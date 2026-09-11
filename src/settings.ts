import { App, Notice, PluginSettingTab, SecretComponent, Setting, SettingDefinitionItem, TextComponent } from 'obsidian';
import ObsidianReaderPlugin from './main';
import { ChunkerStyle } from './text-utils';
import { TimeDisplayMode } from './time-utils';
import { ElevenLabsVoice, listElevenLabsVoices } from './tts/elevenlabs-provider';

export type SaveAudioLocation = 'note-folder' | 'custom-folder';
export type SaveVersioning = 'replace' | 'keep';
export type QuickStartUnit = 'words' | 'characters';
export type BackgroundJobDisplayStyle = 'full' | 'compact' | 'minimal';

export interface ReaderSettings {
	/** Name of the secret in Obsidian's SecretStorage holding the ElevenLabs API key. */
	apiKeySecretId: string;
	voiceId: string;
	modelId: string;
	stability: number;
	similarityBoost: number;
	readSelectionIfPresent: boolean;
	/** HTMLAudioElement.playbackRate applied to the generated audio during playback. */
	playbackRate: number;
	/** Seconds the skip-forward/rewind buttons in the player view jump by. */
	skipSeconds: number;
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
	/** Frontmatter property the voice ID used to generate the audio is written to. */
	audioVoiceProperty: string;
	/**
	 * Extra frontmatter property keys (besides the reader's own) to exclude when computing the staleness
	 * hash, one per line — for properties other plugins/workflows auto-update that shouldn't count as
	 * "the note changed" (e.g. a last-modified timestamp).
	 */
	extraStaleHashExcludedProperties: string;
	/** Show a "Clear reader files" button in the player view. */
	showClearFilesButton: boolean;
	/** Silently remove the reader's own frontmatter properties from a note when its linked audio file no longer exists on disk, instead of showing a misleading "outdated" status. */
	autoCleanupMissingAudioProperties: boolean;
	/** Silently (re)generate and save a note's audio on open if missing or outdated. Requires saveAudioFile and linkAudioInNote. */
	autoGenerateOnOpen: boolean;
	/** Whether regenerating a note's audio replaces the previously linked file or keeps it and creates a new one. Only applies when linkAudioInNote is on. */
	saveVersioning: SaveVersioning;
	/** How to split note text into TTS requests. */
	chunkerStyle: ChunkerStyle;
	/** Headings at or shallower than this depth (1 = H1) start a new section when chunkerStyle is 'markdown-aware'. */
	maxHeadingDepth: number;
	/** Speak the note's title before its content. */
	readTitle: boolean;
	/** Speak "Properties", each frontmatter property and value, then "Content", before the note's content. */
	readProperties: boolean;
	/** Strip Obsidian/Markdown comments (`%% ... %%`) before reading. */
	stripMarkdownComments: boolean;
	/** When a comment isn't fully skipped above, never read its raw `%%` delimiter symbols aloud -- just the text between them. */
	stripCommentDelimiters: boolean;
	/** When a comment isn't fully skipped above, prefix its (delimiter-stripped) text with "Comment: " when read aloud. */
	announceComments: boolean;
	/** Voice IDs shown in the player view's Voice dropdown. Empty means show all fetched voices there. */
	panelVoiceIds: string[];
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
	/** Whether to generate more than one chunk at a time ahead of playback. */
	parallelGenerationEnabled: boolean;
	/** How many chunks may be generating at once when parallelGenerationEnabled is on. */
	maxParallelGeneration: number;
	/** How many chunks may generate at once for a note continuing in the background (via "Continue in background"), independent of maxParallelGeneration -- kept low by default so it doesn't compete with an actively-playing read. */
	maxBackgroundParallelGeneration: number;
	/** How the panel shows queued/generating/done background jobs: a full callout with text buttons, a compact pill row, or a minimal card -- all with icon buttons and click-to-play. */
	backgroundJobDisplayStyle: BackgroundJobDisplayStyle;
	/** Show the volume slider + mute button row in the player view. */
	showVolumeSlider: boolean;
	/** Show the playback speed slider row in the player view. */
	showPlaybackSpeedSlider: boolean;
	/** What the player view's time readout shows: whole-read totals, today's per-chunk-only readout, or both. */
	timeDisplayMode: TimeDisplayMode;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	apiKeySecretId: 'elevenlabs-api-key',
	voiceId: '21m00Tcm4TlvDq8ikWAM',
	modelId: 'eleven_multilingual_v2',
	stability: 0.5,
	similarityBoost: 0.75,
	readSelectionIfPresent: true,
	playbackRate: 1,
	skipSeconds: 15,
	saveAudioFile: false,
	saveAudioLocation: 'note-folder',
	saveAudioFolderPath: 'Reader Audio',
	linkAudioInNote: false,
	audioLinkProperty: 'reader_audio',
	audioHashProperty: 'reader_audio_hash',
	audioPathProperty: 'reader_audio_path',
	audioTimestampProperty: 'reader_audio_timestamp',
	audioVoiceProperty: 'reader_audio_voice',
	extraStaleHashExcludedProperties: '',
	showClearFilesButton: true,
	autoCleanupMissingAudioProperties: true,
	autoGenerateOnOpen: false,
	saveVersioning: 'replace',
	chunkerStyle: 'markdown-aware',
	maxHeadingDepth: 2,
	readTitle: true,
	readProperties: false,
	stripMarkdownComments: true,
	stripCommentDelimiters: true,
	announceComments: true,
	panelVoiceIds: [],
	startPlaybackImmediately: true,
	quickStart: true,
	quickStartUnit: 'words',
	quickStartWordCount: 150,
	quickStartCharCount: 750,
	parallelGenerationEnabled: true,
	maxParallelGeneration: 2,
	maxBackgroundParallelGeneration: 1,
	backgroundJobDisplayStyle: 'minimal',
	showVolumeSlider: true,
	showPlaybackSpeedSlider: true,
	timeDisplayMode: 'current',
};

