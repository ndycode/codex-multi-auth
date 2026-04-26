/**
 * Zod schemas for runtime validation.
 * These are the single source of truth for data structures.
 * Types are inferred from schemas using z.infer.
 */
import { z } from "zod";
import { createLogger, type ScopedLogger } from "./logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";

// Lazy-init so partial `vi.mock("../lib/logger.js", ...)` stubs in tests that
// do not export `createLogger` (e.g. `test/auth-logging.test.ts`) continue to
// load this module without crashing at import time.
let schemaLogInstance: ScopedLogger | null = null;
function schemaLog(): ScopedLogger | null {
	if (schemaLogInstance) return schemaLogInstance;
	if (typeof createLogger !== "function") return null;
	schemaLogInstance = createLogger("schemas");
	return schemaLogInstance;
}

// ============================================================================
// Plugin Configuration Schema
// ============================================================================

export const PluginConfigSchema = z.object({
	codexMode: z.boolean().optional(),
	codexRuntimeRotationProxy: z.boolean().optional(),
	codexTuiV2: z.boolean().optional(),
	codexTuiColorProfile: z.enum(["truecolor", "ansi16", "ansi256"]).optional(),
	codexTuiGlyphMode: z.enum(["ascii", "unicode", "auto"]).optional(),
	fastSession: z.boolean().optional(),
	fastSessionStrategy: z.enum(["hybrid", "always"]).optional(),
	fastSessionMaxInputItems: z.number().min(8).max(200).optional(),
	retryAllAccountsRateLimited: z.boolean().optional(),
	retryAllAccountsMaxWaitMs: z.number().min(0).optional(),
	retryAllAccountsMaxRetries: z.number().min(0).optional(),
	unsupportedCodexPolicy: z.enum(["strict", "fallback"]).optional(),
	fallbackOnUnsupportedCodexModel: z.boolean().optional(),
	fallbackToGpt52OnUnsupportedGpt53: z.boolean().optional(),
	unsupportedCodexFallbackChain: z
		.record(z.string(), z.array(z.string().min(1)))
		.optional(),
	tokenRefreshSkewMs: z.number().min(0).optional(),
	rateLimitToastDebounceMs: z.number().min(0).optional(),
	toastDurationMs: z.number().min(1000).optional(),
	perProjectAccounts: z.boolean().optional(),
	sessionRecovery: z.boolean().optional(),
	autoResume: z.boolean().optional(),
	parallelProbing: z.boolean().optional(),
	parallelProbingMaxConcurrency: z.number().min(1).max(5).optional(),
	emptyResponseMaxRetries: z.number().min(0).optional(),
	emptyResponseRetryDelayMs: z.number().min(0).optional(),
	rateLimitDedupWindowMs: z.number().min(0).optional(),
	rateLimitStateResetMs: z.number().min(1_000).optional(),
	rateLimitMaxBackoffMs: z.number().min(1_000).optional(),
	rateLimitShortRetryThresholdMs: z.number().min(0).optional(),
	pidOffsetEnabled: z.boolean().optional(),
	fetchTimeoutMs: z.number().min(1_000).optional(),
	streamStallTimeoutMs: z.number().min(1_000).optional(),
	liveAccountSync: z.boolean().optional(),
	liveAccountSyncDebounceMs: z.number().min(50).optional(),
	liveAccountSyncPollMs: z.number().min(500).optional(),
	sessionAffinity: z.boolean().optional(),
	sessionAffinityTtlMs: z.number().min(1_000).optional(),
	sessionAffinityMaxEntries: z.number().min(8).optional(),
	responseContinuation: z.boolean().optional(),
	backgroundResponses: z.boolean().optional(),
	proactiveRefreshGuardian: z.boolean().optional(),
	proactiveRefreshIntervalMs: z.number().min(5_000).optional(),
	proactiveRefreshBufferMs: z.number().min(30_000).optional(),
	networkErrorCooldownMs: z.number().min(0).optional(),
	serverErrorCooldownMs: z.number().min(0).optional(),
	storageBackupEnabled: z.boolean().optional(),
	preemptiveQuotaEnabled: z.boolean().optional(),
	preemptiveQuotaRemainingPercent5h: z.number().min(0).max(100).optional(),
	preemptiveQuotaRemainingPercent7d: z.number().min(0).max(100).optional(),
	preemptiveQuotaMaxDeferralMs: z.number().min(1_000).optional(),
	routingMutex: z.enum(["enabled", "legacy"]).optional(),
});

