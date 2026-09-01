import { App, Events, MarkdownView, moment, Notice, normalizePath, TFile } from 'obsidian';
import { concatArrayBuffers, sanitizeFilenameComponent } from './audio-utils';
import { DEFAULT_ELEVENLABS_CHAR_LIMIT, ELEVENLABS_MODEL_CHAR_LIMITS, ReaderSettings } from './settings';
import { chunkText, hashText, stripMarkdown } from './text-utils';
import { ElevenLabsProvider, getElevenLabsVoiceName } from './tts/elevenlabs-provider';

export type ReaderStatus = 'idle' | 'generating' | 'playing' | 'paused';
export type AudioLinkStatus = 'none' | 'up-to-date' | 'outdated';

function hashPropertyName(property: string): string {
	return `${property}-hash`;
}

/** Internal-only property tracking the exact saved audio file path, used to find it again for "replace" mode. */
function pathPropertyName(property: string): string {
	return `${property}-path`;
}

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
		await this.readText(useSelection ? selection : target.editor.getValue(), target.file);
	}

	private async readText(rawText: string, sourceFile: TFile | null): Promise<void> {
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

		const generatedChunks: ArrayBuffer[] = [];
		// One-chunk lookahead: the next chunk starts generating while the current one plays, so
		// there's no gap waiting on the network between chunks unless generation is slower than playback.
		let nextChunkPromise: Promise<ArrayBuffer> = provider.synthesize(chunks[0] ?? '');

		for (let i = 0; i < chunks.length; i++) {
			if (session !== this.sessionId) return;
			this.setState({ status: 'generating', chunkIndex: i });

			let audioData: ArrayBuffer;
			try {
				audioData = await nextChunkPromise;
			} catch (error) {
				console.error('Obsidian Reader: failed to read note aloud', error);
				new Notice(`Failed to read note aloud: ${error instanceof Error ? error.message : String(error)}`);
				this.setState(IDLE_STATE);
				return;
			}

			const next = chunks[i + 1];
			if (next !== undefined) {
				nextChunkPromise = provider.synthesize(next);
				nextChunkPromise.catch(() => {
					/* surfaced when awaited on the next iteration; swallowed here only to avoid an unhandled rejection if reading stops first */
				});
			}

			generatedChunks.push(audioData);
			if (session !== this.sessionId) return;
			await this.playChunk(audioData, i, chunks.length);
		}

		if (session !== this.sessionId) return;
		this.setState(IDLE_STATE);

		if (this.settings.saveAudioFile) {
			await this.saveAudioFile(generatedChunks, sourceFile);
		}
	}

	private async saveAudioFile(chunks: ArrayBuffer[], sourceFile: TFile | null): Promise<void> {
		try {
			const apiKey = this.app.secretStorage.getSecret(this.settings.apiKeySecretId);
			const voiceName = apiKey ? await this.resolveVoiceName(apiKey) : this.settings.voiceId;
			const data = concatArrayBuffers(chunks);

			const existingAudioFile =
				this.settings.saveVersioning === 'replace' && this.settings.linkAudioInNote && sourceFile
					? this.findExistingAudioFile(sourceFile)
					: null;

			let audioFile: TFile;
			if (existingAudioFile) {
				await this.app.vault.modifyBinary(existingAudioFile, data);
				audioFile = existingAudioFile;
				new Notice(`Updated audio at ${audioFile.path}`);
			} else {
				const folderPath = this.resolveSaveFolder(sourceFile);
				await this.ensureFolder(folderPath);
				const noteName = sourceFile?.basename ?? `Reading ${moment().format('YYYY-MM-DD HHmmss')}`;
				const baseName = sanitizeFilenameComponent(`${noteName} (${voiceName})`);
				const path = await this.uniquePath(folderPath, baseName, 'mp3');
				audioFile = await this.app.vault.createBinary(path, data);
				new Notice(`Saved audio to ${path}`);
			}

			if (this.settings.linkAudioInNote && sourceFile) {
				await this.linkAudioInNote(audioFile, sourceFile);
			}
		} catch (error) {
			console.error('Obsidian Reader: failed to save audio file', error);
			new Notice(`Failed to save audio file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async resolveVoiceName(apiKey: string): Promise<string> {
		try {
			return await getElevenLabsVoiceName(apiKey, this.settings.voiceId);
		} catch (error) {
			console.error('Obsidian Reader: failed to resolve voice name for filename', error);
			return this.settings.voiceId;
		}
	}

	private findExistingAudioFile(sourceFile: TFile): TFile | null {
		const property = this.settings.audioLinkProperty;
		const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
		const storedPath = frontmatter?.[pathPropertyName(property)] as string | undefined;
		if (!storedPath) return null;
		const file = this.app.vault.getAbstractFileByPath(storedPath);
		return file instanceof TFile ? file : null;
	}

	private async linkAudioInNote(audioFile: TFile, sourceFile: TFile): Promise<void> {
		const property = this.settings.audioLinkProperty;
		const link = this.app.fileManager.generateMarkdownLink(audioFile, sourceFile.path);
		const currentContent = await this.app.vault.cachedRead(sourceFile);
		const hash = hashText(currentContent);

		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			frontmatter[property] = link;
			frontmatter[hashPropertyName(property)] = hash;
			frontmatter[pathPropertyName(property)] = audioFile.path;
		});
	}

	/**
	 * Silently (re)generates and saves a note's audio if it's missing or outdated, without touching
	 * playback state — safe to call in the background (e.g. on file-open) even while something else is playing.
	 */
	async autoGenerateIfNeeded(file: TFile): Promise<void> {
		if (!this.settings.autoGenerateOnOpen || !this.settings.saveAudioFile || !this.settings.linkAudioInNote) return;
		if (file.extension !== 'md') return;

		try {
			const status = await this.getAudioStatus(file);
			if (status === 'up-to-date') return;

			const apiKey = this.app.secretStorage.getSecret(this.settings.apiKeySecretId);
			if (!apiKey) return;

			const rawText = await this.app.vault.cachedRead(file);
			const text = stripMarkdown(rawText).trim();
			if (!text) return;

			const charLimit = ELEVENLABS_MODEL_CHAR_LIMITS[this.settings.modelId] ?? DEFAULT_ELEVENLABS_CHAR_LIMIT;
			const chunks = chunkText(text, charLimit);
			const provider = new ElevenLabsProvider(apiKey, this.settings);

			const buffers: ArrayBuffer[] = [];
			for (const chunk of chunks) {
				buffers.push(await provider.synthesize(chunk));
			}

			await this.saveAudioFile(buffers, file);
		} catch (error) {
			console.error('Obsidian Reader: auto-generate on open failed', error);
		}
	}

	/** Compares the note's current content against the hash stored when its linked audio was last generated. */
	async getAudioStatus(file: TFile): Promise<AudioLinkStatus> {
		const property = this.settings.audioLinkProperty;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const link = frontmatter?.[property] as string | undefined;
		const storedHash = frontmatter?.[hashPropertyName(property)] as string | undefined;
		if (!link || !storedHash) return 'none';

		const currentContent = await this.app.vault.cachedRead(file);
		return hashText(currentContent) === storedHash ? 'up-to-date' : 'outdated';
	}

	private resolveSaveFolder(sourceFile: TFile | null): string {
		if (this.settings.saveAudioLocation === 'custom-folder') {
			return normalizePath(this.settings.saveAudioFolderPath || '/');
		}
		return sourceFile?.parent?.path ?? '/';
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		if (!folderPath || folderPath === '/') return;
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	private async uniquePath(folder: string, baseName: string, extension: string): Promise<string> {
		const base = folder && folder !== '/' ? `${folder}/${baseName}` : baseName;
		let candidate = normalizePath(`${base}.${extension}`);
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${base} (${counter}).${extension}`);
			counter++;
		}
		return candidate;
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