export const ELEVENLABS_MODELS: Record<string, string> = {
	eleven_v3: 'Eleven v3 (research preview)',
	eleven_multilingual_v2: 'Eleven Multilingual v2',
	eleven_flash_v2_5: 'Eleven Flash v2.5',
};

/** ElevenLabs' documented per-request character limit for each model. */
export const ELEVENLABS_MODEL_CHAR_LIMITS: Record<string, number> = {
	eleven_v3: 5000,
	eleven_multilingual_v2: 10000,
	eleven_flash_v2_5: 40000,
};

export const DEFAULT_ELEVENLABS_CHAR_LIMIT = 5000;

/** Property keys whose text-control value falls back to its default when trimmed empty, instead of persisting an empty string. */
const FALLBACK_TEXT_KEYS: Partial<Record<keyof ReaderSettings, string>> = {
	saveAudioFolderPath: DEFAULT_SETTINGS.saveAudioFolderPath,
	audioLinkProperty: DEFAULT_SETTINGS.audioLinkProperty,
	audioHashProperty: DEFAULT_SETTINGS.audioHashProperty,
	audioPathProperty: DEFAULT_SETTINGS.audioPathProperty,
	audioTimestampProperty: DEFAULT_SETTINGS.audioTimestampProperty,
	audioVoiceProperty: DEFAULT_SETTINGS.audioVoiceProperty,
};

export class ReaderSettingTab extends PluginSettingTab {
	plugin: ObsidianReaderPlugin;
	private voices: ElevenLabsVoice[] = [];
	private voicesLoaded = false;

