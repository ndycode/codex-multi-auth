import { RealtimeCallRegistry } from "./realtime-calls.js";
import type { ResetExhaustionEvidence } from "./reset-credits.js";
import type { NativeAccountSnapshot } from "./native-account-storage.js";
import type { QuotaCacheData, QuotaCacheEntry } from "../quota-cache.js";
import type {RuntimeCapabilityFailures} from "./runtime-capability-failures.js";
import type {RouteModel} from "../model-route-policy.js";
import type {ModelInventory} from "./model-discovery-status.js";
import type { ApiModelCapabilities } from "./api-model-capabilities.js";
import type { ApiModelRuntime } from "./api-model-runtime.js";
import type { ApiRouteCredential } from "../api-route-store.js";
import type { AccountModelCatalog } from "./account-model-catalog.js";
import { AccountManager, sanitizeEmail } from "../accounts.js";
import type { ContextBudgetGuard } from "../context-budget-guard.js";
import type { PreemptiveQuotaScheduler } from "../preemptive-quota-scheduler.js";
import {
	recordRuntimeReload,
	recordRuntimeReset,
} from "./runtime-observability.js";
import type { RuntimeRotationProxyStatus } from "./rotation-server-types.js";
import type { SessionAffinityStore } from "../session-affinity.js";
import { redirectRuntimeRefreshCommits, waitForRuntimeRefreshCommits } from "./rotation-token-refresh.js";

/**
 * Per-instance configuration resolved once in `startRuntimeRotationProxy`,
 * captured as explicit fields instead of closure variables so the request
 * handler and the stale-reload recovery can be plain functions.
 *
 * @internal
 */
export interface RotationProxyStateInit {
	nativeOpenai?: boolean;
	readNativeAccountStorage?: () => Promise<NativeAccountSnapshot>;
	readApiRoutes?: () => Promise<ApiRouteCredential[]>;
	readSubscriptionQuota?: () => Promise<QuotaCacheData | null>;
	catalogAccount?: { email: string; accountId: string; };
	activeAccountManager: AccountManager;
	routingMutexMode: "enabled" | "legacy";
	schedulingStrategy: "hybrid" | "sequential";
	fetchImpl: typeof fetch;
	/**
	 * The embedder's configured fetcher, captured before `state.fetchImpl` is
	 * rebound to the WebSocket gateway. Capability/doc probes must use this —
	 * the gateway fetch exists for Responses transport upgrades, and bare
	 * `fetch` would bypass a custom fetcher's instrumentation entirely.
	 */
	upstreamFetchImpl: typeof fetch;
	upstreamBaseUrl: string;
	clientApiKey: string;
	now: () => number;
	tokenRefreshSkewMs: number;
	networkErrorCooldownMs: number;
	serverErrorCooldownMs: number;
	/**
	 * Wall-clock ceiling on how long ONE request may wait out a model-capacity
	 * response before giving up. `0` restores the pre-#689 behaviour of rotating
	 * the pool and returning the exhaustion 503.
	 */
	modelCapacityRetryMs: number;
	apiAdmissionWaitMs?: number;
	tokenInvalidationCooldownMs: number;
	minRotationIntervalMs: number;
	pidOffsetEnabled: boolean;
	fetchTimeoutMs: number;
	streamStallTimeoutMs: number;
	maxRuntimeAccountAttempts: number;
	maxRequestBodyBytes: number;
	quotaRemainingPercentThreshold: number;
	preemptiveQuotaScheduler: PreemptiveQuotaScheduler;
	contextBudgetGuard: ContextBudgetGuard;
	sessionAffinityStore: SessionAffinityStore | null;
	lastObservedAffinityGeneration: number;
	/**
	 * Ephemeral per-invocation account pin (0-based) or null. When a number,
	 * the request handler treats it exactly like a manual `switch` pin — a
	 * deterministic, fail-hard selection — but it is never written to disk, so
	 * concurrent invocations with different pins never interfere (issue #623).
	 */
	forcedAccountIndex: number | null;
}

