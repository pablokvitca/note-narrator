import { App, Events, MarkdownView, Notice } from 'obsidian';
import { DEFAULT_ELEVENLABS_CHAR_LIMIT, ELEVENLABS_MODEL_CHAR_LIMITS, ReaderSettings } from './settings';
import { chunkText, stripMarkdown } from './text-utils';
import { ElevenLabsProvider } from './tts/elevenlabs-provider';

export type ReaderStatus = 'idle' | 'generating' | 'playing' | 'paused';

export interface ReaderState {
	status: ReaderStatus;
	chunkIndex: number;
	chunkCount: number;
	currentTime: number;
	duration: number;
}

const IDLE_STATE: ReaderState = { status: 'idle', chunkIndex: 0, chunkCount: 0, currentTime: 0, duration: 0 };

export class Reader extends Events {
	private audio: HTMLAudioElement | null = null;
	private sessionId = 0;
	private resolveCurrentChunk: (() => void) | null = null;
	private state: ReaderState = { ...IDLE_STATE };

	constructor(
		private app: App,
		private settings: ReaderSettings,
	) {
		super();
	}

	getState(): ReaderState {
		return this.state;
	}

	private setState(patch: Partial<ReaderState>): void {
		this.state = { ...this.state, ...patch };
		this.trigger('change');
	}

	isPlaying(): boolean {
		return this.state.status === 'playing';
	}

	stop(): void {
		this.sessionId++;
		if (this.audio) {
			this.audio.pause();
			URL.revokeObjectURL(this.audio.src);
			this.audio = null;
		}
		if (this.resolveCurrentChunk) {
			const resolve = this.resolveCurrentChunk;
			this.resolveCurrentChunk = null;
			resolve();
		}
		this.setState(IDLE_STATE);
	}

	pause(): void {
		if (this.audio && !this.audio.paused) {
			this.audio.pause();
			this.setState({ status: 'paused' });
		}
	}

	resume(): void {
		if (this.audio && this.audio.paused && this.state.status === 'paused') {
			void this.audio.play();
			this.setState({ status: 'playing' });
		}
	}

	skip(seconds: number): void {
		if (!this.audio) return;
		const duration = this.audio.duration || Infinity;
		this.audio.currentTime = Math.min(Math.max(this.audio.currentTime + seconds, 0), duration);
	}

	setPlaybackRate(rate: number): void {
		this.settings.playbackRate = rate;
		if (this.audio) this.audio.playbackRate = rate;
	}

	async readNote(view?: MarkdownView): Promise<void> {
		const target = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!target) {
			new Notice('Open a note to read it aloud.');
			return;
		}

		const selection = target.editor.getSelection();
		const useSelection = this.settings.readSelectionIfPresent && selection.length > 0;
		await this.readText(useSelection ? selection : target.editor.getValue());
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
		const session = this.sessionId;

		const charLimit = ELEVENLABS_MODEL_CHAR_LIMITS[this.settings.modelId] ?? DEFAULT_ELEVENLABS_CHAR_LIMIT;
		const chunks = chunkText(text, charLimit);
		const provider = new ElevenLabsProvider(apiKey, this.settings);

		this.setState({ status: 'generating', chunkIndex: 0, chunkCount: chunks.length, currentTime: 0, duration: 0 });

		for (const [i, chunk] of chunks.entries()) {
			if (session !== this.sessionId) return;
			this.setState({ status: 'generating', chunkIndex: i });

			let audioData: ArrayBuffer;
			try {
				audioData = await provider.synthesize(chunk);
			} catch (error) {
				console.error('Obsidian Reader: failed to read note aloud', error);
				new Notice(`Failed to read note aloud: ${error instanceof Error ? error.message : String(error)}`);
				this.setState(IDLE_STATE);
				return;
			}

			if (session !== this.sessionId) return;
			await this.playChunk(audioData, i, chunks.length);
		}

		if (session === this.sessionId) this.setState(IDLE_STATE);
	}

	private playChunk(audioData: ArrayBuffer, index: number, count: number): Promise<void> {
		return new Promise((resolve) => {
			const blob = new Blob([audioData], { type: 'audio/mpeg' });
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			audio.playbackRate = this.settings.playbackRate;
			this.audio = audio;

			const onTimeUpdate = () => this.setState({ currentTime: audio.currentTime, duration: audio.duration || 0 });

			const finish = () => {
				audio.removeEventListener('timeupdate', onTimeUpdate);
				URL.revokeObjectURL(url);
				if (this.audio === audio) this.audio = null;
				this.resolveCurrentChunk = null;
				resolve();
			};

			this.resolveCurrentChunk = finish;
			audio.addEventListener('loadedmetadata', () => this.setState({ duration: audio.duration || 0 }));
			audio.addEventListener('timeupdate', onTimeUpdate);
			audio.addEventListener('ended', finish);
			audio.addEventListener('error', finish);

			this.setState({ status: 'playing', chunkIndex: index, chunkCount: count, currentTime: 0, duration: audio.duration || 0 });
			void audio.play();
		});
	}
}
