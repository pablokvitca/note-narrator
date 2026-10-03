import { App, Events, MarkdownView, Notice, TFile } from 'obsidian';
import { decodeAudioDuration, sliceIntoChunks } from './audio-utils';
import { AudioLinkStatus, ChunkOutcome, GenerationJob, IDLE_STATE, PositionBase, ReaderState, SavedPlaybackTimeline } from './reader-types';
import { ChunkPosition, RawSpan } from '../text/text-position';
import { HighlightGranularity, NoteNarratorSettings } from '../settings/settings';
import { ResolvedNarrator, generationWindow } from '../settings/profiles';
import { GenerateInBackgroundAction, buildBackgroundJobInfo, decideGenerateInBackground, findBackgroundJobForNote, hasPendingGeneration } from './background-job';
import { chunkNote, stripFrontmatter } from '../text/text-utils';
import { createTTSProvider, getProviderApiKey, missingApiKeyMessage } from '../tts/registry';
import { NoteText } from './note-text';
import { SavedAudio } from './saved-audio';

/** How a worker pool's run ended; see `Reader.runGenerationWorkerPool()`. */
type PoolResult = 'done' | 'superseded' | 'failed';

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

	/** The job currently bound to playback and driving `state`. Null when nothing is generating/playing (or a saved file is playing directly, with no generation job involved). */
	private activeJob: GenerationJob | null = null;

	/** Jobs generating (or queued to generate, or done) without being bound to playback. At most one has backgroundStatus 'generating' at a time. */
	private backgroundJobs: GenerationJob[] = [];

	/** Set while a saved file plays directly (no generation job), so `getSpan()` can still map elapsed playback time back to a chunk/section. Null whenever there's no such timeline (e.g. the note's since changed, or no chunk-durations property was saved). */
	private savedPlaybackTimeline: SavedPlaybackTimeline | null = null;

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
		const windowSize = generationWindow(job.narrator.provider, true);
		const result = await this.runGenerationWorkerPool(job, windowSize);
		// Superseded: a newer pool owns the job now (it was adopted into playback, maybe moved back here
		// since), and whichever run owns it finishes it -- acting here too would finish it twice.
		// A 'failed' run has always cancelled the job, so past this check the run is 'done'.
		if (result === 'superseded' || job.cancelled || !this.backgroundJobs.includes(job)) return;

		this.finishBackgroundJob(job);
		this.advanceBackgroundQueue();
	}

	/** Marks a background job done and announces it, once: a no-op if it's already done or still has chunks left. */
	private finishBackgroundJob(job: GenerationJob): void {
		if (job.backgroundStatus === 'done' || hasPendingGeneration(job.chunkReady)) return;
		job.backgroundStatus = 'done';
		this.publishBackgroundJobs();
		new Notice(`Finished generating "${job.file?.basename ?? 'note'}" in the background.`);
	}

	isPlaying(): boolean {
		return this.state.status === 'playing';
	}

	/** Stops playback and cancels every generation job, background ones included; called when the plugin unloads so nothing keeps generating or saving afterwards. */
	dispose(): void {
		this.stop();
		for (const job of this.backgroundJobs) job.cancelled = true;
		this.backgroundJobs = [];
		this.setState({ backgroundJobs: [] });
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
	 * queues behind whichever one is already generating, in the order they were backgrounded. A selection
	 * read is never moved (see `GenerationJob.isSelection`).
	 */
	continueGeneratingInBackground(): void {
		const job = this.activeJob;
		if (!job || job.isSelection) return;
		if (!hasPendingGeneration(job.chunkReady)) return;

		this.activeJob = null;
		// Bumping the session stops the playback loop (playFromIndex) at its next check without touching
		// `job` itself. Its generation is handed to the background queue below: enqueueBackgroundJob() retires
		// the foreground worker pool (see GenerationJob.poolToken), and the queue starts a background one
		// when it's the job's turn. Chunks already in flight still finish and are kept.
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

		this.resetToIdle();
		this.enqueueBackgroundJob(job);
	}

	/** Adds a job to the background list, starting it right away if nothing else is generating there, otherwise queueing it behind the one that is. */
	private enqueueBackgroundJob(job: GenerationJob): void {
		// Retires whatever pool was driving it (its foreground one, after "Move to background"), so the
		// background queue alone decides when it generates and how many chunks at once.
		job.poolToken++;
		job.backgroundStatus = this.backgroundJobs.some((j) => j.backgroundStatus === 'generating') ? 'queued' : 'generating';
		this.backgroundJobs.push(job);
		this.publishBackgroundJobs();

		if (job.backgroundStatus === 'generating') void this.runBackgroundJob(job);
	}

	/** What "Generate in background" would do for this note right now; shared by the command and the panel's button so they always agree. */
	getGenerateInBackgroundAction(file: TFile): GenerateInBackgroundAction {
		const state = this.state;
		return decideGenerateInBackground({
			notePath: file.path,
			activePath: state.status === 'idle' ? null : (state.activeFile?.path ?? null),
			activeKind: state.activeReadKind,
			activePendingGeneration: hasPendingGeneration(state.chunkReady),
			backgroundJobs: this.backgroundJobs.map((job) => ({ path: job.file?.path ?? null, status: job.backgroundStatus })),
		});
	}

	/**
	 * Generates the whole note straight into the background queue without ever playing it, so a note can
	 * be prepared ahead of time without clicking Read first. Never interrupts whatever's currently playing.
	 * See {@link decideGenerateInBackground} for what happens when the note is already being read or
	 * already has a background job. Always the full note, never a selection.
	 */
	generateNoteInBackground(view?: MarkdownView): void {
		const target = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = target?.file;
		if (!target || !file) {
			new Notice('Open a note to generate its audio.');
			return;
		}

		const action = this.getGenerateInBackgroundAction(file);
		if (action === 'move-active') {
			this.continueGeneratingInBackground();
			return;
		}
		if (action === 'already-generated') {
			new Notice(`"${file.basename}" has already finished generating.`);
			return;
		}
		if (action === 'playing-saved') {
			new Notice(`"${file.basename}" is playing from its saved audio.`);
			return;
		}
		if (action === 'already-queued') {
			new Notice(`"${file.basename}" is already in the background queue.`);
			return;
		}
		if (action === 'ready-in-background') {
			new Notice(`"${file.basename}" has already finished generating in the background.`);
			return;
		}

		const { fullValue, rawText, positionBase } = this.buildNoteInput(target);
		const prepared = this.prepareRead(rawText, positionBase);
		if (!prepared) return;

		this.enqueueBackgroundJob(this.createJob(file, prepared, true, fullValue));
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
		const job = this.backgroundJobs.find((j) => j.id === jobId);
		if (!job) return;
		this.adoptBackgroundJob(job);
	}

	/** Shared by `playBackgroundJob()` and `readText()` re-adopting a matching in-progress job: promotes a background job to active and starts playing it from the beginning. */
	private adoptBackgroundJob(job: GenerationJob): void {
		this.backgroundJobs = this.backgroundJobs.filter((j) => j !== job);
		const wasGenerating = job.backgroundStatus === 'generating';
		this.publishBackgroundJobs();

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

		// Promoting the job that held the one "generating" slot frees it for the next queued job. A job
		// that was only 'queued' or already 'done' wasn't occupying that slot, so nothing to advance.
		if (wasGenerating) this.advanceBackgroundQueue();

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
		const job = this.backgroundJobs.find((j) => j.id === jobId);
		if (!job) return;
		this.backgroundJobs = this.backgroundJobs.filter((j) => j !== job);
		const wasGenerating = job.backgroundStatus === 'generating';
		job.cancelled = true;
		this.publishBackgroundJobs();
		if (wasGenerating) this.advanceBackgroundQueue();
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

			const fullValue = await this.app.vault.cachedRead(sourceFile);
			const body = stripFrontmatter(fullValue);
			const fileOffset = fullValue.length - body.length;
			const preamble = this.noteText.buildPreamble(sourceFile.basename, frontmatter);
			const rawText = preamble ? `${preamble}\n\n${body}` : body;
			const positionBase: PositionBase = { rawTextOffset: preamble ? preamble.length + 2 : 0, fileOffset, length: body.length };

			const { positions } = this.noteText.buildChunksAndPositions(rawText, positionBase);
			if (positions.length !== chunkDurations.length) return null;

			return { file: sourceFile, positions, chunkDurations, chunkByteLengths };
		} catch (error) {
			console.error('Note Narrator: failed to build saved-playback highlight timeline', error);
			return null;
		}
	}

	async readNote(view?: MarkdownView): Promise<void> {
		const target = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!target) {
			new Notice('Open a note to read it aloud.');
			return;
		}

		const selection = target.editor.getSelection();
		if (this.settings.readSelectionIfPresent && selection.length > 0) {
			// No reliable offset to rebase estimated spans onto (the selection could start anywhere in the
			// document) -- selections just don't get highlighting/scroll-to-current.
			await this.readText(selection, target.file, { allowSave: false });
			return;
		}

		const { fullValue, rawText, positionBase } = this.buildNoteInput(target);
		await this.readText(rawText, target.file, { allowSave: true, positionBase, sourceContent: fullValue });
	}

	/** The full text a note is read from (spoken preamble plus body, frontmatter stripped), and where that body sits in the file for highlighting. */
	private buildNoteInput(target: MarkdownView): { fullValue: string; rawText: string; positionBase: PositionBase } {
		const fullValue = target.editor.getValue();
		const body = stripFrontmatter(fullValue);
		const fileOffset = fullValue.length - body.length;
		const frontmatter = target.file ? this.app.metadataCache.getFileCache(target.file)?.frontmatter : undefined;
		const preamble = this.noteText.buildPreamble(target.file?.basename ?? null, frontmatter);
		return {
			fullValue,
			rawText: preamble ? `${preamble}\n\n${body}` : body,
			positionBase: { rawTextOffset: preamble ? preamble.length + 2 : 0, fileOffset, length: body.length },
		};
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
	private createJob(sourceFile: TFile | null, prepared: PreparedRead, allowSave: boolean, sourceContent?: string): GenerationJob {
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
			sourceFileForSave: allowSave ? sourceFile : null,
			contentHash: allowSave && sourceFile && sourceContent !== undefined ? this.savedAudio.stalenessHash(sourceContent, sourceFile) : null,
			isSelection: !allowSave,
			savedForSession: false,
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
		options: { allowSave: boolean; positionBase?: PositionBase; sourceContent?: string },
	): Promise<void> {
		const prepared = this.prepareRead(rawText, options.positionBase);
		if (!prepared) return;

		// Re-reading a note that already has a background job (queued, generating, or done) adopts that job
		// in place rather than discarding its progress -- the same outcome as clicking the job's card, just
		// triggered from Read instead. Only for a full-note read: a selection read's text won't match the
		// background job's chunks, so it plays on its own and leaves the background job as it is.
		if (sourceFile && options.allowSave) {
			const existing = findBackgroundJobForNote(this.backgroundJobs, sourceFile.path);
			if (existing) {
				this.adoptBackgroundJob(existing);
				return;
			}
		}

		// A selection read leaves the note's background job (if any) alone: it's for the whole note, so it
		// doesn't conflict with reading just part of it, and discarding it would throw away paid generation.
		this.backgroundActiveJobForOtherNote(sourceFile);
		this.stop();

		const session = this.sessionId;
		this.currentPlaybackRate = this.settings.playbackRate;

		const job = this.createJob(sourceFile, prepared, options.allowSave, options.sourceContent);
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
	 * that are already ready or in flight) -- used both to generate a whole read upfront (when "start
	 * playback immediately" is off) and to drive a background job. Resolves to:
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
			const bgIndex = this.backgroundJobs.indexOf(job);
			if (bgIndex !== -1) {
				this.backgroundJobs.splice(bgIndex, 1);
				this.publishBackgroundJobs();
				this.advanceBackgroundQueue();
			}
			return 'failed';
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
			this.publishJobProgress(job);
			this.maybeSaveOnGenerationComplete(job);
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
		} else if (this.backgroundJobs.includes(job)) {
			this.publishBackgroundJobs();
			// A queued job can still finish before its turn, when every chunk it had left was already in
			// flight as it moved to the background: finish it now instead of showing it as queued.
			if (job.backgroundStatus === 'queued') this.finishBackgroundJob(job);
		}
	}

	/** Saves (once) as soon as every chunk in a job has finished generating, regardless of playback progress. */
	private maybeSaveOnGenerationComplete(job: GenerationJob): void {
		if (job.savedForSession) return;
		if (job.chunkReady.length === 0 || !job.chunkReady.every(Boolean)) return;
		if (!this.settings.saveAudioFile || !job.sourceFileForSave) return;

		job.savedForSession = true;
		const buffers = job.chunkBuffers.filter((buffer): buffer is ArrayBuffer => buffer !== undefined);
		const chunkDurations = job.chunkDurations.map((duration) => duration ?? 0);
		void this.savedAudio.saveAudioFile(buffers, job.sourceFileForSave, chunkDurations, job.narrator, job.contentHash);
	}

	/**
	 * Silently (re)generates and saves a note's audio if it's missing or outdated, without touching
	 * playback state — safe to call in the background (e.g. on file-open) even while something else is playing.
	 */
	async autoGenerateIfNeeded(file: TFile): Promise<void> {
		if (!this.settings.autoGenerateOnOpen || !this.settings.saveAudioFile || !this.settings.linkAudioInNote) return;
		if (file.extension !== 'md') return;

		try {
			const status = await this.savedAudio.getAudioStatus(file);
			if (status === 'up-to-date') return;

			const narrator = this.noteText.getActiveNarrator();
			if (!narrator) return;
			const apiKey = getProviderApiKey(this.app, narrator.provider);
			if (!apiKey) return;

			const rawText = await this.app.vault.cachedRead(file);
			// Taken now, from the text being generated, so edits made while it generates show as outdated.
			const contentHash = this.savedAudio.stalenessHash(rawText, file);
			const body = stripFrontmatter(rawText);
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const preamble = this.noteText.buildPreamble(file.basename, frontmatter);
			const textToRead = preamble ? `${preamble}\n\n${body}` : body;

			const charLimit = this.noteText.getCharLimit();
			const chunks = chunkNote(
				textToRead,
				charLimit,
				this.noteText.getReadingConfig().chunkerStyle,
				this.noteText.getReadingConfig().maxHeadingDepth,
				this.noteText.getStripMarkdownOptions(),
				this.noteText.getSkipHeadingPatterns(),
			);
			if (chunks.length === 0) return;

			const provider = createTTSProvider(narrator.provider, narrator.voice, apiKey);

			const buffers: ArrayBuffer[] = [];
			const chunkDurations: number[] = [];
			for (const chunk of chunks) {
				const buffer = await provider.synthesize(chunk);
				buffers.push(buffer);
				chunkDurations.push(await decodeAudioDuration(buffer));
			}

			await this.savedAudio.saveAudioFile(buffers, file, chunkDurations, narrator, contentHash);
		} catch (error) {
			console.error('Note Narrator: auto-generate on open failed', error);
		}
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

	/** Info about a note's linked saved audio, for the player view's "Play saved"/"Regenerate" buttons. Null if none exists. */
	getAudioInfo(file: TFile): ReturnType<SavedAudio['getAudioInfo']> {
		return this.savedAudio.getAudioInfo(file);
	}

	/** Deletes a note's linked audio file (if any) and removes the Note Narrator audio properties from its frontmatter. */
	clearReaderFiles(sourceFile: TFile): Promise<void> {
		return this.savedAudio.clearReaderFiles(sourceFile);
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
	/** `savedTimeline`, when given, is a saved-playback timeline for the whole (single, concatenated) `audioData` -- used to keep `state.chunkIndex` in sync with elapsed time on every tick, since there's no per-chunk audio element to drive it here the way a live read's chunk-by-chunk loop does. */
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
