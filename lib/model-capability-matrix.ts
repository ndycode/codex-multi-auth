import { getAccountPolicyKey } from "./account-policy.js";
import type { AccountStorageV3 } from "./storage.js";
import {
	MODEL_PROFILES,
	resolveNormalizedModel,
	type ModelCapabilities,
	type ModelReasoningEffort,
	type PromptModelFamily,
} from "./request/helpers/model-map.js";
import {
	resolveEntitlementAccountKey,
	type EntitlementCacheSnapshot,
} from "./entitlement-cache.js";
import type {
	CapabilityPolicySnapshot,
	CapabilityPolicyStore,
} from "./capability-policy.js";
import type { QuotaCacheData, QuotaCacheEntry } from "./quota-cache.js";
import { findQuotaCacheEntryForAccount } from "./quota-readiness.js";

export interface ModelCapabilityMatrixEntry {
	accountIndex: number;
	accountLabel: string;
	accountKey: string;
	model: string;
	normalizedModel: string;
	promptFamily: PromptModelFamily;
	defaultReasoningEffort: ModelReasoningEffort;
	supportedReasoningEfforts: readonly ModelReasoningEffort[];
	capabilities: ModelCapabilities;
	entitlementBlocked: boolean;
	entitlementReason: string | null;
	entitlementWaitMs: number;
	capabilityPolicy: CapabilityPolicySnapshot | null;
	capabilityBoost: number;
	quota: QuotaCacheEntry | null;
	available: boolean;
	reasons: string[];
}

export interface ModelCapabilityMatrix {
	generatedAt: number;
	models: string[];
	entries: ModelCapabilityMatrixEntry[];
}

function getEntitlementBlock(
	snapshot: EntitlementCacheSnapshot | null | undefined,
	accountKeys: string[],
	normalizedModel: string,
	now: number,
): { blocked: boolean; waitMs: number; reason: string | null } {
	if (!snapshot) return { blocked: false, waitMs: 0, reason: null };
	for (const accountKey of accountKeys) {
		const blocks = snapshot.accounts[accountKey] ?? [];
		const block = blocks.find((entry) => entry.model === normalizedModel);
		if (!block || block.blockedUntil <= now) continue;
		return {
			blocked: true,
			waitMs: Math.max(0, block.blockedUntil - now),
			reason: block.reason,
		};
	}
	return { blocked: false, waitMs: 0, reason: null };
}

export function buildModelCapabilityMatrix(input: {
	storage: AccountStorageV3 | null;
	models?: string[];
	entitlements?: EntitlementCacheSnapshot | null;
	capabilityPolicy?: CapabilityPolicyStore | null;
	quotaCache?: QuotaCacheData | null;
	now?: number;
}): ModelCapabilityMatrix {
	const now = input.now ?? Date.now();
	const models = (input.models?.length ? input.models : Object.keys(MODEL_PROFILES))
		.map((model) => resolveNormalizedModel(model))
		.filter((model, index, all) => all.indexOf(model) === index)
		.sort();
	const accounts = input.storage?.accounts ?? [];
	const entries: ModelCapabilityMatrixEntry[] = [];

	for (const [index, account] of accounts.entries()) {
		const accountKey = getAccountPolicyKey(account, index);
		const entitlementKey = resolveEntitlementAccountKey({
			accountId: account.accountId,
			email: account.email,
			index,
		});
		const entitlementKeys = [accountKey, entitlementKey];
		for (const model of models) {
			const profile = MODEL_PROFILES[model] ?? MODEL_PROFILES[resolveNormalizedModel(model)];
			if (!profile) continue;
			const entitlement = getEntitlementBlock(
				input.entitlements,
				entitlementKeys,
				profile.normalizedModel,
				now,
			);
			// quota-forecast-01: the capability store is WRITTEN under the
			// entitlement key (resolveEntitlementAccountKey) at the
			// recordUnsupported sites, so reads must use the same key. Previously
			// this used getAccountPolicyKey ("sha256:…"), a different format, so
			// getSnapshot/getBoost never matched and the capability signal was dead.
			const capabilityPolicy =
				input.capabilityPolicy?.getSnapshot(entitlementKey, profile.normalizedModel) ??
				null;
			const capabilityBoost =
				input.capabilityPolicy?.getBoost(entitlementKey, profile.normalizedModel, now) ??
				0;
			const quota =
				input.quotaCache && input.storage
					? findQuotaCacheEntryForAccount(
							input.quotaCache,
							account,
							input.storage.accounts,
						)
					: null;
			const reasons: string[] = [];
			if (account.enabled === false) reasons.push("account disabled");
			if (entitlement.blocked) {
				reasons.push(`entitlement blocked: ${entitlement.reason ?? "unknown"}`);
			}
			if (capabilityPolicy && capabilityPolicy.unsupported > 0) {
				reasons.push("capability policy has unsupported failures");
			}
			if (quota?.status === 429) reasons.push("quota cache is rate-limited");
			entries.push({
				accountIndex: index + 1,
				accountLabel: `Account ${index + 1}`,
				accountKey,
				model,
				normalizedModel: profile.normalizedModel,
				promptFamily: profile.promptFamily,
				defaultReasoningEffort: profile.defaultReasoningEffort,
				supportedReasoningEfforts: profile.supportedReasoningEfforts,
				capabilities: profile.capabilities,
				entitlementBlocked: entitlement.blocked,
				entitlementReason: entitlement.reason,
				entitlementWaitMs: entitlement.waitMs,
				capabilityPolicy,
				capabilityBoost,
				quota,
				available: reasons.length === 0,
				reasons,
			});
		}
	}

	return {
		generatedAt: now,
		models,
		entries,
	};
}

