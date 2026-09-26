import { App, DropdownComponent, Notice, PluginSettingTab, SecretComponent, Setting, SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem, TextComponent } from 'obsidian';
import { ConfirmModal } from '../ui/confirm-modal';
import NoteNarratorPlugin from '../main';
import {
	createProfile,
	createProvider,
	defaultVoiceConfig,
	ElevenLabsVoiceConfig,
	getActiveProfile,
	getProvider,
	NarratorProfile,
	normalizeProfileSettings,
	PROVIDER_TYPE_LABELS,
	ProfileSettings,
	ProviderEntry,
	ProviderType,
	ReadingConfig,
	ReadingOverrides,
	resolveReadingConfig,
	uniqueName,
} from './profiles';
import { ChunkerStyle } from '../text/text-utils';
import { TimeDisplayMode } from '../engine/time-utils';
import { ElevenLabsVoice, listElevenLabsVoices } from '../tts/elevenlabs-provider';
import { ELEVENLABS_MODELS } from '../tts/elevenlabs-models';
import { getProviderApiKey } from '../tts/registry';

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
	/** Show Play Saved/Read/Cancel/Send to Background as icon-only buttons (with the label as a tooltip) at every panel size, instead of icon + text. */
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
	readProperties: false,
	stripMarkdownComments: true,
	stripCommentDelimiters: true,
	announceComments: true,
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
const FALLBACK_TEXT_KEYS: Partial<Record<keyof NoteNarratorSettings, string>> = {
	saveAudioFolderPath: DEFAULT_SETTINGS.saveAudioFolderPath,
	audioLinkProperty: DEFAULT_SETTINGS.audioLinkProperty,
	audioHashProperty: DEFAULT_SETTINGS.audioHashProperty,
	audioPathProperty: DEFAULT_SETTINGS.audioPathProperty,
	audioTimestampProperty: DEFAULT_SETTINGS.audioTimestampProperty,
	audioVoiceProperty: DEFAULT_SETTINGS.audioVoiceProperty,
	audioChunkDurationsProperty: DEFAULT_SETTINGS.audioChunkDurationsProperty,
};

type SettingsTabId = 'general' | 'providers' | 'profiles' | 'appearance' | 'performance' | 'files';

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
	{ id: 'general', label: 'General' },
	{ id: 'providers', label: 'Providers' },
	{ id: 'profiles', label: 'Profiles' },
	{ id: 'appearance', label: 'Appearance' },
	{ id: 'performance', label: 'Performance' },
	{ id: 'files', label: 'Files' },
];

const INHERIT = 'inherit';

export class NoteNarratorSettingTab extends PluginSettingTab {
	plugin: NoteNarratorPlugin;
	private activeTab: SettingsTabId = 'general';
	private voicesByProvider = new Map<string, ElevenLabsVoice[]>();
	private voiceLoads = new Map<string, Promise<void>>();
	/** Re-applies the disabled state of imperatively rendered rows (declarative controls handle their own via `disabled`). Rebuilt on every render. */
	private disabledUpdaters: (() => void)[] = [];
	/** Reloads a profile's voice dropdown (keyed by profile id) after its provider changes, while its page is open. */
	private voiceRefreshers = new Map<string, () => void>();

