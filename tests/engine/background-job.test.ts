import { describe, expect, it } from 'vitest';
import { buildBackgroundJobInfo, decideGenerateInBackground, findBackgroundJobForNote, hasPendingGeneration, queuePosition } from '../../src/engine/background-job';

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

describe('findBackgroundJobForNote', () => {
	const job = (id: number, path: string | null) => ({ id, file: path === null ? null : { path } });

	it('finds the job whose file matches the note path', () => {
		const jobs = [job(1, 'a.md'), job(2, 'b.md')];
		expect(findBackgroundJobForNote(jobs, 'b.md')?.id).toBe(2);
	});

	it('is undefined when no job is for that note', () => {
		expect(findBackgroundJobForNote([job(1, 'a.md')], 'c.md')).toBeUndefined();
		expect(findBackgroundJobForNote([], 'a.md')).toBeUndefined();
	});

	it('never matches a job with no backing file', () => {
		expect(findBackgroundJobForNote([job(1, null)], '')).toBeUndefined();
	});
});

describe('decideGenerateInBackground', () => {
	it('moves the current read to the background when it is this note', () => {
		expect(decideGenerateInBackground('a.md', 'a.md', [])).toBe('move-active');
	});

	it('prefers moving the current read even if the note somehow also has a background job', () => {
		expect(decideGenerateInBackground('a.md', 'a.md', ['a.md'])).toBe('move-active');
	});

	it('does nothing new when the note already has a background job', () => {
		expect(decideGenerateInBackground('a.md', null, ['b.md', 'a.md'])).toBe('already-queued');
	});

	it('generates when the note is neither being read nor in the background', () => {
		expect(decideGenerateInBackground('a.md', null, [])).toBe('generate');
	});

	it('generates without touching a read of a different note', () => {
		expect(decideGenerateInBackground('a.md', 'b.md', ['c.md', null])).toBe('generate');
	});
});
