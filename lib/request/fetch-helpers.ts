/**
 * Helper functions for the custom fetch implementation
 * These functions break down the complex fetch logic into manageable, testable units
 */

import type { Auth, OpencodeClient } from "@opencode-ai/sdk";
import { queuedRefresh } from "../refresh-queue.js";
import { logRequest, logError, logWarn } from "../logger.js";
import { getCodexInstructions, getModelFamily } from "../prompts/codex.js";
import { transformRequestBody, normalizeModel } from "./request-transformer.js";
import { convertSseToJson, ensureContentType } from "./response-handler.js";
import type { UserConfig, RequestBody } from "../types.js";
import { CodexAuthError } from "../errors.js";
import { isRecord } from "../utils.js";
import {
        CODEX_BASE_URL,
        HTTP_STATUS,
        OPENAI_HEADERS,
        OPENAI_HEADER_VALUES,
        URL_PATHS,
        ERROR_MESSAGES,
        LOG_STAGES,
} from "../constants.js";

export interface RateLimitInfo {
        retryAfterMs: number;
        code?: string;
}

export interface EntitlementError {
        isEntitlement: true;
        code: string;
        message: string;
}

const CODEX_BASE_URL_OBJECT = new URL(CODEX_BASE_URL);
const CODEX_BASE_PATH_PREFIX = CODEX_BASE_URL_OBJECT.pathname.endsWith("/")
	? CODEX_BASE_URL_OBJECT.pathname.slice(0, -1)
	: CODEX_BASE_URL_OBJECT.pathname;

const CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE = "model_not_supported_with_chatgpt_account";
const CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN =
	/model is not supported when using codex with a chatgpt account/i;
const NORMALIZED_UNSUPPORTED_MODEL_PATTERN =
	/the model ['"]([^'"]+)['"] is not currently available for this chatgpt account/i;

export const DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN: Record<string, string[]> = {
	"gpt-5.3-codex-spark": ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"],
	"gpt-5.3-codex": ["gpt-5-codex", "gpt-5.2-codex"],
	"gpt-5.2-codex": ["gpt-5-codex"],
	"gpt-5.1-codex": ["gpt-5-codex"],
};

export interface UnsupportedCodexModelInfo {
	isUnsupported: boolean;
	code?: string;
	message?: string;
	unsupportedModel?: string;
}

export interface ResolveUnsupportedCodexFallbackOptions {
	requestedModel: string | undefined;
	errorBody: unknown;
	attemptedModels?: Iterable<string>;
	fallbackOnUnsupportedCodexModel: boolean;
	fallbackToGpt52OnUnsupportedGpt53: boolean;
	customChain?: Record<string, string[]>;
}

function canonicalizeModelName(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const trimmed = model.trim().toLowerCase();
	if (!trimmed) return undefined;
	const stripped = trimmed.includes("/")
		? (trimmed.split("/").pop() ?? trimmed)
		: trimmed;
	return stripped.replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");
}

function normalizeFallbackChain(
	customChain: Record<string, string[]> | undefined,
): Record<string, string[]> {
	const normalized: Record<string, string[]> = {};
	for (const [key, values] of Object.entries(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN)) {
		const normalizedKey = canonicalizeModelName(key);
		if (!normalizedKey) continue;
		normalized[normalizedKey] = values
			.map((value) => canonicalizeModelName(value))
			.filter((value): value is string => !!value);
	}

	if (!customChain) {
		return normalized;
	}

	for (const [key, values] of Object.entries(customChain)) {
		const normalizedKey = canonicalizeModelName(key);
		if (!normalizedKey || !Array.isArray(values)) continue;
		const normalizedValues = values
			.map((value) => canonicalizeModelName(value))
			.filter((value): value is string => !!value);
		if (normalizedValues.length > 0) {
			normalized[normalizedKey] = normalizedValues;
		}
	}

	return normalized;
}

