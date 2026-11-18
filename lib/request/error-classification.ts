/**
 * Error classification helpers for the custom fetch implementation
 * Extracted from fetch-helpers.ts (audit roadmap §4.1.2); fetch-helpers.ts
 * re-exports the public symbols so existing importers are unchanged.
 */

import { isRecord } from "../utils.js";
import { HTTP_STATUS, stripModelEffortSuffix } from "../constants.js";
import { RETIRED_MODEL_REPLACEMENTS } from "./helpers/model-map.js";

export interface EntitlementError {
        isEntitlement: true;
        code: string;
        message: string;
}

/** @internal Exported only for sibling lib/request modules; import via fetch-helpers.ts elsewhere. */
export const CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE = "model_not_supported_with_chatgpt_account";
const CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN =
	/model is not supported when using codex with a chatgpt account/i;
const NORMALIZED_UNSUPPORTED_MODEL_PATTERN =
	/the model ['"]([^'"]+)['"] is not currently available for this chatgpt account/i;
const MODEL_ACCESS_DENIED_PATTERN =
	/the model [`'"]([^`'"]+)[`'"] does not exist or you do not have access to it/i;

export const DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN: Record<string, string[]> = {
	// GPT-6 models roll out org by org, so an account that is not entitled yet
	// gets a real unsupported-model response for them. This chain only fires
	// when the user has opted into `fallbackOnUnsupportedCodexModel` (default
	// `false`), and only on that response, so it never silently swaps the
	// model out from under a request the account could have served.
	//
	// This table is walked ONE HOP AT A TIME, not as a per-request candidate
	// list. index.ts reassigns `model` to whatever came back and passes that
	// as `requestedModel` on the next unsupported response, so reaching the
	// terminal models from a launch model requires every intermediate model
	// to carry its own entry below. A second element here is only ever
	// consulted when the first is already in `attemptedModels` for that same
	// call.
	//
	// Depth is not free: every hop spends one of the shared per-request
	// outbound attempts (`tryConsumeOutboundRequestAttempt`). A single-account
	// balanced session gets a budget of 5, and the deepest walks — 6.1 Sol and
	// the retired ids that migrate through Astra — spend all 5, the same shape
	// the aeon walk had before `gpt-5.4` was retired as the floor. Hops are
	// ordered most-valuable-first so what is lost first matters least. Do not
	// add a hop to a GPT-6 row without re-checking that budget;
	// `test/gpt6-astra-models.test.ts` asserts it.
	"gpt-6.1-sol": ["gpt-6-sol"],
	// 6.1 Terra steps to the tier it replaces, `gpt-5.6-terra`, whose own row
	// continues to Sol and then Luna: four hops, inside the budget above.
	"gpt-6.1-terra": ["gpt-5.6-terra"],
	// Astra steps to the workhorse rather than to a smaller tier: an account
	// without the flagship is still likelier than not to hold the standard
	// GPT-6 tier, and `gpt-6-sol` keeps the walk inside the generation.
	"gpt-6-astra": ["gpt-6-sol"],
	// Sol and Luna step to the 5.6 tier they replace, never sideways into a
	// pricier model: an account without the new tier is far likelier to lack
	// Astra too, and Astra is the priciest hop available ($10/$50 per 1M
	// against Luna's $0.10/$0.50). Every hop on these walks still costs more
	// than Luna itself.
	"gpt-6-sol": ["gpt-5.6-sol"],
	"gpt-6-luna": ["gpt-5.6-luna"],
	// The hop that makes every general walk reach a model almost every account
	// has: `gpt-6-luna` ships on the most plans of any catalog model, which is
	// why the quota-probe chain also ends on it.
	"gpt-5.6-sol": ["gpt-6-luna"],
	// Luna's own row crosses to Sol rather than stopping: a `gpt-5.6-luna`
	// request whose tier is absent retries on the same-generation workhorse
	// instead of ending on an unsupported response.
	"gpt-5.6-luna": ["gpt-5.6-sol"],
	"gpt-5.6-terra": ["gpt-5.6-sol"],
	"gpt-5": ["gpt-5.6-sol"],
	"gpt-5-pro": ["gpt-6-astra"],
	// A retired id still reaches the backend verbatim through the pass-through
	// rotation proxy, and the backend rejects it as unsupported. One hop to the
	// replacement OpenAI names for it turns that into a working request, and
	// from there the same staircase above continues toward Luna.
	...Object.fromEntries(
		Object.entries(RETIRED_MODEL_REPLACEMENTS).map(([retired, replacement]) => [
			retired,
			[replacement],
		]),
	),
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
	return stripModelEffortSuffix(stripped);
}

function normalizeFallbackChain(
	customChain: Record<string, string[]> | undefined,
): Record<string, string[]> {
	// Null-prototype, because both the keys written here and the keys read out of
	// it are caller-controlled. On a plain object, a `customChain` entry named
	// `__proto__` reassigns this object's prototype instead of adding a row, and
	// a lookup for `constructor` returns `Object.prototype.constructor`, a
	// truthy non-array whose `.length` is 1, so the emptiness check passes and
	// the `for...of` below throws `targets is not iterable` inside the request
	// path.
	const normalized: Record<string, string[]> = Object.create(null);
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
	const accessDeniedMatch = bodyText.match(MODEL_ACCESS_DENIED_PATTERN);
	if (accessDeniedMatch?.[1]) {
		return canonicalizeModelName(accessDeniedMatch[1]);
	}
	return undefined;
}

/** @internal Exported only for sibling lib/request modules; import via fetch-helpers.ts elsewhere. */
export function isUnsupportedCodexModelForChatGpt(status: number, bodyText: string): boolean {
	if (status !== HTTP_STATUS.BAD_REQUEST) return false;
	if (!bodyText) return false;
	return (
		CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(bodyText) ||
		NORMALIZED_UNSUPPORTED_MODEL_PATTERN.test(bodyText) ||
		MODEL_ACCESS_DENIED_PATTERN.test(bodyText)
	);
}

export function getUnsupportedCodexModelInfo(
	errorBody: unknown,
): UnsupportedCodexModelInfo {
	if (!isRecord(errorBody)) {
		return { isUnsupported: false };
	}

	const maybeError = errorBody.error;
	if (!isRecord(maybeError)) {
		// Some upstreams (e.g. the Codex quota endpoint) return the flat
		// `{ "detail": "...model is not supported..." }` shape instead of the
		// nested `{ "error": { "message": "..." } }` envelope. Fall back to the
		// top-level `detail` string so model-fallback detection still works.
		const detail = typeof errorBody.detail === "string" ? errorBody.detail : undefined;
		if (!detail) {
			return { isUnsupported: false };
		}
		const isUnsupportedDetail =
			CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(detail) ||
			NORMALIZED_UNSUPPORTED_MODEL_PATTERN.test(detail) ||
			MODEL_ACCESS_DENIED_PATTERN.test(detail);
		if (!isUnsupportedDetail) {
			return { isUnsupported: false };
		}
		return {
			isUnsupported: true,
			message: detail,
			unsupportedModel: extractUnsupportedCodexModelFromText(detail) ?? undefined,
		};
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
		(message
			? CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(message) ||
				NORMALIZED_UNSUPPORTED_MODEL_PATTERN.test(message) ||
				MODEL_ACCESS_DENIED_PATTERN.test(message)
			: false);

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
	// Belt and braces with the null-prototype chain above: a `customChain` the
	// caller passed straight through could still carry a non-array value.
	if (!Array.isArray(targets) || targets.length === 0) return undefined;

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
			// Probe whether the legacy gpt-5.2 edge is still active under current
			// policy/toggles when the current Codex model is blocked.
			attemptedModels: [],
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: true,
		}) === "gpt-5.2-codex"
	);
}

