import { debounce, ItemView, MarkdownView, Menu, setIcon, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { ConfirmModal } from './confirm-modal';
import ObsidianReaderPlugin from './main';
import { hasPendingGeneration, queuePosition } from './background-job';
import type { BackgroundJobInfo } from './background-job';
import { PLAY_SAVED_ICON_ID } from './icons';
import { AudioLinkStatus, ReaderState } from './reader';
import { computeFullReadTimes, formatTimeDisplay } from './time-utils';
import { ElevenLabsVoice, listElevenLabsVoices } from './tts/elevenlabs-provider';

export const READER_VIEW_TYPE = 'obsidian-reader-player';

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

const AUDIO_STATUS_LABELS: Record<AudioLinkStatus, string> = {
	none: '',
	'up-to-date': '✓ Saved audio is up to date',
	outdated: '⚠ Saved audio is outdated — note has changed since it was generated',
};

export class PlayerView extends ItemView {
	private voices: ElevenLabsVoice[] = [];
	private lastActiveFilePath: string | null = null;

	// Elements patched directly on frequent playback ticks (many times a second via `timeupdate`)
	// instead of going through a full render(), so ticks don't tear down/rebuild the whole panel
	// (which disrupts hover/focus state) and the progress bar can animate smoothly via CSS transition.
	private progressFillEl: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private chunkProgressEl: HTMLElement | null = null;
	private lastStructuralKey: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ObsidianReaderPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return READER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Obsidian reader';
	}

	getIcon(): string {
		return 'audio-lines';
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

		void this.loadVoices();
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

	private async loadVoices(): Promise<void> {
		const apiKey = this.app.secretStorage.getSecret(this.plugin.settings.apiKeySecretId);
		if (!apiKey) return;

		try {
			this.voices = await listElevenLabsVoices(apiKey);
			this.render();
		} catch (error) {
			console.error('Obsidian Reader: failed to fetch ElevenLabs voices', error);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('obsidian-reader-player-view');

		const state = this.plugin.reader.getState();
		const active = state.status !== 'idle';
		const skipSeconds = this.plugin.settings.skipSeconds;

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
		const scroll = contentEl.createDiv({ cls: 'obsidian-reader-scroll-area' });

		// 1. Title
		scroll.createDiv({
			cls: 'obsidian-reader-selected-note',
			text: selectedFile ? `Read: ${selectedFile.basename}` : 'Open a note to read it aloud',
		});
		if (state.activeFile && (!selectedFile || state.activeFile.path !== selectedFile.path)) {
			const currentlyReading = scroll.createDiv({ cls: 'obsidian-reader-currently-reading' });
			currentlyReading.createSpan({ cls: 'obsidian-reader-currently-reading-icon' }, (el) => setIcon(el, 'headphones'));
			currentlyReading.createSpan({ text: `Currently reading: ${state.activeFile.basename}` });
		}

		// 2. Status header
		scroll.createDiv({ cls: 'obsidian-reader-status', text: STATUS_LABELS[state.status] });

		// 3/4. Audio status: saved audio up to date, or outdated (whichever applies -- nothing if neither)
		this.renderAudioStatus(scroll);

		// 5. Voice selection
		this.renderVoiceSelector(scroll);
		this.renderNoteStats(scroll, selectedFile);

		// 6. Play Saved / Read / Cancel / Send to Background
		this.renderPrimaryActions(scroll, activeForSelected, pendingGeneration);

		// 7. Progress bars/text
		if (state.chunkCount > 1) {
			this.chunkProgressEl = scroll.createDiv({ cls: 'obsidian-reader-chunk-progress' });

			const generationBar = scroll.createDiv({ cls: 'obsidian-reader-generation-bar' });
			for (let i = 0; i < state.chunkCount; i++) {
				const segment = generationBar.createDiv({ cls: 'obsidian-reader-generation-segment' });
				if (state.chunkReady[i]) segment.addClass('is-ready');
				else if (state.chunkInFlight[i]) segment.addClass('is-generating');
				if (i === state.chunkIndex) segment.addClass('is-current');
			}
		}

		const bar = scroll.createDiv({ cls: 'obsidian-reader-progress-bar' });
		if (state.status === 'generating') {
			bar.addClass('is-indeterminate');
			bar.createDiv({ cls: 'obsidian-reader-progress-fill' });
		} else {
			this.progressFillEl = bar.createDiv({ cls: 'obsidian-reader-progress-fill' });
		}

		this.timeEl = scroll.createDiv({ cls: 'obsidian-reader-time' });
		this.updateProgress(state);

		// 8/9. Every playback control in one row: previous part, rewind, pause, skip, next part, stop, then
		// (separated, since these scroll the note rather than affect playback) scroll-to-current-section/chunk.
		{
			const partsDisabled = !active || state.chunkCount <= 1;
			const controls = scroll.createDiv({ cls: 'obsidian-reader-controls' });

			this.createIconButton(controls, 'step-back', 'Previous part', partsDisabled, () => this.plugin.reader.previousPart());

			this.createIconButton(controls, 'skip-back', `Rewind ${skipSeconds}s`, !active, () => this.plugin.reader.skip(-skipSeconds));

			this.createIconButton(controls, state.status === 'paused' ? 'circle-play' : 'circle-pause', state.status === 'paused' ? 'Resume' : 'Pause', !active, () => {
				if (state.status === 'playing') this.plugin.reader.pause();
				else if (state.status === 'paused') this.plugin.reader.resume();
			}).addClass('obsidian-reader-control-primary');

			this.createIconButton(controls, 'skip-forward', `Skip forward ${skipSeconds}s`, !active, () => this.plugin.reader.skip(skipSeconds));

			this.createIconButton(
				controls,
				'step-forward',
				'Next part',
				partsDisabled || state.chunkIndex >= state.chunkCount - 1,
				() => this.plugin.reader.nextPart(),
			);

			this.createIconButton(controls, 'square-stop', 'Stop', !active, () => this.plugin.reader.stop());

			if (this.plugin.settings.showJumpToCurrentButtons) {
				controls.createDiv({ cls: 'obsidian-reader-controls-separator' });
				const sectionSpan = active ? this.plugin.reader.getSpan('section') : null;
				this.createIconButton(controls, 'locate', 'Scroll to current section', !sectionSpan, () => void this.scrollToCurrent());
			}
		}

		// 10. Playback speed
		if (this.plugin.settings.showPlaybackSpeedSlider) {
			this.renderSpeedControl(scroll);
		}

		// 11. Volume
		if (this.plugin.settings.showVolumeSlider) {
			this.renderVolumeControl(scroll);
		}

		// 12. Background-jobs queue, pinned to the bottom of the panel (outside the scroll area)
		if (state.backgroundJobs.length > 0) {
			const pinned = contentEl.createDiv({ cls: 'obsidian-reader-background-jobs-pinned' });
			this.renderBackgroundJobStatus(pinned, state);
		}
	}

	private renderVoiceSelector(container: HTMLElement): void {
		const currentValue = this.plugin.settings.voiceId;
		const shortlist = this.plugin.settings.panelVoiceIds;
		const availableVoices = shortlist.length > 0 ? this.voices.filter((voice) => shortlist.includes(voice.voiceId)) : this.voices;

		new Setting(container)
			.setName('Voice')
			.addDropdown((dropdown) => {
				if (availableVoices.length === 0) {
					dropdown.addOption(currentValue, currentValue);
				} else {
					for (const voice of availableVoices) {
						dropdown.addOption(voice.voiceId, voice.name);
					}
					if (!availableVoices.some((voice) => voice.voiceId === currentValue)) {
						dropdown.addOption(currentValue, `${currentValue} (custom)`);
					}
				}
				dropdown.setValue(currentValue);
				dropdown.onChange(async (value) => {
					this.plugin.settings.voiceId = value;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon('refresh-cw')
					.setTooltip('Refresh voice list from ElevenLabs')
					.onClick(() => void this.loadVoices()),
			);
	}

	private renderSpeedControl(container: HTMLElement): void {
		const currentRate = this.plugin.reader.getPlaybackRate();
		const speedSetting = new Setting(container).setName(`Playback speed: ${currentRate.toFixed(2)}x`);
		speedSetting.addSlider((slider) =>
			slider
				.setLimits(SPEED_MIN, SPEED_MAX, 0.05)
				.setValue(currentRate)
				.onChange((value) => {
					this.plugin.reader.setPlaybackRate(value);
					speedSetting.setName(`Playback speed: ${value.toFixed(2)}x`);
				}),
		);
		const speedRange = speedSetting.controlEl.createDiv({ cls: 'obsidian-reader-speed-range' });
		speedRange.createSpan({ cls: 'obsidian-reader-speed-bound', text: `${SPEED_MIN.toFixed(2)}x` });
		speedRange.createSpan({ cls: 'obsidian-reader-speed-bound', text: `${SPEED_MAX.toFixed(2)}x` });
	}

	private renderVolumeControl(container: HTMLElement): void {
		const isMuted = this.plugin.reader.isMuted();
		const currentVolume = this.plugin.reader.getVolume();
		const volumeSetting = new Setting(container).setName(`Volume: ${isMuted ? 'Muted' : `${Math.round(currentVolume * 100)}%`}`);
		volumeSetting.addSlider((slider) =>
			slider
				.setLimits(VOLUME_MIN, VOLUME_MAX, 0.05)
				.setValue(currentVolume)
				.onChange((value) => {
					this.plugin.reader.setVolume(value);
					volumeSetting.setName(`Volume: ${this.plugin.reader.isMuted() ? 'Muted' : `${Math.round(value * 100)}%`}`);
				}),
		);
		volumeSetting.addExtraButton((button) =>
			button
				.setIcon(isMuted ? 'volume-x' : 'volume-2')
				.setTooltip(isMuted ? 'Unmute' : 'Mute')
				.onClick(() => {
					this.plugin.reader.setMuted(!this.plugin.reader.isMuted());
					this.render();
				}),
		);
	}

	private createIconButton(
		container: HTMLElement,
		icon: string,
		label: string,
		disabled: boolean,
		onClick: () => void,
	): HTMLElement {
		const button = container.createDiv({ cls: 'clickable-icon obsidian-reader-icon-button' });
		setIcon(button, icon);
		button.setAttribute('aria-label', label);
		if (disabled) {
			button.addClass('is-disabled');
		} else {
			button.onclick = onClick;
		}
		return button;
	}

	/** Label text for a background job's current status, per {@link BackgroundJobInfo.status}. */
	private backgroundJobLabel(job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): string {
		const name = job.file?.basename ?? 'note';
		if (job.status === 'done') return `Finished generating in background: ${name}`;
		if (job.status === 'queued') return `Queued to generate in background: ${name} (#${queuePosition(allJobs, job.id)})`;
		const readyCount = job.chunkReady.filter(Boolean).length;
		return `Generating in background: ${name} — ${readyCount}/${job.chunkCount} parts`;
	}

	private backgroundJobIcon(job: BackgroundJobInfo): string {
		if (job.status === 'done') return 'check-circle-2';
		if (job.status === 'queued') return 'list-ordered';
		return 'loader-2';
	}

	/** "X" for clearing a finished job from the list -- a trash can there would read as deleting the generated audio, not just the list entry. Queued/generating jobs still get the trash can, since discarding those really does cancel/throw away in-progress work. */
	private backgroundJobRemoveIcon(job: BackgroundJobInfo): string {
		return job.status === 'done' ? 'x' : 'trash-2';
	}

	private backgroundJobRemoveLabel(job: BackgroundJobInfo): string {
		return job.status === 'done' ? 'Clear from list' : 'Discard background generation';
	}

	/** Makes a background-job row/card play that job on click or on Enter/Space when focused, like a real button. */
	private makeBackgroundJobClickable(el: HTMLElement, jobId: number): void {
		el.setAttribute('role', 'button');
		el.setAttribute('tabindex', '0');
		el.onclick = () => this.plugin.reader.playBackgroundJob(jobId);
		el.onkeydown = (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;
			evt.preventDefault();
			this.plugin.reader.playBackgroundJob(jobId);
		};
	}

	/** Small icon button for a background-job row/card, stopping the click from bubbling up to the row's own "play this" click handler. */
	private createBackgroundJobIconButton(container: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const button = container.createDiv({ cls: 'clickable-icon obsidian-reader-bgjob-icon-button' });
		setIcon(button, icon);
		button.setAttribute('aria-label', label);
		button.onclick = (evt) => {
			evt.stopPropagation();
			onClick();
		};
		return button;
	}

	private renderBackgroundGenerationBar(container: HTMLElement, job: BackgroundJobInfo): void {
		const bar = container.createDiv({ cls: 'obsidian-reader-generation-bar' });
		for (let i = 0; i < job.chunkCount; i++) {
			const segment = bar.createDiv({ cls: 'obsidian-reader-generation-segment' });
			if (job.chunkReady[i]) segment.addClass('is-ready');
			else if (job.chunkInFlight[i]) segment.addClass('is-generating');
		}
	}

	/** Shows every note queued/generating/finished in the background, in the style chosen by the "Background job display" setting. Clicking anywhere on a row/card besides its own buttons plays that note. */
	private renderBackgroundJobStatus(container: HTMLElement, state: ReaderState): void {
		if (state.backgroundJobs.length === 0) return;

		const list = container.createDiv({ cls: 'obsidian-reader-background-jobs' });
		const style = this.plugin.settings.backgroundJobDisplayStyle;
		for (const job of state.backgroundJobs) {
			if (style === 'full') this.renderBackgroundJobFull(list, job, state.backgroundJobs);
			else if (style === 'compact') this.renderBackgroundJobCompact(list, job, state.backgroundJobs);
			else this.renderBackgroundJobMinimal(list, job, state.backgroundJobs);
		}
	}

	private renderBackgroundJobFull(container: HTMLElement, job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): void {
		const box = container.createDiv({ cls: 'obsidian-reader-background-job obsidian-reader-background-job--full' });
		box.addClass(`is-${job.status}`);
		this.makeBackgroundJobClickable(box, job.id);

		const header = box.createDiv({ cls: 'obsidian-reader-background-job-header' });
		header.createSpan({ cls: 'obsidian-reader-background-job-icon' }, (el) => setIcon(el, this.backgroundJobIcon(job)));
		header.createSpan({ text: this.backgroundJobLabel(job, allJobs) });

		this.renderBackgroundGenerationBar(box, job);

		const actions = box.createDiv({ cls: 'obsidian-reader-background-job-actions' });
		const playButton = actions.createEl('button', { cls: 'mod-cta', text: 'Play' });
		playButton.onclick = (evt) => {
			evt.stopPropagation();
			this.plugin.reader.playBackgroundJob(job.id);
		};

		const discardButton = actions.createDiv({ cls: 'clickable-icon obsidian-reader-background-job-discard' });
		setIcon(discardButton, this.backgroundJobRemoveIcon(job));
		discardButton.setAttribute('aria-label', this.backgroundJobRemoveLabel(job));
		discardButton.onclick = (evt) => {
			evt.stopPropagation();
			this.plugin.reader.discardBackgroundJob(job.id);
		};
	}

	private renderBackgroundJobCompact(container: HTMLElement, job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): void {
		const row = container.createDiv({ cls: 'obsidian-reader-background-job obsidian-reader-background-job--compact' });
		row.addClass(`is-${job.status}`);
		row.setAttribute('aria-label', this.backgroundJobLabel(job, allJobs));
		this.makeBackgroundJobClickable(row, job.id);

		row.createSpan({ cls: 'obsidian-reader-background-job-icon' }, (el) => setIcon(el, this.backgroundJobIcon(job)));
		row.createSpan({ cls: 'obsidian-reader-background-job-name', text: job.file?.basename ?? 'note' });

		const bar = row.createDiv({ cls: 'obsidian-reader-background-job-minibar' });
		for (let i = 0; i < job.chunkCount; i++) {
			const segment = bar.createDiv();
			if (job.chunkReady[i]) segment.addClass('is-ready');
		}

		this.createBackgroundJobIconButton(row, 'play', 'Play', () => this.plugin.reader.playBackgroundJob(job.id));
		this.createBackgroundJobIconButton(row, this.backgroundJobRemoveIcon(job), this.backgroundJobRemoveLabel(job), () =>
			this.plugin.reader.discardBackgroundJob(job.id),
		);
	}

	private renderBackgroundJobMinimal(container: HTMLElement, job: BackgroundJobInfo, allJobs: BackgroundJobInfo[]): void {
		const card = container.createDiv({ cls: 'obsidian-reader-background-job obsidian-reader-background-job--minimal' });
		card.addClass(`is-${job.status}`);
		card.setAttribute('aria-label', this.backgroundJobLabel(job, allJobs));
		this.makeBackgroundJobClickable(card, job.id);

		const titleRow = card.createDiv({ cls: 'obsidian-reader-background-job-title-row' });
		titleRow.createSpan({ cls: 'obsidian-reader-background-job-icon' }, (el) => setIcon(el, this.backgroundJobIcon(job)));
		titleRow.createSpan({ cls: 'obsidian-reader-background-job-name', text: job.file?.basename ?? 'note' });

		const buttons = titleRow.createDiv({ cls: 'obsidian-reader-background-job-minimal-buttons' });
		this.createBackgroundJobIconButton(buttons, 'play', 'Play', () => this.plugin.reader.playBackgroundJob(job.id));
		this.createBackgroundJobIconButton(buttons, this.backgroundJobRemoveIcon(job), this.backgroundJobRemoveLabel(job), () =>
			this.plugin.reader.discardBackgroundJob(job.id),
		);

		this.renderBackgroundGenerationBar(card, job);
	}

	private renderAudioStatus(container: HTMLElement): void {
		const activeFile = this.getActiveFile();
		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		const statusEl = container.createDiv({ cls: 'obsidian-reader-audio-status' });
		void this.plugin.reader.getAudioStatus(activeFile).then((status) => {
			if (status === 'none') return;
			statusEl.addClass(status === 'outdated' ? 'is-outdated' : 'is-up-to-date');
			statusEl.createSpan({ text: AUDIO_STATUS_LABELS[status] });

			if (this.plugin.settings.showClearFilesButton) {
				const deleteButton = statusEl.createDiv({ cls: 'clickable-icon obsidian-reader-audio-status-delete' });
				setIcon(deleteButton, 'trash-2');
				deleteButton.setAttribute('aria-label', 'Delete saved audio file');
				deleteButton.onclick = () => this.confirmClearReaderFiles(activeFile);
			}
		});
	}

	private confirmClearReaderFiles(activeFile: TFile): void {
		new ConfirmModal(
			this.app,
			'Clear reader files?',
			`This deletes ${activeFile.basename}'s linked audio file and removes the reader-audio properties from its frontmatter. This can't be undone from within Obsidian Reader.`,
			'DELETE',
			() => void this.plugin.reader.clearReaderFiles(activeFile),
		).open();
	}

	/** Total characters/chunks and derived averages for the selected note, shown just above the Read button. */
	private renderNoteStats(container: HTMLElement, file: TFile | null): void {
		if (!file) return;

		const statsEl = container.createDiv({ cls: 'obsidian-reader-note-stats' });
		void this.plugin.reader.getNoteStats(file).then((stats) => {
			if (!stats) {
				statsEl.remove();
				return;
			}
			statsEl.empty();
			statsEl.createDiv({
				text: `${stats.totalChars.toLocaleString()} characters · ${stats.chunkCount} chunk${stats.chunkCount === 1 ? '' : 's'}`,
			});
			statsEl.createDiv({
				cls: 'obsidian-reader-note-stats-secondary',
				text: `~${stats.avgCharsPerChunk.toLocaleString()} characters/chunk · ~${stats.avgWordsPerChunk.toLocaleString()} words/chunk`,
			});
		});
	}

	/**
	 * An icon + text label button for the primary-actions row. Returns the label span separately so
	 * callers can update just the text later (e.g. Read -> Regenerate) via {@link setButtonLabel}
	 * without disturbing the icon. Also sets `aria-label` from the same text -- the label itself is
	 * hidden at narrow container widths (icon-only), and Obsidian shows a tooltip (hover, or long-press
	 * on mobile) from a button's `aria-label`, so the accessible name doubles as that tooltip text.
	 */
	private createLabeledButton(container: HTMLElement, cls: string, icon: string, label: string): { button: HTMLButtonElement; labelEl: HTMLElement } {
		const button = container.createEl('button', { cls });
		setIcon(button.createSpan({ cls: 'obsidian-reader-button-icon' }), icon);
		const labelEl = button.createSpan({ cls: 'obsidian-reader-button-label', text: label });
		button.setAttribute('aria-label', label);
		return { button, labelEl };
	}

	/** Updates both a labeled button's visible text and its `aria-label` (see {@link createLabeledButton}) together, so the icon-only tooltip never drifts from what a wide layout shows as text. */
	private setButtonLabel(button: HTMLButtonElement, labelEl: HTMLElement, text: string): void {
		labelEl.setText(text);
		button.setAttribute('aria-label', text);
	}

	private renderPrimaryActions(container: HTMLElement, active: boolean, pendingGeneration: boolean): void {
		const actionsRow = container.createDiv({ cls: 'obsidian-reader-primary-actions' });
		actionsRow.toggleClass('is-compact', this.plugin.settings.compactButtons);

		const { button: playSavedButton } = this.createLabeledButton(actionsRow, 'obsidian-reader-play-saved-button', PLAY_SAVED_ICON_ID, 'Play Saved');
		playSavedButton.disabled = true;

		const { button: readButton, labelEl: readLabelEl } = this.createLabeledButton(
			actionsRow,
			'mod-cta obsidian-reader-read-button',
			'audio-lines',
			active ? 'Reading' : 'Read',
		);
		readButton.disabled = active;
		readButton.onclick = () => void this.plugin.reader.readNote(this.getActiveMarkdownView() ?? undefined);

		const { button: cancelButton } = this.createLabeledButton(actionsRow, 'obsidian-reader-cancel-button', 'octagon-x', 'Cancel');
		cancelButton.disabled = !pendingGeneration;
		cancelButton.setAttribute('aria-label', 'Cancel generation');
		cancelButton.onclick = () => this.plugin.reader.stop();

		const { button: backgroundButton } = this.createLabeledButton(actionsRow, 'obsidian-reader-background-button', 'layers', 'Send to Background');
		backgroundButton.disabled = !pendingGeneration;
		backgroundButton.setAttribute(
			'aria-label',
			'Stop playback but keep generating the rest of this note in the background, so you can jump back into it later.',
		);
		backgroundButton.onclick = () => this.plugin.reader.continueGeneratingInBackground();

		const activeFile = this.getActiveFile();
		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		void this.plugin.reader.getAudioInfo(activeFile).then((info) => {
			if (!info) return;

			// Read button's label only makes sense while it's actually clickable (not `active`) — leave it
			// alone otherwise so it doesn't flash "Regenerate" next to a disabled "Reading" state. Play saved
			// isn't gated the same way: it's available the instant a saved file exists, even mid-read, since
			// clicking it just stops whatever's currently happening and plays the saved copy instead (same
			// pattern as Read/Regenerate staying clickable while a *different* note is playing).
			if (!active) {
				const voiceMismatch = info.voiceId !== undefined && info.voiceId !== this.plugin.settings.voiceId;
				if (info.status === 'outdated') {
					this.setButtonLabel(readButton, readLabelEl, 'Regenerate');
				} else if (voiceMismatch) {
					this.setButtonLabel(readButton, readLabelEl, 'Regenerate with new voice');
				}
			}

			playSavedButton.disabled = false;
			playSavedButton.onclick = () => void this.plugin.reader.playSavedFile(info.audioFile, activeFile);
		});
	}

	private showOptionsMenu(evt: MouseEvent): void {
		const activeFile = this.getActiveFile();
		const clearEnabled = this.plugin.settings.showClearFilesButton && this.plugin.settings.linkAudioInNote && !!activeFile;

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Clear reader files')
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
