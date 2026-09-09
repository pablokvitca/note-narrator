import type { TFile } from 'obsidian';
import type { BackgroundJobInfo } from './reader';

/**
 * Pure, Obsidian-independent decision logic for "continue generating in background" (OBS-35), kept out of
 * reader.ts so it's unit-testable without a vault or a mocked Obsidian runtime -- reader.ts and player-view.ts
 * both delegate to this instead of duplicating the same `chunkReady.some(...)` check inline.
 */

/** Whether a job still has chunks left to generate -- gates both the "Continue in background" and "Cancel generation" buttons. */
export function hasPendingGeneration(chunkReady: boolean[]): boolean {
	return chunkReady.some((ready) => !ready);
}

/** Snapshot of a job's progress for the panel's background-job status box. */
export function buildBackgroundJobInfo(file: TFile | null, chunkReady: boolean[], chunkInFlight: boolean[]): BackgroundJobInfo {
	return {
		file,
		chunkCount: chunkReady.length,
		chunkReady: [...chunkReady],
		chunkInFlight: [...chunkInFlight],
		done: chunkReady.length > 0 && chunkReady.every(Boolean),
	};
}
