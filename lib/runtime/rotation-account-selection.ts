import type { AccountManager, ManagedAccount } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";
import type { RuntimePolicyDecision } from "../policy/runtime-policy.js";
import type { SessionAffinityStore } from "../session-affinity.js";

/**
 * `chooseAccount` is a SYNC selector that internally advances the rotation
 * cursor (the session-affinity-preferred branch and the round-robin fallback
 * both call `accountManager.markSwitched(...)`, and the hybrid selector advances
 * its own cursor). It does NOT acquire the routing mutex itself.
 *
 * Concurrency (L4): when `routingMutex === "enabled"`, the proxy hot path runs
 * this whole call AND the subsequent `markSwitchedLocked` commit inside a single
 * `withRoutingMutex` acquisition, so concurrent requests serialize selection +
 * cursor advance and cannot stampede the same account. `withRoutingMutex` is
 * reentrant (AsyncLocalStorage), so the nested `markSwitchedLocked` — and the
 * later one in `persistRuntimeActiveAccount` — run inline without re-acquiring
 * the non-reentrant FIFO queue (no deadlock). In legacy mode the inline
 * `markSwitched` calls below are used unchanged and no lock is taken, so default
 * behavior and perf are identical. See the hot-path caller in
 * `startRuntimeRotationProxy` and the regression in
 * `test/runtime-rotation-proxy.test.ts`.
 */
export function chooseAccount(params: {
	accountManager: AccountManager;
	sessionAffinityStore: SessionAffinityStore | null;
	sessionKey: string | null;
	family: ModelFamily;
	model: string | null;
	attemptedIndexes: ReadonlySet<number>;
	now: number;
	policy: RuntimePolicyDecision | null;
	pinnedIndex: number | null;
	skipReasons?: Map<number, string>;
	stickyBoostByAccount?: Record<number, number>;
	pidOffsetEnabled?: boolean;
	schedulingStrategy?: "hybrid" | "sequential";
}): ManagedAccount | null {
	const {
		accountManager,
		sessionAffinityStore,
		sessionKey,
		family,
		model,
		attemptedIndexes,
		now,
		policy,
		pinnedIndex,
		skipReasons,
		stickyBoostByAccount,
		pidOffsetEnabled,
		schedulingStrategy,
	} = params;

	// Manual pin (from `codex-multi-auth switch <n>`) overrides every other
	// selection signal. We do NOT call markSwitched here — the proxy must not
	// clobber the pin set by the CLI. See issue #474.
	if (typeof pinnedIndex === "number") {
		if (attemptedIndexes.has(pinnedIndex)) {
			skipReasons?.set(pinnedIndex, "already-attempted");
			return null;
		}
		if (pinnedIndex < 0 || pinnedIndex >= accountManager.getAccountCount()) {
			skipReasons?.set(pinnedIndex, "missing");
			return null;
		}
		if (policy?.blockedAccountIndexes.has(pinnedIndex)) {
			skipReasons?.set(pinnedIndex, "policy-blocked");
			return null;
		}
		const pinned = accountManager.getAccountByIndex(pinnedIndex);
		if (!pinned || pinned.enabled === false) {
			skipReasons?.set(pinnedIndex, "disabled");
			return null;
		}
		const reason = accountManager.getAccountRuntimeSkipReason(
			pinnedIndex,
			family,
			model,
		);
		if (reason) {
			skipReasons?.set(pinnedIndex, reason);
			return null;
		}
		return pinned;
	}

	// Sequential / drain-first mode (issue #509): the active account governs ALL
	// new requests, so we deliberately SKIP the per-session affinity tier — there
	// is no per-chat stickiness, every request follows the single active account.
	// The manual pin above still wins (handled first). When the active account is
	// exhausted the selector advances to the next available account and earlier
	// accounts reclaim the slot once their quota recovers.
	if (schedulingStrategy === "sequential") {
		const selected = accountManager.getCurrentOrNextForFamilySequential(
			family,
			model,
			policy?.blockedAccountIndexes,
		);
		if (
			selected &&
			!attemptedIndexes.has(selected.index) &&
			!policy?.blockedAccountIndexes.has(selected.index)
		) {
			const reason = accountManager.getAccountRuntimeSkipReason(
				selected.index,
				family,
				model,
			);
			if (!reason) return selected;
			skipReasons?.set(selected.index, reason);
		}

		// Active account was attempted/blocked/skipped this request (e.g. it just
		// rate-limited mid-loop): fall through to the shared linear scan to find
		// the next eligible account to TRY. Pass advanceActivePointer=false so a
		// transient, non-exhausting failure on the active account does not
		// permanently move the drain-first primary — only
		// getCurrentOrNextForFamilySequential advances it, and only on true
		// exhaustion.
		return chooseLinearScanFallback({
			accountManager,
			family,
			model,
			attemptedIndexes,
			policy,
			skipReasons,
			advanceActivePointer: false,
		});
	}

	const preferredIndex = sessionAffinityStore?.getPreferredAccountIndex(sessionKey, now);
	if (
		typeof preferredIndex === "number" &&
		!attemptedIndexes.has(preferredIndex) &&
		!policy?.blockedAccountIndexes.has(preferredIndex)
	) {
		const preferred = accountManager.getAccountByIndex(preferredIndex);
		if (
			preferred) {
			const reason = accountManager.getAccountRuntimeSkipReason(
				preferred.index,
				family,
				model,
			);
			if (reason) {
				skipReasons?.set(preferred.index, reason);
			} else {
			// L4 (deferred): unlocked cursor mutation — see chooseAccount header.
			accountManager.markSwitched(preferred, "rotation", family);
			return preferred;
			}
		}
	}

	const selected = accountManager.getCurrentOrNextForFamilyHybrid(family, model, {
		scoreBoostByAccount: {
			...(policy?.scoreBoostByAccount ?? {}),
			...(stickyBoostByAccount ?? {}),
		},
		// accounts-05: carry the PID-offset distribution into the default-on proxy
		// path too (index.ts already does). Without it, parallel proxy processes can
		// stampede the same account instead of spreading across the pool.
		pidOffsetEnabled,
	});
	if (
		selected &&
		!attemptedIndexes.has(selected.index) &&
		!policy?.blockedAccountIndexes.has(selected.index)
	) {
		const reason = accountManager.getAccountRuntimeSkipReason(
			selected.index,
			family,
			model,
		);
		if (!reason) return selected;
		skipReasons?.set(selected.index, reason);
	}

	return chooseLinearScanFallback({
		accountManager,
		family,
		model,
		attemptedIndexes,
		policy,
		skipReasons,
	});
}