/**
 * Mutable rotation-loop state shared by every request of one proxy instance.
 * `activeAccountManager` and `lastObservedAffinityGeneration` are reassigned
 * at runtime (stale-state recovery and affinity-generation tracking), so the
 * whole container is passed by reference and never copied.
 *
 * @internal
 */
export interface RotationProxyState extends RotationProxyStateInit {
	readonly knownAccountManagers: Set<AccountManager>;
	readonly status: RuntimeRotationProxyStatus;
	modelCatalog?: AccountModelCatalog;
	modelCatalogs?: Map<string, AccountModelCatalog>;
    catalogBackoff?: Map<string, number>;
    /** Short-lived per-request file reads (quota cache, reset credits), keyed by source. */
    readCache?: Map<string, { at: number; value: Promise<unknown> }>;
 capabilityFailures?: RuntimeCapabilityFailures;
	apiModelRuntime?: ApiModelRuntime;
 apiModelCapabilities?:ApiModelCapabilities;
	catalogEtag?: string;
 catalogOAuthModels?:RouteModel[];
 catalogApiRoutes?:ApiRouteCredential[];
 catalogInventory?:ModelInventory;
 subscriptionQuotaObservations?: Map<string, QuotaCacheEntry>;
 /** Explicit pre-inference quota rejections, scoped to immutable workspace/model identity. */
 subscriptionQuotaRejections?: Map<string, ResetExhaustionEvidence>;
	readonly threadGoalFallbacks: Map<string, string | null>;
	/** Which managed account created each realtime voice call (#750). */
	readonly realtimeCalls: RealtimeCallRegistry;
	lastGlobalAccountIndex: number | null;
	lastGlobalSwitchAt: number;
	staleRuntimeReloadPromise: Promise<AccountManager | null> | null;
	lastStaleRuntimeReloadAt: number;
	credentialReloadPromise: Promise<AccountManager | null> | null;
	lastCredentialReloadAt: number;
	transcriptionNextAccountIndex: number;
	readonly transcriptionRateLimitUntilByRecordId: Map<string, number>;
}

const STALE_RUNTIME_RELOAD_DEDUPE_MS = 1_000;

/**
 * Copy credentials that rotated on `previousManager` since `authBeforeLoad`
 * into the matching rows of `reloaded`. A replacement snapshot read before a
 * refresh commit persisted still holds the spent single-use refresh token;
 * without this carry the swap reintroduces it and the next refresh fails with
 * token reuse. Matching is deliberately conservative — persisted record id,
 * then the refresh token on either side of the rotation, then accountId+email —
 * so a credential never lands on a different account.
 */
function carryRotatedCredentials(
	previousManager: AccountManager,
	authBeforeLoad: ReturnType<AccountManager["getAccountsSnapshot"]>,
	reloaded: AccountManager,
): void {
	const candidates = reloaded.getAccountsSnapshot();
	for (const previous of previousManager.getAccountsSnapshot()) {
		const baseline = authBeforeLoad.find(
			(account) =>
				(account.recordId && account.recordId === previous.recordId) ||
				account.index === previous.index,
		);
		if (
			!baseline ||
			(baseline.access === previous.access &&
				baseline.refreshToken === previous.refreshToken &&
				baseline.expires === previous.expires)
		) {
			continue;
		}
		const rotatedTokens = new Set([previous.refreshToken, baseline.refreshToken]);
		const sourceEmail = sanitizeEmail(previous.email);
		const matches = candidates.filter(
			(candidate) =>
				(previousManager.hasPersistedRecordId(previous) &&
					candidate.recordId === previous.recordId) ||
				rotatedTokens.has(candidate.refreshToken) ||
				(previous.accountId !== undefined &&
					candidate.accountId === previous.accountId &&
					sanitizeEmail(candidate.email) === sourceEmail),
		);
		const [matched] = matches;
		if (matches.length !== 1 || !matched) continue;
		const live = reloaded.getAccountByIndex(matched.index);
		if (!live) continue;
		live.access = previous.access;
		live.refreshToken = previous.refreshToken;
		live.expires = previous.expires;
		// Token-bound identity (accountId/accountIdSource/email) rides along with
		// the rotated credential — `commitRefreshedAuth` can refresh it during the
		// same window, and without it the row keeps a workspace binding issued for
		// the spent token. Explicit manual/org bindings stay authoritative.
		const tokenBoundIdentityChanged =
			baseline.accountId !== previous.accountId ||
			baseline.accountIdSource !== previous.accountIdSource;
		const liveHasExplicitBinding =
			live.accountIdSource === "manual" || live.accountIdSource === "org";
		const previousHasTokenBinding =
			previous.accountIdSource === "token" || previous.accountIdSource === "id_token";
		if (tokenBoundIdentityChanged && previousHasTokenBinding && !liveHasExplicitBinding) {
			live.accountId = previous.accountId;
			live.accountIdSource = previous.accountIdSource;
		}
		if (baseline.email !== previous.email) {
			live.email = previous.email;
		}
	}
}

