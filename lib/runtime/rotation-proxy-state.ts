import { AccountManager } from "../accounts.js";
import {
	recordRuntimeReload,
	recordRuntimeReset,
} from "./runtime-observability.js";
import type { RuntimeRotationProxyStatus } from "./rotation-server-types.js";
import type { SessionAffinityStore } from "../session-affinity.js";

/**
 * Per-instance configuration resolved once in `startRuntimeRotationProxy`,
 * captured as explicit fields instead of closure variables so the request
 * handler and the stale-reload recovery can be plain functions.
 *
 * @internal
 */
export interface RotationProxyStateInit {
	activeAccountManager: AccountManager;
	routingMutexMode: "enabled" | "legacy";
	schedulingStrategy: "hybrid" | "sequential";
	fetchImpl: typeof fetch;
	upstreamBaseUrl: string;
	clientApiKey: string;
	now: () => number;
	tokenRefreshSkewMs: number;
	networkErrorCooldownMs: number;
	serverErrorCooldownMs: number;
	tokenInvalidationCooldownMs: number;
	minRotationIntervalMs: number;
	pidOffsetEnabled: boolean;
	fetchTimeoutMs: number;
	streamStallTimeoutMs: number;
	maxRuntimeAccountAttempts: number;
	maxRequestBodyBytes: number;
	quotaRemainingPercentThreshold: number;
	sessionAffinityStore: SessionAffinityStore | null;
	lastObservedAffinityGeneration: number;
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
	readonly threadGoalFallbacks: Map<string, string | null>;
	lastGlobalAccountIndex: number | null;
	lastGlobalSwitchAt: number;
	staleRuntimeReloadPromise: Promise<AccountManager | null> | null;
	lastStaleRuntimeReloadAt: number;
}

const STALE_RUNTIME_RELOAD_DEDUPE_MS = 1_000;

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
		lastGlobalAccountIndex: null,
		lastGlobalSwitchAt: 0,
		staleRuntimeReloadPromise: null,
		lastStaleRuntimeReloadAt: 0,
	};
}

/** @internal */
export async function recoverStaleRuntimeState(
	state: RotationProxyState,
): Promise<AccountManager | null> {
	if (Date.now() - state.lastStaleRuntimeReloadAt <= STALE_RUNTIME_RELOAD_DEDUPE_MS) {
		return state.activeAccountManager;
	}
	if (state.staleRuntimeReloadPromise) {
		return state.staleRuntimeReloadPromise;
	}
	state.staleRuntimeReloadPromise = (async () => {
		AccountManager.resetVolatileRuntimeState();
		recordRuntimeReset("pool-exhausted-no-account");
		const reloaded = await AccountManager.loadFromDisk();
		reloaded.setRoutingMutexMode(state.routingMutexMode);
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
