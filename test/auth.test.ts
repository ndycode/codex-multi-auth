import { describe, it, expect, vi } from 'vitest';
import {
	createState,
	parseAuthorizationInput,
	decodeJWT,
	createAuthorizationFlow,
	refreshAccessToken,
	exchangeAuthorizationCode,
	CLIENT_ID,
	AUTHORIZE_URL,
	REDIRECT_URI,
	SCOPE,
} from '../lib/auth/auth.js';

describe('Auth Module', () => {
	describe('createState', () => {
		it('should generate a random 32-character hex string', () => {
			const state = createState();
			expect(state).toMatch(/^[a-f0-9]{32}$/);
		});

		it('should generate unique states', () => {
			const state1 = createState();
			const state2 = createState();
			expect(state1).not.toBe(state2);
		});
	});

	describe('parseAuthorizationInput', () => {
		it('should parse full OAuth callback URL', () => {
			const input = 'http://localhost:1455/auth/callback?code=abc123&state=xyz789';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
		});

		it('should parse code#state format', () => {
			const input = 'abc123#xyz789';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
		});

		it('should parse query string format', () => {
			const input = 'code=abc123&state=xyz789';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
		});

		it('should parse query string with code= only (no state param)', () => {
			const input = 'code=abc123';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: undefined });
		});

		it('should parse URL with fragment parameters (#code=...)', () => {
			const input = 'http://localhost:1455/auth/callback#code=abc123&state=xyz789';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
		});

		it('should prefer query params over hash params when both exist', () => {
			const input = 'http://localhost:1455/auth/callback?code=querycode&state=querystate#code=hashcode&state=hashstate';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'querycode', state: 'querystate' });
		});

		it('should fallback to hash for missing state in query', () => {
			const input = 'http://localhost:1455/auth/callback?code=querycode#state=hashstate';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'querycode', state: 'hashstate' });
		});

		it('should fallback to hash for missing code in query', () => {
			const input = 'http://localhost:1455/auth/callback?state=querystate#code=hashcode';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'hashcode', state: 'querystate' });
		});

		it('should handle URL with hash but without # prefix', () => {
			const input = 'http://localhost:1455/auth/callback#code=abc123';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: undefined });
		});

		it('should return code and state when only state is in hash (line 44 coverage)', () => {
			const input = 'http://localhost:1455/auth/callback?code=querycode#state=hashstate';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'querycode', state: 'hashstate' });
		});

		it('should return state only when only state is in hash and no code (line 44 coverage)', () => {
			const input = 'http://localhost:1455/auth/callback#state=hashstate';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: undefined, state: 'hashstate' });
		});

	it('should parse code only', () => {
		const input = 'abc123';
		const result = parseAuthorizationInput(input);
		expect(result).toEqual({ code: 'abc123' });
	});

	it('should parse code= query string without state (line 58 state undefined branch)', () => {
		const input = 'code=abc123';
		const result = parseAuthorizationInput(input);
		expect(result).toEqual({ code: 'abc123', state: undefined });
	});

		it('should return empty object for empty input', () => {
			const result = parseAuthorizationInput('');
			expect(result).toEqual({});
		});

		it('should handle whitespace', () => {
			const result = parseAuthorizationInput('  ');
			expect(result).toEqual({});
		});

	it('should fall through to # split when valid URL has hash with no code/state params (line 44 false branch)', () => {
		// URL parses successfully but hash contains no code= or state= params
		// Line 44's false branch is hit (code && state both undefined)
		// Falls through to line 51 which splits on #
		const input = 'http://localhost:1455/auth/callback#invalid';
		const result = parseAuthorizationInput(input);
		expect(result).toEqual({ code: 'http://localhost:1455/auth/callback', state: 'invalid' });
	});
	});

	describe('decodeJWT', () => {
		it('should decode valid JWT token', () => {
			// Create a simple JWT token: header.payload.signature
			const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
			const payload = Buffer.from(JSON.stringify({ sub: '1234567890', name: 'Test User' })).toString('base64');
			const signature = 'fake-signature';
			const token = `${header}.${payload}.${signature}`;

			const decoded = decodeJWT(token);
			expect(decoded).toEqual({ sub: '1234567890', name: 'Test User' });
		});

		it('should decode JWT with ChatGPT account info', () => {
			const payload = Buffer.from(JSON.stringify({
				'https://api.openai.com/auth': {
					chatgpt_account_id: 'account-123',
				},
			})).toString('base64');
			const token = `header.${payload}.signature`;

			const decoded = decodeJWT(token);
			expect(decoded?.['https://api.openai.com/auth']?.chatgpt_account_id).toBe('account-123');
		});

		it('should decode base64url JWT payloads', () => {
			const payload = Buffer.from(
				JSON.stringify({ sub: '1234567890', name: 'Test User' }),
				'utf8',
			).toString('base64url');
			const token = `header.${payload}.signature`;

			const decoded = decodeJWT(token);
			expect(decoded).toEqual({ sub: '1234567890', name: 'Test User' });
		});

		it('should return null for invalid JWT', () => {
			const result = decodeJWT('invalid-token');
			expect(result).toBeNull();
		});

		it('should return null for malformed JWT', () => {
			const result = decodeJWT('header.payload');
			expect(result).toBeNull();
		});

		it('should return null for non-JSON payload', () => {
			const token = 'header.not-json.signature';
			const result = decodeJWT(token);
			expect(result).toBeNull();
		});
	});

	describe('createAuthorizationFlow', () => {
		it('should create authorization flow with PKCE', async () => {
			const flow = await createAuthorizationFlow();

			expect(flow).toHaveProperty('pkce');
			expect(flow).toHaveProperty('state');
			expect(flow).toHaveProperty('url');

			expect(flow.pkce).toHaveProperty('challenge');
			expect(flow.pkce).toHaveProperty('verifier');
			expect(flow.state).toMatch(/^[a-f0-9]{32}$/);
		});

		it('should generate URL with correct parameters', async () => {
			const flow = await createAuthorizationFlow();
			const url = new URL(flow.url);

			expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
			expect(url.searchParams.get('response_type')).toBe('code');
			expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
			expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
			expect(url.searchParams.get('scope')).toBe(SCOPE);
			expect(url.searchParams.get('code_challenge_method')).toBe('S256');
			expect(url.searchParams.get('code_challenge')).toBe(flow.pkce.challenge);
			expect(url.searchParams.get('state')).toBe(flow.state);
			expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
			expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
			expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
			expect(url.searchParams.has('prompt')).toBe(false);
		});

		it('should include prompt=login when forceNewLogin is true', async () => {
			const flow = await createAuthorizationFlow({ forceNewLogin: true });
			const url = new URL(flow.url);
			expect(url.searchParams.get('prompt')).toBe('login');
		});

		it('should generate unique flows', async () => {
			const flow1 = await createAuthorizationFlow();
			const flow2 = await createAuthorizationFlow();

			expect(flow1.state).not.toBe(flow2.state);
			expect(flow1.pkce.verifier).not.toBe(flow2.pkce.verifier);
			expect(flow1.url).not.toBe(flow2.url);
		});
	});

	describe('exchangeAuthorizationCode', () => {
		it('returns success with tokens on valid response', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'access-123',
					refresh_token: 'refresh-456',
					expires_in: 3600,
					id_token: 'id-token-789',
				}), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
				expect(result).toEqual({
					type: 'success',
					access: 'access-123',
					refresh: 'refresh-456',
					expires: 3_601_000,
					idToken: 'id-token-789',
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it('returns success with empty refresh token when not provided', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'access-123',
					expires_in: 3600,
				}), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
				expect(result).toEqual({
					type: 'success',
					access: 'access-123',
					refresh: '',
					expires: 3_601_000,
					idToken: undefined,
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it('returns failed for HTTP error response', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response('Bad Request', { status: 400 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('bad-code', 'verifier');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
					expect(result.statusCode).toBe(400);
					expect(result.message).toBe('Bad Request');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed with undefined message when text read fails', async () => {
			const originalFetch = globalThis.fetch;
			const mockResponse = {
				ok: false,
				status: 500,
				text: vi.fn().mockRejectedValue(new Error('Read failed')),
			};
			globalThis.fetch = vi.fn(async () => mockResponse) as never;

			try {
				const result = await exchangeAuthorizationCode('code', 'verifier');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
					expect(result.statusCode).toBe(500);
					expect(result.message).toBeUndefined();
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed for invalid response schema', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ wrong: 'schema' }), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('code', 'verifier');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('invalid_response');
					expect(result.message).toBe('Response failed schema validation');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('uses custom redirect URI when provided', async () => {
			const originalFetch = globalThis.fetch;
			let capturedBody: URLSearchParams | undefined;
			globalThis.fetch = vi.fn(async (_url, init) => {
				capturedBody = init?.body as URLSearchParams;
				return new Response(JSON.stringify({
					access_token: 'access',
					expires_in: 3600,
				}), { status: 200 });
			}) as never;

			try {
				await exchangeAuthorizationCode('code', 'verifier', 'http://custom:8080/callback');
				expect(capturedBody?.get('redirect_uri')).toBe('http://custom:8080/callback');
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe('refreshAccessToken', () => {
		it('keeps existing refresh token when missing in response', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ access_token: 'new-access', expires_in: 60 }), {
					status: 200,
				}),
			) as never;

			try {
				const result = await refreshAccessToken('existing-refresh');
			expect(result).toEqual({
				type: 'success',
				access: 'new-access',
				refresh: 'existing-refresh',
				expires: 61_000,
				idToken: undefined,
				multiAccount: true,
			});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it('returns failed for HTTP 400 invalid_grant', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
			) as never;

			try {
				const result = await refreshAccessToken('bad-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed for invalid response schema', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ wrong: 'schema' }), { status: 200 }),
			) as never;

			try {
				const result = await refreshAccessToken('some-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('invalid_response');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed for network errors', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () => {
				throw new Error('Network failed');
			}) as never;

			try {
				const result = await refreshAccessToken('some-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('network_error');
					expect(result.message).toBe('Network failed');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed when both response and input have no refresh token', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'new-access',
					expires_in: 60,
					// no refresh_token in response
				}), { status: 200 }),
			) as never;

			try {
				// Pass empty string as refresh token to trigger missing_refresh branch
				const result = await refreshAccessToken('');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('missing_refresh');
					expect(result.message).toBe('No refresh token in response or input');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns http_error with undefined message when response text is empty', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response('', { status: 500 }),
			) as never;

			try {
				const result = await refreshAccessToken('some-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
					expect(result.statusCode).toBe(500);
					expect(result.message).toBeUndefined();
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns success with new refresh token from response', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'new-access',
					refresh_token: 'new-refresh',
					expires_in: 60,
					id_token: 'new-id-token',
				}), { status: 200 }),
			) as never;

			try {
				const result = await refreshAccessToken('old-refresh');
				expect(result).toEqual({
					type: 'success',
					access: 'new-access',
					refresh: 'new-refresh',
					expires: 61_000,
					idToken: 'new-id-token',
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});
	});
});
