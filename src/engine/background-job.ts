import type { TFile } from 'obsidian';

/**
 * Pure, Obsidian-independent logic for background generation -- "Move to background" (OBS-35) and
 * "Generate in background" (OBS-127) -- kept out of reader.ts so it's unit-testable without a vault or a
 * mocked Obsidian runtime. reader.ts and player-view.ts both delegate to this, so the panel's buttons and
 * the commands always make the same decision.
 */

/** A background job's lifecycle: waiting its turn, actively generating, or fully generated. Only one job is 'generating' at a time -- the rest queue in insertion order. */
export type BackgroundJobStatus = 'queued' | 'generating' | 'done';

/** Snapshot of one background job's progress for the panel's background-jobs list. */
export interface BackgroundJobInfo {
	id: number;
	file: TFile | null;
	chunkCount: number;
	chunkReady: boolean[];
	chunkInFlight: boolean[];
	status: BackgroundJobStatus;
}

/** Whether a job still has chunks left to generate -- gates both the "Move to background" and "Cancel" buttons. */
export function hasPendingGeneration(chunkReady: boolean[]): boolean {
	return chunkReady.some((ready) => !ready);
}

/** Snapshot of a job's progress for the panel's background-job status box. */
export function buildBackgroundJobInfo(
	id: number,
	file: TFile | null,
	chunkReady: boolean[],
	chunkInFlight: boolean[],
	status: BackgroundJobStatus,
): BackgroundJobInfo {
	return {
		id,
		file,
		chunkCount: chunkReady.length,
		chunkReady: [...chunkReady],
		chunkInFlight: [...chunkInFlight],
		status,
	};
}

/** 1-based position of a queued job among only the other queued jobs, in list order. Meaningless (and unused) for a job that isn't 'queued'. */
export function queuePosition(jobs: BackgroundJobInfo[], jobId: number): number {
	return jobs.filter((job) => job.status === 'queued').findIndex((job) => job.id === jobId) + 1;
}

/** What's driving playback right now: nothing, a full-note read, a selection read, or "Play saved" (no generation job at all). */
export type ActiveReadKind = 'none' | 'full' | 'selection' | 'saved';

/**
 * What "Generate in background" does for a note:
 * - 'move-active': moves its current full-note read to the background.
 * - 'already-generated': its full-note read has nothing left to generate, so (like the panel's disabled
 *   "Move to background") nothing happens.
 * - 'playing-saved': it's playing from its saved audio (and has no background job), so nothing happens
 *   rather than paying to regenerate audio that's playing right now.
 * - 'already-queued': it already has a background job, still queued or generating.
 * - 'ready-in-background': its background job has finished (play it from its card, or clear it from the
 *   list to generate again).
 * - 'regenerate': its saved audio is up to date (same text, same narrator). Like Read, it can still be
 *   generated again on purpose; the panel's button tooltip then says "Regenerate in background".
 * - 'generate': starts a new background job.
 * A selection read of the note is never moved (selection reads can't go to the background); the full note
 * is generated alongside it instead.
 */
export type GenerateInBackgroundAction =
	| 'move-active'
	| 'already-generated'
	| 'playing-saved'
	| 'already-queued'
	| 'ready-in-background'
	| 'regenerate'
	| 'generate';

export interface GenerateInBackgroundInput {
	notePath: string;
	/** The note playback is currently about, or null when idle. */
	activePath: string | null;
	activeKind: ActiveReadKind;
	/** Whether the current read still has chunks left to generate. */
	activePendingGeneration: boolean;
	backgroundJobs: { path: string | null; status: BackgroundJobStatus }[];
	/** Whether the note's saved audio is up to date with its text and made with the active narrator. */
	savedAudioUpToDate: boolean;
}

export function decideGenerateInBackground(input: GenerateInBackgroundInput): GenerateInBackgroundAction {
	const isActive = input.activePath === input.notePath;
	if (isActive && input.activeKind === 'full') return input.activePendingGeneration ? 'move-active' : 'already-generated';
	// Checked before "playing saved" so a background job for the note still shows (queued, or ready to play)
	// while its saved audio plays.
	const existing = input.backgroundJobs.find((job) => job.path === input.notePath);
	if (existing) return existing.status === 'done' ? 'ready-in-background' : 'already-queued';
	if (isActive && input.activeKind === 'saved') return 'playing-saved';
	if (input.savedAudioUpToDate) return 'regenerate';
	return 'generate';
}
