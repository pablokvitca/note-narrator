import { App, Events, MarkdownView, moment, Notice, normalizePath, TFile } from 'obsidian';
import { concatArrayBuffers, sanitizeFilenameComponent } from './audio-utils';
import { buildBackgroundJobInfo, hasPendingGeneration } from './background-job';
import { DEFAULT_ELEVENLABS_CHAR_LIMIT, ELEVENLABS_MODEL_CHAR_LIMITS, ReaderSettings } from './settings';
import {
	buildReadingPreamble,
	chunkByWordCount,
	chunkBySentence,
	chunkNote,
	hashText,
	stripFrontmatter,
	StripMarkdownOptions,
} from './text-utils';
import { ElevenLabsProvider, getElevenLabsVoiceName } from './tts/elevenlabs-provider';

export type ReaderStatus = 'idle' | 'generating' | 'playing' | 'paused';
export type AudioLinkStatus = 'none' | 'up-to-date' | 'outdated';

/** Progress snapshot of a note generating in the background (not bound to playback), for the panel. */
export interface BackgroundJobInfo {
	file: TFile | null;
	chunkCount: number;
	chunkReady: boolean[];
	chunkInFlight: boolean[];
	/** True once every chunk has finished generating. */
	done: boolean;
}

export interface ReaderState {
	status: ReaderStatus;
	chunkIndex: number;
	chunkCount: number;
	currentTime: number;
	duration: number;
	/** Whether each chunk's audio has finished generating, for the segmented generation-progress bar. */
	chunkReady: boolean[];
	/** Whether each chunk is actively being generated right now (dispatched to the provider, not yet resolved), for the generation-progress bar. */
	chunkInFlight: boolean[];
	/** Decoded audio duration (seconds) of each chunk once generated, for whole-read elapsed/total/remaining. Undefined until decoded. */
	chunkDurations: (number | undefined)[];
	/** The note this status is about, so the panel can show it even when it isn't the currently-active note. Null when reading a selection with no backing file, or once idle. */
	activeFile: TFile | null;
	/** A note continuing to generate in the background after playback was stopped/detached from it. Null when there is none. Independent of the playback fields above. */
	backgroundJob: BackgroundJobInfo | null;
}

const IDLE_STATE: ReaderState = {
	status: 'idle',
	chunkIndex: 0,
	chunkCount: 0,
	currentTime: 0,
	duration: 0,
	chunkReady: [],
	chunkInFlight: [],
	chunkDurations: [],
	activeFile: null,
	backgroundJob: null,
};

type ChunkOutcome = 'ended' | 'next' | 'previous';

/**
 * A single read's generation state: its chunk texts, buffers/promises/readiness, and the provider used to
 * synthesize them. Exactly one job at a time drives active playback (`Reader.activeJob`); at most one other
 * can keep generating in the background (`Reader.backgroundJob`) after being detached from playback via
 * `continueGeneratingInBackground()`. Kept as a plain object (rather than flat fields on Reader) so a job
 * can be handed off between those two roles, or discarded, without the two roles' state colliding.
 */
interface GenerationJob {
	id: number;
	file: TFile | null;
	chunks: string[];
	chunkBuffers: (ArrayBuffer | undefined)[];
	chunkPromises: (Promise<ArrayBuffer> | undefined)[];
	chunkReady: boolean[];
	chunkInFlight: boolean[];
	chunkDurations: (number | undefined)[];
	provider: ElevenLabsProvider;
	sourceFileForSave: TFile | null;
	/** Whether this job's audio has already been saved (triggered once every chunk finishes generating). */
	savedForSession: boolean;
	/** Set once a 429 is seen for this job; falls back its generation to sequential (1 at a time) to avoid repeating it. */
	rateLimited: boolean;
	/** Set once this job is discarded (stopped, superseded, or promoted elsewhere) so any still-settling promises know not to touch playback/background state on completion. */
	cancelled: boolean;
}

export class Reader extends Events {
	private audio: HTMLAudioElement | null = null;
	private sessionId = 0;
	private resolveCurrentChunk: ((outcome: ChunkOutcome) => void) | null = null;
	private state: ReaderState = { ...IDLE_STATE };
	/** Live playback rate for the current/next read. Starts from settings.playbackRate but is never persisted back to it. */
	private currentPlaybackRate: number;
	/** Live volume/mute for the current session. Not tied to any setting — persists across reads until Obsidian restarts, like a physical volume knob. */
	private currentVolume = 1;
	private muted = false;

