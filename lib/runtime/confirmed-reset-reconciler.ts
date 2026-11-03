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
	at: number;
	generation?: number;
	startedAt: number;
	manager: AccountManager;
	account: ManagedAccount;
	retryAfter?: number;
	promise: Promise<boolean>;
}
const RETRY_DELAY_MS = 5_000;

/** A redemption is a durable notification, not a permanently healthy quota snapshot. */
export class ConfirmedResetReconciler {
	private readonly operations = new Map<string, Operation>();

	async reconcile(options: {
		state: ResetState | null; account: ManagedAccount; scope: Scope;
		model: string; family: ModelFamily; manager: AccountManager;
		read: () => Promise<ResetSnapshot | undefined>;
		isCurrent: () => boolean; now: () => number;
		observations: Map<string, QuotaCacheEntry>;
		clearQuotaScheduler: () => void;
		hasQuotaDeferral?: () => boolean;
		hasCachedQuotaBlock?: () => boolean;
		usesAdmissionBucket?: boolean;
	}): Promise<boolean> {
		const { state, account, scope, model, family, manager } = options;
		const receipt = state?.redemptions?.[scope.id] ?? (state?.lastRedemption?.key === scope.id ? state.lastRedemption : undefined);
		if (model === LUNA_RESERVE_MODEL || state?.pending?.key === scope.id || !receipt ||
			(receipt.outcome !== "reset" && receipt.outcome !== "alreadyRedeemed") || receipt.key !== scope.id) return false;
		const eligible = () => options.isCurrent() && account.enabled !== false && !account.authInvalidatedAt &&
			!(account.cooldownReason === "auth-failure" && (account.coolingDownUntil ?? 0) > options.now()) &&
			workspaceModelScopes(account).some(current => current.id === scope.id && current.routable);
		const now = options.now();
		// A wall-clock step backwards must not make an old observation win forever.
		const observationKey = getRateLimitObservationKey(family, scope.id);
		const rejectionForScope = () => account.rateLimitObservations?.[observationKey] ?? account.rateLimitObservations?.[family];
		const revision = () => `${account.rateLimitObservations?.[observationKey]?.revision ?? 0}:${account.rateLimitObservations?.[family]?.revision ?? 0}`;
		// A failed receipt read leaves ordering unknown. The first successful
		// state read establishes a conservative baseline, never permission to replay it.
		for (const rejection of [account.rateLimitObservations?.[observationKey], account.rateLimitObservations?.[family]]) {
			if (!rejection?.receiptReadFailed) continue;
			if (receipt.generation !== undefined) {
				(rejection.receiptGenerations ??= {})[scope.id] = Math.max(rejection.receiptGenerations?.[scope.id] ?? 0, receipt.generation);
				rejection.receiptReadFailed = false;
			}
			return false;
		}
		// Modern receipts are ordered by durable generation, not wall time. A
		// rejection after this generation was observed cannot replay that receipt.
		const rejectedAfterReceipt = [account.rateLimitObservations?.[observationKey], account.rateLimitObservations?.[family]].some(rejection =>
			receipt.generation !== undefined
				? (rejection?.receiptGenerations?.[scope.id] ?? 0) >= receipt.generation
				: rejection?.receiptIdentities?.[scope.id] === resetReceiptIdentity(receipt) ||
                    (rejection?.observedAt ?? 0) > receipt.at &&
					((rejection?.observedAt ?? 0) <= now || receipt.at > now));
		if (!eligible() || rejectedAfterReceipt || (receipt.generation !== undefined && receipt.generation < (account.resetReceiptGenerations?.[scope.id] ?? 0))) return false;
		if (!(quotaResetTime(account, family, scope.accountId) > now ||
			(account.cooldownReason === "rate-limit" && (account.coolingDownUntil ?? 0) > now) ||
			options.hasQuotaDeferral?.() || options.hasCachedQuotaBlock?.() ||
			(options.usesAdmissionBucket !== false && getTokenTracker().getTokens(getRuntimeTrackerKey(account), `${family}:${model}`) < 1))) return false;
		// Receipt time may be ahead of this process after a clock rollback. Fresh
		// permission still decides recovery; exact receipt identity prevents replay.
		const key = JSON.stringify([scope.id, model]);
		const existing = this.operations.get(key);
		if (existing && existing.manager === manager && existing.account === account &&
			(receipt.generation !== undefined
				? existing.generation !== undefined && existing.generation >= receipt.generation
				: existing.generation !== undefined || existing.at === receipt.at || (existing.at <= now && existing.at > receipt.at)) &&
			(existing.retryAfter === undefined || (now >= existing.startedAt && now < existing.retryAfter))) {
			await existing.promise;
			return false;
		}
		// Install the operation before starting I/O so concurrent requests share it.
		if (receipt.generation !== undefined) {
			const generations = account.resetReceiptGenerations ??= {};
			generations[scope.id] = Math.max(generations[scope.id] ?? 0, receipt.generation);
		}
		const operation: Operation = { at: receipt.at, generation:receipt.generation, startedAt:now, manager, account, promise: Promise.resolve(false) };
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
			// Keep a newer rejection authoritative, including when the read failed.
			if (revision() !== startedRevision) return false;
			if (!snapshot || snapshot.updatedAt < startedAt || snapshot.updatedAt > options.now() ||
				snapshot.ordinaryUsageAllowed !== true) {
				operation.retryAfter = options.now() + RETRY_DELAY_MS;
				return false;
			}
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
