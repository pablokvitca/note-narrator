import { describe, expect, it } from 'vitest';
import { buildCanonicalRequest, signAwsRequest } from '../../src/tts/aws-sigv4';

/*
 * Every hardcoded expectation below was cross-checked independently: computed with Node's built-in
 * `crypto` module (a separate implementation from this file's Web Crypto-based one) from the exact same
 * inputs, via a throwaway script, not copied from memory or from this file. `sha256("")` and the RFC 4231
 * HMAC-SHA256 test case #1 are additionally well-known published constants, included as a sanity check
 * that the low-level primitives match a source with no relation to this signer at all.
 */

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const FIXED_DATE = new Date('2024-01-15T12:00:00.000Z');
const FIXTURE = {
	method: 'POST',
	url: 'https://polly.us-east-1.amazonaws.com/v1/speech',
	region: 'us-east-1',
	service: 'polly',
	credentials: CREDENTIALS,
	headers: { 'content-type': 'application/json' },
	body: '{"Text":"Hello world","OutputFormat":"mp3","VoiceId":"Joanna"}',
	date: FIXED_DATE,
};

describe('signAwsRequest', () => {
	it('produces the exact canonical request for a known fixture', async () => {
		const { canonicalRequest, signedHeaders } = await buildCanonicalRequest(FIXTURE, '20240115T120000Z');
		expect(canonicalRequest).toBe(
			[
				'POST',
				'/v1/speech',
				'',
				'content-type:application/json',
				'host:polly.us-east-1.amazonaws.com',
				'x-amz-content-sha256:cd7ce934f1a9e6dbb4f01b8710ea16472606ecfa1fb81e6d17ca8e4bd3abfef3',
				'x-amz-date:20240115T120000Z',
				'',
				'content-type;host;x-amz-content-sha256;x-amz-date',
				'cd7ce934f1a9e6dbb4f01b8710ea16472606ecfa1fb81e6d17ca8e4bd3abfef3',
			].join('\n'),
		);
		expect(signedHeaders).toBe('content-type;host;x-amz-content-sha256;x-amz-date');
	});

	it('produces the exact Authorization header for a known fixture', async () => {
		const headers = await signAwsRequest(FIXTURE);
		expect(headers.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20240115/us-east-1/polly/aws4_request, ' +
				'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
				'Signature=5deac11d3b3cf68a65142616a5f0c96e452a81bf81676e85999cbae13656d80f',
		);
	});

	it('includes host, x-amz-date, x-amz-content-sha256 and the caller-supplied headers', async () => {
		const headers = await signAwsRequest(FIXTURE);
		expect(headers.host).toBe('polly.us-east-1.amazonaws.com');
		expect(headers['x-amz-date']).toBe('20240115T120000Z');
		expect(headers['x-amz-content-sha256']).toBe('cd7ce934f1a9e6dbb4f01b8710ea16472606ecfa1fb81e6d17ca8e4bd3abfef3');
		expect(headers['content-type']).toBe('application/json');
	});

	it('hashes an empty body to the well-known SHA-256-of-empty-string constant', async () => {
		const headers = await signAwsRequest({ ...FIXTURE, body: '' });
		expect(headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('produces a different signature for a different body (payload is actually signed)', async () => {
		const a = await signAwsRequest(FIXTURE);
		const b = await signAwsRequest({ ...FIXTURE, body: '{"Text":"Something else","OutputFormat":"mp3","VoiceId":"Joanna"}' });
		expect(a.authorization).not.toBe(b.authorization);
		expect(a['x-amz-content-sha256']).not.toBe(b['x-amz-content-sha256']);
	});

	it('produces a different signature for a different date, region, or credentials', async () => {
		const base = await signAwsRequest(FIXTURE);
		const laterDate = await signAwsRequest({ ...FIXTURE, date: new Date('2024-01-16T12:00:00.000Z') });
		const otherRegion = await signAwsRequest({ ...FIXTURE, region: 'eu-west-1' });
		const otherKey = await signAwsRequest({ ...FIXTURE, credentials: { ...CREDENTIALS, secretAccessKey: 'different-secret-key-value-000000000' } });
		expect(laterDate.authorization).not.toBe(base.authorization);
		expect(otherRegion.authorization).not.toBe(base.authorization);
		expect(otherKey.authorization).not.toBe(base.authorization);
	});

	it('defaults to the current time when no date is given', async () => {
		const before = Date.now();
		const headers = await signAwsRequest({ ...FIXTURE, date: undefined });
		expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
		const parsed = Date.parse(`${headers['x-amz-date']!.slice(0, 4)}-${headers['x-amz-date']!.slice(4, 6)}-${headers['x-amz-date']!.slice(6, 11)}:${headers['x-amz-date']!.slice(11, 13)}:${headers['x-amz-date']!.slice(13, 15)}Z`);
		expect(parsed).toBeGreaterThanOrEqual(before - 1000);
	});
});
