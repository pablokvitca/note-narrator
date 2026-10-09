import { describe, expect, it } from 'vitest';
import { requestFailedError } from '../../src/tts/elevenlabs-provider';

describe('requestFailedError', () => {
	it('includes the status and a short body as is', () => {
		expect(requestFailedError(401, ' {"detail":"invalid_api_key"} ').message).toBe('ElevenLabs request failed (401): {"detail":"invalid_api_key"}');
	});

	it('cuts a long body to its first 200 characters', () => {
		const message = requestFailedError(500, 'x'.repeat(5000)).message;
		expect(message).toBe(`ElevenLabs request failed (500): ${'x'.repeat(200)}…`);
	});

	it('cuts only bodies longer than 200 characters', () => {
		expect(requestFailedError(500, 'x'.repeat(200)).message).toBe(`ElevenLabs request failed (500): ${'x'.repeat(200)}`);
		expect(requestFailedError(500, 'x'.repeat(201)).message).toBe(`ElevenLabs request failed (500): ${'x'.repeat(200)}…`);
	});

	it('leaves out an empty body', () => {
		expect(requestFailedError(502, '  ').message).toBe('ElevenLabs request failed (502)');
	});
});
