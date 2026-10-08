import { ProfileSettings, ReadingConfig } from './profiles';
import { TimeDisplayMode } from '../engine/time-utils';

export type SaveAudioLocation = 'note-folder' | 'custom-folder';
export type SaveVersioning = 'replace' | 'keep';
export type QuickStartUnit = 'words' | 'characters';
export type BackgroundJobDisplayStyle = 'full' | 'compact' | 'minimal';
/**
 * How much text lights up at once while highlighting. Both are exact -- driven by which chunk is actually
 * playing, a real event -- unlike a hypothetical 'sentence' granularity, which would need to estimate
 * position from elapsed playback time (no per-word/sentence timing from the TTS provider); pushed to a
 * future milestone alongside word-level highlighting rather than ship something that drifts out of sync.
 */
export type HighlightGranularity = 'chunk' | 'section';
export type HighlightStyle = 'margin-marker' | 'background' | 'underline';

/** The fixed set of rewind/skip-forward durations offered in both the settings dropdown and the player view's skip-icon set (one custom icon per value, per direction -- see icons.ts). */
export const SKIP_SECONDS_OPTIONS = [5, 10, 15, 20, 25, 30, 45, 60] as const;
export type SkipSeconds = (typeof SKIP_SECONDS_OPTIONS)[number];

export interface NoteNarratorSettings extends ProfileSettings, ReadingConfig {
	readSelectionIfPresent: boolean;
	/** HTMLAudioElement.playbackRate applied to the generated audio during playback. */
	playbackRate: number;
	/** Seconds the rewind button in the player view jumps back by. One of SKIP_SECONDS_OPTIONS. */
	skipBackSeconds: SkipSeconds;
	/** Seconds the skip-forward button in the player view jumps ahead by. One of SKIP_SECONDS_OPTIONS. */
	skipForwardSeconds: SkipSeconds;
	/** Whether to also save the generated audio as a file in the vault. */
	saveAudioFile: boolean;
	saveAudioLocation: SaveAudioLocation;
	/** Vault-relative folder path used when saveAudioLocation is 'custom-folder'. */
	saveAudioFolderPath: string;
	/** Whether to write a link to the saved audio file into the note's frontmatter. */
	linkAudioInNote: boolean;
	/** Frontmatter property the audio link is written to. */
	audioLinkProperty: string;
	/** Frontmatter property the content hash is written to, used to detect staleness. */
	audioHashProperty: string;
	/** Frontmatter property the raw vault path to the audio file is written to, used internally to find it again. */
	audioPathProperty: string;
	/** Frontmatter property the generation timestamp is written to. */
	audioTimestampProperty: string;
	/** Frontmatter property the narrator fingerprint (a hash of the profile's voice configuration) is written to. Older notes hold the raw voice ID here. */
	audioVoiceProperty: string;
	/** Frontmatter property each chunk's [duration (seconds), byte length] pair is written to -- lets "Play saved" slice the saved file back into its per-chunk buffers, for real Previous/Next part and highlighting/scroll-to-current during saved playback. */
	audioChunkDurationsProperty: string;
	/**
	 * Extra frontmatter property keys (besides Note Narrator's own) to exclude when computing the staleness
	 * hash, one per line — for properties other plugins/workflows auto-update that shouldn't count as
	 * "the note changed" (e.g. a last-modified timestamp).
	 */
	extraStaleHashExcludedProperties: string;
	/** Show a "Clear Note Narrator files" button in the player view. */
	showClearFilesButton: boolean;
	/** Silently remove Note Narrator's own frontmatter properties from a note when its linked audio file no longer exists on disk, instead of showing a misleading "outdated" status. */
	autoCleanupMissingAudioProperties: boolean;
	/** Silently (re)generate and save a note's audio on open if missing or outdated. Requires saveAudioFile and linkAudioInNote. */
	autoGenerateOnOpen: boolean;
	/** Whether regenerating a note's audio replaces the previously linked file or keeps it and creates a new one. Only applies when linkAudioInNote is on. */
	saveVersioning: SaveVersioning;
	/** When a read (or Play saved) starts on a different note while another note is still generating, keep generating the old one in the background instead of discarding it. */
	autoBackgroundOnSwitch: boolean;
	/**
	 * How many finished background jobs whose audio isn't saved in the vault are kept in memory; finishing one
	 * more clears the oldest. 0 keeps them all. A finished job whose audio is saved doesn't count: its audio is
	 * freed from memory and read back from the vault when played.
	 */
	maxUnsavedBackgroundJobs: number;
	/** Start playback as soon as the first chunk is ready, rather than waiting for the whole note to generate. */
	startPlaybackImmediately: boolean;
	/** Generate an artificially short first chunk so playback can start sooner. Only applies when startPlaybackImmediately is on. */
	quickStart: boolean;
	/** Whether the quick-start first chunk is sized by word count or character count. */
	quickStartUnit: QuickStartUnit;
	/** Target word count for the quick-start first chunk when quickStartUnit is 'words'. */
	quickStartWordCount: number;
	/** Target character count for the quick-start first chunk when quickStartUnit is 'characters'. */
	quickStartCharCount: number;
	/** How the panel shows queued/generating/done background jobs: a full callout with text buttons, a compact pill row, or a minimal card -- all with icon buttons and click-to-play. */
	backgroundJobDisplayStyle: BackgroundJobDisplayStyle;
	/** Show Play saved/Read/Cancel/Background as icon-only buttons (with the label as a tooltip) at every panel size, instead of icon + text. */
	compactButtons: boolean;
	/** Show the volume slider + mute button row in the player view. */
	showVolumeSlider: boolean;
	/** Show the playback speed slider row in the player view. */
	showPlaybackSpeedSlider: boolean;
	/** What the player view's time readout shows: whole-read totals, today's per-chunk-only readout, or both. */
	timeDisplayMode: TimeDisplayMode;
	/** Highlight the currently-playing text in the editor as it's read. */
	highlightWhileReading: boolean;
	/** How much text lights up at once while highlighting. */
	highlightGranularity: HighlightGranularity;
	/** How the active text is marked in the editor. */
	highlightStyle: HighlightStyle;
	/** When highlightGranularity is 'section', highlight only the section's heading instead of its whole body. */
	highlightSectionTitleOnly: boolean;
	/** Show the "scroll to current section" button in the player view's playback controls row. */
	showJumpToCurrentButtons: boolean;
}

