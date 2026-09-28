import { describe, expect, it } from 'vitest';
import { audioFormatForExtension, joinAudioChunks, splitAudioChunks } from '../../src/engine/audio-utils';
import { WAV_HEADER_BYTES, readWavFormat, wavPcmData, wrapPcmAsWav } from '../../src/engine/wav';

function bufferOf(bytes: number[]): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

const FORMAT = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };
const wav = (bytes: number[]) => wrapPcmAsWav(bufferOf(bytes), FORMAT);

describe('joinAudioChunks and splitAudioChunks', () => {
	it('concatenates mp3 chunks byte for byte, and splits them back', () => {
		const { data, byteLengths } = joinAudioChunks([bufferOf([1, 2]), bufferOf([3, 4, 5])], 'mp3');
		expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
		expect(byteLengths).toEqual([2, 3]);
		expect(splitAudioChunks(data, byteLengths, 'mp3')?.map((b) => [...new Uint8Array(b)])).toEqual([[1, 2], [3, 4, 5]]);
	});

	it('joins wav chunks into one wav file with every chunk\'s samples', () => {
		const { data, byteLengths } = joinAudioChunks([wav([1, 2]), wav([3, 4, 5, 6])], 'wav');
		expect(readWavFormat(data)).toEqual(FORMAT);
		expect([...new Uint8Array(wavPcmData(data))]).toEqual([1, 2, 3, 4, 5, 6]);
		expect(byteLengths).toEqual([WAV_HEADER_BYTES + 2, 4]);
		expect(byteLengths.reduce((a, b) => a + b)).toBe(data.byteLength);
	});

	it('splits a joined wav file back into playable wav chunks', () => {
		const { data, byteLengths } = joinAudioChunks([wav([1, 2]), wav([3, 4, 5, 6])], 'wav');
		const chunks = splitAudioChunks(data, byteLengths, 'wav');
		expect(chunks?.map((chunk) => readWavFormat(chunk))).toEqual([FORMAT, FORMAT]);
		expect(chunks?.map((chunk) => [...new Uint8Array(wavPcmData(chunk))])).toEqual([[1, 2], [3, 4, 5, 6]]);
	});

	it("won't split by lengths that don't add up to the file's size", () => {
		const { data } = joinAudioChunks([wav([1, 2])], 'wav');
		expect(splitAudioChunks(data, [3], 'wav')).toBeNull();
		expect(splitAudioChunks(bufferOf([1, 2, 3]), [1, 1], 'mp3')).toBeNull();
	});

	it('rejects wav chunks that are not wav files', () => {
		expect(() => joinAudioChunks([bufferOf([1, 2, 3])], 'wav')).toThrow();
	});

	it('returns an empty buffer for no chunks', () => {
		expect(joinAudioChunks([], 'mp3').data.byteLength).toBe(0);
	});
});

describe('audioFormatForExtension', () => {
	it('knows the formats saving writes, in any case', () => {
		expect(audioFormatForExtension('mp3')).toBe('mp3');
		expect(audioFormatForExtension('WAV')).toBe('wav');
		expect(audioFormatForExtension('md')).toBeNull();
	});
});
