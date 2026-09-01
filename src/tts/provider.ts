export interface TTSProvider {
	/** Converts text to speech audio and returns the encoded audio bytes (e.g. MPEG). */
	synthesize(text: string): Promise<ArrayBuffer>;
}
