import { Extension, StateEffect } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, gutter, GutterMarker, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField, setIcon, setTooltip } from 'obsidian';
import NoteNarratorPlugin from '../main';

/** Dispatched (as a no-op transaction) whenever the reader's playback state changes, so each open editor's decoration/gutter recomputes even though nothing in its own document changed. */
const refreshHighlight = StateEffect.define<null>();

/** Whether this transaction-carrying update was triggered by the reader (as opposed to an actual edit). */
function isReaderRefresh(update: ViewUpdate): boolean {
	return update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshHighlight)));
}

class SpeakerGutterMarker extends GutterMarker {
	toDOM(): HTMLElement {
		const el = createSpan({ cls: 'note-narrator-margin-marker' });
		setIcon(el, 'audio-lines');
		setTooltip(el, 'Currently reading aloud this section');
		return el;
	}

	eq(other: GutterMarker): boolean {
		return other instanceof SpeakerGutterMarker;
	}
}

/** A plain vertical-rule segment for a gutter line between the icon and the end of the active span -- same visual line, no icon repeated on every row. */
class MarkerContinuationGutterMarker extends GutterMarker {
	toDOM(): HTMLElement {
		return createSpan({ cls: 'note-narrator-margin-marker-line' });
	}

	eq(other: GutterMarker): boolean {
		return other instanceof MarkerContinuationGutterMarker;
	}
}

const SPEAKER_MARKER = new SpeakerGutterMarker();
const CONTINUATION_MARKER = new MarkerContinuationGutterMarker();

/** Clamps `result.span` to the document and returns it, or null if there's nothing to show (no active span, wrong file, or an empty/out-of-bounds range). Shared by the mark-decorations and the gutter so both agree on exactly the same range. */
function resolveActiveSpan(view: EditorView, plugin: NoteNarratorPlugin): { start: number; end: number } | null {
	if (!plugin.settings.highlightWhileReading) return null;

	const file = view.state.field(editorInfoField, false)?.file ?? null;
	if (!file) return null;

	const result = plugin.reader.getSpan(plugin.settings.highlightGranularity, plugin.settings.highlightSectionTitleOnly);
	if (!result || result.file.path !== file.path) return null;

	const docLength = view.state.doc.length;
	const start = Math.max(0, Math.min(result.span.start, docLength));
	const end = Math.max(start, Math.min(result.span.end, docLength));
	return end > start ? { start, end } : null;
}

/** The mark-decorations for one editor (background/underline styles only -- margin-marker is a left-gutter marker instead, see `createMarkerGutter`), or none if this editor isn't showing the note currently being read. */
function buildDecorations(view: EditorView, plugin: NoteNarratorPlugin): DecorationSet {
	if (plugin.settings.highlightStyle === 'margin-marker') return Decoration.none;

	const span = resolveActiveSpan(view, plugin);
	if (!span) return Decoration.none;

	const cls = plugin.settings.highlightStyle === 'underline' ? 'note-narrator-highlight-underline' : 'note-narrator-highlight-bg';
	return Decoration.set([Decoration.mark({ class: cls }).range(span.start, span.end)]);
}

/**
 * Registered once (in `registerEditorExtension`) but instantiated by CodeMirror per open editor. Each
 * instance listens to Note Narrator's own 'change' event (and 'highlight-refresh', for highlight settings changing) directly -- rather than relying on a doc-change
 * update, since the trigger here is external playback progress, not an edit to this document -- and
 * dispatches a no-op transaction to make CodeMirror re-run `update()` (on this extension and the gutter
 * below, which shares the same dispatched transaction) and re-read `decorations`.
 */
function createMarkPlugin(plugin: NoteNarratorPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private readonly handleReaderChange = () => {
				if (this.view.dom.isConnected) this.view.dispatch({ effects: refreshHighlight.of(null) });
			};

			constructor(private view: EditorView) {
				this.decorations = buildDecorations(view, plugin);
				plugin.reader.on('change', this.handleReaderChange);
				plugin.reader.on('highlight-refresh', this.handleReaderChange);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged || isReaderRefresh(update)) {
					this.decorations = buildDecorations(update.view, plugin);
				}
			}

			destroy(): void {
				plugin.reader.off('change', this.handleReaderChange);
				plugin.reader.off('highlight-refresh', this.handleReaderChange);
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
 *
 * The icon sits on the span's first line; every line after it through the span's last line gets a plain
 * vertical-rule marker instead, so the line drawn by CSS (see styles.css) runs from the icon down to
 * wherever the currently-playing chunk/section actually ends, rather than down the entire gutter.
 */
function createMarkerGutter(plugin: NoteNarratorPlugin): Extension {
	return gutter({
		class: 'note-narrator-marker-gutter',
		renderEmptyElements: false,
		lineMarker(view, line) {
			if (plugin.settings.highlightStyle !== 'margin-marker') return null;

			const span = resolveActiveSpan(view, plugin);
			if (!span) return null;

			const startLine = view.state.doc.lineAt(span.start);
			const endLine = view.state.doc.lineAt(Math.max(span.start, span.end - 1));
			if (line.from < startLine.from || line.from > endLine.from) return null;

			return line.from === startLine.from ? SPEAKER_MARKER : CONTINUATION_MARKER;
		},
		lineMarkerChange: (update) => update.docChanged || isReaderRefresh(update),
	});
}

export function createHighlightExtension(plugin: NoteNarratorPlugin): Extension {
	return [createMarkPlugin(plugin), createMarkerGutter(plugin)];
}
