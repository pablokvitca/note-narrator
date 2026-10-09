import { App, Events, MarkdownView, Notice, TFile } from 'obsidian';
import { decodeAudioDuration, sliceIntoChunks } from './audio-utils';
import { AudioLinkStatus, ChunkOutcome, GenerationJob, IDLE_STATE, PoolResult, PositionBase, ReaderState, SavedPlaybackTimeline } from './reader-types';
import { ChunkPosition, RawSpan } from '../text/text-position';
import { HighlightGranularity, NoteNarratorSettings } from '../settings/settings';
import { ResolvedNarrator, generationWindow } from '../settings/profiles';
import { GenerateInBackgroundAction, decideGenerateInBackground, hasPendingGeneration } from './background-job';
import { BackgroundQueue } from './background-queue';
import { createTTSProvider, getProviderApiKey, missingApiKeyMessage } from '../tts/registry';
import { NoteText } from './note-text';
import { SavedAudio } from './saved-audio';
import { SavedAudioFreshness, savedAudioFreshness } from './saved-audio-freshness';

/** What the "Generate note audio in background" command says when there's nothing for it to do. */
const GENERATE_IN_BACKGROUND_NOTICES: Record<Exclude<GenerateInBackgroundAction, 'move-active' | 'generate' | 'regenerate'>, (note: string) => string> = {
	'already-generated': (note) => `"${note}" has already finished generating.`,
	'playing-saved': (note) => `"${note}" is playing from its saved audio.`,
	'already-queued': (note) => `"${note}" is already in the background queue.`,
	'ready-in-background': (note) => `"${note}" has already finished generating in the background.`,
};

/** Whether a read covers the whole note or just the selected text. */
type ReadKind = 'full' | 'selection';

/** Everything needed to build a generation job, resolved and validated up front. */
interface PreparedRead {
	narrator: ResolvedNarrator;
	apiKey: string;
	chunks: string[];
	positions: ChunkPosition[];
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

	/** Pause was pressed while the chunk to play was still generating; it starts paused when it arrives. */
	private pauseWhenChunkArrives = false;

	/** The job currently bound to playback and driving `state`. Null when nothing is generating/playing (or a saved file is playing directly, with no generation job involved). */
	private activeJob: GenerationJob | null = null;

	/** Jobs generating (or queued to generate, or done) without being bound to playback. */
	private readonly backgroundQueue: BackgroundQueue;

	/** Set while a saved file plays directly (no generation job), so `getSpan()` can still map elapsed playback time back to a chunk/section. Null whenever there's no such timeline (e.g. the note's since changed, or no chunk-durations property was saved). */
	private savedPlaybackTimeline: SavedPlaybackTimeline | null = null;
	/**
	 * The notes "Auto-generate on open" is generating right now, by path, so reopening one doesn't start it
	 * again. Setting `cancelled` (e.g. the note was deleted) stops that run before its next chunk and before saving.
	 */
	private readonly autoGenerations = new Map<string, { cancelled: boolean }>();
	/** Set once the plugin unloads (see {@link dispose}), so work still waiting on a request or a vault read stops instead of starting or saving anything. */
	private disposed = false;

	private readonly savedAudio: SavedAudio;
	private readonly noteText: NoteText;

	constructor(
		private app: App,
		private settings: NoteNarratorSettings,
	) {
		super();
		this.currentPlaybackRate = settings.playbackRate;
		this.savedAudio = new SavedAudio(app, settings, (file) => this.trigger('audio-status-change', file));
		this.noteText = new NoteText(app, settings);
		this.backgroundQueue = new BackgroundQueue(settings, {
			runWorkerPool: (job, windowSize) => this.runGenerationWorkerPool(job, windowSize),
			publish: (backgroundJobs) => this.setState({ backgroundJobs }),
			isStale: (job, file, currentContent) => this.isJobStale(job, file, currentContent),
		});
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
		// A pending pause belongs to the read that just ended (stopped, finished, failed or moved to the
		// background); cleared here so no path to idle can leave it for Resume to revive.
		this.pauseWhenChunkArrives = false;
		this.setState({ ...IDLE_STATE, backgroundJobs: this.state.backgroundJobs });
	}

	isPlaying(): boolean {
		return this.state.status === 'playing';
	}

	/** Stops playback and cancels every generation job, background ones included; called when the plugin unloads so nothing keeps generating or saving afterwards. */
	dispose(): void {
		this.disposed = true;
		this.autoGenerations.clear();
		this.stop();
		this.backgroundQueue.dispose();
	}

	/** Asks every open editor to redraw its highlight, e.g. after a highlight setting changed while reading is paused or idle. */
	refreshHighlights(): void {
		this.trigger('highlight-refresh');
	}

	/** Fully stops playback and cancels the active job's generation. Use `continueGeneratingInBackground()` instead to keep generating without playing. */
	stop(): void {
		this.sessionId++;
		this.savedPlaybackTimeline = null;
		if (this.activeJob) {
			this.activeJob.cancelled = true;
			this.activeJob = null;
		}
		this.releaseCurrentAudio();
		this.resetToIdle();
	}

	/** Stops and releases the chunk audio that's loaded right now (if any), and ends the playback loop's wait on it. */
	private releaseCurrentAudio(): void {
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
	}

