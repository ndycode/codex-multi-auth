/**
 * Helper functions for the custom fetch implementation
 * These functions break down the complex fetch logic into manageable, testable units
 */

import { logRequest, logError, logWarn } from "../logger.js";
import { getCodexInstructions, getModelFamily } from "../prompts/codex.js";
import {
	transformRequestBody,
	normalizeModel,
	resolveFastSessionInputTrimPlan,
	type FastSessionInputTrimPlan,
} from "./request-transformer.js";
import {
	attachResponseIdCapture,
	convertSseToJson,
	ensureContentType,
} from "./response-handler.js";
import type { UserConfig, RequestBody } from "../types.js";
import { isRecord } from "../utils.js";
import {
	HTTP_STATUS,
	ERROR_MESSAGES,
	LOG_STAGES,
} from "../constants.js";
import {
	CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE,
	createEntitlementErrorResponse,
	extractUnsupportedCodexModelFromText,
	isEntitlementError,
	isUnsupportedCodexModelForChatGpt,
} from "./error-classification.js";
import { logDeprecationHeaders } from "./headers.js";

export { shouldRefreshToken, refreshAndUpdateToken } from "./token-refresh.js";
export {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	extractUnsupportedCodexModelFromText,
	getUnsupportedCodexModelInfo,
	resolveUnsupportedCodexFallbackModel,
	shouldFallbackToGpt52OnUnsupportedGpt53,
	isEntitlementError,
	isWorkspaceDisabledError,
	createEntitlementErrorResponse,
} from "./error-classification.js";
export type {
	EntitlementError,
	UnsupportedCodexModelInfo,
	ResolveUnsupportedCodexFallbackOptions,
} from "./error-classification.js";
export {
	extractRequestUrl,
	rewriteUrlForCodex,
	resolveProxyUrlForRequest,
	closeSharedProxyDispatchers,
	applyProxyCompatibleInit,
} from "./url-rewriting.js";
export type { ProxyCompatibleRequestInit } from "./url-rewriting.js";
export { createCodexHeaders } from "./headers.js";
export type {
	CreateCodexHeadersOptions,
	CreateCodexHeadersParams,
} from "./headers.js";

export interface RateLimitInfo {
        retryAfterMs: number;
        code?: string;
}

const MAX_RATE_LIMIT_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_DURATION_PATTERN =
	/\b(?:try|retry)\s+again\s+in\s+(\d+)\s*(second|minute|hour|day)s?\b/i;
const RETRY_AFTER_CLOCK_TIME_PATTERN =
	/\b(?:try|retry)\s+again\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

