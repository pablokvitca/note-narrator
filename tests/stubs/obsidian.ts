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
