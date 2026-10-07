import { savedVoiceMatches, VoiceConfig } from '../settings/profiles';
import type { AudioLinkStatus } from './reader-types';

/**
 * How a note's saved audio compares with the note and the active narrator:
 * - 'outdated': the note changed since the audio was generated.
 * - 'other-narrator': the note hasn't changed, but the audio was made with a different narrator.
 * - 'current': up to date with both, so generating it again is a deliberate regenerate.
 * - 'unknown': no stored link or hash to compare against, and no narrator mismatch to go on.
 *
 * The one place this is decided, so the panel's Read label and its background button can't disagree.
 */
export type SavedAudioFreshness = 'outdated' | 'other-narrator' | 'current' | 'unknown';

export function savedAudioFreshness(status: AudioLinkStatus, savedVoice: string | undefined, activeVoice: VoiceConfig | null): SavedAudioFreshness {
	if (status === 'outdated') return 'outdated';
	// Audio saved without a narrator record (or with no usable narrator now) counts as made with this one.
	if (savedVoice !== undefined && activeVoice && !savedVoiceMatches(savedVoice, activeVoice)) return 'other-narrator';
	return status === 'up-to-date' ? 'current' : 'unknown';
}
