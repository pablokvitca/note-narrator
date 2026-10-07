import type { GenerateInBackgroundAction } from '../engine/background-job';

/** The panel's background button for each "Generate in background" decision; `onClick` null means disabled. */
export interface BackgroundButtonSpec {
	label: string;
	icon: string;
	tooltip: string;
	onClick: 'move' | 'generate' | null;
}

const MOVE_TO_BACKGROUND: Omit<BackgroundButtonSpec, 'onClick'> = {
	label: 'Move to background',
	icon: 'layers',
	tooltip: 'Stop playback but keep generating the rest of this note in the background, so you can jump back into it later.',
};

// Labelled just "Background": whether it generates or regenerates is clear from the rest of the panel (Read
// says "Regenerate" too), and the tooltip spells it out.
const GENERATE_IN_BACKGROUND: Omit<BackgroundButtonSpec, 'onClick'> = {
	label: 'Background',
	icon: 'layers',
	tooltip: 'Generate in background: generate this note without playing it, so you can listen to it later.',
};

const BACKGROUND_BUTTONS: Record<GenerateInBackgroundAction, BackgroundButtonSpec> = {
	'move-active': { ...MOVE_TO_BACKGROUND, onClick: 'move' },
	'already-generated': { ...MOVE_TO_BACKGROUND, tooltip: 'This note has finished generating, so there is nothing to move to the background.', onClick: null },
	'playing-saved': { ...GENERATE_IN_BACKGROUND, tooltip: 'This note is playing from its saved audio.', onClick: null },
	'already-queued': { ...GENERATE_IN_BACKGROUND, tooltip: 'This note is already in the background queue.', onClick: null },
	'ready-in-background': {
		label: 'Ready in background',
		icon: 'check',
		tooltip: 'This note finished generating in the background. Play it from its card below, or clear it from the list to generate it again.',
		onClick: null,
	},
	regenerate: {
		...GENERATE_IN_BACKGROUND,
		tooltip: 'Regenerate in background: this note\'s saved audio is up to date. Generate it again without playing it.',
		onClick: 'generate',
	},
	generate: { ...GENERATE_IN_BACKGROUND, onClick: 'generate' },
};

/** The background button for a decision, or for no selected note at all (a disabled "Background"). Pure, so it's unit-testable without the panel. */
export function backgroundButtonSpec(action: GenerateInBackgroundAction | null): BackgroundButtonSpec {
	return action ? BACKGROUND_BUTTONS[action] : { ...GENERATE_IN_BACKGROUND, onClick: null };
}
