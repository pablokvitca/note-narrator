import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownView } from 'obsidian';
import { Notice, TFile } from '../stubs/obsidian';
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
	resolve: () => void;
	reject: (error: Error) => void;
}

const fakes = vi.hoisted(() => ({
	synthCalls: [] as SynthCall[],
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
	createTTSProvider: () => ({
		synthesize: (text: string) =>
			new Promise<ArrayBuffer>((resolve, reject) => {
				fakes.synthCalls.push({ text, resolve: () => resolve(new ArrayBuffer(8)), reject });
			}),
	}),
}));

vi.mock('../../src/engine/note-text', () => ({
	NoteText: class {
		getActiveNarrator() {
			return fakes.narrator;
		}
		buildPreamble() {
			return '';
		}
		buildChunksAndPositions(rawText: string) {
			const chunks = rawText.split('\n').filter((line) => line.length > 0);
			return { chunks, positions: chunks.map(() => ({ span: null, sectionSpan: null, sectionHeadingSpan: null })) };
		}
	},
}));

vi.mock('../../src/engine/saved-audio', () => ({
	SavedAudio: class {
		saveAudioFile(...args: unknown[]) {
			fakes.saveAudioFile.push(args);
			return Promise.resolve();
		}
		getAudioStatus() {
			return Promise.resolve('none');
		}
	},
}));

vi.mock('../../src/engine/audio-utils', () => ({
	decodeAudioDuration: () => Promise.resolve(1),
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
}

function makeFile(name: string): TFile {
	const file = new TFile();
	file.path = `${name}.md`;
	file.basename = name;
	return file;
}

/** A Markdown view whose note has `lines` as its body (one chunk per line), optionally with selected text. */
function makeView(file: TFile, lines: string[], selection = ''): MarkdownView {
	return { file, editor: { getValue: () => lines.join('\n'), getSelection: () => selection } } as unknown as MarkdownView;
}

function makeReader(settings: Partial<NoteNarratorSettings> = {}): Reader {
	const app = {
		workspace: { getActiveViewOfType: () => null },
		metadataCache: { getFileCache: () => ({}) },
		vault: {},
	} as unknown as App;
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
