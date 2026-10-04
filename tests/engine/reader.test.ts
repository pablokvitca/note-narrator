import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownView, TFile } from 'obsidian';
import { Notice } from '../stubs/obsidian';
import { Reader } from '../../src/engine/reader';
import { NoteNarratorSettings } from '../../src/settings/settings';

/**
 * Reader is tested against fakes for everything outside it: the TTS provider (every synthesize() call
 * is recorded and stays pending until the test settles it), saved audio, note text (one chunk per
 * non-empty line, no preamble), and the browser's Audio element. That keeps the background queue and
 * playback hand-offs observable without a vault, network or real audio.
 */

interface SynthCall {
	text: string;
	/** The cancellation check Reader passed in, as the real provider polls it between retries. */
	isCancelled: () => boolean;
	resolve: () => void;
	reject: (error: Error) => void;
}

const fakes = vi.hoisted(() => ({
	synthCalls: [] as SynthCall[],
	/** Fails the pending vault.readBinary() call (Play saved reading its audio file). */
	failReadBinary: null as ((error: Error) => void) | null,
	/** When true, SavedAudio.clearReaderFiles() fails. */
	clearFails: false,
	/** The rate-limit callback Reader handed the most recently created provider (as the real one calls on a 429). */
	reportRateLimit: null as (() => void) | null,
	/** What vault.cachedRead() returns for any note. */
	diskContent: '',
	/** When true, decodeAudioDuration() stays pending until the test releases it (see releaseDecodes()). */
	holdDecodes: false,
	heldDecodes: [] as (() => void)[],
	saveAudioFile: [] as unknown[][],
	narrator: {
		profile: { id: 'p' },
		provider: { parallelGenerationEnabled: true, maxParallelGeneration: 2, maxBackgroundParallelGeneration: 1 },
		voice: { id: 'v' },
		fingerprint: 'f',
	},
}));

vi.mock('../../src/tts/registry', () => ({
	getProviderApiKey: () => 'key',
	missingApiKeyMessage: () => 'No API key.',
	createTTSProvider: (_provider: unknown, _voice: unknown, _apiKey: unknown, onRateLimited?: () => void) => {
		fakes.reportRateLimit = onRateLimited ?? null;
		return {
		synthesize: (text: string, isCancelled: () => boolean = () => false) =>
			new Promise<ArrayBuffer>((resolve, reject) => {
				fakes.synthCalls.push({ text, isCancelled, resolve: () => resolve(new ArrayBuffer(8)), reject });
			}),
		};
	},
}));

vi.mock('../../src/engine/note-text', () => ({
	NoteText: class {
		getActiveNarrator() {
			return fakes.narrator;
		}
		buildPreamble() {
			return '';
		}
		getCharLimit() {
			return 1000;
		}
		getReadingConfig() {
			return { chunkerStyle: 'sentence', maxHeadingDepth: 6 };
		}
		getStripMarkdownOptions() {
			return {};
		}
		getSkipHeadingPatterns() {
			return [];
		}
		buildChunksAndPositions(rawText: string) {
			const chunks = rawText.split('\n').filter((line) => line.length > 0);
			return { chunks, positions: chunks.map(() => ({ span: null, sectionSpan: null, sectionHeadingSpan: null })) };
		}
	},
}));

// Auto-generate on open chunks with chunkNote() directly; one chunk per non-empty line, like the NoteText fake.
vi.mock('../../src/text/text-utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/text/text-utils')>()),
	chunkNote: (text: string) => text.split('\n').filter((line) => line.length > 0),
}));

vi.mock('../../src/engine/saved-audio', () => ({
	SavedAudio: class {
		saveAudioFile(...args: unknown[]) {
			fakes.saveAudioFile.push(args);
			const note = args[1] as { basename: string } | null;
			return Promise.resolve(note ? { path: `audio/${note.basename}.mp3` } : null);
		}
		clearReaderFiles() {
			return fakes.clearFails ? Promise.reject(new Error('cannot trash')) : Promise.resolve();
		}
		getAudioStatus() {
			return Promise.resolve('none');
		}
		stalenessHash(rawContent: string) {
			return `hash of ${rawContent}`;
		}
	},
}));

vi.mock('../../src/engine/audio-utils', () => ({
	decodeAudioDuration: () =>
		fakes.holdDecodes ? new Promise<number>((resolve) => fakes.heldDecodes.push(() => resolve(1))) : Promise.resolve(1),
	sliceIntoChunks: () => null,
}));

class FakeAudio {
	static instances: FakeAudio[] = [];
	paused = true;
	currentTime = 0;
	duration = 1;
	playbackRate = 1;
	volume = 1;
	muted = false;
	private listeners = new Map<string, (() => void)[]>();

	constructor(public src: string) {
		FakeAudio.instances.push(this);
	}

	play(): Promise<void> {
		this.paused = false;
		return Promise.resolve();
	}

