export type ChunkerStyle = 'markdown-aware' | 'sentence';

const SENTENCE_MARKER = '~~NOTE-NARRATOR-SENTENCE-BREAK~~';

/** A leading YAML frontmatter block; group 1 is the YAML between its `---` fences. Shared so the two helpers below always agree. */
const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---(\n|$)/;

/** Removes a leading YAML frontmatter block, if present. */
export function stripFrontmatter(markdown: string): string {
	return markdown.replace(FRONTMATTER_BLOCK, '');
}

/** The YAML between a note's leading `---` fences (the part {@link stripFrontmatter} removes), or null when it has none. */
export function extractFrontmatterYaml(markdown: string): string | null {
	const match = FRONTMATTER_BLOCK.exec(markdown);
	return match ? (match[1] ?? '') : null;
}

export interface StripMarkdownOptions {
	/** Remove Obsidian/Markdown comments (`%% ... %%`) entirely, content included, before reading. */
	stripMarkdownComments: boolean;
	/**
	 * When a comment isn't fully removed (`stripMarkdownComments` above is off), still never read the raw
	 * `%%` delimiter symbols themselves aloud -- just the text between them, as normal prose.
	 */
	stripCommentDelimiters: boolean;
	/** When a comment isn't fully removed, prefix its (delimiter-stripped) text with "Comment: " so a listener knows it was one. */
	announceComments: boolean;
}

export const DEFAULT_STRIP_MARKDOWN_OPTIONS: StripMarkdownOptions = {
	stripMarkdownComments: true,
	stripCommentDelimiters: true,
	announceComments: true,
};

/**
 * Removes/rewrites Obsidian/Markdown comments per options. Applied to the whole note before markdown-aware
 * chunking splits it into heading-delimited sections (not just per-section inside stripMarkdown) -- a
 * comment that happens to span a heading boundary (e.g. commenting out a whole section, heading
 * included) would otherwise have its opening/closing `%%` land in different sections, leaving unmatched
 * fragments behind that neither section's own stripMarkdown() call could pair up.
 *
 * HTML comment (`<!-- ... -->`) support was removed -- see README's "Known limitations" for why -- so raw
 * HTML comments are left untouched here and read as literal text, same as any other markdown syntax we
 * don't specifically handle.
 */
function stripComments(markdown: string, options: StripMarkdownOptions): string {
	return markdown.replace(/%%([\s\S]*?)%%/g, (match: string, inner: string) => {
		if (options.stripMarkdownComments) return '';
		if (!options.stripCommentDelimiters) return match;
		const content = inner.trim();
		if (!content) return '';
		return options.announceComments ? `Comment: ${content}.` : content;
	});
}

