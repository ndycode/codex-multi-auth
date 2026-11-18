import { subscriptionStatus, formatSubscriptionStatus } from "../formatters/subscription-status.js";
import { resetSnapshotQuota } from "../../runtime/reset-credits.js";
import { resetTargetForStoredAccount, type loadResetCreditState } from "../../runtime/account-reset-credits.js";
import { subscriptionQuotaPreference, compareSubscriptionQuota, usesSubscriptionReserve, SUBSCRIPTION_RESERVE_PERCENT } from "../../runtime/subscription-quota-order.js";
import { styleReportText as paint } from "../../ui/format.js";
import { inferenceAccountKey } from "../../runtime/inference-activity.js";
import type { ApiRouteCredential } from "../../api-route-store.js";
import { modelScopeId } from "../../runtime/workspace-model-scopes.js";
import { loadAccountPolicyStore, getAccountPolicyKey } from "../../account-policy.js";
import { getSchedulingStrategy, loadPluginConfig } from "../../config.js";
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
import { formatWebsocketDisconnect, type AppBindRouterStatus } from "../../runtime/app-bind.js";
import {
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
	type RuntimeAccountSignal,
} from "../../runtime/runtime-current-account.js";
import { isRateLimitedMarker } from "../rate-limit-markers.js";
import type { RuntimeObservabilitySnapshot } from "../../runtime/runtime-observability.js";
import { localized, resolveOutputLocale, type OutputLocale } from "../../locale.js";
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
	/** Compact human-facing summary. Undefined keeps the legacy detailed view for API callers. */
	compact?: boolean;
	locale?: OutputLocale;
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

type SubscriptionStatusValue = ReturnType<typeof subscriptionStatus>;

function boundedPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

/** Render usage as a visual bar while retaining exact percentages for copy/paste. */
function formatQuotaBar(
	usedPercent: number,
	width = 20,
): string {
	const used = boundedPercent(usedPercent);
	const filled = Math.round((used / 100) * width);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

/**
 * Human label for a quota window length. Derived from the reported
 * `windowMinutes` (300→"5h"/"5小时", 10080→"7d"/"7天"); falls back to a
 * neutral primary/secondary label when the duration is unknown.
 */
function formatQuotaWindowDuration(
	windowMinutes: number,
	locale: OutputLocale,
): string {
	const zh = locale === "zh";
	if (windowMinutes % 1440 === 0) {
		const days = windowMinutes / 1440;
		return zh ? `${days}天` : `${days}d`;
	}
	if (windowMinutes % 60 === 0) {
		const hours = windowMinutes / 60;
		return zh ? `${hours}小时` : `${hours}h`;
	}
	return zh ? `${windowMinutes}分钟` : `${windowMinutes}m`;
}

function formatQuotaWindowLabel(
	window: QuotaCacheWindow,
	key: "primary" | "secondary",
	locale: OutputLocale,
): string {
	const minutes = window.windowMinutes;
	if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
		return formatQuotaWindowDuration(minutes, locale);
	}
	return localized(
		locale,
		key === "primary" ? "primary" : "secondary",
		key === "primary" ? "主窗口" : "次窗口",
	);
}

function formatQuotaWindow(
	key: "primary" | "secondary",
	window: QuotaCacheWindow,
	locale: OutputLocale,
	width = 20,
): string {
	const used = boundedPercent(window.usedPercent ?? 0);
	const left = 100 - used;
	const label = formatQuotaWindowLabel(window, key, locale);
	if (locale === "zh") {
		return `${label} [${formatQuotaBar(used, width)}] 已用 ${used}% · 剩余 ${left}%`;
	}
	return `${label} [${formatQuotaBar(used, width)}] used ${used}% · ${left}% left`;
}

function formatQuotaCell(
	key: "primary" | "secondary",
	window: QuotaCacheWindow,
	locale: OutputLocale,
): string {
	const used = boundedPercent(window.usedPercent ?? 0);
	const label = formatQuotaWindowLabel(window, key, locale);
	return locale === "zh"
		? `${label} ${formatQuotaBar(used, 8)} ${used}%用/${100 - used}%余`
		: `${label} ${formatQuotaBar(used, 8)} ${used}%/${100 - used}%`;
}

