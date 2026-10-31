import { sanitizeEmail, type AccountManager, type ManagedAccount } from "../accounts.js";
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

type RuntimeRefreshTarget = {
	accountManager: AccountManager;
	account: ManagedAccount;
};

type RuntimeRefreshCommitResult = {
	accountManager: AccountManager;
	account: ManagedAccount | null;
	/**
	 * Set when the commit did not run because a queued sync disabled the row
	 * while the refresh was in flight. The caller must not dispatch with it.
	 */
	skipped?: "disabled";
};

let runtimeRefreshCommitQueues = new WeakMap<
	AccountManager,
	Map<string, Promise<RuntimeRefreshCommitResult>>
>();
let runtimeRefreshManagerRedirects = new WeakMap<AccountManager, AccountManager>();

let runtimeCredentialLocks = new WeakMap<AccountManager, Promise<void>>();

/** Serialize credential snapshots with commits, including their disk writes. */
export async function withRuntimeCredentialLock<T>(
	accountManager: AccountManager,
	operation: () => Promise<T>,
): Promise<T> {
	const target = resolveRuntimeRefreshCommitManager(accountManager);
	const previous = runtimeCredentialLocks.get(target);
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	runtimeCredentialLocks.set(target, pending);
	await previous;
	try {
		if (resolveRuntimeRefreshCommitManager(target) !== target) {
			return await withRuntimeCredentialLock(target, operation);
		}
		return await operation();
	} finally {
		release();
		if (runtimeCredentialLocks.get(target) === pending) runtimeCredentialLocks.delete(target);
	}
}

function resolveRuntimeRefreshCommitManager(accountManager: AccountManager): AccountManager {
	let current = accountManager;
	const seen = new Set<AccountManager>();
	while (!seen.has(current)) {
		seen.add(current);
		const next = runtimeRefreshManagerRedirects.get(current);
		if (!next) return current;
		current = next;
	}
	return current;
}

function uniqueMatch(
	accounts: ManagedAccount[],
	predicate: (candidate: ManagedAccount) => boolean,
): ManagedAccount | null {
	const matches = accounts.filter(predicate);
	return matches.length === 1 ? matches[0] ?? null : null;
}

function workspaceIds(account: Pick<ManagedAccount, "accountId" | "workspaces">): Set<string> {
	return new Set(
		[
			account.accountId?.trim(),
			...(account.workspaces ?? []).map((workspace) => workspace.id.trim()),
		].filter((value): value is string => Boolean(value)),
	);
}

function hasWorkspaceConflict(source: ManagedAccount, candidate: ManagedAccount): boolean {
	const sourceIds = workspaceIds(source);
	const candidateIds = workspaceIds(candidate);
	return (
		sourceIds.size > 0 &&
		candidateIds.size > 0 &&
		![...sourceIds].some((id) => candidateIds.has(id))
	);
}

/** @internal Resolve an account onto the latest runtime manager replacement. */
export function resolveRuntimeRefreshTarget(
	accountManager: AccountManager,
	account: ManagedAccount,
): RuntimeRefreshTarget | null {
	const targetManager = resolveRuntimeRefreshCommitManager(accountManager);
	if (targetManager === accountManager) return { accountManager, account };

	const accounts = targetManager.getAccountsSnapshot();
	// A persisted record id is the strongest row identity we have. If that row
	// vanished in the replacement manager, never fall through to a same-email
	// sibling workspace: the in-flight refresh belongs to the removed row.
	// Derived in-memory ids hash the refresh token, so they are only strict
	// when the row actually persisted one — otherwise rotation retires the id.
	if (account.recordId && accountManager.hasPersistedRecordId(account)) {
		const exact = uniqueMatch(accounts, (candidate) => candidate.recordId === account.recordId);
		if (!exact) return null;
		const live = targetManager.getAccountByIndex(exact.index);
		return live ? { accountManager: targetManager, account: live } : null;
	}

	const compatibleAccounts = accounts.filter((candidate) => !hasWorkspaceConflict(account, candidate));
	const sourceEmail = sanitizeEmail(account.email);
	const snapshot =
		uniqueMatch(compatibleAccounts, (candidate) => candidate.refreshToken === account.refreshToken) ??
		(account.accountId && sourceEmail
			? uniqueMatch(
				compatibleAccounts,
				(candidate) =>
					candidate.accountId === account.accountId && sanitizeEmail(candidate.email) === sourceEmail,
			)
			: null) ??
		// accountId alone cannot merge logins: two members of one workspace share
		// it. When both rows carry known-but-different emails they are different
		// logins, and the in-flight refresh belongs to the removed one — let the
		// caller restart selection instead of adopting the sibling's credentials.
		(account.accountId
			? uniqueMatch(
				compatibleAccounts,
				(candidate) =>
					candidate.accountId === account.accountId &&
					(!sourceEmail ||
						!sanitizeEmail(candidate.email) ||
						sanitizeEmail(candidate.email) === sourceEmail),
			)
			: null) ??
		(sourceEmail
			? uniqueMatch(compatibleAccounts, (candidate) => sanitizeEmail(candidate.email) === sourceEmail)
			: null);
	if (!snapshot) return null;
	const live = targetManager.getAccountByIndex(snapshot.index);
	return live ? { accountManager: targetManager, account: live } : null;
}