export function extractUnsupportedCodexModelFromText(bodyText: string): string | undefined {
	const directMatch = bodyText.match(
		/['"]([^'"]+)['"]\s+model is not supported when using codex with a chatgpt account/i,
	);
	if (directMatch?.[1]) {
		return canonicalizeModelName(directMatch[1]);
	}
	const normalizedMatch = bodyText.match(NORMALIZED_UNSUPPORTED_MODEL_PATTERN);
	if (normalizedMatch?.[1]) {
		return canonicalizeModelName(normalizedMatch[1]);
	}
	return undefined;
}

function isUnsupportedCodexModelForChatGpt(status: number, bodyText: string): boolean {
	if (status !== HTTP_STATUS.BAD_REQUEST) return false;
	if (!bodyText) return false;
	return CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(bodyText);
}

export function getUnsupportedCodexModelInfo(
	errorBody: unknown,
): UnsupportedCodexModelInfo {
	if (!isRecord(errorBody)) {
		return { isUnsupported: false };
	}

	const maybeError = errorBody.error;
	if (!isRecord(maybeError)) {
		return { isUnsupported: false };
	}

	const code = typeof maybeError.code === "string" ? maybeError.code : undefined;
	const message =
		typeof maybeError.message === "string" ? maybeError.message : undefined;
	const unsupportedModelFromPayload =
		typeof maybeError.unsupported_model === "string"
			? maybeError.unsupported_model
			: undefined;
	const unsupportedModel = unsupportedModelFromPayload
		? canonicalizeModelName(unsupportedModelFromPayload)
		: extractUnsupportedCodexModelFromText(message ?? "");
	const isUnsupported =
		code === CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE ||
		(message ? CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(message) : false);

	return {
		isUnsupported,
		code,
		message,
		unsupportedModel: unsupportedModel ?? undefined,
	};
}

export function resolveUnsupportedCodexFallbackModel(
	options: ResolveUnsupportedCodexFallbackOptions,
): string | undefined {
	if (!options.fallbackOnUnsupportedCodexModel) return undefined;

	const unsupported = getUnsupportedCodexModelInfo(options.errorBody);
	if (!unsupported.isUnsupported) return undefined;

	const requestedModel = canonicalizeModelName(options.requestedModel);
	const currentModel = requestedModel ?? unsupported.unsupportedModel;
	if (!currentModel) return undefined;

	const attempted = new Set<string>();
	for (const model of options.attemptedModels ?? []) {
		const normalized = canonicalizeModelName(model);
		if (normalized) attempted.add(normalized);
	}

	const chain = normalizeFallbackChain(options.customChain);
	const targets = chain[currentModel] ?? [];
	if (targets.length === 0) return undefined;

	for (const target of targets) {
		if (!options.fallbackToGpt52OnUnsupportedGpt53 &&
			currentModel === "gpt-5.3-codex" &&
			target === "gpt-5.2-codex") {
			continue;
		}
		if (target === currentModel) continue;
		if (attempted.has(target)) continue;
		return target;
	}

	return undefined;
}

/**
 * Returns true when the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge is available.
 */
export function shouldFallbackToGpt52OnUnsupportedGpt53(
	requestedModel: string | undefined,
	errorBody: unknown,
): boolean {
	if (canonicalizeModelName(requestedModel) !== "gpt-5.3-codex") {
		return false;
	}

	return (
		resolveUnsupportedCodexFallbackModel({
			requestedModel,
			errorBody,
			// Skip the canonical `gpt-5-codex` step and probe whether the legacy
			// gpt-5.2 edge is still active under current policy/toggles.
			attemptedModels: ["gpt-5-codex"],
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: true,
		}) === "gpt-5.2-codex"
	);
}

/**
 * Checks if an error code indicates an entitlement/subscription issue
 * These errors should NOT be treated as rate limits because:
 * 1. They won't resolve by waiting
 * 2. They won't resolve by switching accounts (all accounts likely have same issue)
 * 3. User needs to upgrade their subscription
 */
export function isEntitlementError(code: string, bodyText: string): boolean {
        const haystack = `${code} ${bodyText}`.toLowerCase();
        // "usage_not_included" means the subscription doesn't include this feature
        // This is different from "usage_limit_reached" which is a temporary quota limit
        return /usage_not_included|not.included.in.your.plan|subscription.does.not.include/i.test(haystack);
}

