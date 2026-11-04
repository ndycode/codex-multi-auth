import { getRateLimitObservationKey, getRuntimeTrackerKey, type AccountManager, type ManagedAccount } from "../accounts.js";
import { getTokenTracker } from "../rotation.js";
import { quotaResetTime, workspaceQuotaKey } from "../accounts/rate-limits.js";
import { LUNA_RESERVE_MODEL } from "../constants.js";
import type { ModelFamily } from "../prompts/codex.js";
import type { QuotaCacheEntry } from "../quota-cache.js";
import { resetReceiptIdentity, resetSnapshotQuota, type ResetCreditService, type ResetSnapshot } from "./reset-credits.js";
import { workspaceModelScopes } from "./workspace-model-scopes.js";

type ResetState = Awaited<ReturnType<ResetCreditService["status"]>>;
type Scope = ReturnType<typeof workspaceModelScopes>[number];
interface Operation {
	identity: string;
	generation?: number;
	startedAt: number;
	manager: AccountManager;
	account: ManagedAccount;
	failures: number;
	retryAfter?: number;
	/** Rejection history a completed read judged; a later rejection reopens the receipt. */
	judgedRevision?: string;
	promise: Promise<boolean>;
}
const RETRY_DELAY_MS = 5_000;
// Backend propagation can lag a redemption, so an exhausted read is never
// final; a long-retained receipt must not cost a native read every 5 seconds.
const MAX_RETRY_DELAY_MS = 300_000;

function receiptFor(state: ResetState | null, key: string) {
	return state?.redemptions?.[key] ?? (state?.lastRedemption?.key === key ? state.lastRedemption : undefined);
}

/**
 * A rejection recorded while receipts were unreadable is bounded by the next
 * successful read: anything visible then may predate it, so it cannot replay.
 */
export function settleReceiptBaselines(account: ManagedAccount, state: ResetState): void {
	const keys = new Set([...Object.keys(state.redemptions ?? {}), ...(state.lastRedemption ? [state.lastRedemption.key] : [])]);
	for (const rejection of Object.values(account.rateLimitObservations ?? {})) {
		if (!rejection.receiptReadFailed) continue;
		for (const key of keys) {
			const receipt = receiptFor(state, key);
			if (receipt?.generation !== undefined) {
				(rejection.receiptGenerations ??= {})[key] = Math.max(rejection.receiptGenerations?.[key] ?? 0, receipt.generation);
			} else if (receipt) {
				const identities = rejection.receiptIdentities ??= {}, identity = resetReceiptIdentity(receipt);
				if (!identities[key]?.includes(identity)) identities[key] = [...(identities[key] ?? []), identity];
			}
		}
		rejection.receiptReadFailed = false;
	}
}

/** A redemption is a durable notification, not a permanently healthy quota snapshot. */
export class ConfirmedResetReconciler {
	private readonly operations = new Map<string, Operation>();

