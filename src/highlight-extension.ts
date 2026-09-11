import { Extension, StateEffect } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, gutter, GutterMarker, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import ObsidianReaderPlugin from './main';

/** Dispatched (as a no-op transaction) whenever the reader's playback state changes, so each open editor's decoration/gutter recomputes even though nothing in its own document changed. */
const refreshHighlight = StateEffect.define<null>();

/** Whether this transaction-carrying update was triggered by the reader (as opposed to an actual edit). */
function isReaderRefresh(update: ViewUpdate): boolean {
	return update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshHighlight)));
}

class SpeakerGutterMarker extends GutterMarker {
	toDOM(): HTMLElement {
		const el = createSpan({ cls: 'obsidian-reader-margin-marker', text: '\u{1F50A}' });
		el.setAttribute('aria-hidden', 'true');
		return el;
	}

	eq(other: GutterMarker): boolean {
		return other instanceof SpeakerGutterMarker;
	}
}

const SPEAKER_MARKER = new SpeakerGutterMarker();

/** The mark-decorations for one editor (background/underline styles only -- margin-marker is a left-gutter marker instead, see `createMarkerGutter`), or none if this editor isn't showing the note currently being read. */
function buildDecorations(view: EditorView, plugin: ObsidianReaderPlugin): DecorationSet {
	if (!plugin.settings.highlightWhileReading || plugin.settings.highlightStyle === 'margin-marker') return Decoration.none;

	const file = view.state.field(editorInfoField, false)?.file ?? null;
	if (!file) return Decoration.none;

	const result = plugin.reader.getSpan(plugin.settings.highlightGranularity, plugin.settings.highlightSectionTitleOnly);
	if (!result || result.file.path !== file.path) return Decoration.none;

	const docLength = view.state.doc.length;
	const start = Math.max(0, Math.min(result.span.start, docLength));
	const end = Math.max(start, Math.min(result.span.end, docLength));
	if (end <= start) return Decoration.none;

	const cls = plugin.settings.highlightStyle === 'underline' ? 'obsidian-reader-highlight-underline' : 'obsidian-reader-highlight-bg';
	return Decoration.set([Decoration.mark({ class: cls }).range(start, end)]);
}

/**
 * Registered once (in `registerEditorExtension`) but instantiated by CodeMirror per open editor. Each
 * instance listens to the reader's own 'change' event directly -- rather than relying on a doc-change
 * update, since the trigger here is external playback progress, not an edit to this document -- and
 * dispatches a no-op transaction to make CodeMirror re-run `update()` (on this extension and the gutter
 * below, which shares the same dispatched transaction) and re-read `decorations`.
 */
function createMarkPlugin(plugin: ObsidianReaderPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private readonly handleReaderChange = () => {
				if (this.view.dom.isConnected) this.view.dispatch({ effects: refreshHighlight.of(null) });
			};

			constructor(private view: EditorView) {
				this.decorations = buildDecorations(view, plugin);
				plugin.reader.on('change', this.handleReaderChange);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged || isReaderRefresh(update)) {
					this.decorations = buildDecorations(update.view, plugin);
				}
			}

			destroy(): void {
				plugin.reader.off('change', this.handleReaderChange);
			}
		},
		{ decorations: (instance) => instance.decorations },
	);
}

/**
 * Left-gutter speaker icon for the margin-marker style -- the same mechanism plugins like Git blame/diff
 * gutters use, since it's a dedicated render column that's never subject to being clipped by line-wrap
 * (unlike an inline widget positioned into the text itself). Piggybacks on `createMarkPlugin`'s dispatched
 * refresh transactions (both extensions are registered together) rather than driving its own event
 * subscription.
 */
function createMarkerGutter(plugin: ObsidianReaderPlugin): Extension {
	return gutter({
		class: 'obsidian-reader-marker-gutter',
		renderEmptyElements: false,
		lineMarker(view, line) {
			if (!plugin.settings.highlightWhileReading || plugin.settings.highlightStyle !== 'margin-marker') return null;

			const file = view.state.field(editorInfoField, false)?.file ?? null;
			if (!file) return null;

			const result = plugin.reader.getSpan(plugin.settings.highlightGranularity, plugin.settings.highlightSectionTitleOnly);
			if (!result || result.file.path !== file.path) return null;

			const docLength = view.state.doc.length;
			const pos = Math.max(0, Math.min(result.span.start, docLength));
			return pos >= line.from && pos <= line.to ? SPEAKER_MARKER : null;
		},
		lineMarkerChange: (update) => update.docChanged || isReaderRefresh(update),
	});
}

export function createHighlightExtension(plugin: ObsidianReaderPlugin): Extension {
	return [createMarkPlugin(plugin), createMarkerGutter(plugin)];
}
