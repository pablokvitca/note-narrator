/**
 * OpenAI's text-to-speech models (POST /v1/audio/speech), current as of 2026-09-28. Source:
 * https://developers.openai.com/api/docs/guides/text-to-speech
 */
export const OPENAI_MODELS: Record<string, string> = {
	'gpt-4o-mini-tts': 'GPT-4o mini TTS (newest, supports style instructions)',
	'tts-1': 'TTS-1 (lower latency, lower quality)',
	'tts-1-hd': 'TTS-1 HD (higher quality, higher latency)',
};

/**
 * OpenAI's built-in voices, shared across all three TTS models (the API rejects an unsupported
 * model/voice pairing itself; the plugin doesn't try to pre-filter this list per model).
 */
export const OPENAI_VOICES: Record<string, string> = {
	alloy: 'Alloy',
	ash: 'Ash',
	ballad: 'Ballad',
	cedar: 'Cedar',
	coral: 'Coral',
	echo: 'Echo',
	fable: 'Fable',
	marin: 'Marin',
	nova: 'Nova',
	onyx: 'Onyx',
	sage: 'Sage',
	shimmer: 'Shimmer',
	verse: 'Verse',
};

/**
 * OpenAI's `tts-1`/`tts-1-hd` documented per-request input limit is 4096 characters. `gpt-4o-mini-tts`
 * documents its limit in input *tokens* (2000) rather than characters, which doesn't translate to an
 * exact character count; 4096 is used as a conservative character limit for it too so chunking stays
 * safely under whatever the token limit works out to for a given language.
 */
export const OPENAI_CHAR_LIMIT = 4096;
