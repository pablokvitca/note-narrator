import { TFile } from 'obsidian';
import { ActiveReadKind, BackgroundJobInfo } from './background-job';
import { ChunkPosition } from '../text/text-position';
import { ResolvedNarrator } from '../settings/profiles';
import { TTSProvider } from '../tts/provider';

export const NULL_CHUNK_POSITION: ChunkPosition = { span: null, sectionSpan: null, sectionHeadingSpan: null };

/** Where in the editor a `readText()` call's raw text corresponds to -- used to rebase estimated chunk spans (computed over that raw text) onto real document offsets. Omitted entirely for a selection read, which has no reliable base offset to rebase onto. */
export interface PositionBase {
	/** Offset within the raw text passed to `readText()` where trackable (in-editor) content starts -- e.g. past a prepended title/properties preamble that has no corresponding editor text. */
	rawTextOffset: number;
	/** Offset within the actual document where that same trackable content starts -- e.g. past frontmatter, which `readText()`'s raw text never includes. */
	fileOffset: number;
	/** Length of the trackable content, for clipping spans that would otherwise run past it. */
	length: number;
}

/**
 * Lets `getSpan()` and Previous/Next part work during "Play saved" playback, which has no `GenerationJob`.
 * `chunkByteLengths` is what makes this reliable: it lets the saved file be sliced back into its individual
 * chunk buffers and played one at a time through the exact same per-chunk path a live read uses, rather
 * than relying on native `<audio>` seeking within one big multi-chunk MP3 concatenation -- browsers
 * estimate seek positions from the file's own header, which (being a raw concatenation, not a properly
 * re-muxed stream) only actually describes the first chunk, so seeking past it isn't reliable.
 */
export interface SavedPlaybackTimeline {
	file: TFile;
	positions: ChunkPosition[];
	/** Each chunk's audio duration (seconds), for the full-read time display -- not used for chunk lookup (that's now the plain index into a sequentially-played buffer, like a live read). */
	chunkDurations: number[];
	/** Each chunk's byte length within the saved file, in order -- lets the concatenated file be sliced back into its original per-chunk buffers. */
	chunkByteLengths: number[];
}

export type ReaderStatus = 'idle' | 'generating' | 'playing' | 'paused';
export type AudioLinkStatus = 'none' | 'up-to-date' | 'outdated';

export interface ReaderState {
	status: ReaderStatus;
	chunkIndex: number;
	chunkCount: number;
	currentTime: number;
	duration: number;
	/** Whether each chunk's audio has finished generating, for the segmented generation-progress bar. */
	chunkReady: boolean[];
	/** Whether each chunk is actively being generated right now (dispatched to the provider, not yet resolved), for the generation-progress bar. */
	chunkInFlight: boolean[];
	/** Decoded audio duration (seconds) of each chunk once generated, for whole-read elapsed/total/remaining. Undefined until decoded. */
	chunkDurations: (number | undefined)[];
	/** The note this status is about, so the panel can show it even when it isn't the currently-active note. Null when reading a selection with no backing file, or once idle. */
	activeFile: TFile | null;
	/** What kind of read `activeFile`'s status is about -- the panel needs it to tell a full-note read (which can move to the background) from a selection read or "Play saved" (which can't). */
	activeReadKind: ActiveReadKind;
	/**
	 * Notes generating in the background after being detached from playback, plus ones that have finished
	 * (kept until explicitly cleared). Only one is ever 'generating' at once; the rest are 'queued' (waiting
	 * their turn, in this array's order) or 'done'. Independent of the playback fields above.
	 */
	backgroundJobs: BackgroundJobInfo[];
}

export const IDLE_STATE: ReaderState = {
	status: 'idle',
	chunkIndex: 0,
	chunkCount: 0,
	currentTime: 0,
	duration: 0,
	chunkReady: [],
	chunkInFlight: [],
	chunkDurations: [],
	activeFile: null,
	activeReadKind: 'none',
	backgroundJobs: [],
};

export type ChunkOutcome = 'ended' | 'next' | 'previous';

/**
 * A single read's generation state: its chunk texts, buffers/promises/readiness, and the provider used to
 * synthesize them. Exactly one job at a time drives active playback (`Reader.activeJob`); any number of
 * others can be queued/generating/done in the background (`Reader.backgroundJobs`) after being detached from
 * playback via `continueGeneratingInBackground()`. Kept as a plain object (rather than flat fields on Reader)
 * so a job can be handed off between roles, or discarded, without those roles' state colliding.
 */
export interface GenerationJob {
	id: number;
	file: TFile | null;
	chunks: string[];
	chunkBuffers: (ArrayBuffer | undefined)[];
	chunkPromises: (Promise<ArrayBuffer> | undefined)[];
	chunkReady: boolean[];
	chunkInFlight: boolean[];
	chunkDurations: (number | undefined)[];
	/** Estimated editor position of each chunk (and its section), for highlighting/scroll-to-current. See `computeChunkPositions()`. */
	positions: ChunkPosition[];
	provider: TTSProvider;
	/** The narrator this job was started with, resolved once so later edits to the profile or provider don't change a read (or its saved audio) mid-flight. */
	narrator: ResolvedNarrator;
	sourceFileForSave: TFile | null;
	/** Staleness hash of the note text this job generates, taken when the job was created -- what its saved audio is marked with, so edits made while it generates (or waits in the queue) show it as outdated. Null when it won't be saved. */
	contentHash: string | null;
	/** A read of selected text rather than the whole note. Never moved to the background: its chunks wouldn't match the note's, so it could neither be saved nor stand in for the full note later. */
	isSelection: boolean;
	/** Whether this job's audio has already been saved (triggered once every chunk finishes generating). */
	savedForSession: boolean;
	/** Set once a 429 is seen for this job; falls back its generation to sequential (1 at a time) to avoid repeating it. */
	rateLimited: boolean;
	/**
	 * Identifies the one worker pool allowed to keep claiming this job's chunks: each `runGenerationWorkerPool()`
	 * call takes the next value, and workers holding an older one stop (after finishing any chunk already in
	 * flight). Lets a job change hands -- foreground to background queue, or background back to playback --
	 * without the previous owner's pool generating on alongside the new one.
	 */
	poolToken: number;
	/** Set once this job is discarded (stopped, discarded from the background, failed, or the plugin unloaded) so any still-settling promises know not to touch playback/background state on completion. Handing a job between owners (playback and the background queue) doesn't cancel it -- see `poolToken`. */
	cancelled: boolean;
	/** Only meaningful while the job is in `Reader.backgroundJobs` -- see {@link BackgroundJobStatus}. */
	backgroundStatus: 'queued' | 'generating' | 'done';
}