export const DEFAULT_SETTINGS: NoteNarratorSettings = {
	// Providers and profiles are seeded (from any pre-profile settings) by migrateProfileSettings() on load.
	providers: [],
	profiles: [],
	activeProfileId: '',
	readSelectionIfPresent: true,
	playbackRate: 1,
	skipBackSeconds: 15,
	skipForwardSeconds: 15,
	saveAudioFile: false,
	saveAudioLocation: 'note-folder',
	saveAudioFolderPath: 'Note Narrator Audio',
	// On by default so turning saving on gives linked, staleness-tracked audio straight away (see setControlValue).
	linkAudioInNote: true,
	audioLinkProperty: 'note_narrator_audio',
	audioHashProperty: 'note_narrator_audio_hash',
	audioPathProperty: 'note_narrator_audio_path',
	audioTimestampProperty: 'note_narrator_audio_timestamp',
	audioVoiceProperty: 'note_narrator_audio_voice',
	audioChunkDurationsProperty: 'note_narrator_audio_chunk_durations',
	extraStaleHashExcludedProperties: '',
	showClearFilesButton: true,
	autoCleanupMissingAudioProperties: true,
	autoGenerateOnOpen: false,
	saveVersioning: 'replace',
	chunkerStyle: 'markdown-aware',
	maxHeadingDepth: 2,
	readTitle: true,
	skipTitleWhenMatchingHeading: true,
	readProperties: false,
	stripMarkdownComments: true,
	stripCommentDelimiters: true,
	announceComments: true,
	autoBackgroundOnSwitch: true,
	maxUnsavedBackgroundJobs: 5,
	startPlaybackImmediately: true,
	quickStart: true,
	quickStartUnit: 'words',
	quickStartWordCount: 150,
	quickStartCharCount: 750,
	backgroundJobDisplayStyle: 'minimal',
	compactButtons: false,
	showVolumeSlider: true,
	showPlaybackSpeedSlider: true,
	timeDisplayMode: 'current',
	skipSectionHeadingPatterns: '',
	highlightWhileReading: false,
	highlightGranularity: 'chunk',
	highlightStyle: 'margin-marker',
	highlightSectionTitleOnly: false,
	showJumpToCurrentButtons: true,
};

/** The global reading defaults, which a narrator profile may override key by key. */
export function getGlobalReadingConfig(settings: NoteNarratorSettings): ReadingConfig {
	return {
		readTitle: settings.readTitle,
		skipTitleWhenMatchingHeading: settings.skipTitleWhenMatchingHeading,
		readProperties: settings.readProperties,
		stripMarkdownComments: settings.stripMarkdownComments,
		stripCommentDelimiters: settings.stripCommentDelimiters,
		announceComments: settings.announceComments,
		chunkerStyle: settings.chunkerStyle,
		maxHeadingDepth: settings.maxHeadingDepth,
		skipSectionHeadingPatterns: settings.skipSectionHeadingPatterns,
	};
}

/** Property keys whose text-control value falls back to its default when trimmed empty, instead of persisting an empty string. */
export const FALLBACK_TEXT_KEYS: Partial<Record<keyof NoteNarratorSettings, string>> = {
	saveAudioFolderPath: DEFAULT_SETTINGS.saveAudioFolderPath,
	audioLinkProperty: DEFAULT_SETTINGS.audioLinkProperty,
	audioHashProperty: DEFAULT_SETTINGS.audioHashProperty,
	audioPathProperty: DEFAULT_SETTINGS.audioPathProperty,
	audioTimestampProperty: DEFAULT_SETTINGS.audioTimestampProperty,
	audioVoiceProperty: DEFAULT_SETTINGS.audioVoiceProperty,
	audioChunkDurationsProperty: DEFAULT_SETTINGS.audioChunkDurationsProperty,
};
