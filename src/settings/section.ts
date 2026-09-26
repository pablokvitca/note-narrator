import { App, Setting, SettingDefinitionItem, SettingGroupItem, TextComponent } from 'obsidian';
import NoteNarratorPlugin from '../main';
import { NoteNarratorSettings } from './settings';
import { ProviderEntry } from './profiles';
import { VoiceCache } from './voices';
import { getProviderApiKey } from '../tts/registry';

export type SettingsTabId = 'general' | 'providers' | 'profiles' | 'appearance' | 'performance' | 'files';

/** What a settings section needs from the settings tab that hosts it. */
export interface SettingsHost {
	readonly app: App;
	readonly plugin: NoteNarratorPlugin;
	readonly voices: VoiceCache;
	readonly activeTab: SettingsTabId;
	/** Re-render the tab from `getSettingDefinitions()` (structure changed: rows added or removed). */
	update(): void;
	/** Re-evaluate every `visible`/`disabled` predicate in place. */
	refreshAll(): void;
	/** Register a callback that re-applies a hand-rendered row's disabled state on {@link refreshAll}. */
	registerDisabledUpdater(apply: () => void): void;
}

/**
 * Base class for one settings tab's content. Holds the row-building helpers (rows that edit fields of
 * nested objects, greyed-out handling, delete buttons) shared by every tab; each subclass returns its
 * tab's setting definitions from `definitions()`.
 */
export abstract class SettingsSection {
	constructor(protected readonly host: SettingsHost) {}

	protected get app(): App {
		return this.host.app;
	}

	protected get plugin(): NoteNarratorPlugin {
		return this.host.plugin;
	}

	protected get settings(): NoteNarratorSettings {
		return this.host.plugin.settings;
	}

	protected get voices(): VoiceCache {
		return this.host.voices;
	}

	protected update(): void {
		this.host.update();
	}

	protected refreshAll(): void {
		this.host.refreshAll();
	}

	abstract definitions(): SettingDefinitionItem[];

	/** A predicate for `visible` that is true while the given settings tab is the one showing. */
	protected onTab(id: SettingsTabId): () => boolean {
		return () => this.host.activeTab === id;
	}

	/** Greys out and blocks interaction with a row while `isDisabled()` is true, and keeps it in sync with later changes. */
	protected trackDisabled(setting: Setting, isDisabled: () => boolean): void {
		const apply = () => {
			const disabled = isDisabled();
			setting.setDisabled(disabled);
			setting.settingEl.toggleClass('note-narrator-row-disabled', disabled);
		};
		apply();
		this.host.registerDisabledUpdater(apply);
	}

	protected textRow(
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

	protected toggleRow(name: string, desc: string, get: () => boolean, set: (value: boolean) => void, disabled?: () => boolean): SettingGroupItem {
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

	protected dropdownRow(
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

	protected sliderRow(
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

	protected numberRow(
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

	protected providerHasCredentials(provider: ProviderEntry): boolean {
		return getProviderApiKey(this.app, provider) !== null;
	}

	/** A destructive button row, shown at the bottom of a provider's or profile's page. */
	protected deleteRow(label: string, desc: string, onClick: () => void, disabled?: () => boolean): SettingGroupItem {
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
	protected closeSettingsPage(): void {
		const modal = (this.app as unknown as { setting?: { closePage?: () => void } }).setting;
		if (modal?.closePage) modal.closePage();
		else this.update();
	}

	protected async moveItem<T>(list: T[], from: number, to: number): Promise<void> {
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
	protected renderNumberControlWithReset(setting: Setting, options: { get: () => number; set: (value: number) => void; min: number; defaultValue: number }): void {
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
