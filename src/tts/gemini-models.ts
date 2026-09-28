/**
 * Static model and voice catalogs for Gemini's TTS models. Verified against Google's public docs and cookbook
 * as of 2026-09-28: https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
 * (that page is labelled "(Legacy)" in Google's nav in favour of a newer, more complex "Interactions API" --
 * see the long comment in gemini-provider.ts for why this implementation deliberately targets the legacy,
 * well-documented `generateContent` shape instead).
 */

/** Gemini's two dedicated TTS models. Both take the same request/response shape; they differ in quality/cost/latency. */
export const GEMINI_MODELS: Record<string, string> = {
	'gemini-2.5-flash-preview-tts': 'Gemini 2.5 Flash TTS (preview)',
	'gemini-2.5-pro-preview-tts': 'Gemini 2.5 Pro TTS (preview)',
};

/**
 * Google does not publish an explicit per-request character limit for the TTS models (unlike ElevenLabs).
 * The models do have a documented ~32k token input context window, which is far larger than a sensible
 * single-request chunk size for narration audio quality/latency anyway. This is a conservative, unverified
 * default chosen to keep chunks ElevenLabs-sized until real-world testing (with a live API key) shows it can
 * safely go higher -- flagged in the PR description for the reviewing session.
 */
export const DEFAULT_GEMINI_CHAR_LIMIT = 5000;

export const GEMINI_MODEL_CHAR_LIMITS: Record<string, number> = {
	'gemini-2.5-flash-preview-tts': DEFAULT_GEMINI_CHAR_LIMIT,
	'gemini-2.5-pro-preview-tts': DEFAULT_GEMINI_CHAR_LIMIT,
};

/**
 * Gemini TTS' 30 prebuilt voices -- a fixed set shipped with the model, not fetched per-account like
 * ElevenLabs' voice list. Names are Google's own voice identifiers (used verbatim as `voiceName` in the
 * request) and are also what's shown to the user, so id and label are the same string.
 */
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