	/**
	 * Detaches the active job from playback so it keeps generating its remaining chunks in the background,
	 * using the (likely lower) background parallel-generation setting instead of competing with an actively
	 * playing read. Only one job generates in the background at a time -- a second "continue in background"
	 * queues behind whichever one is already generating, in the order they were backgrounded. A selection
	 * read is never moved (see `GenerationJob.isSelection`).
	 */
	continueGeneratingInBackground(): void {
		const job = this.activeJob;
		if (!job || job.isSelection || job.noteDeleted) return;
		if (!hasPendingGeneration(job.chunkReady)) return;

		this.activeJob = null;
		// Bumping the session stops the playback loop (playFromIndex) at its next check without touching
		// `job` itself. Its generation is handed to the background queue below: enqueuing it retires
		// the foreground worker pool (see GenerationJob.poolToken), and the queue starts a background one
		// when it's the job's turn. Chunks already in flight still finish and are kept.
		this.sessionId++;
		this.releaseCurrentAudio();

		this.resetToIdle();
		this.backgroundQueue.enqueue(job);
	}

	/** What "Generate in background" would do for this note right now; shared by the command and the panel's button so they always agree. */
	getGenerateInBackgroundAction(file: TFile, currentContent?: string, savedAudioUpToDate = false): GenerateInBackgroundAction {
		const state = this.state;
		return decideGenerateInBackground({
			notePath: file.path,
			activePath: state.status === 'idle' ? null : (state.activeFile?.path ?? null),
			activeKind: state.activeReadKind,
			activePendingGeneration: hasPendingGeneration(state.chunkReady),
			// A stale job for this note doesn't count: generating again replaces it.
			backgroundJobs: this.backgroundQueue
				.all()
				.filter((job) => job.file?.path !== file.path || !this.isJobStale(job, file, currentContent))
				.map((job) => ({ path: job.file?.path ?? null, status: job.backgroundStatus })),
			savedAudioUpToDate,
		});
	}

	/**
	 * Whether the note's own read, playing or generating now, is stale (see {@link isJobStale}): reading it
	 * again then regenerates it, so the panel offers that instead of a disabled "Reading". Saved audio playing
	 * has no job, so it's judged by its file's freshness instead.
	 */
	isActiveReadStale(file: TFile, currentContent?: string): boolean {
		const job = this.activeJob;
		// A selection read (no contentHash) isn't the note's audio, so the note's edits don't make it stale.
		return !!job && job.contentHash !== null && job.file?.path === file.path && this.isJobStale(job, file, currentContent);
	}

	/**
	 * Whether a job no longer matches its note: generated with a different narrator than the active one, or
	 * (when `currentContent` is given) from text that's since been edited. Playing it would play the old
	 * version, so Read and "Generate in background" replace it instead.
	 */
	private isJobStale(job: GenerationJob, file: TFile, currentContent?: string): boolean {
		const narrator = this.noteText.getActiveNarrator();
		if (narrator && narrator.fingerprint !== job.narrator.fingerprint) return true;
		if (currentContent === undefined || job.contentHash === null) return false;
		return job.contentHash !== this.savedAudio.stalenessHash(currentContent, file);
	}

