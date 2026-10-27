/** How OpenAI is named in the settings and in error messages. */
export const OPENAI_NAME = 'OpenAI';

/**
 * OpenAI's text to speech models (POST /v1/audio/speech), as of 2026-09-28. Source:
 * https://developers.openai.com/api/docs/guides/text-to-speech
 */
export const OPENAI_MODELS: Record<string, string> = {
	'gpt-4o-mini-tts': 'GPT-4o mini TTS',
	'tts-1': 'TTS-1',
	'tts-1-hd': 'TTS-1 HD',
};

/** The model a new narrator profile starts with: the only one that takes instructions. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini-tts';

/** The models that take natural-language instructions on how to speak. */
export const OPENAI_INSTRUCTION_MODELS = new Set(['gpt-4o-mini-tts']);

/**
 * OpenAI's built-in voices, shared by every model. OpenAI has no per-account voice list to fetch, so this is
 * the whole list; the API rejects a voice a model doesn't support.
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

/** The voice a new narrator profile starts with. */
export const DEFAULT_OPENAI_VOICE = 'alloy';

/**
 * The per-request character limit. TTS-1 and TTS-1 HD document 4096 characters; GPT-4o mini TTS documents 2000
 * input tokens instead, which 4096 characters stays under for typical text.
 */
export const OPENAI_CHAR_LIMIT = 4096;
