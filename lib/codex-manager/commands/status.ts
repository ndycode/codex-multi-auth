import { resetSnapshotQuota } from "../../runtime/reset-credits.js";
import { resetTargetForStoredAccount, type loadResetCreditState } from "../../runtime/account-reset-credits.js";
import { subscriptionQuotaPreference, compareSubscriptionQuota, usesSubscriptionReserve, SUBSCRIPTION_RESERVE_PERCENT } from "../../runtime/subscription-quota-order.js";
import { styleReportText as paint } from "../../ui/format.js";
import { inferenceAccountKey } from "../../runtime/inference-activity.js";
import type { ApiRouteCredential } from "../../api-route-store.js";
import { modelScopeId } from "../../runtime/workspace-model-scopes.js";
import { loadAccountPolicyStore, getAccountPolicyKey } from "../../account-policy.js";
import { formatModelInventory, type ModelInventory } from "../../runtime/model-discovery-status.js";
import {
	AUTH_INVALIDATION_MARKER,
	formatAccountLabel,
	formatCooldown,
	formatWaitTime,
	formatWorkspaceLines,
} from "../../accounts.js";
import {
	evaluateForecastAccounts,
	recommendForecastAccount,
} from "../../forecast.js";
import type { ModelFamily } from "../../prompts/codex.js";
import {
	findQuotaCacheEntryForAccount,
	isQuotaCacheEntryExhausted,
} from "../../quota-readiness.js";
import type { QuotaCacheData, QuotaCacheWindow } from "../../quota-cache.js";
import type { AppBindRouterStatus } from "../../runtime/app-bind.js";
import {
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
	type RuntimeAccountSignal,
} from "../../runtime/runtime-current-account.js";
import { isRateLimitedMarker } from "../rate-limit-markers.js";
import type { RuntimeObservabilitySnapshot } from "../../runtime/runtime-observability.js";
import type { AccountStorageV3, StorageHealthSummary } from "../../storage.js";

type LoadedStorage = AccountStorageV3 | null;
type RestoreReason = "empty-storage" | "intentional-reset" | "missing-storage";

export interface StatusCommandDeps {
 loadResetCreditState?: typeof loadResetCreditState;
	setStoragePath: (path: string | null) => void;
	getStoragePath: () => string | null;
	loadAccounts: () => Promise<LoadedStorage>;
	resolveActiveIndex: (
		storage: AccountStorageV3,
		family?: ModelFamily,
	) => number;
	formatRateLimitEntry: (
		account: AccountStorageV3["accounts"][number],
		now: number,
		family: ModelFamily,
	) => string | null;
	loadRuntimeObservabilitySnapshot?: () => Promise<RuntimeObservabilitySnapshot | null>;
	loadAppBindStatus?: () => Promise<(AppBindRouterStatus & { nativeOpenai?: boolean }) | null>;
	loadAccountPolicies?: typeof loadAccountPolicyStore;
	loadAppHelperStatus?: () => RuntimeAccountSignal | null;
	loadModelInventory?: () => Promise<ModelInventory | null>;
	loadApiRoutes?: () => Promise<ApiRouteCredential[]>;
	loadInferenceRequestTimes?: (keys: string[]) => Promise<Record<string, number>>;
	loadQuotaCache?: () => Promise<QuotaCacheData | null>;
	inspectStorageHealth?: () => Promise<StorageHealthSummary>;
	getNow?: () => number;
	logInfo?: (message: string) => void;
	/** When true, emit a single machine-readable JSON object instead of text (cli-manager-03). */
	json?: boolean;
}

function isRestoreReason(value: unknown): value is RestoreReason {
	return (
		value === "empty-storage" ||
		value === "intentional-reset" ||
		value === "missing-storage"
	);
}

function readRestoreReason(storage: AccountStorageV3): RestoreReason | undefined {
	if (!("restoreReason" in storage)) return undefined;
	return isRestoreReason(storage.restoreReason)
		? storage.restoreReason
		: undefined;
}

