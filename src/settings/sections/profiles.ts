import { DropdownComponent, Notice, SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';
import { ChunkerStyle, findHeadingPatternIssues } from '../../text/text-utils';
import { DEFAULT_ELEVENLABS_MODEL_ID, ELEVENLABS_MODELS } from '../../tts/elevenlabs-models';
import { ElevenLabsVoiceConfig, NarratorProfile, ReadingConfig, ReadingOverrides, createProfile, defaultVoiceConfig, getActiveProfile, getProvider, normalizeProfileSettings, resolveReadingConfig, uniqueName } from '../profiles';
import { SettingsSection } from '../section';
import { getGlobalReadingConfig } from '../settings';

const INHERIT = 'inherit';

/** The Model dropdown's options: the model list, with the default marked like every other dropdown's. */
const MODEL_OPTIONS: Record<string, string> = Object.fromEntries(
	Object.entries(ELEVENLABS_MODELS).map(([id, label]) => [id, id === DEFAULT_ELEVENLABS_MODEL_ID ? `${label} (default)` : label]),
);
export class ProfilesSection extends SettingsSection {
	/** Reloads a profile's voice dropdown (keyed by profile id) after its provider changes, while its page is open. */
	private voiceRefreshers = new Map<string, () => void>();

	public definitions(): SettingDefinitionItem[] {
		this.voiceRefreshers.clear();
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
		const voice = profile.voice.type === 'elevenlabs' ? (this.voices.voicesByProvider.get(profile.providerId)?.find((v) => v.voiceId === profile.voice.voiceId)?.name ?? profile.voice.voiceId) : '';
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
						if (provider) this.voices.populateVoiceDropdown(dropdown, provider, voice().voiceId);
					};
					const reload = async (force: boolean) => {
						const provider = getProvider(this.settings, profile.providerId);
						if (!provider) return;
						if (force) this.voices.voicesByProvider.delete(provider.id);
						await this.voices.ensureVoices(provider, force);
						populate();
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
							.onClick(() => void reload(true)),
					);
					this.voiceRefreshers.set(profile.id, () => void reload(false));
					void reload(false);
				},
			},
			this.dropdownRow('Model', 'The ElevenLabs text-to-speech model to use.', MODEL_OPTIONS, () => voice().modelId, (value) => {
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

	private readingOverrideRows(profile: NarratorProfile): SettingGroupItem[] {
		const overrides = profile.readingOverrides;
		const global = () => getGlobalReadingConfig(this.settings);
		const effective = (): ReadingConfig => resolveReadingConfig(global(), overrides);

		const onOff = (value: boolean) => (value ? 'on' : 'off');
		const booleanRow = (
			key: 'readTitle' | 'skipTitleWhenMatchingHeading' | 'readProperties' | 'stripMarkdownComments' | 'stripCommentDelimiters' | 'announceComments',
			name: string,
			disabled?: () => boolean,
		) =>
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
			booleanRow('skipTitleWhenMatchingHeading', 'Skip title when it repeats the first heading', () => !effective().readTitle),
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
				desc: "This profile's own list. One regex pattern per line. Lookbehind patterns are not supported on iOS below 16.4.",
				render: (setting) => {
					const warning = setting.descEl.createDiv({ cls: 'mod-warning' });
					const showIssues = (value: string) => {
						warning.setText(
							findHeadingPatternIssues(value)
								.map((issue) => issue.message)
								.join('\n'),
						);
					};
					setting.addTextArea((area) => {
						area.setPlaceholder('Changelog');
						area.inputEl.rows = 3;
						showIssues(overrides.skipSectionHeadingPatterns ?? '');
						area.setValue(overrides.skipSectionHeadingPatterns ?? '').onChange(async (value) => {
							showIssues(value);
							setOverride(overrides, 'skipSectionHeadingPatterns', value);
							await this.plugin.saveSettings();
						});
					});
					this.trackDisabled(setting, () => overrides.skipSectionHeadingPatterns === undefined || notMarkdownAware());
				},
			},
		];
	}
}

/** Sets (or, when `value` is undefined, clears) one reading override. */
function setOverride<K extends keyof ReadingOverrides>(overrides: ReadingOverrides, key: K, value: ReadingOverrides[K] | undefined): void {
	if (value === undefined) delete overrides[key];
	else overrides[key] = value;
}
