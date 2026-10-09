export const ELEVENLABS_MODELS: Record<string, string> = {
	eleven_v3: 'Eleven v3 (research preview)',
	eleven_multilingual_v2: 'Eleven Multilingual v2',
	eleven_flash_v2_5: 'Eleven Flash v2.5',
};

/** The model a new narrator profile starts with. */
export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';

/** ElevenLabs' documented per-request character limit for each model. */
export const ELEVENLABS_MODEL_CHAR_LIMITS: Record<string, number> = {
	eleven_v3: 5000,
	eleven_multilingual_v2: 10000,
	eleven_flash_v2_5: 40000,
};

export const DEFAULT_ELEVENLABS_CHAR_LIMIT = 5000;
