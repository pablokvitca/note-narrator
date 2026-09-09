import { describe, expect, it } from 'vitest';
import { buildBackgroundJobInfo, hasPendingGeneration } from './background-job';

describe('hasPendingGeneration', () => {
	it('is false for an empty chunk list', () => {
		expect(hasPendingGeneration([])).toBe(false);
	});

	it('is false once every chunk is ready', () => {
		expect(hasPendingGeneration([true, true, true])).toBe(false);
	});

	it('is true while any chunk is still not ready', () => {
		expect(hasPendingGeneration([true, false, true])).toBe(true);
	});
});

describe('buildBackgroundJobInfo', () => {
	it('reports done once every chunk is ready', () => {
		const info = buildBackgroundJobInfo(null, [true, true], [false, false]);
		expect(info).toEqual({ file: null, chunkCount: 2, chunkReady: [true, true], chunkInFlight: [false, false], done: true });
	});

	it('reports not done while any chunk is pending', () => {
		const info = buildBackgroundJobInfo(null, [true, false], [false, true]);
		expect(info.done).toBe(false);
	});

	it('treats an empty read as not done (nothing to be done)', () => {
		const info = buildBackgroundJobInfo(null, [], []);
		expect(info.done).toBe(false);
		expect(info.chunkCount).toBe(0);
	});

	it('copies the arrays so later mutation of the source does not affect the snapshot', () => {
		const chunkReady = [true, false];
		const chunkInFlight = [false, true];
		const info = buildBackgroundJobInfo(null, chunkReady, chunkInFlight);
		chunkReady[1] = true;
		chunkInFlight[1] = false;
		expect(info.chunkReady).toEqual([true, false]);
		expect(info.chunkInFlight).toEqual([false, true]);
	});
});