	constructor(app: App, plugin: NoteNarratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Text-control keys (the audio frontmatter properties, plus the custom save folder path) fall back to
	 * their default when trimmed empty, instead of persisting an empty string — everything else is handled
	 * by the default PluginSettingTab behavior (read/write `this.plugin.settings[key]`, then persist).
	 *
	 * Many settings gate others' `disabled` predicates, so this refreshes the DOM state after every change.
	 * Turning on "save audio" also turns on "link in note": saved audio is only useful if the note tracks
	 * it, and linking is on by default, but a person may have switched it off before.
	 */
	setControlValue(key: string, value: unknown): void | Promise<void> {
		const fallback = FALLBACK_TEXT_KEYS[key as keyof NoteNarratorSettings];
		const normalized = fallback !== undefined && typeof value === 'string' ? value.trim() || fallback : value;
		const result = super.setControlValue(key, normalized);

		const after = async () => {
			if (key === 'saveAudioFile' && normalized === true && !this.plugin.settings.linkAudioInNote) {
				this.plugin.settings.linkAudioInNote = true;
				await this.plugin.saveSettings();
				// The linking toggle is already rendered showing "off"; re-render so it shows the new value.
				this.update();
				return;
			}
			this.refreshAll();
		};

		if (result instanceof Promise) return result.then(after);
		return after();
	}

	/** Re-evaluates every declarative `visible`/`disabled` predicate and the imperative rows' disabled state. */
	private refreshAll(): void {
		this.refreshDomState();
		for (const apply of this.disabledUpdaters) apply();
	}

	private get settings(): NoteNarratorSettings {
		return this.plugin.settings;
	}

	// ---------------------------------------------------------------------------------------------------
	// Row helpers (imperatively rendered rows that edit fields of nested objects)
	// ---------------------------------------------------------------------------------------------------

	/** Greys out and blocks interaction with a row while `isDisabled()` is true, and keeps it in sync with later changes. */
	private trackDisabled(setting: Setting, isDisabled: () => boolean): void {
		const apply = () => {
			const disabled = isDisabled();
			setting.setDisabled(disabled);
			setting.settingEl.toggleClass('note-narrator-row-disabled', disabled);
		};
		apply();
		this.disabledUpdaters.push(apply);
	}

	private textRow(
		name: string,
		desc: string,
		get: () => string,
		set: (value: string) => void,
		options: { placeholder?: string; disabled?: () => boolean } = {},
	): SettingGroupItem {
		return {
			name,
			desc,
			render: (setting) => {
				setting.addText((text) => {
					if (options.placeholder) text.setPlaceholder(options.placeholder);
					text.setValue(get()).onChange(async (value) => {
						set(value);
						await this.plugin.saveSettings();
					});
				});
				if (options.disabled) this.trackDisabled(setting, options.disabled);
			},
		};
	}

	private toggleRow(name: string, desc: string, get: () => boolean, set: (value: boolean) => void, disabled?: () => boolean): SettingGroupItem {
		return {
			name,
			desc,
			render: (setting) => {
				setting.addToggle((toggle) =>
					toggle.setValue(get()).onChange(async (value) => {
						set(value);
						await this.plugin.saveSettings();
						this.refreshAll();
					}),
				);
				if (disabled) this.trackDisabled(setting, disabled);
			},
		};
	}

	private dropdownRow(
		name: string,
		desc: string,
		options: Record<string, string>,
		get: () => string,
		set: (value: string) => void,
		disabled?: () => boolean,
	): SettingGroupItem {
		return {
			name,
			desc,
			render: (setting) => {
				setting.addDropdown((dropdown) => {
					dropdown.addOptions(options);
					dropdown.setValue(get()).onChange(async (value) => {
						set(value);
						await this.plugin.saveSettings();
						this.refreshAll();
					});
				});
				if (disabled) this.trackDisabled(setting, disabled);
			},
		};
	}

	private sliderRow(
		name: string,
		desc: string,
		range: { min: number; max: number; step: number },
		get: () => number,
		set: (value: number) => void,
	): SettingGroupItem {
		return {
			name,
			desc,
			render: (setting) => {
				setting.addSlider((slider) =>
					slider
						.setLimits(range.min, range.max, range.step)
						.setValue(get())
						.onChange(async (value) => {
							set(value);
							await this.plugin.saveSettings();
						}),
				);
			},
		};
	}

	private numberRow(
		name: string,
		desc: string,
		options: { get: () => number; set: (value: number) => void; min: number; defaultValue: number; disabled?: () => boolean },
	): SettingGroupItem {
		return {
			name,
			desc,
			render: (setting) => {
				this.renderNumberControlWithReset(setting, options);
				if (options.disabled) this.trackDisabled(setting, options.disabled);
			},
		};
	}

	// ---------------------------------------------------------------------------------------------------
	// Definitions
	// ---------------------------------------------------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		this.disabledUpdaters = [];
		this.voiceRefreshers.clear();

		return [
			{ name: 'Sections', render: (setting) => this.renderTabBar(setting) },
			...this.generalTab(),
			...this.providersTab(),
			...this.profilesTab(),
			...this.appearanceTab(),
			...this.performanceTab(),
			...this.filesTab(),
		];
	}

	private renderTabBar(setting: Setting): void {
		setting.settingEl.addClass('note-narrator-settings-tabs');
		// Obsidian re-runs a row's render() on the same element when the tab re-renders (e.g. after adding a
		// provider), and this bar is appended straight to the row, so drop any earlier copy first.
		setting.settingEl.findAll(':scope > .note-narrator-tab-bar').forEach((existing) => existing.remove());
		const bar = setting.settingEl.createDiv({ cls: 'note-narrator-tab-bar', attr: { role: 'tablist' } });
		const buttons = new Map<SettingsTabId, HTMLButtonElement>();

		const syncSelection = () => {
			for (const [id, button] of buttons) {
				const selected = id === this.activeTab;
				button.toggleClass('is-active', selected);
				button.setAttribute('aria-selected', String(selected));
			}
		};

		for (const tab of SETTINGS_TABS) {
			const button = bar.createEl('button', { cls: 'note-narrator-tab', text: tab.label, attr: { role: 'tab', type: 'button' } });
			button.addEventListener('click', () => {
				this.activeTab = tab.id;
				syncSelection();
				this.refreshAll();
			});
			buttons.set(tab.id, button);
		}
		syncSelection();
	}

	private onTab(id: SettingsTabId): () => boolean {
		return () => this.activeTab === id;
	}

	// ------------------------------ General ------------------------------