/**
 * Creates a user-friendly entitlement error response
 */
export function createEntitlementErrorResponse(_bodyText: string): Response {
        const message = 
                "This model is not included in your ChatGPT subscription. " +
                "Please check that your account or workspace has access to Codex models (Plus/Pro/Business/Enterprise). " +
                "If you recently subscribed or switched workspaces, try logging out and back in with `opencode auth login`.";
        
        const payload = {
                error: {
                        message,
                        type: "entitlement_error",
                        code: "usage_not_included",
                },
        };

        return new Response(JSON.stringify(payload), {
                status: 403, // Forbidden - not a rate limit
                statusText: "Forbidden",
                headers: { "content-type": "application/json; charset=utf-8" },
        });
}

export interface ErrorHandlingResult {
        response: Response;
        rateLimit?: RateLimitInfo;
        errorBody?: unknown;
}

export interface ErrorHandlingOptions {
	requestCorrelationId?: string;
	threadId?: string;
}

export interface ErrorDiagnostics {
	requestId?: string;
	cfRay?: string;
	correlationId?: string;
	threadId?: string;
	httpStatus?: number;
}

/**
 * Determines if the current auth token needs to be refreshed
 * @param auth - Current authentication state
 * @returns True if token is expired or invalid
 */
export function shouldRefreshToken(auth: Auth, skewMs = 0): boolean {
	if (auth.type !== "oauth") return true;
	if (!auth.access) return true;

	const safeSkewMs = Math.max(0, Math.floor(skewMs));
	return auth.expires <= Date.now() + safeSkewMs;
}

/**
 * Refreshes the OAuth token and updates stored credentials
 * @param currentAuth - Current auth state
 * @param client - Opencode client for updating stored credentials
 * @returns Updated auth (throws on failure)
 */
export async function refreshAndUpdateToken(
	currentAuth: Auth,
	client: OpencodeClient,
): Promise<Auth> {
	const refreshToken = currentAuth.type === "oauth" ? currentAuth.refresh : "";
	const refreshResult = await queuedRefresh(refreshToken);

	if (refreshResult.type === "failed") {
		throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, { retryable: false });
	}

	await client.auth.set({
		path: { id: "openai" },
		body: {
			type: "oauth",
			access: refreshResult.access,
			refresh: refreshResult.refresh,
			expires: refreshResult.expires,
			multiAccount: true,
		} as Parameters<typeof client.auth.set>[0]["body"],
	});

	// Update current auth reference if it's OAuth type
	if (currentAuth.type === "oauth") {
		currentAuth.access = refreshResult.access;
		currentAuth.refresh = refreshResult.refresh;
		currentAuth.expires = refreshResult.expires;
	}

	return currentAuth;
}

/**
 * Extracts URL string from various request input types
 * @param input - Request input (string, URL, or Request object)
 * @returns URL string
 */
export function extractRequestUrl(input: Request | string | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * Rewrites OpenAI API URLs to Codex backend URLs
 * @param url - Original URL
 * @returns Rewritten URL for Codex backend
 */
export function rewriteUrlForCodex(url: string): string {
	const parsedUrl = new URL(url);
	const rewrittenPath = parsedUrl.pathname.includes(URL_PATHS.RESPONSES)
		? parsedUrl.pathname.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES)
		: parsedUrl.pathname;
	const normalizedPath =
		rewrittenPath === CODEX_BASE_PATH_PREFIX ||
		rewrittenPath.startsWith(`${CODEX_BASE_PATH_PREFIX}/`)
			? rewrittenPath
			: `${CODEX_BASE_PATH_PREFIX}${rewrittenPath.startsWith("/") ? rewrittenPath : `/${rewrittenPath}`}`;

	parsedUrl.protocol = CODEX_BASE_URL_OBJECT.protocol;
	parsedUrl.username = "";
	parsedUrl.password = "";
	parsedUrl.host = CODEX_BASE_URL_OBJECT.host;
	parsedUrl.pathname = normalizedPath;

	return parsedUrl.toString();
}