/** @internal */
export function createRotationProxyState(
	init: RotationProxyStateInit,
): RotationProxyState {
	return {
		...init,
		knownAccountManagers: new Set<AccountManager>([init.activeAccountManager]),
		status: {
			startedAt: init.now(),
			totalRequests: 0,
			upstreamRequests: 0,
			retries: 0,
			rotations: 0,
			streamsStarted: 0,
			lastError: null,
			lastAccountIndex: null,
			lastAccountLabel: null,
			lastAccountId: null,
			lastAccountUpdatedAt: null,
		},
		threadGoalFallbacks: new Map<string, string | null>(),
		realtimeCalls: new RealtimeCallRegistry(init.now),
		lastGlobalAccountIndex: null,
		lastGlobalSwitchAt: 0,
		staleRuntimeReloadPromise: null,
		lastStaleRuntimeReloadAt: 0,
		credentialReloadPromise: null,
		lastCredentialReloadAt: 0,
		transcriptionNextAccountIndex: 0,
		transcriptionRateLimitUntilByRecordId: new Map<string, number>(),
	};
}

/**
 * Reload account credentials without resetting inference runtime state.
 *
 * This is intentionally narrower than {@link recoverStaleRuntimeState}: it is
 * used when a non-inference operation discovers that its in-memory credential
 * inventory is stale after an external login/enable action. Fresh credential,
 * workspace, enabled and auth-invalidation fields come from disk, while live
 * inference rate-limit windows and non-auth cooldowns are carried forward by
 * stable account identity. An auth-failure cooldown is carried only while the
 * access token is unchanged, so a genuine re-login can repair the credential.
 * Process-global health/token trackers and circuit breakers are never reset.
 *
 * @internal
 */