function formatQuotaSummary(
	quota: { primary: QuotaCacheWindow; secondary: QuotaCacheWindow },
	locale: OutputLocale,
	width = 20,
): string[] {
	return (["primary", "secondary"] as const).flatMap((key) => {
		const used = quota[key]?.usedPercent;
		return typeof used === "number" && Number.isFinite(used)
			? [formatQuotaWindow(key, quota[key], locale, width)]
			: [];
	});
}

function translateMarker(marker: string): string {
	const direct: Record<string, string> = {
		current: "当前",
		selected: "已选中",
		"in-use": "使用中",
		"strict pin": "严格固定",
		disabled: "已禁用",
		"rate-limited": "限流中",
		"quota-exhausted": "配额已用尽",
		"token-invalid — re-login needed": "令牌无效——需要重新登录",
	};
	if (direct[marker]) return direct[marker];
	if (marker.startsWith("cooldown:")) return `冷却中：${marker.slice("cooldown:".length)}`;
	return marker
		.replace(/^account is disabled$/, "账号已禁用")
		.replace(/^runtime policy blocked account$/, "运行时策略阻止了账号")
		.replace(/^quota cache exhausted$/, "配额缓存已用尽")
		.replace(/^live probe returned 429$/, "实时探测返回 429")
		.replace(/^primary quota (.+) used$/, "主窗口配额已使用 $1")
		.replace(/^secondary quota (.+) used$/, "次窗口配额已使用 $1")
		.replace(/^hard auth failure: /, "认证失败：")
		.replace(/^refresh warning: /, "刷新警告：")
		.replace(/^runtime skip: /, "运行时跳过：")
		.replace(/^cooldown remaining /, "冷却剩余 ")
		.replace(/^rate limit resets in /, "限流将在 ")
		.replace(/^quota resets in /, "配额将在 ");
}

function translateDisconnectLine(line: string): string {
	return line
		.replace(/^Last WebSocket disconnect: /, "上次 WebSocket 断开：")
		.replace(/; cause=/, "；原因=")
		.replace(/; stage=/, "；阶段=")
		.replace(/; closeCode=/, "；关闭码=")
		.replace(/; route=/, "；路由=")
		.replace(/; connectionAgeMs=/, "；连接时长(ms)=")
		.replace(/; events=/, "；事件数=");
}

function translateReason(reason: string): string {
	if (reason === "token-invalid — re-login needed") return "令牌无效——需要重新登录";
	if (reason === "primary quota 0% used") return "主窗口配额已使用 0%";
	if (reason === "primary quota 97% used") return "主窗口配额已使用 97%";
	if (reason === "No recommendation available.") return "暂无推荐账号。";
	return translateMarker(reason)
		.replace(/^Lowest risk ready account \(([^,]+), score (\d+)\)\.$/, (_match, level: string, score: string) => `最低风险可用账号（${translateRiskLevel(level)}，分数 ${score}）。`)
		.replace(/^No account is immediately ready; pick shortest wait \((.+)\)\.$/, "当前没有立即可用账号；选择等待时间最短的账号（$1）。")
		.replace(/^All accounts are blocked or exhausted\..*$/, "所有账号都被阻止或配额已用尽。")
		.replace(/^No healthy accounts are available\..*$/, "没有健康可用的账号。")
		.replace(/^primary quota (\d+)% used$/, "主窗口配额已使用 $1%")
		.replace(/^secondary quota (\d+)% used$/, "次窗口配额已使用 $1%");
}

function formatLocalizedSubscriptionStatus(value: SubscriptionStatusValue): string {
	const plan: Record<string, string> = {
		"Unknown plan": "未知套餐",
		Business: "商业版",
		Enterprise: "企业版",
		Edu: "教育版",
	};
	const freshness = value.freshness === "stale"
		? "（数据已过期；请运行账号检查）"
		: value.freshness === "missing" ? "（尚未观测）" : "";
	const autoPrime = value.autoPrime === null ? "未知" : value.autoPrime ? "开启" : "关闭";
	const priming: Record<string, string> = {
		unknown: "首次使用状态未知",
		"awaiting-first-use": "等待首次使用",
		"timer-running": "重置计时运行中",
		used: "已记录使用",
		completed: "首次使用已完成；尚未确认计时器",
		failed: "首次使用失败",
		"not-applicable": "首次使用不适用",
	};
	const block: Record<string, string> = {
		"sign-in required": "需要重新登录",
		"account disabled": "账号已禁用",
		paused: "已暂停",
		drained: "已排空",
		"cooling down": "冷却中",
		"workspace unavailable": "工作区不可用",
	};
	const workspace = value.selectedWorkspace
		.replace(/Token account/g, "令牌账号")
		.replace(/Unnamed workspace/g, "未命名工作区")
		.replace(/Invalid workspace selection/g, "工作区选择无效")
		.replace(/Stored binding \(workspace unknown\)/g, "已存绑定（工作区未知）");
	const planLabel = plan[value.planLabel] ?? value.planLabel;
	const blocked = value.automaticBlock ? `；阻断：${block[value.automaticBlock] ?? value.automaticBlock}` : "";
	return `${workspace}${freshness} · ${planLabel} · 自动预热 ${autoPrime} · ${priming[value.primingState] ?? value.primingState}${blocked}`;
}