/**
 * Transforms request body and logs the transformation
 * Fetches model-specific Codex instructions based on the request model
 *
 * @param init - Request init options
 * @param url - Request URL
 * @param userConfig - User configuration
 * @param codexMode - Enable CODEX_MODE (bridge prompt instead of tool remap)
 * @param parsedBody - Pre-parsed body to avoid double JSON.parse (optional)
 * @returns Transformed body and updated init, or undefined if no body
 */
export async function transformRequestForCodex(
	init: RequestInit | undefined,
	url: string,
	userConfig: UserConfig,
	codexMode = true,
	parsedBody?: Record<string, unknown>,
	options?: {
		fastSession?: boolean;
		fastSessionStrategy?: "hybrid" | "always";
		fastSessionMaxInputItems?: number;
	},
): Promise<{ body: RequestBody; updatedInit: RequestInit } | undefined> {
	const hasParsedBody =
		parsedBody !== undefined &&
		parsedBody !== null &&
		typeof parsedBody === "object" &&
		Object.keys(parsedBody).length > 0;
	if (!init?.body && !hasParsedBody) return undefined;

	try {
		// Use pre-parsed body if provided, otherwise parse from init.body
		let body: RequestBody;
		if (hasParsedBody) {
			body = parsedBody as RequestBody;
		} else {
			if (typeof init?.body !== "string") return undefined;
			body = JSON.parse(init.body) as RequestBody;
		}
		const originalModel = body.model;

		// Normalize model first to determine which instructions to fetch
		// This ensures we get the correct model-specific prompt
		const normalizedModel = normalizeModel(originalModel);
		const modelFamily = getModelFamily(normalizedModel);

		// Log original request
		logRequest(LOG_STAGES.BEFORE_TRANSFORM, {
			url,
			originalModel,
			model: body.model,
			hasTools: !!body.tools,
			hasInput: !!body.input,
			inputLength: body.input?.length,
			codexMode,
			body: body as unknown as Record<string, unknown>,
		});

		// Fetch model-specific Codex instructions (cached per model family)
		const codexInstructions = await getCodexInstructions(normalizedModel);

		// Transform request body
		const transformedBody = await transformRequestBody(
			body,
			codexInstructions,
			userConfig,
			codexMode,
			options?.fastSession ?? false,
			options?.fastSessionStrategy ?? "hybrid",
			options?.fastSessionMaxInputItems ?? 30,
		);

		// Log transformed request
		logRequest(LOG_STAGES.AFTER_TRANSFORM, {
			url,
			originalModel,
			normalizedModel: transformedBody.model,
			modelFamily,
			hasTools: !!transformedBody.tools,
			hasInput: !!transformedBody.input,
			inputLength: transformedBody.input?.length,
			reasoning: transformedBody.reasoning as unknown,
			textVerbosity: transformedBody.text?.verbosity,
			include: transformedBody.include,
			body: transformedBody as unknown as Record<string, unknown>,
		});

			return {
				body: transformedBody,
				updatedInit: { ...(init ?? {}), body: JSON.stringify(transformedBody) },
			};
	} catch (e) {
		logError(`${ERROR_MESSAGES.REQUEST_PARSE_ERROR}`, e);
		return undefined;
	}
}

/**
 * Creates headers for Codex API requests
 * @param init - Request init options
 * @param accountId - ChatGPT account ID
 * @param accessToken - OAuth access token
 * @returns Headers object with all required Codex headers
 */
export function createCodexHeaders(
    init: RequestInit | undefined,
    accountId: string,
    accessToken: string,
    opts?: { model?: string; promptCacheKey?: string },
): Headers {
	const headers = new Headers(init?.headers ?? {});
	headers.delete("x-api-key"); // Remove any existing API key
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);

    const cacheKey = opts?.promptCacheKey;
    if (cacheKey) {
        headers.set(OPENAI_HEADERS.CONVERSATION_ID, cacheKey);
        headers.set(OPENAI_HEADERS.SESSION_ID, cacheKey);
    } else {
        headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
        headers.delete(OPENAI_HEADERS.SESSION_ID);
    }
    headers.set("accept", "text/event-stream");
    return headers;
}

