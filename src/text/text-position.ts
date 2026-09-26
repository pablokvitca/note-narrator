import { ChunkerStyle, StripMarkdownOptions, chunkBySentence, isHeadingSkipped, stripMarkdown } from './text-utils';

/** A half-open character range `[start, end)` into some raw text. */
export interface RawSpan {
	start: number;
	end: number;
}

interface TrackedSection {
	text: string;
	start: number;
	end: number;
}

/** Same partitioning `chunkNote`'s markdown-aware style uses, but keeping each section's raw character range in `rawText` instead of discarding it. */
function splitIntoSectionsTracked(rawText: string, maxHeadingDepth: number): TrackedSection[] {
	const headingPattern = new RegExp(`^#{1,${Math.max(1, maxHeadingDepth)}}\\s`);
	const lines = rawText.split('\n');
	const sections: TrackedSection[] = [];
	let current: string[] = [];
	let currentStart = 0;
	let offset = 0;
	let inCodeFence = false;

	const flush = (end: number) => {
		if (current.length === 0) return;
		sections.push({ text: current.join('\n'), start: currentStart, end });
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (/^\s*```/.test(line)) inCodeFence = !inCodeFence;

		if (!inCodeFence && headingPattern.test(line) && current.length > 0) {
			flush(offset);
			current = [line];
			currentStart = offset;
		} else {
			if (current.length === 0) currentStart = offset;
			current.push(line);
		}
		offset += line.length + (i < lines.length - 1 ? 1 : 0);
	}
	flush(rawText.length);

	return sections;
}

/** Raw span of just a section's heading line (its first line, if it has one) -- for "highlight only the section title" mode. */
function headingSpan(section: TrackedSection, maxHeadingDepth: number): RawSpan | null {
	const headingPattern = new RegExp(`^#{1,${Math.max(1, maxHeadingDepth)}}\\s`);
	const firstLineEnd = section.text.indexOf('\n');
	const firstLine = firstLineEnd === -1 ? section.text : section.text.slice(0, firstLineEnd);
	if (!headingPattern.test(firstLine)) return null;
	return { start: section.start, end: section.start + firstLine.length };
}

/**
 * Estimated raw-text position of one generated chunk, for highlighting/scrolling -- never sent to the TTS
 * provider. Null fields mean the chunk couldn't be attributed to real note text (e.g. it's (part of) the
 * spoken title/properties preamble, which has no corresponding editor text).
 */
export interface ChunkPosition {
	/** This chunk's own estimated raw span. */
	span: RawSpan | null;
	/** The raw span of the whole section this chunk was drawn from. */
	sectionSpan: RawSpan | null;
	/** The raw span of just that section's heading line, if it has one. */
	sectionHeadingSpan: RawSpan | null;
}

/** Splits `pieceLengths` proportionally across `span`, by each piece's share of the total length. */
function proportionalSplit(span: RawSpan, pieceLengths: number[]): RawSpan[] {
	const spanLength = span.end - span.start;
	// +1 between pieces approximates the single space/newline chunkBySentence() rejoins sentences/chunks
	// with -- not exact (original whitespace runs are collapsed during sentence splitting), but this whole
	// scheme is already a proportional estimate, not a byte-exact mapping.
	const total = pieceLengths.reduce((sum, length) => sum + length, 0) + Math.max(0, pieceLengths.length - 1);
	if (total <= 0) return pieceLengths.map(() => ({ start: span.start, end: span.start }));

	let cursor = 0;
	return pieceLengths.map((length) => {
		const start = span.start + Math.round((cursor / total) * spanLength);
		cursor += length + 1;
		const end = span.start + Math.round((Math.min(cursor - 1, total) / total) * spanLength);
		return { start, end: Math.max(start, end) };
	});
}

/**
 * Rebuilds the chunk list `chunkNote()` would produce for TTS, alongside an estimated raw-text span for
 * each chunk (and its section) -- used only for highlighting/jump-to-current, never for what's sent to
 * the TTS provider. Kept as the canonical chunker for reads that need positions (rather than a second
 * implementation that has to be kept in sync with `chunkNote()`'s), so its chunk boundaries are exactly
 * what actually gets synthesized.
 *
 * Markdown-stripping changes text length (removing `**`, `#`, link syntax, etc.), so a chunk's raw span
 * can't be read off character-for-character. Each chunk is instead allocated a *proportional* share of
 * its section's raw span, by its share of the section's stripped-text length -- exact enough to scroll to
 * and highlight without a position-preserving rewrite of every `stripMarkdown()` rule. For the same reason
 * as `chunkMarkdownAware()`, a comment that spans a heading boundary can shift a section's raw span.
 */
export function computeChunkPositions(
	rawText: string,
	maxLength: number,
	style: ChunkerStyle,
	maxHeadingDepth: number,
	stripOptions: StripMarkdownOptions,
	skipHeadingPatterns: RegExp[],
): { chunks: string[]; positions: ChunkPosition[] } {
	const sections: TrackedSection[] =
		style === 'markdown-aware'
			? splitIntoSectionsTracked(rawText, maxHeadingDepth)
			: [{ text: rawText, start: 0, end: rawText.length }];

	const chunks: string[] = [];
	const positions: ChunkPosition[] = [];

	for (const section of sections) {
		if (style === 'markdown-aware' && isHeadingSkipped(section.text, maxHeadingDepth, skipHeadingPatterns)) continue;

		const stripped = stripMarkdown(section.text, stripOptions).trim();
		if (!stripped) continue;

		const sectionChunks = chunkBySentence(stripped, maxLength);
		const sectionSpan: RawSpan = { start: section.start, end: section.end };
		const sectionHeadingSpan = headingSpan(section, maxHeadingDepth);
		const chunkSpans = proportionalSplit(sectionSpan, sectionChunks.map((chunk) => chunk.length));

		for (let i = 0; i < sectionChunks.length; i++) {
			chunks.push(sectionChunks[i] ?? '');
			positions.push({ span: chunkSpans[i] ?? null, sectionSpan, sectionHeadingSpan });
		}
	}

	return { chunks, positions };
}

/** Splits one chunk's raw span proportionally across `pieceLengths` (e.g. quick-start's lead-in/remainder split of chunk 0). */
export function splitChunkPosition(position: ChunkPosition | undefined, pieceLengths: number[]): ChunkPosition[] {
	if (!position?.span) {
		return pieceLengths.map(() => ({ span: null, sectionSpan: position?.sectionSpan ?? null, sectionHeadingSpan: position?.sectionHeadingSpan ?? null }));
	}
	const spans = proportionalSplit(position.span, pieceLengths);
	return spans.map((span) => ({ span, sectionSpan: position.sectionSpan, sectionHeadingSpan: position.sectionHeadingSpan }));
}

/**
 * Shifts/clips a raw span computed over some larger text (e.g. a spoken preamble followed by the note
 * body) down to just the "trackable" sub-range that actually corresponds to editor content, then rebases
 * it onto that content's own offset in the document. Returns null once the span falls entirely outside
 * the trackable range (e.g. it's (part of) the preamble, which isn't in the editor at all).
 */
export function rebaseSpan(span: RawSpan | null, trackableOffset: number, trackableLength: number, fileOffset: number): RawSpan | null {
	if (!span) return null;
	const start = span.start - trackableOffset;
	const end = span.end - trackableOffset;
	if (end <= 0 || start >= trackableLength) return null;

	const clampedStart = Math.max(0, start);
	const clampedEnd = Math.min(trackableLength, end);
	if (clampedEnd <= clampedStart) return null;

	return { start: clampedStart + fileOffset, end: clampedEnd + fileOffset };
}
