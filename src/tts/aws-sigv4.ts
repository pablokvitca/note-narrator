/*
 * A from-scratch implementation of AWS Signature Version 4 request signing, using only Web Crypto
 * (`crypto.subtle`, available in both Electron and Obsidian's mobile webview). No AWS SDK: pulling in
 * `@aws-sdk/*` would bloat the plugin bundle far more than an Obsidian plugin should for one feature, and
 * esbuild's external list here only covers `obsidian`, `electron`, the CodeMirror/Lezer packages Obsidian
 * itself provides, and Node builtins -- not AWS's SDK.
 *
 * Follows AWS's documented signing process exactly:
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
 * https://docs.aws.amazon.com/general/latest/gr/reference_sigv-signing-elements.html
 */

export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

export interface SigV4SignInput {
	method: string;
	/** Full request URL, e.g. `https://polly.us-east-1.amazonaws.com/v1/speech`. Any query string is signed too. */
	url: string;
	region: string;
	/** AWS service signing name, e.g. `polly`. */
	service: string;
	credentials: SigV4Credentials;
	/** Extra headers to include in the request and the signature (beyond `host`, `x-amz-date`, `x-amz-content-sha256`, which are always added). Keys are case-insensitive. */
	headers?: Record<string, string>;
	/** Raw request body. Pass `''` for a request with no body. */
	body: string;
	/** Defaults to `new Date()`; overridable so signing is deterministic in tests. */
	date?: Date;
}

/** The exact headers to send with the request -- including `Authorization`, `X-Amz-Date`, `X-Amz-Content-Sha256` and `Host` -- lower-cased since HTTP header names are case-insensitive. */
export type SignedHeaders = Record<string, string>;

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** AWS's own URI-encoding rules (RFC 3986 unreserved set, `%`-encoded uppercase hex, space as `%20` not `+`). Standard platform `encodeURIComponent` is close but doesn't match exactly (e.g. it leaves `!'()*` unescaped), so AWS explicitly recommends writing this by hand rather than relying on it. */
function awsUriEncode(value: string, encodeSlash = true): string {
	let result = '';
	for (const byte of new TextEncoder().encode(value)) {
		const char = String.fromCharCode(byte);
		if (UNRESERVED.test(char)) {
			result += char;
		} else if (char === '/' && !encodeSlash) {
			result += char;
		} else {
			result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
	}
	return result;
}

/** The canonical URI is the URL-encoded absolute path, `/`-segments left un-encoded (only encode within each segment). */
function canonicalUri(pathname: string): string {
	const path = pathname || '/';
	return path
		.split('/')
		.map((segment) => awsUriEncode(segment))
		.join('/');
}

/** Query parameters URI-encoded individually, then sorted by encoded key (AWS's canonical query string). */
function canonicalQueryString(searchParams: URLSearchParams): string {
	const pairs: [string, string][] = [];
	for (const [key, value] of searchParams.entries()) pairs.push([awsUriEncode(key), awsUriEncode(value)]);
	pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/** Collapses internal whitespace runs to a single space and trims the ends, per AWS's canonical header value rules. */
function trimHeaderValue(value: string): string {
	return value.trim().replace(/\s+/g, ' ');
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function sha256Hex(data: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
	return toHex(digest);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function hmacSha256Hex(key: ArrayBuffer | Uint8Array, data: string): Promise<string> {
	return toHex(await hmacSha256(key, data));
}

/** `YYYYMMDDTHHMMSSZ`, the ISO 8601 basic-format timestamp SigV4 requires (not the extended format `Date#toISOString()` produces). */
function toAmzDate(date: Date): string {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Derives the final HMAC-SHA256 signing key by chaining four keyed-hash operations over the date, region,
 * service and a literal terminator -- so the key is scoped to exactly one day/region/service, not reusable
 * beyond that.
 */
async function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
	const encoder = new TextEncoder();
	const kDate = await hmacSha256(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
	const kRegion = await hmacSha256(kDate, region);
	const kService = await hmacSha256(kRegion, service);
	return hmacSha256(kService, 'aws4_request');
}

/** Exported for testing: the exact "canonical request" string SigV4 hashes and signs. */
export async function buildCanonicalRequest(input: SigV4SignInput, amzDate: string): Promise<{ canonicalRequest: string; signedHeaders: string; headersToSend: SignedHeaders }> {
	const url = new URL(input.url);
	const payloadHash = await sha256Hex(input.body);

	const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
	for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;

	const sortedNames = Object.keys(headers).sort();
	const canonicalHeaders = sortedNames.map((name) => `${name}:${trimHeaderValue(headers[name] ?? '')}\n`).join('');
	const signedHeaders = sortedNames.join(';');

	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalUri(url.pathname),
		canonicalQueryString(url.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n');

	return { canonicalRequest, signedHeaders, headersToSend: headers };
}

/**
 * Signs an AWS request with SigV4 and returns the complete set of headers to send (the caller's own
 * headers plus `host`, `x-amz-date`, `x-amz-content-sha256` and `authorization`).
 */
export async function signAwsRequest(input: SigV4SignInput): Promise<SignedHeaders> {
	const date = input.date ?? new Date();
	const amzDate = toAmzDate(date);
	const dateStamp = amzDate.slice(0, 8);

	const { canonicalRequest, signedHeaders, headersToSend } = await buildCanonicalRequest(input, amzDate);

	const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

	const signingKey = await deriveSigningKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service);
	const signature = await hmacSha256Hex(signingKey, stringToSign);

	const authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return { ...headersToSend, authorization };
}