/**
 * Handles error responses from the Codex API
 * @param response - Error response from API
 * @returns Original response or mapped retryable response
 */
export async function handleErrorResponse(
        response: Response,
        options?: ErrorHandlingOptions,
): Promise<ErrorHandlingResult> {
        const bodyText = await safeReadBody(response);
        const mapped = mapUsageLimit404WithBody(response, bodyText);
        
        // Entitlement errors return a ready-to-use Response with 403 status
        if (mapped && mapped.status === HTTP_STATUS.FORBIDDEN) {
                return { response: mapped, rateLimit: undefined, errorBody: undefined };
        }
        
        const finalResponse = mapped ?? response;
        const rateLimit = extractRateLimitInfoFromBody(finalResponse, bodyText);

        let errorBody: unknown;
        try {
                errorBody = bodyText ? JSON.parse(bodyText) : undefined;
        } catch {
                errorBody = { message: bodyText };
        }

        const diagnostics = extractErrorDiagnostics(finalResponse, options);
        const normalizedError = normalizeErrorPayload(
                errorBody,
                bodyText,
                finalResponse.statusText,
                finalResponse.status,
                diagnostics,
        );
        const errorResponse = ensureJsonErrorResponse(finalResponse, normalizedError);

        if (finalResponse.status === HTTP_STATUS.UNAUTHORIZED) {
                logWarn("Codex upstream returned 401 Unauthorized", diagnostics);
        }

        logRequest(LOG_STAGES.ERROR_RESPONSE, {
                status: finalResponse.status,
                statusText: finalResponse.statusText,
                diagnostics,
        });

        return { response: errorResponse, rateLimit, errorBody: normalizedError };
}

/**
 * Handles successful responses from the Codex API
 * Converts SSE to JSON for non-streaming requests (generateText)
 * Passes through SSE for streaming requests (streamText)
 * @param response - Success response from API
 * @param isStreaming - Whether this is a streaming request (stream=true in body)
 * @returns Processed response (SSE→JSON for non-streaming, stream for streaming)
 */
export async function handleSuccessResponse(
    response: Response,
    isStreaming: boolean,
    options?: { streamStallTimeoutMs?: number },
): Promise<Response> {
    // Check for deprecation headers (RFC 8594)
    const deprecation = response.headers.get("Deprecation");
    const sunset = response.headers.get("Sunset");
    if (deprecation || sunset) {
        logWarn(`API deprecation notice`, { deprecation, sunset });
    }

    const responseHeaders = ensureContentType(response.headers);

	// For non-streaming requests (generateText), convert SSE to JSON
	if (!isStreaming) {
		return await convertSseToJson(response, responseHeaders, options);
	}

	// For streaming requests (streamText), return stream as-is
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
}

async function safeReadBody(response: Response): Promise<string> {
        try {
                return await response.clone().text();
        } catch {
                return "";
        }
}

function mapUsageLimit404WithBody(response: Response, bodyText: string): Response | null {
        if (response.status !== HTTP_STATUS.NOT_FOUND) return null;
        if (!bodyText) return null;

	let code = "";
	try {
		const parsed = JSON.parse(bodyText) as { error?: { code?: string | number; type?: string } };
		code = (parsed?.error?.code ?? parsed?.error?.type ?? "").toString();
	} catch {
		code = "";
	}

	// Check for entitlement errors first - these should NOT be treated as rate limits
	if (isEntitlementError(code, bodyText)) {
		return createEntitlementErrorResponse(bodyText);
	}

	const haystack = `${code} ${bodyText}`.toLowerCase();
	if (!/usage_limit_reached|rate_limit_exceeded|usage limit/i.test(haystack)) {
		return null;
	}

        const headers = new Headers(response.headers);
        return new Response(bodyText, {
                status: HTTP_STATUS.TOO_MANY_REQUESTS,
                statusText: "Too Many Requests",
                headers,
        });
}

