import { beforeEach, describe, expect, it } from 'vitest';
import type { TFile } from 'obsidian';
import { Notice } from '../stubs/obsidian';
import { BackgroundQueue } from '../../src/engine/background-queue';
import { BackgroundJobInfo } from '../../src/engine/background-job';
import { GenerationJob, PoolResult } from '../../src/engine/reader-types';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from '../../src/settings/settings';

/** Test doubles only implement what BackgroundQueue touches; this is the one place they stand in for the real types. */
function fake<T>(value: object): T {
	return value as T;
}

let nextId = 0;

/** A job for `<name>.md` with `chunks` chunks, none generated yet. */
function makeJob(name: string, chunks = 2): GenerationJob {
	return fake<GenerationJob>({
		id: nextId++,
		file: fake<TFile>({ path: `${name}.md`, basename: name }),
		chunks: new Array<string>(chunks).fill('text'),
		chunkBuffers: new Array<ArrayBuffer | undefined>(chunks),
		chunkPromises: new Array<Promise<ArrayBuffer> | undefined>(chunks),
		chunkReady: new Array<boolean>(chunks).fill(false),
		chunkInFlight: new Array<boolean>(chunks).fill(false),
		narrator: { provider: { maxBackgroundParallelGeneration: 1 } },
		noteDeleted: false,
		savedAudioPath: null,
		saving: false,
		audioFreed: false,
		poolToken: 0,
		cancelled: false,
		backgroundStatus: 'queued',
	});
}

/** Marks every chunk generated, with an 8-byte buffer each. */
function generateAll(job: GenerationJob): void {
	job.chunkReady.fill(true);
	job.chunkBuffers = job.chunkReady.map(() => new ArrayBuffer(8));
}

/** A host whose worker pools stay running until a test finishes them with finishPool(). */
function makeQueue(settings: Partial<NoteNarratorSettings> = {}) {
	const pools: { job: GenerationJob; finish: (result: PoolResult) => void }[] = [];
	let published: BackgroundJobInfo[] = [];
	const staleJobs = new Set<GenerationJob>();
	const queue = new BackgroundQueue({ ...DEFAULT_SETTINGS, ...settings }, {
		runWorkerPool: (job) => new Promise<PoolResult>((resolve) => pools.push({ job, finish: resolve })),
		publish: (jobs) => {
			published = jobs;
		},
		isStale: (job) => staleJobs.has(job),
	});
	/** Generates the job's chunks and ends its pool with `result`. */
	const finishPool = async (job: GenerationJob, result: PoolResult = 'done') => {
		const pool = pools.find((p) => p.job === job);
		if (!pool) throw new Error(`no pool running for ${job.file?.basename}`);
		if (result === 'done') generateAll(job);
		pool.finish(result);
		await Promise.resolve();
		await Promise.resolve();
	};
	return { queue, pools, finishPool, staleJobs, statuses: () => published.map((job) => `${job.file?.basename}:${job.status}`) };
}

beforeEach(() => {
	Notice.messages = [];
});