	pause(): void {
		this.paused = true;
	}

	addEventListener(name: string, callback: () => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
	}

	removeEventListener(name: string, callback: () => void): void {
		this.listeners.set(name, (this.listeners.get(name) ?? []).filter((c) => c !== callback));
	}

	/** Fires a media event the way the browser would, e.g. 'ended' when the chunk finishes playing. */
	fire(name: string): void {
		for (const callback of this.listeners.get(name) ?? []) callback();
	}
}

/** Test doubles only implement what Reader touches; this is the one place they stand in for the real types. */
function fake<T>(value: object): T {
	return value as T;
}

function makeFile(name: string): TFile {
	return fake<TFile>({ path: `${name}.md`, basename: name, extension: 'md' });
}

/** A Markdown view whose note has `lines` as its body (one chunk per line), optionally with selected text. */
function makeView(file: TFile, lines: string[], selection = ''): MarkdownView {
	return fake<MarkdownView>({ file, editor: { getValue: () => lines.join('\n'), getSelection: () => selection } });
}

function makeReader(settings: Partial<NoteNarratorSettings> = {}): Reader {
	const app = fake<App>({
		workspace: { getActiveViewOfType: () => null },
		metadataCache: { getFileCache: () => ({}) },
		vault: {
			cachedRead: () => Promise.resolve(fakes.diskContent),
			readBinary: () => new Promise<ArrayBuffer>((_resolve, reject) => (fakes.failReadBinary = reject)),
		},
	});
	return new Reader(app, {
		playbackRate: 1,
		autoBackgroundOnSwitch: true,
		startPlaybackImmediately: true,
		readSelectionIfPresent: true,
		saveAudioFile: false,
		...settings,
	} as NoteNarratorSettings);
}

/** Lets every pending promise chain (generation, queue hand-offs, playback start) run to its next real wait. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Lets every held decodeAudioDuration() call finish, and stops holding new ones. */
async function releaseDecodes(): Promise<void> {
	fakes.holdDecodes = false;
	for (const release of fakes.heldDecodes.splice(0)) release();
	await settle();
}

function callsFor(prefix: string): SynthCall[] {
	return fakes.synthCalls.filter((call) => call.text.startsWith(prefix));
}

/** Resolves every pending synthesize() call for chunks starting with `prefix`, repeatedly, until none are left. */
async function finishGenerating(prefix: string): Promise<void> {
	for (let settled = 0; settled < callsFor(prefix).length; ) {
		const pending = callsFor(prefix).slice(settled);
		settled += pending.length;
		for (const call of pending) call.resolve();
		await settle();
	}
}

beforeEach(() => {
	// Reader staggers its worker pool's start with window.setTimeout, and there's no window under Node.
	// Running the callback on the next microtask keeps the order but drops the delay.
	vi.stubGlobal('window', {
		setTimeout: (callback: () => void) => {
			queueMicrotask(callback);
			return 0;
		},
	});
	vi.stubGlobal('Audio', FakeAudio);
	fakes.synthCalls.length = 0;
	fakes.clearFails = false;
	fakes.narrator = { ...fakes.narrator, fingerprint: 'f' };
	fakes.diskContent = '';
	fakes.holdDecodes = false;
	fakes.heldDecodes.length = 0;
	fakes.saveAudioFile.length = 0;
	FakeAudio.instances = [];
	Notice.messages = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Reader.generateNoteInBackground', () => {
	it('starts a background job for the note without playing anything', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		reader.generateNoteInBackground(makeView(a, ['A1', 'A2', 'A3']));
		await settle();

		const state = reader.getState();
		expect(state.status).toBe('idle');
		expect(state.backgroundJobs).toHaveLength(1);
		expect(state.backgroundJobs[0]).toMatchObject({ file: a, status: 'generating', chunkCount: 3 });
		// Background generation uses the background window (1), not the foreground one (2).
		expect(callsFor('A')).toHaveLength(1);
		expect(FakeAudio.instances).toHaveLength(0);
	});

	it('queues a second note behind the one already generating, then starts it once that finishes', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1', 'A2']));
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1', 'B2']));
		await settle();

		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['generating', 'queued']);
		expect(callsFor('B')).toHaveLength(0);

		await finishGenerating('A');

		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done', 'generating']);
		expect(callsFor('B')).toHaveLength(1);
		expect(Notice.messages).toContain('Finished generating "A" in the background.');
	});

	it('does not start a second job for a note that is already in the background', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		reader.generateNoteInBackground(makeView(a, ['A1']));
		reader.generateNoteInBackground(makeView(a, ['A1']));
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(1);
		expect(Notice.messages).toContain('"A" is already in the background queue.');
	});

	it('moves a full read of the same note to the background instead of starting another job', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		const view = makeView(a, ['A1', 'A2', 'A3']);
		void reader.readNote(view);
		await settle();
		expect(reader.getState().status).toBe('generating');

		reader.generateNoteInBackground(view);
		await settle();

		const state = reader.getState();
		expect(state.status).toBe('idle');
		expect(state.backgroundJobs).toHaveLength(1);
		expect(state.backgroundJobs[0]?.file).toBe(a);
	});

	it('leaves a read of a different note playing', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		void reader.readNote(makeView(a, ['A1', 'A2']));
		await settle();

		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1', 'B2']));
		await settle();

		const state = reader.getState();
		expect(state.status).toBe('generating');
		expect(state.activeFile).toBe(a);
		expect(state.backgroundJobs.map((job) => job.file?.basename)).toEqual(['B']);
	});
});