	private nextJobId = 0;
	/** The job currently bound to playback and driving `state`. Null when nothing is generating/playing (or a saved file is playing directly, with no generation job involved). */
	private activeJob: GenerationJob | null = null;
	/** At most one job generating without being bound to playback, kept going after `continueGeneratingInBackground()`. */
	private backgroundJob: GenerationJob | null = null;

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

	/** Resets playback to idle without disturbing an unrelated background job's progress (IDLE_STATE.backgroundJob is always null). */
	private resetToIdle(): void {
		this.setState({ ...IDLE_STATE, backgroundJob: this.state.backgroundJob });
	}

	isPlaying(): boolean {
		return this.state.status === 'playing';
	}

	/** Fully stops playback and cancels the active job's generation. Use `continueGeneratingInBackground()` instead to keep generating without playing. */
	stop(): void {
		this.sessionId++;
		if (this.activeJob) {
			this.activeJob.cancelled = true;
			this.activeJob = null;
		}
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
		this.resetToIdle();
	}

	/**
	 * Detaches the active job from playback so it keeps generating its remaining chunks in the background,
	 * using the (likely lower) background parallel-generation setting instead of competing with an actively
	 * playing read. Only one background job is kept at a time — starting another discards the previous one.
	 */
	continueGeneratingInBackground(): void {
		const job = this.activeJob;
		if (!job) return;
		if (!hasPendingGeneration(job.chunkReady)) return;

		if (this.backgroundJob && this.backgroundJob !== job) {
			this.backgroundJob.cancelled = true;
		}

		this.activeJob = null;
		this.backgroundJob = job;
		// Bumping the session stops the playback loop (playFromIndex) at its next check without touching
		// `job` -- generation for it continues below, gated only by `job.cancelled`, not `this.sessionId`.
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

		this.setState({ ...IDLE_STATE, backgroundJob: buildBackgroundJobInfo(job.file, job.chunkReady, job.chunkInFlight) });

		const windowSize = Math.max(1, this.settings.maxBackgroundParallelGeneration);
		void this.runGenerationWorkerPool(job, windowSize).then((ok) => {
			if (job.cancelled || job !== this.backgroundJob) return;
			if (ok) new Notice(`Finished generating "${job.file?.basename ?? 'note'}" in the background.`);
		});
	}

	/** Promotes the background job to active and starts playing it from the beginning. No-op if there is none. */
	playBackgroundJob(): void {
		const job = this.backgroundJob;
		if (!job) return;

		this.stop();
		this.backgroundJob = null;
		job.cancelled = false;
		this.activeJob = job;
		const session = this.sessionId;
		this.currentPlaybackRate = this.settings.playbackRate;
		this.setState({
			status: 'generating',
			chunkIndex: 0,
			chunkCount: job.chunks.length,
			currentTime: 0,
			duration: 0,
			chunkReady: [...job.chunkReady],
			chunkInFlight: [...job.chunkInFlight],
			chunkDurations: [...job.chunkDurations],
			activeFile: job.file,
			backgroundJob: null,
		});

		void this.playFromIndex(session, job, 0);
	}

