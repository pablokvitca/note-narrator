import { SettingDefinitionItem } from 'obsidian';
import { DEFAULT_SETTINGS } from '../settings';
import { SettingsSection } from '../section';

export class PerformanceSection extends SettingsSection {
	public definitions(): SettingDefinitionItem[] {
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
				visible,
				items: [
					{
						name: 'Keep generating when starting another note',
						desc: 'When you start reading a different note while one is still generating, move the current one to the background instead of discarding it. Finished notes show up in the background list, ready to play.',
						control: { type: 'toggle', key: 'autoBackgroundOnSwitch', defaultValue: DEFAULT_SETTINGS.autoBackgroundOnSwitch },
					},
					this.numberRow(
						'Unsaved finished notes kept in memory',
						`How many notes finished in the background, but not saved to the vault, are kept ready to play. Finishing one more clears the oldest. 0 keeps them all. Notes with saved audio don't count: their audio is played from the vault. Default: ${DEFAULT_SETTINGS.maxUnsavedBackgroundJobs}.`,
						{
							get: () => settings.maxUnsavedBackgroundJobs,
							set: (value) => {
								settings.maxUnsavedBackgroundJobs = value;
							},
							min: 0,
							defaultValue: DEFAULT_SETTINGS.maxUnsavedBackgroundJobs,
						},
					),
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
}