describe('Reader.readNote with a background job for the same note', () => {
	it('adopts the background job and plays it instead of starting over', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		const view = makeView(a, ['A1', 'A2']);
		reader.generateNoteInBackground(view);
		await settle();
		await finishGenerating('A');
		const generatedBefore = callsFor('A').length;

		void reader.readNote(view);
		await settle();

		const state = reader.getState();
		expect(state.backgroundJobs).toHaveLength(0);
		expect(state.activeFile).toBe(a);
		expect(state.status).toBe('playing');
		expect(callsFor('A')).toHaveLength(generatedBefore);
	});
});

describe('Reader.dispose', () => {
	it('cancels and clears every background job', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1']));
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1']));
		await settle();

		reader.dispose();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});
});

describe('Reader selection reads and the background queue', () => {
	it('never moves a selection read to the background', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2'], 'selected one\nselected two'));
		await settle();
		expect(reader.getState().activeReadKind).toBe('selection');

		reader.continueGeneratingInBackground();
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(reader.getState().status).not.toBe('idle');
	});

	it('discards a selection read instead of backgrounding it when another note starts', async () => {
		const reader = makeReader({ autoBackgroundOnSwitch: true });
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2'], 'selected one\nselected two'));
		await settle();

		const b = makeFile('B');
		void reader.readNote(makeView(b, ['B1', 'B2']));
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(reader.getState().activeFile).toBe(b);
	});

	it('keeps the note\'s background job when a selection of the same note is read', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		reader.generateNoteInBackground(makeView(a, ['A1', 'A2']));
		await settle();

		void reader.readNote(makeView(a, ['A1', 'A2'], 'selected'));
		await settle();

		const state = reader.getState();
		expect(state.activeReadKind).toBe('selection');
		expect(state.backgroundJobs.map((job) => job.file)).toEqual([a]);
	});

	it('generates the full note in the background while a selection of it plays', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		void reader.readNote(makeView(a, ['A1', 'A2'], 'selected'));
		await settle();

		reader.generateNoteInBackground(makeView(a, ['A1', 'A2'], 'selected'));
		await settle();

		const state = reader.getState();
		expect(state.activeReadKind).toBe('selection');
		expect(state.backgroundJobs).toHaveLength(1);
		expect(state.backgroundJobs[0]).toMatchObject({ file: a, chunkCount: 2 });
	});

	it('does nothing, with a notice, for a full read of the note that has finished generating', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		const view = makeView(a, ['A1', 'A2']);
		void reader.readNote(view);
		await settle();
		await finishGenerating('A');

		reader.generateNoteInBackground(view);
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(reader.getState().activeFile).toBe(a);
		expect(Notice.messages).toContain('"A" has already finished generating.');
	});
});

describe('Reader with a finished background job', () => {
	it('says the note is ready rather than queued when generating it again', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		const view = makeView(a, ['A1', 'A2']);
		reader.generateNoteInBackground(view);
		await settle();
		await finishGenerating('A');

		reader.generateNoteInBackground(view);
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(1);
		expect(reader.getGenerateInBackgroundAction(a)).toBe('ready-in-background');
		expect(Notice.messages).toContain('"A" has already finished generating in the background.');
	});
});

describe('Reader adopting a background job that has chunks left', () => {
	it('generates ahead at the foreground window when a queued job is adopted', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1', 'B2']));
		const viewA = makeView(makeFile('A'), ['A1', 'A2', 'A3', 'A4']);
		reader.generateNoteInBackground(viewA);
		await settle();
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['generating', 'queued']);
		expect(callsFor('A')).toHaveLength(0);

		void reader.readNote(viewA);
		await settle();

		// Foreground window is 2: chunk 0 for playback plus one ahead, not one chunk at a time on demand.
		expect(callsFor('A').map((call) => call.text)).toEqual(['A1', 'A2']);
	});

	it('generates ahead at the foreground window when the generating job is adopted', async () => {
		const reader = makeReader();
		const viewA = makeView(makeFile('A'), ['A1', 'A2', 'A3', 'A4']);
		reader.generateNoteInBackground(viewA);
		await settle();
		expect(callsFor('A')).toHaveLength(1);

		void reader.readNote(viewA);
		await settle();

		expect(callsFor('A').map((call) => call.text)).toEqual(['A1', 'A2']);
	});
});