describe('BackgroundQueue', () => {
	it('generates jobs one at a time, in the order they were added', async () => {
		const { queue, pools, finishPool, statuses } = makeQueue();
		const [a, b, c] = [makeJob('A'), makeJob('B'), makeJob('C')];
		queue.enqueue(a);
		queue.enqueue(b);
		queue.enqueue(c);

		expect(statuses()).toEqual(['A:generating', 'B:queued', 'C:queued']);
		expect(pools.map((pool) => pool.job)).toEqual([a]);

		await finishPool(a);

		expect(statuses()).toEqual(['A:done', 'B:generating', 'C:queued']);
		expect(pools.map((pool) => pool.job)).toEqual([a, b]);
		expect(Notice.messages).toEqual(['Finished generating "A" in the background.']);
	});

	it('retires the pool that drove a job before it was enqueued', () => {
		const { queue } = makeQueue();
		const job = makeJob('A');
		queue.enqueue(job);
		// The queue's own pool takes the next token when it starts; enqueuing bumps it first.
		expect(job.poolToken).toBe(1);
	});

	it('starts the next job when the generating one is taken out to play', () => {
		const { queue, pools, statuses } = makeQueue();
		const [a, b] = [makeJob('A'), makeJob('B')];
		queue.enqueue(a);
		queue.enqueue(b);

		queue.take(a);

		expect(statuses()).toEqual(['B:generating']);
		expect(pools.map((pool) => pool.job)).toEqual([a, b]);
		expect(a.cancelled).toBe(false);
	});

	it('leaves the generating job alone when a queued or finished one is taken out to play', async () => {
		const { queue, pools, finishPool, statuses } = makeQueue();
		const [a, b, c] = [makeJob('A'), makeJob('B'), makeJob('C')];
		queue.enqueue(a);
		await finishPool(a);
		queue.enqueue(b);
		queue.enqueue(c);
		expect(statuses()).toEqual(['A:done', 'B:generating', 'C:queued']);

		queue.take(a);
		queue.take(c);

		expect(statuses()).toEqual(['B:generating']);
		expect(pools.map((pool) => pool.job)).toEqual([a, b]);
	});

	it('leaves the generating job alone when a queued one is discarded', () => {
		const { queue, pools, statuses } = makeQueue();
		const [a, b] = [makeJob('A'), makeJob('B')];
		queue.enqueue(a);
		queue.enqueue(b);

		queue.discard(b.id);

		expect(b.cancelled).toBe(true);
		expect(statuses()).toEqual(['A:generating']);
		expect(pools).toHaveLength(1);
	});

	it('does nothing when a superseded pool ends: the job\'s new owner finishes it', async () => {
		const { queue, finishPool, statuses } = makeQueue();
		const job = makeJob('A');
		queue.enqueue(job);

		await finishPool(job, 'superseded');

		expect(statuses()).toEqual(['A:generating']);
		expect(Notice.messages).toEqual([]);
	});

	it('finishes a queued job as soon as its last chunks arrive, without waiting for its turn', () => {
		const { queue, statuses } = makeQueue();
		const [a, b] = [makeJob('A'), makeJob('B')];
		queue.enqueue(a);
		queue.enqueue(b);

		generateAll(b);
		queue.onProgress(b);

		expect(statuses()).toEqual(['A:generating', 'B:done']);
	});

	it('discards a note\'s job only when it\'s stale', () => {
		const { queue, staleJobs, statuses } = makeQueue();
		const job = makeJob('A');
		queue.enqueue(job);

		queue.discardIfStale(job.file!, 'text');
		expect(statuses()).toEqual(['A:generating']);

		staleJobs.add(job);
		queue.discardIfStale(job.file!, 'text');
		expect(statuses()).toEqual([]);
	});

	describe('a finished job\'s audio', () => {
		it('is freed from memory once the job is both finished and saved, in either order', async () => {
			const { queue, finishPool } = makeQueue();
			const [a, b] = [makeJob('A'), makeJob('B')];
			queue.enqueue(a);
			queue.enqueue(b);

			// A: finished, then saved.
			await finishPool(a);
			expect(a.audioFreed).toBe(false);
			a.savedAudioPath = 'A.mp3';
			queue.onSaved(a);
			expect(a.audioFreed).toBe(true);
			expect(a.chunkBuffers).toEqual([undefined, undefined]);

			// B: saved, then finished.
			b.savedAudioPath = 'B.mp3';
			queue.onSaved(b);
			expect(b.audioFreed).toBe(false);
			await finishPool(b);
			expect(b.audioFreed).toBe(true);
		});

		it('stays in memory for a job taken out of the list to play', async () => {
			const { queue, finishPool } = makeQueue();
			const job = makeJob('A');
			queue.enqueue(job);
			await finishPool(job);
			queue.take(job);

			job.savedAudioPath = 'A.mp3';
			queue.onSaved(job);

			expect(job.audioFreed).toBe(false);
		});
	});

	describe('the limit on unsaved finished jobs', () => {
		it('clears the oldest unsaved finished job beyond the limit, with a notice', async () => {
			const { queue, finishPool, statuses } = makeQueue({ maxUnsavedBackgroundJobs: 1 });
			const [a, b] = [makeJob('A'), makeJob('B')];
			queue.enqueue(a);
			queue.enqueue(b);
			await finishPool(a);
			await finishPool(b);

			expect(statuses()).toEqual(['B:done']);
			expect(a.cancelled).toBe(true);
			expect(Notice.messages.at(-1)).toBe('Cleared "A" from the background list, since its audio wasn\'t saved. Up to 1 unsaved notes are kept (see the Performance settings).');
		});

		it('counts a job once its save fails, not while it is saving', async () => {
			const { queue, finishPool, statuses } = makeQueue({ maxUnsavedBackgroundJobs: 1 });
			const [a, b] = [makeJob('A'), makeJob('B')];
			a.saving = true;
			b.saving = true;
			queue.enqueue(a);
			queue.enqueue(b);
			await finishPool(a);
			await finishPool(b);
			expect(statuses()).toEqual(['A:done', 'B:done']);

			b.saving = false;
			queue.onSaved(b);
			expect(statuses()).toEqual(['A:done', 'B:done']);

			a.saving = false;
			queue.onSaved(a);
			expect(statuses()).toEqual(['B:done']);
		});

		it('ignores an invalid limit, keeping every job', async () => {
			const { queue, finishPool, statuses } = makeQueue({ maxUnsavedBackgroundJobs: Number.NaN });
			const [a, b] = [makeJob('A'), makeJob('B')];
			queue.enqueue(a);
			queue.enqueue(b);
			await finishPool(a);
			await finishPool(b);

			expect(statuses()).toEqual(['A:done', 'B:done']);
		});
	});

	describe('files deleted or renamed', () => {
		it('marks and drops the job of a deleted note, and the job whose saved audio was deleted', () => {
			const { queue, statuses } = makeQueue();
			const [a, b, c] = [makeJob('A'), makeJob('B'), makeJob('C')];
			b.savedAudioPath = 'B.mp3';
			queue.enqueue(a);
			queue.enqueue(b);
			queue.enqueue(c);

			queue.handleFileDeleted('A.md');
			queue.handleFileDeleted('B.mp3');

			expect(a.noteDeleted).toBe(true);
			expect(b.noteDeleted).toBe(false);
			expect(statuses()).toEqual(['C:generating']);
		});

		it('follows saved audio that moves, so deleting it from its new place still drops the job', () => {
			const { queue, statuses } = makeQueue();
			const job = makeJob('A');
			job.savedAudioPath = 'A.mp3';
			queue.enqueue(job);

			queue.handleFileRenamed('Audio/A.mp3', 'A.mp3');
			queue.handleFileDeleted('Audio/A.mp3');

			expect(statuses()).toEqual([]);
		});
	});

	it('cancels and clears every job when disposed', () => {
		const { queue, statuses } = makeQueue();
		const [a, b] = [makeJob('A'), makeJob('B')];
		queue.enqueue(a);
		queue.enqueue(b);

		queue.dispose();

		expect(statuses()).toEqual([]);
		expect([a.cancelled, b.cancelled]).toEqual([true, true]);
	});
});
