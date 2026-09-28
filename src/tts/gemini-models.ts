/** Gemini's text to speech models and prebuilt voices, as documented on 2026-09-28. Source: https://ai.google.dev/gemini-api/docs/generate-content/speech-generation */

/** How Google Gemini is named in the settings and in error messages. */
export const GEMINI_NAME = 'Google Gemini';

/** Gemini's two dedicated TTS models. Both take the same request/response shape; they differ in quality/cost/latency. */
export const GEMINI_MODELS: Record<string, string> = {
	'gemini-2.5-flash-preview-tts': 'Gemini 2.5 Flash TTS (preview)',
	'gemini-2.5-pro-preview-tts': 'Gemini 2.5 Pro TTS (preview)',
};

/**
 * Google documents no per-request character limit for these models, only a 32k-token context, which is far more
 * than a part should be. This keeps parts the size of ElevenLabs' until testing shows longer ones work well.
 */
export const DEFAULT_GEMINI_CHAR_LIMIT = 5000;

export const GEMINI_MODEL_CHAR_LIMITS: Record<string, number> = {
	'gemini-2.5-flash-preview-tts': DEFAULT_GEMINI_CHAR_LIMIT,
	'gemini-2.5-pro-preview-tts': DEFAULT_GEMINI_CHAR_LIMIT,
};

/** Gemini's 30 prebuilt voices, the same for every account. Their names are also their IDs in requests. */
export const GEMINI_VOICES: Record<string, string> = {
	Zephyr: 'Zephyr',
	Puck: 'Puck',
	Charon: 'Charon',
	Kore: 'Kore',
	Fenrir: 'Fenrir',
	Leda: 'Leda',
	Orus: 'Orus',
	Aoede: 'Aoede',
	Callirrhoe: 'Callirrhoe',
	Autonoe: 'Autonoe',
	Enceladus: 'Enceladus',
	Iapetus: 'Iapetus',
	Umbriel: 'Umbriel',
	Algieba: 'Algieba',
	Despina: 'Despina',
	Erinome: 'Erinome',
	Algenib: 'Algenib',
	Rasalgethi: 'Rasalgethi',
	Laomedeia: 'Laomedeia',
	Achernar: 'Achernar',
	Alnilam: 'Alnilam',
	Schedar: 'Schedar',
	Gacrux: 'Gacrux',
	Pulcherrima: 'Pulcherrima',
	Achird: 'Achird',
	Zubenelgenubi: 'Zubenelgenubi',
	Vindemiatrix: 'Vindemiatrix',
	Sadachbia: 'Sadachbia',
	Sadaltager: 'Sadaltager',
	Sulafat: 'Sulafat',
};

export const DEFAULT_GEMINI_VOICE_NAME = 'Kore';
export const DEFAULT_GEMINI_MODEL_ID = 'gemini-2.5-flash-preview-tts';