describe('Reader moving a read to the background', () => {
	it('stops generating a moved read while it waits in the queue', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1', 'B2']));
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3', 'A4']));
		await settle();
		expect(callsFor('A').map((call) => call.text)).toEqual(['A1', 'A2']);

		reader.continueGeneratingInBackground();
		for (const call of callsFor('A')) call.resolve();
		await settle();

		// Queued behind B: the read's own foreground generation must not keep claiming chunks.
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['generating', 'queued']);
		expect(callsFor('A')).toHaveLength(2);

		await finishGenerating('B');

		// Its turn now, at the background window (1).
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done', 'generating']);
		expect(callsFor('A').map((call) => call.text)).toEqual(['A1', 'A2', 'A3']);
	});

	it('generates a moved read at the background window only', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3', 'A4', 'A5']));
		await settle();
		expect(callsFor('A')).toHaveLength(2);

		reader.continueGeneratingInBackground();
		for (const call of callsFor('A')) call.resolve();
		await settle();

		expect(callsFor('A').map((call) => call.text)).toEqual(['A1', 'A2', 'A3']);
	});

	it('does not finish generating a moved read before its turn in the queue', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1']));
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3']));
		await settle();
		reader.continueGeneratingInBackground();
		await finishGenerating('A');

		const queued = reader.getState().backgroundJobs[1];
		expect(queued).toMatchObject({ status: 'queued' });
		expect(queued?.chunkReady).toEqual([true, true, false]);
	});

	it('marks a queued moved read done as soon as its last in-flight chunks finish, without waiting for its turn', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1', 'B2']));
		const a = makeFile('A');
		void reader.readNote(makeView(a, ['A1', 'A2']));
		await settle();
		// Both of A's chunks are already being generated when it moves behind B.
		reader.continueGeneratingInBackground();
		await settle();
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['generating', 'queued']);

		for (const call of callsFor('A')) call.resolve();
		await settle();

		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([
			['B', 'generating'],
			['A', 'done'],
		]);
		expect(Notice.messages).toContain('Finished generating "A" in the background.');
		expect(reader.getGenerateInBackgroundAction(a)).toBe('ready-in-background');
	});

	it('announces a job finishing only once, even after it was played and moved back to the background', async () => {
		const reader = makeReader();
		const view = makeView(makeFile('A'), ['A1', 'A2']);
		reader.generateNoteInBackground(view);
		await settle();
		void reader.readNote(view);
		await settle();
		reader.continueGeneratingInBackground();
		await settle();

		await finishGenerating('A');

		expect(Notice.messages.filter((message) => message === 'Finished generating "A" in the background.')).toHaveLength(1);
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done']);
	});

	it('reports a job discarded mid-generation as failed, not done', async () => {
		const results: Promise<string>[] = [];
		const prototype = Reader.prototype as unknown as { runGenerationWorkerPool: (...args: unknown[]) => Promise<string> };
		const original = prototype.runGenerationWorkerPool;
		const spy = vi.spyOn(prototype, 'runGenerationWorkerPool').mockImplementation(function (this: unknown, ...args: unknown[]) {
			const result = original.apply(this, args);
			results.push(result);
			return result;
		});
		try {
			const reader = makeReader();
			reader.generateNoteInBackground(makeView(makeFile('A'), ['A1', 'A2']));
			await settle();

			reader.discardBackgroundJob(reader.getState().backgroundJobs[0]?.id ?? -1);
			callsFor('A')[0]?.resolve();
			await settle();

			expect(await Promise.all(results)).toEqual(['failed']);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('Reader handing a job over while chunks are still being decoded', () => {
	it('still marks a moved read done, and starts the next job, once its last chunks finish decoding', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();

		// Both chunks are synthesized, but neither has finished decoding when the read moves to the background.
		fakes.holdDecodes = true;
		for (const call of callsFor('A')) call.resolve();
		await settle();
		reader.continueGeneratingInBackground();
		await settle();
		reader.generateNoteInBackground(makeView(makeFile('C'), ['C1']));
		await settle();

		await releaseDecodes();

		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([
			['A', 'done'],
			['C', 'generating'],
		]);
		expect(callsFor('C')).toHaveLength(1);
	});
});

describe('Reader saving generated audio', () => {
	it('marks saved audio with the text it was generated from, not the note as edited since', async () => {
		const reader = makeReader({ saveAudioFile: true });
		const lines = ['A1', 'A2'];
		const view = fake<MarkdownView>({ file: makeFile('A'), editor: { getValue: () => lines.join('\n'), getSelection: () => '' } });
		reader.generateNoteInBackground(view);
		await settle();

		lines.push('A3 added while generating');
		await finishGenerating('A');

		expect(fakes.saveAudioFile).toHaveLength(1);
		expect(fakes.saveAudioFile[0]?.[4]).toBe('hash of A1\nA2');
	});

	it('marks a played read\'s saved audio with the text it started from', async () => {
		const reader = makeReader({ saveAudioFile: true });
		const lines = ['A1', 'A2'];
		const view = fake<MarkdownView>({ file: makeFile('A'), editor: { getValue: () => lines.join('\n'), getSelection: () => '' } });
		void reader.readNote(view);
		await settle();

		lines.push('A3 added while generating');
		await finishGenerating('A');

		expect(fakes.saveAudioFile[0]?.[4]).toBe('hash of A1\nA2');
	});

	it('never saves a selection read', async () => {
		const reader = makeReader({ saveAudioFile: true });
		void reader.readNote(makeView(makeFile('A'), ['A1'], 'selected'));
		await settle();
		await finishGenerating('selected');

		expect(fakes.saveAudioFile).toHaveLength(0);
	});
});

describe('Reader auto-generating on open', () => {
	it('marks the saved audio with the text it read at the start, even if the note changes meanwhile', async () => {
		const reader = makeReader({ saveAudioFile: true, linkAudioInNote: true, autoGenerateOnOpen: true });
		fakes.diskContent = 'A1\nA2';
		const done = reader.autoGenerateIfNeeded(makeFile('A'));
		await settle();

		fakes.diskContent = 'A1\nA2\nA3 added while generating';
		await finishGenerating('A');
		await done;

		expect(fakes.saveAudioFile).toHaveLength(1);
		expect(fakes.saveAudioFile[0]?.[4]).toBe('hash of A1\nA2');
	});
});

describe('Reader playing a background job while another note is being read', () => {
	it('moves the current read to the background when a background job\'s card is played', async () => {
		const reader = makeReader({ autoBackgroundOnSwitch: true });
		const b = makeFile('B');
		reader.generateNoteInBackground(makeView(b, ['B1', 'B2']));
		await settle();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3']));
		await settle();
		const bJob = reader.getState().backgroundJobs[0];

		reader.playBackgroundJob(bJob?.id ?? -1);
		await settle();

		const state = reader.getState();
		expect(state.activeFile).toBe(b);
		expect(state.backgroundJobs.map((job) => job.file?.basename)).toEqual(['A']);
	});

	it('moves the current read to the background when Read adopts another note\'s background job', async () => {
		const reader = makeReader({ autoBackgroundOnSwitch: true });
		const b = makeFile('B');
		const viewB = makeView(b, ['B1', 'B2']);
		reader.generateNoteInBackground(viewB);
		await settle();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3']));
		await settle();

		void reader.readNote(viewB);
		await settle();

		expect(reader.getState().activeFile).toBe(b);
		expect(reader.getState().backgroundJobs.map((job) => job.file?.basename)).toEqual(['A']);
	});

	it('keeps queue order: the next queued job starts before the read that was moved aside', async () => {
		const reader = makeReader({ autoBackgroundOnSwitch: true });
		reader.generateNoteInBackground(makeView(makeFile('G'), ['G1', 'G2']));
		reader.generateNoteInBackground(makeView(makeFile('K'), ['K1', 'K2']));
		await settle();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3']));
		await settle();
		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([
			['G', 'generating'],
			['K', 'queued'],
		]);

		// Play the generating job: it leaves the queue, freeing the generating slot.
		reader.playBackgroundJob(reader.getState().backgroundJobs[0]?.id ?? -1);
		await settle();

		expect(reader.getState().activeFile?.basename).toBe('G');
		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([
			['K', 'generating'],
			['A', 'queued'],
		]);
	});

	it('still discards the current read when "Keep generating when starting another note" is off', async () => {
		const reader = makeReader({ autoBackgroundOnSwitch: false });
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1']));
		await settle();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();

		reader.playBackgroundJob(reader.getState().backgroundJobs[0]?.id ?? -1);
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});
});

describe('Reader with a background job that no longer matches the note', () => {
	function editableView(name: string, lines: string[]) {
		const file = makeFile(name);
		return { file, lines, view: fake<MarkdownView>({ file, editor: { getValue: () => lines.join('\n'), getSelection: () => '' } }) };
	}

	it('Read generates the edited note afresh instead of playing the old background job', async () => {
		const reader = makeReader();
		const a = editableView('A', ['A1', 'A2']);
		reader.generateNoteInBackground(a.view);
		await settle();
		await finishGenerating('A');

		a.lines.push('A3');
		void reader.readNote(a.view);
		await settle();

		const state = reader.getState();
		expect(state.backgroundJobs).toHaveLength(0);
		expect(state.activeFile).toBe(a.file);
		expect(state.chunkCount).toBe(3);
		expect(callsFor('A').map((call) => call.text)).toEqual(['A1', 'A2', 'A1', 'A2']);
	});

	it('Read generates afresh after the narrator changed', async () => {
		const reader = makeReader();
		const a = editableView('A', ['A1', 'A2']);
		reader.generateNoteInBackground(a.view);
		await settle();
		await finishGenerating('A');

		// A new object, like a real narrator change (resolved fresh), rather than mutating the job's own copy.
		fakes.narrator = { ...fakes.narrator, fingerprint: 'another narrator' };
		void reader.readNote(a.view);
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(callsFor('A')).toHaveLength(4);
	});

	it('Read still plays the background job when the note is unchanged', async () => {
		const reader = makeReader();
		const a = editableView('A', ['A1', 'A2']);
		reader.generateNoteInBackground(a.view);
		await settle();
		await finishGenerating('A');

		void reader.readNote(a.view);
		await settle();

		expect(callsFor('A')).toHaveLength(2);
		expect(reader.getState().status).toBe('playing');
	});

	it('offers Generate in background again, and replaces the old job, once the note is edited', async () => {
		const reader = makeReader();
		const a = editableView('A', ['A1', 'A2']);
		reader.generateNoteInBackground(a.view);
		await settle();
		await finishGenerating('A');
		expect(reader.getGenerateInBackgroundAction(a.file, a.lines.join('\n'))).toBe('ready-in-background');

		a.lines.push('A3');
		expect(reader.getGenerateInBackgroundAction(a.file, a.lines.join('\n'))).toBe('generate');

		reader.generateNoteInBackground(a.view);
		await settle();

		const jobs = reader.getState().backgroundJobs;
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ status: 'generating', chunkCount: 3 });
	});
});

