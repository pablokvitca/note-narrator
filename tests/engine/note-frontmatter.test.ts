import { describe, expect, it } from 'vitest';
import type { App, TFile } from 'obsidian';
import { parseNoteFrontmatter } from '../../src/engine/note-frontmatter';

/** Test doubles only implement what parseNoteFrontmatter touches. */
function fake<T>(value: object): T {
	return value as T;
}

const note = fake<TFile>({ path: 'Note.md' });
const appWithCache = (frontmatter: Record<string, unknown> | undefined) => fake<App>({ metadataCache: { getFileCache: () => ({ frontmatter }) } });

describe('parseNoteFrontmatter', () => {
	it('parses the properties from the text, not the metadata cache', () => {
		expect(parseNoteFrontmatter(appWithCache({ status: 'draft' }), '---\nstatus: final\n---\nBody', note)).toEqual({ status: 'final' });
	});

	it('is empty for a note without frontmatter', () => {
		expect(parseNoteFrontmatter(appWithCache({ status: 'draft' }), 'Body', note)).toEqual({});
	});

	it('reads a file saved with CRLF line endings', () => {
		expect(parseNoteFrontmatter(appWithCache(undefined), '---\r\nstatus: final\r\n---\r\nBody', note)).toEqual({ status: 'final' });
	});

	it('falls back to the metadata cache when the YAML does not parse', () => {
		expect(parseNoteFrontmatter(appWithCache({ status: 'draft' }), '---\nstatus: [unclosed\n---\nBody', note)).toEqual({ status: 'draft' });
	});

	it('is empty when the YAML does not parse and there is no file to look up', () => {
		expect(parseNoteFrontmatter(appWithCache({ status: 'draft' }), '---\nstatus: [unclosed\n---\nBody', null)).toEqual({});
	});
});
