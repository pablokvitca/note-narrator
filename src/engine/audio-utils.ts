import type { AudioFormat } from '../tts/provider';

/**
 * Concatenates a provider's raw audio chunks into a single buffer.
 *
 * For `'mp3'`, naive byte concatenation plays back correctly -- ElevenLabs' (and other MPEG) output has no
 * mid-stream headers to worry about. For `'wav'`, this is NOT correctly implemented: each chunk is its own
 * self-contained RIFF/WAVE file with its own header and declared data length, so byte-concatenating several
 * of them produces one file whose header only describes the first chunk -- playback beyond the first chunk's
 * data is undefined (most players will just stop, some may play garbage). A correct fix needs to re-mux the
 * PCM data of every chunk into one new WAV container, which is out of scope here; this only logs so a 'wav'
 * caller with more than one chunk doesn't fail silently.
 */
export function concatArrayBuffers(buffers: ArrayBuffer[], format: AudioFormat): ArrayBuffer {
	if (format === 'wav' && buffers.length > 1) {
		console.warn(
			'Note Narrator: concatenating multiple WAV chunks is not correctly implemented (only the first chunk\'s header is valid) -- playback past the first chunk may be corrupt.',
		);
	}

	const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const buffer of buffers) {
		result.set(new Uint8Array(buffer), offset);
		offset += buffer.byteLength;
	}
	return result.buffer;
}

/** Strips characters invalid in filenames on common filesystems. */
export function sanitizeFilenameComponent(text: string): string {
	return text.replace(/[\\/:*?"<>|]/g, '').trim();
}

/** Decodes a generated chunk's audio duration (seconds) without playing it, for whole-read time totals. */
export function decodeAudioDuration(buffer: ArrayBuffer): Promise<number> {
	return new Promise((resolve) => {
		const blob = new Blob([buffer], { type: 'audio/mpeg' });
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		const finish = (duration: number) => {
			audio.removeEventListener('loadedmetadata', onLoaded);
			audio.removeEventListener('error', onError);
			URL.revokeObjectURL(url);
			resolve(duration);
		};
		const onLoaded = () => finish(audio.duration || 0);
		const onError = () => finish(0);
		audio.addEventListener('loadedmetadata', onLoaded);
		audio.addEventListener('error', onError);
	});
}

/** Splits a saved file's bytes back into its original per-chunk buffers, in order. Null if the lengths don't add up to the file's actual size -- stale or corrupted metadata, not safe to slice by. */
export function sliceIntoChunks(data: ArrayBuffer, byteLengths: number[]): ArrayBuffer[] | null {
	const total = byteLengths.reduce((sum, length) => sum + length, 0);
	if (total !== data.byteLength) return null;

	const buffers: ArrayBuffer[] = [];
	let offset = 0;
	for (const length of byteLengths) {
		buffers.push(data.slice(offset, offset + length));
		offset += length;
	}
	return buffers;
}
