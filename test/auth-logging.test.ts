import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
	logError: vi.fn(),
}));

import { logError } from '../lib/logger.js';
import { exchangeAuthorizationCode } from '../lib/auth/auth.js';

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
				expect.objectContaining({
					responseType: 'object',
					keys: expect.arrayContaining(['access_token', 'refresh_token', 'expires_in']),
				}),
			);

			const loggedData = vi.mocked(logError).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
			expect(loggedData).toBeDefined();
			expect(loggedData).not.toHaveProperty('access_token');
			expect(loggedData).not.toHaveProperty('refresh_token');
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
				expect.objectContaining({
					responseType: 'object',
					keys: expect.arrayContaining(['access_token', 'expires_in']),
				}),
			);

			const loggedData = vi.mocked(logError).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
			expect(loggedData).toBeDefined();
			expect(loggedData).not.toHaveProperty('access_token');
			expect(loggedData).not.toHaveProperty('refresh_token');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
