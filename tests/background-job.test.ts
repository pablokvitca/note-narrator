import { describe, expect, it } from 'vitest';
import { buildBackgroundJobInfo, hasPendingGeneration, queuePosition } from '../src/background-job';

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
	it('carries the id, file, and status through unchanged', () => {
		const info = buildBackgroundJobInfo(7, null, [true, true], [false, false], 'done');
		expect(info).toEqual({ id: 7, file: null, chunkCount: 2, chunkReady: [true, true], chunkInFlight: [false, false], status: 'done' });
	});

	it('reports chunkCount from the chunkReady array length regardless of status', () => {
		const info = buildBackgroundJobInfo(1, null, [], [], 'queued');
		expect(info.chunkCount).toBe(0);
	});

	it('copies the arrays so later mutation of the source does not affect the snapshot', () => {
		const chunkReady = [true, false];
		const chunkInFlight = [false, true];
		const info = buildBackgroundJobInfo(1, null, chunkReady, chunkInFlight, 'generating');
		chunkReady[1] = true;
		chunkInFlight[1] = false;
		expect(info.chunkReady).toEqual([true, false]);
		expect(info.chunkInFlight).toEqual([false, true]);
	});
});

describe('queuePosition', () => {
	const job = (id: number, status: 'queued' | 'generating' | 'done') => buildBackgroundJobInfo(id, null, [], [], status);

	it('numbers queued jobs 1-based, in list order, ignoring non-queued jobs', () => {
		const jobs = [job(1, 'generating'), job(2, 'queued'), job(3, 'done'), job(4, 'queued')];
		expect(queuePosition(jobs, 2)).toBe(1);
		expect(queuePosition(jobs, 4)).toBe(2);
	});

	it('is 0 for a job that is not queued (or not in the list)', () => {
		const jobs = [job(1, 'generating'), job(2, 'queued')];
		expect(queuePosition(jobs, 1)).toBe(0);
		expect(queuePosition(jobs, 999)).toBe(0);
	});
});
