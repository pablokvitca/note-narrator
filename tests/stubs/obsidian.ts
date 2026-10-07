import { parse, stringify } from 'yaml';

/**
 * Minimal runtime stand-in for the `obsidian` module in unit tests (aliased in vitest.config.ts). Only
 * covers what the modules under test touch at runtime; anything they only use as a type needs nothing.
 */

type Handler = (...args: unknown[]) => unknown;

export class Events {
	private handlers = new Map<string, Handler[]>();

	on(name: string, callback: Handler): { name: string; callback: Handler } {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]);
		return { name, callback };
	}

	trigger(name: string, ...args: unknown[]): void {
		for (const handler of this.handlers.get(name) ?? []) handler(...args);
	}
}

/** Records every notice shown, so tests can assert on user-facing messages. */
export class Notice {
	static messages: string[] = [];

	constructor(message: string) {
		Notice.messages.push(message);
	}
}

export class MarkdownView {}

/** A plugin command as registered with addCommand (only the fields the plugin uses). */
export interface StubCommand {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
}

/**
 * Runs a plugin's lifecycle without Obsidian: registrations are recorded, so tests can call the plugin's
 * commands, and unload() runs what it registered for clean-up, then onunload(), like Obsidian's Component.
 */
export class Plugin {
	readonly commands: StubCommand[] = [];
	readonly cleanups: (() => unknown)[] = [];
	private data: unknown = null;

	constructor(
		public app: unknown,
		public manifest: unknown,
	) {}

	addCommand(command: StubCommand): StubCommand {
		this.commands.push(command);
		return command;
	}

	register(cleanup: () => unknown): void {
		this.cleanups.push(cleanup);
	}

	onunload(): void {}

	unload(): void {
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		this.onunload();
	}

	registerEvent(): void {}
	registerView(): void {}
	registerEditorExtension(): void {}
	addRibbonIcon(): void {}
	addSettingTab(): void {}

	loadData(): Promise<unknown> {
		return Promise.resolve(this.data);
	}

	saveData(data: unknown): Promise<void> {
		this.data = data;
		return Promise.resolve();
	}
}

/** Every debouncer made by debounce(), so tests can check a plugin cancels them on unload. */
export const debouncers: { cancelled: boolean }[] = [];

/** Runs the callback right away (no timing in tests); `cancel` records that it was cancelled. */
export function debounce<T extends unknown[]>(callback: (...args: T) => unknown): ((...args: T) => void) & { cancel: () => void } {
	const state = { cancelled: false };
	debouncers.push(state);
	return Object.assign((...args: T) => void callback(...args), { cancel: () => void (state.cancelled = true) });
}

export function setIcon(): void {}

export class TFile {
	path = '';
	basename = '';
	extension = 'md';
}

export function normalizePath(path: string): string {
	return path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function moment(): { format: () => string; toISOString: () => string } {
	return { format: () => '2026-01-01 000000', toISOString: () => '2026-01-01T00:00:00.000Z' };
}

/** Real YAML parsing and writing (the `yaml` package), so frontmatter round-trips like it does in Obsidian. Throws on invalid YAML, like the real parser. */
export function parseYaml(text: string): unknown {
	return parse(text) as unknown;
}

export function stringifyYaml(value: unknown): string {
	return stringify(value);
}