/**
 * Detects whether an error code or response body indicates an entitlement/subscription issue for Codex models.
 *
 * Entitlement errors signal that the requested feature is not included in the user's plan and should not be treated as rate limits.
 * This function is pure and safe to call concurrently; it performs no filesystem access (including on Windows) and does not read or redact tokens — callers must avoid passing sensitive credentials in `code` or `bodyText`.
 *
 * @param code - The error code string returned by the service
 * @param bodyText - The response body text to inspect for entitlement-related phrases
 * @returns `true` if the combined `code` or `bodyText` indicates an entitlement/subscription issue, `false` otherwise
 */
/**
 * Statuses that are never a capacity signal, whatever the body says.
 *
 * Auth, payment, entitlement and not-found responses are terminal for this
 * request and are each handled by their own branch upstream of the capacity
 * check. Retrying them would spin until the deadline for no reason.
 */
const NON_CAPACITY_STATUSES = new Set([401, 402, 403, 404]);

/**
 * Phrases and codes that mean the model itself is out of capacity right now.
 *
 * This is matched on the body TEXT rather than on a status code, because the
 * status this arrives with is not documented and has been reported differently
 * by different callers. Matching text the way `isEntitlementError` and
 * `isWorkspaceDisabledError` already do means a wrong guess about the status
 * leaves behavior exactly as it is today, rather than breaking a path.
 *
 * `at capacity` is deliberately broad. In an OpenAI error body that phrase does
 * not occur outside capacity pressure, and a false positive costs a bounded
 * wait and one re-send, not a wrong answer.
 */
const MODEL_AT_CAPACITY_PATTERN =
	/\bat capacity\b|\bmodel_capacity_exceeded\b|\bcapacity_exceeded\b|\bcurrently overloaded\b|\boverloaded_error\b|\bslow_down\b/i;