describe('Reader when generation fails', () => {
	it('drops a failed background job with a notice and starts the next one', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1', 'A2']));
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1']));
		await settle();

		callsFor('A')[0]?.reject(new Error('boom'));
		await settle();

		expect(Notice.messages).toContain('Failed to generate audio for "A": boom');
		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([['B', 'generating']]);
		expect(callsFor('B')).toHaveLength(1);
	});

	it('stops a read whose generation fails, with a single notice', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();

		callsFor('A')[0]?.reject(new Error('boom'));
		await settle();

		expect(reader.getState().status).toBe('idle');
		expect(Notice.messages.filter((message) => message.includes('boom'))).toHaveLength(1);
	});
});

describe('Reader.discardBackgroundJob', () => {
	it('cancels the generating job and starts the next queued one', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1', 'A2']));
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1']));
		await settle();

		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]?.id ?? -1);
		await settle();

		expect(callsFor('A')[0]?.isCancelled()).toBe(true);
		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([['B', 'generating']]);
		expect(callsFor('B')).toHaveLength(1);

		// The cancelled request finishing late doesn't bring A back or generate more of it.
		callsFor('A')[0]?.resolve();
		await settle();
		expect(reader.getState().backgroundJobs.map((job) => job.file?.basename)).toEqual(['B']);
		expect(callsFor('A')).toHaveLength(1);
	});

	it('removes a queued job without disturbing the one generating', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1']));
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1']));
		await settle();

		reader.discardBackgroundJob(reader.getState().backgroundJobs[1]?.id ?? -1);
		await settle();

		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([['A', 'generating']]);
		expect(callsFor('A')[0]?.isCancelled()).toBe(false);
		expect(callsFor('B')).toHaveLength(0);
	});

	it('clears a finished job', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1']));
		await settle();
		await finishGenerating('A');

		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]?.id ?? -1);

		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});
});