	private generalTab(): SettingDefinitionItem[] {
		const visible = this.onTab('general');
		const settings = this.settings;

		return [
			{
				name: 'About these defaults',
				desc: 'Defaults for how notes are read. A narrator profile can override any of the reading settings below (see Profiles).',
				visible,
			},
			{
				type: 'group',
				heading: 'Reading',
				visible,
				items: [
					{
						name: 'Read selection instead of whole note',
						desc: 'When enabled, reading a note with an active text selection reads only the selection.',
						control: { type: 'toggle', key: 'readSelectionIfPresent', defaultValue: DEFAULT_SETTINGS.readSelectionIfPresent },
					},
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
						desc: 'Strip Obsidian/Markdown comments (`%% like this %%`) before reading, instead of reading them aloud verbatim. HTML comments (`<!-- like this -->`) aren\'t handled specially yet and are always read as literal text.',
						control: { type: 'toggle', key: 'stripMarkdownComments', defaultValue: DEFAULT_SETTINGS.stripMarkdownComments },
					},
					{
						name: "Don't read comment delimiter symbols",
						desc: "When a Markdown comment above isn't fully skipped, never read its raw `%%` markup aloud -- just the text between them.",
						control: {
							type: 'toggle',
							key: 'stripCommentDelimiters',
							defaultValue: DEFAULT_SETTINGS.stripCommentDelimiters,
							disabled: () => settings.stripMarkdownComments,
						},
					},
					{
						name: 'Announce comments as "Comment: ..."',
						desc: "When a Markdown comment above isn't fully skipped, prefix its text with \"Comment: \" when read aloud, so a listener knows it was one.",
						control: {
							type: 'toggle',
							key: 'announceComments',
							defaultValue: DEFAULT_SETTINGS.announceComments,
							disabled: () => settings.stripMarkdownComments,
						},
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
						desc: 'Headings at or shallower than this depth (1 = #, 2 = ## and shallower, etc.) start a new section. Deeper headings stay within their enclosing section. Only applies to the Markdown-aware chunker.',
						control: {
							type: 'slider',
							key: 'maxHeadingDepth',
							min: 1,
							max: 6,
							step: 1,
							defaultValue: DEFAULT_SETTINGS.maxHeadingDepth,
							disabled: () => settings.chunkerStyle !== 'markdown-aware',
						},
					},
					{
						name: 'Skip sections by heading',
						desc: 'One regex pattern per line. Any section whose heading text matches is skipped entirely when chunking/reading -- e.g. to always skip a "Changelog" or "Notes to self" section. Only applies to the Markdown-aware chunker.',
						control: {
							type: 'textarea',
							key: 'skipSectionHeadingPatterns',
							placeholder: 'Changelog\nNotes to self',
							rows: 3,
							disabled: () => settings.chunkerStyle !== 'markdown-aware',
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Playback',
				visible,
				items: [
					{
						name: 'Default playback speed',
						desc: 'Starting speed for each read. The player view has its own speed slider to adjust playback live without changing this default.',
						control: { type: 'slider', key: 'playbackRate', min: 0.5, max: 3, step: 0.05, defaultValue: DEFAULT_SETTINGS.playbackRate },
					},
				],
			},
		];
	}

	// ------------------------------ Providers ------------------------------

	private providersTab(): SettingDefinitionItem[] {
		const visible = this.onTab('providers');

		return [
			{
				name: 'About providers',
				desc: 'A provider is a connection to a text to speech service: its type, its credentials, and how many chunks may generate at once. You can add several, including more than one of the same type (for example two ElevenLabs accounts). Narrator profiles choose which provider they use.',
				visible,
			},
			{
				type: 'list',
				heading: 'Providers',
				visible,
				emptyState: 'No providers yet. Add one with the + button.',
				addItem: { name: 'Add provider', action: () => void this.addProvider() },
				onDelete: (index) => this.deleteProvider(index),
				onReorder: (from, to) => void this.moveItem(this.settings.providers, from, to),
				items: this.settings.providers.map((provider) => this.providerPage(provider)),
			},
		];
	}

	private providerHasCredentials(provider: ProviderEntry): boolean {
		return getProviderApiKey(this.app, provider) !== null;
	}

	private providerPage(provider: ProviderEntry): SettingDefinitionPage {
		return {
			type: 'page',
			name: provider.name,
			desc: `${PROVIDER_TYPE_LABELS[provider.type]}${this.providerHasCredentials(provider) ? '' : ' (no API key set)'}`,
			status: () => (this.providerHasCredentials(provider) ? null : 'warning'),
			items: [
				{
					type: 'group',
					heading: 'Connection',
					items: [
						this.textRow('Name', 'How this provider is listed here and when choosing a provider for a profile.', () => provider.name, (value) => {
							provider.name = value.trim() || provider.name;
						}),
						this.dropdownRow('Type', 'Which text to speech service this provider connects to.', PROVIDER_TYPE_LABELS, () => provider.type, (value) =>
							void this.changeProviderType(provider, value as ProviderType),
						),
						...this.providerCredentialRows(provider),
					],
				},
				{
					type: 'group',
					heading: 'Generation',
					items: [
						this.toggleRow(
							'Generate chunks in parallel',
							'Generate more than one chunk ahead of playback at once, instead of strictly one at a time.',
							() => provider.parallelGenerationEnabled,
							(value) => {
								provider.parallelGenerationEnabled = value;
							},
						),
						this.numberRow(
							'Max parallel chunk generation',
							'How many chunks may be generating at the same time. Higher can finish long notes faster but makes more simultaneous requests (and hits rate limits sooner). Recommended: 2-5. Default: 2.',
							{
								get: () => provider.maxParallelGeneration,
								set: (value) => {
									provider.maxParallelGeneration = value;
								},
								min: 2,
								defaultValue: 2,
								disabled: () => !provider.parallelGenerationEnabled,
							},
						),
						this.numberRow(
							'Max parallel background chunk generation',
							'How many chunks may generate at once for a note continuing in the background (via the panel\'s "Send to Background" button), independent of the setting above. Kept low by default so it doesn\'t compete with an actively-playing read. Recommended: 1-3. Default: 1.',
							{
								get: () => provider.maxBackgroundParallelGeneration,
								set: (value) => {
									provider.maxBackgroundParallelGeneration = value;
								},
								min: 1,
								defaultValue: 1,
							},
						),
					],
				},
				{
					type: 'group',
					heading: 'Delete',
					items: [
						this.deleteRow('Delete provider', 'Removes this provider. Narrator profiles that use it are deleted too, after you confirm.', () => {
							const index = this.settings.providers.indexOf(provider);
							if (index !== -1) this.deleteProvider(index, () => this.closeSettingsPage());
						}),
					],
				},
			],
		};
	}

	/** A destructive button row, shown at the bottom of a provider's or profile's page. */
	private deleteRow(label: string, desc: string, onClick: () => void, disabled?: () => boolean): SettingGroupItem {
		return {
			name: label,
			desc,
			render: (setting) => {
				setting.addButton((button) => button.setButtonText(label).setDestructive().onClick(onClick));
				if (disabled) this.trackDisabled(setting, disabled);
			},
		};
	}

	/**
	 * Goes back from the open provider/profile page to its list, e.g. after deleting what the page edits.
	 * Obsidian has no public call for this, so it uses the settings modal's own and falls back to a plain
	 * re-render if that ever goes away.
	 */
	private closeSettingsPage(): void {
		const modal = (this.app as unknown as { setting?: { closePage?: () => void } }).setting;
		if (modal?.closePage) modal.closePage();
		else this.update();
	}

	/** The credential rows for a provider's type. */
	private providerCredentialRows(provider: ProviderEntry): SettingGroupItem[] {
		switch (provider.type) {
			case 'elevenlabs':
				return [
					{
						name: 'API key',
						desc: "Stored in Obsidian's secret storage, not in this plugin's settings file.",
						render: (setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el).setValue(provider.apiKeySecretId).onChange(async (value) => {
									provider.apiKeySecretId = value;
									await this.plugin.saveSettings();
									// A different key can mean a different account, with a different set of voices.
									this.voicesByProvider.delete(provider.id);
								}),
							);
						},
					},
				];
		}
	}

