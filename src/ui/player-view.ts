import { debounce, ItemView, MarkdownView, Menu, setIcon, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { ConfirmModal } from './confirm-modal';
import NoteNarratorPlugin from '../main';
import { getActiveProfile, getDropdownProfiles, savedVoiceMatches } from '../settings/profiles';
import { GenerateInBackgroundAction, hasPendingGeneration } from '../engine/background-job';
import { PLAY_SAVED_ICON_ID, skipIconId } from './icons';
import { AudioLinkStatus, ReaderState } from '../engine/reader-types';
import { computeFullReadTimes, formatTimeDisplay } from '../engine/time-utils';
import { BackgroundJobList } from './background-job-list';
import { attachTooltip } from './touch-tooltip';

export const NOTE_NARRATOR_VIEW_TYPE = 'note-narrator-player';

const SPEED_MIN = 0.5;
const SPEED_MAX = 3;
const VOLUME_MIN = 0;
const VOLUME_MAX = 1;

const STATUS_LABELS: Record<ReaderState['status'], string> = {
	idle: 'Nothing playing',
	generating: 'Generating speech…',
	playing: 'Reading…',
	paused: 'Paused',
};

/** The panel's background button for each "Generate in background" decision; `onClick` null means disabled. */
interface BackgroundButtonSpec {
	label: string;
	icon: string;
	tooltip: string;
	onClick: 'move' | 'generate' | null;
}

const MOVE_TO_BACKGROUND: Omit<BackgroundButtonSpec, 'onClick'> = {
	label: 'Move to background',
	icon: 'layers',
	tooltip: 'Stop playback but keep generating the rest of this note in the background, so you can jump back into it later.',
};

const GENERATE_IN_BACKGROUND: Omit<BackgroundButtonSpec, 'onClick'> = {
	label: 'Generate in background',
	icon: 'layers',
	tooltip: 'Generate this note in the background without playing it, so you can listen to it later.',
};

const BACKGROUND_BUTTONS: Record<GenerateInBackgroundAction, BackgroundButtonSpec> = {
	'move-active': { ...MOVE_TO_BACKGROUND, onClick: 'move' },
	'already-generated': { ...MOVE_TO_BACKGROUND, onClick: null },
	'playing-saved': { ...GENERATE_IN_BACKGROUND, tooltip: 'This note is playing from its saved audio.', onClick: null },
	'already-queued': { ...GENERATE_IN_BACKGROUND, tooltip: 'This note is already in the background queue.', onClick: null },
	'ready-in-background': {
		label: 'Ready in background',
		icon: 'check',
		tooltip: 'This note finished generating in the background. Play it from its card below, or discard the card to generate it again.',
		onClick: null,
	},
	generate: { ...GENERATE_IN_BACKGROUND, onClick: 'generate' },
};

const AUDIO_STATUS_LABELS: Record<AudioLinkStatus, string> = {
	none: '',
	'up-to-date': '✓ Saved audio is up to date',
	outdated: '⚠ Saved audio is outdated — note has changed since it was generated',
};

export class PlayerView extends ItemView {
	private lastActiveFilePath: string | null = null;

	// Elements patched directly on frequent playback ticks (many times a second via `timeupdate`)
	// instead of going through a full render(), so ticks don't tear down/rebuild the whole panel
	// (which disrupts hover/focus state) and the progress bar can animate smoothly via CSS transition.
	private progressFillEl: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private chunkProgressEl: HTMLElement | null = null;
	private lastStructuralKey: string | null = null;

	/** The currently-open compact speed/volume slider popover (narrow-width layout only), if any. Its anchor button is torn down by every render(), so it's simplest to always dismiss on render() rather than try to keep it pinned to a since-replaced element -- see {@link dismissPopover}. */
	private openPopover: { el: HTMLElement; cleanup: () => void } | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: NoteNarratorPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return NOTE_NARRATOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Note Narrator';
	}

	getIcon(): string {
		return 'audio-lines';
	}

	async onClose(): Promise<void> {
		this.dismissPopover();
	}

	async onOpen(): Promise<void> {
		this.addAction('more-vertical', 'More options', (evt) => this.showOptionsMenu(evt));

		this.lastActiveFilePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;

		this.registerEvent(this.plugin.reader.on('change', () => this.handleReaderChange()));
		// Fired explicitly whenever a note's saved-audio link/hash actually changes (save completes, a note is
		// cleared) — decoupled from the 'change' event above (which cheap-patches on unrelated playback ticks
		// and can leave Play saved/Regenerate stale) and from waiting on an incidental re-render to catch up.
		this.registerEvent(
			this.plugin.reader.on('audio-status-change', (file: unknown) => {
				if (file instanceof TFile && file.path === this.lastActiveFilePath) this.render();
			}),
		);
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.handleActiveFileMaybeChanged()));
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (file.path === this.lastActiveFilePath) this.render();
			}),
		);

		const debouncedRender = debounce(() => this.render(), 1000, true);
		this.registerEvent(this.app.workspace.on('editor-change', () => debouncedRender()));

		this.render();
	}

	/**
	 * Frequent ticks (playback `timeupdate`) only change currentTime/duration, not status, chunk index/count,
	 * or which chunks are ready — patch just the progress bar and time text for those instead of a full
	 * render(), reserving render() for actual state transitions.
	 */
	private handleReaderChange(): void {
		const state = this.plugin.reader.getState();
		const key = this.structuralKey(state);
		if (key === this.lastStructuralKey && this.timeEl) {
			this.updateProgress(state);
		} else {
			this.render();
		}
	}

	private structuralKey(state: ReaderState): string {
		const backgroundKey = state.backgroundJobs
			.map((job) => [job.id, job.file?.path, job.status, job.chunkReady.join(''), job.chunkInFlight.join('')].join(':'))
			.join(',');
		return [state.status, state.chunkIndex, state.chunkCount, state.chunkReady.join(','), state.chunkInFlight.join(','), backgroundKey].join('|');
	}

	private updateProgress(state: ReaderState): void {
		if (this.progressFillEl && state.status !== 'generating') {
			const percent = state.duration > 0 ? Math.min(100, (state.currentTime / state.duration) * 100) : 0;
			this.progressFillEl.style.width = `${percent}%`;
		}

		if (this.timeEl) {
			const mode = this.plugin.settings.timeDisplayMode;
			const showTime = mode === 'current' ? state.duration > 0 : state.chunkCount > 0;
			this.timeEl.style.display = showTime ? '' : 'none';
			if (showTime) {
				const rate = this.plugin.reader.getPlaybackRate();
				const times = computeFullReadTimes({
					chunkCount: state.chunkCount,
					chunkIndex: state.chunkIndex,
					chunkDurations: state.chunkDurations,
					currentTime: state.currentTime,
					currentDuration: state.duration > 0 ? state.duration : undefined,
				});
				this.timeEl.setText(formatTimeDisplay(mode, times, { currentTime: state.currentTime, duration: state.duration }, rate));
			}
		}

		if (this.chunkProgressEl && state.chunkCount > 1) {
			const chunkFraction = state.duration > 0 ? state.currentTime / state.duration : 0;
			const overallPercent = Math.round(Math.min(1, (state.chunkIndex + chunkFraction) / state.chunkCount) * 100);
			this.chunkProgressEl.setText(`Part ${state.chunkIndex + 1} of ${state.chunkCount} · ${overallPercent}% complete`);
		}
	}

	/**
	 * Only re-renders when the active *markdown note* actually changes — not on every active-leaf-change,
	 * which also fires when focus moves into this panel itself (e.g. opening the Voice dropdown), which
	 * would otherwise destroy and immediately close any open native dropdown.
	 */
	private handleActiveFileMaybeChanged(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		if (view.file?.path === this.lastActiveFilePath) return;
		this.lastActiveFilePath = view.file?.path ?? null;
		this.render();
	}

	/**
	 * `workspace.getActiveViewOfType(MarkdownView)` returns null once this panel itself becomes the
	 * active leaf — which happens as soon as the user clicks into it (e.g. to press Read) — so relying
	 * on it alone from inside the panel's own click handlers falsely reports "no note open". Falls back
	 * to the last note this panel tracked as active, resolved to its still-open MarkdownView if any.
	 */
	private getActiveMarkdownView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		if (!this.lastActiveFilePath) return null;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === this.lastActiveFilePath) {
				return leaf.view;
			}
		}
		return null;
	}

	/** Same fallback as {@link getActiveMarkdownView}, for call sites that only need the file, not an editor. */
	private getActiveFile(): TFile | null {
		const view = this.getActiveMarkdownView();
		if (view?.file) return view.file;
		if (!this.lastActiveFilePath) return null;
		const file = this.app.vault.getAbstractFileByPath(this.lastActiveFilePath);
		return file instanceof TFile ? file : null;
	}

	/**
	 * Scrolls (and reveals) the note to whatever section is currently playing, opening it in a leaf if it
	 * isn't already open. No-op if nothing's currently playing there. Doesn't touch playback -- unlike
	 * Previous/Next part, it only moves the editor. Section rather than chunk: a chunk is an internal
	 * TTS-request boundary, not a unit a listener actually navigates by, and section gets you to the same
	 * neighborhood even when it spans more than one chunk.
	 */
	private async scrollToCurrent(): Promise<void> {
		const result = this.plugin.reader.getSpan('section');
		if (!result) return;

		let view: MarkdownView | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === result.file.path) {
				view = leaf.view;
				break;
			}
		}
		if (!view) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(result.file);
			view = leaf.view instanceof MarkdownView ? leaf.view : null;
		}
		if (!view) return;

		await this.app.workspace.revealLeaf(view.leaf);
		const editor = view.editor;
		const from = editor.offsetToPos(result.span.start);
		const to = editor.offsetToPos(result.span.end);
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}

	private render(): void {
		this.dismissPopover();

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('note-narrator-player-view');

		const state = this.plugin.reader.getState();
		const active = state.status !== 'idle';
		const skipBackSeconds = this.plugin.settings.skipBackSeconds;
		const skipForwardSeconds = this.plugin.settings.skipForwardSeconds;

		this.lastStructuralKey = this.structuralKey(state);
		this.progressFillEl = null;
		this.timeEl = null;
		this.chunkProgressEl = null;

		const selectedFile = this.getActiveFile();
		// Read/Play saved/Regenerate act on the *selected* note, not whatever's currently playing — while
		// reading a different note, they should stay clickable so clicking one stops that read and starts
		// this one instead (until background generation lands and playing elsewhere no longer needs to
		// interrupt at all).
		const activeForSelected = active && !!state.activeFile && !!selectedFile && state.activeFile.path === selectedFile.path;
		// Not just status === 'generating': once quick-start playback begins, status flips to 'playing' while
		// later chunks can still be generating in the background (parallel generation/lookahead) — Cancel
		// generation should stay enabled through all of that, not just the initial generating phase.
		const pendingGeneration = active && hasPendingGeneration(state.chunkReady);

		// Everything below scrolls together; the background-jobs queue (appended straight to contentEl,
		// after this) stays pinned at the bottom regardless of scroll position.
		const scroll = contentEl.createDiv({ cls: 'note-narrator-scroll-area' });

		// 1. Title
		scroll.createDiv({
			cls: 'note-narrator-selected-note',
			text: selectedFile ? `Read: ${selectedFile.basename}` : 'Open a note to read it aloud',
		});
		if (state.activeFile && (!selectedFile || state.activeFile.path !== selectedFile.path)) {
			const currentlyReading = scroll.createDiv({ cls: 'note-narrator-currently-reading' });
			currentlyReading.createSpan({ cls: 'note-narrator-currently-reading-icon' }, (el) => setIcon(el, 'headphones'));
			currentlyReading.createSpan({ text: `Currently reading: ${state.activeFile.basename}` });
		}

		// 2. Status header
		scroll.createDiv({ cls: 'note-narrator-status', text: STATUS_LABELS[state.status] });

		// 3/4. Audio status: saved audio up to date, or outdated (whichever applies -- nothing if neither)
		this.renderAudioStatus(scroll);

		// 5. Voice selection
		this.renderNarratorSelector(scroll);
		this.renderNoteStats(scroll, selectedFile);

		// 6. Play saved / Read / Cancel / Move to (or Generate in) background
		this.renderPrimaryActions(scroll, activeForSelected, pendingGeneration);

		// 7. Progress bars/text
		if (state.chunkCount > 1) {
			this.chunkProgressEl = scroll.createDiv({ cls: 'note-narrator-chunk-progress' });

			const generationBar = scroll.createDiv({ cls: 'note-narrator-generation-bar' });
			for (let i = 0; i < state.chunkCount; i++) {
				const segment = generationBar.createDiv({ cls: 'note-narrator-generation-segment' });
				if (state.chunkReady[i]) segment.addClass('is-ready');
				else if (state.chunkInFlight[i]) segment.addClass('is-generating');
				if (i === state.chunkIndex) segment.addClass('is-current');
			}
		}

		const bar = scroll.createDiv({ cls: 'note-narrator-progress-bar' });
		if (state.status === 'generating') {
			bar.addClass('is-indeterminate');
			bar.createDiv({ cls: 'note-narrator-progress-fill' });
		} else {
			this.progressFillEl = bar.createDiv({ cls: 'note-narrator-progress-fill' });
		}

		this.timeEl = scroll.createDiv({ cls: 'note-narrator-time' });
		this.updateProgress(state);

		// 8/9. Every playback control in one row: previous part, rewind, pause, skip, next part, stop, then
		// (separated, since these scroll the note rather than affect playback) scroll-to-current-section/chunk.
		{
			const partsDisabled = !active || state.chunkCount <= 1;
			const controls = scroll.createDiv({ cls: 'note-narrator-controls' });

			this.createIconButton(controls, 'step-back', 'Previous part', partsDisabled, () => this.plugin.reader.previousPart());

			this.createIconButton(
				controls,
				skipIconId(skipBackSeconds, 'back'),
				`Rewind ${skipBackSeconds}s`,
				!active,
				() => this.plugin.reader.skip(-skipBackSeconds),
			);

			this.createIconButton(controls, state.status === 'paused' ? 'circle-play' : 'circle-pause', state.status === 'paused' ? 'Resume' : 'Pause', !active, () => {
				if (state.status === 'playing') this.plugin.reader.pause();
				else if (state.status === 'paused') this.plugin.reader.resume();
			}).addClass('note-narrator-control-primary');

			this.createIconButton(
				controls,
				skipIconId(skipForwardSeconds, 'forward'),
				`Skip forward ${skipForwardSeconds}s`,
				!active,
				() => this.plugin.reader.skip(skipForwardSeconds),
			);

			this.createIconButton(
				controls,
				'step-forward',
				'Next part',
				partsDisabled || state.chunkIndex >= state.chunkCount - 1,
				() => this.plugin.reader.nextPart(),
			);

			this.createIconButton(controls, 'square-stop', 'Stop', !active, () => this.plugin.reader.stop());

			if (this.plugin.settings.showJumpToCurrentButtons) {
				controls.createDiv({ cls: 'note-narrator-controls-separator' });
				const sectionSpan = active ? this.plugin.reader.getSpan('section') : null;
				this.createIconButton(controls, 'locate', 'Scroll to current section', !sectionSpan, () => void this.scrollToCurrent());
			}
		}

		// 10/11. Playback speed / Volume. Each renders its own full Setting row (hidden at the narrow
		// breakpoint) plus a compact icon+value pill -- both pills share one row so they sit side by
		// side, rather than each getting a full-width row of their own, once collapsed.
		const showSpeed = this.plugin.settings.showPlaybackSpeedSlider;
		const showVolume = this.plugin.settings.showVolumeSlider;
		if (showSpeed || showVolume) {
			const compactRow = scroll.createDiv({ cls: 'note-narrator-slider-compact-row' });
			if (showSpeed) this.renderSpeedControl(scroll, compactRow);
			if (showVolume) this.renderVolumeControl(scroll, compactRow);
		}

		// 12. Background-jobs queue, pinned to the bottom of the panel (outside the scroll area)
		if (state.backgroundJobs.length > 0) {
			const pinned = contentEl.createDiv({ cls: 'note-narrator-background-jobs-pinned' });
			new BackgroundJobList(this.plugin.reader, this.plugin.settings).render(pinned, state);
		}
	}

	/** Dropdown of the narrator profiles marked for the panel (plus the active one), replacing the old per-voice list. */
	/** Re-renders the panel from the current settings. */
	refresh(): void {
		this.render();
	}

	private renderNarratorSelector(container: HTMLElement): void {
		const settings = this.plugin.settings;
		const profiles = getDropdownProfiles(settings);
		const activeId = getActiveProfile(settings)?.id;

		new Setting(container).setName('Narration profile').addDropdown((dropdown) => {
			if (profiles.length === 0) {
				dropdown.addOption('', 'No narrator profiles');
				dropdown.setDisabled(true);
				return;
			}
			for (const profile of profiles) dropdown.addOption(profile.id, profile.name);
			if (activeId) dropdown.setValue(activeId);
			dropdown.onChange(async (value) => {
				settings.activeProfileId = value;
				// saveSettings re-renders the panel, so the Read button's Regenerate/"new narrator" label and the note stats follow the new profile.
				await this.plugin.saveSettings();
			});
		});
	}

	/** Builds a Setting name as [icon][label] -- always in that order, at every width. The label itself hides at the narrow container breakpoint (see the `.note-narrator-setting-label` CSS rule); the icon never does, so there's always something to the left of it identifying the row. */
	private buildSettingNameWithIcon(icon: string, label: string): DocumentFragment {
		return createFragment((frag) => {
			const wrapper = frag.createSpan({ cls: 'note-narrator-setting-name' });
			setIcon(wrapper.createSpan({ cls: 'note-narrator-setting-icon' }), icon);
			wrapper.createSpan({ cls: 'note-narrator-setting-label', text: label });
		});
	}

	/**
	 * Playback speed: icon + "Playback speed" (no baked-in value -- Obsidian's own SliderComponent
	 * already shows the current value inline next to the slider by default, so repeating it in the
	 * label would just be redundant text to keep in sync). Full row visible on wide layouts;
	 * collapses to just the icon (opening a vertical popover slider on tap) under the narrow
	 * container breakpoint, where the horizontal slider doesn't have room to be usable.
	 */
	private renderSpeedControl(container: HTMLElement, compactRow: HTMLElement): void {
		const currentRate = this.plugin.reader.getPlaybackRate();
		const formatSpeed = (value: number) => `${value.toFixed(2)}x`;

		const speedSetting = new Setting(container).setName(this.buildSettingNameWithIcon('gauge', 'Playback speed'));
		speedSetting.settingEl.addClass('note-narrator-slider-setting');
		speedSetting.addSlider((slider) =>
			slider
				.setLimits(SPEED_MIN, SPEED_MAX, 0.05)
				.setValue(currentRate)
				.onChange((value) => this.plugin.reader.setPlaybackRate(value)),
		);
		const speedRange = speedSetting.controlEl.createDiv({ cls: 'note-narrator-speed-range' });
		speedRange.createSpan({ cls: 'note-narrator-speed-bound', text: formatSpeed(SPEED_MIN) });
		speedRange.createSpan({ cls: 'note-narrator-speed-bound', text: formatSpeed(SPEED_MAX) });

		const { valueEl } = this.renderCompactPill(compactRow, 'gauge', formatSpeed(currentRate), 'Playback speed', (anchor) =>
			this.openSliderPopover(anchor, {
				min: SPEED_MIN,
				max: SPEED_MAX,
				step: 0.05,
				value: this.plugin.reader.getPlaybackRate(),
				format: formatSpeed,
				onChange: (value) => {
					this.plugin.reader.setPlaybackRate(value);
					valueEl.setText(formatSpeed(value));
				},
			}),
		);
	}

	/** Volume: same icon/label/popover split as {@link renderSpeedControl}. The mute extra-button stays visible at every width (it's already icon-only and touch-sized) regardless of whether the row is showing its full slider or its compact pill. */
	private renderVolumeControl(container: HTMLElement, compactRow: HTMLElement): void {
		const isMuted = this.plugin.reader.isMuted();
		const currentVolume = this.plugin.reader.getVolume();
		const formatVolume = (value: number) => (this.plugin.reader.isMuted() ? 'Muted' : `${Math.round(value * 100)}%`);

		const volumeSetting = new Setting(container).setName(this.buildSettingNameWithIcon(isMuted ? 'volume-x' : 'volume-2', 'Volume'));
		volumeSetting.settingEl.addClass('note-narrator-slider-setting');
		volumeSetting.addSlider((slider) =>
			slider
				.setLimits(VOLUME_MIN, VOLUME_MAX, 0.05)
				.setValue(currentVolume)
				.onChange((value) => this.plugin.reader.setVolume(value)),
		);
		volumeSetting.addExtraButton((button) => {
			button.setIcon(isMuted ? 'volume-x' : 'volume-2').onClick(() => {
				this.plugin.reader.setMuted(!this.plugin.reader.isMuted());
				this.render();
			});
			attachTooltip(button.extraSettingsEl, isMuted ? 'Unmute' : 'Mute');
		});

		const { valueEl } = this.renderCompactPill(compactRow, isMuted ? 'volume-x' : 'volume-2', formatVolume(currentVolume), 'Volume', (anchor) =>
			this.openSliderPopover(anchor, {
				min: VOLUME_MIN,
				max: VOLUME_MAX,
				step: 0.05,
				value: this.plugin.reader.getVolume(),
				format: formatVolume,
				onChange: (value) => {
					this.plugin.reader.setVolume(value);
					valueEl.setText(formatVolume(value));
				},
			}),
		);
	}

	/** The narrow-layout pill: icon + current value, opening a popover slider on click. Hidden except under the container query's narrow breakpoint -- see the `.note-narrator-slider-compact` CSS rule. Speed's and Volume's pills share one row (`compactRow`) so they sit side by side once collapsed, instead of each taking a full-width row. */
	private renderCompactPill(
		compactRow: HTMLElement,
		icon: string,
		valueText: string,
		label: string,
		onOpen: (anchor: HTMLElement) => void,
	): { pill: HTMLElement; valueEl: HTMLElement } {
		const pill = compactRow.createDiv({ cls: 'note-narrator-slider-compact' });
		pill.setAttribute('role', 'button');
		pill.setAttribute('tabindex', '0');
		attachTooltip(pill, label);
		setIcon(pill.createSpan({ cls: 'note-narrator-slider-compact-icon' }), icon);
		const valueEl = pill.createSpan({ cls: 'note-narrator-slider-compact-value', text: valueText });

		const toggle = () => {
			if (this.openPopover) {
				this.dismissPopover();
				return;
			}
			onOpen(pill);
		};
		pill.onclick = toggle;
		pill.onkeydown = (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;
			evt.preventDefault();
			toggle();
		};

		return { pill, valueEl };
	}

	/** Removes the currently-open slider popover (if any) and its document-level listeners. Safe to call when nothing is open. */
	private dismissPopover(): void {
		if (!this.openPopover) return;
		this.openPopover.cleanup();
		this.openPopover.el.remove();
		this.openPopover = null;
	}

	/**
	 * A vertical pill-shaped slider (à la iOS Control Center's volume/brightness sliders), floated as
	 * a fixed-position popover anchored above (or below, if there's no room) the given element.
	 * Appended to `document.body` rather than the panel itself so it's never clipped by the panel's
	 * own scroll/overflow containers regardless of where the anchor sits.
	 */
	private openSliderPopover(
		anchor: HTMLElement,
		opts: { min: number; max: number; step: number; value: number; format: (value: number) => string; onChange: (value: number) => void },
	): void {
		this.dismissPopover();

		const doc = anchor.ownerDocument;
		const popover = doc.body.createDiv({ cls: 'note-narrator-slider-popover' });

		const valueLabel = popover.createDiv({ cls: 'note-narrator-slider-popover-value', text: opts.format(opts.value) });

		const track = popover.createDiv({ cls: 'note-narrator-slider-track' });
		track.setAttribute('role', 'slider');
		track.setAttribute('aria-valuemin', String(opts.min));
		track.setAttribute('aria-valuemax', String(opts.max));
		track.setAttribute('tabindex', '0');
		const fill = track.createDiv({ cls: 'note-narrator-slider-fill' });

		let value = opts.value;
		const clampToStep = (raw: number) => {
			const stepped = Math.round(raw / opts.step) * opts.step;
			return Math.min(opts.max, Math.max(opts.min, stepped));
		};
		const applyValue = (next: number) => {
			value = clampToStep(next);
			const fraction = (value - opts.min) / (opts.max - opts.min);
			fill.setCssStyles({ height: `${fraction * 100}%` });
			track.setAttribute('aria-valuenow', value.toFixed(2));
			valueLabel.setText(opts.format(value));
			opts.onChange(value);
		};
		applyValue(value);

		const valueFromPointer = (clientY: number): number => {
			const rect = track.getBoundingClientRect();
			const fraction = 1 - (clientY - rect.top) / rect.height;
			return opts.min + fraction * (opts.max - opts.min);
		};

		let dragging = false;
		const onPointerDown = (evt: PointerEvent) => {
			dragging = true;
			track.setPointerCapture(evt.pointerId);
			applyValue(valueFromPointer(evt.clientY));
			evt.preventDefault();
		};
		const onPointerMove = (evt: PointerEvent) => {
			if (!dragging) return;
			applyValue(valueFromPointer(evt.clientY));
		};
		const onPointerUp = (evt: PointerEvent) => {
			dragging = false;
			track.releasePointerCapture(evt.pointerId);
		};
		track.addEventListener('pointerdown', onPointerDown);
		track.addEventListener('pointermove', onPointerMove);
		track.addEventListener('pointerup', onPointerUp);
		track.addEventListener('keydown', (evt) => {
			if (evt.key === 'ArrowUp' || evt.key === 'ArrowRight') {
				evt.preventDefault();
				applyValue(value + opts.step);
			} else if (evt.key === 'ArrowDown' || evt.key === 'ArrowLeft') {
				evt.preventDefault();
				applyValue(value - opts.step);
			}
		});

		// Positioned after the popover has real dimensions to measure, and flipped below the anchor
		// when there isn't enough room above it.
		const anchorRect = anchor.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		const gap = 8;
		const openAbove = anchorRect.top - popoverRect.height - gap > 0;
		const top = openAbove ? anchorRect.top - popoverRect.height - gap : anchorRect.bottom + gap;
		const left = Math.min(
			Math.max(anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2, 8),
			doc.defaultView ? doc.defaultView.innerWidth - popoverRect.width - 8 : anchorRect.left,
		);
		popover.setCssStyles({ top: `${top}px`, left: `${left}px` });

		const onDocumentPointerDown = (evt: PointerEvent) => {
			const target = evt.target;
			if (target instanceof Node && (popover.contains(target) || anchor.contains(target))) return;
			this.dismissPopover();
		};
		const onKeyDown = (evt: KeyboardEvent) => {
			if (evt.key === 'Escape') this.dismissPopover();
		};
		doc.addEventListener('pointerdown', onDocumentPointerDown, true);
		doc.addEventListener('keydown', onKeyDown, true);

		this.openPopover = {
			el: popover,
			cleanup: () => {
				doc.removeEventListener('pointerdown', onDocumentPointerDown, true);
				doc.removeEventListener('keydown', onKeyDown, true);
			},
		};
	}

	private createIconButton(
		container: HTMLElement,
		icon: string,
		label: string,
		disabled: boolean,
		onClick: () => void,
	): HTMLElement {
		const button = container.createDiv({ cls: 'clickable-icon note-narrator-icon-button' });
		setIcon(button, icon);
		attachTooltip(button, label);
		if (disabled) {
			button.addClass('is-disabled');
		} else {
			button.onclick = onClick;
		}
		return button;
	}

	private renderAudioStatus(container: HTMLElement): void {
		const activeFile = this.getActiveFile();
		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		const statusEl = container.createDiv({ cls: 'note-narrator-audio-status' });
		void (async () => {
			try {
				const status = await this.plugin.reader.getAudioStatus(activeFile);
					if (status === 'none') return;
					statusEl.addClass(status === 'outdated' ? 'is-outdated' : 'is-up-to-date');
					statusEl.createSpan({ text: AUDIO_STATUS_LABELS[status] });

					if (this.plugin.settings.showClearFilesButton) {
						const deleteButton = statusEl.createDiv({ cls: 'clickable-icon note-narrator-audio-status-delete' });
						setIcon(deleteButton, 'trash-2');
						attachTooltip(deleteButton, 'Delete saved audio file');
						deleteButton.onclick = () => this.confirmClearReaderFiles(activeFile);
					}
			} catch (error) {
				console.error('Note Narrator: failed to update the panel', error);
			}
		})();
	}

	private confirmClearReaderFiles(activeFile: TFile): void {
		new ConfirmModal(
			this.app,
			'Clear Note Narrator files?',
			`This deletes ${activeFile.basename}'s linked audio file and removes the Note Narrator audio properties from its frontmatter. This can't be undone from within Note Narrator.`,
			'Delete',
			() => void this.plugin.reader.clearReaderFiles(activeFile),
		).open();
	}

	/** Total characters/chunks and derived averages for the selected note, shown just above the Read button. */
	private renderNoteStats(container: HTMLElement, file: TFile | null): void {
		if (!file) return;

		const statsEl = container.createDiv({ cls: 'note-narrator-note-stats' });
		void (async () => {
			try {
				const stats = await this.plugin.reader.getNoteStats(file);
					if (!stats) {
						statsEl.remove();
						return;
					}
					statsEl.empty();
					statsEl.createDiv({
						text: `${stats.totalChars.toLocaleString()} characters · ${stats.chunkCount} chunk${stats.chunkCount === 1 ? '' : 's'}`,
					});
					statsEl.createDiv({
						cls: 'note-narrator-note-stats-secondary',
						text: `~${stats.avgCharsPerChunk.toLocaleString()} characters/chunk · ~${stats.avgWordsPerChunk.toLocaleString()} words/chunk`,
					});
			} catch (error) {
				console.error('Note Narrator: failed to update the panel', error);
			}
		})();
	}

	/**
	 * An icon + text label button for the primary-actions row. Returns the label span separately so
	 * callers can update just the text later (e.g. Read -> Regenerate) via {@link setButtonLabel}
	 * without disturbing the icon. `tooltip` (defaulting to `label`) is attached once via
	 * {@link attachTooltip} -- callers that need a longer/different tooltip than the visible label
	 * (Cancel, Move to background / Generate in background) must pass it here rather than calling attachTooltip again
	 * themselves, which would double up its long-press listeners on the same button.
	 */
	private createLabeledButton(
		container: HTMLElement,
		cls: string,
		icon: string,
		label: string,
		tooltip: string = label,
	): { button: HTMLButtonElement; labelEl: HTMLElement } {
		const button = container.createEl('button', { cls });
		setIcon(button.createSpan({ cls: 'note-narrator-button-icon' }), icon);
		const labelEl = button.createSpan({ cls: 'note-narrator-button-label', text: label });
		attachTooltip(button, tooltip);
		return { button, labelEl };
	}

	/** Updates both a labeled button's visible text and its tooltip (see {@link createLabeledButton}) together, so the icon-only tooltip never drifts from what a wide layout shows as text. Only for buttons whose tooltip always matches their label -- Cancel and the background button set theirs once at creation instead. */
	private setButtonLabel(button: HTMLButtonElement, labelEl: HTMLElement, text: string): void {
		labelEl.setText(text);
		attachTooltip(button, text);
	}

	private renderPrimaryActions(container: HTMLElement, active: boolean, pendingGeneration: boolean): void {
		const actionsRow = container.createDiv({ cls: 'note-narrator-primary-actions' });
		actionsRow.toggleClass('is-compact', this.plugin.settings.compactButtons);

		const { button: playSavedButton } = this.createLabeledButton(actionsRow, 'note-narrator-play-saved-button', PLAY_SAVED_ICON_ID, 'Play saved');
		playSavedButton.disabled = true;

		const { button: readButton, labelEl: readLabelEl } = this.createLabeledButton(
			actionsRow,
			'mod-cta note-narrator-read-button',
			'audio-lines',
			active ? 'Reading' : 'Read',
		);
		readButton.disabled = active;
		readButton.onclick = () => void this.plugin.reader.readNote(this.getActiveMarkdownView() ?? undefined);

		const { button: cancelButton } = this.createLabeledButton(actionsRow, 'note-narrator-cancel-button', 'octagon-x', 'Cancel');
		cancelButton.disabled = !pendingGeneration;
		attachTooltip(cancelButton, 'Cancel generation');
		cancelButton.onclick = () => this.plugin.reader.stop();

		// One slot, two jobs: while the selected note's full read is playing it moves that read to the
		// background; otherwise (including while only a selection of it is being read) it starts generating
		// the whole note in the background without playing it. Same decision as the command's.
		const activeFile = this.getActiveFile();
		// The editor's current text lets a background job made from an older version count as stale.
		const view = this.getActiveMarkdownView();
		const currentContent = view && activeFile && view.file?.path === activeFile.path ? view.editor.getValue() : undefined;
		const action = activeFile ? this.plugin.reader.getGenerateInBackgroundAction(activeFile, currentContent) : null;
		const spec: BackgroundButtonSpec = action ? BACKGROUND_BUTTONS[action] : { ...GENERATE_IN_BACKGROUND, onClick: null };
		const { button: backgroundButton } = this.createLabeledButton(actionsRow, 'note-narrator-background-button', spec.icon, spec.label, spec.tooltip);
		backgroundButton.disabled = spec.onClick === null;
		if (spec.onClick === 'move') {
			backgroundButton.onclick = () => this.plugin.reader.continueGeneratingInBackground();
		} else if (spec.onClick === 'generate') {
			backgroundButton.onclick = () => this.plugin.reader.generateNoteInBackground(this.getActiveMarkdownView() ?? undefined);
		}

		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		void (async () => {
			try {
				const info = await this.plugin.reader.getAudioInfo(activeFile);
					if (!info) return;

					// Read button's label only makes sense while it's actually clickable (not `active`) — leave it
					// alone otherwise so it doesn't flash "Regenerate" next to a disabled "Reading" state. Play saved
					// isn't gated the same way: it's available the instant a saved file exists, even mid-read, since
					// clicking it just stops whatever's currently happening and plays the saved copy instead (same
					// pattern as Read/Regenerate staying clickable while a *different* note is playing).
					if (!active) {
						const narrator = this.plugin.reader.getActiveNarrator();
						const voiceMismatch = info.savedVoice !== undefined && !!narrator && !savedVoiceMatches(info.savedVoice, narrator.voice);
						if (info.status === 'outdated') {
							this.setButtonLabel(readButton, readLabelEl, 'Regenerate');
						} else if (voiceMismatch) {
							this.setButtonLabel(readButton, readLabelEl, 'Regenerate with new narrator');
						}
					}

					playSavedButton.disabled = false;
					playSavedButton.onclick = () => void this.plugin.reader.playSavedFile(info.audioFile, activeFile);
			} catch (error) {
				console.error('Note Narrator: failed to update the panel', error);
			}
		})();
	}

	private showOptionsMenu(evt: MouseEvent): void {
		const activeFile = this.getActiveFile();
		const clearEnabled = this.plugin.settings.showClearFilesButton && this.plugin.settings.linkAudioInNote && !!activeFile;

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Clear Note Narrator files')
				.setIcon('trash-2')
				.setDisabled(!clearEnabled)
				.onClick(() => {
					if (!activeFile) return;
					this.confirmClearReaderFiles(activeFile);
				}),
		);
		menu.showAtMouseEvent(evt);
	}
}
