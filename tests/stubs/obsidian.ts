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

/**
 * Just enough YAML for test frontmatter: `key: value` lines (strings, numbers, booleans, quoted strings)
 * and `- item` lists under a key. Throws on anything else, like the real parser does on invalid YAML.
 */
export function parseYaml(yaml: string): unknown {
	const result: Record<string, unknown> = {};
	let listKey: string | null = null;
	for (const line of yaml.split('\n')) {
		if (line.trim() === '') continue;
		const item = /^\s+- (.*)$/.exec(line);
		if (item && listKey) {
			(result[listKey] as unknown[]).push(parseScalar(item[1] ?? ''));
			continue;
		}
		const pair = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
		if (!pair) throw new Error(`Unsupported YAML in test stub: ${line}`);
		const key = pair[1] ?? '';
		const value = pair[2] ?? '';
		listKey = value === '' ? key : null;
		result[key] = value === '' ? [] : parseScalar(value);
	}
	return result;
}

function parseScalar(raw: string): unknown {
	const value = raw.trim();
	if (/^(["']).*\1$/.test(value)) return value.slice(1, -1);
	if (value === 'true' || value === 'false') return value === 'true';
	if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
	return value;
}