export type PluginConfigFromSchema = z.infer<typeof PluginConfigSchema>;

// ============================================================================
// Account Storage Schemas
// ============================================================================

/**
 * Source of the accountId used for ChatGPT requests.
 */
export const AccountIdSourceSchema = z.enum([
	"token",
	"id_token",
	"org",
	"manual",
]);

export type AccountIdSourceFromSchema = z.infer<typeof AccountIdSourceSchema>;

/**
 * Cooldown reason for temporary account suspension.
 */
export const CooldownReasonSchema = z.enum([
	"auth-failure",
	"network-error",
	"server-error",
	"rate-limit",
]);

export type CooldownReasonFromSchema = z.infer<typeof CooldownReasonSchema>;

/**
 * Last switch reason for account rotation tracking.
 */
export const SwitchReasonSchema = z.enum([
	"rate-limit",
	"initial",
	"rotation",
	"best",
	"restore",
]);

export type SwitchReasonFromSchema = z.infer<typeof SwitchReasonSchema>;

/**
 * Rate limit state - maps model family to reset timestamp.
 */
export const RateLimitStateV3Schema = z.record(
	z.string(),
	z.number().optional(),
);

export type RateLimitStateV3FromSchema = z.infer<typeof RateLimitStateV3Schema>;

/**
 * Account metadata V3 - current storage format.
 */
export const AccountMetadataV3Schema = z.object({
	accountId: z.string().optional(),
	accountIdSource: AccountIdSourceSchema.optional(),
	accountLabel: z.string().optional(),
	email: z.string().optional(),
	refreshToken: z.string().min(1), // Required, non-empty
	accessToken: z.string().optional(),
	expiresAt: z.number().optional(),
	enabled: z.boolean().optional(),
	addedAt: z.number(),
	lastUsed: z.number(),
	lastSwitchReason: SwitchReasonSchema.optional(),
	rateLimitResetTimes: RateLimitStateV3Schema.optional(),
	coolingDownUntil: z.number().optional(),
	cooldownReason: CooldownReasonSchema.optional(),
});

export type AccountMetadataV3FromSchema = z.infer<
	typeof AccountMetadataV3Schema
>;

/**
 * Build activeIndexByFamily schema dynamically from MODEL_FAMILIES.
 */
const modelFamilyEntries = MODEL_FAMILIES.map((family) => [
	family,
	z.number().optional(),
]);
export const ActiveIndexByFamilySchema = z
	.object(
		Object.fromEntries(modelFamilyEntries) as Record<
			ModelFamily,
			z.ZodOptional<z.ZodNumber>
		>,
	)
	.partial();

export type ActiveIndexByFamilyFromSchema = z.infer<
	typeof ActiveIndexByFamilySchema
>;

/**
 * Account storage V3 - current storage format with per-family active indices.
 */
export const AccountStorageV3Schema = z.object({
	version: z.literal(3),
	accounts: z.array(AccountMetadataV3Schema),
	activeIndex: z.number().min(0),
	activeIndexByFamily: ActiveIndexByFamilySchema.optional(),
});

export type AccountStorageV3FromSchema = z.infer<typeof AccountStorageV3Schema>;

/**
 * Legacy V1 account metadata for migration support.
 */