	/**
	 * Generates the whole note straight into the background queue without ever playing it, so a note can
	 * be prepared ahead of time without clicking Read first. Never interrupts whatever's currently playing.
	 * See {@link decideGenerateInBackground} for what happens when the note is already being read or
	 * already has a background job. Always the full note, never a selection. Given a file instead of a
	 * view (the panel's note, once its tab is closed), the note is read from the vault.
	 */
	generateNoteInBackground(target?: MarkdownView | TFile): void {
		if (target instanceof TFile) {
			void this.generateFileInBackground(target);
			return;
		}
		const view = target ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!view || !file) {
			new Notice('Open a note to generate its audio.');
			return;
		}
		this.enqueueNoteGeneration(file, view.editor.getValue());
	}

	private async generateFileInBackground(file: TFile): Promise<void> {
		const fullValue = await this.readNoteFromVault(file);
		// The plugin may have unloaded while the note was being read.
		if (fullValue !== null && !this.disposed) this.enqueueNoteGeneration(file, fullValue);
	}

	/** A note's text as saved in the vault, for reading a note with no open editor. Null (after a notice) if it can't be read. */
	private async readNoteFromVault(file: TFile): Promise<string | null> {
		try {
			return await this.app.vault.cachedRead(file);
		} catch (error) {
			console.error('Note Narrator: failed to read note', error);
			new Notice(`Failed to read "${file.basename}".`);
			return null;
		}
	}

	/** The shared rest of {@link generateNoteInBackground}, given the note's full text. */
	private enqueueNoteGeneration(file: TFile, fullValue: string): void {
		const { rawText, positionBase } = this.noteText.buildNoteInput(file, fullValue);
		// Up-to-date saved audio doesn't stop it: like Read, it regenerates (the panel labels the button
		// tooltip says "Regenerate in background" then), so the decision doesn't need the saved-audio status here.
		const action = this.getGenerateInBackgroundAction(file, fullValue);
		if (action === 'move-active') {
			this.continueGeneratingInBackground();
			return;
		}
		if (action !== 'generate' && action !== 'regenerate') {
			new Notice(GENERATE_IN_BACKGROUND_NOTICES[action](file.basename));
			return;
		}

		const prepared = this.prepareRead(rawText, positionBase);
		if (!prepared) return;

		this.backgroundQueue.discardIfStale(file, fullValue);
		this.cancelAutoGeneration(file.path);
		this.backgroundQueue.enqueue(this.createJob(file, prepared, 'full', fullValue));
	}

	/**
	 * With "Keep generating when starting another note" on, hands a still-generating active job to the
	 * background before something else replaces it. Only for a genuinely different note: the same note
	 * restarts fresh as before. Does nothing (so the caller's stop() discards it) when the setting is off,
	 * nothing is active, the active job is a selection read, or it has nothing left to generate.
	 */
	private backgroundActiveJobForOtherNote(nextFile: TFile | null): void {
		if (!this.settings.autoBackgroundOnSwitch) return;
		const active = this.activeJob;
		if (!active || !active.file || !nextFile || active.file.path === nextFile.path) return;
		this.continueGeneratingInBackground();
	}

	/** Promotes a background job (queued, generating, or done) to active and starts playing it from the beginning. No-op if `jobId` isn't in the list. */
	playBackgroundJob(jobId: number): void {
		const job = this.backgroundQueue.findById(jobId);
		if (!job) return;
		this.adoptBackgroundJob(job);
	}

	/** Shared by `playBackgroundJob()` and `readText()` re-adopting a matching in-progress job: promotes a background job to active and starts playing it from the beginning. */
	private adoptBackgroundJob(job: GenerationJob): void {
		// Its audio is only in the saved file now: the card goes, and the file plays like Play saved.
		if (job.audioFreed) {
			this.discardBackgroundJob(job.id);
			const audioFile = job.savedAudioPath === null ? null : this.app.vault.getAbstractFileByPath(job.savedAudioPath);
			if (audioFile instanceof TFile) void this.playSavedFile(audioFile, job.file);
			else new Notice(`Couldn't find the saved audio for "${job.file?.basename ?? 'note'}". Generate it again.`);
			return;
		}
		// Promoting the job that held the one "generating" slot frees it for the next queued job, which starts
		// before the current read moves aside below, so jobs keep the order they were backgrounded in.
		this.backgroundQueue.take(job);

		// Same as starting any other note: with "Keep generating when starting another note" on, a read of a
		// different note that's still generating moves to the background instead of being thrown away. It
		// joins the back of the queue (or takes the generating slot if nothing else wants it).
		this.backgroundActiveJobForOtherNote(job.file);
		this.stop();
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
			activeReadKind: 'full',
		});

		// Without a foreground worker pool only playFromIndex() would generate, one chunk at a time as each
		// is needed, with a silent gap before every chunk. Starting one also retires the background pool
		// (see GenerationJob.poolToken), so the job now generates at the foreground window only.
		if (hasPendingGeneration(job.chunkReady)) {
			void this.runGenerationWorkerPool(job, generationWindow(job.narrator.provider, false));
		}

		void this.playFromIndex(session, job, 0);
	}

	/** Removes a background job from the list -- cancels its generation if still queued/generating, or just clears it once done. No-op if `jobId` isn't in the list. */
	discardBackgroundJob(jobId: number): void {
		this.backgroundQueue.discard(jobId);
	}

	/**
	 * Jumps to the next chunk without waiting for the current one to finish playing. No-op past the last
	 * chunk. Works identically for a live read and "Play saved" playback -- both play one chunk at a time
	 * through `playChunk()`, which is what sets `resolveCurrentChunk` for whichever one is actually active.
	 */
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
		} else if (this.state.status === 'generating' && this.activeJob) {
			// Nothing is playing yet: the chunk to play next is still generating. Remember the pause so that
			// chunk starts paused when it arrives (see playChunk()), instead of playing as if never paused.
			this.pauseWhenChunkArrives = true;
			this.setState({ status: 'paused' });
		}
	}

	resume(): void {
		if (this.pauseWhenChunkArrives) {
			// Resumed before the chunk arrived (a pending pause only exists while no chunk is loaded): just let
			// it play when it does.
			this.pauseWhenChunkArrives = false;
			this.setState({ status: 'generating' });
			return;
		}
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

	/**
	 * Estimated editor position of whatever's currently playing, at the given granularity -- used for both
	 * the now-playing highlight and the "scroll to current" buttons. Both granularities are exact (driven by
	 * which chunk is actually playing, a real event), not a time-based estimate. Null whenever there's
	 * nothing to point at: nothing playing, a saved file playing directly (no chunk/section structure at
	 * all), a selection read (no reliable position to rebase onto), or the active chunk's position estimate
	 * is itself null (e.g. it's entirely the spoken title/properties preamble).
	 */
	getSpan(granularity: HighlightGranularity, sectionTitleOnly = false): { file: TFile; span: RawSpan } | null {
		if (this.activeJob?.file) {
			const position = this.activeJob.positions[this.state.chunkIndex];
			return this.resolvePositionSpan(position, this.activeJob.file, granularity, sectionTitleOnly);
		}

		if (this.savedPlaybackTimeline) {
			const timeline = this.savedPlaybackTimeline;
			return this.resolvePositionSpan(timeline.positions[this.state.chunkIndex], timeline.file, granularity, sectionTitleOnly);
		}

		return null;
	}

	private resolvePositionSpan(
		position: ChunkPosition | undefined,
		file: TFile,
		granularity: HighlightGranularity,
		sectionTitleOnly: boolean,
	): { file: TFile; span: RawSpan } | null {
		if (!position) return null;

		if (granularity === 'section') {
			const span = sectionTitleOnly ? (position.sectionHeadingSpan ?? position.sectionSpan) : position.sectionSpan;
			return span ? { file, span } : null;
		}

		return position.span ? { file, span: position.span } : null;
	}

	/**
	 * Rebuilds a saved file's chunk timeline for highlighting/scroll-to-current during "Play saved" -- only
	 * when the note is still up to date with that saved audio (otherwise the note's current structure
	 * can't be trusted to match what was actually generated) and the saved chunk-durations line up in count
	 * with what re-chunking the note right now produces (a settings change since generation, e.g. a
	 * different chunker or heading depth, could otherwise silently misalign every chunk after the first).
	 * Null in any of those cases -- "no highlight during this saved playback" rather than a wrong one.
	 */
	private async buildSavedPlaybackTimeline(sourceFile: TFile): Promise<SavedPlaybackTimeline | null> {
		try {
			const status = await this.savedAudio.getAudioStatus(sourceFile);
			if (status !== 'up-to-date') return null;

			const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
			const raw = frontmatter?.[this.settings.audioChunkDurationsProperty] as unknown;
			if (!Array.isArray(raw) || raw.length === 0) return null;

			// Each entry is a [duration, byteLength] pair -- one property instead of two.
			const chunkDurations: number[] = [];
			const chunkByteLengths: number[] = [];
			for (const entry of raw as unknown[]) {
				if (!Array.isArray(entry) || entry.length !== 2) return null;
				const [duration, byteLength] = entry as unknown[];
				if (typeof duration !== 'number' || typeof byteLength !== 'number' || !Number.isFinite(duration) || !Number.isFinite(byteLength)) return null;
				chunkDurations.push(duration);
				chunkByteLengths.push(byteLength);
			}

			const { rawText, positionBase } = this.noteText.buildNoteInput(sourceFile, await this.app.vault.cachedRead(sourceFile));
			const { positions } = this.noteText.buildChunksAndPositions(rawText, positionBase);
			if (positions.length !== chunkDurations.length) return null;

			return { file: sourceFile, positions, chunkDurations, chunkByteLengths };
		} catch (error) {
			console.error('Note Narrator: failed to build saved-playback highlight timeline', error);
			return null;
		}
	}

	/**
	 * Reads the note in `target` (or the active Markdown view), or just its selection. Given a file instead
	 * of a view (the panel's note, once its tab is closed), reads the whole note as saved in the vault.
	 */
	async readNote(target?: MarkdownView | TFile): Promise<void> {
		if (target instanceof TFile) {
			const fullValue = await this.readNoteFromVault(target);
			// The plugin may have unloaded while the note was being read.
			if (fullValue === null || this.disposed) return;
			const { rawText, positionBase } = this.noteText.buildNoteInput(target, fullValue);
			await this.readText(rawText, target, { kind: 'full', positionBase, sourceContent: fullValue });
			return;
		}

		const view = target ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('Open a note to read it aloud.');
			return;
		}

		const selection = view.editor.getSelection();
		if (this.settings.readSelectionIfPresent && selection.length > 0) {
			// No reliable offset to rebase estimated spans onto (the selection could start anywhere in the
			// document) -- selections just don't get highlighting/scroll-to-current.
			await this.readText(selection, view.file, { kind: 'selection' });
			return;
		}

		const fullValue = view.editor.getValue();
		const { rawText, positionBase } = this.noteText.buildNoteInput(view.file, fullValue);
		await this.readText(rawText, view.file, { kind: 'full', positionBase, sourceContent: fullValue });
	}

	/** Resolves the narrator and API key and chunks the text, showing a notice and returning null when any of that makes reading impossible. */
	private prepareRead(rawText: string, positionBase?: PositionBase): PreparedRead | null {
		const narrator = this.noteText.getActiveNarrator();
		if (!narrator) {
			new Notice('Add a provider and a narrator profile in the Note Narrator settings.');
			return null;
		}
		const apiKey = getProviderApiKey(this.app, narrator.provider);
		if (!apiKey) {
			new Notice(missingApiKeyMessage(narrator.provider));
			return null;
		}

		const { chunks, positions } = this.noteText.buildChunksAndPositions(rawText, positionBase);
		if (chunks.length === 0) {
			new Notice('Nothing to read.');
			return null;
		}
		return { narrator, apiKey, chunks, positions };
	}

	/**
	 * Builds a fresh, not-yet-started generation job. The caller decides whether it becomes the active
	 * (playing) job or goes to the background queue. `sourceContent` is the note's full text the job was
	 * built from, hashed now for its saved audio's staleness check.
	 */
	private createJob(sourceFile: TFile | null, prepared: PreparedRead, kind: ReadKind, sourceContent?: string): GenerationJob {
		const { narrator, apiKey, chunks, positions } = prepared;
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
			positions,
			provider: createTTSProvider(narrator.provider, narrator.voice, apiKey, () => this.handleRateLimited(job)),
			narrator,
			// Only a full-note read is saved: a selection's audio isn't the note's audio.
			sourceFileForSave: kind === 'full' ? sourceFile : null,
			contentHash: kind === 'full' && sourceFile && sourceContent !== undefined ? this.savedAudio.stalenessHash(sourceContent, sourceFile) : null,
			isSelection: kind === 'selection',
			noteDeleted: false,
			savedForSession: false,
			savedAudioPath: null,
			saving: false,
			audioFreed: false,
			rateLimited: false,
			poolToken: 0,
			cancelled: false,
			backgroundStatus: 'queued',
		};
		return job;
	}

	private async readText(
		rawText: string,
		sourceFile: TFile | null,
		options: { kind: ReadKind; positionBase?: PositionBase; sourceContent?: string },
	): Promise<void> {
		const prepared = this.prepareRead(rawText, options.positionBase);
		if (!prepared) return;

		// Re-reading a note that already has a background job (queued, generating, or done) adopts that job
		// in place rather than discarding its progress -- the same outcome as clicking the job's card, just
		// triggered from Read instead. Only for a full-note read: a selection read's text won't match the
		// background job's chunks, so it plays on its own and leaves the background job as it is. A stale job
		// (the note was edited, or the narrator changed, since it was generated) is discarded instead, so
		// Read -- or "Regenerate" -- actually generates the note as it is now.
		if (sourceFile && options.kind === 'full') {
			if (options.sourceContent !== undefined) this.backgroundQueue.discardIfStale(sourceFile, options.sourceContent);
			const existing = this.backgroundQueue.find(sourceFile);
			if (existing) {
				this.adoptBackgroundJob(existing);
				return;
			}
		}

		// A selection read leaves the note's background job (if any) alone: it's for the whole note, so it
		// doesn't conflict with reading just part of it, and discarding it would throw away paid generation.
		// A selection read leaves an "Auto-generate on open" of the note running too; a full read takes it
		// over (cancels it), as it generates the whole note itself.
		if (sourceFile && options.kind === 'full') this.cancelAutoGeneration(sourceFile.path);
		this.backgroundActiveJobForOtherNote(sourceFile);
		this.stop();

		const session = this.sessionId;
		this.currentPlaybackRate = this.settings.playbackRate;

		const job = this.createJob(sourceFile, prepared, options.kind, options.sourceContent);
		this.activeJob = job;

		this.setState({
			status: 'generating',
			chunkIndex: 0,
			chunkCount: job.chunks.length,
			currentTime: 0,
			duration: 0,
			chunkReady: [...job.chunkReady],
			chunkInFlight: [...job.chunkInFlight],
			chunkDurations: [...job.chunkDurations],
			activeFile: sourceFile,
			activeReadKind: job.isSelection ? 'selection' : 'full',
		});

		// Kicked off now and left running for the rest of the read -- runGenerationWorkerPool() is a
		// continuous worker pool that claims the next not-yet-ready chunk as soon as a worker frees up,
		// regardless of playback position, instead of the old fixed-lookahead prefetch scheme that stalled
		// once its small window finished generating early and nothing re-triggered more until the play
		// index itself advanced. It never touches playback's status/chunkIndex, so it can't fight with
		// playFromIndex()'s own tracking of what's actually playing.
		const windowSize = generationWindow(job.narrator.provider, false);
		const generation = this.runGenerationWorkerPool(job, windowSize);

		if (!this.settings.startPlaybackImmediately) {
			const result = await generation;
			if (result !== 'done' || job.cancelled || session !== this.sessionId) return;
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
	 * that are already ready or in flight). Used for a read (alongside playback, or upfront when "start
	 * playback immediately" is off), for a background job, and when a background job is adopted back into
	 * playback. Resolves to:
	 * - 'done': every chunk is generated.
	 * - 'superseded': a newer pool took the job over (see `GenerationJob.poolToken`); chunks may be left,
	 *   and the job's new owner is responsible for it.
	 * - 'failed': generation failed (or the job was cancelled), and the job has already been reset/removed
	 *   from its owning role (active/background).
	 */
	private async runGenerationWorkerPool(job: GenerationJob, windowSize: number): Promise<PoolResult> {
		const token = ++job.poolToken;
		let nextIndex = 0;

		const worker = async (workerId: number) => {
			// Staggered so a high "max parallel chunk generation" setting doesn't dispatch its entire window
			// of requests in the same instant -- ElevenLabs' concurrent-request limit is otherwise hit by the
			// burst itself, before any 429 has even come back to flip job.rateLimited for the check below.
			if (workerId > 0) await new Promise((resolve) => window.setTimeout(resolve, workerId * 150));

			while (nextIndex < job.chunks.length) {
				if (job.cancelled) return;
				// A newer pool has taken over this job (see GenerationJob.poolToken).
				if (job.poolToken !== token) return;
				// Once rate-limited, only the primary worker keeps going; the rest stop claiming new work.
				if (job.rateLimited && workerId > 0) return;
				const index = nextIndex++;
				if (job.chunkReady[index]) continue;
				await this.ensureChunkBuffer(job, index);
			}
		};

		try {
			await Promise.all(Array.from({ length: windowSize }, (_, workerId) => worker(workerId)));
			// Workers also stop early once the job is cancelled, which isn't "every chunk generated".
			if (job.cancelled) return 'failed';
			return job.poolToken === token ? 'done' : 'superseded';
		} catch (error) {
			if (job.cancelled) return 'failed';
			// Set before notifying (not just checked) so playFromIndex(), which can independently catch this
			// same rejection concurrently, knows this failure was already handled and skips its own notice.
			job.cancelled = true;
			console.error('Note Narrator: failed to generate audio', error);
			new Notice(`Failed to generate audio${job.file ? ` for "${job.file.basename}"` : ''}: ${error instanceof Error ? error.message : String(error)}`);
			if (job === this.activeJob) {
				this.activeJob = null;
				this.resetToIdle();
			}
			this.backgroundQueue.take(job);
			return 'failed';
		}
	}

	/** Generates (if needed) and plays a job's chunks starting at index, honoring Previous/Next-part jumps. */
	private async playFromIndex(session: number, job: GenerationJob, startIndex: number): Promise<void> {
		let index = startIndex;

		while (index >= 0 && index < job.chunks.length) {
			if (session !== this.sessionId) return;
			this.setState({ status: this.pauseWhenChunkArrives ? 'paused' : 'generating', chunkIndex: index });

			let audioData: ArrayBuffer;
			try {
				audioData = await this.ensureChunkBuffer(job, index);
			} catch (error) {
				// runGenerationWorkerPool() runs concurrently and can independently catch this same
				// rejection -- the cancelled check lets only the first one to get here actually
				// notify/reset, instead of showing the same failure twice.
				if (session !== this.sessionId || job.cancelled) return;
				console.error('Note Narrator: failed to read note aloud', error);
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
		// A chunk's promise, not its buffer, is what says it's finished: generateChunk() stores the buffer
		// before decoding its duration and only marks the chunk ready after, so returning the buffer as soon
		// as it exists would let a worker pool finish while that chunk isn't ready yet -- and a background job
		// whose pool finishes with chunks not ready is never marked done, stalling the queue behind it.
		const existing = job.chunkPromises[index];
		if (existing) return existing;

		if (job.cancelled) return Promise.reject(new Error('Generation job was cancelled.'));

		job.chunkInFlight[index] = true;
		this.publishJobProgress(job);

		const promise = this.generateChunk(job, index);
		job.chunkPromises[index] = promise;
		return promise;
	}

	/** Synthesizes one chunk and records the result on the job; a failure (including one while recording) clears the chunk's in-flight flag and rethrows. */
	private async generateChunk(job: GenerationJob, index: number): Promise<ArrayBuffer> {
		try {
			const buffer = await job.provider.synthesize(job.chunks[index] ?? '', () => job.cancelled);
			job.chunkBuffers[index] = buffer;
			const duration = await decodeAudioDuration(buffer);
			job.chunkReady[index] = true;
			job.chunkDurations[index] = duration;
			job.chunkInFlight[index] = false;
			// The save starts first, so a background job finished by this progress counts as being saved.
			this.maybeSaveOnGenerationComplete(job);
			this.publishJobProgress(job);
			return buffer;
		} catch (error) {
			job.chunkInFlight[index] = false;
			this.publishJobProgress(job);
			throw error;
		}
	}

	/** Mirrors a job's generation progress onto whichever public state it's currently driving -- playback's `state` fields if it's the active job, or `state.backgroundJobs` if it's in that list. A no-op once the job has been discarded from both roles. */
	private publishJobProgress(job: GenerationJob): void {
		if (job === this.activeJob) {
			this.setState({
				chunkReady: [...job.chunkReady],
				chunkInFlight: [...job.chunkInFlight],
				chunkDurations: [...job.chunkDurations],
			});
		} else if (this.backgroundQueue.includes(job)) {
			this.backgroundQueue.onProgress(job);
		}
	}

	/**
	 * Saves (once) as soon as every chunk in a job has finished generating, regardless of playback progress.
	 * Never for a cancelled job: a request still in flight when the read was cancelled (or the plugin
	 * unloaded) can complete the last chunk afterwards, and that read's audio isn't wanted any more.
	 */
	private maybeSaveOnGenerationComplete(job: GenerationJob): void {
		if (job.savedForSession || job.cancelled || job.noteDeleted) return;
		if (job.chunkReady.length === 0 || !job.chunkReady.every(Boolean)) return;
		// A job that may be saved always has a contentHash (both are set only for a full-note read); checked
		// because saveAudioFile() requires it.
		const { sourceFileForSave, contentHash } = job;
		if (!this.settings.saveAudioFile || !sourceFileForSave || contentHash === null) return;

		job.savedForSession = true;
		const buffers = job.chunkBuffers.filter((buffer): buffer is ArrayBuffer => buffer !== undefined);
		const chunkDurations = job.chunkDurations.map((duration) => duration ?? 0);
		// The note can still be deleted (or the plugin unloaded) while saving waits, e.g. on the voice name lookup.
		const isCancelled = () => job.noteDeleted || this.disposed;
		job.saving = true;
		void (async () => {
			const audioFile = await this.savedAudio.saveAudioFile(buffers, sourceFileForSave, chunkDurations, job.narrator, contentHash, isCancelled);
			job.saving = false;
			job.savedAudioPath = audioFile?.path ?? null;
			if (!this.disposed) this.backgroundQueue.onSaved(job);
		})();
	}

	/**
	 * Drops background jobs for a file that was just deleted: either the job's note, or the audio file it
	 * saved (see {@link BackgroundQueue.handleFileDeleted}).
	 *
	 * The active read of a deleted note keeps playing, but is marked so it's never saved (that would leave
	 * an orphan audio file, then fail to link it from the missing note) or moved to the background (where it
	 * would show as a card for a note that no longer exists). An "Auto-generate on open" of it stops, for
	 * the same reason.
	 */
	handleFileDeleted(path: string): void {
		if (this.activeJob?.file?.path === path) this.activeJob.noteDeleted = true;
		this.cancelAutoGeneration(path);
		this.backgroundQueue.handleFileDeleted(path);
	}

	/**
	 * Keeps a job's saved-audio path in step with the file being moved or renamed, so deleting it from its
	 * new place still drops the job. (Trashing a file, to the system trash or Obsidian's `.trash` folder,
	 * fires a delete event, not a rename -- see {@link handleFileDeleted}. A renamed note needs nothing here:
	 * the job holds the same TFile, whose path Obsidian updates. A running "Auto-generate on open" is tracked
	 * by path, so it moves along with its note.)
	 */
	handleFileRenamed(newPath: string, oldPath: string): void {
		this.backgroundQueue.handleFileRenamed(newPath, oldPath);
		const autoGeneration = this.autoGenerations.get(oldPath);
		if (autoGeneration) {
			this.autoGenerations.delete(oldPath);
			this.autoGenerations.set(newPath, autoGeneration);
		}
	}

	/**
	 * Silently (re)generates and saves a note's audio if it's missing or outdated, without touching
	 * playback state — safe to call in the background (e.g. on file-open) even while something else is playing.
	 */
	async autoGenerateIfNeeded(file: TFile): Promise<void> {
		if (!this.settings.autoGenerateOnOpen || !this.settings.saveAudioFile || !this.settings.linkAudioInNote) return;
		if (file.extension !== 'md') return;
		if (this.disposed || this.isNoteBeingGenerated(file)) return;

		// Tracked from the start, before the first wait, so deleting the note at any point stops the run.
		const run = { cancelled: false };
		this.autoGenerations.set(file.path, run);
		// Stops (without saving) once the plugin unloads or the run is cancelled: a request in flight then
		// finishes or gives up on its own, but no further chunks are requested, and nothing is written.
		const isCancelled = () => this.disposed || run.cancelled;
		try {
			const status = await this.savedAudio.getAudioStatus(file);
			if (status === 'up-to-date') return;

			const narrator = this.noteText.getActiveNarrator();
			if (!narrator) return;
			const apiKey = getProviderApiKey(this.app, narrator.provider);
			if (!apiKey) return;

			const rawText = await this.app.vault.cachedRead(file);
			// A read or background job of the note may have started during the waits above.
			if (isCancelled() || this.isNoteReadOrQueued(file)) return;
			// Taken now, from the text being generated, so edits made while it generates show as outdated.
			const contentHash = this.savedAudio.stalenessHash(rawText, file);
			const input = this.noteText.buildNoteInput(file, rawText);
			// Chunked exactly as a read is (quick start's short first chunks included), so playing the saved
			// audio can slice it back into the chunks the note splits into, for Previous/Next part and highlighting.
			const { chunks } = this.noteText.buildChunksAndPositions(input.rawText, input.positionBase);
			if (chunks.length === 0) return;

			const provider = createTTSProvider(narrator.provider, narrator.voice, apiKey);
			const buffers: ArrayBuffer[] = [];
			const chunkDurations: number[] = [];
			for (const chunk of chunks) {
				if (isCancelled()) return;
				const buffer = await provider.synthesize(chunk, isCancelled);
				buffers.push(buffer);
				chunkDurations.push(await decodeAudioDuration(buffer));
			}
			if (isCancelled()) return;

			await this.savedAudio.saveAudioFile(buffers, file, chunkDurations, narrator, contentHash, isCancelled);
		} catch (error) {
			console.error('Note Narrator: auto-generate on open failed', error);
		} finally {
			// Another run of the note may have started since this one was cancelled; leave that one tracked.
			if (this.autoGenerations.get(file.path) === run) this.autoGenerations.delete(file.path);
		}
	}

	/**
	 * Stops a running "Auto-generate on open" of the note at `path`, without saving: before its next chunk
	 * (a request in flight finishes or gives up on its own) and before it saves. Used when the note is
	 * deleted, and when Read or Background starts generating the note itself, so the same audio isn't paid
	 * for twice and two saves don't race. Chunks it already generated are dropped: the new generation
	 * starts from the beginning.
	 */
	private cancelAutoGeneration(path: string): void {
		const run = this.autoGenerations.get(path);
		if (run) run.cancelled = true;
	}

	/**
	 * Whether the note's full audio is already being generated, or has been generated and not yet saved:
	 * by its active read, a background job (queued, generating or done), or "Auto-generate on open" itself.
	 * Auto-generating it as well would pay for the same audio twice and race the two saves.
	 */
	private isNoteBeingGenerated(file: TFile): boolean {
		if (this.isNoteReadOrQueued(file)) return true;
		const autoGeneration = this.autoGenerations.get(file.path);
		return autoGeneration !== undefined && !autoGeneration.cancelled;
	}

	/** Whether the note's full audio is being generated by its active read or a background job (queued, generating or done). */
	private isNoteReadOrQueued(file: TFile): boolean {
		const active = this.activeJob;
		if (active && !active.isSelection && active.file?.path === file.path) return true;
		return this.backgroundQueue.find(file) !== undefined;
	}

	/** The active narrator profile resolved with its provider, or null when none is usable. */
	getActiveNarrator(): ResolvedNarrator | null {
		return this.noteText.getActiveNarrator();
	}

	/** Note-length stats for the panel's idle-state display; see {@link NoteText.getNoteStats}. */
	getNoteStats(file: TFile): ReturnType<NoteText['getNoteStats']> {
		return this.noteText.getNoteStats(file);
	}

	/** Compares the note's current content against the hash stored when its linked audio was last generated. */
	getAudioStatus(file: TFile): Promise<AudioLinkStatus> {
		return this.savedAudio.getAudioStatus(file);
	}

	/**
	 * How the note's saved audio compares with the note and the active narrator (see {@link savedAudioFreshness}),
	 * or null when it has none. For the panel's status line and the toolbar icon, which is also where the
	 * properties of a linked audio file that's gone missing are cleaned up.
	 */
	async getSavedAudioFreshness(file: TFile): Promise<SavedAudioFreshness | null> {
		const info = await this.savedAudio.getAudioInfo(file, true);
		if (!info) return null;
		return savedAudioFreshness(info.status, info.savedVoice, this.noteText.getActiveNarrator()?.voice ?? null);
	}

	/** Info about a note's linked saved audio, for the player view's "Play saved"/"Regenerate" buttons. Null if none exists. */
	getAudioInfo(file: TFile): ReturnType<SavedAudio['getAudioInfo']> {
		return this.savedAudio.getAudioInfo(file);
	}

	/** Deletes a note's linked audio file (if any) and removes the Note Narrator audio properties from its frontmatter. */
	async clearReaderFiles(sourceFile: TFile): Promise<void> {
		try {
			await this.savedAudio.clearReaderFiles(sourceFile);
		} catch (error) {
			console.error('Note Narrator: failed to clear Note Narrator files', error);
			new Notice(`Failed to clear Note Narrator files: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		// Once the files are cleared, a finished job's card stands for audio that's gone (its file may not even
		// be the one deleted, e.g. with saving off or "Keep old versions"), so it goes too. If its own saved file
		// was the one trashed, the vault's delete event has already dropped it (handleFileDeleted()), even if
		// clearing then failed on the properties: that audio really is gone. A queued or generating job is
		// left alone: clearing old audio shouldn't throw away a (paid) generation in progress, whose new audio
		// is saved and linked when it finishes.
		const job = this.backgroundQueue.find(sourceFile);
		if (job?.backgroundStatus === 'done') this.backgroundQueue.discard(job.id);
	}

	/** Plays a previously saved audio file directly, without generating anything. */
	async playSavedFile(audioFile: TFile, sourceFile: TFile | null = null): Promise<void> {
		this.backgroundActiveJobForOtherNote(sourceFile);
		this.stop();
		const session = this.sessionId;

		const timeline = sourceFile ? await this.buildSavedPlaybackTimeline(sourceFile) : null;
		if (session !== this.sessionId) return;

		try {
			const data = await this.app.vault.readBinary(audioFile);
			if (session !== this.sessionId) return;

			// Slicing back into per-chunk buffers -- rather than playing the whole file as one element and
			// seeking within it -- is what makes Previous/Next part (and highlighting/scroll-to-current)
			// reliable here: each chunk plays through the exact same per-chunk path a live read uses. If the
			// byte lengths don't actually add up to this file's size (stale/mismatched metadata), fall back
			// to playing it as one opaque chunk with no timeline -- no Previous/Next part, no highlighting,
			// rather than slicing at the wrong offsets.
			const sliced = timeline ? sliceIntoChunks(data, timeline.chunkByteLengths) : null;
			this.savedPlaybackTimeline = sliced ? timeline : null;
			const buffers = sliced ?? [data];
			const chunkCount = buffers.length;

			this.currentPlaybackRate = this.settings.playbackRate;
			this.setState({
				status: 'playing',
				chunkIndex: 0,
				chunkCount,
				currentTime: 0,
				duration: 0,
				chunkReady: new Array<boolean>(chunkCount).fill(true),
				chunkInFlight: new Array<boolean>(chunkCount).fill(false),
				chunkDurations: sliced && timeline ? timeline.chunkDurations : [undefined],
				activeFile: sourceFile,
				activeReadKind: 'saved',
			});

			if (session !== this.sessionId) return;
			await this.playSavedChunksFromIndex(session, buffers);
			if (session !== this.sessionId) return;
			this.savedPlaybackTimeline = null;
			this.resetToIdle();
		} catch (error) {
			// Another read (or Play saved) has started since: this failure is about one that's already gone.
			if (session !== this.sessionId) return;
			console.error('Note Narrator: failed to play saved audio', error);
			new Notice(`Failed to play saved audio: ${error instanceof Error ? error.message : String(error)}`);
			this.savedPlaybackTimeline = null;
			this.resetToIdle();
		}
	}

	/** Plays a saved file's already-sliced chunk buffers sequentially, honoring Previous/Next-part jumps exactly like a live read's `playFromIndex()` -- just with no generation step, since every buffer is already fully formed. */
	private async playSavedChunksFromIndex(session: number, buffers: ArrayBuffer[]): Promise<void> {
		let index = 0;
		while (index >= 0 && index < buffers.length) {
			if (session !== this.sessionId) return;
			this.setState({ chunkIndex: index });
			const outcome = await this.playChunk(null, buffers[index]!, index, buffers.length);
			if (session !== this.sessionId) return;
			index = outcome === 'previous' ? Math.max(0, index - 1) : index + 1;
		}
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

			if (this.pauseWhenChunkArrives) {
				// Paused while this chunk was generating: load it but leave it paused until Resume.
				this.pauseWhenChunkArrives = false;
				this.setState({ status: 'paused', chunkIndex: index, chunkCount: count, currentTime: 0, duration: audio.duration || 0 });
				return;
			}
			this.setState({ status: 'playing', chunkIndex: index, chunkCount: count, currentTime: 0, duration: audio.duration || 0 });
			void audio.play();
		});
	}
}
