import { Notice, TFile } from 'obsidian';
import { NoteNarratorSettings } from '../settings/settings';
import { generationWindow } from '../settings/profiles';
import { BackgroundJobInfo, buildBackgroundJobInfo, hasPendingGeneration } from './background-job';
import { GenerationJob, PoolResult } from './reader-types';

/** What the queue needs from the Reader that owns it. */
export interface BackgroundQueueHost {
	/** Generates a job's remaining chunks with up to `windowSize` at once; see `Reader.runGenerationWorkerPool()`. */
	runWorkerPool(job: GenerationJob, windowSize: number): Promise<PoolResult>;
	/** Publishes the list's progress onto the Reader's state, for the panel. */
	publish(jobs: BackgroundJobInfo[]): void;
	/** Whether a job no longer matches its note (see `Reader.isBackgroundJobStale()`), so it's replaced rather than played. */
	isStale(job: GenerationJob, file: TFile, currentContent?: string): boolean;
}

/**
 * The background generation queue: notes generating (or queued to generate, or done) without being bound to
 * playback. Jobs generate one at a time, in the order they were added, at the provider's background window.
 * The Reader owns one, and hands jobs over at the boundary: moving a read to the background enqueues it,
 * playing a card takes it out (see {@link take}).
 */
export class BackgroundQueue {
	/** At most one has backgroundStatus 'generating' at a time. */
	private jobs: GenerationJob[] = [];

	constructor(
		private settings: NoteNarratorSettings,
		private host: BackgroundQueueHost,
	) {}

	/** The jobs in list order, oldest first. */
	all(): readonly GenerationJob[] {
		return this.jobs;
	}

	includes(job: GenerationJob): boolean {
		return this.jobs.includes(job);
	}

	findById(jobId: number): GenerationJob | undefined {
		return this.jobs.find((job) => job.id === jobId);
	}

	/** The note's background job, if it has one. A note never has more than one: generating again replaces or reuses it. */
	find(file: TFile): GenerationJob | undefined {
		return this.jobs.find((job) => job.file?.path === file.path);
	}

	/** Publishes the jobs' current progress/status onto the Reader's state. */
	publish(): void {
		this.host.publish(this.jobs.map((job) => buildBackgroundJobInfo(job.id, job.file, job.chunkReady, job.chunkInFlight, job.backgroundStatus)));
	}

	/** Adds a job to the list, starting it right away if nothing else is generating, otherwise queueing it behind the one that is. */
	enqueue(job: GenerationJob): void {
		// Retires whatever pool was driving it (its foreground one, after "Move to background"), so the
		// queue alone decides when it generates and how many chunks at once.
		job.poolToken++;
		job.backgroundStatus = this.jobs.some((j) => j.backgroundStatus === 'generating') ? 'queued' : 'generating';
		this.jobs.push(job);
		this.publish();

		if (job.backgroundStatus === 'generating') void this.run(job);
	}

	/**
	 * Takes a job out of the list, without cancelling it: for playing its card, or once its generation failed.
	 * If it held the one "generating" slot, the next queued job starts. A no-op if it isn't in the list.
	 */
	take(job: GenerationJob): void {
		if (!this.jobs.includes(job)) return;
		this.jobs = this.jobs.filter((j) => j !== job);
		this.publish();
		// A job that was only 'queued' or already 'done' wasn't occupying that slot, so nothing to advance.
		if (job.backgroundStatus === 'generating') this.advance();
	}

	/** Removes a job from the list: cancels its generation if still queued/generating, or just clears it once done. No-op if `jobId` isn't in the list. */
	discard(jobId: number): void {
		const job = this.findById(jobId);
		if (!job) return;
		job.cancelled = true;
		this.take(job);
	}

	/** Discards this note's job if it's stale (see {@link BackgroundQueueHost.isStale}). */
	discardIfStale(file: TFile, currentContent: string): void {
		const existing = this.find(file);
		if (existing && this.host.isStale(existing, file, currentContent)) this.discard(existing.id);
	}

	/** Starts the next queued job (if any) generating. No-op if one is already generating or none are queued. */
	private advance(): void {
		if (this.jobs.some((job) => job.backgroundStatus === 'generating')) return;
		const next = this.jobs.find((job) => job.backgroundStatus === 'queued');
		if (!next) return;

		next.backgroundStatus = 'generating';
		this.publish();
		void this.run(next);
	}