export const AccountMetadataV1Schema = z.object({
	accountId: z.string().optional(),
	accountIdSource: AccountIdSourceSchema.optional(),
	accountLabel: z.string().optional(),
	email: z.string().optional(),
	refreshToken: z.string().min(1),
	accessToken: z.string().optional(),
	expiresAt: z.number().optional(),
	enabled: z.boolean().optional(),
	addedAt: z.number(),
	lastUsed: z.number(),
	lastSwitchReason: SwitchReasonSchema.optional(),
	rateLimitResetTime: z.number().optional(), // V1 used single value
	coolingDownUntil: z.number().optional(),
	cooldownReason: CooldownReasonSchema.optional(),
});

export type AccountMetadataV1FromSchema = z.infer<
	typeof AccountMetadataV1Schema
>;

/**
 * Legacy V1 storage format for migration support.
 */
export const AccountStorageV1Schema = z.object({
	version: z.literal(1),
	accounts: z.array(AccountMetadataV1Schema),
	activeIndex: z.number().min(0),
});

export type AccountStorageV1FromSchema = z.infer<typeof AccountStorageV1Schema>;

/**
 * Union of V1 and V3 storage formats for migration detection.
 */
export const AnyAccountStorageSchema = z.discriminatedUnion("version", [
	AccountStorageV1Schema,
	AccountStorageV3Schema,
]);

export type AnyAccountStorageFromSchema = z.infer<
	typeof AnyAccountStorageSchema
>;

// ============================================================================
// Flagged Account Storage Schemas
// ============================================================================

/**
 * Flagged account metadata V1 - extends V3 account metadata with flagging info.
 * Mirrors the `FlaggedAccountMetadataV1` TS interface in `lib/storage.ts`.
 * Uses `passthrough` so V3-compatible extra fields (workspaces, etc.) survive.
 */
export const FlaggedAccountMetadataV1Schema = AccountMetadataV3Schema.extend({
	flaggedAt: z.number(),
	flaggedReason: z.string().optional(),
	lastError: z.string().optional(),
}).passthrough();

export type FlaggedAccountMetadataV1FromSchema = z.infer<
	typeof FlaggedAccountMetadataV1Schema
>;

/**
 * Flagged account storage V1 format (version: 1, accounts: []).
 */
export const FlaggedAccountStorageV1Schema = z.object({
	version: z.literal(1),
	accounts: z.array(FlaggedAccountMetadataV1Schema),
});

export type FlaggedAccountStorageV1FromSchema = z.infer<
	typeof FlaggedAccountStorageV1Schema
>;

// ============================================================================
// Accounts Journal (WAL) Entry Schema
// ============================================================================

/**
 * WAL journal entry used to persist in-flight account storage state.
 * `content` is a JSON string that parses into an `AnyAccountStorage` payload.
 * Mirrors the internal `AccountsJournalEntry` type in `lib/storage.ts`.
 */
export const AccountsJournalEntrySchema = z.object({
	version: z.literal(1),
	createdAt: z.number().optional(),
	path: z.string().optional(),
	content: z.string(),
	checksum: z.string(),
});

export type AccountsJournalEntryFromSchema = z.infer<
	typeof AccountsJournalEntrySchema
>;

// ============================================================================
// Token Result Schemas
// ============================================================================

/**
 * Token failure reason codes.
 */
export const TokenFailureReasonSchema = z.enum([
	"http_error",
	"invalid_response",
	"network_error",
	"missing_refresh",
	"timeout",
	"unknown",
]);

export type TokenFailureReasonFromSchema = z.infer<
	typeof TokenFailureReasonSchema
>;

/**
 * Successful token exchange result.
 */
export const TokenSuccessSchema = z.object({
	type: z.literal("success"),
	access: z.string().min(1),
	refresh: z.string().min(1),
	expires: z.number(),
	idToken: z.string().optional(),
	multiAccount: z.boolean().optional(),
});

export type TokenSuccessFromSchema = z.infer<typeof TokenSuccessSchema>;

/**
 * Failed token exchange result.
 */
export const TokenFailureSchema = z.object({
	type: z.literal("failed"),
	reason: TokenFailureReasonSchema.optional(),
	statusCode: z.number().optional(),
	message: z.string().optional(),
});

