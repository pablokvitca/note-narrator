import type { TFile } from 'obsidian';

/**
 * Pure, Obsidian-independent decision logic for "continue generating in background" (OBS-35), kept out of
 * reader.ts so it's unit-testable without a vault or a mocked Obsidian runtime -- reader.ts and player-view.ts
 * both delegate to this instead of duplicating the same `chunkReady.some(...)` check inline.
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

/** The background job (in any status) for a note, if there is one. Generic so it works on both the reader's live jobs and the panel's `BackgroundJobInfo` snapshots. */
export function findBackgroundJobForNote<T extends { file: { path: string } | null }>(jobs: T[], notePath: string): T | undefined {
	return jobs.find((job) => job.file?.path === notePath);
}

/** What "Generate in background" does for a note: move its current read to the background, nothing (it's already there), or start a new background job. */
export type GenerateInBackgroundAction = 'move-active' | 'already-queued' | 'generate';

export function decideGenerateInBackground(notePath: string, activeJobPath: string | null, backgroundJobPaths: (string | null)[]): GenerateInBackgroundAction {
	if (activeJobPath === notePath) return 'move-active';
	if (backgroundJobPaths.includes(notePath)) return 'already-queued';
	return 'generate';
}