/** Strips common Markdown syntax so TTS reads prose instead of literal symbols. */
export function stripMarkdown(markdown: string, options: StripMarkdownOptions = DEFAULT_STRIP_MARKDOWN_OPTIONS): string {
	let text = markdown.replace(/\r\n/g, '\n');

	text = stripFrontmatter(text);
	text = stripComments(text, options);
	text = text.replace(/```[\s\S]*?```/g, '');
	text = text.replace(/`([^`]+)`/g, '$1');
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
	text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/^#{1,6}\s+/gm, '');
	text = text.replace(/^\s*>\s?/gm, '');
	text = text.replace(/^\s*[-*+]\s+/gm, '');
	text = text.replace(/^\s*\d+\.\s+/gm, '');
	text = text.replace(/(\*\*\*|___)(.*?)\1/g, '$2');
	text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
	text = text.replace(/\*([^*\n]+)\*/g, '$1');
	text = text.replace(/_([^_\n]+)_/g, '$1');
	text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
	text = text.replace(/==([^=]+)==/g, '$1');

	return text;
}

/** Splits text on sentence-ending punctuation without using a lookbehind (unsupported on iOS < 16.4). */
function splitSentences(text: string): string[] {
	return text.replace(/([.!?])\s+/g, `$1${SENTENCE_MARKER}`).split(SENTENCE_MARKER);
}

/** Splits already-stripped prose into chunks no longer than maxLength, breaking on sentence boundaries where possible. */
export function chunkBySentence(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return text.trim() ? [text] : [];

	const sentences = splitSentences(text);
	const chunks: string[] = [];
	let current = '';

	for (const sentence of sentences) {
		if (sentence.length > maxLength) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			let remaining = sentence;
			while (remaining.length > maxLength) {
				let splitAt = remaining.lastIndexOf(' ', maxLength);
				if (splitAt <= 0) splitAt = maxLength;
				chunks.push(remaining.slice(0, splitAt));
				remaining = remaining.slice(splitAt).trimStart();
			}
			current = remaining;
			continue;
		}

		const candidate = current ? `${current} ${sentence}` : sentence;
		if (candidate.length > maxLength) {
			chunks.push(current);
			current = sentence;
		} else {
			current = candidate;
		}
	}

	if (current) chunks.push(current);
	return chunks;
}

function countWords(text: string): number {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Splits already-stripped prose into chunks of at most maxWords words, breaking on sentence boundaries where possible. */
export function chunkByWordCount(text: string, maxWords: number): string[] {
	if (countWords(text) <= maxWords) return text.trim() ? [text] : [];

	const sentences = splitSentences(text);
	const chunks: string[] = [];
	let current = '';
	let currentWords = 0;

	for (const sentence of sentences) {
		const sentenceWords = countWords(sentence);

		if (sentenceWords > maxWords) {
			if (current) {
				chunks.push(current);
				current = '';
				currentWords = 0;
			}
			// Hard-split the oversized sentence on word boundaries, preserving original whitespace.
			const tokens = sentence.split(/(\s+)/);
			let piece = '';
			let pieceWords = 0;
			for (const token of tokens) {
				const isWord = token.trim().length > 0;
				if (isWord && pieceWords >= maxWords) {
					chunks.push(piece.trim());
					piece = '';
					pieceWords = 0;
				}
				piece += token;
				if (isWord) pieceWords++;
			}
			current = piece.trim();
			currentWords = pieceWords;
			continue;
		}

		if (currentWords + sentenceWords > maxWords) {
			chunks.push(current);
			current = sentence;
			currentWords = sentenceWords;
		} else {
			current = current ? `${current} ${sentence}` : sentence;
			currentWords += sentenceWords;
		}
	}

	if (current) chunks.push(current);
	return chunks;
}

/** Splits raw markdown into sections at headings shallower than or equal to maxHeadingDepth (H1 = depth 1). Ignores headings inside fenced code blocks. */
function splitIntoSections(markdown: string, maxHeadingDepth: number): string[] {
	const headingPattern = new RegExp(`^#{1,${Math.max(1, maxHeadingDepth)}}\\s`);
	const lines = markdown.split('\n');
	const sections: string[] = [];
	let current: string[] = [];
	let inCodeFence = false;

	for (const line of lines) {
		if (/^\s*```/.test(line)) inCodeFence = !inCodeFence;

		if (!inCodeFence && headingPattern.test(line) && current.length > 0) {
			sections.push(current.join('\n'));
			current = [line];
		} else {
			current.push(line);
		}
	}
	if (current.length > 0) sections.push(current.join('\n'));

	return sections;
}

export interface HeadingPatternIssue {
	/** 1-based line number in the settings text. */
	line: number;
	pattern: string;
	kind: 'invalid' | 'lookbehind';
	message: string;
}

/**
 * Checks a regex-per-line settings text: lines that don't compile (they are silently skipped when reading) and
 * lookbehind patterns (`(?<=`, `(?<!`), which compile on desktop but not on iOS below 16.4. Blank lines are ignored.
 */
export function findHeadingPatternIssues(raw: string): HeadingPatternIssue[] {
	const issues: HeadingPatternIssue[] = [];
	raw.split('\n').forEach((line, i) => {
		const pattern = line.trim();
		if (!pattern) return;
		try {
			new RegExp(pattern, 'i');
		} catch (error) {
			issues.push({ line: i + 1, pattern, kind: 'invalid', message: `Line ${i + 1} is not a valid regular expression and will be skipped: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		if (/\(\?<[=!]/.test(pattern)) {
			issues.push({ line: i + 1, pattern, kind: 'lookbehind', message: `Line ${i + 1} uses a lookbehind, which is not supported on iOS below 16.4; it may be ignored on older iPhones and iPads.` });
		}
	});
	return issues;
}

/** Parses one regex-per-line settings text into compiled (case-insensitive) patterns, silently dropping invalid ones rather than blocking the whole read. */
export function parseHeadingSkipPatterns(raw: string): RegExp[] {
	const patterns: RegExp[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			patterns.push(new RegExp(trimmed, 'i'));
		} catch {
			// Invalid regex -- skip it rather than failing the whole read over one bad pattern.
		}
	}
	return patterns;
}

/** A section's heading text (the part after the `#`s), or null if it doesn't start with one -- e.g. the leading section before any heading. */
export function sectionHeadingText(sectionText: string, maxHeadingDepth: number): string | null {
	const firstLine = sectionText.split('\n', 1)[0] ?? '';
	const match = new RegExp(`^#{1,${Math.max(1, maxHeadingDepth)}}\\s+(.*)$`).exec(firstLine);
	return match ? (match[1] ?? '').trim() : null;
}

/** Whether a section's heading matches any of the "skip sections by heading" patterns -- never true for a section with no heading. */
export function isHeadingSkipped(sectionText: string, maxHeadingDepth: number, patterns: RegExp[]): boolean {
	if (patterns.length === 0) return false;
	const heading = sectionHeadingText(sectionText, maxHeadingDepth);
	return heading !== null && patterns.some((pattern) => pattern.test(heading));
}

/** Splits raw markdown by section (heading-delimited, up to maxHeadingDepth), then by sentence within each section. */
function chunkMarkdownAware(
	markdown: string,
	maxLength: number,
	maxHeadingDepth: number,
	stripOptions: StripMarkdownOptions,
	skipHeadingPatterns: RegExp[],
): string[] {
	const sections = splitIntoSections(stripComments(stripFrontmatter(markdown), stripOptions), maxHeadingDepth);
	const chunks: string[] = [];

	for (const section of sections) {
		if (isHeadingSkipped(section, maxHeadingDepth, skipHeadingPatterns)) continue;
		const stripped = stripMarkdown(section, stripOptions).trim();
		if (!stripped) continue;
		chunks.push(...chunkBySentence(stripped, maxLength));
	}

	return chunks;
}

/** Splits raw markdown/text into TTS-request-sized chunks per the given style. `skipHeadingPatterns` only applies to the markdown-aware style. */
export function chunkNote(
	rawText: string,
	maxLength: number,
	style: ChunkerStyle,
	maxHeadingDepth: number,
	stripOptions: StripMarkdownOptions = DEFAULT_STRIP_MARKDOWN_OPTIONS,
	skipHeadingPatterns: RegExp[] = [],
): string[] {
	if (style === 'markdown-aware') {
		return chunkMarkdownAware(rawText, maxLength, maxHeadingDepth, stripOptions, skipHeadingPatterns);
	}
	return chunkBySentence(stripMarkdown(rawText, stripOptions).trim(), maxLength);
}

/**
 * The note body's first heading (any level, `#` through `######`, anywhere in the body, not just at the
 * very top), with inline Markdown stripped the same way the reader strips regular text -- so
 * `# **My Note**` matches a title of `My Note`. Null if the body (already past frontmatter) has no heading.
 */
export function firstHeadingText(body: string): string | null {
	const match = /^#{1,6}[ \t]+(.+)$/m.exec(body);
	if (!match) return null;
	const text = stripMarkdown((match[1] ?? '').trim(), DEFAULT_STRIP_MARKDOWN_OPTIONS).trim();
	return text || null;
}

function formatPropertyValue(value: unknown): string {
	if (Array.isArray(value)) return value.map(formatPropertyValue).join(', ');
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

/**
 * Builds the optional spoken preamble (title, then properties) prepended before a note's content. `body`
 * (the note text after frontmatter, before any stripping) is only used for `skipTitleWhenMatchingHeading`;
 * pass an empty string if that option is off and the body isn't otherwise available.
 */
export function buildReadingPreamble(
	title: string | null,
	frontmatter: Record<string, unknown> | undefined,
	body: string,
	options: { readTitle: boolean; readProperties: boolean; skipTitleWhenMatchingHeading: boolean },
): string {
	const parts: string[] = [];

	const skipTitle = options.skipTitleWhenMatchingHeading && title !== null && title === firstHeadingText(body);
	if (options.readTitle && title && !skipTitle) {
		parts.push(title);
	}

	const propertyEntries = frontmatter ? Object.entries(frontmatter).filter(([key]) => key !== 'position') : [];
	if (options.readProperties && propertyEntries.length > 0) {
		parts.push('Properties.');
		for (const [key, value] of propertyEntries) {
			const formatted = formatPropertyValue(value);
			if (formatted) parts.push(`${key}: ${formatted}.`);
		}
		parts.push('Content.');
	}

	return parts.join(' ');
}

/** Deterministic, non-cryptographic hash (FNV-1a) used to detect whether a note's content has changed. */
export function hashText(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}
