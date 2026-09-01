import { debounce, ItemView, MarkdownView, setIcon, Setting, WorkspaceLeaf } from 'obsidian';
import { ConfirmModal } from './confirm-modal';
import ObsidianReaderPlugin from './main';
import { AudioLinkStatus, ReaderState } from './reader';
import { ElevenLabsVoice, listElevenLabsVoices } from './tts/elevenlabs-provider';

export const READER_VIEW_TYPE = 'obsidian-reader-player';

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
		return 'Obsidian Reader';
	}

	getIcon(): string {
		return 'audio-lines';
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.plugin.reader.on('change', () => this.render()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.render()));

		const debouncedRender = debounce(() => this.render(), 1000, true);
		this.registerEvent(this.app.workspace.on('editor-change', () => debouncedRender()));

		void this.loadVoices();
		this.render();
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

		contentEl.createDiv({ cls: 'obsidian-reader-status', text: STATUS_LABELS[state.status] });

		if (state.chunkCount > 1) {
			const chunkFraction = state.duration > 0 ? state.currentTime / state.duration : 0;
			const overallPercent = Math.round(Math.min(1, (state.chunkIndex + chunkFraction) / state.chunkCount) * 100);
			contentEl.createDiv({
				cls: 'obsidian-reader-chunk-progress',
				text: `Part ${state.chunkIndex + 1} of ${state.chunkCount} · ${overallPercent}% complete`,
			});

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
			const percent = state.duration > 0 ? Math.min(100, (state.currentTime / state.duration) * 100) : 0;
			const fill = bar.createDiv({ cls: 'obsidian-reader-progress-fill' });
			fill.style.width = `${percent}%`;
		}

		if (state.duration > 0) {
			const rate = this.plugin.reader.getPlaybackRate();
			const remaining = (state.duration - state.currentTime) / rate;
			contentEl.createDiv({
				cls: 'obsidian-reader-time',
				text: `${formatTime(state.currentTime)} / ${formatTime(state.duration)} · ${formatTime(remaining)} remaining`,
			});
		}

		this.renderVoiceSelector(contentEl);

		if (!active) {
			this.renderPrimaryActions(contentEl);
		}

		if (state.chunkCount > 1) {
			const partControls = contentEl.createDiv({ cls: 'obsidian-reader-controls' });
			this.createIconButton(partControls, 'step-back', 'Previous part', !active, () => this.plugin.reader.previousPart());
			this.createIconButton(partControls, 'step-forward', 'Next part', !active || state.chunkIndex >= state.chunkCount - 1, () =>
				this.plugin.reader.nextPart(),
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
				.setLimits(0.5, 3, 0.05)
				.setValue(currentRate)
				.onChange((value) => {
					this.plugin.reader.setPlaybackRate(value);
					speedSetting.setName(`Playback speed: ${value.toFixed(2)}x`);
				}),
		);
		const speedRange = speedSetting.controlEl.createDiv({ cls: 'obsidian-reader-speed-range' });
		speedRange.createSpan({ text: '0.5x' });
		speedRange.createSpan({ text: '3x' });

		this.renderAudioStatus(contentEl);
		this.renderClearFilesButton(contentEl);
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
		const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		const statusEl = container.createDiv({ cls: 'obsidian-reader-audio-status' });
		void this.plugin.reader.getAudioStatus(activeFile).then((status) => {
			if (status === 'none') return;
			statusEl.setText(AUDIO_STATUS_LABELS[status]);
			statusEl.addClass(status === 'outdated' ? 'is-outdated' : 'is-up-to-date');
		});
	}

	private renderPrimaryActions(container: HTMLElement): void {
		const actionsRow = container.createDiv({ cls: 'obsidian-reader-primary-actions' });
		const readButton = actionsRow.createEl('button', {
			cls: 'mod-cta obsidian-reader-read-button',
			text: 'Read',
		});
		readButton.onclick = () => void this.plugin.reader.readNote();

		const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!activeFile || !this.plugin.settings.linkAudioInNote) return;

		void this.plugin.reader.getAudioInfo(activeFile).then((info) => {
			if (!info) return;

			const voiceMismatch = info.voiceId !== undefined && info.voiceId !== this.plugin.settings.voiceId;
			if (info.status === 'outdated') {
				readButton.setText('Regenerate');
			} else if (voiceMismatch) {
				readButton.setText('Regenerate with new voice');
			}

			const playSavedButton = actionsRow.createEl('button', { cls: 'obsidian-reader-play-saved-button', text: 'Play saved' });
			actionsRow.insertBefore(playSavedButton, readButton);
			playSavedButton.onclick = () => void this.plugin.reader.playSavedFile(info.audioFile);
		});
	}

	private renderClearFilesButton(container: HTMLElement): void {
		if (!this.plugin.settings.showClearFilesButton || !this.plugin.settings.linkAudioInNote) return;

		const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!activeFile) return;

		const button = container.createEl('button', {
			cls: 'obsidian-reader-clear-files-button',
			text: 'Clear reader files',
		});
		button.onclick = () => {
			new ConfirmModal(
				this.app,
				'Clear reader files?',
				`This deletes ${activeFile.basename}'s linked audio file and removes the reader-audio properties from its frontmatter. This can't be undone from within Obsidian Reader.`,
				'Clear',
				() => void this.plugin.reader.clearReaderFiles(activeFile),
			).open();
		};
	}
}