	constructor(app: App, plugin: ObsidianReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Text-control keys (the audio frontmatter properties, plus the custom save folder path) fall back to
	 * their default when trimmed empty, instead of persisting an empty string — everything else is handled
	 * by the default PluginSettingTab behavior (read/write `this.plugin.settings[key]`, then persist).
	 *
	 * Also calls refreshDomState() after every change, defensively — several settings here (e.g. saveAudioFile,
	 * chunkerStyle) gate other settings' `visible` predicates, and this guarantees those re-evaluate regardless
	 * of whether the framework already does so automatically for built-in controls.
	 */
	setControlValue(key: string, value: unknown): void | Promise<void> {
		const fallback = FALLBACK_TEXT_KEYS[key as keyof ReaderSettings];
		const normalized = fallback !== undefined && typeof value === 'string' ? value.trim() || fallback : value;
		const result = super.setControlValue(key, normalized);
		if (result instanceof Promise) {
			return result.then(() => this.refreshDomState());
		}
		this.refreshDomState();
		return result;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;

		if (!this.voicesLoaded) {
			this.voicesLoaded = true;
			void this.loadVoices();
		}

		return [
			{
				type: 'group',
				heading: 'ElevenLabs',
				items: [
					{
						name: 'API key',
						desc: "Stored in Obsidian's secret storage, not in this plugin's settings file.",
						render: (setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el).setValue(settings.apiKeySecretId).onChange(async (value) => {
									settings.apiKeySecretId = value;
									await this.plugin.saveSettings();
								}),
							);
						},
					},
					{
						name: 'Voice',
						desc: 'Voices fetched from your ElevenLabs account (first 100). Use the refresh button after adding an API key or creating new voices.',
						render: (setting) => {
							const currentVoiceId = settings.voiceId;
							setting.addDropdown((dropdown) => {
								if (this.voices.length === 0) {
									dropdown.addOption(currentVoiceId, currentVoiceId);
								} else {
									for (const voice of this.voices) {
										dropdown.addOption(voice.voiceId, voice.name);
									}
									if (!this.voices.some((voice) => voice.voiceId === currentVoiceId)) {
										dropdown.addOption(currentVoiceId, `${currentVoiceId} (custom)`);
									}
								}
								dropdown.setValue(currentVoiceId);
								dropdown.onChange(async (value) => {
									settings.voiceId = value;
									await this.plugin.saveSettings();
								});
							});
							setting.addExtraButton((button) =>
								button
									.setIcon('refresh-cw')
									.setTooltip('Refresh voice list from ElevenLabs')
									.onClick(() => this.loadVoices()),
							);
						},
					},
					{
						name: 'Model',
						desc: 'The ElevenLabs text-to-speech model to use.',
						control: { type: 'dropdown', key: 'modelId', options: ELEVENLABS_MODELS, defaultValue: DEFAULT_SETTINGS.modelId },
					},
					{
						name: 'Stability',
						desc:
							'Lower values sound more expressive and varied; higher values sound steadier. ' +
							"On Eleven v3, this maps to ElevenLabs' Creative (low) / Natural (middle) / Robust (high) presets.",
						control: { type: 'slider', key: 'stability', min: 0, max: 1, step: 0.05, defaultValue: DEFAULT_SETTINGS.stability },
					},
					{
						name: 'Similarity boost',
						desc: 'How closely the output should match the original voice.',
						control: { type: 'slider', key: 'similarityBoost', min: 0, max: 1, step: 0.05, defaultValue: DEFAULT_SETTINGS.similarityBoost },
					},
				],
			},
			{
				type: 'group',
				heading: 'Panel voices',
				items: [
					{
						name: '',
						desc: "Choose a short list of voices to show in the player view's voice dropdown, instead of your whole account list. Leave none selected to show all voices there.",
					},
					{
						name: '',
						desc: 'Voices not loaded yet — set an API key and use the refresh button above.',
						visible: () => this.voices.length === 0,
					},
					...this.voices.map((voice) => ({
						name: voice.name,
						render: (setting: Setting) => {
							setting.addToggle((toggle) =>
								toggle.setValue(settings.panelVoiceIds.includes(voice.voiceId)).onChange(async (value) => {
									const ids = new Set(settings.panelVoiceIds);
									if (value) ids.add(voice.voiceId);
									else ids.delete(voice.voiceId);
									settings.panelVoiceIds = Array.from(ids);
									await this.plugin.saveSettings();
								}),
							);
						},
					})),
				],
			},
			{
				type: 'group',
				heading: 'Reading',
				items: [
					{
						name: 'Read note title',
						desc: "Speak the note's title before its content.",
						control: { type: 'toggle', key: 'readTitle', defaultValue: DEFAULT_SETTINGS.readTitle },
					},
					{
						name: 'Read note properties',
						desc: 'Speak "properties", each frontmatter property and value, then "content", before the note\'s content. Does not apply when reading a selection.',
						control: { type: 'toggle', key: 'readProperties', defaultValue: DEFAULT_SETTINGS.readProperties },
					},
					{
						name: 'Skip Markdown comments',
						desc: 'Strip Obsidian/Markdown comments (`%% like this %%`) before reading, instead of reading them aloud verbatim. HTML comments (`<!-- like this -->`) aren\'t handled specially yet and are always read as literal text -- see the README\'s "Known limitations".',
						control: { type: 'toggle', key: 'stripMarkdownComments', defaultValue: DEFAULT_SETTINGS.stripMarkdownComments },
					},
					{
						name: "Don't read comment delimiter symbols",
						desc: "When a Markdown comment above isn't fully skipped, never read its raw `%%` markup aloud -- just the text between them.",
						control: { type: 'toggle', key: 'stripCommentDelimiters', defaultValue: DEFAULT_SETTINGS.stripCommentDelimiters },
						visible: () => !settings.stripMarkdownComments,
					},
					{
						name: 'Announce comments as "Comment: ..."',
						desc: "When a Markdown comment above isn't fully skipped, prefix its text with \"Comment: \" when read aloud, so a listener knows it was one.",
						control: { type: 'toggle', key: 'announceComments', defaultValue: DEFAULT_SETTINGS.announceComments },
						visible: () => !settings.stripMarkdownComments,
					},
					{
						name: 'Text chunker',
						desc: 'How to split note text into TTS requests. Markdown-aware splits by heading section first, then by sentence within each section. Sentence-only ignores headings and packs sentences up to the character limit.',
						control: {
							type: 'dropdown',
							key: 'chunkerStyle',
							options: { 'markdown-aware': 'Markdown-aware (default)', sentence: 'Sentence-only' },
							defaultValue: DEFAULT_SETTINGS.chunkerStyle,
						},
					},
					{
						name: 'Max heading depth for sections',
						desc: 'Headings at or shallower than this depth (1 = #, 2 = ## and shallower, etc.) start a new section. Deeper headings stay within their enclosing section.',
						control: { type: 'slider', key: 'maxHeadingDepth', min: 1, max: 6, step: 1, defaultValue: DEFAULT_SETTINGS.maxHeadingDepth },
						visible: () => settings.chunkerStyle === 'markdown-aware',
					},
				],
			},
			{
				type: 'group',
				heading: 'Performance',
				items: [
					{
						name: 'Start playback immediately',
						desc: 'Start playing as soon as the first chunk is ready, instead of waiting for the whole note to finish generating first.',
						control: { type: 'toggle', key: 'startPlaybackImmediately', defaultValue: DEFAULT_SETTINGS.startPlaybackImmediately },
					},
					{
						name: 'Quick start',
						desc: 'Generate an artificially short first chunk (including the title/properties preamble, if enabled) so playback can start sooner, especially on long notes.',
						control: { type: 'toggle', key: 'quickStart', defaultValue: DEFAULT_SETTINGS.quickStart },
						visible: () => settings.startPlaybackImmediately,
					},
					{
						name: 'Quick start unit',
						desc: 'Whether the quick-start first chunk is sized by word count or character count.',
						control: {
							type: 'dropdown',
							key: 'quickStartUnit',
							options: { words: 'Words', characters: 'Characters' },
							defaultValue: DEFAULT_SETTINGS.quickStartUnit,
						},
						visible: () => settings.startPlaybackImmediately && settings.quickStart,
					},
					{
						name: 'Quick start word count',
						desc: `Target size of the quick-start first chunk, in words. Recommended: 50-300. Default: ${DEFAULT_SETTINGS.quickStartWordCount}.`,
						visible: () => settings.startPlaybackImmediately && settings.quickStart && settings.quickStartUnit === 'words',
						render: (setting) =>
							this.renderNumberControlWithReset(setting, {
								get: () => settings.quickStartWordCount,
								set: (value) => {
									settings.quickStartWordCount = value;
								},
								min: 1,
								defaultValue: DEFAULT_SETTINGS.quickStartWordCount,
							}),
					},
					{
						name: 'Quick start character count',
						desc: 'Target size of the quick-start first chunk, in characters.',
						control: {
							type: 'slider',
							key: 'quickStartCharCount',
							min: 100,
							max: 2000,
							step: 50,
							defaultValue: DEFAULT_SETTINGS.quickStartCharCount,
						},
						visible: () => settings.startPlaybackImmediately && settings.quickStart && settings.quickStartUnit === 'characters',
					},
					{
						name: 'Generate chunks in parallel',
						desc: 'Generate more than one chunk ahead of playback at once, instead of strictly one at a time.',
						control: { type: 'toggle', key: 'parallelGenerationEnabled', defaultValue: DEFAULT_SETTINGS.parallelGenerationEnabled },
					},
					{
						name: 'Max parallel chunk generation',
						desc: `How many chunks may be generating at the same time. Higher can finish long notes faster but makes more simultaneous ElevenLabs requests (and hits rate limits sooner). Recommended: 2-5. Default: ${DEFAULT_SETTINGS.maxParallelGeneration}.`,
						visible: () => settings.parallelGenerationEnabled,
						render: (setting) =>
							this.renderNumberControlWithReset(setting, {
								get: () => settings.maxParallelGeneration,
								set: (value) => {
									settings.maxParallelGeneration = value;
								},
								min: 2,
								defaultValue: DEFAULT_SETTINGS.maxParallelGeneration,
							}),
					},
					{
						name: 'Max parallel background chunk generation',
						desc: `How many chunks may generate at once for a note continuing in the background (via the panel's "Continue in background" button), independent of the setting above. Kept low by default so it doesn't compete with an actively-playing read. Recommended: 1-3. Default: ${DEFAULT_SETTINGS.maxBackgroundParallelGeneration}.`,
						render: (setting) =>
							this.renderNumberControlWithReset(setting, {
								get: () => settings.maxBackgroundParallelGeneration,
								set: (value) => {
									settings.maxBackgroundParallelGeneration = value;
								},
								min: 1,
								defaultValue: DEFAULT_SETTINGS.maxBackgroundParallelGeneration,
							}),
					},
					{
						name: 'Background job display',
						desc: 'How the panel shows notes queued/generating/finished in the background. "Full" shows a callout with text buttons per note. "Compact" is a slim row with icon buttons. "Minimal" is a small card with icon buttons only. All three play a note when you click anywhere on it besides its buttons.',
						control: {
							type: 'dropdown',
							key: 'backgroundJobDisplayStyle',
							options: { minimal: 'Minimal card (default)', compact: 'Compact row', full: 'Full callout' },
							defaultValue: DEFAULT_SETTINGS.backgroundJobDisplayStyle,
						},
					},
					{
						name: 'Read selection instead of whole note',
						desc: 'When enabled, reading a note with an active text selection reads only the selection.',
						control: { type: 'toggle', key: 'readSelectionIfPresent', defaultValue: DEFAULT_SETTINGS.readSelectionIfPresent },
					},
					{
						name: 'Default playback speed',
						desc: 'Starting speed for each read. The player view has its own speed slider to adjust playback live without changing this default.',
						control: { type: 'slider', key: 'playbackRate', min: 0.5, max: 3, step: 0.05, defaultValue: DEFAULT_SETTINGS.playbackRate },
					},
					{
						name: 'Skip button seconds',
						desc: `How many seconds the skip-forward and rewind buttons in the player view jump by. Recommended: 5-30. Default: ${DEFAULT_SETTINGS.skipSeconds}.`,
						render: (setting) =>
							this.renderNumberControlWithReset(setting, {
								get: () => settings.skipSeconds,
								set: (value) => {
									settings.skipSeconds = value;
								},
								min: 1,
								defaultValue: DEFAULT_SETTINGS.skipSeconds,
							}),
					},
					{
						name: 'Show volume slider in panel',
						desc: "Show the volume slider and mute button row in the player view, for people who don't want the extra control taking up panel space.",
						control: { type: 'toggle', key: 'showVolumeSlider', defaultValue: DEFAULT_SETTINGS.showVolumeSlider },
					},
					{
						name: 'Show playback speed slider in panel',
						desc: "Show the playback speed slider row in the player view, for people who always read at the default speed and don't want the extra control taking up panel space.",
						control: { type: 'toggle', key: 'showPlaybackSpeedSlider', defaultValue: DEFAULT_SETTINGS.showPlaybackSpeedSlider },
					},
					{
						name: 'Time display',
						desc: 'What the player view\'s time readout shows. "Full" totals the whole read across every generated chunk (marking any not-yet-generated parts as "+N parts" rather than guessing their length). "Current part" is today\'s per-chunk-only readout. "Both" shows full totals with the current part\'s times alongside in parentheses.',
						control: {
							type: 'dropdown',
							key: 'timeDisplayMode',
							options: { full: 'Show full times', current: 'Show current part times', both: 'Show full times + current part times' },
							defaultValue: DEFAULT_SETTINGS.timeDisplayMode,
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Save audio',
				items: [
					{
						name: 'Save generated audio to a file',
						desc: 'When enabled, also saves the audio generated by a read as an .mp3 file in the vault. Disabled by default.',
						control: { type: 'toggle', key: 'saveAudioFile', defaultValue: DEFAULT_SETTINGS.saveAudioFile },
					},
					{
						name: 'Save location',
						desc: 'Where to save the audio file.',
						control: {
							type: 'dropdown',
							key: 'saveAudioLocation',
							options: { 'note-folder': 'Same folder as the note', 'custom-folder': 'Custom folder' },
							defaultValue: DEFAULT_SETTINGS.saveAudioLocation,
						},
						visible: () => settings.saveAudioFile,
					},
					{
						name: 'Custom folder path',
						desc: "Vault-relative folder to save audio files in. Created automatically if it doesn't exist.",
						control: { type: 'text', key: 'saveAudioFolderPath', placeholder: DEFAULT_SETTINGS.saveAudioFolderPath, defaultValue: DEFAULT_SETTINGS.saveAudioFolderPath },
						visible: () => settings.saveAudioFile && settings.saveAudioLocation === 'custom-folder',
					},
					{
						name: 'Link saved audio in the note',
						desc: 'When enabled, writes a link to the saved audio file into a frontmatter property on the note, and tracks whether the note has changed since — shown in the player view.',
						control: { type: 'toggle', key: 'linkAudioInNote', defaultValue: DEFAULT_SETTINGS.linkAudioInNote },
						visible: () => settings.saveAudioFile,
					},
					{
						name: 'Link property',
						desc: 'Frontmatter property the audio link is written to.',
						control: { type: 'text', key: 'audioLinkProperty', placeholder: DEFAULT_SETTINGS.audioLinkProperty, defaultValue: DEFAULT_SETTINGS.audioLinkProperty },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Hash property',
						desc: 'Frontmatter property the content hash is written to, used to detect staleness.',
						control: { type: 'text', key: 'audioHashProperty', placeholder: DEFAULT_SETTINGS.audioHashProperty, defaultValue: DEFAULT_SETTINGS.audioHashProperty },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Path property',
						desc: 'Frontmatter property the raw vault path to the audio file is written to (used internally to find it again).',
						control: { type: 'text', key: 'audioPathProperty', placeholder: DEFAULT_SETTINGS.audioPathProperty, defaultValue: DEFAULT_SETTINGS.audioPathProperty },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Timestamp property',
						desc: 'Frontmatter property the generation timestamp is written to.',
						control: {
							type: 'text',
							key: 'audioTimestampProperty',
							placeholder: DEFAULT_SETTINGS.audioTimestampProperty,
							defaultValue: DEFAULT_SETTINGS.audioTimestampProperty,
						},
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Voice property',
						desc: "Frontmatter property the voice ID used to generate the audio is written to. Used to detect when the selected voice differs from the saved audio's voice.",
						control: { type: 'text', key: 'audioVoiceProperty', placeholder: DEFAULT_SETTINGS.audioVoiceProperty, defaultValue: DEFAULT_SETTINGS.audioVoiceProperty },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Extra properties to exclude from staleness hashing',
						desc: "Besides the reader's own properties above (always excluded), also ignore these frontmatter properties when checking whether a note has changed since its audio was generated — for properties other plugins auto-update that shouldn't count as a real edit. One property key per line.",
						control: { type: 'textarea', key: 'extraStaleHashExcludedProperties', placeholder: 'last_modified', rows: 3 },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'On regenerate',
						desc: "What to do when a note's audio already exists and is regenerated: replace the previously linked file, or keep it and create a new one.",
						control: {
							type: 'dropdown',
							key: 'saveVersioning',
							options: { replace: 'Replace existing file', keep: 'Keep old versions' },
							defaultValue: DEFAULT_SETTINGS.saveVersioning,
						},
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Auto-generate on open',
						desc: "When enabled, opening a note silently (re)generates and saves its audio in the background if missing or outdated — without playing it or interrupting anything currently playing.",
						control: { type: 'toggle', key: 'autoGenerateOnOpen', defaultValue: DEFAULT_SETTINGS.autoGenerateOnOpen },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Show "clear reader files" menu item and delete button',
						desc: 'Enable the "clear reader files" item in the player view\'s ⋮ menu (top-right) and the small delete button on the saved-audio status line, both of which delete a note\'s linked audio file and remove the properties above, after confirming.',
						control: { type: 'toggle', key: 'showClearFilesButton', defaultValue: DEFAULT_SETTINGS.showClearFilesButton },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
					{
						name: 'Auto-clean up properties when saved file is missing',
						desc: "When a note's linked audio file no longer exists (moved or deleted outside Obsidian Reader), silently remove the properties above instead of showing a misleading \"outdated\" status.",
						control: { type: 'toggle', key: 'autoCleanupMissingAudioProperties', defaultValue: DEFAULT_SETTINGS.autoCleanupMissingAudioProperties },
						visible: () => settings.saveAudioFile && settings.linkAudioInNote,
					},
				],
			},
		];
	}

	/**
	 * A numeric text input plus a "reset to default" extra button, for settings that need a value
	 * unbounded above (so declarative `control: { type: 'number' }`, which can't add an extra button
	 * alongside it, isn't enough here). Falls back to `defaultValue` on empty/invalid/below-`min` input,
	 * same as the declarative number control does.
	 */
	private renderNumberControlWithReset(setting: Setting, options: { get: () => number; set: (value: number) => void; min: number; defaultValue: number }): void {
		const { get, set, min, defaultValue } = options;
		let textComponent: TextComponent;

		setting.addText((text) => {
			textComponent = text;
			text.inputEl.type = 'number';
			text.inputEl.min = String(min);
			text.setValue(String(get()));
			text.onChange(async (raw) => {
				const parsed = Number(raw);
				set(Number.isFinite(parsed) && parsed >= min ? Math.round(parsed) : defaultValue);
				await this.plugin.saveSettings();
			});
		});

		setting.addExtraButton((button) =>
			button
				.setIcon('rotate-ccw')
				.setTooltip('Reset to default')
				.onClick(async () => {
					set(defaultValue);
					textComponent.setValue(String(defaultValue));
					await this.plugin.saveSettings();
				}),
		);
	}

	private async loadVoices(): Promise<void> {
		const apiKey = this.app.secretStorage.getSecret(this.plugin.settings.apiKeySecretId);
		if (!apiKey) return;

		try {
			this.voices = await listElevenLabsVoices(apiKey);
			this.update();
		} catch (error) {
			console.error('Obsidian Reader: failed to fetch ElevenLabs voices', error);
			new Notice(`Failed to fetch voices: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
