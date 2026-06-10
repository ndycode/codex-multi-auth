import type { AccountManager, ManagedAccount } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";
import { queuedRefresh } from "../refresh-queue.js";
import {
	isTokenInvalidationError,
	isTokenRefreshRetryable,
} from "../request/rate-limit-decision.js";
import type { OAuthAuthDetails } from "../types.js";

/** @internal */
export const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 30_000;

// Monotonic auth-failure cooldown: only extend, never shorten. Two concurrent
// requests on the same account can race so that an invalidation path sets a
// long cooldown (5 min) and a subsequent generic 401 truncates it (30 s).
// Reading the live coolingDownUntil before writing prevents that race.
/** @internal */
export function applyMonotonicAuthCooldown(
	accountManager: AccountManager,
	account: ManagedAccount,
	cooldownMs: number,
): void {
	const existing = accountManager.getAccountByIndex(account.index)?.coolingDownUntil ?? 0;
	// Intentionally Date.now(), not the proxy's injected now(): coolingDownUntil is
	// written by markAccountCoolingDown via nowMs() (== Date.now()), so both sides of
	// this comparison must live in the same real-wall-clock domain. Switching to the
	// injected now() would mis-compare an injected-clock value against a real-clock
	// deadline and silently defeat the monotonic guard.
	if (Date.now() + cooldownMs > existing) {
		accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
	}
}

function hasUsableAccessToken(
	account: ManagedAccount,
	now: number,
	skewMs: number,
): boolean {
	return (
		typeof account.access === "string" &&
		account.access.trim().length > 0 &&
		typeof account.expires === "number" &&
		account.expires > now + Math.max(0, skewMs)
	);
}

const runtimeRefreshCommitQueues = new WeakMap<
	AccountManager,
	Map<string, Promise<ManagedAccount | null>>
>();

async function commitRefreshedAuthOnce(
	accountManager: AccountManager,
	account: ManagedAccount,
	auth: OAuthAuthDetails,
): Promise<ManagedAccount | null> {
	const key = [
		account.index,
		account.accountId ?? "",
		account.email ?? "",
		account.refreshToken,
	].join("\0");
	let queue = runtimeRefreshCommitQueues.get(accountManager);
	if (!queue) {
		queue = new Map();
		runtimeRefreshCommitQueues.set(accountManager, queue);
	}
	const existing = queue.get(key);
	if (existing) return existing;
	const pending = accountManager
		.commitRefreshedAuth(account, auth)
		.finally(() => queue?.delete(key));
	queue.set(key, pending);
	return pending;
}

/** @internal */
export async function ensureFreshAccessToken(params: {
	accountManager: AccountManager;
	account: ManagedAccount;
	family: ModelFamily;
	model: string | null;
	now: number;
	tokenRefreshSkewMs: number;
	tokenInvalidationCooldownMs: number;
}): Promise<
	| { ok: true; accessToken: string; account: ManagedAccount }
	| { ok: false; retryable: boolean; invalidated?: boolean }
> {
	const { accountManager, account, family, model, now, tokenRefreshSkewMs, tokenInvalidationCooldownMs } =
		params;
	if (hasUsableAccessToken(account, now, tokenRefreshSkewMs)) {
		return { ok: true, accessToken: account.access ?? "", account };
	}

	const refreshResult = await queuedRefresh(account.refreshToken);
	if (refreshResult.type === "failed") {
		accountManager.recordFailure(account, family, model);
		accountManager.incrementAuthFailures(account);
		// If the refresh endpoint itself returns an explicit invalidation message
		// (e.g. Microsoft/Outlook SSO revokes the refresh token server-side), apply
		// the long cooldown and signal to the caller to stop rotating rather than
		// presenting other accounts' tokens from the same IP.
		const invalidated = isTokenInvalidationError(refreshResult.message ?? "");
		applyMonotonicAuthCooldown(
			accountManager,
			account,
			invalidated ? tokenInvalidationCooldownMs : DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
		);
		accountManager.saveToDiskDebounced();
		return { ok: false, retryable: isTokenRefreshRetryable(refreshResult), invalidated };
	}

	const auth: OAuthAuthDetails = {
		type: "oauth",
		access: refreshResult.access,
		refresh: refreshResult.refresh,
		expires: refreshResult.expires,
	};
	try {
		const updatedAccount = (await commitRefreshedAuthOnce(
			accountManager,
			account,
			auth,
		)) ?? account;
		return {
			ok: true,
			accessToken: updatedAccount.access ?? refreshResult.access,
			account: updatedAccount,
		};
	} catch {
		accountManager.recordFailure(account, family, model);
		accountManager.markAccountCoolingDown(
			account,
			DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
			"auth-failure",
		);
		accountManager.saveToDiskDebounced();
		return { ok: false, retryable: true };
	}
}