function extractRateLimitInfoFromBody(
        response: Response,
        bodyText: string,
): RateLimitInfo | undefined {
        const isStatusRateLimit =
                response.status === HTTP_STATUS.TOO_MANY_REQUESTS;
        const parsed = parseRateLimitBody(bodyText);

        const haystack = `${parsed?.code ?? ""} ${bodyText}`.toLowerCase();
        
        // Entitlement errors should not be treated as rate limits
        if (isEntitlementError(parsed?.code ?? "", bodyText)) {
                return undefined;
        }
        
        const isRateLimit =
                isStatusRateLimit ||
                /usage_limit_reached|rate_limit_exceeded|rate_limit|usage limit/i.test(
                        haystack,
                );
        if (!isRateLimit) return undefined;

        const retryAfterMs =
                parseRetryAfterMs(response, parsed) ?? 60000;

        return { retryAfterMs, code: parsed?.code };
}

interface RateLimitErrorBody {
	error?: {
		code?: string | number;
		type?: string;
		resets_at?: number;
		reset_at?: number;
		retry_after_ms?: number;
		retry_after?: number;
	};
}

function parseRateLimitBody(
	body: string,
): { code?: string; resetsAt?: number; retryAfterMs?: number } | undefined {
	if (!body) return undefined;
	try {
		const parsed = JSON.parse(body) as RateLimitErrorBody;
		const error = parsed?.error ?? {};
		const code = (error.code ?? error.type ?? "").toString();
		const resetsAt = toNumber(error.resets_at ?? error.reset_at);
		const retryAfterMs = toNumber(error.retry_after_ms ?? error.retry_after);
		return { code, resetsAt, retryAfterMs };
	} catch {
		return undefined;
	}
}

type ErrorPayload = {
        error: {
                message: string;
                type?: string;
                code?: string | number;
                unsupported_model?: string;
                diagnostics?: ErrorDiagnostics;
        };
};

function normalizeErrorPayload(
        errorBody: unknown,
        bodyText: string,
        statusText: string,
        status: number,
        diagnostics?: ErrorDiagnostics,
): ErrorPayload {
        if (isUnsupportedCodexModelForChatGpt(status, bodyText)) {
                const unsupportedModel =
			extractUnsupportedCodexModelFromText(bodyText) ?? "requested model";
				const payload: ErrorPayload = {
						error: {
								message:
										`The model '${unsupportedModel}' is not currently available for this ChatGPT account when using Codex OAuth. ` +
										"This is an account/workspace entitlement gate, not a temporary rate limit. " +
										"Try 'gpt-5-codex' (canonical), or legacy aliases like 'gpt-5.3-codex'/'gpt-5.2-codex', or enable automatic fallback via " +
										'unsupportedCodexPolicy: "fallback" (or CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback). ' +
										"(Legacy: CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1 or fallbackOnUnsupportedCodexModel).",
								type: "entitlement_error",
								code: CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE,
								unsupported_model: unsupportedModel,
						},
				};
                if (diagnostics && Object.keys(diagnostics).length > 0) {
                        payload.error.diagnostics = diagnostics;
                }
                return payload;
        }

        if (isRecord(errorBody)) {
                const maybeError = errorBody.error;
                if (isRecord(maybeError) && typeof maybeError.message === "string") {
                        const payload: ErrorPayload = {
                                error: {
                                        message: maybeError.message,
                                },
                        };
                        if (typeof maybeError.type === "string") {
                                payload.error.type = maybeError.type;
                        }
                        if (typeof maybeError.code === "string" || typeof maybeError.code === "number") {
                                payload.error.code = maybeError.code;
                        }
                        if (diagnostics && Object.keys(diagnostics).length > 0) {
                                payload.error.diagnostics = diagnostics;
                        }
                        if (status === HTTP_STATUS.UNAUTHORIZED) {
                                payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                        }
                        return payload;
                }

                if (typeof errorBody.message === "string") {
                        const payload: ErrorPayload = { error: { message: errorBody.message } };
                        if (diagnostics && Object.keys(diagnostics).length > 0) {
                                payload.error.diagnostics = diagnostics;
                        }
                        if (status === HTTP_STATUS.UNAUTHORIZED) {
                                payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                        }
                        return payload;
                }
        }

        const trimmed = bodyText.trim();
        if (trimmed) {
                const payload: ErrorPayload = { error: { message: trimmed } };
                if (diagnostics && Object.keys(diagnostics).length > 0) {
                        payload.error.diagnostics = diagnostics;
                }
                if (status === HTTP_STATUS.UNAUTHORIZED) {
                        payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                }
                return payload;
        }

        if (statusText) {
                const payload: ErrorPayload = { error: { message: statusText } };
                if (diagnostics && Object.keys(diagnostics).length > 0) {
                        payload.error.diagnostics = diagnostics;
                }
                if (status === HTTP_STATUS.UNAUTHORIZED) {
                        payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                }
                return payload;
        }

        const payload: ErrorPayload = { error: { message: "Request failed" } };
        if (diagnostics && Object.keys(diagnostics).length > 0) {
                payload.error.diagnostics = diagnostics;
        }
        if (status === HTTP_STATUS.UNAUTHORIZED) {
                payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
        }
        return payload;
}