	/** Discards the background job entirely, stopping its generation. No-op if there is none. */
	discardBackgroundJob(): void {
		if (!this.backgroundJob) return;
		this.backgroundJob.cancelled = true;
		this.backgroundJob = null;
		this.setState({ backgroundJob: null });
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

	/** Live-only, per-session: never persisted as a note/read setting. */
	getVolume(): number {
		return this.currentVolume;
	}

	setVolume(volume: number): void {
		this.currentVolume = Math.min(1, Math.max(0, volume));
		if (this.audio) this.audio.volume = this.currentVolume;
	}

	isMuted(): boolean {
		return this.muted;
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		if (this.audio) this.audio.muted = muted;
	}

	private getStripMarkdownOptions(): StripMarkdownOptions {
		return {
			stripMarkdownComments: this.settings.stripMarkdownComments,
			stripCommentDelimiters: this.settings.stripCommentDelimiters,
			announceComments: this.settings.announceComments,
		};
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
			new Notice('Set an ElevenLabs API key in the Obsidian reader settings.');
			return;
		}

		const charLimit = ELEVENLABS_MODEL_CHAR_LIMITS[this.settings.modelId] ?? DEFAULT_ELEVENLABS_CHAR_LIMIT;
		let chunks = chunkNote(rawText, charLimit, this.settings.chunkerStyle, this.settings.maxHeadingDepth, this.getStripMarkdownOptions());
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
		// A note that's already generating in the background can't be adopted mid-flight -- starting a
		// fresh read for the same file discards it rather than trying to merge in-progress buffers.
		if (this.backgroundJob && sourceFile && this.backgroundJob.file?.path === sourceFile.path) {
			this.discardBackgroundJob();
		}

		const session = this.sessionId;
		this.currentPlaybackRate = this.settings.playbackRate;

		let job!: GenerationJob;
		job = {
			id: this.nextJobId++,
			file: sourceFile,
			chunks,
			chunkBuffers: new Array<ArrayBuffer | undefined>(chunks.length),
			chunkPromises: new Array<Promise<ArrayBuffer> | undefined>(chunks.length),
			chunkReady: new Array<boolean>(chunks.length).fill(false),
			chunkInFlight: new Array<boolean>(chunks.length).fill(false),
			chunkDurations: new Array<number | undefined>(chunks.length).fill(undefined),
			provider: new ElevenLabsProvider(apiKey, this.settings, () => this.handleRateLimited(job)),
			sourceFileForSave: options.allowSave ? sourceFile : null,
			savedForSession: false,
			rateLimited: false,
			cancelled: false,
		};
		this.activeJob = job;

		this.setState({
			status: 'generating',
			chunkIndex: 0,
			chunkCount: chunks.length,
			currentTime: 0,
			duration: 0,
			chunkReady: [...job.chunkReady],
			chunkInFlight: [...job.chunkInFlight],
			chunkDurations: [...job.chunkDurations],
			activeFile: sourceFile,
		});

		if (!this.settings.startPlaybackImmediately) {
			const windowSize = this.settings.parallelGenerationEnabled ? Math.max(1, this.settings.maxParallelGeneration) : 1;
			const ok = await this.runGenerationWorkerPool(job, windowSize);
			if (!ok || job.cancelled || session !== this.sessionId) return;
		}

		await this.playFromIndex(session, job, 0);
	}

	/** Called (possibly repeatedly) the moment a 429 is seen for a job; falls back that job's generation to sequential for the rest of it. */
	private handleRateLimited(job: GenerationJob): void {
		if (job.rateLimited) return;
		job.rateLimited = true;
		new Notice('ElevenLabs rate limit hit — retrying with backoff and switching to sequential chunk generation.');
	}

	/**
	 * Drives a job's remaining chunks to completion with up to `windowSize` concurrent generations.
	 * Safe to call on a job that's partially generated already (`ensureChunkBuffer` no-ops on chunks
	 * that are already ready or in flight) -- used both to generate a whole read upfront (when "start
	 * playback immediately" is off) and to resume a job detached into the background. Returns false on
	 * failure, having already reset the job's owning role (active/background) to idle/null.
	 */
	private async runGenerationWorkerPool(job: GenerationJob, windowSize: number): Promise<boolean> {
		let nextIndex = 0;

		const worker = async (workerId: number) => {
			while (nextIndex < job.chunks.length) {
				if (job.cancelled) return;
				// Once rate-limited, only the primary worker keeps going; the rest stop claiming new work.
				if (job.rateLimited && workerId > 0) return;
				const index = nextIndex++;
				if (job.chunkReady[index]) continue;
				await this.ensureChunkBuffer(job, index);
			}
		};

		try {
			await Promise.all(Array.from({ length: windowSize }, (_, workerId) => worker(workerId)));
			return true;
		} catch (error) {
			if (job.cancelled) return false;
			console.error('Obsidian Reader: failed to generate audio', error);
			new Notice(`Failed to generate audio${job.file ? ` for "${job.file.basename}"` : ''}: ${error instanceof Error ? error.message : String(error)}`);
			if (job === this.activeJob) {
				this.activeJob = null;
				this.resetToIdle();
			}
			if (job === this.backgroundJob) {
				this.backgroundJob = null;
				this.setState({ backgroundJob: null });
			}
			return false;
		}
	}