	private async addProvider(): Promise<void> {
		const provider = createProvider('elevenlabs', uniqueName('ElevenLabs', this.settings.providers.map((p) => p.name)));
		this.settings.providers.push(provider);
		// A provider is only useful through a profile, so it starts with one: "Default (<provider name>)".
		const profile = createProfile(provider, uniqueName(`Default (${provider.name})`, this.settings.profiles.map((p) => p.name)));
		this.settings.profiles.push(profile);
		if (!this.settings.activeProfileId) this.settings.activeProfileId = profile.id;
		await this.plugin.saveSettings();
		this.update();
	}

	private async changeProviderType(provider: ProviderEntry, type: ProviderType): Promise<void> {
		if (provider.type === type) return;
		// Mutated in place (not replaced) so an open provider page keeps editing the live entry.
		Object.assign(provider, createProvider(type, provider.name), { id: provider.id });
		// A profile's voice configuration belongs to its provider's type, so its old one no longer applies.
		for (const profile of this.settings.profiles.filter((p) => p.providerId === provider.id)) {
			profile.voice = defaultVoiceConfig(type);
		}
		await this.plugin.saveSettings();
	}

	private deleteProvider(index: number, onDeleted?: () => void): void {
		const provider = this.settings.providers[index];
		if (!provider) return;

		const dependents = this.settings.profiles.filter((profile) => profile.providerId === provider.id);
		const remove = async () => {
			this.settings.providers.splice(index, 1);
			this.settings.profiles = this.settings.profiles.filter((profile) => profile.providerId !== provider.id);
			normalizeProfileSettings(this.settings);
			await this.plugin.saveSettings();
			onDeleted?.();
			this.update();
		};

		if (dependents.length === 0) {
			void remove();
			return;
		}
		new ConfirmModal(
			this.app,
			'Delete provider?',
			`"${provider.name}" is used by ${dependents.length} narrator profile${dependents.length === 1 ? '' : 's'} (${dependents.map((p) => p.name).join(', ')}). Deleting the provider deletes ${dependents.length === 1 ? 'it' : 'them'} too.`,
			'Delete',
			() => void remove(),
		).open();
		// The list may already have dropped the row; put it back until the deletion is confirmed.
		this.update();
	}

	// ------------------------------ Profiles ------------------------------

	private profilesTab(): SettingDefinitionItem[] {
		const visible = this.onTab('profiles');
		const settings = this.settings;

		return [
			{
				name: 'About narrator profiles',
				desc: 'A narrator profile is a named way of reading: a provider, that provider\'s voice settings, and optional overrides of the reading defaults from General. Pick the active one from the dropdown in the panel.',
				visible,
			},
			{
				type: 'group',
				visible,
				items: [
					this.dropdownRow(
						'Default narrator',
						"The narrator profile used for reads. The panel's dropdown changes this too.",
						Object.fromEntries(settings.profiles.map((profile) => [profile.id, profile.name])),
						() => getActiveProfile(settings)?.id ?? '',
						(value) => {
							settings.activeProfileId = value;
						},
					),
				],
			},
			{
				type: 'list',
				heading: 'Narrator profiles',
				visible,
				emptyState: 'No narrator profiles yet. Add one with the + button.',
				addItem: { name: 'Add narrator profile', action: () => void this.addProfile() },
				onDelete: (index) => void this.deleteProfile(index),
				onReorder: (from, to) => void this.moveItem(settings.profiles, from, to),
				items: settings.profiles.map((profile) => this.profilePage(profile)),
			},
		];
	}

	private async addProfile(): Promise<void> {
		const provider = this.settings.providers[0];
		if (!provider) {
			new Notice('Add a provider first.');
			return;
		}
		const profile = createProfile(provider, uniqueName('Narrator', this.settings.profiles.map((p) => p.name)));
		this.settings.profiles.push(profile);
		if (!this.settings.activeProfileId) this.settings.activeProfileId = profile.id;
		await this.plugin.saveSettings();
		this.update();
	}

	private async deleteProfile(index: number, onDeleted?: () => void): Promise<void> {
		if (this.settings.profiles.length <= 1) {
			new Notice('Keep at least one narrator profile.');
			this.update();
			return;
		}
		this.settings.profiles.splice(index, 1);
		normalizeProfileSettings(this.settings);
		await this.plugin.saveSettings();
		onDeleted?.();
		this.update();
	}