/**
 * Build the status marker list for one account (cli-manager-03).
 *
 * The json and text paths previously rebuilt this identical sequence
 * independently, so adding a marker to one branch silently diverged the other.
 * Both paths now call this single builder. Order matters (current → disabled →
 * rate-limited → 429-from-quota → quota-exhausted → cooldown) and is preserved.
 */
function buildAccountMarkers(
	account: AccountStorageV3["accounts"][number],
	index: number,
	activeIndex: number,
	runtimeCurrent: ReturnType<typeof resolveRuntimeCurrentAccount>,
	now: number,
	quotaCache: QuotaCacheData | null,
	allAccounts: AccountStorageV3["accounts"],
	formatRateLimitEntry: StatusCommandDeps["formatRateLimitEntry"],
): string[] {
	const markers: string[] = [];
	markers.push(...resolveAccountCurrentMarkers(index, activeIndex, runtimeCurrent));
	if (account.enabled === false) markers.push("disabled");
	if (
		typeof account.authInvalidatedAt === "number" &&
		Number.isFinite(account.authInvalidatedAt)
	) {
		markers.push(AUTH_INVALIDATION_MARKER);
	}
	if (formatRateLimitEntry(account, now, "codex")) markers.push("rate-limited");
	const quotaEntry = findQuotaCacheEntryForAccount(quotaCache, account, allAccounts);
	if (quotaEntry?.status === 429 && !markers.some(isRateLimitedMarker)) {
		markers.push("rate-limited");
	}
	if (isQuotaCacheEntryExhausted(quotaEntry, now)) markers.push("quota-exhausted");
	const cooldown = formatCooldown(account, now);
	if (cooldown) markers.push(`cooldown:${cooldown}`);
	return markers;
}

function formatRuntimeLastAccount(
	runtimeSnapshot: RuntimeObservabilitySnapshot,
): string | null {
	if (
		runtimeSnapshot.lastAccountLabel &&
		!runtimeSnapshot.lastAccountLabel.includes("@")
	) {
		return runtimeSnapshot.lastAccountLabel;
	}
	if (runtimeSnapshot.lastAccountId) {
		return typeof runtimeSnapshot.lastAccountIndex === "number"
			? `Account ${runtimeSnapshot.lastAccountIndex + 1} (${runtimeSnapshot.lastAccountId})`
			: runtimeSnapshot.lastAccountId;
	}
	if (typeof runtimeSnapshot.lastAccountIndex === "number") {
		return `Account ${runtimeSnapshot.lastAccountIndex + 1}`;
	}
	return null;
}

/** Expired observations must not impose pressure after their window has reset. */
function forecastQuotaWindow(window: QuotaCacheWindow, updatedAt: number, now: number): QuotaCacheWindow {
 const expiresAt = window.resetAtMs ?? (window.windowMinutes && window.windowMinutes > 0 ? updatedAt + window.windowMinutes * 60_000 : null);
 return expiresAt !== null && now >= expiresAt ? {} : window;
}