	/** Drives one job's generation to completion, then advances the queue. A no-op past its own removal (played or discarded): whatever removed it advanced the queue itself. */
	private async run(job: GenerationJob): Promise<void> {
		const result = await this.host.runWorkerPool(job, generationWindow(job.narrator.provider, true));
		// Superseded: a newer pool owns the job now (it was adopted into playback, maybe moved back here
		// since), and whichever run owns it finishes it -- acting here too would finish it twice.
		// A 'failed' run has always cancelled the job, so past this check the run is 'done'.
		if (result === 'superseded' || job.cancelled || !this.jobs.includes(job)) return;

		this.finish(job);
		this.advance();
	}

	/**
	 * Called whenever one of the job's chunks starts or finishes generating. A queued job can still finish
	 * before its turn, when every chunk it had left was already in flight as it moved to the background: it's
	 * finished now instead of showing as queued.
	 */
	onProgress(job: GenerationJob): void {
		this.publish();
		if (job.backgroundStatus === 'queued') this.finish(job);
	}

	/** Marks a job done and announces it, once: a no-op if it's already done or still has chunks left. */
	private finish(job: GenerationJob): void {
		if (job.backgroundStatus === 'done' || hasPendingGeneration(job.chunkReady)) return;
		job.backgroundStatus = 'done';
		this.publish();
		new Notice(`Finished generating "${job.file?.basename ?? 'note'}" in the background.`);
		this.freeSavedAudio(job);
		this.enforceUnsavedJobLimit();
	}

	/**
	 * Called once a job's save has finished and set its `savedAudioPath` (null if saving failed). A finished
	 * job's audio is freed once saved; one whose save failed is held only in memory, so it counts toward the limit.
	 */
	onSaved(job: GenerationJob): void {
		if (job.savedAudioPath === null) this.enforceUnsavedJobLimit();
		else this.freeSavedAudio(job);
	}

	/**
	 * Drops a finished job's audio from memory once it's saved in the vault: playing its card then plays the
	 * saved file instead (see `Reader.adoptBackgroundJob()`). A no-op until the job is both finished and saved,
	 * or once it has left the list.
	 */
	private freeSavedAudio(job: GenerationJob): void {
		if (job.backgroundStatus !== 'done' || job.savedAudioPath === null || job.audioFreed) return;
		if (!this.jobs.includes(job)) return;
		job.audioFreed = true;
		job.chunkBuffers = new Array<ArrayBuffer | undefined>(job.chunks.length);
		job.chunkPromises = new Array<Promise<ArrayBuffer> | undefined>(job.chunks.length);
	}

	/**
	 * Keeps at most `maxUnsavedBackgroundJobs` finished jobs whose audio is held only in memory (not saved, and
	 * not being saved), clearing the oldest beyond that. 0 (or an invalid value) keeps them all.
	 */
	private enforceUnsavedJobLimit(): void {
		const limit = this.settings.maxUnsavedBackgroundJobs;
		if (!Number.isFinite(limit) || limit <= 0) return;
		const unsaved = this.jobs.filter((job) => job.backgroundStatus === 'done' && job.savedAudioPath === null && !job.saving);
		for (const job of unsaved.slice(0, Math.max(0, unsaved.length - limit))) {
			this.discard(job.id);
			new Notice(`Cleared "${job.file?.basename ?? 'note'}" from the background list, since its audio wasn't saved. Up to ${limit} unsaved notes are kept (see the Performance settings).`);
		}
	}

	/**
	 * Drops the jobs for a file that was just deleted: either the job's note, or the audio file it saved. A
	 * finished job's card would otherwise keep showing "Ready in background" (blocking generating the note
	 * again) for audio that's gone from the vault, or for a note that no longer exists. A job of the deleted
	 * note is marked first, so a save it already started doesn't link the missing note.
	 */
	handleFileDeleted(path: string): void {
		for (const job of this.jobs) {
			if (job.file?.path === path) job.noteDeleted = true;
		}
		for (const job of this.jobs.filter((j) => j.file?.path === path || j.savedAudioPath === path)) {
			this.discard(job.id);
		}
	}

	/** Keeps a job's saved-audio path in step with the file being moved or renamed, so deleting it from its new place still drops the job. */
	handleFileRenamed(newPath: string, oldPath: string): void {
		for (const job of this.jobs) {
			if (job.savedAudioPath === oldPath) job.savedAudioPath = newPath;
		}
	}

	/** Cancels and clears every job; for the plugin unloading. */
	dispose(): void {
		for (const job of this.jobs) job.cancelled = true;
		this.jobs = [];
		this.publish();
	}
}
