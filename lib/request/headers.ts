/**
 * Header construction helpers for the custom fetch implementation
 * Extracted from fetch-helpers.ts (audit roadmap §4.1.2); fetch-helpers.ts
 * re-exports the public symbols so existing importers are unchanged.
 */

import { logWarn } from "../logger.js";
import { isRecord } from "../utils.js";
import { OPENAI_HEADERS, OPENAI_HEADER_VALUES } from "../constants.js";

const CREATE_CODEX_HEADERS_PARAM_KEYS = new Set(["init", "accountId", "accessToken", "opts"]);

export interface CreateCodexHeadersOptions {
	model?: string;
	promptCacheKey?: string;
}

export interface CreateCodexHeadersParams {
	init?: RequestInit;
	accountId: string;
	accessToken: string;
	opts?: CreateCodexHeadersOptions;
}

function isCreateCodexHeadersNamedParams(value: unknown): value is CreateCodexHeadersParams {
	if (!isRecord(value)) return false;
	if (typeof value.accountId !== "string" || typeof value.accessToken !== "string") return false;
	return Object.keys(value).every((key) => CREATE_CODEX_HEADERS_PARAM_KEYS.has(key));
}

/**
 * Creates headers for Codex API requests
 * @param init - Request init options
 * @param accountId - ChatGPT account ID
 * @param accessToken - OAuth access token
 * @returns Headers object with all required Codex headers
 */
export function createCodexHeaders(
	params: CreateCodexHeadersParams,
): Headers;
export function createCodexHeaders(
    init: RequestInit | undefined,
    accountId: string,
    accessToken: string,
    opts?: CreateCodexHeadersOptions,
): Headers;
export function createCodexHeaders(
    initOrParams: RequestInit | undefined | CreateCodexHeadersParams,
    accountId?: string,
    accessToken?: string,
    opts?: CreateCodexHeadersOptions,
): Headers {
	const useNamedParams =
		typeof accountId === "undefined" &&
		typeof accessToken === "undefined" &&
		isCreateCodexHeadersNamedParams(initOrParams);
	const namedParams = useNamedParams
		? (initOrParams as CreateCodexHeadersParams)
		: null;
	const resolvedInit = useNamedParams
		? namedParams?.init
		: (initOrParams as RequestInit | undefined);
	const resolvedAccountId = useNamedParams ? namedParams?.accountId : accountId;
	const resolvedAccessToken = useNamedParams ? namedParams?.accessToken : accessToken;
	const resolvedOpts = useNamedParams ? namedParams?.opts : opts;
	if (!resolvedAccountId || !resolvedAccessToken) {
		throw new TypeError("createCodexHeaders requires accountId and accessToken");
	}
	const headers = new Headers(resolvedInit?.headers ?? {});
	headers.delete("x-api-key"); // Remove any existing API key
	headers.set("Authorization", `Bearer ${resolvedAccessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, resolvedAccountId);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);

    const cacheKey = resolvedOpts?.promptCacheKey;
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
 * Log RFC 8594 Deprecation/Sunset headers if present. Shared by the success and
 * error response handlers so a sunset notice is surfaced regardless of status
 * (request-01).
 *
 * @internal Exported only for sibling lib/request modules; import via fetch-helpers.ts elsewhere.
 */
export function logDeprecationHeaders(response: Response): void {
        const deprecation = response.headers.get("Deprecation");
        const sunset = response.headers.get("Sunset");
        if (deprecation || sunset) {
                logWarn(`API deprecation notice`, { deprecation, sunset });
        }
}