/**
 * Shared linear-scan fallback used by both the hybrid and sequential selection
 * paths in `chooseAccount`. Walks every account in pool order and returns the
 * first one that is not already attempted, not policy-blocked, and has no
 * runtime skip reason (rate-limited / cooling down / circuit-open), recording a
 * skip reason for each rejected candidate. Returns null when no eligible
 * account remains.
 *
 * `advanceActivePointer` (default `true`) controls whether the winner is
 * committed as the new active/cursor position via `markSwitched`. The hybrid
 * path wants this (round-robin advance). The sequential path passes `false`:
 * its within-request fallback only needs an account to TRY this request, and
 * must NOT move `currentAccountIndexByFamily` — otherwise a transient,
 * non-exhausting failure on the active account (which leaves it `isUsable` but
 * present in `attemptedIndexes`) would permanently switch the drain-first
 * primary even though it was never exhausted (issue #509 regression caught in
 * review). In sequential mode only `getCurrentOrNextForFamilySequential` is
 * allowed to advance the active pointer, and only on true exhaustion.
 */
function chooseLinearScanFallback(params: {
	accountManager: AccountManager;
	family: ModelFamily;
	model: string | null;
	attemptedIndexes: ReadonlySet<number>;
	policy: RuntimePolicyDecision | null;
	skipReasons?: Map<number, string>;
	advanceActivePointer?: boolean;
}): ManagedAccount | null {
	const {
		accountManager,
		family,
		model,
		attemptedIndexes,
		policy,
		skipReasons,
		advanceActivePointer = true,
	} = params;

	for (const account of accountManager.getAccountsSnapshot()) {
		if (attemptedIndexes.has(account.index)) {
			skipReasons?.set(account.index, "already-attempted");
			continue;
		}
		if (policy?.blockedAccountIndexes.has(account.index)) {
			skipReasons?.set(account.index, "policy-blocked");
			continue;
		}
		const reason = accountManager.getAccountRuntimeSkipReason(
			account.index,
			family,
			model,
		);
		if (!reason) {
			const live = accountManager.getAccountByIndex(account.index);
			if (!live) continue;
			// L4 (deferred): unlocked cursor mutation — see chooseAccount header.
			// Skipped in sequential mode (advanceActivePointer=false) so a
			// within-request retry never reassigns the drain-first primary.
			if (advanceActivePointer) {
				accountManager.markSwitched(live, "rotation", family);
			}
			return live;
		}
		skipReasons?.set(account.index, reason);
	}

	return null;
}
