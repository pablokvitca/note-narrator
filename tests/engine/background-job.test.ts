import { describe, expect, it } from 'vitest';
import { GenerateInBackgroundInput, buildBackgroundJobInfo, decideGenerateInBackground, findBackgroundJobForNote, hasPendingGeneration, queuePosition } from '../../src/engine/background-job';

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

	it('skips jobs with no backing file instead of failing on them', () => {
		const jobs = [job(1, null), job(2, 'a.md')];
		expect(findBackgroundJobForNote(jobs, 'a.md')?.id).toBe(2);
	});
});

describe('decideGenerateInBackground', () => {
	const input = (overrides: Partial<GenerateInBackgroundInput> = {}): GenerateInBackgroundInput => ({
		notePath: 'a.md',
		activePath: null,
		activeKind: 'none',
		activePendingGeneration: false,
		backgroundJobs: [],
		...overrides,
	});

	it('generates when the note is neither being read nor in the background', () => {
		expect(decideGenerateInBackground(input())).toBe('generate');
	});

	it('moves a full read of this note that is still generating', () => {
		expect(decideGenerateInBackground(input({ activePath: 'a.md', activeKind: 'full', activePendingGeneration: true }))).toBe('move-active');
	});

	it('does nothing for a full read of this note that has finished generating', () => {
		expect(decideGenerateInBackground(input({ activePath: 'a.md', activeKind: 'full', activePendingGeneration: false }))).toBe('already-generated');
	});

	it('does nothing while this note plays from saved audio, instead of paying to regenerate it', () => {
		expect(decideGenerateInBackground(input({ activePath: 'a.md', activeKind: 'saved' }))).toBe('playing-saved');
	});

	it('generates the full note alongside a selection read of it, never moving the selection', () => {
		expect(decideGenerateInBackground(input({ activePath: 'a.md', activeKind: 'selection', activePendingGeneration: true }))).toBe('generate');
	});

	it('reports a selection read of a note that is already queued as already queued', () => {
		expect(decideGenerateInBackground(input({ activePath: 'a.md', activeKind: 'selection', backgroundJobs: [{ path: 'a.md', status: 'queued' }] }))).toBe('already-queued');
	});

	it('does nothing new when the note already has a queued or generating background job', () => {
		expect(decideGenerateInBackground(input({ backgroundJobs: [{ path: 'b.md', status: 'generating' }, { path: 'a.md', status: 'queued' }] }))).toBe('already-queued');
		expect(decideGenerateInBackground(input({ backgroundJobs: [{ path: 'a.md', status: 'generating' }] }))).toBe('already-queued');
	});

	it('reports a finished background job as ready rather than queued', () => {
		expect(decideGenerateInBackground(input({ backgroundJobs: [{ path: 'a.md', status: 'done' }] }))).toBe('ready-in-background');
	});

	it('generates while a different note plays from saved audio', () => {
		expect(decideGenerateInBackground(input({ activePath: 'b.md', activeKind: 'saved' }))).toBe('generate');
	});

	it('generates without touching a read of a different note', () => {
		expect(decideGenerateInBackground(input({ activePath: 'b.md', activeKind: 'full', activePendingGeneration: true, backgroundJobs: [{ path: 'c.md', status: 'done' }, { path: null, status: 'queued' }] }))).toBe('generate');
	});
});
