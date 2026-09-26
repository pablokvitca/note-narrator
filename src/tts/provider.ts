export interface TTSProvider {
	/** Converts text to speech audio and returns the encoded audio bytes (e.g. MPEG). `isCancelled` lets a provider stop retrying once its caller gave up (e.g. the plugin unloaded). */
	synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer>;
}
