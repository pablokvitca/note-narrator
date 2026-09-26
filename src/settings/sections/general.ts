import { SettingDefinitionItem } from 'obsidian';
import { DEFAULT_SETTINGS } from '../settings';
import { SettingsSection } from '../section';

export class GeneralSection extends SettingsSection {
	public definitions(): SettingDefinitionItem[] {
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
}
