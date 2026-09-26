import { describe, expect, it } from 'vitest';
import { cleanVaultFolderPath } from '../../src/engine/vault-path';

describe('cleanVaultFolderPath', () => {
	it('keeps ordinary vault-relative folders', () => {
		expect(cleanVaultFolderPath('Note Narrator Audio', '.config')).toEqual({ ok: true, path: 'Note Narrator Audio' });
		expect(cleanVaultFolderPath('  a/b/c  ', '.config')).toEqual({ ok: true, path: 'a/b/c' });
	});

	it('drops leading and trailing slashes, dots segments and normalizes backslashes', () => {
		expect(cleanVaultFolderPath('/a//b/./c/', '.config')).toEqual({ ok: true, path: 'a/b/c' });
		expect(cleanVaultFolderPath('a\\b', '.config')).toEqual({ ok: true, path: 'a/b' });
	});

	it('treats an empty path as the vault root', () => {
		expect(cleanVaultFolderPath('/', '.config')).toEqual({ ok: true, path: '' });
	});

	it('rejects parent-directory segments', () => {
		expect(cleanVaultFolderPath('../outside', '.config').ok).toBe(false);
		expect(cleanVaultFolderPath('a/../../b', '.config').ok).toBe(false);
		expect(cleanVaultFolderPath('a\\..\\b', '.config').ok).toBe(false);
	});

	it('rejects drive letters', () => {
		expect(cleanVaultFolderPath('C:\\Users\\me', '.config').ok).toBe(false);
		expect(cleanVaultFolderPath('c:/x', '.config').ok).toBe(false);
	});

	it('rejects the config folder and anything under it', () => {
		expect(cleanVaultFolderPath('.config', '.config').ok).toBe(false);
		expect(cleanVaultFolderPath('/.Config/plugins', '.config').ok).toBe(false);
		expect(cleanVaultFolderPath('.config-backup', '.config').ok).toBe(true);
	});
});