function ensureJsonErrorResponse(response: Response, payload: ErrorPayload): Response {
        const headers = new Headers(response.headers);
        headers.set("content-type", "application/json; charset=utf-8");
        return new Response(JSON.stringify(payload), {
                status: response.status,
                statusText: response.statusText,
                headers,
	});
}

function parseRetryAfterMs(
        response: Response,
        parsedBody?: { resetsAt?: number; retryAfterMs?: number },
): number | null {
        if (parsedBody?.retryAfterMs !== undefined) {
                return normalizeRetryAfter(parsedBody.retryAfterMs);
        }

        const retryAfterMsHeader = response.headers.get("retry-after-ms");
        if (retryAfterMsHeader) {
                const parsed = Number.parseInt(retryAfterMsHeader, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                        return parsed;
                }
        }

        const retryAfterHeader = response.headers.get("retry-after");
        if (retryAfterHeader) {
                const parsed = Number.parseInt(retryAfterHeader, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                        return parsed * 1000;
                }
        }

        const resetAtHeaders = [
                "x-codex-primary-reset-at",
                "x-codex-secondary-reset-at",
                "x-ratelimit-reset",
        ];
        const now = Date.now();
        const resetCandidates: number[] = [];
        for (const header of resetAtHeaders) {
                const value = response.headers.get(header);
                if (!value) continue;
                const parsed = Number.parseInt(value, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                        const timestamp =
                                parsed < 10_000_000_000 ? parsed * 1000 : parsed;
                        const delta = timestamp - now;
                        if (delta > 0) resetCandidates.push(delta);
                }
        }

        if (parsedBody?.resetsAt) {
                const timestamp =
                        parsedBody.resetsAt < 10_000_000_000
                                ? parsedBody.resetsAt * 1000
                                : parsedBody.resetsAt;
                const delta = timestamp - now;
                if (delta > 0) resetCandidates.push(delta);
        }

        if (resetCandidates.length > 0) {
                return Math.min(...resetCandidates);
        }

        return null;
}

function normalizeRetryAfter(value: number): number {
        if (!Number.isFinite(value)) return 60000;
        let ms: number;
        if (value > 0 && value < 1000) {
                ms = Math.floor(value * 1000);
        } else {
                ms = Math.floor(value);
        }
        const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
        return Math.min(ms, MAX_RETRY_DELAY_MS);
}

function toNumber(value: unknown): number | undefined {
        if (value === null || value === undefined) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
}

function extractErrorDiagnostics(
        response: Response,
        options?: ErrorHandlingOptions,
): ErrorDiagnostics | undefined {
        const requestId =
                response.headers.get("x-request-id") ??
                response.headers.get("request-id") ??
                response.headers.get("openai-request-id") ??
                response.headers.get("x-openai-request-id") ??
                undefined;
        const cfRay = response.headers.get("cf-ray") ?? undefined;

        const diagnostics: ErrorDiagnostics = {
                httpStatus: response.status,
                requestId,
                cfRay,
                correlationId: options?.requestCorrelationId,
                threadId: options?.threadId,
        };

        for (const [key, value] of Object.entries(diagnostics)) {
                if (value === undefined || value === "") {
                        delete diagnostics[key as keyof ErrorDiagnostics];
                }
        }

        return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}
