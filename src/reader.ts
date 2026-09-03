import { App, Events, MarkdownView, moment, Notice, normalizePath, TFile } from 'obsidian';
import { concatArrayBuffers, sanitizeFilenameComponent } from './audio-utils';
import { DEFAULT_ELEVENLABS_CHAR_LIMIT, ELEVENLABS_MODEL_CHAR_LIMITS, ReaderSettings } from './settings';
import { buildReadingPreamble, chunkByWordCount, chunkBySentence, chunkNote, hashText, stripFrontmatter } from './text-utils';
import { ElevenLabsProvider, getElevenLabsVoiceName } from './tts/elevenlabs-provider';

export type ReaderStatus = 'idle' | 'generating' | 'playing' | 'paused';
export type AudioLinkStatus = 'none' | 'up-to-date' | 'outdated';

export interface ReaderState {
	status: ReaderStatus;
	chunkIndex: number;
	chunkCount: number;
	currentTime: number;
	duration: number;
	/** Whether each chunk's audio has finished generating, for the segmented generation-progress bar. */
	chunkReady: boolean[];
	/** The note this status is about, so the panel can show it even when it isn't the currently-active note. Null when reading a selection with no backing file, or once idle. */
	activeFile: TFile | null;
}

const IDLE_STATE: ReaderState = {
	status: 'idle',
	chunkIndex: 0,
	chunkCount: 0,
	currentTime: 0,
	duration: 0,
	chunkReady: [],
	activeFile: null,
};

type ChunkOutcome = 'ended' | 'next' | 'previous';

export class Reader extends Events {
	private audio: HTMLAudioElement | null = null;
	private sessionId = 0;
	private resolveCurrentChunk: ((outcome: ChunkOutcome) => void) | null = null;
	private state: ReaderState = { ...IDLE_STATE };
	/** Live playback rate for the current/next read. Starts from settings.playbackRate but is never persisted back to it. */
	private currentPlaybackRate: number;

	/** Chunk texts and their generated audio for the active read, addressable so Previous/Next part can jump around. */
	private chunks: string[] = [];
	private chunkBuffers: (ArrayBuffer | undefined)[] = [];
	private chunkPromises: (Promise<ArrayBuffer> | undefined)[] = [];
	private provider: ElevenLabsProvider | null = null;
	private sourceFileForSave: TFile | null = null;
	/** Whether the current read's audio has already been saved (triggered once generation of every chunk completes). */
	private savedForSession = false;
	/** Set once a 429 is seen this session; falls back parallel generation to sequential (1 at a time) to avoid repeating it. */
	private rateLimited = false;