	/** Generates (if needed) and plays a job's chunks starting at index, honoring Previous/Next-part jumps. */
	private async playFromIndex(session: number, job: GenerationJob, startIndex: number): Promise<void> {
		let index = startIndex;

		while (index >= 0 && index < job.chunks.length) {
			if (session !== this.sessionId) return;
			this.setState({ status: 'generating', chunkIndex: index });

			let audioData: ArrayBuffer;
			try {
				audioData = await this.ensureChunkBuffer(job, index);
			} catch (error) {
				if (session !== this.sessionId) return;
				console.error('Obsidian Reader: failed to read note aloud', error);
				new Notice(`Failed to read note aloud: ${error instanceof Error ? error.message : String(error)}`);
				job.cancelled = true;
				this.activeJob = null;
				this.resetToIdle();
				return;
			}

			// Checked before prefetching (not just after) so that if this job was just detached into the
			// background (a lower parallel-generation window) while this await was in flight, this stale
			// continuation doesn't still prefetch one more wave at the foreground window size.
			if (session !== this.sessionId) return;
			this.prefetchAhead(job, index);

			const outcome = await this.playChunk(job, audioData, index, job.chunks.length);
			if (session !== this.sessionId) return;

			index = outcome === 'previous' ? Math.max(0, index - 1) : index + 1;
		}

		if (session !== this.sessionId) return;
		if (job === this.activeJob) this.activeJob = null;
		this.resetToIdle();
	}

	/** Kicks off generation for the next chunks within the configured parallel-generation window (a no-op if disabled). */
	private prefetchAhead(job: GenerationJob, fromIndex: number): void {
		if (!this.settings.parallelGenerationEnabled || job.rateLimited) return;
		const windowSize = Math.max(1, this.settings.maxParallelGeneration);
		for (let offset = 1; offset < windowSize; offset++) {
			this.prefetchChunkBuffer(job, fromIndex + offset);
		}
	}

	private ensureChunkBuffer(job: GenerationJob, index: number): Promise<ArrayBuffer> {
		const cached = job.chunkBuffers[index];
		if (cached) return Promise.resolve(cached);

		const inFlight = job.chunkPromises[index];
		if (inFlight) return inFlight;

		if (job.cancelled) return Promise.reject(new Error('Generation job was cancelled.'));

		job.chunkInFlight[index] = true;
		this.publishJobProgress(job);

		const promise = job.provider
			.synthesize(job.chunks[index] ?? '')
			.then(async (buffer) => {
				job.chunkBuffers[index] = buffer;
				const duration = await this.decodeAudioDuration(buffer);
				job.chunkReady[index] = true;
				job.chunkDurations[index] = duration;
				job.chunkInFlight[index] = false;
				this.publishJobProgress(job);
				this.maybeSaveOnGenerationComplete(job);
				return buffer;
			})
			.catch((error: unknown) => {
				job.chunkInFlight[index] = false;
				this.publishJobProgress(job);
				throw error;
			});
		job.chunkPromises[index] = promise;
		return promise;
	}

	/** Mirrors a job's generation progress onto whichever public state it's currently playing `state.backgroundJob`, depending on its current role. A no-op once the job has been discarded from both roles. */
	private publishJobProgress(job: GenerationJob): void {
		if (job === this.activeJob) {
			this.setState({
				chunkReady: [...job.chunkReady],
				chunkInFlight: [...job.chunkInFlight],
				chunkDurations: [...job.chunkDurations],
			});
		} else if (job === this.backgroundJob) {
			this.setState({ backgroundJob: buildBackgroundJobInfo(job.file, job.chunkReady, job.chunkInFlight) });
		}
	}

	/** Decodes a generated chunk's audio duration (seconds) without playing it, for whole-read time totals. */
	private decodeAudioDuration(buffer: ArrayBuffer): Promise<number> {
		return new Promise((resolve) => {
			const blob = new Blob([buffer], { type: 'audio/mpeg' });
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			const finish = (duration: number) => {
				audio.removeEventListener('loadedmetadata', onLoaded);
				audio.removeEventListener('error', onError);
				URL.revokeObjectURL(url);
				resolve(duration);
			};
			const onLoaded = () => finish(audio.duration || 0);
			const onError = () => finish(0);
			audio.addEventListener('loadedmetadata', onLoaded);
			audio.addEventListener('error', onError);
		});
	}

	/** Saves (once) as soon as every chunk in a job has finished generating, regardless of playback progress. */
	private maybeSaveOnGenerationComplete(job: GenerationJob): void {
		if (job.savedForSession) return;
		if (job.chunkReady.length === 0 || !job.chunkReady.every(Boolean)) return;
		if (!this.settings.saveAudioFile || !job.sourceFileForSave) return;

		job.savedForSession = true;
		const buffers = job.chunkBuffers.filter((buffer): buffer is ArrayBuffer => buffer !== undefined);
		void this.saveAudioFile(buffers, job.sourceFileForSave);
	}