describe('Reader with "Start playback immediately" off', () => {
	it('waits for the whole note to generate before playing', async () => {
		const reader = makeReader({ startPlaybackImmediately: false });
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3']));
		await settle();

		callsFor('A')[0]?.resolve();
		await settle();
		expect(FakeAudio.instances).toHaveLength(0);
		expect(reader.getState().status).toBe('generating');

		await finishGenerating('A');

		expect(FakeAudio.instances).toHaveLength(1);
		expect(reader.getState().status).toBe('playing');
	});
});

describe('Reader.dispose with generation still in flight', () => {
	it('cancels it and ignores requests that finish afterwards', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1', 'A2']));
		reader.generateNoteInBackground(makeView(makeFile('B'), ['B1']));
		await settle();

		reader.dispose();
		expect(callsFor('A')[0]?.isCancelled()).toBe(true);

		await finishGenerating('A');

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(callsFor('A')).toHaveLength(1);
		expect(callsFor('B')).toHaveLength(0);
		expect(Notice.messages.some((message) => message.startsWith('Finished generating'))).toBe(false);
	});
});

describe('Reader when a background job\'s files are deleted', () => {
	async function finishedJobWithSavedAudio(reader: Reader, name: string): Promise<void> {
		reader.generateNoteInBackground(makeView(makeFile(name), [`${name}1`]));
		await settle();
		await finishGenerating(name);
	}

	it('drops a finished job once its saved audio file is deleted', async () => {
		const reader = makeReader({ saveAudioFile: true });
		await finishedJobWithSavedAudio(reader, 'A');
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done']);

		reader.handleFileDeleted('audio/A.mp3');

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(reader.getGenerateInBackgroundAction(makeFile('A'))).toBe('generate');
	});

	it('drops a job once its note is deleted', async () => {
		const reader = makeReader();
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1']));
		await settle();

		reader.handleFileDeleted('A.md');

		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});

	it('keeps jobs when an unrelated file is deleted', async () => {
		const reader = makeReader({ saveAudioFile: true });
		await finishedJobWithSavedAudio(reader, 'A');

		reader.handleFileDeleted('audio/B.mp3');
		reader.handleFileDeleted('B.md');

		expect(reader.getState().backgroundJobs).toHaveLength(1);
	});

	it('follows the saved audio when it is moved, so deleting it from its new place still drops the job', async () => {
		const reader = makeReader({ saveAudioFile: true });
		await finishedJobWithSavedAudio(reader, 'A');

		reader.handleFileRenamed('archive/A.mp3', 'audio/A.mp3');
		expect(reader.getState().backgroundJobs).toHaveLength(1);

		reader.handleFileDeleted('audio/A.mp3');
		expect(reader.getState().backgroundJobs).toHaveLength(1);
		reader.handleFileDeleted('archive/A.mp3');
		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});

	it('keeps a job when its note is renamed or moved', async () => {
		const reader = makeReader({ saveAudioFile: true });
		await finishedJobWithSavedAudio(reader, 'A');

		reader.handleFileRenamed('Archive/A.md', 'A.md');

		expect(reader.getState().backgroundJobs).toHaveLength(1);
	});

	it('keeps the finished card, and says so, when clearing the note\'s files fails', async () => {
		const reader = makeReader({ saveAudioFile: true });
		await finishedJobWithSavedAudio(reader, 'A');
		fakes.clearFails = true;

		await reader.clearReaderFiles(makeFile('A'));

		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done']);
		expect(Notice.messages).toContain('Failed to clear Note Narrator files: cannot trash');
	});

	it('keeps a job that is still generating when the note\'s Note Narrator files are cleared', async () => {
		const reader = makeReader({ saveAudioFile: true });
		reader.generateNoteInBackground(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();

		await reader.clearReaderFiles(makeFile('A'));

		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['generating']);
		expect(callsFor('A')[0]?.isCancelled()).toBe(false);
	});

	it('drops the note\'s job when its Note Narrator files are cleared', async () => {
		const reader = makeReader({ saveAudioFile: true });
		await finishedJobWithSavedAudio(reader, 'A');

		await reader.clearReaderFiles(makeFile('A'));

		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});
});

