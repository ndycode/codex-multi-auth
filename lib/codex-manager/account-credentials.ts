import {
	resolveRequestAccountId,
	shouldUpdateAccountIdFromToken,
} from "../accounts.js";
import type { AccountMetadataV3 } from "../storage.js";
import type { AccountIdSource } from "../types.js";

/**
 * Token freshness and account-identity helpers shared by the manager CLI
 * commands (audit roadmap §4.1.1 phase 3). Previously module-private in
 * lib/codex-manager.ts and closure-captured by the repair/forecast/report/best
 * dependency factories, the health check, and the switch persistence path.
 * Moved verbatim so extracted command modules import or inject one shared
 * implementation.
 */

const ACCESS_TOKEN_FRESH_WINDOW_MS = 5 * 60 * 1000;

export function hasUsableAccessToken(
	account: Pick<AccountMetadataV3, "accessToken" | "expiresAt">,
	now: number,
): boolean {
	if (!account.accessToken) return false;
	if (
		typeof account.expiresAt !== "number" ||
		!Number.isFinite(account.expiresAt)
	)
		return false;
	return account.expiresAt - now > ACCESS_TOKEN_FRESH_WINDOW_MS;
}

export function hasLikelyInvalidRefreshToken(
	refreshToken: string | undefined,
): boolean {
	if (!refreshToken) return true;
	const trimmed = refreshToken.trim();
	if (trimmed.length < 20) return true;
	return trimmed.startsWith("token-");
}

export function resolveStoredAccountIdentity(
	storedAccountId: string | undefined,
	storedAccountIdSource: AccountIdSource | undefined,
	tokenAccountId: string | undefined,
): { accountId?: string; accountIdSource?: AccountIdSource } {
	const accountId = resolveRequestAccountId(
		storedAccountId,
		storedAccountIdSource,
		tokenAccountId,
	);
	if (!accountId) {
		return {};
	}

	if (!shouldUpdateAccountIdFromToken(storedAccountIdSource, storedAccountId)) {
		return {
			accountId,
			accountIdSource: storedAccountIdSource,
		};
	}

	return {
		accountId,
		accountIdSource:
			accountId === tokenAccountId ? "token" : storedAccountIdSource,
	};
}

export function applyTokenAccountIdentity(
	account: { accountId?: string; accountIdSource?: AccountIdSource },
	tokenAccountId: string | undefined,
): boolean {
	const nextIdentity = resolveStoredAccountIdentity(
		account.accountId,
		account.accountIdSource,
		tokenAccountId,
	);
	if (!nextIdentity.accountId) {
		return false;
	}
	if (
		nextIdentity.accountId === account.accountId &&
		nextIdentity.accountIdSource === account.accountIdSource
	) {
		return false;
	}

	account.accountId = nextIdentity.accountId;
	account.accountIdSource = nextIdentity.accountIdSource;
	return true;
}
