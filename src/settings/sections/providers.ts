import { Menu, SecretComponent, SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';
import { ConfirmModal } from '../../ui/confirm-modal';
import { PROVIDER_TYPE_LABELS, ProviderEntry, ProviderType, createProfile, createProvider, defaultVoiceConfig, normalizeProfileSettings, uniqueName } from '../profiles';
import { SettingsSection } from '../section';
import { credentialsLabel } from '../../tts/registry';
import { AWS_POLLY_REGIONS, DEFAULT_AWS_REGION } from '../../tts/aws-models';

/** The Region dropdown's options, the default marked like every other dropdown's. */
const REGION_OPTIONS: Record<string, string> = Object.fromEntries(
	Object.entries(AWS_POLLY_REGIONS).map(([id, label]) => [id, id === DEFAULT_AWS_REGION ? `${label} (default)` : label]),
);

const DOCS_URL = 'https://publish.obsidian.md/pablokvitca-plugin-note-narrator/note-narrator';

/** Each provider type's setup guide in the docs, linked from its credential rows. */
const PROVIDER_SETUP_GUIDES: Record<ProviderType, string> = {
	[ProviderType.ElevenLabs]: `${DOCS_URL}/getting-started/setting-up-elevenlabs`,
	[ProviderType.OpenAI]: `${DOCS_URL}/getting-started/setting-up-openai`,
	[ProviderType.Gemini]: `${DOCS_URL}/getting-started/setting-up-google-gemini`,
	[ProviderType.AWS]: `${DOCS_URL}/getting-started/setting-up-amazon-polly`,
};

export class ProvidersSection extends SettingsSection {
	public definitions(): SettingDefinitionItem[] {
		const visible = this.onTab('providers');

		return [
			{
				name: 'About providers',
				desc: 'A provider is a connection to a text to speech service: its type, its credentials, and how many chunks may generate at once. You can add several, including more than one of the same type (for example two ElevenLabs accounts). Narrator profiles choose which provider they use.',
				visible,
			},
			{
				type: 'list',
				visible,
				emptyState: 'No providers yet. Add one with the + button.',
				addItem: { name: 'Add provider', action: (el) => this.showAddProviderMenu(el) },
				onDelete: (index) => this.deleteProvider(index),
				onReorder: (from, to) => void this.moveItem(this.settings.providers, from, to),
				items: this.settings.providers.map((provider) => this.providerPage(provider)),
			},
		];
	}

	private providerPage(provider: ProviderEntry): SettingDefinitionPage {
		const builtName = provider.name;
		return {
			type: 'page',
			name: builtName,
			desc: `${PROVIDER_TYPE_LABELS[provider.type]}${this.providerHasCredentials(provider) ? '' : ` (no ${credentialsLabel(provider.type)} set)`}`,
			status: () => (this.providerHasCredentials(provider) ? null : 'warning'),
			items: [
				{
					// General settings at the top of the page, without a heading.
					type: 'group',
					items: [
						this.textRow(
							'Name',
							'How this provider is listed here and when choosing a provider for a profile.',
							() => provider.name,
							(value) => {
								provider.name = value.trim() || provider.name;
							},
							// The list, this page's title and the profiles' Provider dropdowns show the name it was built with.
							{ onCommit: () => this.updateIfRenamed(provider.name, builtName) },
						),
						this.dropdownRow('Type', 'Which text to speech service this provider connects to.', PROVIDER_TYPE_LABELS, () => provider.type, (value) =>
							void this.changeProviderType(provider, value as ProviderType),
						),
						...this.withSetupGuideLink(this.providerCredentialRows(provider), provider.type),
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
							'How many chunks may generate at once for a note generating in the background (via the panel\'s "Move to background" or "Background" button), independent of the setting above. Kept low by default so it doesn\'t compete with an actively playing read. Recommended: 1-3. Default: 1.',
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

	/**
	 * Adds a link to the provider type's setup guide under the first credential row's description: how to create
	 * a key with only the permissions it needs, a spending limit and an expiration date. Added when the row
	 * renders, so it shows however many times the page is opened.
	 */
	private withSetupGuideLink(rows: SettingGroupItem[], type: ProviderType): SettingGroupItem[] {
		const [first, ...rest] = rows;
		if (!first || !('render' in first) || !first.render) return rows;
		const render = first.render;
		return [
			{
				...first,
				render: (setting, group) => {
					const cleanup = render(setting, group);
					setting.descEl.createDiv().createEl('a', {
						text: `Setting up ${PROVIDER_TYPE_LABELS[type]} keys safely`,
						href: PROVIDER_SETUP_GUIDES[type],
					});
					return cleanup;
				},
			},
			...rest,
		];
	}

	/** The credential rows for a provider's type. */
	private providerCredentialRows(provider: ProviderEntry): SettingGroupItem[] {
		switch (provider.type) {
			case ProviderType.ElevenLabs:
				// A different key can mean a different account, with a different set of voices.
				return [this.apiKeyRow(provider, () => this.voices.voicesByProvider.delete(provider.id))];
			case ProviderType.OpenAI:
			case ProviderType.Gemini:
				return [this.apiKeyRow(provider)];
			case ProviderType.AWS:
				return [
					this.secretRow(
						'Access key ID',
						'For an AWS user or role allowed to use Polly (the polly:SynthesizeSpeech permission). Stored in Obsidian\'s secret storage, not in this plugin\'s settings file.',
						() => provider.accessKeyIdSecretId,
						(value) => {
							provider.accessKeyIdSecretId = value;
						},
					),
					this.secretRow(
						'Secret access key',
						"Stored in Obsidian's secret storage, not in this plugin's settings file.",
						() => provider.secretAccessKeySecretId,
						(value) => {
							provider.secretAccessKeySecretId = value;
						},
					),
					this.dropdownRow(
						'Region',
						'The AWS region Polly requests go to. Some voices and engines are only offered in some regions.',
						REGION_OPTIONS,
						() => provider.region,
						(value) => {
							provider.region = value;
						},
					),
				];
		}
	}

	private apiKeyRow(provider: ProviderEntry & { apiKeySecretId: string }, onChange?: () => void): SettingGroupItem {
		return this.secretRow(
			'API key',
			"Stored in Obsidian's secret storage, not in this plugin's settings file.",
			() => provider.apiKeySecretId,
			(value) => {
				provider.apiKeySecretId = value;
				onChange?.();
			},
		);
	}

	/** A row choosing a secret from Obsidian's secret storage; `get` and `set` are the secret's name. */
	private secretRow(name: string, desc: string, get: () => string, set: (value: string) => void): SettingGroupItem {
		return {
			name,
			desc,
			render: (setting) => {
				setting.addComponent((el) =>
					new SecretComponent(this.app, el).setValue(get()).onChange(async (value) => {
						set(value);
						await this.plugin.saveSettings();
					}),
				);
			},
		};
	}

	/** Lists the provider types under the `+` button; nothing is added until one is chosen. */
	private showAddProviderMenu(el: HTMLElement): void {
		const menu = new Menu();
		for (const [type, label] of Object.entries(PROVIDER_TYPE_LABELS) as [ProviderType, string][]) {
			menu.addItem((item) => item.setTitle(label).onClick(() => void this.addProvider(type)));
		}
		// The settings can be in a popout window, so the menu opens in the button's own document.
		const rect = el.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom }, el.ownerDocument);
	}

	private async addProvider(type: ProviderType): Promise<void> {
		const provider = createProvider(type, uniqueName(PROVIDER_TYPE_LABELS[type], this.settings.providers.map((p) => p.name)));
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
		// Mutated in place (not replaced) so an open provider page keeps editing the live entry. The old type's
		// own fields, such as its secrets' names, go.
		const replacement: Record<string, unknown> = { ...createProvider(type, provider.name), id: provider.id };
		const entry = provider as unknown as Record<string, unknown>;
		for (const key of Object.keys(entry)) if (!(key in replacement)) delete entry[key];
		Object.assign(entry, replacement);
		// A profile's voice configuration belongs to its provider's type, so its old one no longer applies.
		for (const profile of this.settings.profiles.filter((p) => p.providerId === provider.id)) {
			profile.voice = defaultVoiceConfig(type);
		}
		await this.plugin.saveSettings();
		// Another type has other credential rows (and its profiles other voice rows).
		this.update();
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
}
