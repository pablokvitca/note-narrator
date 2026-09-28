import { describe, expect, it } from 'vitest';
import { readWavFormat, wavPcmData, wrapPcmAsWav } from '../../src/engine/wav';

/** A WAV file with an extra `LIST` chunk between `fmt ` and `data`, as some encoders write. */
function wavWithListChunk(pcm: number[]): ArrayBuffer {
	const base = new Uint8Array(wrapPcmAsWav(new Uint8Array(pcm).buffer, { sampleRate: 16000, channels: 2, bitsPerSample: 16 }));
	const list = [...'LIST'].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 9, 9, 9, 0]);
	const bytes = new Uint8Array(base.length + list.length);
	bytes.set(base.subarray(0, 36));
	bytes.set(list, 36);
	bytes.set(base.subarray(36), 36 + list.length);
	return bytes.buffer;
}

describe('wav', () => {
	it('reads back the format and samples it wrote', () => {
		const data = wrapPcmAsWav(new Uint8Array([1, 2, 3, 4]).buffer, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
		expect(readWavFormat(data)).toEqual({ sampleRate: 24000, channels: 1, bitsPerSample: 16 });
		expect([...new Uint8Array(wavPcmData(data))]).toEqual([1, 2, 3, 4]);
	});

	it('skips chunks other than fmt and data, including an odd-sized one', () => {
		const data = wavWithListChunk([5, 6, 7, 8]);
		expect(readWavFormat(data)).toEqual({ sampleRate: 16000, channels: 2, bitsPerSample: 16 });
		expect([...new Uint8Array(wavPcmData(data))]).toEqual([5, 6, 7, 8]);
	});

	it('is not fooled by data that is not a wav file', () => {
		expect(readWavFormat(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
		expect(() => wavPcmData(new Uint8Array(20).buffer)).toThrow();
	});
});
