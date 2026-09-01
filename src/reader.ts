import { App, MarkdownView, Notice } from 'obsidian';
import { ReaderSettings } from './settings';
import { stripMarkdown } from './text-utils';
import { ElevenLabsProvider } from './tts/elevenlabs-provider';

export class Reader {
	private audio: HTMLAudioElement | null = null;

	constructor(
		private app: App,
		private settings: ReaderSettings,
	) {}

	isPlaying(): boolean {
		return this.audio !== null && !this.audio.paused;
	}

	stop(): void {
		if (!this.audio) return;
		this.audio.pause();
		URL.revokeObjectURL(this.audio.src);
		this.audio = null;
	}

	async readActiveNote(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('Open a note to read it aloud.');
			return;
		}

		const selection = view.editor.getSelection();
		const useSelection = this.settings.readSelectionIfPresent && selection.length > 0;
		await this.readText(useSelection ? selection : view.editor.getValue());
	}

	private async readText(rawText: string): Promise<void> {
		const text = stripMarkdown(rawText).trim();
		if (!text) {
			new Notice('Nothing to read.');
			return;
		}

		const apiKey = this.app.secretStorage.getSecret(this.settings.apiKeySecretId);
		if (!apiKey) {
			new Notice('Set an ElevenLabs API key in the Obsidian Reader settings.');
			return;
		}

		this.stop();

		const notice = new Notice('Generating speech…', 0);
		try {
			const provider = new ElevenLabsProvider(apiKey, this.settings);
			const audioData = await provider.synthesize(text);
			const blob = new Blob([audioData], { type: 'audio/mpeg' });
			const url = URL.createObjectURL(blob);
			this.audio = new Audio(url);
			this.audio.playbackRate = this.settings.playbackRate;
			this.audio.addEventListener('ended', () => this.stop());
			await this.audio.play();
		} catch (error) {
			console.error('Obsidian Reader: failed to read note aloud', error);
			new Notice(`Failed to read note aloud: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			notice.hide();
		}
	}
}