	constructor(
		private app: App,
		private settings: ReaderSettings,
	) {
		super();
		this.currentPlaybackRate = settings.playbackRate;
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
			resolve('ended');
		}
		this.setState(IDLE_STATE);
	}

	/** Jumps to the next chunk without waiting for the current one to finish playing. No-op past the last chunk. */
	nextPart(): void {
		if (!this.resolveCurrentChunk) return;
		const resolve = this.resolveCurrentChunk;
		this.resolveCurrentChunk = null;
		resolve('next');
	}

	/** Jumps to the previous chunk (or restarts the current one if already on the first). */
	previousPart(): void {
		if (!this.resolveCurrentChunk) return;
		const resolve = this.resolveCurrentChunk;
		this.resolveCurrentChunk = null;
		resolve('previous');
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

	/** Live-only: applies to the current/next read but is never written back to settings.playbackRate. */
	getPlaybackRate(): number {
		return this.currentPlaybackRate;
	}

	setPlaybackRate(rate: number): void {
		this.currentPlaybackRate = rate;
		if (this.audio) this.audio.playbackRate = rate;
	}

	async readNote(view?: MarkdownView): Promise<void> {
		const target = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!target) {
			new Notice('Open a note to read it aloud.');
			return;
		}

		const selection = target.editor.getSelection();
		if (this.settings.readSelectionIfPresent && selection.length > 0) {
			await this.readText(selection, target.file, { allowSave: false });
			return;
		}

		const body = stripFrontmatter(target.editor.getValue());
		const frontmatter = target.file ? this.app.metadataCache.getFileCache(target.file)?.frontmatter : undefined;
		const preamble = buildReadingPreamble(target.file?.basename ?? null, frontmatter, {
			readTitle: this.settings.readTitle,
			readProperties: this.settings.readProperties,
		});

		await this.readText(preamble ? `${preamble}\n\n${body}` : body, target.file, { allowSave: true });
	}

	private async readText(rawText: string, sourceFile: TFile | null, options: { allowSave: boolean }): Promise<void> {
		const apiKey = this.app.secretStorage.getSecret(this.settings.apiKeySecretId);
		if (!apiKey) {
			new Notice('Set an ElevenLabs API key in the Obsidian Reader settings.');
			return;
		}

		const charLimit = ELEVENLABS_MODEL_CHAR_LIMITS[this.settings.modelId] ?? DEFAULT_ELEVENLABS_CHAR_LIMIT;
		let chunks = chunkNote(rawText, charLimit, this.settings.chunkerStyle, this.settings.maxHeadingDepth);
		if (chunks.length === 0) {
			new Notice('Nothing to read.');
			return;
		}

		// Quick start: split the first chunk into a short lead-in plus the remainder (including the
		// preamble, since it's already part of chunks[0]), so the first TTS request returns sooner.
		if (this.settings.startPlaybackImmediately && this.settings.quickStart) {
			const [firstChunk, ...rest] = chunks;
			if (firstChunk !== undefined) {
				const leadPieces =
					this.settings.quickStartUnit === 'words'
						? chunkByWordCount(firstChunk, this.settings.quickStartWordCount)
						: chunkBySentence(firstChunk, this.settings.quickStartCharCount);
				chunks = [...leadPieces, ...rest];
			}
		}

		this.stop();
		const session = this.sessionId;
		this.currentPlaybackRate = this.settings.playbackRate;
		this.chunks = chunks;
		this.chunkBuffers = new Array<ArrayBuffer | undefined>(chunks.length);
		this.chunkPromises = new Array<Promise<ArrayBuffer> | undefined>(chunks.length);
		this.rateLimited = false;
		this.provider = new ElevenLabsProvider(apiKey, this.settings, () => this.handleRateLimited());
		this.sourceFileForSave = options.allowSave ? sourceFile : null;
		this.savedForSession = false;
		this.setState({
			status: 'generating',
			chunkIndex: 0,
			chunkCount: chunks.length,
			currentTime: 0,
			duration: 0,
			chunkReady: new Array<boolean>(chunks.length).fill(false),
			activeFile: sourceFile,
		});

		if (!this.settings.startPlaybackImmediately) {
			const ok = await this.generateAllChunks(session);
			if (!ok || session !== this.sessionId) return;
		}

		await this.playFromIndex(session, 0);
	}

	/** Called (possibly repeatedly) the moment a 429 is seen; falls back to sequential generation for the rest of this read. */
	private handleRateLimited(): void {
		if (this.rateLimited) return;
		this.rateLimited = true;
		new Notice('ElevenLabs rate limit hit — retrying with backoff and switching to sequential chunk generation.');
	}

	/** Generates every chunk (respecting the parallel-generation setting) before any playback starts. Returns false on failure. */
	private async generateAllChunks(session: number): Promise<boolean> {
		const windowSize = this.settings.parallelGenerationEnabled ? Math.max(1, this.settings.maxParallelGeneration) : 1;
		let nextIndex = 0;

		const worker = async (workerId: number) => {
			while (nextIndex < this.chunks.length) {
				if (session !== this.sessionId) return;
				// Once rate-limited, only the primary worker keeps going; the rest stop claiming new work.
				if (this.rateLimited && workerId > 0) return;
				const index = nextIndex++;
				this.setState({ status: 'generating', chunkIndex: index });
				await this.ensureChunkBuffer(index);
			}
		};

		try {
			await Promise.all(Array.from({ length: windowSize }, (_, workerId) => worker(workerId)));
			return true;
		} catch (error) {
			if (session !== this.sessionId) return false;
			console.error('Obsidian Reader: failed to read note aloud', error);
			new Notice(`Failed to read note aloud: ${error instanceof Error ? error.message : String(error)}`);
			this.setState(IDLE_STATE);
			return false;
		}
	}

	/** Generates (if needed) and plays chunks starting at index, honoring Previous/Next-part jumps. */
	private async playFromIndex(session: number, startIndex: number): Promise<void> {
		let index = startIndex;

		while (index >= 0 && index < this.chunks.length) {
			if (session !== this.sessionId) return;
			this.setState({ status: 'generating', chunkIndex: index });

			let audioData: ArrayBuffer;
			try {
				audioData = await this.ensureChunkBuffer(index);
			} catch (error) {
				console.error('Obsidian Reader: failed to read note aloud', error);
				new Notice(`Failed to read note aloud: ${error instanceof Error ? error.message : String(error)}`);
				this.setState(IDLE_STATE);
				return;
			}

			this.prefetchAhead(index);

			if (session !== this.sessionId) return;
			const outcome = await this.playChunk(audioData, index, this.chunks.length);
			if (session !== this.sessionId) return;

			index = outcome === 'previous' ? Math.max(0, index - 1) : index + 1;
		}

		if (session !== this.sessionId) return;
		this.setState(IDLE_STATE);
	}

	/** Kicks off generation for the next chunks within the configured parallel-generation window (a no-op if disabled). */
	private prefetchAhead(fromIndex: number): void {
		if (!this.settings.parallelGenerationEnabled || this.rateLimited) return;
		const windowSize = Math.max(1, this.settings.maxParallelGeneration);
		for (let offset = 1; offset < windowSize; offset++) {
			this.prefetchChunkBuffer(fromIndex + offset);
		}
	}

	private ensureChunkBuffer(index: number): Promise<ArrayBuffer> {
		const cached = this.chunkBuffers[index];
		if (cached) return Promise.resolve(cached);

		const inFlight = this.chunkPromises[index];
		if (inFlight) return inFlight;

		const promise = this.provider!.synthesize(this.chunks[index] ?? '').then((buffer) => {
			this.chunkBuffers[index] = buffer;
			const chunkReady = [...this.state.chunkReady];
			chunkReady[index] = true;
			this.setState({ chunkReady });
			this.maybeSaveOnGenerationComplete(chunkReady);
			return buffer;
		});
		this.chunkPromises[index] = promise;
		return promise;
	}

	/** Saves (once) as soon as every chunk has finished generating, regardless of playback progress. */
	private maybeSaveOnGenerationComplete(chunkReady: boolean[]): void {
		if (this.savedForSession) return;
		if (chunkReady.length === 0 || !chunkReady.every(Boolean)) return;
		if (!this.settings.saveAudioFile || !this.sourceFileForSave) return;

		this.savedForSession = true;
		const buffers = this.chunkBuffers.filter((buffer): buffer is ArrayBuffer => buffer !== undefined);
		void this.saveAudioFile(buffers, this.sourceFileForSave);
	}

	private prefetchChunkBuffer(index: number): void {
		if (index < 0 || index >= this.chunks.length || this.chunkBuffers[index] || this.chunkPromises[index]) return;
		void this.ensureChunkBuffer(index).catch((error: unknown) => {
			console.error('Obsidian Reader: failed to prefetch chunk', error);
		});
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
		const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
		const storedPath = frontmatter?.[this.settings.audioPathProperty] as string | undefined;
		if (!storedPath) return null;
		const file = this.app.vault.getAbstractFileByPath(storedPath);
		return file instanceof TFile ? file : null;
	}

	private async linkAudioInNote(audioFile: TFile, sourceFile: TFile): Promise<void> {
		const link = this.app.fileManager.generateMarkdownLink(audioFile, sourceFile.path);
		const currentContent = await this.app.vault.cachedRead(sourceFile);
		const hash = hashText(currentContent);

		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			frontmatter[this.settings.audioLinkProperty] = link;
			frontmatter[this.settings.audioHashProperty] = hash;
			frontmatter[this.settings.audioPathProperty] = audioFile.path;
			frontmatter[this.settings.audioTimestampProperty] = moment().toISOString(true);
			frontmatter[this.settings.audioVoiceProperty] = this.settings.voiceId;
		});
	}

	/** Deletes a note's linked audio file (if any) and removes the reader-audio properties from its frontmatter. */
	async clearReaderFiles(sourceFile: TFile): Promise<void> {
		const audioFile = this.findExistingAudioFile(sourceFile);
		if (audioFile) {
			await this.app.fileManager.trashFile(audioFile);
		}

		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			delete frontmatter[this.settings.audioLinkProperty];
			delete frontmatter[this.settings.audioHashProperty];
			delete frontmatter[this.settings.audioPathProperty];
			delete frontmatter[this.settings.audioTimestampProperty];
			delete frontmatter[this.settings.audioVoiceProperty];
		});

		new Notice(audioFile ? 'Cleared reader audio file and properties.' : 'Cleared reader properties (no audio file was linked).');
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
			const body = stripFrontmatter(rawText);
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const preamble = buildReadingPreamble(file.basename, frontmatter, {
				readTitle: this.settings.readTitle,
				readProperties: this.settings.readProperties,
			});
			const textToRead = preamble ? `${preamble}\n\n${body}` : body;

			const charLimit = ELEVENLABS_MODEL_CHAR_LIMITS[this.settings.modelId] ?? DEFAULT_ELEVENLABS_CHAR_LIMIT;
			const chunks = chunkNote(textToRead, charLimit, this.settings.chunkerStyle, this.settings.maxHeadingDepth);
			if (chunks.length === 0) return;

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
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const link = frontmatter?.[this.settings.audioLinkProperty] as string | undefined;
		const storedHash = frontmatter?.[this.settings.audioHashProperty] as string | undefined;
		if (!link || !storedHash) return 'none';

		const currentContent = await this.app.vault.cachedRead(file);
		return hashText(currentContent) === storedHash ? 'up-to-date' : 'outdated';
	}

	/** Info about a note's linked saved audio, for the player view's "Play saved"/"Regenerate" buttons. Null if none exists. */
	async getAudioInfo(file: TFile): Promise<{ audioFile: TFile; status: AudioLinkStatus; voiceId: string | undefined } | null> {
		const audioFile = this.findExistingAudioFile(file);
		if (!audioFile) return null;

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const voiceId = frontmatter?.[this.settings.audioVoiceProperty] as string | undefined;
		const status = await this.getAudioStatus(file);
		return { audioFile, status, voiceId };
	}

	/** Plays a previously saved audio file directly, without generating anything. */
	async playSavedFile(audioFile: TFile, sourceFile: TFile | null = null): Promise<void> {
		this.stop();
		const session = this.sessionId;

		try {
			const data = await this.app.vault.readBinary(audioFile);
			if (session !== this.sessionId) return;

			this.chunks = [];
			this.chunkBuffers = [data];
			this.chunkPromises = [];
			this.provider = null;
			this.sourceFileForSave = null;
			this.savedForSession = true;
			this.currentPlaybackRate = this.settings.playbackRate;
			this.setState({
				status: 'playing',
				chunkIndex: 0,
				chunkCount: 1,
				currentTime: 0,
				duration: 0,
				chunkReady: [true],
				activeFile: sourceFile,
			});

			if (session !== this.sessionId) return;
			await this.playChunk(data, 0, 1);
			if (session !== this.sessionId) return;
			this.setState(IDLE_STATE);
		} catch (error) {
			console.error('Obsidian Reader: failed to play saved audio', error);
			new Notice(`Failed to play saved audio: ${error instanceof Error ? error.message : String(error)}`);
			this.setState(IDLE_STATE);
		}
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

	private playChunk(audioData: ArrayBuffer, index: number, count: number): Promise<ChunkOutcome> {
		return new Promise((resolve) => {
			const blob = new Blob([audioData], { type: 'audio/mpeg' });
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			audio.playbackRate = this.currentPlaybackRate;
			this.audio = audio;

			const onTimeUpdate = () => this.setState({ currentTime: audio.currentTime, duration: audio.duration || 0 });

			const cleanup = () => {
				audio.removeEventListener('timeupdate', onTimeUpdate);
				URL.revokeObjectURL(url);
				if (this.audio === audio) this.audio = null;
				this.resolveCurrentChunk = null;
			};

			const finish = (outcome: ChunkOutcome) => {
				cleanup();
				resolve(outcome);
			};

			this.resolveCurrentChunk = finish;
			audio.addEventListener('loadedmetadata', () => this.setState({ duration: audio.duration || 0 }));
			audio.addEventListener('timeupdate', onTimeUpdate);
			audio.addEventListener('ended', () => finish('ended'));
			audio.addEventListener('error', () => finish('ended'));

			this.setState({ status: 'playing', chunkIndex: index, chunkCount: count, currentTime: 0, duration: audio.duration || 0 });
			void audio.play();
		});
	}
}
