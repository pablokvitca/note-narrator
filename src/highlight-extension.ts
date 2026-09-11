import { Extension, StateEffect } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import ObsidianReaderPlugin from './main';

/** Dispatched (as a no-op transaction) whenever the reader's playback state changes, so each open editor's decoration recomputes even though nothing in its own document changed. */
const refreshHighlight = StateEffect.define<null>();

class SpeakerMarkerWidget extends WidgetType {
	toDOM(): HTMLElement {
		const el = createSpan({ cls: 'obsidian-reader-margin-marker', text: '\u{1F50A}' });
		el.setAttribute('aria-hidden', 'true');
		return el;
	}

	eq(): boolean {
		return true;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** The decorations for one editor, or none if this editor isn't showing the note currently being read. */
function buildDecorations(view: EditorView, plugin: ObsidianReaderPlugin): DecorationSet {
	if (!plugin.settings.highlightWhileReading) return Decoration.none;

	const file = view.state.field(editorInfoField, false)?.file ?? null;
	if (!file) return Decoration.none;

	const result = plugin.reader.getSpan(plugin.settings.highlightGranularity, plugin.settings.highlightSectionTitleOnly);
	if (!result || result.file.path !== file.path) return Decoration.none;

	const docLength = view.state.doc.length;
	const start = Math.max(0, Math.min(result.span.start, docLength));
	const end = Math.max(start, Math.min(result.span.end, docLength));
	if (end <= start) return Decoration.none;

	if (plugin.settings.highlightStyle === 'margin-marker') {
		// A widget rather than a marked range -- the source text stays untouched, and a small speaker icon
		// sits right after it, in the editor's right margin (see the CSS for the absolute positioning).
		return Decoration.set([Decoration.widget({ widget: new SpeakerMarkerWidget(), side: 1 }).range(end)]);
	}

	const cls = plugin.settings.highlightStyle === 'underline' ? 'obsidian-reader-highlight-underline' : 'obsidian-reader-highlight-bg';
	return Decoration.set([Decoration.mark({ class: cls }).range(start, end)]);
}

/**
 * Registered once (in `registerEditorExtension`) but instantiated by CodeMirror per open editor. Each
 * instance listens to the reader's own 'change' event directly -- rather than relying on a doc-change
 * update, since the trigger here is external playback progress, not an edit to this document -- and
 * dispatches a no-op transaction to make CodeMirror re-run `update()` and re-read `decorations`.
 */
export function createHighlightExtension(plugin: ObsidianReaderPlugin): Extension {
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
				const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshHighlight)));
				if (update.docChanged || refreshed) {
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