	private profilePage(profile: NarratorProfile): SettingDefinitionPage {
		const settings = this.settings;
		const providerOptions = Object.fromEntries(settings.providers.map((provider) => [provider.id, provider.name]));

		return {
			type: 'page',
			name: profile.name,
			desc: this.profileSummary(profile),
			displayValue: () => (getActiveProfile(settings)?.id === profile.id ? 'Default' : ''),
			status: () => {
				const provider = getProvider(settings, profile.providerId);
				return provider && this.providerHasCredentials(provider) ? null : 'warning';
			},
			items: [
				{
					type: 'group',
					heading: 'Profile',
					items: [
						this.textRow('Name', 'How this profile is listed in the panel and here.', () => profile.name, (value) => {
							profile.name = value.trim() || profile.name;
						}),
						this.dropdownRow('Provider', 'Which provider generates this narrator\'s audio.', providerOptions, () => profile.providerId, (value) => {
							void this.changeProfileProvider(profile, value);
						}),
						this.toggleRow(
							'Show in panel dropdown',
							"Offer this profile in the panel's narrator dropdown. The active profile is always shown.",
							() => profile.showInDropdown,
							(value) => {
								profile.showInDropdown = value;
							},
						),
						{
							name: 'Use as default narrator',
							desc: 'Make this the active narrator profile for reads.',
							action: () => {
								settings.activeProfileId = profile.id;
								void this.plugin.saveSettings();
								new Notice(`"${profile.name}" is now the default narrator.`);
							},
						},
					],
				},
				{
					type: 'group',
					heading: 'Voice',
					items: this.voiceRows(profile),
				},
				{
					type: 'group',
					heading: 'Reading overrides',
					items: [
						{
							name: 'Inherit or override',
							desc: 'Each setting below uses the default from the General tab unless you override it here.',
						},
						...this.readingOverrideRows(profile),
					],
				},
				{
					type: 'group',
					heading: 'Delete',
					items: [
						this.deleteRow(
							'Delete narrator profile',
							'Removes this profile. You always keep at least one.',
							() => {
								const index = settings.profiles.indexOf(profile);
								if (index !== -1) void this.deleteProfile(index, () => this.closeSettingsPage());
							},
							() => settings.profiles.length <= 1,
						),
					],
				},
			],
		};
	}

	private profileSummary(profile: NarratorProfile): string {
		const provider = getProvider(this.settings, profile.providerId);
		const voice = profile.voice.type === 'elevenlabs' ? (this.voicesByProvider.get(profile.providerId)?.find((v) => v.voiceId === profile.voice.voiceId)?.name ?? profile.voice.voiceId) : '';
		return [provider?.name ?? 'No provider', voice].filter(Boolean).join(' · ');
	}

	private async changeProfileProvider(profile: NarratorProfile, providerId: string): Promise<void> {
		const provider = getProvider(this.settings, providerId);
		if (!provider || profile.providerId === providerId) return;
		const previous = getProvider(this.settings, profile.providerId);
		profile.providerId = providerId;
		if (previous?.type !== provider.type) profile.voice = defaultVoiceConfig(provider.type);
		await this.plugin.saveSettings();
		// The voice list belongs to the provider's account; reload it into the open page's dropdown.
		this.voiceRefreshers.get(profile.id)?.();
	}

	/** The voice configuration rows for a profile's provider type. */
	private voiceRows(profile: NarratorProfile): SettingGroupItem[] {
		switch (profile.voice.type) {
			case 'elevenlabs':
				return this.elevenLabsVoiceRows(profile);
		}
	}

	/**
	 * Rows read `profile.voice` and the profile's provider when they render or change, never from values
	 * captured up front: the page can stay open while the provider (or its voice config) is swapped.
	 */
	private elevenLabsVoiceRows(profile: NarratorProfile): SettingGroupItem[] {
		const voice = (): ElevenLabsVoiceConfig => {
			if (profile.voice.type !== 'elevenlabs') throw new Error('Narrator profile is not an ElevenLabs profile.');
			return profile.voice;
		};

		return [
			{
				name: 'Voice',
				desc: "Voices fetched from the provider's ElevenLabs account (first 100). Use the refresh button after adding an API key or creating new voices.",
				render: (setting) => {
					let dropdown!: DropdownComponent;
					const populate = () => {
						const provider = getProvider(this.settings, profile.providerId);
						if (provider) this.populateVoiceDropdown(dropdown, provider, voice().voiceId);
					};
					const reload = (force: boolean) => {
						const provider = getProvider(this.settings, profile.providerId);
						if (!provider) return;
						if (force) this.voicesByProvider.delete(provider.id);
						void this.ensureVoices(provider, force).then(populate);
					};

					setting.addDropdown((component) => {
						dropdown = component;
						populate();
						component.onChange(async (value) => {
							voice().voiceId = value;
							await this.plugin.saveSettings();
						});
					});
					setting.addExtraButton((button) =>
						button
							.setIcon('refresh-cw')
							.setTooltip('Refresh voice list from ElevenLabs')
							.onClick(() => reload(true)),
					);
					this.voiceRefreshers.set(profile.id, () => reload(false));
					reload(false);
				},
			},
			this.dropdownRow('Model', 'The ElevenLabs text-to-speech model to use.', ELEVENLABS_MODELS, () => voice().modelId, (value) => {
				voice().modelId = value;
			}),
			this.sliderRow(
				'Stability',
				'Lower values sound more expressive and varied; higher values sound steadier. ' +
					"On Eleven v3, this maps to ElevenLabs' Creative (low) / Natural (middle) / Robust (high) presets.",
				{ min: 0, max: 1, step: 0.05 },
				() => voice().stability,
				(value) => {
					voice().stability = value;
				},
			),
			this.sliderRow('Similarity boost', 'How closely the output should match the original voice.', { min: 0, max: 1, step: 0.05 }, () => voice().similarityBoost, (value) => {
				voice().similarityBoost = value;
			}),
		];
	}

	private populateVoiceDropdown(dropdown: DropdownComponent, provider: ProviderEntry, currentVoiceId: string): void {
		const voices = this.voicesByProvider.get(provider.id) ?? [];
		dropdown.selectEl.empty();
		if (voices.length === 0) {
			dropdown.addOption(currentVoiceId, currentVoiceId);
		} else {
			for (const voice of voices) dropdown.addOption(voice.voiceId, voice.name);
			if (!voices.some((voice) => voice.voiceId === currentVoiceId)) dropdown.addOption(currentVoiceId, `${currentVoiceId} (custom)`);
		}
		dropdown.setValue(currentVoiceId);
	}

