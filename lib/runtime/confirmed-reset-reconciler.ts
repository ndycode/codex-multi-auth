import type { AccountManager, ManagedAccount } from "../accounts.js";
import { LUNA_RESERVE_MODEL } from "../constants.js";
import type { ModelFamily } from "../prompts/codex.js";
import type { QuotaCacheEntry } from "../quota-cache.js";
import { resetSnapshotQuota, type ResetCreditService, type ResetSnapshot } from "./reset-credits.js";
import { workspaceModelScopes } from "./workspace-model-scopes.js";

type ResetState = Awaited<ReturnType<ResetCreditService["status"]>>;
type Scope = ReturnType<typeof workspaceModelScopes>[number];
interface Operation { at: number; promise: Promise<boolean> }

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
	}): Promise<boolean> {
		const { state, account, scope, model, family, manager } = options;
		const receipt = state?.lastRedemption;
		if (model === LUNA_RESERVE_MODEL || state?.pending || !receipt ||
			receipt.outcome !== "reset" || receipt.key !== scope.id || receipt.at > options.now()) return false;
		const eligible = () => options.isCurrent() && account.enabled !== false && !account.authInvalidatedAt &&
			!(account.cooldownReason === "auth-failure" && (account.coolingDownUntil ?? 0) > options.now()) &&
			workspaceModelScopes(account).some(current => current.id === scope.id && current.routable);
		if (!eligible() || (account.rateLimitObservedAt ?? 0) > receipt.at) return false;
		const key = JSON.stringify([scope.id, model]);
		const existing = this.operations.get(key);
		if (existing && existing.at >= receipt.at) {
			await existing.promise;
			return false;
		}
		// Install the operation before starting I/O so concurrent requests share it.
		const operation: Operation = { at: receipt.at, promise: Promise.resolve(false) };
		if (this.operations.size >= 1000 && !this.operations.has(key)) {
			this.operations.delete(this.operations.keys().next().value ?? "");
		}
		this.operations.set(key, operation);
		operation.promise = (async () => {
			const revision = account.rateLimitRevision ?? 0;
			const startedAt = options.now();
			const snapshot = await options.read().catch(() => undefined);
			if (!snapshot) {
				if (this.operations.get(key) === operation) this.operations.delete(key);
				return false;
			}
			// A new 429, workspace change, or newer redemption wins over a delayed read.
			if (this.operations.get(key) !== operation || !eligible() ||
				(account.rateLimitRevision ?? 0) !== revision ||
				snapshot.updatedAt < startedAt || snapshot.updatedAt > options.now() ||
				snapshot.ordinaryUsageAllowed !== true) return false;
			options.observations.set(key, resetSnapshotQuota(snapshot));
			// A cold manager has no reason for its persisted family-level quota block.
			// Fresh native permission can supersede that block, but not token/concurrency
			// limits, model-specific windows, auth failures, or separately metered Reserve.
			if (account.lastRateLimitReason !== undefined && account.lastRateLimitReason !== "quota") return false;
			delete account.rateLimitResetTimes[family];
			if (account.cooldownReason === "rate-limit") manager.clearAccountCooldown(account);
			options.clearQuotaScheduler();
			manager.saveToDiskDebounced();
			return true;
		})();
		return operation.promise;
	}
}