export type TokenFailureFromSchema = z.infer<typeof TokenFailureSchema>;

/**
 * Token result - discriminated union of success/failure.
 */
export const TokenResultSchema = z.discriminatedUnion("type", [
	TokenSuccessSchema,
	TokenFailureSchema,
]);

export type TokenResultFromSchema = z.infer<typeof TokenResultSchema>;

// ============================================================================
// OAuth Response Schemas (for validating API responses)
// ============================================================================

/**
 * OAuth token response from OpenAI.
 */
export const OAuthTokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().optional(),
	expires_in: z.number(),
	id_token: z.string().optional(),
	token_type: z.string().optional(),
	scope: z.string().optional(),
});

export type OAuthTokenResponseFromSchema = z.infer<
	typeof OAuthTokenResponseSchema
>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely parse plugin configuration with detailed error logging.
 * Returns null on failure, allowing graceful degradation.
 */
export function safeParsePluginConfig(
	data: unknown,
): PluginConfigFromSchema | null {
	const result = PluginConfigSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse account storage (any version).
 * Returns null on failure, allowing graceful degradation.
 */
export function safeParseAccountStorage(
	data: unknown,
): AnyAccountStorageFromSchema | null {
	const result = AnyAccountStorageSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse V3 account storage specifically.
 * Returns null on failure.
 */
export function safeParseAccountStorageV3(
	data: unknown,
): AccountStorageV3FromSchema | null {
	const result = AccountStorageV3Schema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse token result.
 * Returns null on failure.
 */
export function safeParseTokenResult(
	data: unknown,
): TokenResultFromSchema | null {
	const result = TokenResultSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse OAuth token response from API.
 * Returns null on failure.
 */
export function safeParseOAuthTokenResponse(
	data: unknown,
): OAuthTokenResponseFromSchema | null {
	const result = OAuthTokenResponseSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse flagged account storage V1.
 * Returns null on failure.
 */
export function safeParseFlaggedAccountStorageV1(
	data: unknown,
): FlaggedAccountStorageV1FromSchema | null {
	const result = FlaggedAccountStorageV1Schema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse accounts WAL journal entry.
 * Returns null on failure.
 */
export function safeParseAccountsJournalEntry(
	data: unknown,
): AccountsJournalEntryFromSchema | null {
	const result = AccountsJournalEntrySchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Fail-closed helper that wraps BOTH `JSON.parse` and Zod schema validation.
 *
 * Behavior:
 * - Returns `null` if `raw` is not a string.
 * - Returns `null` on `JSON.parse` `SyntaxError`, logging a debug-level message
 *   tagged with `context` so callers can identify the boundary.
 * - Returns `null` on schema validation failure, logging a debug-level message
 *   with the first validation issues.
 * - Returns the parsed + validated data on success.
 *
 * Use this at JSON.parse boundaries (disk reads, user imports, WAL replay) so
 * schema drift and corrupt files fail closed instead of crashing the caller.
 */
export function safeParseJson<T>(
	raw: unknown,
	schema: z.ZodType<T>,
	context = "safeParseJson",
): T | null {
	if (typeof raw !== "string") {
		schemaLog()?.debug("safeParseJson received non-string input", {
			context,
			type: typeof raw,
		});
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		schemaLog()?.debug("safeParseJson JSON.parse failed", {
			context,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
	const result = schema.safeParse(parsed);
	if (!result.success) {
		schemaLog()?.debug("safeParseJson schema validation failed", {
			context,
			issues: result.error.issues.slice(0, 3).map((issue) => {
				const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
				return `${path}${issue.message}`;
			}),
		});
		return null;
	}
	return result.data;
}

/**
 * Get validation errors as a flat array of strings.
 * Useful for logging and error messages.
 */
export function getValidationErrors(
	schema: z.ZodType,
	data: unknown,
): string[] {
	const result = schema.safeParse(data);
	if (result.success) {
		return [];
	}
	return result.error.issues.map((issue) => {
		const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
		return `${path}${issue.message}`;
	});
}
