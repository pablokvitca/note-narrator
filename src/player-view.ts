import { ItemView, Setting, WorkspaceLeaf } from 'obsidian';
import ObsidianReaderPlugin from './main';
import { ReaderState } from './reader';

export const READER_VIEW_TYPE = 'obsidian-reader-player';

const STATUS_LABELS: Record<ReaderState['status'], string> = {
	idle: 'Nothing playing.',
	generating: 'Generating speech…',
	playing: 'Reading…',
	paused: 'Paused.',
};

export class PlayerView extends ItemView {
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
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('obsidian-reader-player-view');

		const state = this.plugin.reader.getState();
		const active = state.status !== 'idle';

		contentEl.createDiv({ cls: 'obsidian-reader-status', text: STATUS_LABELS[state.status] });

		if (state.chunkCount > 1) {
			contentEl.createDiv({
				cls: 'obsidian-reader-chunk-progress',
				text: `Part ${state.chunkIndex + 1} of ${state.chunkCount}`,
			});
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

		const controls = contentEl.createDiv({ cls: 'obsidian-reader-controls' });
		const skipSeconds = this.plugin.settings.skipSeconds;

		const rewindBtn = controls.createEl('button', { text: `« ${skipSeconds}s` });
		rewindBtn.disabled = !active;
		rewindBtn.onclick = () => this.plugin.reader.skip(-skipSeconds);

		const playPauseBtn = controls.createEl('button', {
			text: state.status === 'paused' ? 'Resume' : 'Pause',
		});
		playPauseBtn.disabled = !active;
		playPauseBtn.onclick = () => {
			if (state.status === 'playing') this.plugin.reader.pause();
			else if (state.status === 'paused') this.plugin.reader.resume();
		};

		const skipBtn = controls.createEl('button', { text: `${skipSeconds}s »` });
		skipBtn.disabled = !active;
		skipBtn.onclick = () => this.plugin.reader.skip(skipSeconds);

		const stopBtn = controls.createEl('button', { text: 'Stop' });
		stopBtn.disabled = !active;
		stopBtn.onclick = () => this.plugin.reader.stop();

		new Setting(contentEl).setName('Playback speed').addSlider((slider) =>
			slider
				.setLimits(0.5, 2, 0.05)
				.setValue(this.plugin.settings.playbackRate)
				.onChange(async (value) => {
					this.plugin.reader.setPlaybackRate(value);
					await this.plugin.saveSettings();
				}),
		);
	}
}
