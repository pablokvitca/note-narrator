import { App, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
import NoteNarratorPlugin from '../main';
import { AppearanceSection } from './sections/appearance';
import { FALLBACK_TEXT_KEYS, NoteNarratorSettings } from './settings';
import { FilesSection } from './sections/files';
import { GeneralSection } from './sections/general';
import { PerformanceSection } from './sections/performance';
import { ProfilesSection } from './sections/profiles';
import { ProvidersSection } from './sections/providers';
import { SettingsHost, SettingsTabId } from './section';
import { VoiceCache } from './voices';

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
	{ id: 'general', label: 'General' },
	{ id: 'providers', label: 'Providers' },
	{ id: 'profiles', label: 'Profiles' },
	{ id: 'appearance', label: 'Appearance' },
	{ id: 'performance', label: 'Performance' },
	{ id: 'files', label: 'Files' },
];

export class NoteNarratorSettingTab extends PluginSettingTab implements SettingsHost {
	readonly plugin: NoteNarratorPlugin;
	readonly voices: VoiceCache;
	activeTab: SettingsTabId = 'general';
	/** Re-applies the disabled state of imperatively rendered rows (declarative controls handle their own via `disabled`). Rebuilt on every render. */
	private disabledUpdaters: (() => void)[] = [];

	private readonly general: GeneralSection;
	private readonly providers: ProvidersSection;
	private readonly profiles: ProfilesSection;
	private readonly appearance: AppearanceSection;
	private readonly performance: PerformanceSection;
	private readonly files: FilesSection;

	constructor(app: App, plugin: NoteNarratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.voices = new VoiceCache(app);
		this.general = new GeneralSection(this);
		this.providers = new ProvidersSection(this);
		this.profiles = new ProfilesSection(this);
		this.appearance = new AppearanceSection(this);
		this.performance = new PerformanceSection(this);
		this.files = new FilesSection(this);
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
	refreshAll(): void {
		this.refreshDomState();
		for (const apply of this.disabledUpdaters) apply();
	}

	registerDisabledUpdater(apply: () => void): void {
		this.disabledUpdaters.push(apply);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		this.disabledUpdaters = [];

		return [
			{ name: 'Sections', render: (setting) => this.renderTabBar(setting) },
			...this.general.definitions(),
			...this.providers.definitions(),
			...this.profiles.definitions(),
			...this.appearance.definitions(),
			...this.performance.definitions(),
			...this.files.definitions(),
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
}
