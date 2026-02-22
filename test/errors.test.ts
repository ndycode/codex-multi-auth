import { describe, it, expect } from 'vitest';
import {
	ErrorCode,
	CodexError,
	CodexApiError,
	CodexAuthError,
	CodexNetworkError,
	CodexValidationError,
	CodexRateLimitError,
} from '../lib/errors.js';

describe('Errors Module', () => {
	describe('ErrorCode', () => {
		it('should have all expected error codes', () => {
			expect(ErrorCode.NETWORK_ERROR).toBe('CODEX_NETWORK_ERROR');
			expect(ErrorCode.API_ERROR).toBe('CODEX_API_ERROR');
			expect(ErrorCode.AUTH_ERROR).toBe('CODEX_AUTH_ERROR');
			expect(ErrorCode.VALIDATION_ERROR).toBe('CODEX_VALIDATION_ERROR');
			expect(ErrorCode.RATE_LIMIT).toBe('CODEX_RATE_LIMIT');
			expect(ErrorCode.TIMEOUT).toBe('CODEX_TIMEOUT');
		});
	});

	describe('CodexError', () => {
		it('should create error with message', () => {
			const error = new CodexError('Test error');
			expect(error.message).toBe('Test error');
			expect(error.name).toBe('CodexError');
			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(CodexError);
		});

		it('should default code to API_ERROR', () => {
			const error = new CodexError('Test error');
			expect(error.code).toBe(ErrorCode.API_ERROR);
		});

		it('should accept custom code', () => {
			const error = new CodexError('Test error', { code: ErrorCode.TIMEOUT });
			expect(error.code).toBe(ErrorCode.TIMEOUT);
		});

		it('should accept cause for error chaining', () => {
			const cause = new Error('Original error');
			const error = new CodexError('Wrapped error', { cause });
			expect((error as unknown as { cause: unknown }).cause).toBe(cause);
		});

		it('should accept context data', () => {
			const context = { accountId: '123', attempt: 2 };
			const error = new CodexError('Test error', { context });
			expect(error.context).toEqual(context);
		});

		it('should have a stack trace', () => {
			const error = new CodexError('Test error');
			expect(error.stack).toBeDefined();
			expect(error.stack).toContain('CodexError');
		});
	});

	describe('CodexApiError', () => {
		it('should create API error with status', () => {
			const error = new CodexApiError('Not found', { status: 404 });
			expect(error.message).toBe('Not found');
			expect(error.name).toBe('CodexApiError');
			expect(error.status).toBe(404);
			expect(error.code).toBe(ErrorCode.API_ERROR);
		});

		it('should extend CodexError', () => {
			const error = new CodexApiError('Server error', { status: 500 });
			expect(error).toBeInstanceOf(CodexError);
			expect(error).toBeInstanceOf(Error);
		});

		it('should accept response headers', () => {
			const headers = { 'retry-after': '60', 'x-request-id': 'abc123' };
			const error = new CodexApiError('Rate limited', { status: 429, headers });
			expect(error.headers).toEqual(headers);
		});

		it('should accept custom code', () => {
			const error = new CodexApiError('Custom', { status: 500, code: ErrorCode.TIMEOUT });
			expect(error.code).toBe(ErrorCode.TIMEOUT);
		});

		it('should support error chaining', () => {
			const cause = new Error('Network failure');
			const error = new CodexApiError('API failed', { status: 503, cause });
			expect((error as unknown as { cause: unknown }).cause).toBe(cause);
		});
	});

	describe('CodexAuthError', () => {
		it('should create auth error with defaults', () => {
			const error = new CodexAuthError('Token expired');
			expect(error.message).toBe('Token expired');
			expect(error.name).toBe('CodexAuthError');
			expect(error.code).toBe(ErrorCode.AUTH_ERROR);
			expect(error.retryable).toBe(false);
			expect(error.accountId).toBeUndefined();
		});

		it('should extend CodexError', () => {
			const error = new CodexAuthError('Auth failed');
			expect(error).toBeInstanceOf(CodexError);
		});

		it('should accept accountId', () => {
			const error = new CodexAuthError('Invalid token', { accountId: 'user@example.com' });
			expect(error.accountId).toBe('user@example.com');
		});

		it('should accept retryable flag', () => {
			const error = new CodexAuthError('Temporary failure', { retryable: true });
			expect(error.retryable).toBe(true);
		});

		it('should default retryable to false', () => {
			const error = new CodexAuthError('Permanent failure');
			expect(error.retryable).toBe(false);
		});
	});

	describe('CodexNetworkError', () => {
		it('should create network error with defaults', () => {
			const error = new CodexNetworkError('Connection refused');
			expect(error.message).toBe('Connection refused');
			expect(error.name).toBe('CodexNetworkError');
			expect(error.code).toBe(ErrorCode.NETWORK_ERROR);
			expect(error.retryable).toBe(true);
		});

		it('should extend CodexError', () => {
			const error = new CodexNetworkError('Timeout');
			expect(error).toBeInstanceOf(CodexError);
		});

		it('should default retryable to true', () => {
			const error = new CodexNetworkError('DNS failure');
			expect(error.retryable).toBe(true);
		});

		it('should accept retryable override', () => {
			const error = new CodexNetworkError('Permanent DNS failure', { retryable: false });
			expect(error.retryable).toBe(false);
		});

		it('should support error chaining', () => {
			const cause = new TypeError('fetch failed');
			const error = new CodexNetworkError('Request failed', { cause });
			expect((error as unknown as { cause: unknown }).cause).toBe(cause);
		});
	});

	describe('CodexValidationError', () => {
		it('should create validation error with defaults', () => {
			const error = new CodexValidationError('Invalid input');
			expect(error.message).toBe('Invalid input');
			expect(error.name).toBe('CodexValidationError');
			expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
			expect(error.field).toBeUndefined();
			expect(error.expected).toBeUndefined();
		});

		it('should extend CodexError', () => {
			const error = new CodexValidationError('Bad data');
			expect(error).toBeInstanceOf(CodexError);
		});

		it('should accept field name', () => {
			const error = new CodexValidationError('Required', { field: 'email' });
			expect(error.field).toBe('email');
		});

		it('should accept expected value description', () => {
			const error = new CodexValidationError('Invalid type', {
				field: 'age',
				expected: 'number',
			});
			expect(error.field).toBe('age');
			expect(error.expected).toBe('number');
		});
	});

	describe('CodexRateLimitError', () => {
		it('should create rate limit error with defaults', () => {
			const error = new CodexRateLimitError('Rate limited');
			expect(error.message).toBe('Rate limited');
			expect(error.name).toBe('CodexRateLimitError');
			expect(error.code).toBe(ErrorCode.RATE_LIMIT);
			expect(error.retryAfterMs).toBeUndefined();
			expect(error.accountId).toBeUndefined();
		});

		it('should extend CodexError', () => {
			const error = new CodexRateLimitError('Too many requests');
			expect(error).toBeInstanceOf(CodexError);
		});

		it('should accept retryAfterMs', () => {
			const error = new CodexRateLimitError('Slow down', { retryAfterMs: 60000 });
			expect(error.retryAfterMs).toBe(60000);
		});

		it('should accept accountId', () => {
			const error = new CodexRateLimitError('Account limited', {
				accountId: 'user@example.com',
				retryAfterMs: 30000,
			});
			expect(error.accountId).toBe('user@example.com');
			expect(error.retryAfterMs).toBe(30000);
		});
	});

	describe('Error inheritance chain', () => {
		it('should maintain correct prototype chain for all error types', () => {
			const errors = [
				new CodexError('base'),
				new CodexApiError('api', { status: 500 }),
				new CodexAuthError('auth'),
				new CodexNetworkError('network'),
				new CodexValidationError('validation'),
				new CodexRateLimitError('rate limit'),
			];

			for (const error of errors) {
				expect(error).toBeInstanceOf(Error);
				expect(error).toBeInstanceOf(CodexError);
			}
		});

		it('should work with try/catch for CodexError', () => {
			const throwAndCatch = () => {
				try {
					throw new CodexApiError('Test', { status: 400 });
				} catch (e) {
					if (e instanceof CodexError) {
						return e.code;
					}
					return 'not caught';
				}
			};

			expect(throwAndCatch()).toBe(ErrorCode.API_ERROR);
		});

		it('should distinguish between error types', () => {
			const apiError = new CodexApiError('api', { status: 500 });
			const authError = new CodexAuthError('auth');
			const networkError = new CodexNetworkError('network');

			expect(apiError).toBeInstanceOf(CodexApiError);
			expect(apiError).not.toBeInstanceOf(CodexAuthError);

			expect(authError).toBeInstanceOf(CodexAuthError);
			expect(authError).not.toBeInstanceOf(CodexNetworkError);

			expect(networkError).toBeInstanceOf(CodexNetworkError);
			expect(networkError).not.toBeInstanceOf(CodexApiError);
		});
	});
});
