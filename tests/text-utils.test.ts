import { describe, expect, it } from 'vitest';
import { chunkNote, isHeadingSkipped, parseHeadingSkipPatterns, sectionHeadingText } from '../src/text-utils';

describe('parseHeadingSkipPatterns', () => {
	it('parses one case-insensitive regex per line, skipping blanks', () => {
		const patterns = parseHeadingSkipPatterns('Changelog\n\nnotes? to self');
		expect(patterns).toHaveLength(2);
		expect(patterns[0]?.test('CHANGELOG')).toBe(true);
		expect(patterns[1]?.test('Note to self')).toBe(true);
	});

	it('silently drops an invalid pattern instead of throwing', () => {
		expect(() => parseHeadingSkipPatterns('[unterminated\nChangelog')).not.toThrow();
		const patterns = parseHeadingSkipPatterns('[unterminated\nChangelog');
		expect(patterns).toHaveLength(1);
		expect(patterns[0]?.test('Changelog')).toBe(true);
	});
});

describe('sectionHeadingText', () => {
	it('extracts the text after the heading marker', () => {
		expect(sectionHeadingText('## Changelog\nSome text.', 2)).toBe('Changelog');
	});

	it('returns null for a section with no heading (e.g. the leading section)', () => {
		expect(sectionHeadingText('Just a paragraph, no heading.', 2)).toBeNull();
	});
});

describe('isHeadingSkipped', () => {
	it('matches a heading against the compiled patterns', () => {
		const patterns = parseHeadingSkipPatterns('Changelog');
		expect(isHeadingSkipped('## Changelog\nv1.2.3', 2, patterns)).toBe(true);
		expect(isHeadingSkipped('## Overview\ntext', 2, patterns)).toBe(false);
	});

	it('never skips a heading-less section', () => {
		const patterns = parseHeadingSkipPatterns('.*');
		expect(isHeadingSkipped('Leading text before any heading.', 2, patterns)).toBe(false);
	});
});

describe('chunkNote skipHeadingPatterns', () => {
	it('drops a matching markdown-aware section entirely', () => {
		const note = '## Overview\nThe important part.\n\n## Changelog\nv1.0: initial release.';
		const withSkip = chunkNote(note, 5000, 'markdown-aware', 2, undefined, parseHeadingSkipPatterns('Changelog'));
		expect(withSkip.join(' ')).toContain('important part');
		expect(withSkip.join(' ')).not.toContain('initial release');

		const withoutSkip = chunkNote(note, 5000, 'markdown-aware', 2);
		expect(withoutSkip.join(' ')).toContain('initial release');
	});

	it('has no effect on the sentence-only chunker', () => {
		const note = '## Changelog\nv1.0: initial release.';
		const chunks = chunkNote(note, 5000, 'sentence', 2, undefined, parseHeadingSkipPatterns('Changelog'));
		expect(chunks.join(' ')).toContain('initial release');
	});
});
