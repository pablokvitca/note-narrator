import { SecretComponent, SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';
import { ConfirmModal } from '../../ui/confirm-modal';
import { PROVIDER_TYPE_LABELS, ProviderEntry, ProviderType, createProfile, createProvider, defaultVoiceConfig, normalizeProfileSettings, uniqueName } from '../profiles';
import { SettingsSection } from '../section';

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
									this.voices.voicesByProvider.delete(provider.id);
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
}