	private prefetchChunkBuffer(job: GenerationJob, index: number): void {
		if (index < 0 || index >= job.chunks.length || job.chunkBuffers[index] || job.chunkPromises[index]) return;
		void this.ensureChunkBuffer(job, index).catch((error: unknown) => {
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

	/**
	 * Staleness hash for a note, excluding the reader's own bookkeeping properties from the frontmatter
	 * before hashing. Hashing raw file content directly would be self-referential: linkAudioInNote() writes
	 * these properties (including this very hash) into the file's frontmatter right after computing it, so
	 * every later read of "current content" would include them while the stored hash never could —
	 * guaranteeing a permanent mismatch. Excluding them keeps the hash stable across saves.
	 */
	private async computeStalenessHash(file: TFile): Promise<string> {
		const rawContent = await this.app.vault.cachedRead(file);
		const body = stripFrontmatter(rawContent);
		const frontmatter: Record<string, unknown> = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) };
		delete frontmatter.position;
		delete frontmatter[this.settings.audioLinkProperty];
		delete frontmatter[this.settings.audioHashProperty];
		delete frontmatter[this.settings.audioPathProperty];
		delete frontmatter[this.settings.audioTimestampProperty];
		delete frontmatter[this.settings.audioVoiceProperty];
		for (const key of this.settings.extraStaleHashExcludedProperties.split('\n')) {
			const trimmed = key.trim();
			if (trimmed) delete frontmatter[trimmed];
		}
		return hashText(`${JSON.stringify(frontmatter)}\n${body}`);
	}

	/**
	 * `processFrontMatter()`'s returned promise can resolve before `metadataCache.getFileCache()` actually
	 * reflects the write — the cache recomputes on its own pipeline after the underlying `vault.modify`,
	 * not synchronously as part of the write call. Callers that immediately re-read frontmatter via the
	 * cache (like the panel's Play saved/status checks, triggered off `audio-status-change`) would see the
	 * stale pre-write cache otherwise. Waits for the cache's own 'changed' event for this file, with a
	 * timeout as a safety net in case that event is ever missed.
	 */
	private waitForMetadataCacheUpdate(file: TFile): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				this.app.metadataCache.offref(ref);
				window.clearTimeout(timeoutId);
				resolve();
			};
			const ref = this.app.metadataCache.on('changed', (changedFile: TFile) => {
				if (changedFile.path === file.path) finish();
			});
			const timeoutId = window.setTimeout(finish, 2000);
		});
	}

	private async linkAudioInNote(audioFile: TFile, sourceFile: TFile): Promise<void> {
		const link = this.app.fileManager.generateMarkdownLink(audioFile, sourceFile.path);
		const hash = await this.computeStalenessHash(sourceFile);

		const cacheUpdated = this.waitForMetadataCacheUpdate(sourceFile);
		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			frontmatter[this.settings.audioLinkProperty] = link;
			frontmatter[this.settings.audioHashProperty] = hash;
			frontmatter[this.settings.audioPathProperty] = audioFile.path;
			frontmatter[this.settings.audioTimestampProperty] = moment().toISOString(true);
			frontmatter[this.settings.audioVoiceProperty] = this.settings.voiceId;
		});
		await cacheUpdated;

		this.trigger('audio-status-change', sourceFile);
	}

	/** Removes just the reader-audio frontmatter properties (not the audio file itself), used by both the user-facing clear action and silent missing-file cleanup. */
	private async removeReaderProperties(sourceFile: TFile): Promise<void> {
		const cacheUpdated = this.waitForMetadataCacheUpdate(sourceFile);
		await this.app.fileManager.processFrontMatter(sourceFile, (frontmatter: Record<string, unknown>) => {
			delete frontmatter[this.settings.audioLinkProperty];
			delete frontmatter[this.settings.audioHashProperty];
			delete frontmatter[this.settings.audioPathProperty];
			delete frontmatter[this.settings.audioTimestampProperty];
			delete frontmatter[this.settings.audioVoiceProperty];
		});
		await cacheUpdated;

		this.trigger('audio-status-change', sourceFile);
	}

	/** Deletes a note's linked audio file (if any) and removes the reader-audio properties from its frontmatter. */
	async clearReaderFiles(sourceFile: TFile): Promise<void> {
		const audioFile = this.findExistingAudioFile(sourceFile);
		if (audioFile) {
			await this.app.fileManager.trashFile(audioFile);
		}

		await this.removeReaderProperties(sourceFile);

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
			const chunks = chunkNote(textToRead, charLimit, this.settings.chunkerStyle, this.settings.maxHeadingDepth, this.getStripMarkdownOptions());
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

	/**
	 * Note-length stats for the panel's idle-state display (total characters/chunks, average per chunk),
	 * computed via the same preamble+chunking pipeline readNote() would use. Null for non-notes or notes
	 * with nothing to read.
	 */
	async getNoteStats(
		file: TFile,
	): Promise<{ totalChars: number; chunkCount: number; avgCharsPerChunk: number; avgWordsPerChunk: number } | null> {
		if (file.extension !== 'md') return null;

		const rawText = await this.app.vault.cachedRead(file);
		const body = stripFrontmatter(rawText);
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const preamble = buildReadingPreamble(file.basename, frontmatter, {
			readTitle: this.settings.readTitle,
			readProperties: this.settings.readProperties,
		});
		const textToRead = preamble ? `${preamble}\n\n${body}` : body;
		if (!textToRead.trim()) return null;

		const charLimit = ELEVENLABS_MODEL_CHAR_LIMITS[this.settings.modelId] ?? DEFAULT_ELEVENLABS_CHAR_LIMIT;
		const chunks = chunkNote(textToRead, charLimit, this.settings.chunkerStyle, this.settings.maxHeadingDepth, this.getStripMarkdownOptions());
		if (chunks.length === 0) return null;

		const totalChars = textToRead.length;
		const totalWords = textToRead.split(/\s+/).filter(Boolean).length;
		return {
			totalChars,
			chunkCount: chunks.length,
			avgCharsPerChunk: Math.round(totalChars / chunks.length),
			avgWordsPerChunk: Math.round(totalWords / chunks.length),
		};
	}

	/** Compares the note's current content against the hash stored when its linked audio was last generated. */
	async getAudioStatus(file: TFile): Promise<AudioLinkStatus> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const link = frontmatter?.[this.settings.audioLinkProperty] as string | undefined;
		const storedHash = frontmatter?.[this.settings.audioHashProperty] as string | undefined;
		if (!link || !storedHash) return 'none';

		// The note still links to audio that's since been moved/deleted outside Obsidian Reader — there's
		// nothing to be "outdated" relative to, so clean up the stale properties instead of showing a
		// misleading status. Self-stabilizing: once cleaned, `link`/`storedHash` above are gone and this
		// short-circuits to 'none' on the next call without re-checking the vault.
		if (!this.findExistingAudioFile(file)) {
			if (this.settings.autoCleanupMissingAudioProperties) {
				await this.removeReaderProperties(file);
				new Notice('Cleaned up stale reader audio file metadata properties');
			}
			return 'none';
		}

		const currentHash = await this.computeStalenessHash(file);
		return currentHash === storedHash ? 'up-to-date' : 'outdated';
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

			this.currentPlaybackRate = this.settings.playbackRate;
			this.setState({
				status: 'playing',
				chunkIndex: 0,
				chunkCount: 1,
				currentTime: 0,
				duration: 0,
				chunkReady: [true],
				chunkInFlight: [false],
				chunkDurations: [undefined],
				activeFile: sourceFile,
			});

			if (session !== this.sessionId) return;
			await this.playChunk(null, data, 0, 1);
			if (session !== this.sessionId) return;
			this.resetToIdle();
		} catch (error) {
			console.error('Obsidian Reader: failed to play saved audio', error);
			new Notice(`Failed to play saved audio: ${error instanceof Error ? error.message : String(error)}`);
			this.resetToIdle();
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

	/** `job` is null only for direct saved-file playback, which has no generation job and thus nothing to patch chunkDurations onto. */
	private playChunk(job: GenerationJob | null, audioData: ArrayBuffer, index: number, count: number): Promise<ChunkOutcome> {
		return new Promise((resolve) => {
			const blob = new Blob([audioData], { type: 'audio/mpeg' });
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			audio.playbackRate = this.currentPlaybackRate;
			audio.volume = this.currentVolume;
			audio.muted = this.muted;
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
			audio.addEventListener('loadedmetadata', () => {
				const duration = audio.duration || 0;
				const patch: Partial<ReaderState> = { duration };
				if (job && job.chunkDurations[index] === undefined) {
					job.chunkDurations[index] = duration;
					patch.chunkDurations = [...job.chunkDurations];
				}
				this.setState(patch);
			});
			audio.addEventListener('timeupdate', onTimeUpdate);
			audio.addEventListener('ended', () => finish('ended'));
			audio.addEventListener('error', () => finish('ended'));

			this.setState({ status: 'playing', chunkIndex: index, chunkCount: count, currentTime: 0, duration: audio.duration || 0 });
			void audio.play();
		});
	}
}
