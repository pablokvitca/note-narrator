/**
 * Why a custom save folder was rejected, or the cleaned vault-relative folder path.
 * Pure (no Obsidian imports) so it can be unit tested.
 */
export type FolderPathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Validates a user-typed vault-relative folder path: no `..` segments, no drive letters, nothing inside the
 * vault's config folder. Backslashes count as separators and leading/trailing slashes are dropped (the path is
 * always relative to the vault root). An empty result means the vault root.
 */
export function cleanVaultFolderPath(input: string, configDir: string): FolderPathResult {
	const segments = input
		.trim()
		.replace(/\\/g, '/')
		.split('/')
		.map((s) => s.trim())
		.filter((s) => s !== '' && s !== '.');

	if (segments.some((s) => s === '..')) return { ok: false, reason: 'The folder path cannot contain ".." segments.' };
	if (segments.length > 0 && /^[a-zA-Z]:$/.test(segments[0]!)) return { ok: false, reason: 'The folder path must be inside the vault, not a drive path.' };

	const path = segments.join('/');
	const config = configDir.replace(/^\/+|\/+$/g, '').toLowerCase();
	if (config && (path.toLowerCase() === config || path.toLowerCase().startsWith(config + '/'))) {
		return { ok: false, reason: `The folder path cannot be inside the vault's config folder (${configDir}).` };
	}
	return { ok: true, path };
}