function formatStorageHealthZh(state: StorageHealthSummary["state"]): string {
	const labels: Record<string, string> = {
		healthy: "正常",
		corrupt: "损坏",
		empty: "空",
		"intentional-reset": "已主动重置",
		recoverable: "可恢复",
	};
	return labels[state] ?? state;
}

function translateAccountLabel(label: string): string {
	return label
		.replace(/^Account /, "账号 ")
		.replace(/Token account/g, "令牌账号")
		.replace(/, id:/g, "，ID:")
		.replace(/, /g, "，");
}

function translateRiskLevel(level: string): string {
	return ({ low: "低", medium: "中", high: "高" } as Record<string, string>)[level] ?? level;
}

function formatModelInventoryZh(inventory: ModelInventory | null): string[] {
	if (!inventory) return ["模型：未检查；请运行 codex-multi-auth check。"];
	const lines = [`模型发现（仅目录访问，不会发起推理探测）：${inventory.entries.length} 个条目`];
	for (const entry of inventory.entries) {
		const state = !entry.enabled ? "已禁用" : entry.error ? "发现失败" : `${entry.models.length} 个可用`;
		lines.push(`  ${entry.label} [${entry.kind.toUpperCase()}]：${state}`);
		lines.push(`    可用模型：${entry.models.join("、") || "无"}`);
	}
	return lines;
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
	const locale = deps.locale ?? resolveOutputLocale(loadPluginConfig().locale);
    if (apiConfigurationUnavailable && !deps.json && !deps.compact && locale !== "zh") logInfo("API configuration unavailable; subscription status remains available.");

	const modelInventory = await deps.loadModelInventory?.();
	const appBindStatus = await deps.loadAppBindStatus?.() ?? null;
	const disconnectLine = formatWebsocketDisconnect(appBindStatus?.lastWebsocketDisconnect);
	if (!deps.json && !deps.compact && locale !== "zh" && disconnectLine) logInfo(paint(disconnectLine, "warning"));
 const resetCredits = await deps.loadResetCreditState?.().catch(()=>null);
 const resetSnapshot = (account: AccountStorageV3["accounts"][number]) => {const target=resetTargetForStoredAccount(account);return target?resetCredits?.snapshots[target.key]:undefined;};
	let policiesUnavailable = false;
	const accountPolicies: Awaited<ReturnType<typeof loadAccountPolicyStore>> = await (deps.loadAccountPolicies ?? loadAccountPolicyStore)({strict:true}).catch(() => { policiesUnavailable = true; return {version:1 as const,accounts:{}}; });
	if (!deps.json && !deps.compact && locale !== "zh" && deps.loadModelInventory) for (const line of formatModelInventory(modelInventory ?? null)) logInfo(line);
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
					lastWebsocketDisconnect: appBindStatus?.lastWebsocketDisconnect ?? null,
						// Emit the same keys the populated branch does (as null) so a
						// --json consumer sees one stable shape regardless of account count.
						activeIndex: null,
						pinnedAccountIndex: null,
						recommendedIndex: null,
						recommendationReason: null,
						runtimeInUseIndex: null,
						runtime: null,
						accounts: [],
					},
					null,
					2,
				),
			);
			return 0;
		}
		if (deps.compact) {
			logInfo(localized(locale, "Codex Multi-Auth status", "Codex Multi-Auth 状态"));
			logInfo(localized(locale, "Accounts: 0 total", "账号：共 0 个"));
			logInfo(`${localized(locale, "Storage", "存储")}: ${path}`);
			if (effectiveState) logInfo(`${localized(locale, "Storage health", "存储健康")}: ${effectiveState}`);
			return 0;
		}
		if (locale === "zh") {
			if (apiConfigurationUnavailable) logInfo("警告：API 配置不可用；仍会显示订阅状态。");
			if (deps.loadModelInventory) {
				for (const line of formatModelInventoryZh(modelInventory ?? null)) logInfo(line);
			}
			const message = effectiveState === "intentional-reset"
				? "未配置账号。存储已主动重置。"
				: effectiveState === "recoverable"
					? "未配置账号。存在可用的恢复文件。"
					: effectiveState === "corrupt"
						? "未配置账号。存储似乎已损坏。"
						: "未配置账号。";
			logInfo(message);
			logInfo(`存储：${path}`);
			if (effectiveState) logInfo(`存储健康：${formatStorageHealthZh(effectiveState)}`);
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
 const subscriptionStatuses = storage.accounts.map(account => subscriptionStatus(account, findQuotaCacheEntryForAccount(quotaCache, account, storage.accounts), policiesUnavailable ? undefined : accountPolicies.accounts[getAccountPolicyKey(account)] ?? {}, now));
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
	if (!deps.json && !deps.compact && locale !== "zh") {
		logInfo(paint(apiRoutes.length ? `Accounts (${storage.accounts.length + apiRoutes.length}: ${storage.accounts.length} subscription, ${apiRoutes.length} API/ZDR/PSP)` : `Accounts (${storage.accounts.length})`, "heading"));
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
	const runtimeSnapshot = await deps.loadRuntimeObservabilitySnapshot?.() ?? null;
 const quotaPreferences = forecastQuotas.map(quota=>subscriptionQuotaPreference(quota,now));
 const automaticOrder = new Map<number,number>();
 if (appBindStatus?.nativeOpenai) {
  const schedulingStrategy = appBindStatus.schedulingStrategy ?? getSchedulingStrategy(loadPluginConfig());
  let candidates=storage.accounts.map((account,index)=>({account,index,quota:quotaPreferences[index] ?? subscriptionQuotaPreference(null,now),tier:accountPolicies.accounts[getAccountPolicyKey(account,index)]?.priority ?? 1}));
  const useSavedOrder = candidates.some(account => account.tier !== 1);
  candidates = candidates.filter(a=>forecastResults[a.index]?.availability === "ready" && !a.quota.exhausted);
  candidates.sort((a,b)=>{
   const tierOrder = Number(usesSubscriptionReserve(a.quota))-Number(usesSubscriptionReserve(b.quota)) || a.tier-b.tier;
   if (tierOrder) return tierOrder;
   if (schedulingStrategy === "sequential") {
    if (useSavedOrder) return a.index-b.index;
    const count = storage.accounts.length;
    return (a.index-activeIndex+count)%count - (b.index-activeIndex+count)%count;
   }
   return compareSubscriptionQuota(a.quota,b.quota) || Number(b.index===activeIndex)-Number(a.index===activeIndex) || a.index-b.index;
  });
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
  logInfo(""); logInfo(paint(`API/ZDR/PSP accounts (${apiAccounts.length}; separate privacy pools, lower tier first):`, "heading"));
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

	if (!deps.json && deps.compact) {
		const compactRows = storage.accounts.map((account, index) => {
			const markers = buildAccountMarkers(account, index, activeIndex, runtimeCurrent, now, quotaCache, storage.accounts, deps.formatRateLimitEntry);
			const needsLogin = markers.some((marker) => /(re-login|sign-in|invalid)/i.test(marker));
			const disabled = account.enabled === false;
			const state = disabled
				? localized(locale, "disabled", "已禁用")
				: needsLogin
					? localized(locale, "needs login", "需重新登录")
					: markers.length > 0
						? markers
							.map((marker) => marker === "current" ? localized(locale, "current", "当前") : marker === "selected" ? localized(locale, "selected", "已选中") : marker === "in-use" ? localized(locale, "in use", "使用中") : marker)
							.join(", ")
						: localized(locale, "ready", "可用");
			const subscription = subscriptionStatuses[index];
			const plan = subscription?.planLabel === "Unknown plan"
				? localized(locale, "unknown", "未知")
				: subscription?.planLabel ?? localized(locale, "unknown", "未知");
			const quota = forecastQuotas[index];
			const quotaText = quota
				? (["primary", "secondary"] as const)
						.map((key) => {
							const used = quota[key].usedPercent;
							return typeof used === "number" && Number.isFinite(used)
								? formatQuotaCell(key, quota[key], locale)
								: null;
						})
						.filter(Boolean)
						.join(" / ") || "?"
				: "?";
			const last = inferenceTimes[inferenceAccountKey(account)];
			const activity = typeof last === "number" && last > 0 ? formatWaitTime(Math.max(0, now - last)) : "—";
			// Counts derive from the unlocalized marker set, not the rendered
			// label: matching translated text miscounts states like a raw
			// "disabled" marker embedded in a joined reason list.
			const stateKind = disabled
				? "disabled"
				: needsLogin
					? "login"
					: markers.some((marker) =>
							isRateLimitedMarker(marker) ||
							marker === "quota-exhausted" ||
							marker.startsWith("cooldown:"))
						? "blocked"
						: "ready";
			return { index: index + 1, plan, state, stateKind, quota: quotaText, activity };
		});
		const apiRows = apiAccounts.map((account) => ({
			index: `${account.kind}${account.index + 1}`,
			plan: account.label || localized(locale, "API", "API"),
			state: account.enabled
				? localized(locale, "enabled", "已启用")
				: localized(locale, "disabled", "已禁用"),
			enabled: account.enabled,
			quota: "—",
			activity:
				typeof account.lastInferenceRequestAt === "number" && account.lastInferenceRequestAt > 0
					? formatWaitTime(Math.max(0, now - account.lastInferenceRequestAt))
					: "—",
		}));
		const needsLoginCount = compactRows.filter((row) => row.stateKind === "login").length;
		const disabledCount = compactRows.filter((row) => row.stateKind === "disabled").length;
		const blockedCount = compactRows.filter((row) => row.stateKind === "blocked").length;
		const readyCount = compactRows.length - needsLoginCount - disabledCount - blockedCount;
		const route = typeof storage.pinnedAccountIndex === "number"
			? localized(locale, `pinned to account ${storage.pinnedAccountIndex + 1}`, `固定到账号 ${storage.pinnedAccountIndex + 1}`)
			: activeIndex >= 0
				? localized(locale, `automatic (active account ${activeIndex + 1})`, `自动轮换（当前账号 ${activeIndex + 1}）`)
				: localized(locale, "automatic", "自动轮换");
		logInfo(localized(locale, "Codex Multi-Auth status", "Codex Multi-Auth 状态"));
		logInfo(`${localized(locale, "Accounts", "账号")}: ${readyCount} ${localized(locale, "ready", "可用")} / ${needsLoginCount} ${localized(locale, "need login", "需登录")}${blockedCount > 0 ? ` / ${blockedCount} ${localized(locale, "blocked", "受限")}` : ""} / ${disabledCount} ${localized(locale, "disabled", "已禁用")} (${compactRows.length} ${localized(locale, "total", "总计")})`);
		if (apiRows.length > 0) {
			const apiDisabled = apiRows.filter((row) => !row.enabled).length;
			logInfo(`${localized(locale, "API/ZDR/PSP accounts", "API/ZDR/PSP 账号")}: ${apiRows.length - apiDisabled} ${localized(locale, "enabled", "已启用")} / ${apiDisabled} ${localized(locale, "disabled", "已禁用")}`);
		}
		logInfo(`${localized(locale, "Routing", "路由")}: ${route}; ${localized(locale, "recommended", "推荐")} ${recommendation.recommendedIndex === null ? "—" : `#${recommendation.recommendedIndex + 1}`}`);
		if (runtimeSnapshot) {
			const metrics = runtimeSnapshot.runtimeMetrics;
			logInfo(`${localized(locale, "Runtime", "运行时")}: ${runtimeSnapshot.responsesRequests} ${localized(locale, "requests", "请求")}, ${metrics.successfulRequests} ${localized(locale, "ok", "成功")}, ${metrics.failedRequests} ${localized(locale, "failed", "失败")}`);
		}
		logInfo("");
		logInfo(localized(locale, "#  Plan       Quota          State             Last request", "#  套餐       配额            状态              最近请求"));
		for (const row of [...compactRows, ...apiRows]) {
			logInfo(`${row.index}  ${row.plan.padEnd(10)} ${row.quota.padEnd(14)} ${row.state.padEnd(17)} ${row.activity}`);
		}
		if (needsLoginCount > 0) {
			logInfo("");
			logInfo(localized(locale, "Action: codex-multi-auth login --account <index>", "操作：codex-multi-auth login --account <序号>"));
		}
		logInfo(`${localized(locale, "Storage", "存储")}: ${path}`);
		logInfo(localized(locale, "Use --details for the full diagnostic view; --json is stable machine-readable output.", "使用 --details 查看完整诊断；--json 输出稳定的机器可读格式。"));
		return 0;
	}

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
				subscription: subscriptionStatuses[i],
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
				quota: (() => {
					const entry = forecastQuotas[i];
					return entry ? {
						updatedAt: entry.updatedAt,
						primary: entry.primary,
						secondary: entry.secondary,
					} : null;
				})(),
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
					lastWebsocketDisconnect: appBindStatus?.lastWebsocketDisconnect ?? null,
					accounts,
					lastRequestedWorkspace: runtimeSnapshot?.lastRequestedWorkspaceId ? {
						id: runtimeSnapshot.lastRequestedWorkspaceId,
						accountIndex: runtimeSnapshot.lastAccountIndex ?? null,
						requestedAt: runtimeSnapshot.lastAccountUpdatedAt ?? null,
					} : null,
					runtime: runtimeSnapshot ? {
						responsesRequests: runtimeSnapshot.responsesRequests,
						authRefreshRequests: runtimeSnapshot.authRefreshRequests,
						diagnosticProbeRequests: runtimeSnapshot.diagnosticProbeRequests,
						successfulRequests: runtimeSnapshot.runtimeMetrics.successfulRequests,
						failedRequests: runtimeSnapshot.runtimeMetrics.failedRequests,
					} : null,
				},
				null,
				2,
			),
		);
		return 0;
	}

	// The Chinese detailed view is rendered as one localized block so no
	// English diagnostic labels leak through when --locale zh is requested.
	if (locale === "zh") {
		if (apiConfigurationUnavailable) logInfo("警告：API 配置不可用；仍会显示订阅状态。");
		if (disconnectLine) logInfo(translateDisconnectLine(disconnectLine));
		if (deps.loadModelInventory) {
			for (const line of formatModelInventoryZh(modelInventory ?? null)) logInfo(line);
		}
		const totalLabel = apiAccounts.length
			? storage.accounts.length + apiAccounts.length + "："
				+ storage.accounts.length + " 个订阅账号，" + apiAccounts.length + " 个 API/ZDR/PSP 账号"
			: String(storage.accounts.length);
		logInfo("账号（" + totalLabel + "）");
		logInfo("存储：" + path);
		logInfo("预测建议：" + (recommendation.recommendedIndex === null
			? translateReason(recommendation.reason)
			: "账号 " + (recommendation.recommendedIndex + 1) + "（" + translateReason(recommendation.reason) + "）"));
		if (storageHealth) logInfo("存储健康：" + formatStorageHealthZh(storageHealth.state));
		if (runtimeSnapshot) {
			const runtimeMetrics = runtimeSnapshot.runtimeMetrics;
			logInfo("运行时：请求=" + runtimeSnapshot.responsesRequests
				+ "，刷新=" + runtimeSnapshot.authRefreshRequests
				+ "，探测=" + runtimeSnapshot.diagnosticProbeRequests
				+ "，保留模型回退=" + (runtimeSnapshot.lunaReserveFallbacks ?? 0)
				+ "，预算耗尽=" + runtimeMetrics.requestAttemptBudgetExhaustions);
			const lastRuntimeAccount = formatRuntimeLastAccount(runtimeSnapshot);
			if (lastRuntimeAccount) {
				logInfo("最近运行账号：" + translateAccountLabel(lastRuntimeAccount));
				if (typeof runtimeSnapshot.lastAccountUpdatedAt === "number" && runtimeSnapshot.lastAccountUpdatedAt > 0) {
					logInfo("最近运行请求：" + formatWaitTime(Math.max(0, now - runtimeSnapshot.lastAccountUpdatedAt)) + " 前");
				}
			}
			const requestedId = runtimeSnapshot.lastRequestedWorkspaceId;
			if (requestedId) {
				const index = resolveRuntimeCurrentAccount(storage, { runtimeSnapshot }, { now })?.index;
				const workspace = index === undefined ? undefined : storage.accounts[index]?.workspaces?.find((w) => w.id === requestedId);
				logInfo("最近请求工作区：" + (index === undefined ? "" : "账号 " + (index + 1) + " / ")
					+ (workspace?.name?.trim() || "未命名工作区").replace(/Token account/g, "令牌账号") + "（ID:" + requestedId.slice(-6)
					+ "；发送范围，计费套餐未验证）");
			} else {
				logInfo("最近请求工作区：未记录");
			}
			const poolCooldown = typeof runtimeSnapshot.poolExhaustionCooldownUntil === "number" && runtimeSnapshot.poolExhaustionCooldownUntil > now
				? formatWaitTime(runtimeSnapshot.poolExhaustionCooldownUntil - now) : null;
			const serverCooldown = typeof runtimeSnapshot.serverBurstCooldownUntil === "number" && runtimeSnapshot.serverBurstCooldownUntil > now
				? formatWaitTime(runtimeSnapshot.serverBurstCooldownUntil - now) : null;
			if (poolCooldown || serverCooldown) logInfo("冷却：账号池=" + (poolCooldown ?? "无") + "，服务突发=" + (serverCooldown ?? "无"));
			if (runtimeSnapshot.currentRequestId) logInfo("最近请求跟踪 ID：" + runtimeSnapshot.currentRequestId);
		}
		if (runtimeCurrent) logInfo("当前运行账号：账号 " + (runtimeCurrent.index + 1) + "（来源：" + runtimeCurrent.source + "）");
		if (appBindStatus?.nativeOpenai) logInfo("自动顺序来自最近一次检查；请求模型、工作区和实时健康状态可能改变顺序。");
		logInfo("下面的账号/工作区标签表示保存的设置，不代表最近一次路由的工作区。");
		const pinnedAccountIndex = storage.pinnedAccountIndex;
		if (typeof pinnedAccountIndex === "number") {
			if (!Number.isInteger(pinnedAccountIndex) || pinnedAccountIndex < 0 || pinnedAccountIndex >= storage.accounts.length) {
				logInfo("固定账号：索引 " + pinnedAccountIndex + " 无效；请运行 codex-multi-auth unpin");
			} else {
				logInfo("固定账号：账号 " + (pinnedAccountIndex + 1) + "（严格固定，由 switch 设置）");
				if (!appBindStatus?.nativeOpenai && runtimeCurrent && runtimeCurrent.index !== pinnedAccountIndex) {
					logInfo("警告：当前运行账号是 " + (runtimeCurrent.index + 1) + "，但固定账号是 "
						+ (pinnedAccountIndex + 1) + "；下一次请求时代理会采用固定账号。");
				}
			}
		}
		logInfo("");

		for (let i = 0; i < storage.accounts.length; i += 1) {
			const account = storage.accounts[i];
			if (!account) continue;
			const label = translateAccountLabel(formatAccountLabel(account, i));
			const markers = buildAccountMarkers(account, i, activeIndex, runtimeCurrent, now, quotaCache, storage.accounts, deps.formatRateLimitEntry);
			if (storage.pinnedAccountIndex === i) markers.push("strict pin");
			const markerLabel = markers.length > 0 ? " [" + markers.map(translateMarker).join("，") + "]" : "";
			const lastInferenceAt = inferenceTimes[inferenceAccountKey(account)];
			const activity = typeof account.lastUsed === "number" && account.lastUsed > 0
				? "账号活动于 " + formatWaitTime(Math.max(0, now - account.lastUsed)) + " 前"
				: "尚无账号活动记录";
			const lastUsed = typeof lastInferenceAt === "number" && lastInferenceAt > 0
				? "最近推理请求于 " + formatWaitTime(Math.max(0, now - lastInferenceAt)) + " 前"
				: "尚未记录推理请求；" + activity;
			logInfo((i + 1) + ". " + label + markerLabel + " " + lastUsed);
			logInfo("   优先级：" + (accountPolicies.accounts[getAccountPolicyKey(account, i)]?.priority ?? 1));
			const subscription = subscriptionStatuses[i];
			if (subscription) logInfo("   订阅：" + formatLocalizedSubscriptionStatus(subscription));
			if (appBindStatus?.nativeOpenai) {
				const preference = quotaPreferences[i];
				const order = automaticOrder.get(i);
				const reset = preference?.resetAtMs
					? "；限制窗口将在 " + formatWaitTime(Math.max(0, preference.resetAtMs - now)) + " 后重置"
					: "；配额重置时间未知，请运行检查";
				const reserve = usesSubscriptionReserve(preference) ? "；" + SUBSCRIPTION_RESERVE_PERCENT + "% 保留额度（最后使用）" : "";
				const pinnedElsewhere = typeof storage.pinnedAccountIndex === "number" && storage.pinnedAccountIndex !== i;
				const pinnedIndex = storage.pinnedAccountIndex;
				logInfo("   自动顺序：" + (order ? "#" + order : pinnedElsewhere && typeof pinnedIndex === "number" ? "无（账号 " + (pinnedIndex + 1) + " 已固定）" : "不可用") + reset + reserve);
			}
			const quota = forecastQuotas[i];
			if (quota) {
				const quotaLines = formatQuotaSummary(quota, "zh");
				if (quotaLines.length > 0) {
					logInfo("   配额：");
					for (const line of quotaLines) logInfo("     " + line);
					logInfo("     缓存于 " + formatWaitTime(Math.max(0, now - quota.updatedAt)) + " 前");
				} else {
					logInfo("   配额：未知；请运行检查（风险评估仅使用其他信号）");
				}
			} else {
				logInfo("   配额：未知；请运行检查（风险评估仅使用其他信号）");
			}
			const resets = resetSnapshot(account);
			logInfo("   订阅重置额度：" + (resets?.availableCount ?? "未知")
				+ (resets ? "（缓存于 " + formatWaitTime(Math.max(0, now - resets.updatedAt)) + " 前）" : "；请运行检查"));
			const forecast = forecastResults[i];
			if (forecast) logInfo("   预测风险：" + forecast.riskScore + "/100（" + translateRiskLevel(forecast.riskLevel) + "；分数越低越好）");
			const primaryReason = forecastResults[i]?.reasons[0];
			if (primaryReason) logInfo("   原因：" + translateReason(primaryReason));
			if ((account.workspaces?.length ?? 0) > 1) {
				logInfo("   工作区（保存的选择；不是实时路由）：");
				for (const workspaceLine of formatWorkspaceLines(account, "     ", "保存的选择")) {
					logInfo(workspaceLine.replace(/\(disabled\)/g, "（已禁用）").replace(/ id:/g, " ID:").replace(/\(unnamed\)/g, "（未命名）"));
				}
			}
		}
		if (apiAccounts.length > 0) {
			logInfo("");
			logInfo("API/ZDR/PSP 账号（" + apiAccounts.length + " 个；独立隐私池，低优先级数字先用）：");
			for (const account of apiAccounts) {
				const last = account.lastInferenceRequestAt === null
					? "尚未记录推理请求"
					: "最近推理请求于 " + formatWaitTime(Math.max(0, now - account.lastInferenceRequestAt)) + " 前";
				logInfo(account.kind.toUpperCase() + " 账号 " + (account.index + 1) + "：" + account.label
					+ (account.enabled ? "" : "（已禁用）") + " " + last);
				logInfo("   优先级：" + account.priority + "；可见模型：" + account.visibleModelCount + " 个");
			}
		}
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
			`Runtime: responses=${runtimeSnapshot.responsesRequests}, refresh=${runtimeSnapshot.authRefreshRequests}, probes=${runtimeSnapshot.diagnosticProbeRequests}, reserveFallbacks=${runtimeSnapshot.lunaReserveFallbacks ?? 0}, budgetExhaustions=${runtimeMetrics.requestAttemptBudgetExhaustions}`,
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
		const subscription = subscriptionStatuses[i];
		if (subscription) logInfo(`   ${formatSubscriptionStatus(subscription)}`);
  if (appBindStatus?.nativeOpenai) {
   const preference=quotaPreferences[i];
   const order=automaticOrder.get(i);
   const reset=preference?.resetAtMs ? `; limiting window resets in ${formatWaitTime(Math.max(0,preference.resetAtMs-now))}` : "; quota reset unknown; run check";
   const reserve=usesSubscriptionReserve(preference)?`; ${SUBSCRIPTION_RESERVE_PERCENT}% reserve (last resort)`:"";
   const pinnedElsewhere=typeof storage.pinnedAccountIndex==="number" && storage.pinnedAccountIndex!==i;
   logInfo(paint(`   automatic order: ${order ? `#${order}` : pinnedElsewhere ? `none (account ${(storage.pinnedAccountIndex ?? 0)+1} is pinned)` : "unavailable"}${reset}${reserve}`,reserve?"warning":"accent"));
  }
  const quota = forecastQuotas[i];
  if (quota) {
   const windows = (["primary", "secondary"] as const).flatMap(key => {
    const used = quota[key].usedPercent;
    return typeof used === "number" && Number.isFinite(used) ? [paint(formatQuotaWindow(key, quota[key], "en"), used >= 95 ? "danger" : used >= 80 ? "warning" : "success")] : [];
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
