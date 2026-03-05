import { describe, it, expect, vi, afterEach } from 'vitest';
import * as refreshQueueModule from '../lib/refresh-queue.js';
import {
    shouldRefreshToken,
    refreshAndUpdateToken,
    extractRequestUrl,
    rewriteUrlForCodex,
    createCodexHeaders,
    handleErrorResponse,
    handleSuccessResponse,
    handleSuccessResponseDetailed,
    isEntitlementError,
    createEntitlementErrorResponse,
	getUnsupportedCodexModelInfo,
	resolveUnsupportedCodexFallbackModel,
	extractUnsupportedCodexModelFromText,
	shouldFallbackToGpt52OnUnsupportedGpt53,
} from '../lib/request/fetch-helpers.js';
import * as loggerModule from '../lib/logger.js';
import type { Auth } from '../lib/types.js';
import type { CreateCodexHeadersParams } from '../lib/request/fetch-helpers.js';
import { URL_PATHS, OPENAI_HEADERS, OPENAI_HEADER_VALUES, CODEX_BASE_URL } from '../lib/constants.js';

describe('Fetch Helpers Module', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('shouldRefreshToken', () => {
		it('should return true for non-oauth auth', () => {
			const auth: Auth = { type: 'api', key: 'test-key' };
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return true when access token is missing', () => {
			const auth: Auth = { type: 'oauth', access: '', refresh: 'refresh-token', expires: Date.now() + 1000 };
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return true when token is expired', () => {
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() - 1000 // expired
			};
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return false for valid oauth token', () => {
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() + 10000 // valid for 10 seconds
			};
			expect(shouldRefreshToken(auth)).toBe(false);
		});

		it('should refresh token early when within skew window', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: 1_500,
			};
			expect(shouldRefreshToken(auth, 500)).toBe(true);
			expect(shouldRefreshToken(auth, 400)).toBe(false);
			expect(shouldRefreshToken(auth, -1)).toBe(false);
		});
	});

	describe('refreshAndUpdateToken', () => {
		it('throws when client auth setter is missing', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'oldr', expires: 0 };
			const client = {} as any;
			const refreshSpy = vi.spyOn(refreshQueueModule, 'queuedRefresh');

			await expect(refreshAndUpdateToken(auth, client)).rejects.toThrow();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it('throws when client auth.set is not a function', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'oldr', expires: 0 };
			const client = { auth: { set: 'bad' } } as any;
			const refreshSpy = vi.spyOn(refreshQueueModule, 'queuedRefresh');

			await expect(refreshAndUpdateToken(auth, client)).rejects.toThrow();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it('throws when refresh fails', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'bad', expires: 0 };
			const client = { auth: { set: vi.fn() } } as any;
			vi.spyOn(refreshQueueModule, 'queuedRefresh').mockResolvedValue({ type: 'failed' } as any);

			await expect(refreshAndUpdateToken(auth, client)).rejects.toThrow();
		});

		it('updates stored auth on success', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'oldr', expires: 0 };
			const client = { auth: { set: vi.fn() } } as any;
			vi.spyOn(refreshQueueModule, 'queuedRefresh').mockResolvedValue({
				type: 'success',
				access: 'new',
				refresh: 'newr',
				expires: 123,
			} as any);

			const updated = await refreshAndUpdateToken(auth, client);

		expect(client.auth.set).toHaveBeenCalledWith({
			path: { id: 'openai' },
			body: {
				type: 'oauth',
				access: 'new',
				refresh: 'newr',
				expires: 123,
				multiAccount: true,
			},
		});
			expect(updated.access).toBe('new');
			expect(updated.refresh).toBe('newr');
			expect(updated.expires).toBe(123);
		});
	});

	describe('extractRequestUrl', () => {
		it('should extract URL from string', () => {
			const url = 'https://example.com/test';
			expect(extractRequestUrl(url)).toBe(url);
		});

		it('should extract URL from URL object', () => {
			const url = new URL('https://example.com/test');
			expect(extractRequestUrl(url)).toBe('https://example.com/test');
		});

		it('should extract URL from Request object', () => {
			const request = new Request('https://example.com/test');
			expect(extractRequestUrl(request)).toBe('https://example.com/test');
		});
	});

	describe('rewriteUrlForCodex', () => {
		it('should rewrite /responses to /codex/responses', () => {
			const url = 'https://chatgpt.com/backend-api/responses';
			expect(rewriteUrlForCodex(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
		});

		it('should keep backend-api paths when URL is already on codex origin', () => {
			const url = 'https://chatgpt.com/backend-api/other';
			expect(rewriteUrlForCodex(url)).toBe(url);
		});

		it('should force codex origin and preserve query params', () => {
			const url = 'https://example.com/backend-api/responses?foo=bar';
			const result = rewriteUrlForCodex(url);
			expect(result).toBe('https://chatgpt.com/backend-api/codex/responses?foo=bar');
		});

		it('should prefix backend-api path when request path is outside backend-api', () => {
			const url = 'https://chatgpt.com/v1/other';
			const result = rewriteUrlForCodex(url);
			expect(result).toBe(`${CODEX_BASE_URL}/v1/other`);
		});

		it('should throw for invalid URL input', () => {
			expect(() => rewriteUrlForCodex('not-a-valid-url')).toThrow(TypeError);
		});
	});

		describe('createCodexHeaders', () => {
	const accountId = 'test-account-123';
	const accessToken = 'test-access-token';

		it('should create headers with all required fields when cache key provided', () => {
	    const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5-codex', promptCacheKey: 'session-1' });

	    expect(headers.get('Authorization')).toBe(`Bearer ${accessToken}`);
	    expect(headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe(accountId);
	    expect(headers.get(OPENAI_HEADERS.BETA)).toBe(OPENAI_HEADER_VALUES.BETA_RESPONSES);
	    expect(headers.get(OPENAI_HEADERS.ORIGINATOR)).toBe(OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	    expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe('session-1');
	    expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe('session-1');
	    expect(headers.get('accept')).toBe('text/event-stream');
    });

                it('maps usage-limit 404 errors to 429', async () => {
                        const body = {
                                error: {
                                        code: 'usage_limit_reached',
                                        message: 'limit reached',
                                },
                        };
                        const resp = new Response(JSON.stringify(body), { status: 404 });
                        const { response: mapped, rateLimit } = await handleErrorResponse(resp);
                        expect(mapped.status).toBe(429);
                        const json = await mapped.json() as any;
                        expect(json.error.code).toBe('usage_limit_reached');
                        expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
                });

                it('leaves non-usage 404 errors unchanged', async () => {
                        const body = { error: { code: 'not_found', message: 'nope' } };
                        const resp = new Response(JSON.stringify(body), { status: 404 });
                        const { response: result, rateLimit } = await handleErrorResponse(resp);
                        expect(result.status).toBe(404);
                        const json = await result.json() as any;
                        expect(json.error.code).toBe('not_found');
                        expect(rateLimit).toBeUndefined();
                });

		it('should remove x-api-key header', () => {
        const init = { headers: { 'x-api-key': 'should-be-removed' } } as any;
        const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5', promptCacheKey: 'session-2' });

			expect(headers.has('x-api-key')).toBe(false);
		});

		it('should preserve other existing headers', () => {
        const init = { headers: { 'Content-Type': 'application/json' } } as any;
        const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5', promptCacheKey: 'session-3' });

			expect(headers.get('Content-Type')).toBe('application/json');
		});

		it('should use provided promptCacheKey for both conversation_id and session_id', () => {
			const key = 'ses_abc123';
			const headers = createCodexHeaders(undefined, accountId, accessToken, { promptCacheKey: key });
			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe(key);
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe(key);
		});

		it('does not set conversation/session headers when no promptCacheKey provided', () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5' });
			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBeNull();
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBeNull();
		});

		it('supports named-parameter options form', () => {
			const positional = createCodexHeaders(undefined, accountId, accessToken, {
				model: 'gpt-5',
				promptCacheKey: 'session-named',
			});
			const named = createCodexHeaders({
				init: undefined,
				accountId,
				accessToken,
				opts: { model: 'gpt-5', promptCacheKey: 'session-named' },
			});

			expect(named.get('Authorization')).toBe(positional.get('Authorization'));
			expect(named.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe(positional.get(OPENAI_HEADERS.ACCOUNT_ID));
			expect(named.get(OPENAI_HEADERS.SESSION_ID)).toBe(positional.get(OPENAI_HEADERS.SESSION_ID));
			expect(named.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe(positional.get(OPENAI_HEADERS.CONVERSATION_ID));
			expect(named.get(OPENAI_HEADERS.BETA)).toBe(positional.get(OPENAI_HEADERS.BETA));
			expect(named.get(OPENAI_HEADERS.ORIGINATOR)).toBe(positional.get(OPENAI_HEADERS.ORIGINATOR));
			expect(named.get('accept')).toBe(positional.get('accept'));
			expect(named.get('content-type')).toBe(positional.get('content-type'));
			expect(named.has('x-api-key')).toBe(false);
		});

		it('does not treat RequestInit-like objects as named params when keys are spread accidentally', () => {
			const accidentalRequestInit = {
				headers: { 'content-type': 'application/json' },
				accountId: 'accidental-account',
				accessToken: 'accidental-token',
			};

			expect(() =>
				createCodexHeaders(accidentalRequestInit as unknown as CreateCodexHeadersParams),
			).toThrow('createCodexHeaders requires accountId and accessToken');
		});

		it('maps usage_not_included 404 to 403 entitlement error, not rate limit', async () => {
			const body = {
				error: {
					code: 'usage_not_included',
					message: 'Usage not included in your plan',
				},
			};
			const resp = new Response(JSON.stringify(body), { status: 404 });
			const { response: result, rateLimit } = await handleErrorResponse(resp);
			expect(result.status).toBe(403);
			expect(rateLimit).toBeUndefined();
			const json = await result.json() as any;
			expect(json.error.type).toBe('entitlement_error');
			expect(json.error.message).toContain('not included in your ChatGPT subscription');
		});
    });

	describe('isEntitlementError', () => {
		it('returns true for usage_not_included code', () => {
			expect(isEntitlementError('usage_not_included', '')).toBe(true);
		});

		it('returns true when body contains "not included in your plan"', () => {
			expect(isEntitlementError('', 'Usage not included in your plan')).toBe(true);
		});

		it('returns false for usage_limit_reached (rate limit)', () => {
			expect(isEntitlementError('usage_limit_reached', '')).toBe(false);
		});

		it('returns false for rate_limit_exceeded', () => {
			expect(isEntitlementError('rate_limit_exceeded', '')).toBe(false);
		});

		it('returns false for generic errors', () => {
			expect(isEntitlementError('not_found', 'Resource not found')).toBe(false);
		});
	});

	describe('createEntitlementErrorResponse', () => {
		it('returns 403 status with user-friendly message', async () => {
			const resp = createEntitlementErrorResponse('original body');
			expect(resp.status).toBe(403);
			expect(resp.statusText).toBe('Forbidden');
			const json = await resp.json() as any;
			expect(json.error.type).toBe('entitlement_error');
			expect(json.error.code).toBe('usage_not_included');
			expect(json.error.message).toContain('ChatGPT subscription');
		});
	});

	describe('gpt-5.3 unsupported model handling', () => {
		it('normalizes ChatGPT model-not-supported 400 to actionable entitlement error', async () => {
			const body = {
				detail: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
			};
			const response = new Response(JSON.stringify(body), { status: 400, statusText: 'Bad Request' });

			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as {
				error: {
					message: string;
					type?: string;
					code?: string;
					unsupported_model?: string;
				};
			};

			expect(json.error.type).toBe('entitlement_error');
			expect(json.error.code).toBe('model_not_supported_with_chatgpt_account');
			expect(json.error.message).toContain("'gpt-5.3-codex'");
			expect(json.error.message).toContain('CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL');
			expect(json.error.unsupported_model).toBe('gpt-5.3-codex');
		});

		it('flags fallback when gpt-5.3-codex returns unsupported-model entitlement error', () => {
			const shouldFallback = shouldFallbackToGpt52OnUnsupportedGpt53('gpt-5.3-codex', {
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message: 'not supported when using Codex with a ChatGPT account',
				},
			});

			expect(shouldFallback).toBe(true);
		});

		it('does not flag fallback for other models or errors', () => {
			expect(
				shouldFallbackToGpt52OnUnsupportedGpt53('gpt-5.2-codex', {
					error: { code: 'model_not_supported_with_chatgpt_account' },
				}),
			).toBe(false);
			expect(
				shouldFallbackToGpt52OnUnsupportedGpt53('gpt-5.3-codex', {
					error: { code: 'usage_not_included' },
				}),
			).toBe(false);
		});

		it('extracts unsupported model from upstream and normalized error messages', () => {
			expect(
				extractUnsupportedCodexModelFromText(
					"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
				),
			).toBe('gpt-5.3-codex-spark');
			expect(
				extractUnsupportedCodexModelFromText(
					"The model 'gpt-5.3-codex' is not currently available for this ChatGPT account when using Codex OAuth.",
				),
			).toBe('gpt-5.3-codex');
		});

		it('returns unsupported model info from normalized error payload', () => {
			const info = getUnsupportedCodexModelInfo({
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message: "The model 'gpt-5.3-codex-spark' is not currently available for this ChatGPT account when using Codex OAuth.",
					unsupported_model: 'gpt-5.3-codex-spark',
				},
			});

			expect(info.isUnsupported).toBe(true);
			expect(info.unsupportedModel).toBe('gpt-5.3-codex-spark');
		});

		it('resolves Spark fallback chain to canonical gpt-5-codex first', () => {
			const errorBody = {
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message:
						"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
				},
			};

			const first = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex-spark',
				errorBody,
				attemptedModels: ['gpt-5.3-codex-spark'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(first).toBe('gpt-5-codex');

			const second = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex-spark', 'gpt-5.3-codex', 'gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(second).toBe('gpt-5.2-codex');
		});

		it('respects legacy gpt-5.3 -> gpt-5.2 toggle when disabled', () => {
			const canonicalFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: false,
			});
			expect(canonicalFallback).toBe('gpt-5-codex');

			const legacyEdgeFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex', 'gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: false,
			});
			expect(legacyEdgeFallback).toBeUndefined();
		});
	});

	describe('handleSuccessResponse', () => {
		it('logs warning when Deprecation header is present', async () => {
			const warnSpy = vi.spyOn(loggerModule, 'logWarn');
			const headers = new Headers({ 'Deprecation': 'true' });
			const response = new Response('{}', { status: 200, headers });
			
			await handleSuccessResponse(response, false);
			
			expect(warnSpy).toHaveBeenCalledWith('API deprecation notice', { deprecation: 'true', sunset: null });
		});

		it('logs warning when Sunset header is present', async () => {
			const warnSpy = vi.spyOn(loggerModule, 'logWarn');
			const headers = new Headers({ 'Sunset': 'Sat, 01 Jan 2030 00:00:00 GMT' });
			const response = new Response('{}', { status: 200, headers });
			
			await handleSuccessResponse(response, false);
			
			expect(warnSpy).toHaveBeenCalledWith('API deprecation notice', { deprecation: null, sunset: 'Sat, 01 Jan 2030 00:00:00 GMT' });
		});

		it('does not log warning when no deprecation headers present', async () => {
			const warnSpy = vi.spyOn(loggerModule, 'logWarn');
			const response = new Response('{}', { status: 200 });
			
			await handleSuccessResponse(response, false);
			
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('returns stream as-is for streaming requests', async () => {
			const response = new Response('stream body', { status: 200 });
			
			const result = await handleSuccessResponse(response, true);
			
			expect(result.status).toBe(200);
			const text = await result.text();
			expect(text).toBe('stream body');
		});

		it('returns parsedBody metadata for non-streaming success responses', async () => {
			const sseContent = `data: {"type":"response.done","response":{"id":"resp_meta","output":"done"}}`;
			const response = new Response(sseContent, { status: 200 });

			const result = await handleSuccessResponseDetailed(response, false);

			expect(result.parsedBody).toEqual({ id: 'resp_meta', output: 'done' });
			expect(await result.response.json()).toEqual({ id: 'resp_meta', output: 'done' });
		});

		it('parses CRLF-framed SSE payloads for non-streaming success responses', async () => {
			const sseContent =
				`data: {"type":"response.done","response":{"id":"resp_meta_crlf","output":"done"}}\r\n\r\n`;
			const response = new Response(sseContent, { status: 200 });

			const result = await handleSuccessResponseDetailed(response, false);

			expect(result.parsedBody).toEqual({ id: 'resp_meta_crlf', output: 'done' });
			expect(await result.response.json()).toEqual({ id: 'resp_meta_crlf', output: 'done' });
		});

		it('surfaces SSE parse errors in detailed mode when final response event is missing', async () => {
			const sseContent = `data: {"type":"response.output_text.delta","delta":"partial"}`;
			const response = new Response(sseContent, { status: 200 });

			const result = await handleSuccessResponseDetailed(response, false);
			expect(result.response.status).toBe(502);
			expect(result.parsedBody).toBeUndefined();
			const body = await result.response.json() as { error: { type: string; message: string } };
			expect(body.error.type).toBe('stream_parse_error');
			expect(body.error.message).toContain('No response.done event');
		});

		it('returns undefined parsedBody for streaming success responses in detailed mode', async () => {
			const response = new Response('streamed output', { status: 200 });
			const result = await handleSuccessResponseDetailed(response, true);
			expect(result.parsedBody).toBeUndefined();
			expect(await result.response.text()).toBe('streamed output');
		});
	});

	describe('handleErrorResponse error normalization', () => {
		it('extracts nested error.message', async () => {
			const body = { error: { message: 'nested error message', type: 'test_type', code: 'test_code' } };
			const response = new Response(JSON.stringify(body), { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string; type?: string; code?: string } };
			
			expect(json.error.message).toBe('nested error message');
			expect(json.error.type).toBe('test_type');
			expect(json.error.code).toBe('test_code');
		});

		it('extracts top-level message', async () => {
			const body = { message: 'top-level message' };
			const response = new Response(JSON.stringify(body), { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('top-level message');
		});

		it('uses trimmed body text when JSON parses to non-record (line 463 coverage)', async () => {
			const response = new Response('"just a string"', { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('"just a string"');
		});

		it('uses body text when no structured error', async () => {
			const response = new Response('plain text error', { status: 500 });
			const debugSpy = vi.spyOn(loggerModule, 'logDebug');
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('plain text error');
			expect(debugSpy).toHaveBeenCalledWith(
				'Failed to parse error response body as JSON; using raw text message',
			);
		});

		it('uses statusText when body is empty', async () => {
			const response = new Response('', { status: 500, statusText: 'Internal Server Error' });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('Internal Server Error');
		});

	it('uses fallback message when everything is empty', async () => {
		const response = new Response('', { status: 500, statusText: '' });
		
		const { response: result } = await handleErrorResponse(response);
		const json = await result.json() as { error: { message: string } };
		
		expect(json.error.message).toBe('Request failed');
	});

		it('handles numeric error codes', async () => {
			const body = { error: { message: 'error', code: 12345 } };
			const response = new Response(JSON.stringify(body), { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { code?: string | number } };
			
			expect(json.error.code).toBe(12345);
		});

		it('includes 401 diagnostics from response headers', async () => {
			const body = { error: { message: 'Unauthorized' } };
			const headers = new Headers({
				'cf-ray': 'abc123-def',
				'x-request-id': 'req_123',
			});
			const response = new Response(JSON.stringify(body), { status: 401, headers });

			const { response: result } = await handleErrorResponse(response, {
				requestCorrelationId: 'corr-1',
				threadId: 'thread-1',
			});
			const json = await result.json() as {
				error: {
					message: string;
					diagnostics?: {
						cfRay?: string;
						requestId?: string;
						correlationId?: string;
						threadId?: string;
						httpStatus?: number;
					};
				};
			};

			expect(json.error.message).toContain('codex login');
			expect(json.error.diagnostics).toEqual(
				expect.objectContaining({
					cfRay: 'abc123-def',
					requestId: 'req_123',
					correlationId: 'corr-1',
					threadId: 'thread-1',
					httpStatus: 401,
				}),
			);
		});
	});

	describe('handleErrorResponse edge cases', () => {
		it('handles 404 with non-JSON body containing usage limit text', async () => {
			const response = new Response('usage limit exceeded - please try again', { status: 404 });
			
			const { response: result, rateLimit } = await handleErrorResponse(response);
			
			expect(result.status).toBe(429);
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
		});

		it('handles 429 with entitlement error code (should not be rate limit)', async () => {
			const body = { error: { code: 'usage_not_included', message: 'Not included' } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { response: result, rateLimit } = await handleErrorResponse(response);
			
			expect(result.status).toBe(429);
			expect(rateLimit).toBeUndefined();
		});

		it('handles 429 with entitlement text pattern (should not be rate limit)', async () => {
			const body = { error: { message: 'Usage not included in your plan' } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { response: result, rateLimit } = await handleErrorResponse(response);
			
			expect(result.status).toBe(429);
			expect(rateLimit).toBeUndefined();
		});

		it('handles Response that throws on clone (safeReadBody catch)', async () => {
			const response = new Response('test', { status: 500 });
			const originalClone = response.clone.bind(response);
			let cloneCallCount = 0;
			response.clone = () => {
				cloneCallCount++;
				if (cloneCallCount === 1) {
					throw new Error('Clone failed');
				}
				return originalClone();
			};
			
			const { response: result } = await handleErrorResponse(response);
			
			expect(result.status).toBe(500);
			const json = await result.json() as { error: { message: string } };
			expect(json.error.message).toBe('Request failed');
		});
	});

	describe('handleErrorResponse rate limit parsing', () => {
	it('parses retryAfterMs from body', async () => {
		const body = { error: { message: 'rate limited', retry_after_ms: 5000 } };
		const response = new Response(JSON.stringify(body), { status: 429 });
		
		const { rateLimit } = await handleErrorResponse(response);
		
		expect(rateLimit).toBeDefined();
		expect(rateLimit?.retryAfterMs).toBe(5000);
	});

		it('parses retry-after-ms header', async () => {
			const headers = new Headers({ 'retry-after-ms': '3000' });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBe(3000);
		});

		it('parses retry-after header (seconds)', async () => {
			const headers = new Headers({ 'retry-after': '10' });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBe(10000);
		});

		it('parses x-ratelimit-reset header (unix timestamp)', async () => {
			const futureTimestamp = Math.floor(Date.now() / 1000) + 60;
			const headers = new Headers({ 'x-ratelimit-reset': String(futureTimestamp) });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
			expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(60000);
		});

		it('parses resetsAt from body', async () => {
			const futureTimestamp = Math.floor(Date.now() / 1000) + 30;
			const body = { error: { message: 'rate limited' }, resetsAt: futureTimestamp };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
		});

		it('keeps retry_after_ms values in milliseconds', async () => {
			const body = { error: { message: 'rate limited', retry_after_ms: 5 } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit?.retryAfterMs).toBe(5);
		});

		it('interprets retry_after values as seconds', async () => {
			const body = { error: { message: 'rate limited', retry_after: 5 } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit?.retryAfterMs).toBe(5000);
		});

		it('falls back to retry-after headers when body retry values are invalid', async () => {
			const body = { error: { message: 'rate limited', retry_after_ms: -1 } };
			const headers = new Headers({ 'retry-after-ms': '2500' });
			const response = new Response(JSON.stringify(body), { status: 429, headers });

			const { rateLimit } = await handleErrorResponse(response);

			expect(rateLimit?.retryAfterMs).toBe(2500);
		});

	it('caps retryAfterMs at 5 minutes', async () => {
		const body = { error: { message: 'rate limited', retry_after_ms: 600000 } };
		const response = new Response(JSON.stringify(body), { status: 429 });
		
		const { rateLimit } = await handleErrorResponse(response);
		
		expect(rateLimit?.retryAfterMs).toBe(300000);
	});

	it('handles invalid retry-after header with default fallback', async () => {
		const headers = new Headers({ 'retry-after': 'invalid' });
		const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
		
		const { rateLimit } = await handleErrorResponse(response);
		
		expect(rateLimit?.retryAfterMs).toBe(60000);
	});

		it('handles millisecond unix timestamp in reset header', async () => {
			const futureTimestampMs = Date.now() + 45000;
			const headers = new Headers({ 'x-ratelimit-reset': String(futureTimestampMs) });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
		});

		it('parses resetsAt in milliseconds format from body (already in ms)', async () => {
			const futureTimestampMs = Date.now() + 30000;
			const body = { error: { message: 'rate limited', resets_at: futureTimestampMs } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
			expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(30000);
		});

		it('handles resetsAt in the past (delta <= 0)', async () => {
			const pastTimestamp = Math.floor(Date.now() / 1000) - 60;
			const body = { error: { message: 'rate limited', resets_at: pastTimestamp } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit?.retryAfterMs).toBe(60000);
		});

		it('falls back to statusText when body is empty', async () => {
			const response = new Response('', { status: 500, statusText: 'Internal Server Error' });
			
			const { response: errorResponse } = await handleErrorResponse(response);
			const json = await errorResponse.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('Internal Server Error');
		});

		it('falls back to default message when body and statusText are empty', async () => {
			const response = new Response('', { status: 500, statusText: '' });
			
			const { response: errorResponse } = await handleErrorResponse(response);
			const json = await errorResponse.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('Request failed');
		});
	});

	describe('transformRequestForCodex', () => {
		it('returns undefined when init is undefined (line 166 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const result = await transformRequestForCodex(undefined, 'https://example.com', { global: {}, models: {} });
			expect(result).toBeUndefined();
		});

		it('returns undefined when init.body is undefined (line 166 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const result = await transformRequestForCodex({}, 'https://example.com', { global: {}, models: {} });
			expect(result).toBeUndefined();
		});

			it('returns undefined when init.body is not a string (line 167 coverage)', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const result = await transformRequestForCodex(
					{ body: new Blob(['test']) as unknown as BodyInit },
				'https://example.com',
				{ global: {}, models: {} }
				);
				expect(result).toBeUndefined();
			});

			it('transforms request when parsedBody is provided even if init.body is not a string', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const parsedBody = {
					model: 'gpt-5.3-codex',
					input: [{ type: 'message', role: 'user', content: 'hi' }],
				};
				const result = await transformRequestForCodex(
					{ body: new Blob(['ignored']) as unknown as BodyInit },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					parsedBody,
					{ fastSession: true, fastSessionStrategy: 'always', fastSessionMaxInputItems: 12 },
				);

				expect(result).toBeDefined();
				expect(result?.body.model).toBe('gpt-5-codex');
				expect(typeof result?.updatedInit.body).toBe('string');
			});

			it('returns undefined when parsedBody is empty object and init body is unavailable', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const result = await transformRequestForCodex(
					{ body: new Blob(['ignored']) as unknown as BodyInit },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					{},
				);

				expect(result).toBeUndefined();
			});

		it('returns undefined and logs error when JSON parsing fails (line 220-222 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const result = await transformRequestForCodex(
				{ body: 'not valid json {{{' },
				'https://example.com',
				{ global: {}, models: {} }
			);
			expect(result).toBeUndefined();
		});

		it('transforms request body successfully (lines 194-202 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const requestBody = { model: 'gpt-5.1', input: 'Hello' };
			const result = await transformRequestForCodex(
				{ body: JSON.stringify(requestBody) },
				'https://example.com',
				{ global: {}, models: {} }
			);
			expect(result).toBeDefined();
			expect(result?.body).toBeDefined();
			expect(result?.body.model).toBe('gpt-5.1');
			expect(result?.updatedInit).toBeDefined();
		});
	describe("additional edge branches", () => {
		it("handles unsupported model info for malformed payloads", () => {
			expect(getUnsupportedCodexModelInfo(undefined).isUnsupported).toBe(false);
			expect(
				getUnsupportedCodexModelInfo({ error: "not-an-object" }).isUnsupported,
			).toBe(false);

			const info = getUnsupportedCodexModelInfo({
				error: {
					code: 123,
				},
			});
			expect(info.code).toBeUndefined();
			expect(info.message).toBeUndefined();
			expect(info.isUnsupported).toBe(false);
		});

		it("resolves unsupported-model fallbacks with custom chains and canonicalization", () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: "org/gpt-5.3-codex-high",
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message: "not supported when using Codex with a ChatGPT account",
					},
				},
				attemptedModels: ["", "   ", "gpt-5.3-codex"],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
				customChain: {
					"": ["gpt-5-codex"],
					"gpt-5.3-codex": ["gpt-5.3-codex", "gpt-5-codex-low"],
					"bad-entry": "not-an-array" as unknown as string[],
				},
			});

			expect(fallback).toBe("gpt-5-codex");
		});

		it("returns undefined when fallback is disabled or model cannot be resolved", () => {
			const unsupportedError = {
				error: {
					code: "model_not_supported_with_chatgpt_account",
				},
			};

			expect(
				resolveUnsupportedCodexFallbackModel({
					requestedModel: "gpt-5.3-codex",
					errorBody: unsupportedError,
					fallbackOnUnsupportedCodexModel: false,
					fallbackToGpt52OnUnsupportedGpt53: true,
				}),
			).toBeUndefined();

			expect(
				resolveUnsupportedCodexFallbackModel({
					requestedModel: undefined,
					errorBody: unsupportedError,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				}),
			).toBeUndefined();

			expect(
				resolveUnsupportedCodexFallbackModel({
					requestedModel: "unknown-codex-model",
					errorBody: unsupportedError,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				}),
			).toBeUndefined();
		});

		it("throws when createCodexHeaders receives invalid named-parameter candidates", () => {
			expect(() => createCodexHeaders("bad" as unknown as RequestInit)).toThrow(
				"createCodexHeaders requires accountId and accessToken",
			);

			expect(() =>
				createCodexHeaders({
					accountId: "acc",
					accessToken: "tok",
					extra: "value",
				} as unknown as CreateCodexHeadersParams),
			).toThrow("createCodexHeaders requires accountId and accessToken");

			expect(() =>
				createCodexHeaders({
					accountId: "acc",
					accessToken: 123,
				} as unknown as CreateCodexHeadersParams),
			).toThrow("createCodexHeaders requires accountId and accessToken");
		});

		it("refreshes using API auth without mutating oauth-only fields", async () => {
			const auth: Auth = { type: "api", key: "api-key" };
			const client = { auth: { set: vi.fn() } };

			vi.spyOn(refreshQueueModule, "queuedRefresh").mockResolvedValue({
				type: "success",
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 60_000,
			} as never);

			const updated = await refreshAndUpdateToken(auth, client as never);
			expect(updated).toBe(auth);
			expect(client.auth.set).toHaveBeenCalledTimes(1);
		});

		it("transforms parsed body when init is undefined", async () => {
			const { transformRequestForCodex } =
				await import("../lib/request/fetch-helpers.js");
			const result = await transformRequestForCodex(
				undefined,
				"https://example.com",
				{ global: {}, models: {} },
				true,
				{
					model: "gpt-5.3-codex",
					input: [{ type: "message", role: "user", content: "hello" }],
				},
			);

			expect(result).toBeDefined();
			expect(typeof result?.updatedInit.body).toBe("string");
			expect(result?.body.model).toBe("gpt-5-codex");
		});

		it("adds codex login hint for unauthorized top-level, trimmed, statusText, and fallback messages", async () => {
			const topLevel = await handleErrorResponse(
				new Response(JSON.stringify({ message: "token invalid" }), {
					status: 401,
					statusText: "Unauthorized",
				}),
			);
			const topLevelJson = (await topLevel.response.json()) as {
				error: { message: string };
			};
			expect(topLevelJson.error.message).toContain("codex login");

			const trimmed = await handleErrorResponse(
				new Response("plain auth failure", {
					status: 401,
					statusText: "Unauthorized",
				}),
			);
			const trimmedJson = (await trimmed.response.json()) as {
				error: { message: string };
			};
			expect(trimmedJson.error.message).toContain("codex login");

			const statusText = await handleErrorResponse(
				new Response("", { status: 401, statusText: "Unauthorized" }),
			);
			const statusTextJson = (await statusText.response.json()) as {
				error: { message: string };
			};
			expect(statusTextJson.error.message).toContain("codex login");

			const fallback = await handleErrorResponse(
				new Response("", { status: 401, statusText: "" }),
			);
			const fallbackJson = (await fallback.response.json()) as {
				error: { message: string };
			};
			expect(fallbackJson.error.message).toContain("codex login");
		});

		it("does not remap empty 404 bodies to rate limits", async () => {
			const { response, rateLimit } = await handleErrorResponse(
				new Response("", { status: 404 }),
			);
			expect(response.status).toBe(404);
			expect(rateLimit).toBeUndefined();
		});

		it("falls back to default retry window when retry metadata is invalid", async () => {
			const pastUnixSeconds = Math.floor(Date.now() / 1000) - 60;
			const response = new Response(
				JSON.stringify({
					error: {
						message: "rate limited",
						retry_after_ms: "not-a-number",
						retry_after: 0,
						resets_at: "also-bad",
					},
				}),
				{
					status: 429,
					headers: {
						"retry-after-ms": "NaN",
						"retry-after": "0",
						"x-ratelimit-reset": String(pastUnixSeconds),
					},
				},
			);

			const { rateLimit } = await handleErrorResponse(response);
			expect(rateLimit?.retryAfterMs).toBe(60000);
		});

		it("uses generic unsupported model placeholder when body has no quoted model", async () => {
			const body = {
				detail:
					"model is not supported when using Codex with a ChatGPT account",
			};
			const response = new Response(JSON.stringify(body), {
				status: 400,
				statusText: "Bad Request",
			});

			const { response: result } = await handleErrorResponse(response);
			const json = (await result.json()) as {
				error: { unsupported_model?: string };
			};
			expect(json.error.unsupported_model).toBe("requested model");
		});
	});
});

});
