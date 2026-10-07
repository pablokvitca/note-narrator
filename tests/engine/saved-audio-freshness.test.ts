import { describe, expect, it } from 'vitest';
import { savedAudioFreshness } from '../../src/engine/saved-audio-freshness';
import { VoiceConfig, voiceFingerprint } from '../../src/settings/profiles';

const voice: VoiceConfig = { type: 'elevenlabs', voiceId: 'voice-1', modelId: 'eleven_flash_v2_5', stability: 0.5, similarityBoost: 0.75 };
const otherVoice: VoiceConfig = { ...voice, voiceId: 'voice-2' };

describe('savedAudioFreshness', () => {
	it('is current when the note is unchanged and the narrator matches', () => {
		expect(savedAudioFreshness('up-to-date', voiceFingerprint(voice), voice)).toBe('current');
	});

	it('counts a raw voice ID saved before profiles existed as the same narrator', () => {
		expect(savedAudioFreshness('up-to-date', 'voice-1', voice)).toBe('current');
	});

	it('is current when no narrator was recorded with the audio', () => {
		expect(savedAudioFreshness('up-to-date', undefined, voice)).toBe('current');
	});

	it('is current when there is no usable narrator to compare with', () => {
		expect(savedAudioFreshness('up-to-date', voiceFingerprint(otherVoice), null)).toBe('current');
	});

	it('is other-narrator when the note is unchanged but the narrator differs', () => {
		expect(savedAudioFreshness('up-to-date', voiceFingerprint(otherVoice), voice)).toBe('other-narrator');
	});

	it('is outdated when the note changed, whatever the narrator', () => {
		expect(savedAudioFreshness('outdated', voiceFingerprint(voice), voice)).toBe('outdated');
		expect(savedAudioFreshness('outdated', voiceFingerprint(otherVoice), voice)).toBe('outdated');
	});

	it('is other-narrator, not unknown, when no hash was stored but the narrator differs', () => {
		expect(savedAudioFreshness('none', voiceFingerprint(otherVoice), voice)).toBe('other-narrator');
	});

	it('is unknown when no hash was stored and the narrator matches', () => {
		expect(savedAudioFreshness('none', voiceFingerprint(voice), voice)).toBe('unknown');
	});
});
