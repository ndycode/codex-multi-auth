import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
	logError: vi.fn(),
}));

import { logError } from '../lib/logger.js';
import { exchangeAuthorizationCode, REDIRECT_URI } from '../lib/auth/auth.js';

describe('OAuth auth logging', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('logs safe metadata when token response schema validation fails', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({
				access_token: 'secret-access-token',
				refresh_token: 'secret-refresh-token',
				expires_in: '3600',
			}), { status: 200 }),
		) as never;

		try {
			const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
			expect(result.type).toBe('failed');

			expect(vi.mocked(logError)).toHaveBeenCalledWith(
				'token response validation failed',
				{ responseType: 'object', keyCount: 3 },
			);

			const loggedData = vi.mocked(logError).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
			expect(loggedData).toEqual({ responseType: 'object', keyCount: 3 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('logs safe metadata when refresh token is missing', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({
				access_token: 'secret-access-token',
				expires_in: 3600,
			}), { status: 200 }),
		) as never;

		try {
			const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
			expect(result.type).toBe('failed');

			expect(vi.mocked(logError)).toHaveBeenCalledWith(
				'token response missing refresh token',
				{ responseType: 'object', keyCount: 2 },
			);

			const loggedData = vi.mocked(logError).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
			expect(loggedData).toEqual({ responseType: 'object', keyCount: 2 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('logs timeout metadata when token exchange aborts', async () => {
		const originalFetch = globalThis.fetch;
		vi.useFakeTimers();
		globalThis.fetch = vi.fn((_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal as AbortSignal | undefined;
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener(
					'abort',
					() => {
						reject(signal.reason);
					},
					{ once: true },
				);
			}),
		) as never;

		try {
			const resultPromise = exchangeAuthorizationCode(
				'auth-code',
				'verifier-123',
				REDIRECT_URI,
				{ timeoutMs: 1000 },
			);
			await vi.advanceTimersByTimeAsync(1000);
			const result = await resultPromise;
			expect(result.type).toBe('failed');

			expect(vi.mocked(logError)).toHaveBeenCalledWith(
				'code->token aborted',
				{ message: 'OAuth token exchange timed out after 1000ms' },
			);
		} finally {
			globalThis.fetch = originalFetch;
			vi.useRealTimers();
		}
	});

	it('logs only sanitized metadata for HTTP token exchange failures', async () => {
		const originalFetch = globalThis.fetch;
		const rawBody = JSON.stringify({
			error: 'invalid_request',
			refresh_token: 'secret-refresh-token',
			access_token: 'secret-access-token',
		});
		globalThis.fetch = vi.fn(async () => new Response(rawBody, { status: 400 })) as never;

		try {
			const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
			expect(result.type).toBe('failed');
			if (result.type === 'failed') {
				expect(result.reason).toBe('http_error');
				expect(result.statusCode).toBe(400);
				expect(result.message).toBe('OAuth token exchange failed');
			}
			expect(vi.mocked(logError)).toHaveBeenCalledWith('code->token failed', {
				status: 400,
				bodyLength: rawBody.length,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