export async function runStatusCommand(
	deps: StatusCommandDeps,
): Promise<number> {
	deps.setStoragePath(null);
	let apiConfigurationUnavailable = false;
    const apiRoutes = await deps.loadApiRoutes?.().catch(() => {apiConfigurationUnavailable=true;return [];}) ?? [];
 const loadedStorage = await deps.loadAccounts();
 const storage: LoadedStorage = loadedStorage ?? (apiRoutes.length ? {version:3,activeIndex:0,accounts:[]} : null);
	const path = deps.getStoragePath();
	const storageHealth = await deps.inspectStorageHealth?.();
	const logInfo = deps.logInfo ?? console.log;
    if (apiConfigurationUnavailable && !deps.json) logInfo("API configuration unavailable; subscription status remains available.");

	const modelInventory = await deps.loadModelInventory?.();
 const resetCredits = await deps.loadResetCreditState?.().catch(()=>null);
 const resetSnapshot = (account: AccountStorageV3["accounts"][number]) => {const target=resetTargetForStoredAccount(account);return target?resetCredits?.snapshots[target.key]:undefined;};
	const accountPolicies: Awaited<ReturnType<typeof loadAccountPolicyStore>> = await (deps.loadAccountPolicies ?? loadAccountPolicyStore)().catch(() => ({version:1 as const,accounts:{}}));
	if (!deps.json && deps.loadModelInventory) for (const line of formatModelInventory(modelInventory ?? null)) logInfo(line);
	if (!storage || (storage.accounts.length === 0 && apiRoutes.length === 0)) {
		const restoreReason = storage ? readRestoreReason(storage) : undefined;
		const effectiveState: StorageHealthSummary["state"] | undefined =
			restoreReason === "intentional-reset"
				? "intentional-reset"
				: storageHealth?.state ??
					(restoreReason === "empty-storage" ||
					restoreReason === "missing-storage"
						? "empty"
						: undefined);
		if (deps.json) {
			logInfo(
				JSON.stringify(
					{
						storagePath: path,
                        ...(apiConfigurationUnavailable ? {warnings:["api_configuration_unavailable"]} : {}),
						storageHealth: effectiveState ?? null,
						accountCount: 0,
						totalAccountCount: 0,
						apiAccounts: [],
						modelInventory: modelInventory ?? null,
						// Emit the same keys the populated branch does (as null) so a
						// --json consumer sees one stable shape regardless of account count.
						activeIndex: null,
						pinnedAccountIndex: null,
						recommendedIndex: null,
						recommendationReason: null,
						runtimeInUseIndex: null,
						accounts: [],
					},
					null,
					2,
				),
			);
			return 0;
		}
		logInfo(
			effectiveState === "intentional-reset"
				? "No accounts configured. Storage was intentionally reset."
				: effectiveState === "recoverable"
					? "No accounts configured. Recovery artifacts are available."
					: effectiveState === "corrupt"
						? "No accounts configured. Storage appears corrupted."
						: "No accounts configured.",
		);
		logInfo(paint(`Storage: ${path}`, "muted"));
		if (effectiveState) {
			logInfo(`Storage health: ${effectiveState}`);
		}
		return 0;
	}

	const now = deps.getNow?.() ?? Date.now();
	const activeIndex = storage.accounts.length ? deps.resolveActiveIndex(storage, "codex") : -1;
	const quotaCache = await deps.loadQuotaCache?.() ?? null;
 const forecastQuotas = storage.accounts.map(account => {
  const cached = findQuotaCacheEntryForAccount(quotaCache, account, storage.accounts);
  const reset=resetSnapshot(account);
  const entry=reset && reset.updatedAt > (cached?.updatedAt??0) && reset.updatedAt<=now && now-reset.updatedAt<=60000 ? resetSnapshotQuota(reset):cached;
  if (!entry) return null;
  const primary = forecastQuotaWindow(entry.primary, entry.updatedAt, now);
  const secondary = forecastQuotaWindow(entry.secondary, entry.updatedAt, now);
  if (![primary, secondary].some(window => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent))) return null;
  return {...entry, primary, secondary};
 });
 const forecastResults = evaluateForecastAccounts(
		storage.accounts.map((account, index) => ({
			index,
			account,
			isCurrent: index === activeIndex,
			now,
			quotaCache,
			allAccounts: storage.accounts,
			liveQuota: forecastQuotas[index] ?? undefined,
		})),
	);
	const recommendation = recommendForecastAccount(forecastResults);
	if (!deps.json) {
		logInfo(paint(apiRoutes.length ? `Accounts (${storage.accounts.length + apiRoutes.length}: ${storage.accounts.length} subscription, ${apiRoutes.length} API/ZDR)` : `Accounts (${storage.accounts.length})`, "heading"));
		logInfo(paint(`Storage: ${path}`, "muted"));
		if (recommendation.recommendedIndex !== null) {
			logInfo(
				paint(`Forecast suggestion: account ${recommendation.recommendedIndex + 1} (${recommendation.reason})`, "accent"),
			);
		}
		if (storageHealth) {
			logInfo(paint(`Storage health: ${storageHealth.state}`, storageHealth.state === "healthy" ? "success" : "warning"));
		}
	}
	const appHelperStatus = deps.loadAppHelperStatus?.() ?? null;
	const [runtimeSnapshot, appBindStatus] = await Promise.all([
		deps.loadRuntimeObservabilitySnapshot?.() ?? Promise.resolve(null),
		deps.loadAppBindStatus?.() ?? Promise.resolve(null),
	]);
 const quotaPreferences = forecastQuotas.map(quota=>subscriptionQuotaPreference(quota,now));
 const automaticOrder = new Map<number,number>();
 if (appBindStatus?.nativeOpenai) {
  const candidates=storage.accounts.map((account,index)=>({account,index,quota:quotaPreferences[index] ?? subscriptionQuotaPreference(null,now),tier:accountPolicies.accounts[getAccountPolicyKey(account,index)]?.priority ?? 1}))
   .filter(a=>forecastResults[a.index]?.availability === "ready" && !a.quota.exhausted);
  candidates.sort((a,b)=>Number(usesSubscriptionReserve(a.quota))-Number(usesSubscriptionReserve(b.quota)) ||
   a.tier-b.tier || compareSubscriptionQuota(a.quota,b.quota) || Number(b.index===activeIndex)-Number(a.index===activeIndex) || a.index-b.index);
  // A switch pin is strict in native mode too: no other account is tried, so none gets an order.
  const pinned=typeof storage.pinnedAccountIndex==="number" ? candidates.filter(a=>a.index===storage.pinnedAccountIndex) : candidates;
  pinned.forEach((a,index)=>{automaticOrder.set(a.index,index+1);});
 }
 const activityKeys = [...storage.accounts.map(inferenceAccountKey),...apiRoutes.map(route=>`sha256:${modelScopeId(route.kind,route.id)}`)];
 const persistedActivity = await deps.loadInferenceRequestTimes?.(activityKeys) ?? {};
 const inferenceTimes = {...runtimeSnapshot?.lastInferenceRequestAtByAccount};
 for(const [key,at] of Object.entries(persistedActivity)) inferenceTimes[key]=Math.max(inferenceTimes[key]??0,at);
 const apiAccounts = apiRoutes.map((route,index)=>({
  index, label:route.label, kind:route.kind, enabled:route.enabled, priority:route.priority,
  visibleModelCount:route.visibleModels.length,
  lastInferenceRequestAt:inferenceTimes[`sha256:${modelScopeId(route.kind,route.id)}`]??null,
 }));
 const printApiAccounts = () => {
  if(!apiAccounts.length)return;
  logInfo(""); logInfo(paint(`API/ZDR accounts (${apiAccounts.length}; separate privacy pools, lower tier first):`, "heading"));
  for(const account of apiAccounts){
   const last = account.lastInferenceRequestAt === null ? "inference not yet recorded" : `last inference request ${formatWaitTime(Math.max(0,now-account.lastInferenceRequestAt))} ago`;
   logInfo(`${paint(`${account.kind.toUpperCase()} account ${account.index+1}: ${account.label}`, "heading")}${account.enabled?"":paint(" [disabled]", "warning")} ${paint(last, "muted")}`);
   logInfo(`   ${paint(`priority tier: ${account.priority}`, "accent")}; visible models: ${account.visibleModelCount}`);
  }
 };

	const runtimeCurrent = resolveRuntimeCurrentAccount(
		storage,
		{
			runtimeSnapshot,
			appBindStatus,
			appHelperStatus,
		},
		{ now },
	);

	// cli-manager-03: machine-readable output for status/list. Build a single
	// object from the same data the text path renders, then emit and return.
	if (deps.json) {
		const accounts = storage.accounts.map((account, i) => {
			const markers = buildAccountMarkers(
				account,
				i,
				activeIndex,
				runtimeCurrent,
				now,
				quotaCache,
				storage.accounts,
				deps.formatRateLimitEntry,
			);
			return {
				index: i,
        resetCreditsAvailable: resetSnapshot(account)?.availableCount ?? null,
        resetCreditsCheckedAt: resetSnapshot(account)?.updatedAt ?? null,
				label: formatAccountLabel(account, i),
				enabled: account.enabled !== false,
				current: i === activeIndex,
				priority: accountPolicies.accounts[getAccountPolicyKey(account, i)]?.priority ?? 1,
				autoPrime: accountPolicies.accounts[getAccountPolicyKey(account, i)]?.autoPrime ?? false,
				markers,
				selectionPreference: storage.pinnedAccountIndex === i ? "strict-pin" : null,
				forecastRiskScore: forecastResults[i]?.riskScore ?? null,
				forecastRiskLevel: forecastResults[i]?.riskLevel ?? null,
				forecastQuotaUpdatedAt: forecastQuotas[i]?.updatedAt ?? null,
    automaticOrder: automaticOrder.get(i) ?? null,
    subscriptionReserve: usesSubscriptionReserve(quotaPreferences[i]),
    quotaResetAt: quotaPreferences[i]?.resetAtMs ?? null,
    quotaDrainPerHour: quotaPreferences[i]?.urgency ?? null,
				lastInferenceRequestAt: inferenceTimes[inferenceAccountKey(account)] ?? null,
				lastUsed:
					typeof account.lastUsed === "number" && account.lastUsed > 0
						? account.lastUsed
						: null,
				reason: forecastResults[i]?.reasons[0] ?? null,
			};
		});
		logInfo(
			JSON.stringify(
				{
					storagePath: path,
                        ...(apiConfigurationUnavailable ? {warnings:["api_configuration_unavailable"]} : {}),
					storageHealth: storageHealth?.state ?? null,
					accountCount: storage.accounts.length,
					apiAccounts,
					totalAccountCount: storage.accounts.length + apiAccounts.length,
					selectionMode: appBindStatus?.nativeOpenai ? "model-priority" : "legacy-pin",
					activeIndex,
					pinnedAccountIndex:
						typeof storage.pinnedAccountIndex === "number"
							? storage.pinnedAccountIndex
							: null,
					recommendedIndex: recommendation.recommendedIndex,
					recommendationReason: recommendation.reason,
					runtimeInUseIndex: runtimeCurrent ? runtimeCurrent.index : null,
					modelInventory: modelInventory ?? null,
					accounts,
					lastRequestedWorkspace: runtimeSnapshot?.lastRequestedWorkspaceId ? {
						id: runtimeSnapshot.lastRequestedWorkspaceId,
						accountIndex: runtimeSnapshot.lastAccountIndex ?? null,
						requestedAt: runtimeSnapshot.lastAccountUpdatedAt ?? null,
					} : null,
				},
				null,
				2,
			),
		);
		return 0;
	}

	if (runtimeSnapshot) {
		const runtimeMetrics = runtimeSnapshot.runtimeMetrics;
		const poolCooldown =
			typeof runtimeSnapshot.poolExhaustionCooldownUntil === "number" &&
			runtimeSnapshot.poolExhaustionCooldownUntil > now
				? formatWaitTime(runtimeSnapshot.poolExhaustionCooldownUntil - now)
				: null;
		const serverCooldown =
			typeof runtimeSnapshot.serverBurstCooldownUntil === "number" &&
			runtimeSnapshot.serverBurstCooldownUntil > now
				? formatWaitTime(runtimeSnapshot.serverBurstCooldownUntil - now)
				: null;
		logInfo(
			`Runtime: responses=${runtimeSnapshot.responsesRequests}, refresh=${runtimeSnapshot.authRefreshRequests}, probes=${runtimeSnapshot.diagnosticProbeRequests}, budgetExhaustions=${runtimeMetrics.requestAttemptBudgetExhaustions}`,
		);
		const lastRuntimeAccount = formatRuntimeLastAccount(runtimeSnapshot);
		if (lastRuntimeAccount) {
			logInfo(paint(`Last runtime account: ${lastRuntimeAccount}`, "accent"));
   if (typeof runtimeSnapshot.lastAccountUpdatedAt === "number" && runtimeSnapshot.lastAccountUpdatedAt > 0) logInfo(`Last runtime request: ${formatWaitTime(Math.max(0, now-runtimeSnapshot.lastAccountUpdatedAt))} ago`);
		}
		const requestedId = runtimeSnapshot.lastRequestedWorkspaceId;
		if (requestedId) {
			const index = resolveRuntimeCurrentAccount(storage, {runtimeSnapshot}, {now})?.index;
			const workspace = index === undefined ? undefined : storage.accounts[index]?.workspaces?.find(w => w.id === requestedId);
			logInfo(`Last requested workspace: ${index === undefined ? "" : `account ${index + 1} / `}${workspace?.name?.trim() || "unlabelled"} (id:${requestedId.slice(-6)}; outgoing scope, billing plan not verified)`);
		} else logInfo("Last requested workspace: not recorded");
		if (poolCooldown || serverCooldown) {
			logInfo(
				`Cooldowns: pool=${poolCooldown ?? "none"}, server-burst=${serverCooldown ?? "none"}`,
			);
		}
		if (runtimeSnapshot.currentRequestId) {
			logInfo(`Last request trace: ${runtimeSnapshot.currentRequestId}`);
		}
	}
	if (runtimeCurrent) {
		logInfo(
			paint(`Runtime in use: account ${runtimeCurrent.index + 1} (${runtimeCurrent.source})`, "accent"),
		);
	}
	if (appBindStatus?.nativeOpenai) logInfo(paint("Automatic order estimates use the last check; requested model/workspace and live health can change the order.", "muted"));
	logInfo(paint("Account/workspace labels below describe saved settings, not the last routed workspace.", "muted"));
	const pinnedAccountIndex = storage.pinnedAccountIndex;
	if (typeof pinnedAccountIndex === "number") {
		if (
			!Number.isInteger(pinnedAccountIndex) ||
			pinnedAccountIndex < 0 ||
			pinnedAccountIndex >= storage.accounts.length
		) {
			logInfo(
				`Pinned: invalid account index ${pinnedAccountIndex}; run codex-multi-auth unpin`,
			);
		} else {
			logInfo(paint(`Pinned: account ${pinnedAccountIndex + 1} (strict; set by switch)`, "accent"));
			if (!appBindStatus?.nativeOpenai && runtimeCurrent && runtimeCurrent.index !== pinnedAccountIndex) {
				logInfo(
					`  warning: runtime currently using account ${runtimeCurrent.index + 1} but pin requests account ${pinnedAccountIndex + 1}; the proxy will pick up the pin on the next request.`,
				);
			}
		}
	}
	logInfo("");

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);
		const markers = buildAccountMarkers(
			account,
			i,
			activeIndex,
			runtimeCurrent,
			now,
			quotaCache,
			storage.accounts,
			deps.formatRateLimitEntry,
		);
		if (storage.pinnedAccountIndex === i) markers.push("strict pin");
		const markerLabel = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
  const lastInferenceAt = inferenceTimes[inferenceAccountKey(account)];
  const activity = typeof account.lastUsed === "number" && account.lastUsed > 0
   ? `account activity ${formatWaitTime(Math.max(0,now-account.lastUsed))} ago` : "no account activity recorded";
  const lastUsed = typeof lastInferenceAt === "number" && lastInferenceAt > 0
   ? `last inference request ${formatWaitTime(Math.max(0,now-lastInferenceAt))} ago`
   : `inference not yet recorded; ${activity}`;
		logInfo(`${paint(`${i + 1}. ${label}`, "heading")}${paint(markerLabel, markers.some(m => /disabled|cooldown|exhausted|limited|invalid/.test(m)) ? "warning" : "success")} ${paint(lastUsed, "muted")}`);
		logInfo(`   ${paint(`priority tier: ${accountPolicies.accounts[getAccountPolicyKey(account, i)]?.priority ?? 1}`, "accent")}`);
		if (accountPolicies.accounts[getAccountPolicyKey(account, i)]?.autoPrime) logInfo("   automatic first-use priming: on (router checks every 15 minutes)");
  if (appBindStatus?.nativeOpenai) {
   const preference=quotaPreferences[i];
   const order=automaticOrder.get(i);
   const reset=preference?.resetAtMs ? `; limiting window resets in ${formatWaitTime(Math.max(0,preference.resetAtMs-now))}` : "; reset ordering unknown; run check";
   const reserve=usesSubscriptionReserve(preference)?`; ${SUBSCRIPTION_RESERVE_PERCENT}% reserve (last resort)`:"";
   const pinnedElsewhere=typeof storage.pinnedAccountIndex==="number" && storage.pinnedAccountIndex!==i;
   logInfo(paint(`   automatic order: ${order ? `#${order}` : pinnedElsewhere ? `none (account ${(storage.pinnedAccountIndex ?? 0)+1} is pinned)` : "unavailable"}${reset}${reserve}`,reserve?"warning":"accent"));
  }
  const quota = forecastQuotas[i];
  if (quota) {
   const windows = (["primary", "secondary"] as const).flatMap(key => {
    const used = quota[key].usedPercent;
    return typeof used === "number" && Number.isFinite(used) ? [paint(`${key} ${Math.max(0, Math.min(100, Math.round(100-used)))}% left`, used >= 95 ? "danger" : used >= 80 ? "warning" : "success")] : [];
   });
   logInfo(`   quota: ${windows.join("; ")} (${paint(`cached quota ${formatWaitTime(Math.max(0, now-quota.updatedAt))} ago`, "muted")})`);
  } else logInfo(paint("   quota unknown; run check (risk uses other known signals only)", "warning"));
  const forecast = forecastResults[i];
  const resets=resetSnapshot(account);
  logInfo(`   subscription resets: ${resets?.availableCount ?? "unknown"}${resets ? ` (cached ${formatWaitTime(Math.max(0,now-resets.updatedAt))} ago)` : "; run check"}`);
  if (forecast) logInfo(`   ${paint(`forecast risk: ${forecast.riskScore}/100 (${forecast.riskLevel}; lower is better)`, forecast.riskLevel === "high" ? "danger" : forecast.riskLevel === "medium" ? "warning" : "success")}`);
		const primaryReason = forecastResults[i]?.reasons[0];
		if (primaryReason) {
			logInfo(paint(`   reason: ${primaryReason}`, "warning"));
		}
		// Surface every workspace a same-email account can rotate between, so
		// personal Plus vs business/team stay visible at once (issue #491).
		if ((account.workspaces?.length ?? 0) > 1) {
			logInfo(paint("   workspaces (saved selection; not live routing):", "muted"));
			for (const workspaceLine of formatWorkspaceLines(account, "     ", "saved selection")) {
				logInfo(paint(workspaceLine, workspaceLine.includes("(saved selection)") ? "accent" : "muted"));
			}
		}
	}

 printApiAccounts();
	return 0;
}

export interface FeaturesCommandDeps {
	implementedFeatures: ReadonlyArray<{ id: number; name: string }>;
	logInfo?: (message: string) => void;
}

export function runFeaturesCommand(deps: FeaturesCommandDeps): number {
	const logInfo = deps.logInfo ?? console.log;
	logInfo(`Implemented features (${deps.implementedFeatures.length})`);
	logInfo("");
	for (const feature of deps.implementedFeatures) {
		logInfo(`${feature.id}. ${feature.name}`);
	}
	return 0;
}
