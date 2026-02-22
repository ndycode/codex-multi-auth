/**
 * Proactive Token Refresh Module
 *
 * Refreshes OAuth tokens before they expire to prevent auth failures mid-request.
 * Default buffer: 5 minutes before expiry (configurable via tokenRefreshSkewMs).
 *
 * This is a production hardening feature that:
 * - Reduces mid-request auth failures
 * - Improves user experience with seamless token rotation
 * - Works alongside the existing reactive refresh in fetch-helpers
 */

import { queuedRefresh } from "./refresh-queue.js";
import { createLogger } from "./logger.js";
import type { ManagedAccount } from "./accounts.js";
import type { TokenResult } from "./types.js";

const log = createLogger("proactive-refresh");

/** Default buffer before expiry to trigger proactive refresh (5 minutes) */
export const DEFAULT_PROACTIVE_BUFFER_MS = 5 * 60 * 1000;

/** Minimum buffer to prevent unnecessary refreshes (30 seconds) */
export const MIN_PROACTIVE_BUFFER_MS = 30 * 1000;

/**
 * Result of a proactive refresh operation.
 */
export interface ProactiveRefreshResult {
	refreshed: boolean;
	tokenResult?: TokenResult;
	reason: "not_needed" | "no_refresh_token" | "success" | "failed";
}

/**
 * Determines if an account's token should be proactively refreshed.
 *
 * @param account - The managed account to check
 * @param bufferMs - Time buffer before expiry to trigger refresh (default: 5 minutes)
 * @returns True if token is approaching expiry and should be refreshed
 */
export function shouldRefreshProactively(
	account: ManagedAccount,
	bufferMs: number = DEFAULT_PROACTIVE_BUFFER_MS,
): boolean {
	// No expiry set - can't determine if refresh is needed
	if (account.expires === undefined) {
		return false;
	}

	// No access token - definitely needs refresh
	if (!account.access) {
		return true;
	}

	// Clamp buffer to minimum
	const safeBufferMs = Math.max(MIN_PROACTIVE_BUFFER_MS, bufferMs);

	// Check if token expires within buffer window
	const now = Date.now();
	const expiresAt = account.expires;
	const refreshThreshold = expiresAt - safeBufferMs;

	return now >= refreshThreshold;
}

/**
 * Calculates milliseconds until an account's token expires.
 *
 * @param account - The managed account to check
 * @returns Milliseconds until expiry, or Infinity if no expiry set
 */
export function getTimeUntilExpiry(account: ManagedAccount): number {
	if (account.expires === undefined) {
		return Infinity;
	}
	return Math.max(0, account.expires - Date.now());
}

/**
 * Proactively refreshes an account's token if it's approaching expiry.
 *
 * @param account - The managed account to refresh
 * @param bufferMs - Time buffer before expiry to trigger refresh
 * @returns Result indicating whether refresh was performed and outcome
 */
export async function proactiveRefreshAccount(
	account: ManagedAccount,
	bufferMs: number = DEFAULT_PROACTIVE_BUFFER_MS,
): Promise<ProactiveRefreshResult> {
	if (!shouldRefreshProactively(account, bufferMs)) {
		return { refreshed: false, reason: "not_needed" };
	}

	if (!account.refreshToken) {
		log.warn("Cannot proactively refresh account without refresh token", {
			accountIndex: account.index,
		});
		return { refreshed: false, reason: "no_refresh_token" };
	}

	const timeUntilExpiry = getTimeUntilExpiry(account);
	log.info("Proactively refreshing token", {
		accountIndex: account.index,
		email: account.email,
		expiresInMs: timeUntilExpiry,
		expiresInMinutes: Math.round(timeUntilExpiry / 60000),
	});

	const result = await queuedRefresh(account.refreshToken);

	if (result.type === "success") {
		log.info("Proactive refresh succeeded", {
			accountIndex: account.index,
			email: account.email,
		});
		return { refreshed: true, tokenResult: result, reason: "success" };
	}

	log.warn("Proactive refresh failed", {
		accountIndex: account.index,
		email: account.email,
		failureReason: result.reason,
	});
	return { refreshed: true, tokenResult: result, reason: "failed" };
}

/**
 * Refreshes all accounts that are approaching token expiry.
 *
 * @param accounts - Array of managed accounts to check
 * @param bufferMs - Time buffer before expiry to trigger refresh
 * @returns Map of account index to refresh result
 */
export async function refreshExpiringAccounts(
	accounts: ManagedAccount[],
	bufferMs: number = DEFAULT_PROACTIVE_BUFFER_MS,
): Promise<Map<number, ProactiveRefreshResult>> {
	const results = new Map<number, ProactiveRefreshResult>();
	const accountsToRefresh = accounts.filter((a) =>
		shouldRefreshProactively(a, bufferMs),
	);

	if (accountsToRefresh.length === 0) {
		log.debug("No accounts need proactive refresh");
		return results;
	}

	log.info(`Proactively refreshing ${accountsToRefresh.length} account(s)`);

	// Refresh in parallel for efficiency
	const refreshPromises = accountsToRefresh.map(async (account) => {
		const result = await proactiveRefreshAccount(account, bufferMs);
		return { index: account.index, result };
	});

	const outcomes = await Promise.all(refreshPromises);

	for (const { index, result } of outcomes) {
		results.set(index, result);
	}

	// Log summary
	const succeeded = Array.from(results.values()).filter(
		(r) => r.reason === "success",
	).length;
	const failed = Array.from(results.values()).filter(
		(r) => r.reason === "failed",
	).length;

	if (succeeded > 0 || failed > 0) {
		log.info("Proactive refresh complete", {
			total: accountsToRefresh.length,
			succeeded,
			failed,
		});
	}

	return results;
}

/**
 * Updates a ManagedAccount with fresh token data from a successful refresh.
 *
 * @param account - The account to update
 * @param result - Successful token refresh result
 */
export function applyRefreshResult(
	account: ManagedAccount,
	result: Extract<TokenResult, { type: "success" }>,
): void {
	account.access = result.access;
	account.expires = result.expires;
	if (result.refresh !== account.refreshToken) {
		account.refreshToken = result.refresh;
	}
}
