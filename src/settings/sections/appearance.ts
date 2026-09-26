import { SettingDefinitionItem, SettingGroupItem } from 'obsidian';
import { DEFAULT_SETTINGS, SKIP_SECONDS_OPTIONS, SkipSeconds } from '../settings';
import { SettingsSection } from '../section';

export class AppearanceSection extends SettingsSection {
	public definitions(): SettingDefinitionItem[] {
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
						desc: 'Show Play saved, Read, Cancel, and Background as icon-only buttons, with the full name as a tooltip on hover/long-press, instead of icon + text. Applies at every panel size, not just narrow ones.',
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
}