/** @internal Test-only reset for process-global refresh commit/redirect state. */
export function resetRuntimeRefreshStateForTests(): void {
	runtimeCredentialLocks = new WeakMap<AccountManager, Promise<void>>();
	runtimeRefreshCommitQueues = new WeakMap<
		AccountManager,
		Map<string, Promise<RuntimeRefreshCommitResult>>
	>();
	runtimeRefreshManagerRedirects = new WeakMap<AccountManager, AccountManager>();
}

/** @internal Wait until every refresh-auth commit already targeting this manager settles. */
export async function waitForRuntimeRefreshCommits(accountManager: AccountManager): Promise<void> {
	const target = resolveRuntimeRefreshCommitManager(accountManager);
	while (true) {
		const queue = runtimeRefreshCommitQueues.get(target);
		const pending = queue ? [...queue.values()] : [];
		if (pending.length === 0) return;
		await Promise.allSettled(pending);
	}
}

/** @internal Redirect late refresh state from requests that captured a superseded manager. */
export function redirectRuntimeRefreshCommits(
	previousManager: AccountManager,
	replacementManager: AccountManager,
): void {
	if (previousManager === replacementManager) return;
	runtimeRefreshManagerRedirects.set(
		previousManager,
		resolveRuntimeRefreshCommitManager(replacementManager),
	);
}

