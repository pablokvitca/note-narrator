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

/** Whether a job still has chunks left to generate -- gates both the "Send to Background" and "Cancel" buttons. */
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
