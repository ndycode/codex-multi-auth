import type {
	AccountMetadataV3,
	CodexCliMirror,
	FlaggedAccountMetadataV1,
	FlaggedAccountStorageV1,
} from "./public-types.js";

function normalizeCodexCliMirror(value: unknown): CodexCliMirror | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { forAccountId, accountId } = value as Record<string, unknown>;
	return typeof forAccountId === "string" &&
		forAccountId.trim() &&
		typeof accountId === "string" &&
		accountId.trim()
		? { forAccountId, accountId }
		: undefined;
}

export function normalizeFlaggedStorage(
	data: unknown,
	deps: {
		isRecord: (value: unknown) => value is Record<string, unknown>;
		now: () => number;
	},
): FlaggedAccountStorageV1 {
	if (
		!deps.isRecord(data) ||
		data.version !== 1 ||
		!Array.isArray(data.accounts)
	) {
		return { version: 1, accounts: [] };
	}

	const byRefreshToken = new Map<string, FlaggedAccountMetadataV1>();
	for (const rawAccount of data.accounts) {
		if (!deps.isRecord(rawAccount)) continue;
		const refreshToken =
			typeof rawAccount.refreshToken === "string"
				? rawAccount.refreshToken.trim()
				: "";
		if (!refreshToken) continue;

		const flaggedAt =
			typeof rawAccount.flaggedAt === "number"
				? rawAccount.flaggedAt
				: deps.now();
		const isAccountIdSource = (
			value: unknown,
		): value is AccountMetadataV3["accountIdSource"] =>
			value === "token" ||
			value === "id_token" ||
			value === "org" ||
			value === "manual";
		const isSwitchReason = (
			value: unknown,
		): value is AccountMetadataV3["lastSwitchReason"] =>
			value === "rate-limit" ||
			value === "initial" ||
			value === "rotation" ||
			value === "best" ||
			value === "restore" ||
			value === "manual";
		const isCooldownReason = (
			value: unknown,
		): value is AccountMetadataV3["cooldownReason"] =>
			value === "auth-failure" ||
			value === "network-error" ||
			value === "server-error" ||
			value === "rate-limit";

		let rateLimitResetTimes:
			| AccountMetadataV3["rateLimitResetTimes"]
			| undefined;
		if (deps.isRecord(rawAccount.rateLimitResetTimes)) {
			const normalizedRateLimits: Record<string, number | undefined> = {};
			for (const [key, value] of Object.entries(
				rawAccount.rateLimitResetTimes,
			)) {
				if (typeof value === "number") {
					normalizedRateLimits[key] = value;
				}
			}
			if (Object.keys(normalizedRateLimits).length > 0) {
				rateLimitResetTimes = normalizedRateLimits;
			}
		}

		const accountIdSource = isAccountIdSource(rawAccount.accountIdSource)
			? rawAccount.accountIdSource
			: undefined;
		const lastSwitchReason = isSwitchReason(rawAccount.lastSwitchReason)
			? rawAccount.lastSwitchReason
			: undefined;
		const cooldownReason = isCooldownReason(rawAccount.cooldownReason)
			? rawAccount.cooldownReason
			: undefined;
		const authInvalidatedAt =
			typeof rawAccount.authInvalidatedAt === "number" &&
			Number.isFinite(rawAccount.authInvalidatedAt) &&
			rawAccount.authInvalidatedAt > 0
				? rawAccount.authInvalidatedAt
				: undefined;
		const authInvalidationErrorCode =
			authInvalidatedAt !== undefined &&
			typeof rawAccount.authInvalidationErrorCode === "string" &&
			rawAccount.authInvalidationErrorCode.trim().length > 0
				? rawAccount.authInvalidationErrorCode.trim()
				: undefined;

		const normalized: FlaggedAccountMetadataV1 = {
			recordId:
				typeof rawAccount.recordId === "string" && rawAccount.recordId.trim()
					? rawAccount.recordId.trim()
					: undefined,
			refreshToken,
			addedAt:
				typeof rawAccount.addedAt === "number" ? rawAccount.addedAt : flaggedAt,
			lastUsed:
				typeof rawAccount.lastUsed === "number"
					? rawAccount.lastUsed
					: flaggedAt,
			accountId:
				typeof rawAccount.accountId === "string"
					? rawAccount.accountId
					: undefined,
			accountIdSource,
			accountLabel:
				typeof rawAccount.accountLabel === "string"
					? rawAccount.accountLabel
					: undefined,
			email:
				typeof rawAccount.email === "string" ? rawAccount.email : undefined,
			accessToken:
				typeof rawAccount.accessToken === "string"
					? rawAccount.accessToken
					: undefined,
			expiresAt:
				typeof rawAccount.expiresAt === "number"
					? rawAccount.expiresAt
					: undefined,
			enabled:
				typeof rawAccount.enabled === "boolean"
					? rawAccount.enabled
					: undefined,
			lastSwitchReason,
			rateLimitResetTimes,
			coolingDownUntil:
				typeof rawAccount.coolingDownUntil === "number"
					? rawAccount.coolingDownUntil
					: undefined,
			cooldownReason,
			authInvalidatedAt,
			authInvalidationErrorCode,
			workspaces: Array.isArray(rawAccount.workspaces)
				? (rawAccount.workspaces as FlaggedAccountMetadataV1["workspaces"])
				: undefined,
			currentWorkspaceIndex:
				typeof rawAccount.currentWorkspaceIndex === "number"
					? rawAccount.currentWorkspaceIndex
					: undefined,
			codexCliMirror: normalizeCodexCliMirror(rawAccount.codexCliMirror),
			flaggedAt,
			flaggedReason:
				typeof rawAccount.flaggedReason === "string"
					? rawAccount.flaggedReason
					: undefined,
			lastError:
				typeof rawAccount.lastError === "string"
					? rawAccount.lastError
					: undefined,
		};
		byRefreshToken.set(refreshToken, normalized);
	}

	return {
		version: 1,
		accounts: Array.from(byRefreshToken.values()),
	};
}