export async function reloadRuntimeCredentials(
	state: RotationProxyState,
): Promise<AccountManager | null> {
	// Inference stale recovery is destructive by design and takes precedence over
	// the credential-only refresh. Sharing the in-flight result prevents two
	// asynchronous loaders from racing to replace activeAccountManager.
	if (state.staleRuntimeReloadPromise) return state.staleRuntimeReloadPromise;
	if (Date.now() - state.lastCredentialReloadAt <= STALE_RUNTIME_RELOAD_DEDUPE_MS) {
		return state.activeAccountManager;
	}
	if (state.credentialReloadPromise) return state.credentialReloadPromise;

	state.credentialReloadPromise = (async () => {
		const previousManager = state.activeAccountManager;
		/** Stable matching key for carrying only runtime observations between credential snapshots. */
		const identityOf = (account: { accountId?: string; email?: string; refreshToken?: string }) => {
			const accountId = account.accountId?.trim();
			const email = sanitizeEmail(account.email);
			return accountId || email
				? JSON.stringify([accountId ?? null, email ?? null])
				: account.refreshToken?.trim()
					? `refresh:${account.refreshToken.trim()}`
					: null;
		};
		// Capture auth before I/O so a token rotation that lands while loadFromDisk
		// is suspended can be distinguished from credentials intentionally changed
		// on disk by another login. Only the former is carried into the replacement.
		const authBeforeLoad = previousManager.getAccountsSnapshot();
		const reloaded = await AccountManager.loadFromDisk();
		if (state.activeAccountManager !== previousManager) {
			// Another path (native storage sync, stale recovery) already swapped
			// the manager while disk I/O was pending; never clobber its redirect.
			state.lastCredentialReloadAt = Date.now();
			return state.activeAccountManager;
		}
		reloaded.setRoutingMutexMode(state.routingMutexMode);
		const freshAccounts = reloaded.getAccountsSnapshot();
		// loadFromDisk intentionally converts an unreadable/corrupt source with no
		// usable WAL/backup into an empty manager. Do not let a transient read
		// failure erase a healthy resident pool; a parsed empty/reset snapshot is
		// still authoritative and may intentionally remove every account.
		if (
			authBeforeLoad.length > 0 &&
			freshAccounts.length === 0 &&
			!reloaded.hasLoadedAccountStorageSnapshot()
		) {
			state.lastCredentialReloadAt = Date.now();
			return previousManager;
		}
		// A refresh can finish upstream while disk I/O is pending and then queue
		// its auth commit against the resident manager. Let every commit already
		// targeting that manager settle before taking the final live snapshot.
		await waitForRuntimeRefreshCommits(previousManager);
		if (state.activeAccountManager !== previousManager) {
			state.lastCredentialReloadAt = Date.now();
			return state.activeAccountManager;
		}
		const previousAccounts = previousManager.getAccountsSnapshot();
		const credentialInventoryFingerprint = (
			accounts: ReturnType<AccountManager["getAccountsSnapshot"]>,
		): string => JSON.stringify(accounts.map((account) => ({
			recordId: account.recordId ?? null,
			accountId: account.accountId?.trim() ?? null,
			accountIdSource: account.accountIdSource ?? null,
			email: sanitizeEmail(account.email) ?? null,
			refreshToken: account.refreshToken,
			access: account.access ?? null,
			expires: account.expires ?? null,
			enabled: account.enabled !== false,
			authInvalidatedAt: account.authInvalidatedAt ?? null,
			authInvalidationErrorCode: account.authInvalidationErrorCode ?? null,
			workspaces: (account.workspaces ?? []).map((workspace) => ({
				id: workspace.id.trim(),
				name: workspace.name ?? null,
				enabled: workspace.enabled !== false,
				disabledAt: workspace.disabledAt ?? null,
				isDefault: workspace.isDefault ?? null,
			})),
			currentWorkspaceIndex: account.currentWorkspaceIndex ?? null,
		})));
		// A credential probe that finds the exact same inventory must not swap the
		// live manager. Returning the resident object preserves inference cursors,
		// lastUsed state, and in-flight runtime observations while still bounding
		// disk checks through lastCredentialReloadAt.
		if (credentialInventoryFingerprint(authBeforeLoad) === credentialInventoryFingerprint(freshAccounts)) {
			// Cooldown fields are deliberately excluded from the inventory fingerprint
			// so a disk probe cannot reset inference selector state. Still absorb a
			// newer persisted auth-failure cooldown from another proxy, but only when
			// the credential itself is unchanged; a re-login/rotation repairs that wait.
			for (const fresh of freshAccounts) {
				const resident = previousManager.getAccountByIndex(fresh.index);
				if (
					resident &&
					fresh.cooldownReason === "auth-failure" &&
					typeof fresh.coolingDownUntil === "number" &&
					fresh.coolingDownUntil > state.now() &&
					resident.access === fresh.access &&
					resident.refreshToken === fresh.refreshToken &&
					fresh.coolingDownUntil > (resident.coolingDownUntil ?? 0)
				) {
					resident.coolingDownUntil = fresh.coolingDownUntil;
					resident.cooldownReason = "auth-failure";
				}
			}
			state.lastCredentialReloadAt = Date.now();
			return previousManager;
		}

		const baselineFor = (previous: (typeof previousAccounts)[number]) =>
			authBeforeLoad.find((account) =>
				(account.recordId && account.recordId === previous.recordId) ||
				account.index === previous.index,
			);
		const workspaceIds = (account: {
			accountId?: string;
			workspaces?: Array<{ id: string }>;
		}): Set<string> => new Set([
			account.accountId?.trim(),
			...(account.workspaces ?? []).map((workspace) => workspace.id.trim()),
		].filter((value): value is string => Boolean(value)));
		const hasWorkspaceConflict = (
			previous: (typeof previousAccounts)[number],
			baseline: (typeof authBeforeLoad)[number] | undefined,
			candidate: (typeof freshAccounts)[number],
		): boolean => {
			const sourceIds = workspaceIds(previous);
			if (baseline) {
				for (const id of workspaceIds(baseline)) sourceIds.add(id);
			}
			const candidateIds = workspaceIds(candidate);
			return sourceIds.size > 0 && candidateIds.size > 0 &&
				![...sourceIds].some((id) => candidateIds.has(id));
		};
		const claimed = new Set<number>();
		const matchedFreshIndexByPrevious = new Map<number, number>();
		const reserve = (
			previous: (typeof previousAccounts)[number],
			candidate: (typeof freshAccounts)[number] | undefined,
		): boolean => {
			if (!candidate || claimed.has(candidate.index)) return false;
			claimed.add(candidate.index);
			matchedFreshIndexByPrevious.set(previous.index, candidate.index);
			return true;
		};

		// Reserve every strong match for every old row before considering fuzzy
		// fallbacks. This prevents an earlier deleted row from stealing the only
		// surviving same-email workspace before that survivor can claim itself.
		for (const previous of previousAccounts) {
			if (!previous.recordId) continue;
			const matches = freshAccounts.filter((account) =>
				!claimed.has(account.index) && account.recordId === previous.recordId,
			);
			if (matches.length === 1) reserve(previous, matches[0]);
		}
		for (const previous of previousAccounts) {
			if (matchedFreshIndexByPrevious.has(previous.index)) continue;
			const baseline = baselineFor(previous);
			const identities = new Set(
				[identityOf(previous), baseline ? identityOf(baseline) : null].filter(
					(identity): identity is string => identity !== null,
				),
			);
			const matches = freshAccounts.filter((account) => {
				if (claimed.has(account.index)) return false;
				const identity = identityOf(account);
				return identity !== null && identities.has(identity);
			});
			if (matches.length === 1) reserve(previous, matches[0]);
		}
		for (const previous of previousAccounts) {
			if (matchedFreshIndexByPrevious.has(previous.index)) continue;
			const baseline = baselineFor(previous);
			const refreshTokens = new Set(
				[previous.refreshToken, baseline?.refreshToken].filter(
					(value): value is string => Boolean(value),
				),
			);
			const matches = freshAccounts.filter((account) =>
				!claimed.has(account.index) && refreshTokens.has(account.refreshToken),
			);
			if (matches.length === 1) reserve(previous, matches[0]);
		}
		for (const previous of previousAccounts) {
			if (matchedFreshIndexByPrevious.has(previous.index)) continue;
			const baseline = baselineFor(previous);
			const stableEmail = sanitizeEmail(previous.email) ?? sanitizeEmail(baseline?.email);
			if (!stableEmail) continue;
			const matches = freshAccounts.filter((account) =>
				!claimed.has(account.index) &&
				sanitizeEmail(account.email) === stableEmail &&
				!hasWorkspaceConflict(previous, baseline, account),
			);
			if (matches.length === 1) reserve(previous, matches[0]);
		}

		for (const previous of previousAccounts) {
			const matchedIndex = matchedFreshIndexByPrevious.get(previous.index);
			if (matchedIndex === undefined) continue;
			const baseline = baselineFor(previous);
			const live = reloaded.getAccountByIndex(matchedIndex);
			if (!live) continue;
			const authRotatedDuringLoad = baseline !== undefined && (
				baseline.access !== previous.access ||
				baseline.refreshToken !== previous.refreshToken ||
				baseline.expires !== previous.expires
			);
			if (authRotatedDuringLoad) {
				live.access = previous.access;
				live.refreshToken = previous.refreshToken;
				live.expires = previous.expires;
				const tokenBoundIdentityChanged = baseline !== undefined && (
					baseline.accountId !== previous.accountId ||
					baseline.accountIdSource !== previous.accountIdSource
				);
				const liveHasExplicitBinding =
					live.accountIdSource === "manual" || live.accountIdSource === "org";
				const previousHasTokenBinding =
					previous.accountIdSource === "token" || previous.accountIdSource === "id_token";
				if (tokenBoundIdentityChanged && previousHasTokenBinding && !liveHasExplicitBinding) {
					live.accountId = previous.accountId;
					live.accountIdSource = previous.accountIdSource;
				}
				if (baseline !== undefined && baseline.email !== previous.email) {
					live.email = previous.email;
				}
			}
			for (const [key, until] of Object.entries(previous.rateLimitResetTimes)) {
				if (typeof until === "number" && until > state.now()) {
					live.rateLimitResetTimes[key] = Math.max(live.rateLimitResetTimes[key] ?? 0, until);
				}
			}
			if ((previous.coolingDownUntil ?? 0) > (live.coolingDownUntil ?? 0)) {
				const repairedAuth =
					previous.cooldownReason === "auth-failure" && previous.access !== live.access;
				if (!repairedAuth) {
					live.coolingDownUntil = previous.coolingDownUntil;
					live.cooldownReason = previous.cooldownReason;
				}
			}
			const sameCredential =
				live.access === previous.access && live.refreshToken === previous.refreshToken;
			// Auth-invalidation and workspace-disable markers are written in memory
			// first and only reach disk through the debounced save. Carry only a
			// marker that landed during the load window (absent from the baseline):
			// a pre-existing marker may have been legitimately cleared on disk by
			// another process, which is then authoritative. A re-login (rotated
			// credential) legitimately clears them either way.
			const baselineInvalidated =
				baseline !== undefined && previousManager.isAccountAuthInvalidated(baseline);
			if (
				sameCredential &&
				!baselineInvalidated &&
				previousManager.isAccountAuthInvalidated(previous) &&
				!reloaded.isAccountAuthInvalidated(live)
			) {
				live.authInvalidatedAt = previous.authInvalidatedAt;
				live.authInvalidationErrorCode = previous.authInvalidationErrorCode;
			}
			if (sameCredential) {
				for (const workspace of previous.workspaces ?? []) {
					const baselineWorkspace = baseline?.workspaces?.find(
						(item) => item.id === workspace.id,
					);
					// A disable that predates the load is already in the baseline —
					// disk may have re-enabled the workspace, and that wins.
					if (baselineWorkspace?.enabled === false) continue;
					const target = live.workspaces?.find((item) => item.id === workspace.id);
					if (
						target &&
						workspace.enabled === false &&
						workspace.disabledAt !== undefined &&
						target.enabled !== false
					) {
						target.enabled = false;
						target.disabledAt = workspace.disabledAt;
					}
				}
			}
		}
		// Requests that captured the resident manager before this swap may finish
		// refreshing afterward. Redirect those late auth commits to the replacement
		// so rotated single-use refresh tokens cannot be stranded on the old object.
		redirectRuntimeRefreshCommits(previousManager, reloaded);
		state.activeAccountManager = reloaded;
		state.knownAccountManagers.add(reloaded);
		state.lastCredentialReloadAt = Date.now();
		recordRuntimeReload("credential-inventory-refresh");
		return reloaded;
	})()
		.catch((error) => {
			state.status.lastError = error instanceof Error ? error.message : String(error);
			return null;
		})
		.finally(() => {
			state.credentialReloadPromise = null;
		});
	return state.credentialReloadPromise;
}

