import { describe, expect, it } from 'vitest';
import {
	buildReadingPreamble,
	chunkNote,
	findHeadingPatternIssues,
	firstHeadingText,
	isHeadingSkipped,
	parseHeadingSkipPatterns,
	sectionHeadingText,
} from '../../src/text/text-utils';

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

describe('findHeadingPatternIssues', () => {
	it('reports nothing for valid patterns and blank lines', () => {
		expect(findHeadingPatternIssues('Changelog\n\n  Notes to self  \n^Draft$')).toEqual([]);
	});

	it('flags patterns that do not compile, with their line number', () => {
		const issues = findHeadingPatternIssues('ok\n(unclosed\n[bad');
		expect(issues.map((i) => [i.line, i.kind])).toEqual([
			[2, 'invalid'],
			[3, 'invalid'],
		]);
		expect(issues[0]!.message).toContain('Line 2');
	});

	it('flags lookbehind as an iOS 16.4 caveat without calling it invalid', () => {
		const issues = findHeadingPatternIssues(['(?', '<=Chapter )\\d+\n(?', '<!x)y'].join(''));
		expect(issues.map((i) => i.kind)).toEqual(['lookbehind', 'lookbehind']);
		expect(issues[0]!.message).toContain('iOS below 16.4');
	});

	it('does not treat named groups as lookbehind', () => {
		expect(findHeadingPatternIssues('(?<name>abc)')).toEqual([]);
	});
});

describe('firstHeadingText', () => {
	it('returns the first heading anywhere in the body, any level', () => {
		expect(firstHeadingText('Some text.\n\n## A Heading\n\nMore text.')).toBe('A Heading');
		expect(firstHeadingText('# Top Level')).toBe('Top Level');
		expect(firstHeadingText('###### Deep')).toBe('Deep');
	});

	it('strips inline Markdown from the heading text, same as the reader strips regular text', () => {
		expect(firstHeadingText('# **My Note**')).toBe('My Note');
		expect(firstHeadingText('# A [linked](https://example.com) heading')).toBe('A linked heading');
	});

	it('returns null when there is no heading', () => {
		expect(firstHeadingText('Just a paragraph, no heading at all.')).toBeNull();
		expect(firstHeadingText('')).toBeNull();
	});

	it('does not match a line with a # that is not a heading (no space, or mid-line)', () => {
		expect(firstHeadingText('#not-a-heading\n\nSee #tag for more.')).toBeNull();
	});
});

describe('buildReadingPreamble', () => {
	const on = { readTitle: true, readProperties: false, skipTitleWhenMatchingHeading: true };

	it('reads the title when there is no matching heading', () => {
		expect(buildReadingPreamble('My Note', undefined, '# Something Else', on)).toBe('My Note');
	});

	it('skips the title when skipTitleWhenMatchingHeading is on and it matches the first heading exactly', () => {
		expect(buildReadingPreamble('My Note', undefined, '# My Note\n\nBody.', on)).toBe('');
	});

	it('still reads the title when skipTitleWhenMatchingHeading is off, even with a matching heading', () => {
		expect(buildReadingPreamble('My Note', undefined, '# My Note', { ...on, skipTitleWhenMatchingHeading: false })).toBe('My Note');
	});

	it('reads the title when the heading only partially matches (case, punctuation, extra words)', () => {
		expect(buildReadingPreamble('My Note', undefined, '# my note', on)).toBe('My Note');
		expect(buildReadingPreamble('My Note', undefined, '# My Note!', on)).toBe('My Note');
		expect(buildReadingPreamble('My Note', undefined, '# My Note, Continued', on)).toBe('My Note');
	});

	it('matches after stripping inline Markdown from the heading', () => {
		expect(buildReadingPreamble('My Note', undefined, '# **My Note**', on)).toBe('');
	});

	it('does not affect readProperties when the title is skipped', () => {
		const result = buildReadingPreamble('My Note', { tag: 'x' }, '# My Note', { ...on, readProperties: true });
		expect(result).toContain('Properties.');
		expect(result).not.toContain('My Note ');
		expect(result.startsWith('My Note')).toBe(false);
	});
});
