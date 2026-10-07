import type { SavedAudioFreshness } from '../engine/saved-audio-freshness';

/** The Read button's label once the saved audio's freshness is known, or null to leave it as "Read". Pure, so it's unit-testable without the panel. */
export function readButtonLabel(freshness: SavedAudioFreshness): string | null {
	if (freshness === 'outdated') return 'Regenerate';
	if (freshness === 'other-narrator') return 'Regenerate with new narrator';
	return null;
}