/** @internal */
export async function recoverStaleRuntimeState(
	state: RotationProxyState,
): Promise<AccountManager | null> {
	if (state.staleRuntimeReloadPromise) return state.staleRuntimeReloadPromise;
	// If a non-destructive credential refresh started first, let it publish its
	// inventory before performing the authoritative stale-state reset. Re-check
	// the stale promise afterward so concurrent recovery callers still dedupe.
	if (state.credentialReloadPromise) await state.credentialReloadPromise;
	if (state.staleRuntimeReloadPromise) return state.staleRuntimeReloadPromise;
	if (Date.now() - state.lastStaleRuntimeReloadAt <= STALE_RUNTIME_RELOAD_DEDUPE_MS) {
		return state.activeAccountManager;
	}
	state.staleRuntimeReloadPromise = (async () => {
		const previousManager = state.activeAccountManager;
		const authBeforeLoad = previousManager.getAccountsSnapshot();
		AccountManager.resetVolatileRuntimeState();
		recordRuntimeReset("pool-exhausted-no-account");
		const reloaded = await AccountManager.loadFromDisk();
		if (state.activeAccountManager !== previousManager) {
			// A concurrent swap (native storage sync, credential reload) already
			// published a newer manager; discarding this result keeps its redirect
			// chain intact instead of clobbering previous → live with stale.
			state.lastStaleRuntimeReloadAt = Date.now();
			return state.activeAccountManager;
		}
		reloaded.setRoutingMutexMode(state.routingMutexMode);
		// Drain refresh commits that queued against the resident manager while
		// disk I/O was pending, then carry the rotated credentials: the loaded
		// snapshot predates their persist and still holds the spent token.
		await waitForRuntimeRefreshCommits(previousManager);
		if (state.activeAccountManager !== previousManager) {
			state.lastStaleRuntimeReloadAt = Date.now();
			return state.activeAccountManager;
		}
		carryRotatedCredentials(previousManager, authBeforeLoad, reloaded);
		// Wipe per-account cooldowns and rate-limit windows on the freshly
		// reloaded pool. `resetVolatileRuntimeState` above only cleared global
		// singletons (trackers, circuit breakers); the per-account transient
		// state is serialized to disk, so loadFromDisk restores the same state
		// that wedged the pool. Clearing it here gives recovery a real clean
		// slate before any request can pick up the manager (issue #606). Runs
		// before the `state.activeAccountManager` assignment so no concurrent
		// request can observe the reloaded manager with stale state.
		//
		// This also drops still-future rate-limit windows from genuine upstream
		// 429s, not just stale ones from a dead prior process. That is the
		// intended trade-off: recovery only runs at full pool exhaustion, where
		// the alternative is a hard 503 anyway, and the 1s reload dedupe bounds
		// re-probing to ~1/sec — the upstream simply re-429s and re-populates the
		// window until the next exhaustion. Availability is preferred over
		// honoring backoff in this already-degraded state.
		reloaded.clearAccountTransientState();
		// Force the cleared snapshot to disk now rather than waiting out the
		// debounce window inside clearAccountTransientState. If the process
		// exited during that window the next startup would reload the wedged
		// snapshot; flushing here makes the "next reload starts clean" guarantee
		// durable across a restart, not just best-effort. Recovery is rare
		// (full-pool exhaustion), so the extra synchronous write is cheap.
		await reloaded.flushPendingSave();
		// The flush opened another window in which a late commit could queue on
		// the superseded manager. Drain it, then carry + redirect + swap in one
		// synchronous block so no commit can slip between the drain and the swap.
		await waitForRuntimeRefreshCommits(previousManager);
		if (state.activeAccountManager !== previousManager) {
			state.lastStaleRuntimeReloadAt = Date.now();
			return state.activeAccountManager;
		}
		carryRotatedCredentials(previousManager, authBeforeLoad, reloaded);
		// Keep refresh ownership chains current across destructive recovery too.
		// Requests that captured the previous manager before this swap must never
		// persist a late refresh/cooldown into an object that is no longer active.
		redirectRuntimeRefreshCommits(previousManager, reloaded);
		state.activeAccountManager = reloaded;
		state.knownAccountManagers.add(reloaded);
		state.lastStaleRuntimeReloadAt = Date.now();
		recordRuntimeReload("pool-exhausted-no-account");
		return reloaded;
	})()
		.catch((error) => {
			state.status.lastError = error instanceof Error ? error.message : String(error);
			return null;
		})
		.finally(() => {
			state.staleRuntimeReloadPromise = null;
		});
	return state.staleRuntimeReloadPromise;
}
