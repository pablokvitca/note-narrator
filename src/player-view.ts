import { debounce, ItemView, MarkdownView, Menu, setIcon, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { ConfirmModal } from './confirm-modal';
import ObsidianReaderPlugin from './main';
import { AudioLinkStatus, ReaderState } from './reader';
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

function formatTime(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.floor(totalSeconds % 60);
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

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
		return [state.status, state.chunkIndex, state.chunkCount, state.chunkReady.join(',')].join('|');
	}

	private updateProgress(state: ReaderState): void {
		if (this.progressFillEl && state.status !== 'generating') {
			const percent = state.duration > 0 ? Math.min(100, (state.currentTime / state.duration) * 100) : 0;
			this.progressFillEl.style.width = `${percent}%`;
		}

		if (this.timeEl) {
			this.timeEl.style.display = state.duration > 0 ? '' : 'none';
			if (state.duration > 0) {
				const rate = this.plugin.reader.getPlaybackRate();
				const remaining = (state.duration - state.currentTime) / rate;
				this.timeEl.setText(`${formatTime(state.currentTime)} / ${formatTime(state.duration)} · ${formatTime(remaining)} remaining`);
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
		contentEl.createDiv({
			cls: 'obsidian-reader-selected-note',
			text: selectedFile ? `Read: ${selectedFile.basename}` : 'Open a note to read it aloud',
		});

		if (state.activeFile && (!selectedFile || state.activeFile.path !== selectedFile.path)) {
			const currentlyReading = contentEl.createDiv({ cls: 'obsidian-reader-currently-reading' });
			currentlyReading.createSpan({ cls: 'obsidian-reader-currently-reading-icon' }, (el) => setIcon(el, 'headphones'));
			currentlyReading.createSpan({ text: `Currently reading: ${state.activeFile.basename}` });
		}

		contentEl.createDiv({ cls: 'obsidian-reader-status', text: STATUS_LABELS[state.status] });

		if (state.chunkCount > 1) {
			this.chunkProgressEl = contentEl.createDiv({ cls: 'obsidian-reader-chunk-progress' });

			const generationBar = contentEl.createDiv({ cls: 'obsidian-reader-generation-bar' });
			for (let i = 0; i < state.chunkCount; i++) {
				const segment = generationBar.createDiv({ cls: 'obsidian-reader-generation-segment' });
				if (state.chunkReady[i]) segment.addClass('is-ready');
				if (i === state.chunkIndex) segment.addClass('is-current');
			}
		}

		const bar = contentEl.createDiv({ cls: 'obsidian-reader-progress-bar' });
		if (state.status === 'generating') {
			bar.addClass('is-indeterminate');
			bar.createDiv({ cls: 'obsidian-reader-progress-fill' });
		} else {
			this.progressFillEl = bar.createDiv({ cls: 'obsidian-reader-progress-fill' });
		}

		this.timeEl = contentEl.createDiv({ cls: 'obsidian-reader-time' });
		this.updateProgress(state);

		this.renderVoiceSelector(contentEl);

		this.renderNoteStats(contentEl, selectedFile);

		this.renderPrimaryActions(contentEl, active, state.status);

		{
			const partsDisabled = !active || state.chunkCount <= 1;
			const partControls = contentEl.createDiv({ cls: 'obsidian-reader-controls' });
			this.createIconButton(partControls, 'step-back', 'Previous part', partsDisabled, () => this.plugin.reader.previousPart());
			this.createIconButton(
				partControls,
				'step-forward',
				'Next part',
				partsDisabled || state.chunkIndex >= state.chunkCount - 1,
				() => this.plugin.reader.nextPart(),
			);
		}

		const controls = contentEl.createDiv({ cls: 'obsidian-reader-controls' });

		this.createIconButton(controls, 'skip-back', `Rewind ${skipSeconds}s`, !active, () =>
			this.plugin.reader.skip(-skipSeconds),
		);

		this.createIconButton(controls, state.status === 'paused' ? 'circle-play' : 'circle-pause', state.status === 'paused' ? 'Resume' : 'Pause', !active, () => {
			if (state.status === 'playing') this.plugin.reader.pause();
			else if (state.status === 'paused') this.plugin.reader.resume();
		}).addClass('obsidian-reader-control-primary');

		this.createIconButton(controls, 'skip-forward', `Skip forward ${skipSeconds}s`, !active, () =>
			this.plugin.reader.skip(skipSeconds),
		);

		this.createIconButton(controls, 'square-stop', 'Stop', !active, () => this.plugin.reader.stop());

		const currentRate = this.plugin.reader.getPlaybackRate();
		const speedSetting = new Setting(contentEl).setName(`Playback speed: ${currentRate.toFixed(2)}x`);
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

		const isMuted = this.plugin.reader.isMuted();
		const currentVolume = this.plugin.reader.getVolume();
		const volumeSetting = new Setting(contentEl).setName(`Volume: ${isMuted ? 'Muted' : `${Math.round(currentVolume * 100)}%`}`);
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

		this.renderAudioStatus(contentEl);
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

	private renderAudioStatus(container: HTMLElement): void {
		const activeFile = this.getActiveFile();
		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		const statusEl = container.createDiv({ cls: 'obsidian-reader-audio-status' });
		void this.plugin.reader.getAudioStatus(activeFile).then((status) => {
			if (status === 'none') return;
			statusEl.setText(AUDIO_STATUS_LABELS[status]);
			statusEl.addClass(status === 'outdated' ? 'is-outdated' : 'is-up-to-date');
		});
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

	private renderPrimaryActions(container: HTMLElement, active: boolean, status: ReaderState['status']): void {
		const actionsRow = container.createDiv({ cls: 'obsidian-reader-primary-actions' });

		const playSavedButton = actionsRow.createEl('button', { cls: 'obsidian-reader-play-saved-button', text: 'Play saved' });
		playSavedButton.disabled = true;

		const readButton = actionsRow.createEl('button', {
			cls: 'mod-cta obsidian-reader-read-button',
			text: active ? 'Reading' : 'Read',
		});
		readButton.disabled = active;
		readButton.onclick = () => void this.plugin.reader.readNote(this.getActiveMarkdownView() ?? undefined);

		const cancelButton = actionsRow.createEl('button', { cls: 'obsidian-reader-cancel-button', text: 'Cancel generation' });
		cancelButton.disabled = status !== 'generating';
		cancelButton.onclick = () => this.plugin.reader.stop();

		const activeFile = this.getActiveFile();
		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		void this.plugin.reader.getAudioInfo(activeFile).then((info) => {
			if (!info || active) return;

			const voiceMismatch = info.voiceId !== undefined && info.voiceId !== this.plugin.settings.voiceId;
			if (info.status === 'outdated') {
				readButton.setText('Regenerate');
			} else if (voiceMismatch) {
				readButton.setText('Regenerate with new voice');
			}

			playSavedButton.disabled = active;
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
					new ConfirmModal(
						this.app,
						'Clear reader files?',
						`This deletes ${activeFile.basename}'s linked audio file and removes the reader-audio properties from its frontmatter. This can't be undone from within Obsidian Reader.`,
						'Clear',
						() => void this.plugin.reader.clearReaderFiles(activeFile),
					).open();
				}),
		);
		menu.showAtMouseEvent(evt);
	}
}