describe('Reader pausing while the chunk to play is still generating', () => {
	it('stays paused when the chunk arrives, then plays it on resume', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();
		expect(reader.getState().status).toBe('generating');

		reader.pause();
		expect(reader.getState().status).toBe('paused');

		callsFor('A')[0]?.resolve();
		await settle();

		expect(reader.getState().status).toBe('paused');
		expect(FakeAudio.instances).toHaveLength(1);
		expect(FakeAudio.instances[0]?.paused).toBe(true);

		reader.resume();

		expect(reader.getState().status).toBe('playing');
		expect(FakeAudio.instances[0]?.paused).toBe(false);
	});

	it('stays paused when paused in the gap between chunks', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2', 'A3']));
		await settle();
		callsFor('A')[0]?.resolve();
		await settle();
		expect(reader.getState().status).toBe('playing');

		// The first chunk ends before the second has finished generating.
		FakeAudio.instances[0]?.fire('ended');
		await settle();
		expect(reader.getState().status).toBe('generating');
		reader.pause();

		callsFor('A')[1]?.resolve();
		await settle();

		expect(reader.getState()).toMatchObject({ status: 'paused', chunkIndex: 1 });
		expect(FakeAudio.instances[1]?.paused).toBe(true);
	});

	it('plays as normal if resumed before the chunk arrives', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();

		reader.pause();
		reader.resume();
		expect(reader.getState().status).toBe('generating');

		callsFor('A')[0]?.resolve();
		await settle();

		expect(reader.getState().status).toBe('playing');
		expect(FakeAudio.instances[0]?.paused).toBe(false);
	});

	it('forgets a pending pause when the read fails, so Resume can\'t revive it', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();
		reader.pause();

		callsFor('A')[0]?.reject(new Error('boom'));
		await settle();
		expect(reader.getState().status).toBe('idle');

		reader.resume();
		expect(reader.getState().status).toBe('idle');

		// Nor does it carry into the next read.
		void reader.readNote(makeView(makeFile('B'), ['B1']));
		await settle();
		callsFor('B')[0]?.resolve();
		await settle();
		expect(reader.getState().status).toBe('playing');
	});

	it('forgets a pending pause once the read stops', async () => {
		const reader = makeReader();
		const view = makeView(makeFile('A'), ['A1']);
		void reader.readNote(view);
		await settle();
		reader.pause();
		reader.stop();

		void reader.readNote(makeView(makeFile('B'), ['B1']));
		await settle();
		callsFor('B')[0]?.resolve();
		await settle();

		expect(reader.getState().status).toBe('playing');
	});
});