export interface TransformRequestForCodexResult {
	body: RequestBody;
	updatedInit: RequestInit;
	deferredFastSessionInputTrim?: FastSessionInputTrimPlan["trim"];
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
		deferFastSessionInputTrimming?: boolean;
		allowBackgroundResponses?: boolean;
	},
): Promise<TransformRequestForCodexResult | undefined> {
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
		const fastSessionInputTrimPlan = resolveFastSessionInputTrimPlan(
			body,
			options?.fastSession ?? false,
			options?.fastSessionStrategy ?? "hybrid",
			options?.fastSessionMaxInputItems ?? 30,
		);

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
			options?.deferFastSessionInputTrimming ?? false,
			options?.allowBackgroundResponses ?? false,
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
				deferredFastSessionInputTrim:
					options?.deferFastSessionInputTrimming === true &&
					transformedBody.background !== true
						? fastSessionInputTrimPlan.trim
						: undefined,
			};
	} catch (e) {
		if (
			e instanceof Error &&
			e.message.startsWith("Responses background mode")
		) {
			throw e;
		}
		logError(`${ERROR_MESSAGES.REQUEST_PARSE_ERROR}`, e);
		return undefined;
	}
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
        // request-01: deprecation/sunset headers (RFC 8594) were logged only on the
        // success path. Upstream often attaches them to error responses too (e.g. a
        // sunset endpoint returning 4xx), so log them here as well.
        logDeprecationHeaders(response);
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
    options?: {
		onResponseId?: (responseId: string) => void;
		streamStallTimeoutMs?: number;
	},
): Promise<Response> {
    // Check for deprecation headers (RFC 8594) — see logDeprecationHeaders.
    logDeprecationHeaders(response);

    const responseHeaders = ensureContentType(response.headers);

	// For non-streaming requests (generateText), convert SSE to JSON
	if (!isStreaming) {
		return await convertSseToJson(response, responseHeaders, options);
	}

	// For streaming requests (streamText), return stream as-is
	return attachResponseIdCapture(response, responseHeaders, options?.onResponseId);
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
	let type = "";
	try {
		const parsed = JSON.parse(bodyText) as {
			error?: { code?: string | number; type?: string | number };
		};
		code = (parsed?.error?.code ?? "").toString();
		type = (parsed?.error?.type ?? "").toString();
	} catch {
		code = "";
		type = "";
	}

	const normalizedSignals = [code, type]
		.map((value) => value.toLowerCase())
		.filter((value) => value.length > 0);

	// Check for entitlement errors first - these should NOT be treated as rate limits
	if (isEntitlementError(normalizedSignals.join(" "), bodyText)) {
		return createEntitlementErrorResponse(bodyText);
	}

	// Only structured quota-limit codes should be remapped from 404 to 429.
	// Free-text 404 bodies remain untouched, but known quota/rate-limit codes
	// should still preserve retry semantics for callers.
	if (
		!normalizedSignals.some(
			(value) =>
				value.includes("usage_limit") || value.includes("rate_limit_exceeded"),
		)
	) {
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
        
        // Entitlement errors should not be treated as rate limits
        if (isEntitlementError(parsed?.code ?? "", bodyText)) {
                return undefined;
        }

        if (!isStatusRateLimit) return undefined;

        const retryAfterMs =
                parseRetryAfterMs(response, bodyText, parsed) ?? 60000;

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
): {
	code?: string;
	resetsAt?: number;
	retryAfterMs?: number;
	retryAfterSeconds?: number;
} | undefined {
	if (!body) return undefined;
	try {
		const parsed = JSON.parse(body) as RateLimitErrorBody;
		const error = parsed?.error ?? {};
		const code = (error.code ?? error.type ?? "").toString();
		const resetsAt = toNumber(error.resets_at ?? error.reset_at);
		const retryAfterMs = toNumber(error.retry_after_ms);
		const retryAfterSeconds = toNumber(error.retry_after);
		return { code, resetsAt, retryAfterMs, retryAfterSeconds };
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

/**
 * Build a normalized ErrorPayload from a raw response body, status, and diagnostics.
 *
 * Produces a structured error object by preferring explicit error fields in `errorBody`, falling back to `bodyText`, `statusText`, or a generic message; special-cases Codex ChatGPT unsupported-model entitlement errors and appends diagnostic info when provided.
 *
 * @param errorBody - Parsed response body, if available; may be any JSON-derived value.
 * @param bodyText - Raw response text used as a fallback message when structured fields are absent.
 * @param statusText - HTTP status text used as a final fallback for the error message.
 * @param status - HTTP status code; when 401 adds a short hint to run `codex-multi-auth login`.
 * @param diagnostics - Optional diagnostic metadata (request IDs, correlation/thread IDs); fields may be redacted for tokens and sensitive values.
 * @returns The normalized ErrorPayload with an `error.message` and optional `type`, `code`, `unsupported_model`, and `diagnostics` fields.
 *
 * Concurrency: pure and safe to call concurrently from multiple threads/tasks.
 * Filesystem: performs no filesystem I/O and has no Windows-specific behavior.
 * Token redaction: callers should assume diagnostic fields may be redacted to avoid leaking credentials.
 */
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
										"Try 'gpt-5.3-codex' (current), or legacy aliases like 'gpt-5-codex'/'gpt-5.2-codex', or enable automatic fallback via " +
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
                                payload.error.message = `${payload.error.message} (run \`codex-multi-auth login\` if this persists)`;
                        }
                        return payload;
                }

                if (typeof errorBody.message === "string") {
                        const payload: ErrorPayload = { error: { message: errorBody.message } };
                        if (diagnostics && Object.keys(diagnostics).length > 0) {
                                payload.error.diagnostics = diagnostics;
                        }
                        if (status === HTTP_STATUS.UNAUTHORIZED) {
                                payload.error.message = `${payload.error.message} (run \`codex-multi-auth login\` if this persists)`;
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
                        payload.error.message = `${payload.error.message} (run \`codex-multi-auth login\` if this persists)`;
                }
                return payload;
        }

        if (statusText) {
                const payload: ErrorPayload = { error: { message: statusText } };
                if (diagnostics && Object.keys(diagnostics).length > 0) {
                        payload.error.diagnostics = diagnostics;
                }
                if (status === HTTP_STATUS.UNAUTHORIZED) {
                        payload.error.message = `${payload.error.message} (run \`codex-multi-auth login\` if this persists)`;
                }
                return payload;
        }

        const payload: ErrorPayload = { error: { message: "Request failed" } };
        if (diagnostics && Object.keys(diagnostics).length > 0) {
                payload.error.diagnostics = diagnostics;
        }
        if (status === HTTP_STATUS.UNAUTHORIZED) {
                payload.error.message = `${payload.error.message} (run \`codex-multi-auth login\` if this persists)`;
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

function parseResetTimestampMs(rawValue: string): number | null {
	const trimmed = rawValue.trim();
	if (trimmed.length === 0) return null;

	if (/^\d+$/.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
		}
	}

	const parsedDate = Date.parse(trimmed);
	return Number.isFinite(parsedDate) ? parsedDate : null;
}

function parseRetryAfterMs(
	response: Response,
	bodyText: string,
	parsedBody?: { resetsAt?: number; retryAfterMs?: number; retryAfterSeconds?: number },
): number | null {
	if (parsedBody?.retryAfterMs !== undefined) {
		const normalized = normalizeRetryAfterMs(parsedBody.retryAfterMs);
		if (normalized !== null) return normalized;
	}

	if (parsedBody?.retryAfterSeconds !== undefined) {
		const normalized = normalizeRetryAfterSeconds(parsedBody.retryAfterSeconds);
		if (normalized !== null) return normalized;
	}

	const retryAfterMsHeader = response.headers.get("retry-after-ms");
	if (retryAfterMsHeader) {
		const parsed = Number.parseInt(retryAfterMsHeader, 10);
		const normalized = normalizeRetryAfterMs(parsed);
		if (normalized !== null) {
			return normalized;
		}
	}

	const retryAfterHeader = response.headers.get("retry-after");
	if (retryAfterHeader) {
		const parsed = Number.parseInt(retryAfterHeader, 10);
		const normalized = normalizeRetryAfterSeconds(parsed);
		if (normalized !== null) {
			return normalized;
		}
		const parsedDate = Date.parse(retryAfterHeader);
		if (Number.isFinite(parsedDate)) {
			const normalizedDate = normalizeRetryAfterMs(parsedDate - Date.now());
			if (normalizedDate !== null) {
				return normalizedDate;
			}
		}
	}

	const resetAfterSecondsHeaders = [
		"x-codex-primary-reset-after-seconds",
		"x-codex-secondary-reset-after-seconds",
	];
	const resetCandidates: number[] = [];
	for (const header of resetAfterSecondsHeaders) {
		const value = response.headers.get(header);
		if (!value) continue;
		const parsed = Number.parseInt(value, 10);
		const normalized = normalizeRetryAfterSeconds(parsed);
		if (normalized !== null) {
			resetCandidates.push(normalized);
		}
	}

	const resetAtHeaders = [
		"x-codex-primary-reset-at",
		"x-codex-secondary-reset-at",
		"x-ratelimit-reset",
	];
	const now = Date.now();
	for (const header of resetAtHeaders) {
		const value = response.headers.get(header);
		if (!value) continue;
		const timestamp = parseResetTimestampMs(value);
		if (timestamp === null) continue;
		const delta = normalizeRetryAfterMs(timestamp - now);
		if (delta !== null) resetCandidates.push(delta);
	}

	if (parsedBody?.resetsAt) {
		const timestamp =
			parsedBody.resetsAt < 10_000_000_000
				? parsedBody.resetsAt * 1000
				: parsedBody.resetsAt;
		const delta = normalizeRetryAfterMs(timestamp - now);
		if (delta !== null) resetCandidates.push(delta);
	}

	if (resetCandidates.length > 0) {
		return Math.max(...resetCandidates);
	}

	const naturalLanguageRetryAfterMs = parseRetryAfterTextMs(bodyText, now);
	if (naturalLanguageRetryAfterMs !== null) {
		return naturalLanguageRetryAfterMs;
	}

	return null;
}

function parseRetryAfterTextMs(bodyText: string, now: number): number | null {
	if (!bodyText) return null;

	const durationMatch = bodyText.match(RETRY_AFTER_DURATION_PATTERN);
	if (durationMatch) {
		const amount = Number.parseInt(durationMatch[1] ?? "", 10);
		const unit = (durationMatch[2] ?? "").toLowerCase();
		if (Number.isFinite(amount) && amount > 0) {
			const multiplier =
				unit === "second"
					? 1000
					: unit === "minute"
						? 60_000
						: unit === "hour"
							? 60 * 60_000
							: unit === "day"
								? 24 * 60 * 60_000
								: 0;
			if (multiplier > 0) {
				return clampRateLimitDelayMs(amount * multiplier);
			}
		}
	}

	const clockTimeMatch = bodyText.match(RETRY_AFTER_CLOCK_TIME_PATTERN);
	if (!clockTimeMatch) return null;

	const hour12 = Number.parseInt(clockTimeMatch[1] ?? "", 10);
	const minute = Number.parseInt(clockTimeMatch[2] ?? "0", 10);
	const meridiem = (clockTimeMatch[3] ?? "").toLowerCase();
	if (
		!Number.isFinite(hour12) ||
		hour12 < 1 ||
		hour12 > 12 ||
		!Number.isFinite(minute) ||
		minute < 0 ||
		minute > 59 ||
		(meridiem !== "am" && meridiem !== "pm")
	) {
		return null;
	}

	const target = new Date(now);
	let hour24 = hour12 % 12;
	if (meridiem === "pm") {
		hour24 += 12;
	}
	target.setHours(hour24, minute, 0, 0);
	if (target.getTime() <= now) {
		target.setDate(target.getDate() + 1);
	}

	return clampRateLimitDelayMs(target.getTime() - now);
}

function clampRateLimitDelayMs(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	const normalized = Math.floor(value);
	if (normalized <= 0) return null;
	return Math.min(normalized, MAX_RATE_LIMIT_DELAY_MS);
}

function normalizeRetryAfterMs(value: number): number | null {
	return clampRateLimitDelayMs(value);
}

function normalizeRetryAfterSeconds(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	return clampRateLimitDelayMs(value * 1000);
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


