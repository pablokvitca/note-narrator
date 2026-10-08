import { App, TFile, parseYaml } from 'obsidian';
import { extractFrontmatterYaml } from '../text/text-utils';

/**
 * A note's frontmatter, parsed from `content` (its full text) rather than read from the metadata cache, which
 * lags unsaved editor edits by a moment. Everything derived from one text (its spoken preamble, its staleness
 * hash) then agrees on its properties. Line endings are normalized first (a file on disk may use CRLF), and the
 * metadata cache's copy is used if the YAML doesn't parse, since Obsidian's own view of it is the best there is then.
 */
export function parseNoteFrontmatter(app: App, content: string, file: TFile | null): Record<string, unknown> {
	const yaml = extractFrontmatterYaml(content.replace(/\r\n/g, '\n'));
	if (yaml === null) return {};
	try {
		const parsed: unknown = parseYaml(yaml);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return (file && app.metadataCache.getFileCache(file)?.frontmatter) ?? {};
	}
}