async function commitRefreshedAuthOnce(
	accountManager: AccountManager,
	account: ManagedAccount,
	auth: OAuthAuthDetails,
): Promise<RuntimeRefreshCommitResult> {
	const commitManager = resolveRuntimeRefreshCommitManager(accountManager);
	const key = [
		account.recordId ?? "",
		account.accountId ?? "",
		account.email ?? "",
		account.refreshToken,
	].join("\0");
	let queue = runtimeRefreshCommitQueues.get(commitManager);
	if (!queue) {
		queue = new Map();
		runtimeRefreshCommitQueues.set(commitManager, queue);
	}
	const existing = queue.get(key);
	if (existing) return existing;
	const expectedRefresh = account.refreshToken;
	const pending = withRuntimeCredentialLock(commitManager, async () => {
		const target = resolveRuntimeRefreshTarget(commitManager, account);
		if (!target) return { accountManager: resolveRuntimeRefreshCommitManager(commitManager), account: null };
		// A queued disk sync may have disabled the row, or installed a newer login,
		// before this commit. A disabled row is never dispatchable; a newer login
		// is, with its own credential.
		if (target.account.enabled === false) return { ...target, skipped: "disabled" as const };
		if (target.account.refreshToken !== expectedRefresh) return target;
		const updatedAccount = await target.accountManager.commitRefreshedAuth(target.account, auth);
		return { accountManager: target.accountManager, account: updatedAccount };
	}).finally(() => queue?.delete(key));
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
	| { ok: true; accessToken: string; account: ManagedAccount; accountManager: AccountManager }
	| {
		ok: false;
		retryable: boolean;
		invalidated?: boolean;
		coordinationFailed?: boolean;
		selectionRestart?: false;
		account: ManagedAccount;
		accountManager: AccountManager;
	}
	| {
		ok: false;
		retryable: true;
		selectionRestart: true;
		accountManager: AccountManager;
	}
> {
	const {
		accountManager,
		account,
		family,
		model,
		now,
		tokenRefreshSkewMs,
		tokenInvalidationCooldownMs,
	} = params;
	const redirectedInitialManager = resolveRuntimeRefreshCommitManager(accountManager);
	const resolvedInitialTarget = resolveRuntimeRefreshTarget(accountManager, account);
	if (redirectedInitialManager !== accountManager && !resolvedInitialTarget) {
		// The request captured a manager that has since been replaced, and the
		// selected row no longer exists there. Even a still-fresh old token must not
		// bypass that removal; restart selection on the replacement pool.
		return {
			ok: false,
			retryable: true,
			selectionRestart: true,
			accountManager: redirectedInitialManager,
		};
	}
	const initialTarget = resolvedInitialTarget ?? {
		accountManager,
		account,
	};
	if (initialTarget.account.enabled === false) {
		return {
			ok: false,
			retryable: true,
			selectionRestart: true,
			accountManager: initialTarget.accountManager,
		};
	}
	if (hasUsableAccessToken(initialTarget.account, now, tokenRefreshSkewMs)) {
		return {
			ok: true,
			accessToken: initialTarget.account.access ?? "",
			account: initialTarget.account,
			accountManager: initialTarget.accountManager,
		};
	}

	const refreshCredential = {
		access: initialTarget.account.access,
		refreshToken: initialTarget.account.refreshToken,
		expires: initialTarget.account.expires,
	};
	const refreshResult = await queuedRefresh(refreshCredential.refreshToken);
	const redirectedManager = resolveRuntimeRefreshCommitManager(initialTarget.accountManager);
	const resolvedLatestTarget = resolveRuntimeRefreshTarget(
		initialTarget.accountManager,
		initialTarget.account,
	);
	if (redirectedManager !== initialTarget.accountManager && !resolvedLatestTarget) {
		// The row that initiated this refresh disappeared while OAuth was in flight.
		// Ignore the stale result rather than guessing another same-email workspace,
		// but hand the caller the replacement manager so it can restart selection and
		// discover a different healthy login from the current pool.
		return {
			ok: false,
			retryable: true,
			selectionRestart: true,
			accountManager: redirectedManager,
		};
	}
	const latestTarget = resolvedLatestTarget ?? initialTarget;
	if (latestTarget.account.enabled === false) {
		// An operator/runtime inventory change disabled this row while OAuth was in
		// flight. Never let a successful refresh re-enable it in commitRefreshedAuth.
		return {
			ok: false,
			retryable: true,
			selectionRestart: true,
			accountManager: latestTarget.accountManager,
		};
	}
	const credentialChangedWhileRefreshing =
		latestTarget.account.access !== refreshCredential.access ||
		latestTarget.account.refreshToken !== refreshCredential.refreshToken ||
		latestTarget.account.expires !== refreshCredential.expires;
	if (credentialChangedWhileRefreshing) {
		// A concurrent refresh or external re-login repaired/replaced this credential.
		// The result for the old OAuth tuple must never invalidate or overwrite it.
		if (hasUsableAccessToken(latestTarget.account, now, tokenRefreshSkewMs)) {
			return {
				ok: true,
				accessToken: latestTarget.account.access ?? "",
				account: latestTarget.account,
				accountManager: latestTarget.accountManager,
			};
		}
		return {
			ok: false,
			retryable: true,
			account: latestTarget.account,
			accountManager: latestTarget.accountManager,
		};
	}
	if (refreshResult.type === "failed") {
		if (refreshResult.reason === "coordination_error") {
			// A local lock failure says nothing about the validity of the login.
			return { ok: false, retryable: true, coordinationFailed: true, account: latestTarget.account, accountManager: latestTarget.accountManager };
		}
		latestTarget.accountManager.recordFailure(latestTarget.account, family, model);
		latestTarget.accountManager.incrementAuthFailures(latestTarget.account);
		// If the refresh endpoint itself returns an explicit invalidation message
		// (e.g. Microsoft/Outlook SSO revokes the refresh token server-side), apply
		// the long cooldown and signal to the caller to stop rotating rather than
		// presenting other accounts' tokens from the same IP.
		const invalidated = isTokenInvalidationError(refreshResult.message ?? "");
		if (invalidated) {
			latestTarget.accountManager.markAuthInvalidated(latestTarget.account);
		}
		applyMonotonicAuthCooldown(
			latestTarget.accountManager,
			latestTarget.account,
			invalidated ? tokenInvalidationCooldownMs : DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
		);
		latestTarget.accountManager.saveToDiskDebounced();
		return {
			ok: false,
			retryable: isTokenRefreshRetryable(refreshResult),
			invalidated,
			account: latestTarget.account,
			accountManager: latestTarget.accountManager,
		};
	}

	const auth: OAuthAuthDetails = {
		type: "oauth",
		access: refreshResult.access,
		refresh: refreshResult.refresh,
		expires: refreshResult.expires,
	};
	try {
		const committed = await commitRefreshedAuthOnce(
			latestTarget.accountManager,
			latestTarget.account,
			auth,
		);
		if (committed.skipped === "disabled") {
			// Same outcome as the disabled check above: restart selection rather
			// than hand back a disabled row and its possibly expired token.
			return {
				ok: false,
				retryable: true,
				selectionRestart: true,
				accountManager: committed.accountManager,
			};
		}
		// If commit succeeded, use the stored access token from the committed
		// account ? this also handles the dedup case where two concurrent callers
		// share one commit and both end up with the same committed token.
		// If commit returned null (account missing from storage after persist),
		// fall back to the account that initiated the commit but always use
		// refreshResult.access; that account may still carry an expired token.
		const resolvedAccount = committed.account ?? latestTarget.account;
		const resolvedManager = committed.account ? committed.accountManager : latestTarget.accountManager;
		const accessToken =
			committed.account !== null
				? (committed.account.access ?? refreshResult.access)
				: refreshResult.access;
		return {
			ok: true,
			accessToken,
			account: resolvedAccount,
			accountManager: resolvedManager,
		};
	} catch {
		const failureTarget =
			resolveRuntimeRefreshTarget(latestTarget.accountManager, latestTarget.account) ?? latestTarget;
		failureTarget.accountManager.recordFailure(failureTarget.account, family, model);
		failureTarget.accountManager.markAccountCoolingDown(
			failureTarget.account,
			DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
			"auth-failure",
		);
		failureTarget.accountManager.saveToDiskDebounced();
		return {
			ok: false,
			retryable: true,
			account: failureTarget.account,
			accountManager: failureTarget.accountManager,
		};
	}
}
