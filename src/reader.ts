import { App, Events, MarkdownView, moment, Notice, normalizePath, TFile } from 'obsidian';
import { concatArrayBuffers, sanitizeFilenameComponent } from './audio-utils';
import { buildBackgroundJobInfo, hasPendingGeneration } from './background-job';
import type { BackgroundJobInfo } from './background-job';
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
	/**
	 * Notes generating in the background after being detached from playback, plus ones that have finished
	 * (kept until explicitly cleared). Only one is ever 'generating' at once; the rest are 'queued' (waiting
	 * their turn, in this array's order) or 'done'. Independent of the playback fields above.
	 */
	backgroundJobs: BackgroundJobInfo[];
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
	backgroundJobs: [],
};

type ChunkOutcome = 'ended' | 'next' | 'previous';

/**
 * A single read's generation state: its chunk texts, buffers/promises/readiness, and the provider used to
 * synthesize them. Exactly one job at a time drives active playback (`Reader.activeJob`); any number of
 * others can be queued/generating/done in the background (`Reader.backgroundJobs`) after being detached from
 * playback via `continueGeneratingInBackground()`. Kept as a plain object (rather than flat fields on Reader)
 * so a job can be handed off between roles, or discarded, without those roles' state colliding.
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
	/** Only meaningful while the job is in `Reader.backgroundJobs` -- see {@link BackgroundJobStatus}. */
	backgroundStatus: 'queued' | 'generating' | 'done';
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
	/** Jobs generating (or queued to generate, or done) without being bound to playback. At most one has backgroundStatus 'generating' at a time. */
	private backgroundJobs: GenerationJob[] = [];

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

	/** Resets playback to idle without disturbing the background jobs list (IDLE_STATE.backgroundJobs is always empty). */
	private resetToIdle(): void {
		this.setState({ ...IDLE_STATE, backgroundJobs: this.state.backgroundJobs });
	}

	/** Publishes `this.backgroundJobs`' current progress/status onto `state.backgroundJobs`. */
	private publishBackgroundJobs(): void {
		this.setState({
			backgroundJobs: this.backgroundJobs.map((job) =>
				buildBackgroundJobInfo(job.id, job.file, job.chunkReady, job.chunkInFlight, job.backgroundStatus),
			),
		});
	}

	/** Starts the next queued background job (if any) generating. No-op if one is already generating or none are queued. */
	private advanceBackgroundQueue(): void {
		if (this.backgroundJobs.some((job) => job.backgroundStatus === 'generating')) return;
		const next = this.backgroundJobs.find((job) => job.backgroundStatus === 'queued');
		if (!next) return;

		next.backgroundStatus = 'generating';
		this.publishBackgroundJobs();
		void this.runBackgroundJob(next);
	}

	/** Drives one background job's generation to completion, then advances the queue. A no-op past its own removal (promoted or discarded) -- the action that removed it is responsible for advancing the queue itself. */
	private async runBackgroundJob(job: GenerationJob): Promise<void> {
		const windowSize = Math.max(1, this.settings.maxBackgroundParallelGeneration);
		const ok = await this.runGenerationWorkerPool(job, windowSize);
		if (job.cancelled || !this.backgroundJobs.includes(job)) return;

		if (ok) {
			job.backgroundStatus = 'done';
			this.publishBackgroundJobs();
			new Notice(`Finished generating "${job.file?.basename ?? 'note'}" in the background.`);
		}
		this.advanceBackgroundQueue();
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
	 * playing read. Only one job generates in the background at a time -- a second "continue in background"
	 * queues behind whichever one is already generating, in the order they were backgrounded.
	 */
	continueGeneratingInBackground(): void {
		const job = this.activeJob;
		if (!job) return;
		if (!hasPendingGeneration(job.chunkReady)) return;

		this.activeJob = null;
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

		job.backgroundStatus = this.backgroundJobs.some((j) => j.backgroundStatus === 'generating') ? 'queued' : 'generating';
		this.backgroundJobs.push(job);
		this.resetToIdle();
		this.publishBackgroundJobs();

		if (job.backgroundStatus === 'generating') void this.runBackgroundJob(job);
	}

	/** Promotes a background job (queued, generating, or done) to active and starts playing it from the beginning. No-op if `jobId` isn't in the list. */
	playBackgroundJob(jobId: number): void {
		const job = this.backgroundJobs.find((j) => j.id === jobId);
		if (!job) return;
		this.backgroundJobs = this.backgroundJobs.filter((j) => j !== job);
		const wasGenerating = job.backgroundStatus === 'generating';
		this.publishBackgroundJobs();

		this.stop();
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
		});

		// Promoting the job that held the one "generating" slot frees it for the next queued job. A job
		// that was only 'queued' or already 'done' wasn't occupying that slot, so nothing to advance.
		if (wasGenerating) this.advanceBackgroundQueue();

		void this.playFromIndex(session, job, 0);
	}

	/** Removes a background job from the list -- cancels its generation if still queued/generating, or just clears it once done. No-op if `jobId` isn't in the list. */
	discardBackgroundJob(jobId: number): void {
		const job = this.backgroundJobs.find((j) => j.id === jobId);
		if (!job) return;
		this.backgroundJobs = this.backgroundJobs.filter((j) => j !== job);
		const wasGenerating = job.backgroundStatus === 'generating';
		job.cancelled = true;
		this.publishBackgroundJobs();
		if (wasGenerating) this.advanceBackgroundQueue();
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
		// Notes already queued/generating in the background can't be adopted mid-flight -- starting a
		// fresh read for the same file discards them rather than trying to merge in-progress buffers.
		if (sourceFile) {
			for (const existing of this.backgroundJobs.filter((job) => job.file?.path === sourceFile.path)) {
				this.discardBackgroundJob(existing.id);
			}
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
			backgroundStatus: 'queued',
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

		// Kicked off now and left running for the rest of the read -- runGenerationWorkerPool() is a
		// continuous worker pool that claims the next not-yet-ready chunk as soon as a worker frees up,
		// regardless of playback position, instead of the old fixed-lookahead prefetch scheme that stalled
		// once its small window finished generating early and nothing re-triggered more until the play
		// index itself advanced. It never touches playback's status/chunkIndex, so it can't fight with
		// playFromIndex()'s own tracking of what's actually playing.
		const windowSize = this.settings.parallelGenerationEnabled ? Math.max(1, this.settings.maxParallelGeneration) : 1;
		const generation = this.runGenerationWorkerPool(job, windowSize);

		if (!this.settings.startPlaybackImmediately) {
			const ok = await generation;
			if (!ok || job.cancelled || session !== this.sessionId) return;
		} else {
			void generation;
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
	 * playback immediately" is off) and to drive a background job. Returns false on failure, having
	 * already reset/removed the job from its owning role (active/background).
	 */
	private async runGenerationWorkerPool(job: GenerationJob, windowSize: number): Promise<boolean> {
		let nextIndex = 0;

		const worker = async (workerId: number) => {
			// Staggered so a high "max parallel chunk generation" setting doesn't dispatch its entire window
			// of requests in the same instant -- ElevenLabs' concurrent-request limit is otherwise hit by the
			// burst itself, before any 429 has even come back to flip job.rateLimited for the check below.
			if (workerId > 0) await new Promise((resolve) => window.setTimeout(resolve, workerId * 150));

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
			// Set before notifying (not just checked) so playFromIndex(), which can independently catch this
			// same rejection concurrently, knows this failure was already handled and skips its own notice.
			job.cancelled = true;
			console.error('Obsidian Reader: failed to generate audio', error);
			new Notice(`Failed to generate audio${job.file ? ` for "${job.file.basename}"` : ''}: ${error instanceof Error ? error.message : String(error)}`);
			if (job === this.activeJob) {
				this.activeJob = null;
				this.resetToIdle();
			}
			const bgIndex = this.backgroundJobs.indexOf(job);
			if (bgIndex !== -1) {
				this.backgroundJobs.splice(bgIndex, 1);
				this.publishBackgroundJobs();
				this.advanceBackgroundQueue();
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
				// runGenerationWorkerPool() runs concurrently and can independently catch this same
				// rejection -- the cancelled check lets only the first one to get here actually
				// notify/reset, instead of showing the same failure twice.
				if (session !== this.sessionId || job.cancelled) return;
				console.error('Obsidian Reader: failed to read note aloud', error);
				new Notice(`Failed to read note aloud: ${error instanceof Error ? error.message : String(error)}`);
				job.cancelled = true;
				this.activeJob = null;
				this.resetToIdle();
				return;
			}

			if (session !== this.sessionId) return;
			const outcome = await this.playChunk(job, audioData, index, job.chunks.length);
			if (session !== this.sessionId) return;

			index = outcome === 'previous' ? Math.max(0, index - 1) : index + 1;
		}

		if (session !== this.sessionId) return;
		if (job === this.activeJob) this.activeJob = null;
		this.resetToIdle();
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

	/** Mirrors a job's generation progress onto whichever public state it's currently driving -- playback's `state` fields if it's the active job, or `state.backgroundJobs` if it's in that list. A no-op once the job has been discarded from both roles. */
	private publishJobProgress(job: GenerationJob): void {
		if (job === this.activeJob) {
			this.setState({
				chunkReady: [...job.chunkReady],
				chunkInFlight: [...job.chunkInFlight],
				chunkDurations: [...job.chunkDurations],
			});
		} else if (this.backgroundJobs.includes(job)) {
			this.publishBackgroundJobs();
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
				// Harmless no-op when the 'ended'/'error' events triggered this (the audio has already
				// stopped by itself there) -- but essential when nextPart()/previousPart() call finish()
				// directly while this chunk is still actively playing, which otherwise left it playing on
				// in the background (revoking the blob URL doesn't stop audio already buffered/playing)
				// while the next chunk started too, overlapping the two.
				audio.pause();
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