/**
 * Detects an upstream response saying the selected model is temporarily out of
 * capacity, as opposed to the account being rate limited or the server being
 * broken.
 *
 * The distinction matters because the two want opposite handling. A rate limit
 * is per account, so rotating to another account clears it. Capacity is a
 * property of the MODEL, so every account in the pool fails identically and
 * rotating just burns the pool's transient budget in a few seconds, ending the
 * request as a 503. The caller waits and re-sends on the same account instead.
 * See issue #689.
 *
 * @param status - Upstream HTTP status.
 * @param bodyText - Upstream error body, already read.
 * @returns `true` when the request should be waited out rather than rotated.
 */
export function isModelAtCapacityError(
	status: number,
	bodyText: string,
): boolean {
	if (NON_CAPACITY_STATUSES.has(status)) return false;
	if (!bodyText) return false;
	return MODEL_AT_CAPACITY_PATTERN.test(bodyText);
}

export function isEntitlementError(code: string, bodyText: string): boolean {
        const haystack = `${code} ${bodyText}`.toLowerCase();
        // "usage_not_included" means the subscription doesn't include this feature
        // This is different from "usage_limit_reached" which is a temporary quota limit
        return /usage_not_included|not.included.in.your.plan|subscription.does.not.include/i.test(haystack);
}

/**
 * Detects whether an error indicates the workspace/account has been disabled or expired.
 *
 * Workspace disabled errors signal that the current workspace is no longer accessible
 * (expired, disabled, or removed) and the plugin should automatically switch to another account.
 *
 * @param status - HTTP status code
 * @param code - The error code string returned by the service
 * @param bodyText - The response body text to inspect for workspace-related phrases
 * @returns `true` if the error indicates a disabled/expired workspace
 */
export function isWorkspaceDisabledError(
        status: number,
        code: unknown,
        bodyText: string,
): boolean {
        const normalizedCode = typeof code === "string" ? code.trim().toLowerCase() : "";

        if (status === 402) {
                const normalizedTokens = normalizedCode
                        .split(/[^a-z0-9_]+/i)
                        .map((token) => token.trim())
                        .filter((token) => token.length > 0);
                return (
                        normalizedTokens.includes("deactivated_workspace") ||
                        /\bdeactivated_workspace\b/i.test(bodyText)
                );
        }

        if (status !== 403) {
                return false;
        }

        const haystack = `${normalizedCode} ${bodyText}`.toLowerCase();
        const normalizedTokens = normalizedCode
                .split(/[^a-z0-9_]+/i)
                .map((token) => token.trim())
                .filter((token) => token.length > 0);

		const disabledPatterns = [
				/workspace.*(?:disabled|expired|deactivated|terminated)/i,
				/account\s+(?:has\s+been|is)\s+(?:disabled|expired|deactivated|terminated|closed)/i,
				/(?:workspace|org(?:anization)?).*no longer.*(?:active|available|valid)/i,
				/(?:workspace|org(?:anization)?).*has been.*(?:disabled|expired|closed)/i,
				/workspace.*(?:access|subscription).*expired/i,
				/org(?:anization)?.*(?:disabled|expired|inactive)/i,
		];

        for (const pattern of disabledPatterns) {
                if (pattern.test(haystack)) {
                        return true;
                }
        }

        const workspaceErrorCodes = new Set([
                "workspace_disabled",
                "workspace_expired",
                "workspace_terminated",
                "account_disabled",
                "account_expired",
                "organization_disabled",
        ]);
        if (workspaceErrorCodes.has(normalizedCode)) {
                return true;
        }

        return normalizedTokens.some((token) => workspaceErrorCodes.has(token));
}

/**
 * Constructs a standardized 403 entitlement error Response indicating the user lacks access to Codex models.
 *
 * This function returns a JSON Response with an `error` payload containing a user-facing message, a
 * `type` of `"entitlement_error"`, and a `code` of `"usage_not_included"`. The message suggests checking
 * account/workspace access and re-authenticating with `codex-multi-auth login`.
 *
 * Concurrency: stateless and safe to call concurrently from multiple threads or requests.
 * Windows filesystem behavior: none (function does not access the filesystem).
 * Token redaction: any tokens are not included in the generated payload; do not pass sensitive tokens in `_bodyText`.
 *
 * @param _bodyText - Original response body text (accepted for compatibility; ignored when building the response)
 * @returns A 403 Response with a JSON body describing the entitlement error and guidance for resolving it
 */
export function createEntitlementErrorResponse(_bodyText: string): Response {
        const message = 
                "This model is not included in your ChatGPT subscription. " +
                "Please check that your account or workspace has access to Codex models (Plus/Pro/Business/Enterprise). " +
                "If you recently subscribed or switched workspaces, try logging out and back in with `codex-multi-auth login`.";
        
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
