import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Only this repo's own tests: without this, vitest also collects the copies inside
		// .claude/worktrees/ (other branches checked out by agents), inflating and mixing results.
		include: ['tests/**/*.test.ts'],
		exclude: ['node_modules/**', '.claude/**'],
	},
	resolve: {
		// The real `obsidian` package is types only (the app provides it at runtime), so tests that
		// load modules importing it at runtime get a minimal stub instead.
		alias: { obsidian: fileURLToPath(new URL('./tests/stubs/obsidian.ts', import.meta.url)) },
	},
});
