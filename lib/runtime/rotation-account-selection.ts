import { compareSubscriptionQuota, usesSubscriptionReserve, type SubscriptionQuotaPreference } from "./subscription-quota-order.js";
import { AUTH_INVALIDATION_MARKER, type AccountManager, type ManagedAccount } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";
import type { RuntimePolicyDecision } from "../policy/runtime-policy.js";
import type { SessionAffinityStore } from "../session-affinity.js";

/**
 * Whether a runtime skip reason is a cooldown, the one blocker a pinned
 * retry may waive. `getManagedAccountRuntimeSkipReason` emits either the
 * bare token or `cooling-down:<reason>`.
 */
function isCooldownReason(reason: string): boolean {
	return reason === "cooling-down" || reason.startsWith("cooling-down:");
}

/**
 * Select a managed credential for transcription without consulting or mutating
 * Codex inference health, quota, cooldown, circuit-breaker, affinity, or cursor
 * state. Transcription shares account authentication and workspace policy with
 * inference, but it is a separately admitted operation and must not inherit
 * model-runtime backpressure.
 */
export function chooseTranscriptionAccount(params: {
	accountManager: AccountManager;
	attemptedIndexes: ReadonlySet<number>;
	policy: RuntimePolicyDecision | null;
	pinnedIndex: number | null;
	now: number;
	transcriptionRateLimitUntilByRecordId?: ReadonlyMap<string, number>;
	startIndex?: number | null;
	preferredIndex?: number | null;
	fallbackPinnedIndex?: number | null;
	skipReasons?: Map<number, string>;
}): ManagedAccount | null {
	const {
		accountManager,
		attemptedIndexes,
		policy,
		pinnedIndex,
		now,
		transcriptionRateLimitUntilByRecordId,
		startIndex,
		preferredIndex,
		fallbackPinnedIndex,
		skipReasons,
	} = params;

	/** Return only credential-level blockers; inference runtime health is intentionally ignored. */
	const credentialReason = (index: number): string | null => {
		const account = accountManager.getAccountByIndex(index);
		if (!account) return "missing";
		if (account.enabled === false) return "disabled";
		if (!accountManager.hasEnabledWorkspaces(account)) return "workspace-disabled";
		if (accountManager.isAccountAuthInvalidated(account)) return AUTH_INVALIDATION_MARKER;
		if (
			account.cooldownReason === "auth-failure" &&
			typeof account.coolingDownUntil === "number" &&
			account.coolingDownUntil > now
		) return "cooling-down:auth-failure";
		const transcriptionRateLimitUntil = account.recordId
			? transcriptionRateLimitUntilByRecordId?.get(account.recordId)
			: undefined;
		if (typeof transcriptionRateLimitUntil === "number" && transcriptionRateLimitUntil > now) {
			return "transcription-rate-limited";
		}
		if (policy?.blockedAccountIndexes.has(index)) return "policy-blocked";
		if (attemptedIndexes.has(index)) return "already-attempted";
		return null;
	};

	/** Resolve one candidate while preserving a diagnostic skip reason for rejected credentials. */
	const eligible = (index: number): ManagedAccount | null => {
		const reason = credentialReason(index);
		if (reason) {
			skipReasons?.set(index, reason);
			return null;
		}
		return accountManager.getAccountByIndex(index);
	};

	if (typeof pinnedIndex === "number") return eligible(pinnedIndex);

	if (typeof fallbackPinnedIndex === "number") {
		const fallback = eligible(fallbackPinnedIndex);
		if (fallback) return fallback;
	}

	let candidates = accountManager.getAccountsSnapshot().filter((account) =>
		credentialReason(account.index) === null,
	);
	if (!candidates.length) {
		for (const account of accountManager.getAccountsSnapshot()) {
			const reason = credentialReason(account.index);
			if (reason) skipReasons?.set(account.index, reason);
		}
		return null;
	}

	if (policy?.priorityByAccount) {
		const tier = Math.min(...candidates.map((account) =>
			policy.priorityByAccount?.[account.index] ?? 1,
		));
		candidates = candidates.filter((account) =>
			(policy.priorityByAccount?.[account.index] ?? 1) === tier,
		);
	}

	if (typeof preferredIndex === "number") {
		const preferred = candidates.find((account) => account.index === preferredIndex);
		if (preferred) return accountManager.getAccountByIndex(preferred.index);
	}

	if (typeof startIndex === "number" && candidates.length > 1) {
		const after = candidates.filter((account) => account.index >= startIndex);
		const before = candidates.filter((account) => account.index < startIndex);
		candidates = [...after, ...before];
	}

	const first = candidates[0];
	return first ? accountManager.getAccountByIndex(first.index) : null;
}

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
	/** Soft preference, used only within the first eligible priority tier. */
	preferredIndex?: number | null;
	/** Soft pin: first eligible attempt across tiers, then normal fallback. Ignored whenever `pinnedIndex` is set, which is how the proxy applies a stored `switch` pin. */
	fallbackPinnedIndex?: number | null;
	subscriptionQuotaByAccount?: Record<number, SubscriptionQuotaPreference>;
	skipReasons?: Map<number, string>;
	stickyBoostByAccount?: Record<number, number>;
	pidOffsetEnabled?: boolean;
	schedulingStrategy?: "hybrid" | "sequential";
	/**
	 * Admit a pinned account that is only blocked by its own cooldown.
	 *
	 * Set by the proxy for RETRY passes, or the first pass when a pin only
	 * has a shared network-error cooldown. Independent concurrent work must
	 * not fail solely because another request encountered a transport error.
	 * Other cooldown reasons still protect the pin from new requests.
	 * Conflating them meant every transient branch cooled the pin down before
	 * the next selection pass and the budget could never be spent — a pinned
	 * request got exactly one upstream attempt under shipped defaults.
	 *
	 * Only the cooldown is waived. Rate limits, an open circuit, a disabled
	 * account, workspace and policy blocks all still reject the pin, and the
	 * cooldown itself stays on the account for unpinned selection and the 503's
	 * `retry_after_ms`.
	 *
	 * One ordering note: `getAccountRuntimeSkipReason` reports the FIRST
	 * blocker it finds and checks the cooldown before the circuit, so an
	 * account that is both cooling down and circuit-open reads as a cooldown
	 * and is admitted here. That is safe: `consumeTokenWithReason` takes the
	 * breaker's admission slot immediately after selection and rejects it with
	 * `circuit-open`, which is also the more accurate skip reason to report.
	 */
	allowPinnedCooldown?: boolean;
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
		allowPinnedCooldown,
	} = params;

 const fallbackPin = params.fallbackPinnedIndex;
 const quotaByAccount = params.subscriptionQuotaByAccount;
 const hasNonReserve = quotaByAccount && accountManager.getAccountsSnapshot().some(a =>
  a.enabled !== false && !attemptedIndexes.has(a.index) && !policy?.blockedAccountIndexes.has(a.index) &&
  !accountManager.getAccountRuntimeSkipReason(a.index,family,model) && !quotaByAccount[a.index]?.exhausted && !usesSubscriptionReserve(quotaByAccount[a.index]));
 if (pinnedIndex === null && typeof fallbackPin === "number" && !attemptedIndexes.has(fallbackPin) &&
  !quotaByAccount?.[fallbackPin]?.exhausted && !(hasNonReserve && usesSubscriptionReserve(quotaByAccount?.[fallbackPin]))) {
  const selected = chooseAccount({...params, pinnedIndex: fallbackPin, allowPinnedCooldown: false});
  if (selected) return selected;
 }

	if (pinnedIndex === null && policy?.priorityByAccount) {
		const priorities = policy.priorityByAccount;
		let candidates = accountManager.getAccountsSnapshot().filter(account => {
			if (account.enabled === false || attemptedIndexes.has(account.index) || policy.blockedAccountIndexes.has(account.index)) return false;
			const reason = accountManager.getAccountRuntimeSkipReason(account.index, family, model);
			if (reason) skipReasons?.set(account.index, reason);
			return !reason;
		});
		if (!candidates.length) return null;
  if (quotaByAccount) {
   const usable = candidates.filter(a => !quotaByAccount[a.index]?.exhausted);
   if (!usable.length) return null;
   const nonReserve = usable.filter(a => !usesSubscriptionReserve(quotaByAccount[a.index]));
   candidates = nonReserve.length ? nonReserve : usable;
  }
		const tier = Math.min(...candidates.map(a => priorities[a.index] ?? 1));
		const tierIndexes = new Set(candidates.filter(a => (priorities[a.index] ?? 1) === tier).map(a => a.index));
		// Runtime policy fills default priority 1 even without a configured order.
		const useSavedOrder = schedulingStrategy === "sequential" &&
			Object.values(priorities).some(priority => priority !== 1);
		let preferred = useSavedOrder
			? candidates.find(account => tierIndexes.has(account.index))?.index
			: params.preferredIndex;
  if (quotaByAccount && schedulingStrategy !== "sequential") {
   // Rank only measured accounts: "no data" compares equal to everything, which
   // is not transitive and would make the winner depend on storage order.
   const ranked = candidates.flatMap(a=>{
    const quota=quotaByAccount[a.index];
    return tierIndexes.has(a.index) && quota ? [{account:a,quota}] : [];
   }).sort((a,b)=>compareSubscriptionQuota(a.quota,b.quota)).map(entry=>entry.account);
   const best=ranked[0];
   const bestQuota=best && quotaByAccount[best.index];
   if (best && bestQuota && (bestQuota.resetAtMs !== null || bestQuota.remainingPercent !== null)) {
    const preferredQuota=typeof preferred === "number" ? quotaByAccount[preferred] : undefined;
    if (!preferredQuota || !tierIndexes.has(preferred ?? -1) || compareSubscriptionQuota(bestQuota,preferredQuota)<0) preferred=best.index;
   }
  }
		// Re-evaluate tiers on every attempt. Never persist a temporary tier block.
		const selected = chooseAccount({
			...params,
			policy: {
				...policy,
				priorityByAccount: undefined,
				blockedAccountIndexes: new Set([
					...policy.blockedAccountIndexes,
					// A retry alone must not make a healthy sequential primary unusable.
					...accountManager.getAccountsSnapshot().filter(a => !tierIndexes.has(a.index) && (
						schedulingStrategy !== "sequential" || !attemptedIndexes.has(a.index) ||
						quotaByAccount?.[a.index]?.exhausted ||
						(hasNonReserve && usesSubscriptionReserve(quotaByAccount?.[a.index]))
					)).map(a => a.index),
				]),
			},
			fallbackPinnedIndex: null,
			pinnedIndex: typeof preferred === "number" && tierIndexes.has(preferred) ? preferred : null,
		});
		if (selected && schedulingStrategy === "sequential") selected.lastUsed = now;
		return selected;
	}

	// Manual pin (from `codex-multi-auth switch <n>`) overrides every other
	// selection signal. We do NOT call markSwitched here — the proxy must not
	// clobber the pin set by the CLI. See issue #474.
	if (typeof pinnedIndex === "number") {
		// A pin has no alternative account to rotate to. Re-evaluate its live
		// blockers on every pass so a healthy account can use the caller's bounded
		// retry budget; attemptedIndexes remains authoritative for unpinned pool
		// selection below. The proxy also carries an absolute loop guard for retry
		// branches that do not advance their transient-attempt counter.
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
		if (reason && !(allowPinnedCooldown === true && isCooldownReason(reason))) {
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
		blockedAccountIndexes: policy?.blockedAccountIndexes,
		blockedReasonByAccount: policy?.blockedAccountReasons,
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