	async reconcile(options: {
		state: () => Promise<ResetState | null>; account: ManagedAccount; scope: Scope;
		model: string; family: ModelFamily; manager: AccountManager;
		read: () => Promise<ResetSnapshot | undefined>;
		isCurrent: () => boolean; now: () => number;
		observations: Map<string, QuotaCacheEntry>;
		clearQuotaScheduler: () => void;
		hasQuotaDeferral?: () => boolean;
		hasCachedQuotaBlock?: () => boolean;
		usesAdmissionBucket?: boolean;
	}): Promise<boolean> {
		const { account, scope, model, family, manager } = options;
		if (model === LUNA_RESERVE_MODEL) return false;
		const eligible = () => options.isCurrent() && account.enabled !== false && !account.authInvalidatedAt &&
			!(account.cooldownReason === "auth-failure" && (account.coolingDownUntil ?? 0) > options.now()) &&
			workspaceModelScopes(account).some(current => current.id === scope.id && current.routable);
		// A wall-clock step backwards must not make an old observation win forever.
		const observationKey = getRateLimitObservationKey(family, scope.id);
		const rejectionForScope = () => account.rateLimitObservations?.[observationKey] ?? account.rateLimitObservations?.[family];
		const revision = () => `${account.rateLimitObservations?.[observationKey]?.revision ?? 0}:${account.rateLimitObservations?.[family]?.revision ?? 0}`;
		const blocked = (now: number) => quotaResetTime(account, family, scope.accountId) > now ||
			(account.cooldownReason === "rate-limit" && (account.coolingDownUntil ?? 0) > now) ||
			options.hasQuotaDeferral?.() || options.hasCachedQuotaBlock?.() ||
			// Ordinary load also drains the bucket; only a quota rejection makes it reset debt.
			(options.usesAdmissionBucket !== false && rejectionForScope()?.reason === "quota" &&
				getTokenTracker().getTokens(getRuntimeTrackerKey(account), `${family}:${model}`) < 1);
		// Receipts are read only for a request this account cannot otherwise serve.
		if (!eligible() || !blocked(options.now())) return false;
		const state = await options.state();
		if (state) settleReceiptBaselines(account, state);
		// A concurrent check can recover the account meanwhile; the caller then reselects it.
		if (!blocked(options.now())) return eligible();
		const receipt = receiptFor(state, scope.id);
		if (state?.pending?.key === scope.id || !receipt ||
			(receipt.outcome !== "reset" && receipt.outcome !== "alreadyRedeemed") || receipt.key !== scope.id) return false;
		const now = options.now();
		// Modern receipts are ordered by durable generation, not wall time. A
		// rejection after this generation was observed cannot replay that receipt.
		// Legacy receipt identities seen by the rejections are exact; wall time only
		// orders rejections that saw none.
		const identity = resetReceiptIdentity(receipt);
		const rejectedAfterReceipt = [account.rateLimitObservations?.[observationKey], account.rateLimitObservations?.[family]].some(rejection => {
			if (receipt.generation !== undefined) return (rejection?.receiptGenerations?.[scope.id] ?? 0) >= receipt.generation;
			const seen = rejection?.receiptIdentities?.[scope.id];
			if (seen !== undefined) return seen.includes(identity);
			return (rejection?.observedAt ?? 0) > receipt.at && ((rejection?.observedAt ?? 0) <= now || receipt.at > now);
		});
		if (!eligible() || rejectedAfterReceipt ||
			(receipt.generation !== undefined && receipt.generation < (account.resetReceiptGenerations?.[scope.id] ?? 0))) return false;
		// Receipt time may be ahead of this process after a clock rollback. Fresh
		// permission still decides recovery; exact receipt identity prevents replay.
		const key = JSON.stringify([scope.id, model]);
		const existing = this.operations.get(key);
		if (existing && existing.manager === manager && existing.account === account &&
			(receipt.generation !== undefined
				? existing.generation !== undefined && existing.generation >= receipt.generation
				: existing.generation !== undefined || existing.identity === identity) &&
			(existing.retryAfter === undefined
				? existing.judgedRevision === undefined || existing.judgedRevision === revision()
				: now >= existing.startedAt && now < existing.retryAfter)) {
			await existing.promise;
			return eligible() && !blocked(options.now());
		}
		// Install the operation before starting I/O so concurrent requests share it.
		if (receipt.generation !== undefined) {
			const generations = account.resetReceiptGenerations ??= {};
			generations[scope.id] = Math.max(generations[scope.id] ?? 0, receipt.generation);
		}
		const failures = existing?.manager === manager && existing.account === account &&
			existing.identity === identity && existing.generation === receipt.generation ? existing.failures : 0;
		const operation: Operation = { identity, generation:receipt.generation, startedAt:now, manager, account, failures, promise: Promise.resolve(false) };
		if (this.operations.size >= 1000 && !this.operations.has(key)) {
			this.operations.delete(this.operations.keys().next().value ?? "");
		}
		this.operations.set(key, operation);
		operation.promise = (async () => {
			const startedRevision = revision();
			const startedAt = options.now();
			const snapshot = await options.read().catch(() => undefined);
			if (this.operations.get(key) !== operation) return false;
			if (!eligible()) {
				if (this.operations.get(key) === operation) this.operations.delete(key);
				return false;
			}
			// A rejection during the read outranks its result. The next check skips
			// this receipt only if that rejection was sent after the receipt existed.
			if (revision() !== startedRevision || !snapshot || snapshot.updatedAt < startedAt ||
				snapshot.updatedAt > options.now() || snapshot.ordinaryUsageAllowed !== true) {
				operation.failures++;
				operation.retryAfter = options.now() + Math.min(RETRY_DELAY_MS * 2 ** (operation.failures - 1), MAX_RETRY_DELAY_MS);
				return false;
			}
			operation.judgedRevision = startedRevision;
			if (options.observations.size >= 1000 && !options.observations.has(key)) {
				options.observations.delete(options.observations.keys().next().value ?? "");
			}
			options.observations.set(key, resetSnapshotQuota(snapshot));
			// A cold manager has no reason for its persisted family-level quota block.
			// Fresh native permission can supersede that block, but not token/concurrency
			// limits, model-specific windows, auth failures, or separately metered Reserve.
			const reason = account.rateLimitObservations
				? rejectionForScope()?.reason : account.lastRateLimitReason;
			if (reason !== undefined && reason !== "quota") return false;
			delete account.rateLimitResetTimes[family];
			delete account.rateLimitResetTimes[workspaceQuotaKey(family, scope.accountId)];
			if (account.cooldownReason === "rate-limit") manager.clearAccountCooldown(account);
			options.clearQuotaScheduler();
			getTokenTracker().reset(getRuntimeTrackerKey(account), `${family}:${model}`);
			manager.saveToDiskDebounced();
			return true;
		})();
		return operation.promise;
	}
}