describe('Reader with a rate-limited job changing hands', () => {
	it('keeps generating one chunk at a time after moving to the background and back', async () => {
		const reader = makeReader();
		const view = makeView(makeFile('A'), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
		void reader.readNote(view);
		await settle();
		expect(callsFor('A')).toHaveLength(2);

		// A 429: the provider reports it, and the job falls back to one chunk at a time from here on.
		fakes.reportRateLimit?.();
		const settled = new Set<SynthCall>();
		const waiting = () => callsFor('A').filter((call) => !settled.has(call));
		const resolveWaiting = async () => {
			for (const call of waiting()) {
				settled.add(call);
				call.resolve();
			}
			await settle();
		};

		reader.continueGeneratingInBackground();
		await resolveWaiting();
		expect(waiting()).toHaveLength(1);

		// Adopted back at the foreground window (2), but still rate-limited.
		void reader.readNote(view);
		await settle();
		expect(waiting()).toHaveLength(1);

		await resolveWaiting();
		expect(waiting()).toHaveLength(1);
	});
});

describe('Reader with a pending pause when the read moves to the background', () => {
	it('forgets the pending pause when the read moves to the background', async () => {
		const reader = makeReader();
		void reader.readNote(makeView(makeFile('A'), ['A1', 'A2']));
		await settle();
		reader.pause();

		reader.continueGeneratingInBackground();
		expect(reader.getState().status).toBe('idle');

		void reader.readNote(makeView(makeFile('B'), ['B1']));
		await settle();
		callsFor('B')[0]?.resolve();
		await settle();
		expect(reader.getState().status).toBe('playing');
	});
});

describe('Reader replacing a stale job while another note is being read', () => {
	it('keeps queue order: the next queued job starts, then the read moved aside', async () => {
		const reader = makeReader({ autoBackgroundOnSwitch: true });
		const linesA = ['A1', 'A2'];
		const viewA = fake<MarkdownView>({ file: makeFile('A'), editor: { getValue: () => linesA.join('\n'), getSelection: () => '' } });
		reader.generateNoteInBackground(viewA);
		reader.generateNoteInBackground(makeView(makeFile('K'), ['K1', 'K2']));
		void reader.readNote(makeView(makeFile('B'), ['B1', 'B2', 'B3']));
		await settle();
		const staleCall = callsFor('A')[0];

		// A's background job (generating) goes stale, then Read on A replaces it while B is being read.
		linesA.push('A3');
		void reader.readNote(viewA);
		await settle();

		expect(staleCall?.isCancelled()).toBe(true);
		expect(reader.getState().activeFile?.basename).toBe('A');
		expect(reader.getState().chunkCount).toBe(3);
		expect(reader.getState().backgroundJobs.map((job) => [job.file?.basename, job.status])).toEqual([
			['K', 'generating'],
			['B', 'queued'],
		]);
	});
});

describe('Reader deciding without the note\'s current text (no live editor)', () => {
	it('can only tell a job is stale from a narrator change, not from edits', async () => {
		const reader = makeReader();
		const a = makeFile('A');
		const lines = ['A1', 'A2'];
		reader.generateNoteInBackground(fake<MarkdownView>({ file: a, editor: { getValue: () => lines.join('\n'), getSelection: () => '' } }));
		await settle();
		await finishGenerating('A');

		lines.push('A3');
		expect(reader.getGenerateInBackgroundAction(a)).toBe('ready-in-background');
		expect(reader.getGenerateInBackgroundAction(a, lines.join('\n'))).toBe('generate');

		fakes.narrator = { ...fakes.narrator, fingerprint: 'another narrator' };
		expect(reader.getGenerateInBackgroundAction(a)).toBe('generate');
	});
});

describe('Reader when Play saved fails after another read has started', () => {
	it('leaves the newer read alone', async () => {
		const reader = makeReader();
		void reader.playSavedFile(makeFile('A audio'), makeFile('A'));
		await settle();

		void reader.readNote(makeView(makeFile('B'), ['B1', 'B2']));
		await settle();
		reader.pause();
		expect(reader.getState()).toMatchObject({ status: 'paused', activeFile: { basename: 'B' } });

		// The saved file can't be read (e.g. deleted meanwhile), long after B started.
		fakes.failReadBinary?.(new Error('missing'));
		await settle();

		expect(reader.getState()).toMatchObject({ status: 'paused', activeFile: { basename: 'B' } });
		callsFor('B')[0]?.resolve();
		await settle();
		// B's pending pause survived, so its first chunk arrives paused.
		expect(reader.getState().status).toBe('paused');
	});
});
