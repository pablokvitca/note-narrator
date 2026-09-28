import { describe, expect, it, vi } from 'vitest';
import { concatArrayBuffers } from '../../src/engine/audio-utils';

function bufferOf(bytes: number[]): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

describe('concatArrayBuffers', () => {
	it('concatenates mp3 chunks byte-for-byte in order', () => {
		const result = concatArrayBuffers([bufferOf([1, 2]), bufferOf([3, 4, 5])], 'mp3');
		expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
	});

	it('concatenates a single wav chunk without warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const result = concatArrayBuffers([bufferOf([1, 2, 3])], 'wav');
		expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('warns when concatenating more than one wav chunk (known-broken multi-chunk WAV output)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const result = concatArrayBuffers([bufferOf([1, 2]), bufferOf([3, 4])], 'wav');
		// Still concatenates (best-effort) -- the warning is the only behavior change for this known-broken case.
		expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('returns an empty buffer for no chunks', () => {
		const result = concatArrayBuffers([], 'mp3');
		expect(result.byteLength).toBe(0);
	});
});
