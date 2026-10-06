import { describe, expect, it } from 'vitest';
import { DEFAULT_STRIP_MARKDOWN_OPTIONS, chunkByWordCount, chunkNote } from '../../src/text/text-utils';
import { computeChunkPositions, rebaseSpan, splitChunkPosition } from '../../src/text/text-position';

const STRIP_OPTIONS = DEFAULT_STRIP_MARKDOWN_OPTIONS;

describe('computeChunkPositions', () => {
	it('estimates each chunk within its own section, in order, without overlapping the next section', () => {
		const note = '## First section\nSome opening text here.\n\n## Second section\nSome closing text here.';
		const { chunks, positions } = computeChunkPositions(note, 5000, 'markdown-aware', 2, STRIP_OPTIONS, []);

		expect(chunks).toHaveLength(2);
		expect(positions).toHaveLength(2);

		const [first, second] = positions;
		expect(first?.span).not.toBeNull();
		expect(second?.span).not.toBeNull();
		// First chunk's span should sit entirely before the second section starts.
		expect(first!.span!.end).toBeLessThanOrEqual(second!.sectionSpan!.start);
		expect(second!.span!.start).toBeGreaterThanOrEqual(second!.sectionSpan!.start);

		// The raw span for each chunk should be a real slice of the note text.
		expect(note.slice(first!.sectionSpan!.start, first!.sectionSpan!.end)).toContain('First section');
		expect(note.slice(second!.sectionSpan!.start, second!.sectionSpan!.end)).toContain('Second section');
	});

	it('reports the section heading span separately from the whole section span', () => {
		const note = '## Overview\nBody text goes here.';
		const { positions } = computeChunkPositions(note, 5000, 'markdown-aware', 2, STRIP_OPTIONS, []);
		const heading = positions[0]?.sectionHeadingSpan;
		expect(heading).not.toBeNull();
		expect(note.slice(heading!.start, heading!.end)).toBe('## Overview');
	});

	it('drops chunks from a section skipped by a heading pattern', () => {
		const note = '## Overview\nKeep this.\n\n## Changelog\nDrop this.';
		const { chunks } = computeChunkPositions(note, 5000, 'markdown-aware', 2, STRIP_OPTIONS, [/changelog/i]);
		expect(chunks.join(' ')).toContain('Keep this');
		expect(chunks.join(' ')).not.toContain('Drop this');
	});

	it('treats the whole note as one section for the sentence-only style', () => {
		const note = 'First sentence. Second sentence.';
		const { positions } = computeChunkPositions(note, 5000, 'sentence', 2, STRIP_OPTIONS, []);
		expect(positions[0]?.sectionSpan).toEqual({ start: 0, end: note.length });
		expect(positions[0]?.sectionHeadingSpan).toBeNull();
	});
});

describe('computeChunkPositions with a spoken preamble', () => {
	const preamble = 'My note';
	const body = '## Overview\nThe first sentence of the note. The second sentence of the note.\n\n## Details\nMore text.';
	const note = `${preamble}\n\n${body}`;
	const preambleLength = preamble.length + 2;

	it('reads the title as part of the first section when the note starts with a heading', () => {
		const { chunks, positions } = computeChunkPositions(note, 5000, 'markdown-aware', 2, STRIP_OPTIONS, [], preambleLength);

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toMatch(/^My note\s+Overview\s+The first sentence/);
		// The heading span is still the note's own heading, not the preamble's first line.
		const heading = positions[0]?.sectionHeadingSpan;
		expect(note.slice(heading!.start, heading!.end)).toBe('## Overview');
	});

	it('gives quick start a first piece with the title and the start of the note', () => {
		const { chunks } = computeChunkPositions(note, 5000, 'markdown-aware', 2, STRIP_OPTIONS, [], preambleLength);
		const [lead] = chunkByWordCount(chunks[0] ?? '', 6);

		expect(lead).toMatch(/^My note\s+Overview\s+The first sentence/);
		expect(lead!.split(/\s+/).length).toBeLessThanOrEqual(6 + 3);
	});

	it('counts the title toward the first chunk\'s length limit', () => {
		const { chunks } = computeChunkPositions(note, 40, 'markdown-aware', 2, STRIP_OPTIONS, [], preambleLength);
		expect(chunks[0]).toContain('My note');
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
	});

	it('keeps the title on its own when the first section is skipped by heading', () => {
		const { chunks } = computeChunkPositions(note, 5000, 'markdown-aware', 2, STRIP_OPTIONS, [/overview/i], preambleLength);
		expect(chunks[0]).toBe('My note');
		expect(chunks.join(' ')).not.toContain('first sentence');
	});

	it('leaves a note that starts with text alone', () => {
		const withIntro = `${preamble}\n\nAn intro line.\n\n${body}`;
		const { chunks } = computeChunkPositions(withIntro, 5000, 'markdown-aware', 2, STRIP_OPTIONS, [], preambleLength);
		expect(chunks[0]).toMatch(/^My note\s+An intro line\.$/);
	});

	it('chunks the same way as chunkNote()', () => {
		const { chunks } = computeChunkPositions(note, 40, 'markdown-aware', 2, STRIP_OPTIONS, [], preambleLength);
		expect(chunks).toEqual(chunkNote(note, 40, 'markdown-aware', 2, STRIP_OPTIONS, [], preambleLength));
	});
});

describe('rebaseSpan', () => {
	it('shifts a span past a preamble prefix onto the file offset where the body begins', () => {
		// "Title.\n\n" is 8 chars of preamble; the body starts at rawTextOffset 8 in the read text but at
		// fileOffset 40 in the actual document (e.g. after frontmatter).
		const span = { start: 8, end: 20 };
		const rebased = rebaseSpan(span, 8, 100, 40);
		expect(rebased).toEqual({ start: 40, end: 52 });
	});

	it('returns null for a span that falls entirely within the preamble', () => {
		const span = { start: 0, end: 6 };
		expect(rebaseSpan(span, 8, 100, 40)).toBeNull();
	});

	it('clips a span that starts in the preamble but extends into the body', () => {
		const span = { start: 4, end: 12 };
		expect(rebaseSpan(span, 8, 100, 40)).toEqual({ start: 40, end: 44 });
	});
});

describe('splitChunkPosition', () => {
	it('splits a chunk position proportionally across quick-start lead/remainder pieces', () => {
		const position = { span: { start: 0, end: 100 }, sectionSpan: { start: 0, end: 100 }, sectionHeadingSpan: null };
		const pieces = splitChunkPosition(position, [10, 90]);
		expect(pieces).toHaveLength(2);
		expect(pieces[0]!.span!.start).toBe(0);
		expect(pieces[1]!.span!.end).toBe(100);
		expect(pieces[0]!.span!.end).toBeLessThan(pieces[1]!.span!.start + 1);
	});
});
