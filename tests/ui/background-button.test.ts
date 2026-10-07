import { describe, expect, it } from 'vitest';
import type { GenerateInBackgroundAction } from '../../src/engine/background-job';
import { backgroundButtonSpec } from '../../src/ui/background-button';

const ALL_ACTIONS: GenerateInBackgroundAction[] = [
	'move-active',
	'already-generated',
	'playing-saved',
	'already-queued',
	'ready-in-background',
	'regenerate',
	'generate',
];

describe('backgroundButtonSpec', () => {
	it('is only clickable when it can act: moving a generating read, or (re)generating a note', () => {
		const clickable = ALL_ACTIONS.filter((action) => backgroundButtonSpec(action).onClick !== null);
		expect(clickable).toEqual(['move-active', 'regenerate', 'generate']);
		expect(backgroundButtonSpec('regenerate').onClick).toBe('generate');
		expect(backgroundButtonSpec('move-active').onClick).toBe('move');
		expect(backgroundButtonSpec('generate').onClick).toBe('generate');
	});

	it('says "Move to background" while the note\'s full read is the one playing', () => {
		expect(backgroundButtonSpec('move-active').label).toBe('Move to background');
		expect(backgroundButtonSpec('already-generated').label).toBe('Move to background');
	});

	it('says "Ready in background", with a check icon, once the note\'s background job has finished', () => {
		expect(backgroundButtonSpec('ready-in-background')).toMatchObject({ label: 'Ready in background', icon: 'check' });
	});

	it('says just "Background" when it (re)generates, with the full action in its tooltip', () => {
		for (const action of ['playing-saved', 'already-queued', 'generate', 'regenerate'] as const) {
			expect(backgroundButtonSpec(action).label).toBe('Background');
		}
		expect(backgroundButtonSpec('generate').tooltip).toMatch(/^Generate in background: /);
		expect(backgroundButtonSpec('regenerate').tooltip).toMatch(/^Regenerate in background: /);
	});

	it('explains every disabled state in its own tooltip, never with the clickable states\' text', () => {
		const disabled = ALL_ACTIONS.filter((action) => backgroundButtonSpec(action).onClick === null);
		const tooltips = disabled.map((action) => backgroundButtonSpec(action).tooltip);
		expect(new Set(tooltips).size).toBe(disabled.length);
		for (const tooltip of tooltips) {
			expect(tooltip).not.toBe(backgroundButtonSpec('move-active').tooltip);
			expect(tooltip).not.toBe(backgroundButtonSpec('generate').tooltip);
		}
	});

	it('is a disabled "Background" when no note is selected', () => {
		expect(backgroundButtonSpec(null)).toMatchObject({ label: 'Background', onClick: null });
	});
});
