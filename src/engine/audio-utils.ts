import { AudioFormat, AudioMimeType } from '../tts/provider';
import { WAV_HEADER_BYTES, readWavFormat, wavPcmData, wrapPcmAsWav } from './wav';

/** The MIME type for a buffer of audio in `format`, e.g. for a playback Blob. */
export function audioMimeType(format: AudioFormat): AudioMimeType {
	switch (format) {
		case AudioFormat.Mp3:
			return AudioMimeType.Mp3;
		case AudioFormat.Wav:
			return AudioMimeType.Wav;
	}
}

/** Each {@link AudioFormat} by its file extension, which is its value. */
const FORMATS_BY_EXTENSION = new Map<string, AudioFormat>(Object.values(AudioFormat).map((format) => [format, format]));

/** The saved-audio format a file extension stands for, or null for one saving never writes. */
export function audioFormatForExtension(extension: string): AudioFormat | null {
	return FORMATS_BY_EXTENSION.get(extension.toLowerCase()) ?? null;
}

/**
 * Joins a read's chunk buffers into one file, and gives each chunk's byte length within it, so the file can be
 * split back into the same chunks with {@link splitAudioChunks}.
 *
 * MP3 chunks have no file-level header, so they're simply concatenated. Each WAV chunk is a whole file, with a
 * header giving its own length, so their samples go into one new WAV file instead (the chunks of one read
 * share a sample format). The first chunk's length then includes the new header, so the lengths still add up
 * to the file's size.
 */
export function joinAudioChunks(buffers: ArrayBuffer[], format: AudioFormat): { data: ArrayBuffer; byteLengths: number[] } {
	if (format === AudioFormat.Mp3 || buffers.length === 0) {
		return { data: concatBuffers(buffers), byteLengths: buffers.map((buffer) => buffer.byteLength) };
	}

	const wavFormat = readWavFormat(buffers[0]!);
	if (!wavFormat) throw new Error('The generated audio is not a valid WAV file.');
	const samples = buffers.map((buffer) => wavPcmData(buffer));
	const data = wrapPcmAsWav(concatBuffers(samples), wavFormat);
	const byteLengths = samples.map((pcm, i) => pcm.byteLength + (i === 0 ? WAV_HEADER_BYTES : 0));
	return { data, byteLengths };
}

/**
 * Splits a saved file back into its chunks' playable buffers, in order, from the byte lengths
 * {@link joinAudioChunks} gave. Null if they don't add up to the file's size: stale or mismatched metadata,
 * not safe to split by.
 */
export function splitAudioChunks(data: ArrayBuffer, byteLengths: number[], format: AudioFormat): ArrayBuffer[] | null {
	const total = byteLengths.reduce((sum, length) => sum + length, 0);
	if (total !== data.byteLength) return null;
	if (format === AudioFormat.Mp3) return sliceBuffer(data, byteLengths);

	const wavFormat = readWavFormat(data);
	if (!wavFormat || byteLengths.length === 0 || byteLengths[0]! < WAV_HEADER_BYTES) return null;
	const pcmLengths = byteLengths.map((length, i) => length - (i === 0 ? WAV_HEADER_BYTES : 0));
	return sliceBuffer(data.slice(WAV_HEADER_BYTES), pcmLengths).map((pcm) => wrapPcmAsWav(pcm, wavFormat));
}

function concatBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
	const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const buffer of buffers) {
		result.set(new Uint8Array(buffer), offset);
		offset += buffer.byteLength;
	}
	return result.buffer;
}

function sliceBuffer(data: ArrayBuffer, byteLengths: number[]): ArrayBuffer[] {
	const buffers: ArrayBuffer[] = [];
	let offset = 0;
	for (const length of byteLengths) {
		buffers.push(data.slice(offset, offset + length));
		offset += length;
	}
	return buffers;
}

/** Strips characters invalid in filenames on common filesystems. */
export function sanitizeFilenameComponent(text: string): string {
	return text.replace(/[\\/:*?"<>|]/g, '').trim();
}

/** Decodes a generated chunk's audio duration (seconds) without playing it, for whole-read time totals. */
export function decodeAudioDuration(buffer: ArrayBuffer, format: AudioFormat): Promise<number> {
	return new Promise((resolve) => {
		const blob = new Blob([buffer], { type: audioMimeType(format) });
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