	/** Loads (once, unless `force`) the voices available to a provider, for the profile voice dropdown. */
	private ensureVoices(provider: ProviderEntry, notify = false): Promise<void> {
		if (this.voicesByProvider.has(provider.id)) return Promise.resolve();
		const existing = this.voiceLoads.get(provider.id);
		if (existing) return existing;

		const apiKey = getProviderApiKey(this.app, provider);
		if (!apiKey) return Promise.resolve();

		const load = (async () => {
			try {
				this.voicesByProvider.set(provider.id, await listElevenLabsVoices(apiKey));
			} catch (error) {
				console.error('Note Narrator: failed to fetch ElevenLabs voices', error);
				if (notify) new Notice(`Failed to fetch voices: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.voiceLoads.delete(provider.id);
			}
		})();
		this.voiceLoads.set(provider.id, load);
		return load;
	}

	private readingOverrideRows(profile: NarratorProfile): SettingGroupItem[] {
		const overrides = profile.readingOverrides;
		const global = () => getGlobalReadingConfig(this.settings);
		const effective = (): ReadingConfig => resolveReadingConfig(global(), overrides);

		const onOff = (value: boolean) => (value ? 'On' : 'Off');
		const booleanRow = (key: 'readTitle' | 'readProperties' | 'stripMarkdownComments' | 'stripCommentDelimiters' | 'announceComments', name: string, disabled?: () => boolean) =>
			this.dropdownRow(
				name,
				'',
				{ [INHERIT]: `Use default (${onOff(global()[key])})`, on: 'On', off: 'Off' },
				() => (overrides[key] === undefined ? INHERIT : overrides[key] ? 'on' : 'off'),
				(value) => setOverride(overrides, key, value === INHERIT ? undefined : value === 'on'),
				disabled,
			);

		const depthOptions: Record<string, string> = { [INHERIT]: `Use default (${global().maxHeadingDepth})` };
		for (let depth = 1; depth <= 6; depth++) depthOptions[String(depth)] = String(depth);
		const notMarkdownAware = () => effective().chunkerStyle !== 'markdown-aware';

		return [
			booleanRow('readTitle', 'Read note title'),
			booleanRow('readProperties', 'Read note properties'),
			booleanRow('stripMarkdownComments', 'Skip Markdown comments'),
			booleanRow("stripCommentDelimiters", "Don't read comment delimiter symbols", () => effective().stripMarkdownComments),
			booleanRow('announceComments', 'Announce comments as "Comment: ..."', () => effective().stripMarkdownComments),
			this.dropdownRow(
				'Text chunker',
				'',
				{
					[INHERIT]: `Use default (${global().chunkerStyle === 'markdown-aware' ? 'Markdown-aware' : 'Sentence-only'})`,
					'markdown-aware': 'Markdown-aware',
					sentence: 'Sentence-only',
				},
				() => overrides.chunkerStyle ?? INHERIT,
				(value) => setOverride(overrides, 'chunkerStyle', value === INHERIT ? undefined : (value as ChunkerStyle)),
			),
			this.dropdownRow(
				'Max heading depth for sections',
				'Only applies to the Markdown-aware chunker.',
				depthOptions,
				() => (overrides.maxHeadingDepth === undefined ? INHERIT : String(overrides.maxHeadingDepth)),
				(value) => setOverride(overrides, 'maxHeadingDepth', value === INHERIT ? undefined : Number(value)),
				notMarkdownAware,
			),
			this.toggleRow(
				'Override skip sections by heading',
				`Off uses the default patterns from General. Only applies to the Markdown-aware chunker.`,
				() => overrides.skipSectionHeadingPatterns !== undefined,
				(value) => setOverride(overrides, 'skipSectionHeadingPatterns', value ? (overrides.skipSectionHeadingPatterns ?? global().skipSectionHeadingPatterns) : undefined),
				notMarkdownAware,
			),
			{
				name: 'Skip sections by heading',
				desc: "This profile's own list. One regex pattern per line.",
				render: (setting) => {
					setting.addTextArea((area) => {
						area.setPlaceholder('Changelog');
						area.inputEl.rows = 3;
						area.setValue(overrides.skipSectionHeadingPatterns ?? '').onChange(async (value) => {
							setOverride(overrides, 'skipSectionHeadingPatterns', value);
							await this.plugin.saveSettings();
						});
					});
					this.trackDisabled(setting, () => overrides.skipSectionHeadingPatterns === undefined || notMarkdownAware());
				},
			},
		];
	}

	// ------------------------------ Appearance ------------------------------

	private appearanceTab(): SettingDefinitionItem[] {
		const visible = this.onTab('appearance');
		const settings = this.settings;

		return [
			{
				type: 'group',
				heading: 'Panel',
				visible,
				items: [
					{
						name: 'Compact buttons',
						desc: 'Show Play Saved, Read, Cancel, and Send to Background as icon-only buttons, with the full name as a tooltip on hover/long-press, instead of icon + text. Applies at every panel size, not just narrow ones.',
						control: { type: 'toggle', key: 'compactButtons', defaultValue: DEFAULT_SETTINGS.compactButtons },
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
						desc: 'What the player view\'s time readout shows. "Full" totals the whole read across every generated chunk (marking any not-yet-generated parts as "+N parts" rather than guessing their length). "Current part" is the per-chunk-only readout. "Both" shows full totals with the current part\'s times alongside in parentheses.',
						control: {
							type: 'dropdown',
							key: 'timeDisplayMode',
							options: { full: 'Show full times', current: 'Show current part times', both: 'Show full times + current part times' },
							defaultValue: DEFAULT_SETTINGS.timeDisplayMode,
						},
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
					this.rewindSkipRow('Rewind seconds', 'How many seconds the rewind button in the player view jumps back by.', 'skipBackSeconds'),
					this.rewindSkipRow('Skip forward seconds', 'How many seconds the skip-forward button in the player view jumps ahead by.', 'skipForwardSeconds'),
				],
			},
			{
				type: 'group',
				heading: 'Highlighting',
				visible,
				items: [
					{
						name: 'Highlight while reading',
						desc: 'Highlight the currently-playing text in the editor as the note is read. The note must be open in Editing view.',
						control: { type: 'toggle', key: 'highlightWhileReading', defaultValue: DEFAULT_SETTINGS.highlightWhileReading },
					},
					{
						name: 'Highlight granularity',
						desc: 'How much text lights up at once: Chunk moves once per generated audio request; Section (Markdown-aware chunker only -- otherwise the whole note counts as one section) moves least often. Both are exact, driven by which chunk is actually playing. Sentence/word granularity would need to estimate position from elapsed playback time (no per-word timing from the TTS provider) -- left for a future milestone rather than ship something that drifts out of sync.',
						control: {
							type: 'dropdown',
							key: 'highlightGranularity',
							options: { chunk: 'Chunk (default)', section: 'Section' },
							defaultValue: DEFAULT_SETTINGS.highlightGranularity,
							disabled: () => !settings.highlightWhileReading,
						},
					},
					{
						name: 'Only highlight the section heading',
						desc: "When granularity is Section, highlight just the section's heading line instead of its whole body.",
						control: {
							type: 'toggle',
							key: 'highlightSectionTitleOnly',
							defaultValue: DEFAULT_SETTINGS.highlightSectionTitleOnly,
							disabled: () => !settings.highlightWhileReading || settings.highlightGranularity !== 'section',
						},
					},
					{
						name: 'Highlight style',
						desc: "How the active text is marked. Margin marker leaves the text untouched and shows a small speaker icon in the editor's left gutter next to it (same place line numbers show). Background/Underline mark the text itself.",
						control: {
							type: 'dropdown',
							key: 'highlightStyle',
							options: { 'margin-marker': 'Margin marker (default)', background: 'Background wash', underline: 'Underline' },
							defaultValue: DEFAULT_SETTINGS.highlightStyle,
							disabled: () => !settings.highlightWhileReading,
						},
					},
					{
						name: 'Scroll-to-current button',
						desc: 'Show a "Scroll to current section" button in the player view\'s playback controls, to scroll the note to whatever section is currently playing without affecting playback itself.',
						control: { type: 'toggle', key: 'showJumpToCurrentButtons', defaultValue: DEFAULT_SETTINGS.showJumpToCurrentButtons },
					},
				],
			},
		];
	}

	private rewindSkipRow(name: string, desc: string, key: 'skipBackSeconds' | 'skipForwardSeconds'): SettingGroupItem {
		return {
			name,
			desc: `${desc} Default: ${DEFAULT_SETTINGS[key]}s.`,
			render: (setting) => {
				setting.addDropdown((dropdown) => {
					for (const seconds of SKIP_SECONDS_OPTIONS) dropdown.addOption(String(seconds), `${seconds}s`);
					dropdown.setValue(String(this.settings[key]));
					dropdown.onChange(async (value) => {
						this.settings[key] = Number(value) as SkipSeconds;
						await this.plugin.saveSettings();
					});
				});
			},
		};
	}

	// ------------------------------ Performance ------------------------------

	private performanceTab(): SettingDefinitionItem[] {
		const visible = this.onTab('performance');
		const settings = this.settings;

		return [
			{
				name: 'Parallel generation',
				desc: 'How many chunks generate at once is set per provider, since rate limits belong to the account. See the Providers tab.',
				visible,
			},
			{
				type: 'group',
				heading: 'Starting playback',
				visible,
				items: [
					{
						name: 'Start playback immediately',
						desc: 'Start playing as soon as the first chunk is ready, instead of waiting for the whole note to finish generating first.',
						control: { type: 'toggle', key: 'startPlaybackImmediately', defaultValue: DEFAULT_SETTINGS.startPlaybackImmediately },
					},
					{
						name: 'Quick start',
						desc: 'Generate an artificially short first chunk (including the title/properties preamble, if enabled) so playback can start sooner, especially on long notes.',
						control: {
							type: 'toggle',
							key: 'quickStart',
							defaultValue: DEFAULT_SETTINGS.quickStart,
							disabled: () => !settings.startPlaybackImmediately,
						},
					},
					{
						name: 'Quick start unit',
						desc: 'Whether the quick-start first chunk is sized by word count or character count.',
						control: {
							type: 'dropdown',
							key: 'quickStartUnit',
							options: { words: 'Words', characters: 'Characters' },
							defaultValue: DEFAULT_SETTINGS.quickStartUnit,
							disabled: () => !settings.startPlaybackImmediately || !settings.quickStart,
						},
					},
					this.numberRow('Quick start word count', `Target size of the quick-start first chunk, in words. Recommended: 50-300. Default: ${DEFAULT_SETTINGS.quickStartWordCount}.`, {
						get: () => settings.quickStartWordCount,
						set: (value) => {
							settings.quickStartWordCount = value;
						},
						min: 1,
						defaultValue: DEFAULT_SETTINGS.quickStartWordCount,
						disabled: () => !settings.startPlaybackImmediately || !settings.quickStart || settings.quickStartUnit !== 'words',
					}),
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
							disabled: () => !settings.startPlaybackImmediately || !settings.quickStart || settings.quickStartUnit !== 'characters',
						},
					},
				],
			},
		];
	}

	// ------------------------------ Files ------------------------------

	private filesTab(): SettingDefinitionItem[] {
		const visible = this.onTab('files');
		const settings = this.settings;
		const savingOff = () => !settings.saveAudioFile;
		const linkingOff = () => !settings.saveAudioFile || !settings.linkAudioInNote;

		const propertyRow = (name: string, desc: string, key: keyof typeof FALLBACK_TEXT_KEYS): SettingGroupItem => ({
			name,
			desc,
			control: {
				type: 'text',
				key,
				placeholder: DEFAULT_SETTINGS[key] as string,
				defaultValue: DEFAULT_SETTINGS[key] as string,
				disabled: linkingOff,
			},
		});

		return [
			{
				type: 'group',
				heading: 'Saving audio',
				visible,
				items: [
					{
						name: 'Save generated audio to a file',
						desc: 'When enabled, also saves the audio generated by a read as an .mp3 file in the vault, and links it in the note. Disabled by default.',
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
							disabled: savingOff,
						},
					},
					{
						name: 'Custom folder path',
						desc: "Vault-relative folder to save audio files in. Created automatically if it doesn't exist.",
						control: {
							type: 'text',
							key: 'saveAudioFolderPath',
							placeholder: DEFAULT_SETTINGS.saveAudioFolderPath,
							defaultValue: DEFAULT_SETTINGS.saveAudioFolderPath,
							disabled: () => savingOff() || settings.saveAudioLocation !== 'custom-folder',
						},
					},
					{
						name: 'On regenerate',
						desc: "What to do when a note's audio already exists and is regenerated: replace the previously linked file, or keep it and create a new one.",
						control: {
							type: 'dropdown',
							key: 'saveVersioning',
							options: { replace: 'Replace existing file', keep: 'Keep old versions' },
							defaultValue: DEFAULT_SETTINGS.saveVersioning,
							disabled: linkingOff,
						},
					},
					{
						name: 'Auto-generate on open',
						desc: 'When enabled, opening a note silently (re)generates and saves its audio in the background if missing or outdated — without playing it or interrupting anything currently playing.',
						control: { type: 'toggle', key: 'autoGenerateOnOpen', defaultValue: DEFAULT_SETTINGS.autoGenerateOnOpen, disabled: linkingOff },
					},
				],
			},
			{
				type: 'group',
				heading: 'Linking in the note',
				visible,
				items: [
					{
						name: 'Link saved audio in the note',
						desc: 'Writes a link to the saved audio file into a frontmatter property on the note, and tracks whether the note has changed since — shown in the player view. On by default; turning on saving turns this on too.',
						control: { type: 'toggle', key: 'linkAudioInNote', defaultValue: DEFAULT_SETTINGS.linkAudioInNote, disabled: savingOff },
					},
					propertyRow('Link property', 'Frontmatter property the audio link is written to.', 'audioLinkProperty'),
					propertyRow('Hash property', 'Frontmatter property the content hash is written to, used to detect staleness.', 'audioHashProperty'),
					propertyRow('Path property', 'Frontmatter property the raw vault path to the audio file is written to (used internally to find it again).', 'audioPathProperty'),
					propertyRow('Timestamp property', 'Frontmatter property the generation timestamp is written to.', 'audioTimestampProperty'),
					propertyRow(
						'Narrator property',
						"Frontmatter property a fingerprint of the narrator profile's voice settings is written to. Used to detect when the selected narrator differs from the one that made the saved audio.",
						'audioVoiceProperty',
					),
					propertyRow(
						'Chunk durations property',
						"Frontmatter property each chunk's [duration, byte length] is written to. Lets the saved file be sliced back into its per-chunk parts, so Previous/Next part and highlighting/scroll-to-current work during \"Play saved\" too -- only while the note is up to date with the saved audio.",
						'audioChunkDurationsProperty',
					),
					{
						name: 'Extra properties to exclude from staleness hashing',
						desc: "Besides Note Narrator's own properties above (always excluded), also ignore these frontmatter properties when checking whether a note has changed since its audio was generated — for properties other plugins auto-update that shouldn't count as a real edit. One property key per line.",
						control: { type: 'textarea', key: 'extraStaleHashExcludedProperties', placeholder: 'last_modified', rows: 3, disabled: linkingOff },
					},
				],
			},
			{
				type: 'group',
				heading: 'Cleanup',
				visible,
				items: [
					{
						name: 'Show "clear Note Narrator files" menu item and delete button',
						desc: 'Enable the "clear Note Narrator files" item in the player view\'s ⋮ menu (top-right) and the small delete button on the saved-audio status line, both of which delete a note\'s linked audio file and remove the properties above, after confirming.',
						control: { type: 'toggle', key: 'showClearFilesButton', defaultValue: DEFAULT_SETTINGS.showClearFilesButton, disabled: linkingOff },
					},
					{
						name: 'Auto-clean up properties when saved file is missing',
						desc: "When a note's linked audio file no longer exists (moved or deleted outside Note Narrator), silently remove the properties above instead of showing a misleading \"outdated\" status.",
						control: {
							type: 'toggle',
							key: 'autoCleanupMissingAudioProperties',
							defaultValue: DEFAULT_SETTINGS.autoCleanupMissingAudioProperties,
							disabled: linkingOff,
						},
					},
				],
			},
		];
	}

	// ------------------------------ Shared helpers ------------------------------

	private async moveItem<T>(list: T[], from: number, to: number): Promise<void> {
		const [item] = list.splice(from, 1);
		if (item === undefined) return;
		list.splice(to, 0, item);
		await this.plugin.saveSettings();
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
}

/** Sets (or, when `value` is undefined, clears) one reading override. */
function setOverride<K extends keyof ReadingOverrides>(overrides: ReadingOverrides, key: K, value: ReadingOverrides[K] | undefined): void {
	if (value === undefined) delete overrides[key];
	else overrides[key] = value;
}
