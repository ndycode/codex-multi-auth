import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	REDIRECT_URI,
} from "./auth/auth.js";
import { startLocalOAuthServer } from "./auth/server.js";
import { copyTextToClipboard, openBrowserUrl } from "./auth/browser.js";
import { promptAddAnotherAccount, promptLoginMode, type ExistingAccountInfo } from "./cli.js";
import {
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	formatCooldown,
	formatWaitTime,
	getAccountIdCandidates,
	resolveRequestAccountId,
	sanitizeEmail,
	selectBestAccountCandidate,
} from "./accounts.js";
import { ACCOUNT_LIMITS } from "./constants.js";
import {
	loadDashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	type DashboardDisplaySettings,
	type DashboardAccountSortMode,
} from "./dashboard-settings.js";
import {
	evaluateForecastAccounts,
	isHardRefreshFailure,
	recommendForecastAccount,
	summarizeForecast,
	type ForecastAccountResult,
} from "./forecast.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import {
	fetchCodexQuotaSnapshot,
	formatQuotaSnapshotLine,
	type CodexQuotaSnapshot,
} from "./quota-probe.js";
import { queuedRefresh } from "./refresh-queue.js";
import {
	loadQuotaCache,
	saveQuotaCache,
	type QuotaCacheData,
	type QuotaCacheEntry,
} from "./quota-cache.js";
import {
	clearAccounts,
	findMatchingAccountIndex,
	getStoragePath,
	loadFlaggedAccounts,
	loadAccounts,
	saveFlaggedAccounts,
	saveAccounts,
	setStoragePath,
	withAccountStorageTransaction,
	type AccountMetadataV3,
	type AccountStorageV3,
	type FlaggedAccountMetadataV1,
} from "./storage.js";
import type { AccountIdSource, TokenFailure, TokenResult } from "./types.js";
import {
	getCodexCliAuthPath,
	getCodexCliConfigPath,
	loadCodexCliState,
} from "./codex-cli/state.js";
import { setCodexCliActiveSelection } from "./codex-cli/writer.js";
import { ANSI } from "./ui/ansi.js";
import { UI_COPY } from "./ui/copy.js";
import { paintUiText, quotaToneFromLeftPercent } from "./ui/format.js";
import { getUiRuntimeOptions } from "./ui/runtime.js";
import { select, type MenuItem } from "./ui/select.js";
import { applyUiThemeFromDashboardSettings, configureUnifiedSettings, resolveMenuLayoutMode } from "./codex-manager/settings-hub.js";

type TokenSuccess = Extract<TokenResult, { type: "success" }>;
type TokenSuccessWithAccount = TokenSuccess & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
};
type PromptTone = "accent" | "success" | "warning" | "danger" | "muted";

function stylePromptText(text: string, tone: PromptTone): string {
	if (!output.isTTY) return text;
	const ui = getUiRuntimeOptions();
	if (ui.v2Enabled) {
		if (tone === "muted") {
			return `${ui.theme.colors.dim}${paintUiText(ui, text, "muted")}${ui.theme.colors.reset}`;
		}
		const mapped = tone === "accent" ? "primary" : tone;
		return paintUiText(ui, text, mapped);
	}
	const legacyCode = tone === "accent"
		? ANSI.green
		: tone === "success"
			? ANSI.green
			: tone === "warning"
				? ANSI.yellow
				: tone === "danger"
					? ANSI.red
					: ANSI.dim;
	return `${legacyCode}${text}${ANSI.reset}`;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function formatReasonLabel(reason: string | undefined): string | undefined {
	if (!reason) return undefined;
	const normalized = collapseWhitespace(reason.replace(/_/g, " "));
	return normalized.length > 0 ? normalized : undefined;
}

function extractErrorMessageFromPayload(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;

	const directMessage = typeof record.message === "string"
		? collapseWhitespace(record.message)
		: "";
	const directCode = typeof record.code === "string"
		? collapseWhitespace(record.code)
		: "";
	if (directMessage) {
		if (directCode && !directMessage.toLowerCase().includes(directCode.toLowerCase())) {
			return `${directMessage} [${directCode}]`;
		}
		return directMessage;
	}

	const nested = record.error;
	if (nested && typeof nested === "object") {
		return extractErrorMessageFromPayload(nested);
	}
	return undefined;
}

function parseStructuredErrorMessage(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const candidates = new Set<string>([trimmed]);
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		candidates.add(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const message = extractErrorMessageFromPayload(parsed);
			if (message) return message;
		} catch {
			// ignore non-JSON candidates
		}
	}
	return undefined;
}

function normalizeFailureDetail(
	message: string | undefined,
	reason: string | undefined,
): string {
	const reasonLabel = formatReasonLabel(reason);
	const raw = message?.trim() || reasonLabel || "refresh failed";
	const structured = parseStructuredErrorMessage(raw);
	const normalized = collapseWhitespace(structured ?? raw);
	const bounded = normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
	return bounded.length > 0 ? bounded : "refresh failed";
}

function joinStyledSegments(parts: string[]): string {
	if (parts.length === 0) return "";
	const separator = stylePromptText(" | ", "muted");
	return parts.join(separator);
}

function formatResultSummary(
	segments: ReadonlyArray<{ text: string; tone: PromptTone }>,
): string {
	const rendered = segments.map((segment) => stylePromptText(segment.text, segment.tone));
	return `${stylePromptText("Result:", "accent")} ${joinStyledSegments(rendered)}`;
}

function styleQuotaSummary(summary: string): string {
	const normalized = collapseWhitespace(summary);
	if (!normalized) return stylePromptText(summary, "muted");
	const segments = normalized.split("|").map((segment) => segment.trim()).filter(Boolean);
	if (segments.length === 0) return stylePromptText(normalized, "muted");

	const rendered = segments.map((segment) => {
		if (/rate-limited/i.test(segment)) {
			return stylePromptText(segment, "danger");
		}
		const match = segment.match(/^([0-9a-zA-Z]+)\s+(\d{1,3})%$/);
		if (!match) {
			return stylePromptText(segment, "muted");
		}
		const windowLabel = match[1] ?? "";
		const leftPercent = Number.parseInt(match[2] ?? "", 10);
		if (!Number.isFinite(leftPercent)) {
			return stylePromptText(segment, "muted");
		}
		const tone = quotaToneFromLeftPercent(leftPercent);
		return `${stylePromptText(windowLabel, "muted")} ${stylePromptText(`${leftPercent}%`, tone)}`;
	});

	return joinStyledSegments(rendered);
}

function styleAccountDetailText(detail: string, fallbackTone: PromptTone = "muted"): string {
	const compact = collapseWhitespace(detail);
	if (!compact) return stylePromptText("", fallbackTone);

	const quotaMatch = compact.match(/^(.*?)\(([^()]*\d{1,3}%[^()]*)\)(.*)$/);
	if (quotaMatch) {
		const prefix = (quotaMatch[1] ?? "").trim();
		const quota = (quotaMatch[2] ?? "").trim();
		const suffix = (quotaMatch[3] ?? "").trim();

		const prefixTone: PromptTone = /failed|error/i.test(prefix)
			? "danger"
			: /ok|working|succeeded|valid/i.test(prefix)
				? "success"
				: fallbackTone;
		const suffixTone: PromptTone = /re-login|stale|warning|retry|fallback/i.test(suffix)
			? "warning"
			: /failed|error/i.test(suffix)
				? "danger"
				: "muted";

		const chunks: string[] = [];
		if (prefix) chunks.push(stylePromptText(prefix, prefixTone));
		chunks.push(`(${styleQuotaSummary(quota)})`);
		if (suffix) chunks.push(stylePromptText(suffix, suffixTone));
		return chunks.join(" ");
	}

	if (/rate-limited/i.test(compact)) return stylePromptText(compact, "danger");
	if (/re-login|stale|warning|fallback/i.test(compact)) return stylePromptText(compact, "warning");
	if (/failed|error/i.test(compact)) return stylePromptText(compact, "danger");
	if (/ok|working|succeeded|valid/i.test(compact)) return stylePromptText(compact, "success");
	return stylePromptText(compact, fallbackTone);
}

function riskTone(level: ForecastAccountResult["riskLevel"]): "success" | "warning" | "danger" {
	if (level === "low") return "success";
	if (level === "medium") return "warning";
	return "danger";
}

function availabilityTone(
	availability: ForecastAccountResult["availability"],
): "success" | "warning" | "danger" {
	if (availability === "ready") return "success";
	if (availability === "delayed") return "warning";
	return "danger";
}

function formatQuotaSnapshotForDashboard(
	snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
	settings: DashboardDisplaySettings,
): string {
	if (!settings.showQuotaDetails) return "live session OK";
	return `live session OK (${formatCompactQuotaSnapshot(snapshot)})`;
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const maybe = error as Error & { code?: string };
	return maybe.name === "AbortError" || maybe.code === "ABORT_ERR";
}

function isUserCancelledOAuth(result: TokenResult): boolean {
	if (result.type !== "failed") return false;
	const message = (result.message ?? "").toLowerCase();
	return message.includes("cancelled");
}

function printUsage(): void {
	console.log(
		[
			"Codex Multi-Auth CLI",
			"",
			"Usage:",
			"  codex auth login",
			"  codex auth list",
			"  codex auth status",
			"  codex auth switch <index>",
			"  codex auth check",
			"  codex auth features",
			"  codex auth verify-flagged [--dry-run] [--json] [--no-restore]",
			"  codex auth forecast [--live] [--json] [--model <model>]",
			"  codex auth report [--live] [--json] [--model <model>] [--out <path>]",
			"  codex auth fix [--dry-run] [--json] [--live] [--model <model>]",
			"  codex auth doctor [--json] [--fix] [--dry-run]",
			"",
			"Notes:",
			"  - Uses ~/.codex/multi-auth/openai-codex-accounts.json",
			"  - Syncs active account into Codex CLI auth state",
		].join("\n"),
	);
}

interface ImplementedFeature {
	id: number;
	name: string;
}

const IMPLEMENTED_FEATURES: ImplementedFeature[] = [
	{ id: 1, name: "Multi-account OAuth login dashboard" },
	{ id: 2, name: "Account add/update dedupe by token/id/email" },
	{ id: 3, name: "Set current account command" },
	{ id: 4, name: "Per-family active index handling" },
	{ id: 5, name: "Quick health check command" },
	{ id: 6, name: "Full refresh check command" },
	{ id: 7, name: "Flagged account verification command" },
	{ id: 8, name: "Flagged account restore flow" },
	{ id: 9, name: "Best account forecast engine" },
	{ id: 10, name: "Forecast live quota probing" },
	{ id: 11, name: "Auto-fix command (safe mode)" },
	{ id: 12, name: "Doctor diagnostics command" },
	{ id: 13, name: "JSON outputs for machine automation" },
	{ id: 14, name: "Report generation command" },
	{ id: 15, name: "Storage v3 normalization and migration" },
	{ id: 16, name: "Storage backup and recovery journal" },
	{ id: 17, name: "Project-scoped and global storage paths" },
	{ id: 18, name: "Quota cache storage" },
	{ id: 19, name: "Live account sync watcher" },
	{ id: 20, name: "Session affinity store" },
	{ id: 21, name: "Refresh queue dedupe (in-process)" },
	{ id: 22, name: "Refresh lease dedupe (cross-process)" },
	{ id: 23, name: "Token rotation mapping in refresh queue" },
	{ id: 24, name: "Refresh guardian (proactive refresh)" },
	{ id: 25, name: "Preemptive quota scheduler" },
	{ id: 26, name: "Entitlement cache for unsupported models" },
	{ id: 27, name: "Capability policy scoring store" },
	{ id: 28, name: "Failure policy evaluation module" },
	{ id: 29, name: "Streaming failover pipeline" },
	{ id: 30, name: "Rate-limit backoff and cooldown handling" },
	{ id: 31, name: "Host request transformer bridge" },
	{ id: 32, name: "Prompt template sync with cache" },
	{ id: 33, name: "Codex CLI active-account state sync" },
	{ id: 34, name: "TUI quick-switch hotkeys (1-9)" },
	{ id: 35, name: "TUI search and help toggles" },
	{ id: 36, name: "TUI account detail hotkeys (S/R/E/D)" },
	{ id: 37, name: "TUI settings hub (list/summary/behavior/theme)" },
	{ id: 38, name: "Dashboard display customization" },
	{ id: 39, name: "Unified color/theme runtime (v2 UI)" },
	{ id: 40, name: "OAuth browser-first flow with manual callback fallback" },
];

function runFeaturesReport(): number {
	console.log(`Implemented features (${IMPLEMENTED_FEATURES.length})`);
	console.log("");
	for (const feature of IMPLEMENTED_FEATURES) {
		console.log(`${feature.id}. ${feature.name}`);
	}
	return 0;
}

function resolveActiveIndex(
	storage: AccountStorageV3,
	family: ModelFamily = "codex",
): number {
	const total = storage.accounts.length;
	if (total === 0) return 0;
	const rawCandidate = storage.activeIndexByFamily?.[family] ?? storage.activeIndex;
	const raw = Number.isFinite(rawCandidate) ? rawCandidate : 0;
	return Math.max(0, Math.min(raw, total - 1));
}

function getRateLimitResetTimeForFamily(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily,
): number | null {
	const times = account.rateLimitResetTimes;
	if (!times) return null;

	let minReset: number | null = null;
	const prefix = `${family}:`;
	for (const [key, value] of Object.entries(times)) {
		if (typeof value !== "number") continue;
		if (value <= now) continue;
		if (key !== family && !key.startsWith(prefix)) continue;
		if (minReset === null || value < minReset) {
			minReset = value;
		}
	}

	return minReset;
}

function formatRateLimitEntry(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily = "codex",
): string | null {
	const resetAt = getRateLimitResetTimeForFamily(account, now, family);
	if (typeof resetAt !== "number") return null;
	const remaining = resetAt - now;
	if (remaining <= 0) return null;
	return `resets in ${formatWaitTime(remaining)}`;
}

function normalizeQuotaEmail(email: string | undefined): string | null {
	const normalized = sanitizeEmail(email);
	return normalized && normalized.length > 0 ? normalized : null;
}

function quotaCacheEntryToSnapshot(entry: QuotaCacheEntry): CodexQuotaSnapshot {
	return {
		status: entry.status,
		planType: entry.planType,
		model: entry.model,
		primary: {
			usedPercent: entry.primary.usedPercent,
			windowMinutes: entry.primary.windowMinutes,
			resetAtMs: entry.primary.resetAtMs,
		},
		secondary: {
			usedPercent: entry.secondary.usedPercent,
			windowMinutes: entry.secondary.windowMinutes,
			resetAtMs: entry.secondary.resetAtMs,
		},
	};
}

function formatCompactQuotaWindowLabel(windowMinutes: number | undefined): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

function formatCompactQuotaPart(windowMinutes: number | undefined, usedPercent: number | undefined): string | null {
	const label = formatCompactQuotaWindowLabel(windowMinutes);
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return null;
	}
	const left = quotaLeftPercentFromUsed(usedPercent);
	return `${label} ${left}%`;
}

function quotaLeftPercentFromUsed(usedPercent: number | undefined): number | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return undefined;
	}
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function formatCompactQuotaSnapshot(snapshot: CodexQuotaSnapshot): string {
	const parts = [
		formatCompactQuotaPart(snapshot.primary.windowMinutes, snapshot.primary.usedPercent),
		formatCompactQuotaPart(snapshot.secondary.windowMinutes, snapshot.secondary.usedPercent),
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	if (snapshot.status === 429) {
		parts.push("rate-limited");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(snapshot);
}

function formatAccountQuotaSummary(entry: QuotaCacheEntry): string {
	const parts = [
		formatCompactQuotaPart(entry.primary.windowMinutes, entry.primary.usedPercent),
		formatCompactQuotaPart(entry.secondary.windowMinutes, entry.secondary.usedPercent),
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	if (entry.status === 429) {
		parts.push("rate-limited");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(quotaCacheEntryToSnapshot(entry));
}

function getQuotaCacheEntryForAccount(
	cache: QuotaCacheData,
	account: Pick<AccountMetadataV3, "accountId" | "email">,
): QuotaCacheEntry | null {
	if (account.accountId && cache.byAccountId[account.accountId]) {
		return cache.byAccountId[account.accountId] ?? null;
	}
	const email = normalizeQuotaEmail(account.email);
	if (email && cache.byEmail[email]) {
		return cache.byEmail[email] ?? null;
	}
	return null;
}

function updateQuotaCacheForAccount(
	cache: QuotaCacheData,
	account: Pick<AccountMetadataV3, "accountId" | "email">,
	snapshot: CodexQuotaSnapshot,
): boolean {
	const nextEntry: QuotaCacheEntry = {
		updatedAt: Date.now(),
		status: snapshot.status,
		model: snapshot.model,
		planType: snapshot.planType,
		primary: {
			usedPercent: snapshot.primary.usedPercent,
			windowMinutes: snapshot.primary.windowMinutes,
			resetAtMs: snapshot.primary.resetAtMs,
		},
		secondary: {
			usedPercent: snapshot.secondary.usedPercent,
			windowMinutes: snapshot.secondary.windowMinutes,
			resetAtMs: snapshot.secondary.resetAtMs,
		},
	};

	let changed = false;
	if (account.accountId) {
		cache.byAccountId[account.accountId] = nextEntry;
		changed = true;
	}
	const email = normalizeQuotaEmail(account.email);
	if (email) {
		cache.byEmail[email] = nextEntry;
		changed = true;
	}
	return changed;
}

const DEFAULT_MENU_QUOTA_REFRESH_TTL_MS = 5 * 60_000;
const MENU_QUOTA_REFRESH_MODEL = "gpt-5-codex";

interface MenuQuotaProbeTarget {
	account: AccountMetadataV3;
	accountId: string;
	accessToken: string;
}

function resolveMenuQuotaProbeInput(
	account: AccountMetadataV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	now: number,
): { accountId: string; accessToken: string } | null {
	if (account.enabled === false) return null;
	if (!hasUsableAccessToken(account, now)) return null;

	const existing = getQuotaCacheEntryForAccount(cache, account);
	if (
		existing &&
		typeof existing.updatedAt === "number" &&
		Number.isFinite(existing.updatedAt) &&
		now - existing.updatedAt < maxAgeMs
	) {
		return null;
	}

	const accessToken = account.accessToken;
	const accountId = accessToken
		? (account.accountId ?? extractAccountId(accessToken))
		: account.accountId;
	if (!accountId || !accessToken) return null;
	return { accountId, accessToken };
}

function collectMenuQuotaRefreshTargets(
	storage: AccountStorageV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	now = Date.now(),
): MenuQuotaProbeTarget[] {
	const targets: MenuQuotaProbeTarget[] = [];
	for (const account of storage.accounts) {
		const probeInput = resolveMenuQuotaProbeInput(account, cache, maxAgeMs, now);
		if (!probeInput) continue;
		targets.push({
			account,
			accountId: probeInput.accountId,
			accessToken: probeInput.accessToken,
		});
	}
	return targets;
}

function countMenuQuotaRefreshTargets(
	storage: AccountStorageV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	now = Date.now(),
): number {
	let count = 0;
	for (const account of storage.accounts) {
		if (resolveMenuQuotaProbeInput(account, cache, maxAgeMs, now)) {
			count += 1;
		}
	}
	return count;
}

async function refreshQuotaCacheForMenu(
	storage: AccountStorageV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	onProgress?: (current: number, total: number) => void,
): Promise<QuotaCacheData> {
	if (storage.accounts.length === 0) {
		return cache;
	}

	const now = Date.now();
	const targets = collectMenuQuotaRefreshTargets(storage, cache, maxAgeMs, now);
	const total = targets.length;
	let processed = 0;
	onProgress?.(processed, total);
	let changed = false;
	for (const target of targets) {
		processed += 1;
		onProgress?.(processed, total);

		try {
			const snapshot = await fetchCodexQuotaSnapshot({
				accountId: target.accountId,
				accessToken: target.accessToken,
				model: MENU_QUOTA_REFRESH_MODEL,
			});
			changed = updateQuotaCacheForAccount(cache, target.account, snapshot) || changed;
		} catch {
			// Keep existing cached values if probing fails.
		}
	}

	if (changed) {
		await saveQuotaCache(cache);
	}

	return cache;
}

const ACCESS_TOKEN_FRESH_WINDOW_MS = 5 * 60 * 1000;

function hasUsableAccessToken(
	account: Pick<AccountMetadataV3, "accessToken" | "expiresAt">,
	now: number,
): boolean {
	if (!account.accessToken) return false;
	if (typeof account.expiresAt !== "number" || !Number.isFinite(account.expiresAt)) return false;
	return account.expiresAt - now > ACCESS_TOKEN_FRESH_WINDOW_MS;
}

function hasLikelyInvalidRefreshToken(refreshToken: string | undefined): boolean {
	if (!refreshToken) return true;
	const trimmed = refreshToken.trim();
	if (trimmed.length < 20) return true;
	return trimmed.startsWith("token-");
}

function mapAccountStatus(
	account: AccountMetadataV3,
	index: number,
	activeIndex: number,
	now: number,
): ExistingAccountInfo["status"] {
	if (account.enabled === false) return "disabled";
	if (typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now) {
		return "cooldown";
	}
	const rateLimit = formatRateLimitEntry(account, now, "codex");
	if (rateLimit) return "rate-limited";
	if (index === activeIndex) return "active";
	return "ok";
}

function parseLeftPercentFromQuotaSummary(
	summary: string | undefined,
	windowLabel: "5h" | "7d",
): number {
	if (!summary) return -1;
	const match = summary.match(new RegExp(`(?:^|\\|)\\s*${windowLabel}\\s+(\\d{1,3})%`, "i"));
	const value = Number.parseInt(match?.[1] ?? "", 10);
	if (!Number.isFinite(value)) return -1;
	return Math.max(0, Math.min(100, value));
}

function readQuotaLeftPercent(
	account: ExistingAccountInfo,
	windowLabel: "5h" | "7d",
): number {
	const direct = windowLabel === "5h" ? account.quota5hLeftPercent : account.quota7dLeftPercent;
	if (typeof direct === "number" && Number.isFinite(direct)) {
		return Math.max(0, Math.min(100, Math.round(direct)));
	}
	return parseLeftPercentFromQuotaSummary(account.quotaSummary, windowLabel);
}

function accountStatusSortBucket(status: ExistingAccountInfo["status"]): number {
	switch (status) {
		case "active":
		case "ok":
			return 0;
		case "unknown":
			return 1;
		case "cooldown":
		case "rate-limited":
			return 2;
		case "disabled":
		case "error":
		case "flagged":
			return 3;
		default:
			return 1;
	}
}

function compareReadyFirstAccounts(
	left: ExistingAccountInfo,
	right: ExistingAccountInfo,
): number {
	const left5h = readQuotaLeftPercent(left, "5h");
	const right5h = readQuotaLeftPercent(right, "5h");
	if (left5h !== right5h) return right5h - left5h;

	const left7d = readQuotaLeftPercent(left, "7d");
	const right7d = readQuotaLeftPercent(right, "7d");
	if (left7d !== right7d) return right7d - left7d;

	const bucketDelta = accountStatusSortBucket(left.status) - accountStatusSortBucket(right.status);
	if (bucketDelta !== 0) return bucketDelta;

	const leftLastUsed = left.lastUsed ?? 0;
	const rightLastUsed = right.lastUsed ?? 0;
	if (leftLastUsed !== rightLastUsed) return rightLastUsed - leftLastUsed;

	const leftSource = left.sourceIndex ?? left.index;
	const rightSource = right.sourceIndex ?? right.index;
	return leftSource - rightSource;
}

function applyAccountMenuOrdering(
	accounts: ExistingAccountInfo[],
	displaySettings: DashboardDisplaySettings,
): ExistingAccountInfo[] {
	const sortEnabled =
		displaySettings.menuSortEnabled ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? true);
	const sortMode: DashboardAccountSortMode =
		displaySettings.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first");
	if (!sortEnabled || sortMode !== "ready-first") {
		return [...accounts];
	}

	const sorted = [...accounts].sort(compareReadyFirstAccounts);
	const pinCurrent = displaySettings.menuSortPinCurrent ??
		(DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ?? false);
	if (pinCurrent) {
		const currentIndex = sorted.findIndex((account) => account.isCurrentAccount);
		if (currentIndex > 0) {
			const current = sorted.splice(currentIndex, 1)[0];
			const first = sorted[0];
			if (current && first && compareReadyFirstAccounts(current, first) <= 0) {
				sorted.unshift(current);
			} else if (current) {
				sorted.splice(currentIndex, 0, current);
			}
		}
	}
	return sorted;
}

function toExistingAccountInfo(
	storage: AccountStorageV3,
	quotaCache: QuotaCacheData | null,
	displaySettings: DashboardDisplaySettings,
): ExistingAccountInfo[] {
	const now = Date.now();
	const activeIndex = resolveActiveIndex(storage, "codex");
	const layoutMode = resolveMenuLayoutMode(displaySettings);
	const baseAccounts = storage.accounts.map((account, index) => {
		const entry = quotaCache ? getQuotaCacheEntryForAccount(quotaCache, account) : null;
		return {
			index,
			sourceIndex: index,
			accountId: account.accountId,
			accountLabel: account.accountLabel,
			email: account.email,
			addedAt: account.addedAt,
			lastUsed: account.lastUsed,
			status: mapAccountStatus(account, index, activeIndex, now),
			quotaSummary: (displaySettings.menuShowQuotaSummary ?? true) && entry
				? formatAccountQuotaSummary(entry)
				: undefined,
			quota5hLeftPercent: quotaLeftPercentFromUsed(entry?.primary.usedPercent),
			quota5hResetAtMs: entry?.primary.resetAtMs,
			quota7dLeftPercent: quotaLeftPercentFromUsed(entry?.secondary.usedPercent),
			quota7dResetAtMs: entry?.secondary.resetAtMs,
			quotaRateLimited: entry?.status === 429,
			isCurrentAccount: index === activeIndex,
			enabled: account.enabled !== false,
			showStatusBadge: displaySettings.menuShowStatusBadge ?? true,
			showCurrentBadge: displaySettings.menuShowCurrentBadge ?? true,
			showLastUsed: displaySettings.menuShowLastUsed ?? true,
			showQuotaCooldown: displaySettings.menuShowQuotaCooldown ?? true,
			showHintsForUnselectedRows: layoutMode === "expanded-rows",
			highlightCurrentRow: displaySettings.menuHighlightCurrentRow ?? true,
			focusStyle: displaySettings.menuFocusStyle ?? "row-invert",
			statuslineFields: displaySettings.menuStatuslineFields ?? ["last-used", "limits", "status"],
		};
	});
	const orderedAccounts = applyAccountMenuOrdering(baseAccounts, displaySettings);
	const quickSwitchUsesVisibleRows = displaySettings.menuSortQuickSwitchVisibleRow ?? true;
	return orderedAccounts.map((account, displayIndex) => ({
		...account,
		index: displayIndex,
		quickSwitchNumber: quickSwitchUsesVisibleRows
			? displayIndex + 1
			: (account.sourceIndex ?? displayIndex) + 1,
	}));
}

function resolveAccountSelection(tokens: TokenSuccess): TokenSuccessWithAccount {
	const override = (process.env.CODEX_AUTH_ACCOUNT_ID ?? "").trim();
	if (override) {
		return {
			...tokens,
			accountIdOverride: override,
			accountIdSource: "manual",
		};
	}

	const candidates = getAccountIdCandidates(tokens.access, tokens.idToken);
	if (candidates.length === 0) {
		return tokens;
	}

	if (candidates.length === 1) {
		const [candidate] = candidates;
		if (candidate) {
			return {
				...tokens,
				accountIdOverride: candidate.accountId,
				accountIdSource: candidate.source,
				accountLabel: candidate.label,
			};
		}
	}

	const best = selectBestAccountCandidate(candidates);
	if (!best) {
		return tokens;
	}

	return {
		...tokens,
		accountIdOverride: best.accountId,
		accountIdSource: best.source ?? "token",
		accountLabel: best.label,
	};
}

async function promptManualCallback(state: string): Promise<string | null> {
	if (!input.isTTY || !output.isTTY) {
		return null;
	}

	const rl = createInterface({ input, output });
	try {
		console.log("");
		console.log(stylePromptText(UI_COPY.oauth.pastePrompt, "accent"));
		const answer = await rl.question("◆  ");
		if (answer.includes("\u001b")) {
			return null;
		}
		const normalized = answer.trim().toLowerCase();
		if (
			normalized.length === 0 ||
			normalized === "q" ||
			normalized === "quit" ||
			normalized === "cancel" ||
			normalized === "back"
		) {
			return null;
		}
		const parsed = parseAuthorizationInput(answer);
		if (!parsed.code) return null;
		if (parsed.state && parsed.state !== state) return null;
		return parsed.code;
	} catch (error) {
		if (isAbortError(error)) {
			return null;
		}
		throw error;
	} finally {
		rl.close();
	}
}

type OAuthSignInMode = "browser" | "manual" | "cancel";

async function promptOAuthSignInMode(): Promise<OAuthSignInMode> {
	if (!input.isTTY || !output.isTTY) {
		return "browser";
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<OAuthSignInMode>[] = [
		{ label: UI_COPY.oauth.openBrowser, value: "browser", color: "green" },
		{ label: UI_COPY.oauth.manualMode, value: "manual", color: "yellow" },
		{ label: UI_COPY.oauth.back, value: "cancel", color: "red" },
	];

	const selected = await select<OAuthSignInMode>(items, {
		message: UI_COPY.oauth.chooseModeTitle,
		subtitle: UI_COPY.oauth.chooseModeSubtitle,
		help: UI_COPY.oauth.chooseModeHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return "cancel";
			if (lower === "1") return "browser";
			if (lower === "2") return "manual";
			return undefined;
		},
	});

	return selected ?? "cancel";
}

interface WaitForReturnOptions {
	promptText?: string;
	autoReturnMs?: number;
	pauseOnAnyKey?: boolean;
}

async function waitForMenuReturn(options: WaitForReturnOptions = {}): Promise<void> {
	if (!input.isTTY || !output.isTTY) {
		return;
	}

	const promptText = options.promptText ?? UI_COPY.returnFlow.continuePrompt;
	const autoReturnMs = options.autoReturnMs ?? 0;
	const pauseOnAnyKey = options.pauseOnAnyKey ?? true;

	try {
		let chunk: Buffer | string | null;
		do {
			chunk = input.read();
		} while (chunk !== null);
	} catch {
		// best effort buffer drain
	}

	const writeInlineStatus = (message: string): void => {
		output.write(`\r${ANSI.clearLine}${stylePromptText(message, "muted")}`);
	};

	const clearInlineStatus = (): void => {
		output.write(`\r${ANSI.clearLine}`);
	};

	if (autoReturnMs > 0) {
		if (!pauseOnAnyKey) {
			await new Promise<void>((resolve) => setTimeout(resolve, autoReturnMs));
			return;
		}
		const wasRaw = input.isRaw ?? false;
		const endAt = Date.now() + autoReturnMs;
		let lastShownSeconds: number | null = null;
		const renderCountdown = () => {
			const remainingMs = Math.max(0, endAt - Date.now());
			const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
			if (lastShownSeconds === remainingSeconds) return;
			lastShownSeconds = remainingSeconds;
			writeInlineStatus(
				UI_COPY.returnFlow.autoReturn(remainingSeconds),
			);
		};
		renderCountdown();
		const pinned = await new Promise<boolean>((resolve) => {
			let done = false;
			const interval = setInterval(renderCountdown, 80);
			let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
				timeout = null;
				if (!done) {
					done = true;
					cleanup();
					resolve(false);
				}
			}, autoReturnMs);
			const onData = () => {
				if (done) return;
				done = true;
				cleanup();
				resolve(true);
			};
			const cleanup = () => {
				clearInterval(interval);
				if (timeout) {
					clearTimeout(timeout);
					timeout = null;
				}
				input.removeListener("data", onData);
				try {
					input.setRawMode(wasRaw);
				} catch {
					// best effort restore
				}
			};
			try {
				input.setRawMode(true);
			} catch {
				// if raw mode fails, keep countdown behavior
			}
			input.on("data", onData);
			input.resume();
		});
		clearInlineStatus();
		if (!pinned) {
			return;
		}
		const paused = stylePromptText(UI_COPY.returnFlow.paused, "muted");
		writeInlineStatus(paused);
		await new Promise<void>((resolve) => {
			const wasRaw = input.isRaw ?? false;
			const onData = () => {
				cleanup();
				resolve();
			};
			const cleanup = () => {
				input.removeListener("data", onData);
				try {
					input.setRawMode(wasRaw);
				} catch {
					// best effort restore
				}
			};
			try {
				input.setRawMode(true);
			} catch {
				// best effort fallback
			}
			input.on("data", onData);
			input.resume();
		});
		clearInlineStatus();
		return;
	}

	const rl = createInterface({ input, output });
	try {
		const question = promptText.length > 0 ? `${stylePromptText(promptText, "muted")} ` : "";
		output.write(`\r${ANSI.clearLine}`);
		await rl.question(question);
	} catch (error) {
		if (!isAbortError(error)) {
			throw error;
		}
	} finally {
		rl.close();
		clearInlineStatus();
	}
}

function stringifyLogArgs(args: unknown[]): string {
	return args
		.map((value) => {
			if (typeof value === "string") return value;
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		})
		.join(" ");
}

async function runActionPanel(
	title: string,
	stage: string,
	action: () => Promise<void> | void,
	settings?: DashboardDisplaySettings,
): Promise<void> {
	if (!input.isTTY || !output.isTTY) {
		await action();
		return;
	}

	const spinnerFrames = ["-", "\\", "|", "/"];
	let frame = 0;
	let running = true;
	let failed: unknown = null;
	const captured: string[] = [];
	const maxVisibleLines = Math.max(8, (output.rows ?? 24) - 8);
	const previousLog = console.log;
	const previousWarn = console.warn;
	const previousError = console.error;

	const capture = (prefix: string, args: unknown[]): void => {
		const line = stringifyLogArgs(args).trim();
		if (!line) return;
		captured.push(prefix ? `${prefix}${line}` : line);
		if (captured.length > 400) {
			captured.splice(0, captured.length - 400);
		}
	};

	const render = () => {
		output.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		const spinner = running
			? `${spinnerFrames[frame % spinnerFrames.length] ?? "-"} `
			: failed
				? "x "
				: "+ ";
		const stageText = running
			? `${spinner}${stage}`
			: failed
				? UI_COPY.returnFlow.failed
				: UI_COPY.returnFlow.done;
		previousLog(stylePromptText(title, "accent"));
		previousLog(stylePromptText(stageText, failed ? "danger" : running ? "accent" : "success"));
		previousLog("");

		const lines = captured.slice(-maxVisibleLines);
		for (const line of lines) {
			previousLog(line);
		}

		const remainingLines = Math.max(0, maxVisibleLines - lines.length);
		for (let i = 0; i < remainingLines; i += 1) {
			previousLog("");
		}
		previousLog("");
		if (running) previousLog(stylePromptText(UI_COPY.returnFlow.working, "muted"));
		frame += 1;
	};

	console.log = (...args: unknown[]) => {
		capture("", args);
	};
	console.warn = (...args: unknown[]) => {
		capture("! ", args);
	};
	console.error = (...args: unknown[]) => {
		capture("x ", args);
	};

	output.write(ANSI.altScreenOn + ANSI.hide);
	let timer: ReturnType<typeof setInterval> | null = null;
	try {
		render();
		timer = setInterval(() => {
			if (!running) return;
			render();
		}, 120);

		await action();
	} catch (error) {
		failed = error;
		capture("x ", [error instanceof Error ? error.message : String(error)]);
	} finally {
		running = false;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		render();
		console.log = previousLog;
		console.warn = previousWarn;
		console.error = previousError;
	}

	if (failed) {
		await waitForMenuReturn({
			promptText: UI_COPY.returnFlow.actionFailedPrompt,
		});
	} else {
		await waitForMenuReturn({
			autoReturnMs: settings?.actionAutoReturnMs ?? 2_000,
			pauseOnAnyKey: settings?.actionPauseOnKey ?? true,
		});
	}
	output.write(ANSI.altScreenOff + ANSI.show + ANSI.clearScreen + ANSI.moveTo(1, 1));
	if (failed) {
		throw failed;
	}
}

async function runOAuthFlow(forceNewLogin: boolean): Promise<TokenResult> {
	const { pkce, state, url } = await createAuthorizationFlow({ forceNewLogin });
	const oauthServer = await startLocalOAuthServer({ state });
	let code: string | null = null;
	try {
		const signInMode = await promptOAuthSignInMode();
		if (signInMode === "cancel") {
			return {
				type: "failed",
				reason: "unknown",
				message: UI_COPY.oauth.cancelled,
			};
		}

		if (signInMode === "browser") {
			const opened = openBrowserUrl(url);
			if (opened) {
				console.log(stylePromptText(UI_COPY.oauth.browserOpened, "success"));
			} else {
				console.log(stylePromptText(UI_COPY.oauth.browserOpenFail, "warning"));
				console.log(`${stylePromptText(UI_COPY.oauth.goTo, "accent")} ${url}`);
				const copied = copyTextToClipboard(url);
				console.log(
					stylePromptText(
						copied ? UI_COPY.oauth.copyOk : UI_COPY.oauth.copyFail,
						copied ? "success" : "warning",
					),
				);
			}
		} else {
			console.log(`${stylePromptText(UI_COPY.oauth.goTo, "accent")} ${url}`);
			const copied = copyTextToClipboard(url);
			console.log(
				stylePromptText(
					copied ? UI_COPY.oauth.copyOk : UI_COPY.oauth.copyFail,
					copied ? "success" : "warning",
				),
			);
		}

		if (oauthServer.ready) {
			console.log(stylePromptText(UI_COPY.oauth.waitingCallback, "muted"));
			const callbackResult = await oauthServer.waitForCode(state);
			code = callbackResult?.code ?? null;
		}

		if (!code) {
			console.log(stylePromptText(UI_COPY.oauth.callbackMissed, "warning"));
			code = await promptManualCallback(state);
		}
	} finally {
		oauthServer.close();
	}

	if (!code) {
		return {
			type: "failed",
			reason: "unknown",
			message: UI_COPY.oauth.cancelled,
		};
	}
	return exchangeAuthorizationCode(code, pkce.verifier, REDIRECT_URI);
}

async function persistAccountPool(
	results: TokenSuccessWithAccount[],
	replaceAll: boolean,
): Promise<void> {
	if (results.length === 0) return;

	await withAccountStorageTransaction(async (loadedStorage, persist) => {
		const stored = replaceAll ? null : loadedStorage;
		const now = Date.now();
		const accounts = stored?.accounts ? [...stored.accounts] : [];
		let selectedAccountIndex: number | null = null;

		for (const result of results) {
			const tokenAccountId = extractAccountId(result.access);
			const accountId = resolveRequestAccountId(
				result.accountIdOverride,
				result.accountIdSource,
				tokenAccountId,
			);
			const accountIdSource = accountId
				? (result.accountIdSource ?? (result.accountIdOverride ? "manual" : "token"))
				: undefined;
			const accountLabel = result.accountLabel;
			const accountEmail = sanitizeEmail(
				extractAccountEmail(result.access, result.idToken),
			);
			const existingIndex = findMatchingAccountIndex(accounts, {
				accountId,
				email: accountEmail,
				refreshToken: result.refresh,
			});

			if (existingIndex === undefined) {
				const newIndex = accounts.length;
				accounts.push({
					accountId,
					accountIdSource,
					accountLabel,
					email: accountEmail,
					refreshToken: result.refresh,
					accessToken: result.access,
					expiresAt: result.expires,
					enabled: true,
					addedAt: now,
					lastUsed: now,
				});
				selectedAccountIndex = newIndex;
				continue;
			}

			const existing = accounts[existingIndex];
			if (!existing) continue;

			const nextEmail = accountEmail ?? existing.email;
			const nextAccountId = accountId ?? existing.accountId;
			const nextAccountIdSource = accountId
				? (accountIdSource ?? existing.accountIdSource)
				: existing.accountIdSource;

			accounts[existingIndex] = {
				...existing,
				accountId: nextAccountId,
				accountIdSource: nextAccountIdSource,
				accountLabel: accountLabel ?? existing.accountLabel,
				email: nextEmail,
				refreshToken: result.refresh,
				accessToken: result.access,
				expiresAt: result.expires,
				enabled: true,
				lastUsed: now,
			};
			selectedAccountIndex = existingIndex;
		}

		const fallbackActiveIndex = accounts.length === 0
			? 0
			: Math.max(
				0,
				Math.min(stored?.activeIndex ?? 0, accounts.length - 1),
			);
		const nextActiveIndex = accounts.length === 0
			? 0
			: selectedAccountIndex === null
				? fallbackActiveIndex
				: Math.max(0, Math.min(selectedAccountIndex, accounts.length - 1));
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			activeIndexByFamily[family] = nextActiveIndex;
		}

		await persist({
			version: 3,
			accounts,
			activeIndex: nextActiveIndex,
			activeIndexByFamily,
		});
	});
}

async function syncSelectionToCodex(tokens: TokenSuccessWithAccount): Promise<void> {
	const tokenAccountId = extractAccountId(tokens.access);
	const accountId = resolveRequestAccountId(
		tokens.accountIdOverride,
		tokens.accountIdSource,
		tokenAccountId,
	);
	const email = sanitizeEmail(extractAccountEmail(tokens.access, tokens.idToken));
	await setCodexCliActiveSelection({
		accountId,
		email,
		accessToken: tokens.access,
		refreshToken: tokens.refresh,
		expiresAt: tokens.expires,
		idToken: tokens.idToken,
	});
}

async function showAccountStatus(): Promise<void> {
	setStoragePath(null);
	const storage = await loadAccounts();
	const path = getStoragePath();
	if (!storage || storage.accounts.length === 0) {
		console.log("No accounts configured.");
		console.log(`Storage: ${path}`);
		return;
	}

	const now = Date.now();
	const activeIndex = resolveActiveIndex(storage, "codex");
	console.log(`Accounts (${storage.accounts.length})`);
	console.log(`Storage: ${path}`);
	console.log("");
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);
		const markers: string[] = [];
		if (i === activeIndex) markers.push("current");
		if (account.enabled === false) markers.push("disabled");
		const rateLimit = formatRateLimitEntry(account, now, "codex");
		if (rateLimit) markers.push("rate-limited");
		const cooldown = formatCooldown(account, now);
		if (cooldown) markers.push(`cooldown:${cooldown}`);
		const markerLabel = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
		const lastUsed = typeof account.lastUsed === "number" && account.lastUsed > 0
			? `used ${formatWaitTime(now - account.lastUsed)} ago`
			: "never used";
		console.log(`${i + 1}. ${label}${markerLabel} ${lastUsed}`);
	}
}

interface HealthCheckOptions {
	forceRefresh?: boolean;
	liveProbe?: boolean;
	model?: string;
	display?: DashboardDisplaySettings;
}

async function runHealthCheck(options: HealthCheckOptions = {}): Promise<void> {
	const forceRefresh = options.forceRefresh === true;
	const liveProbe = options.liveProbe === true;
	const probeModel = options.model?.trim() || "gpt-5-codex";
	const display = options.display ?? DEFAULT_DASHBOARD_DISPLAY_SETTINGS;
	const quotaCache = liveProbe ? await loadQuotaCache() : null;
	let quotaCacheChanged = false;
	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.log("No accounts configured.");
		return;
	}

	let changed = false;
	let ok = 0;
	let failed = 0;
	let warnings = 0;
	const activeIndex = resolveActiveIndex(storage, "codex");
	let activeAccountRefreshed = false;
	const now = Date.now();
	console.log(stylePromptText(
		forceRefresh
			? `Checking ${storage.accounts.length} account(s) with full refresh test...`
			: `Checking ${storage.accounts.length} account(s) with quick check${liveProbe ? " + live check" : ""}...`,
		"accent",
	));
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);
		const labelText = stylePromptText(label, "accent");
		const sessionLikelyValid = hasUsableAccessToken(account, now);
		if (!forceRefresh && sessionLikelyValid) {
			if (account.enabled === false) {
				account.enabled = true;
				changed = true;
			}
			if (i === activeIndex) {
				activeAccountRefreshed = true;
			}
			let healthDetail = "signed in and working";
			if (liveProbe) {
				const currentAccessToken = account.accessToken;
				const probeAccountId = currentAccessToken
					? (account.accountId ?? extractAccountId(currentAccessToken))
					: undefined;
				if (!probeAccountId || !currentAccessToken) {
					warnings += 1;
					healthDetail = "signed in and working (live check skipped: missing account ID)";
				} else {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: currentAccessToken,
							model: probeModel,
						});
						if (quotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(quotaCache, account, snapshot) || quotaCacheChanged;
						}
						healthDetail = formatQuotaSnapshotForDashboard(snapshot, display);
					} catch (error) {
						const message = normalizeFailureDetail(
							error instanceof Error ? error.message : String(error),
							undefined,
						);
						warnings += 1;
						healthDetail = `signed in and working (live check failed: ${message})`;
					}
				}
			}
			if (hasLikelyInvalidRefreshToken(account.refreshToken)) {
				healthDetail += " (re-login suggested soon)";
			}
			ok += 1;
			if (display.showPerAccountRows) {
				console.log(
					`  ${stylePromptText("✓", "success")} ${labelText} ${stylePromptText("|", "muted")} ${styleAccountDetailText(healthDetail)}`,
				);
			}
			continue;
		}
		const result = await queuedRefresh(account.refreshToken);
		if (result.type === "success") {
			const tokenAccountId = extractAccountId(result.access);
			const nextEmail = sanitizeEmail(extractAccountEmail(result.access, result.idToken));
			if (account.refreshToken !== result.refresh) {
				account.refreshToken = result.refresh;
				changed = true;
			}
			if (account.accessToken !== result.access) {
				account.accessToken = result.access;
				changed = true;
			}
			if (account.expiresAt !== result.expires) {
				account.expiresAt = result.expires;
				changed = true;
			}
			if (nextEmail && nextEmail !== account.email) {
				account.email = nextEmail;
				changed = true;
			}
			if (tokenAccountId && tokenAccountId !== account.accountId) {
				account.accountId = tokenAccountId;
				account.accountIdSource = "token";
				changed = true;
			}
			if (account.enabled === false) {
				account.enabled = true;
				changed = true;
			}
			account.lastUsed = Date.now();
			if (i === activeIndex) {
				activeAccountRefreshed = true;
			}
			ok += 1;
			let healthyMessage = "working now";
			if (liveProbe) {
				const probeAccountId = account.accountId ?? tokenAccountId;
				if (!probeAccountId) {
					warnings += 1;
					healthyMessage = "working now (live check skipped: missing account ID)";
				} else {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: result.access,
							model: probeModel,
						});
						if (quotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(quotaCache, account, snapshot) || quotaCacheChanged;
						}
						healthyMessage = formatQuotaSnapshotForDashboard(snapshot, display);
					} catch (error) {
						const message = normalizeFailureDetail(
							error instanceof Error ? error.message : String(error),
							undefined,
						);
						warnings += 1;
						healthyMessage = `working now (live check failed: ${message})`;
					}
				}
			}
			if (display.showPerAccountRows) {
				console.log(
					`  ${stylePromptText("✓", "success")} ${labelText} ${stylePromptText("|", "muted")} ${styleAccountDetailText(healthyMessage)}`,
				);
			}
		} else {
			const detail = normalizeFailureDetail(result.message, result.reason);
			if (sessionLikelyValid) {
				warnings += 1;
				if (display.showPerAccountRows) {
					console.log(
						`  ${stylePromptText("!", "warning")} ${labelText} ${stylePromptText("|", "muted")} ${stylePromptText(`refresh failed (${detail}) but this account still works right now`, "warning")}`,
					);
				}
			} else {
				failed += 1;
				if (display.showPerAccountRows) {
					console.log(
						`  ${stylePromptText("✗", "danger")} ${labelText} ${stylePromptText("|", "muted")} ${stylePromptText(detail, "danger")}`,
					);
				}
			}
		}
	}

	if (!display.showPerAccountRows) {
		console.log(stylePromptText("Per-account lines are hidden in dashboard settings.", "muted"));
	}
	if (quotaCache && quotaCacheChanged) {
		await saveQuotaCache(quotaCache);
	}

	if (changed) {
		await saveAccounts(storage);
	}

	if (activeAccountRefreshed && activeIndex >= 0 && activeIndex < storage.accounts.length) {
		const activeAccount = storage.accounts[activeIndex];
		if (activeAccount) {
			await setCodexCliActiveSelection({
				accountId: activeAccount.accountId,
				email: activeAccount.email,
				accessToken: activeAccount.accessToken,
				refreshToken: activeAccount.refreshToken,
				expiresAt: activeAccount.expiresAt,
			});
		}
	}

	console.log("");
	console.log(formatResultSummary([
		{ text: `${ok} working`, tone: "success" },
		{ text: `${failed} need re-login`, tone: failed > 0 ? "danger" : "muted" },
		{ text: `${warnings} warning${warnings === 1 ? "" : "s"}`, tone: warnings > 0 ? "warning" : "muted" },
	]));
}

interface ForecastCliOptions {
	live: boolean;
	json: boolean;
	model: string;
}

interface FixCliOptions {
	dryRun: boolean;
	json: boolean;
	live: boolean;
	model: string;
}

interface ReportCliOptions {
	live: boolean;
	json: boolean;
	model: string;
	outPath?: string;
}

interface VerifyFlaggedCliOptions {
	dryRun: boolean;
	json: boolean;
	restore: boolean;
}

type ParsedArgsResult<T> = { ok: true; options: T } | { ok: false; message: string };

function printForecastUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth forecast [--live] [--json] [--model <model>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend",
			"  --json, -j         Print machine-readable JSON output",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
		].join("\n"),
	);
}

function printFixUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth fix [--dry-run] [--json] [--live] [--model <model>]",
			"",
			"Options:",
			"  --dry-run, -n      Preview changes without writing storage",
			"  --json, -j         Print machine-readable JSON output",
			"  --live, -l         Run live session probe before deciding health",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
			"",
			"Behavior:",
			"  - Refreshes tokens for enabled accounts",
			"  - Disables hard-failed accounts (never deletes)",
			"  - Recommends a better current account when needed",
		].join("\n"),
	);
}

function printVerifyFlaggedUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth verify-flagged [--dry-run] [--json] [--no-restore]",
			"",
			"Options:",
			"  --dry-run, -n      Preview changes without writing storage",
			"  --json, -j         Print machine-readable JSON output",
			"  --no-restore       Check flagged accounts without restoring healthy ones",
			"",
			"Behavior:",
			"  - Refresh-checks accounts from flagged storage",
			"  - Restores healthy accounts back to active storage by default",
		].join("\n"),
	);
}

function parseForecastArgs(args: string[]): ParsedArgsResult<ForecastCliOptions> {
	const options: ForecastCliOptions = {
		live: false,
		json: false,
		model: "gpt-5-codex",
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (!arg) continue;
		if (arg === "--live" || arg === "-l") {
			options.live = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--model" || arg === "-m") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

function parseFixArgs(args: string[]): ParsedArgsResult<FixCliOptions> {
	const options: FixCliOptions = {
		dryRun: false,
		json: false,
		live: false,
		model: "gpt-5-codex",
	};

	for (let i = 0; i < args.length; i += 1) {
		const argValue = args[i];
		if (typeof argValue !== "string") continue;
		if (argValue === "--dry-run" || argValue === "-n") {
			options.dryRun = true;
			continue;
		}
		if (argValue === "--json" || argValue === "-j") {
			options.json = true;
			continue;
		}
		if (argValue === "--live" || argValue === "-l") {
			options.live = true;
			continue;
		}
		if (argValue === "--model" || argValue === "-m") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			i += 1;
			continue;
		}
		if (argValue.startsWith("--model=")) {
			const value = argValue.slice("--model=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${argValue}` };
	}

	return { ok: true, options };
}

function parseVerifyFlaggedArgs(args: string[]): ParsedArgsResult<VerifyFlaggedCliOptions> {
	const options: VerifyFlaggedCliOptions = {
		dryRun: false,
		json: false,
		restore: true,
	};

	for (const arg of args) {
		if (arg === "--dry-run" || arg === "-n") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--no-restore") {
			options.restore = false;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

interface DoctorCliOptions {
	json: boolean;
	fix: boolean;
	dryRun: boolean;
}

function printDoctorUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth doctor [--json] [--fix] [--dry-run]",
			"",
			"Options:",
			"  --json, -j         Print machine-readable JSON diagnostics",
			"  --fix              Apply safe auto-fixes to storage",
			"  --dry-run, -n      Preview --fix changes without writing storage",
			"",
			"Behavior:",
			"  - Validates account storage readability",
			"  - Checks active index consistency and account duplication",
			"  - Flags placeholder/demo accounts and disabled-all scenarios",
		].join("\n"),
	);
}

function parseDoctorArgs(args: string[]): ParsedArgsResult<DoctorCliOptions> {
	const options: DoctorCliOptions = { json: false, fix: false, dryRun: false };
	for (const arg of args) {
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--fix") {
			options.fix = true;
			continue;
		}
		if (arg === "--dry-run" || arg === "-n") {
			options.dryRun = true;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}
	if (options.dryRun && !options.fix) {
		return { ok: false, message: "--dry-run requires --fix" };
	}
	return { ok: true, options };
}

function printReportUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth report [--live] [--json] [--model <model>] [--out <path>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend",
			"  --json, -j         Print machine-readable JSON output",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
			"  --out              Write JSON report to a file path",
		].join("\n"),
	);
}

function parseReportArgs(args: string[]): ParsedArgsResult<ReportCliOptions> {
	const options: ReportCliOptions = {
		live: false,
		json: false,
		model: "gpt-5-codex",
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--live" || arg === "-l") {
			options.live = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--model" || arg === "-m") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			continue;
		}
		if (arg === "--out") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --out" };
			}
			options.outPath = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--out=")) {
			const value = arg.slice("--out=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --out" };
			}
			options.outPath = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

function serializeForecastResults(
	results: ForecastAccountResult[],
	liveQuotaByIndex: Map<number, Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>>,
	refreshFailures: Map<number, TokenFailure>,
): Array<{
	index: number;
	label: string;
	isCurrent: boolean;
	availability: ForecastAccountResult["availability"];
	riskScore: number;
	riskLevel: ForecastAccountResult["riskLevel"];
	waitMs: number;
	reasons: string[];
	liveQuota?: {
		status: number;
		planType?: string;
		activeLimit?: number;
		model: string;
		summary: string;
	};
	refreshFailure?: TokenFailure;
}> {
	return results.map((result) => {
		const liveQuota = liveQuotaByIndex.get(result.index);
		return {
			index: result.index,
			label: result.label,
			isCurrent: result.isCurrent,
			availability: result.availability,
			riskScore: result.riskScore,
			riskLevel: result.riskLevel,
			waitMs: result.waitMs,
			reasons: result.reasons,
			liveQuota: liveQuota
				? {
					status: liveQuota.status,
					planType: liveQuota.planType,
					activeLimit: liveQuota.activeLimit,
					model: liveQuota.model,
					summary: formatQuotaSnapshotLine(liveQuota),
				}
				: undefined,
			refreshFailure: refreshFailures.get(result.index),
		};
	});
}

async function runForecast(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printForecastUsage();
		return 0;
	}

	const parsedArgs = parseForecastArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printForecastUsage();
		return 1;
	}
	const options = parsedArgs.options;
	const display = DEFAULT_DASHBOARD_DISPLAY_SETTINGS;
	const quotaCache = options.live ? await loadQuotaCache() : null;
	let quotaCacheChanged = false;

	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.log("No accounts configured.");
		return 0;
	}

	const now = Date.now();
	const activeIndex = resolveActiveIndex(storage, "codex");
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>>();
	const probeErrors: string[] = [];

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account || !options.live) continue;
		if (account.enabled === false) continue;

		let probeAccessToken = account.accessToken;
		let probeAccountId = account.accountId ?? extractAccountId(account.accessToken);
		if (!hasUsableAccessToken(account, now)) {
			const refreshResult = await queuedRefresh(account.refreshToken);
			if (refreshResult.type !== "success") {
				refreshFailures.set(i, {
					...refreshResult,
					message: normalizeFailureDetail(refreshResult.message, refreshResult.reason),
				});
				continue;
			}
			probeAccessToken = refreshResult.access;
			probeAccountId = account.accountId ?? extractAccountId(refreshResult.access);
		}

		if (!probeAccessToken || !probeAccountId) {
			probeErrors.push(`${formatAccountLabel(account, i)}: missing accountId for live probe`);
			continue;
		}

		try {
			const liveQuota = await fetchCodexQuotaSnapshot({
				accountId: probeAccountId,
				accessToken: probeAccessToken,
				model: options.model,
			});
			liveQuotaByIndex.set(i, liveQuota);
			if (quotaCache) {
				const account = storage.accounts[i];
				if (account) {
					quotaCacheChanged =
						updateQuotaCacheForAccount(quotaCache, account, liveQuota) || quotaCacheChanged;
				}
			}
		} catch (error) {
			const message = normalizeFailureDetail(
				error instanceof Error ? error.message : String(error),
				undefined,
			);
			probeErrors.push(`${formatAccountLabel(account, i)}: ${message}`);
		}
	}

	const forecastInputs = storage.accounts.map((account, index) => ({
		index,
		account,
		isCurrent: index === activeIndex,
		now,
		refreshFailure: refreshFailures.get(index),
		liveQuota: liveQuotaByIndex.get(index),
	}));
	const forecastResults = evaluateForecastAccounts(forecastInputs);
	const summary = summarizeForecast(forecastResults);
	const recommendation = recommendForecastAccount(forecastResults);

	if (options.json) {
		if (quotaCache && quotaCacheChanged) {
			await saveQuotaCache(quotaCache);
		}
		console.log(
			JSON.stringify(
				{
					command: "forecast",
					model: options.model,
					liveProbe: options.live,
					summary,
					recommendation,
					probeErrors,
					accounts: serializeForecastResults(forecastResults, liveQuotaByIndex, refreshFailures),
				},
				null,
				2,
			),
		);
		return 0;
	}

	console.log(
		stylePromptText(
			`Best-account preview (${storage.accounts.length} account(s), model ${options.model}, live check ${options.live ? "on" : "off"})`,
			"accent",
		),
	);
	console.log(
		formatResultSummary([
			{ text: `${summary.ready} ready now`, tone: "success" },
			{ text: `${summary.delayed} waiting`, tone: "warning" },
			{ text: `${summary.unavailable} unavailable`, tone: summary.unavailable > 0 ? "danger" : "muted" },
			{ text: `${summary.highRisk} high risk`, tone: summary.highRisk > 0 ? "danger" : "muted" },
		]),
	);
	console.log("");

	for (const result of forecastResults) {
		if (!display.showPerAccountRows) {
			continue;
		}
		const currentTag = result.isCurrent ? " [current]" : "";
		const waitLabel = result.waitMs > 0 ? stylePromptText(`wait ${formatWaitTime(result.waitMs)}`, "muted") : "";
		const indexLabel = stylePromptText(`${result.index + 1}.`, "accent");
		const accountLabel = stylePromptText(`${result.label}${currentTag}`, "accent");
		const riskLabel = stylePromptText(`${result.riskLevel} risk (${result.riskScore})`, riskTone(result.riskLevel));
		const availabilityLabel = stylePromptText(result.availability, availabilityTone(result.availability));
		const rowParts = [availabilityLabel, riskLabel];
		if (waitLabel) rowParts.push(waitLabel);
		console.log(`${indexLabel} ${accountLabel} ${stylePromptText("|", "muted")} ${joinStyledSegments(rowParts)}`);
		if (display.showForecastReasons && result.reasons.length > 0) {
			console.log(`   ${stylePromptText(result.reasons.slice(0, 3).join("; "), "muted")}`);
		}
		const liveQuota = liveQuotaByIndex.get(result.index);
		if (display.showQuotaDetails && liveQuota) {
			console.log(`   ${stylePromptText("quota:", "accent")} ${styleQuotaSummary(formatCompactQuotaSnapshot(liveQuota))}`);
		}
	}

	if (!display.showPerAccountRows) {
		console.log(stylePromptText("Per-account lines are hidden in dashboard settings.", "muted"));
	}

	if (display.showRecommendations) {
		console.log("");
		if (recommendation.recommendedIndex !== null) {
			const index = recommendation.recommendedIndex;
			const account = forecastResults.find((result) => result.index === index);
			if (account) {
				console.log(
					`${stylePromptText("Best next account:", "accent")} ${stylePromptText(`${index + 1} (${account.label})`, "success")}`,
				);
				console.log(`${stylePromptText("Why:", "accent")} ${stylePromptText(recommendation.reason, "muted")}`);
				if (index !== activeIndex) {
					console.log(`${stylePromptText("Switch now with:", "accent")} codex auth switch ${index + 1}`);
				}
			}
		} else {
			console.log(`${stylePromptText("Note:", "accent")} ${stylePromptText(recommendation.reason, "muted")}`);
		}
	}

	if (display.showLiveProbeNotes && probeErrors.length > 0) {
		console.log("");
		console.log(stylePromptText(`Live check notes (${probeErrors.length}):`, "warning"));
		for (const error of probeErrors) {
			console.log(`  ${stylePromptText("-", "warning")} ${stylePromptText(error, "muted")}`);
		}
	}
	if (quotaCache && quotaCacheChanged) {
		await saveQuotaCache(quotaCache);
	}

	return 0;
}

async function runReport(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printReportUsage();
		return 0;
	}

	const parsedArgs = parseReportArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printReportUsage();
		return 1;
	}
	const options = parsedArgs.options;

	setStoragePath(null);
	const storagePath = getStoragePath();
	const storage = await loadAccounts();
	const now = Date.now();
	const accountCount = storage?.accounts.length ?? 0;
	const activeIndex = storage ? resolveActiveIndex(storage, "codex") : 0;
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>>();
	const probeErrors: string[] = [];

	if (storage && options.live) {
		for (let i = 0; i < storage.accounts.length; i += 1) {
			const account = storage.accounts[i];
			if (!account || account.enabled === false) continue;

			const refreshResult = await queuedRefresh(account.refreshToken);
			if (refreshResult.type !== "success") {
				refreshFailures.set(i, {
					...refreshResult,
					message: normalizeFailureDetail(refreshResult.message, refreshResult.reason),
				});
				continue;
			}

			const accountId = account.accountId ?? extractAccountId(refreshResult.access);
			if (!accountId) {
				probeErrors.push(`${formatAccountLabel(account, i)}: missing accountId for live probe`);
				continue;
			}

			try {
				const liveQuota = await fetchCodexQuotaSnapshot({
					accountId,
					accessToken: refreshResult.access,
					model: options.model,
				});
				liveQuotaByIndex.set(i, liveQuota);
			} catch (error) {
				const message = normalizeFailureDetail(
					error instanceof Error ? error.message : String(error),
					undefined,
				);
				probeErrors.push(`${formatAccountLabel(account, i)}: ${message}`);
			}
		}
	}

	const forecastResults = storage
		? evaluateForecastAccounts(
				storage.accounts.map((account, index) => ({
					index,
					account,
					isCurrent: index === activeIndex,
					now,
					refreshFailure: refreshFailures.get(index),
					liveQuota: liveQuotaByIndex.get(index),
				})),
			)
		: [];
	const forecastSummary = summarizeForecast(forecastResults);
	const recommendation = recommendForecastAccount(forecastResults);
	const enabledCount = storage
		? storage.accounts.filter((account) => account.enabled !== false).length
		: 0;
	const disabledCount = Math.max(0, accountCount - enabledCount);
	const coolingCount = storage
		? storage.accounts.filter(
				(account) =>
					typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now,
			).length
		: 0;
	const rateLimitedCount = storage
		? storage.accounts.filter((account) => !!formatRateLimitEntry(account, now, "codex")).length
		: 0;

	const report = {
		command: "report",
		generatedAt: new Date(now).toISOString(),
		storagePath,
		model: options.model,
		liveProbe: options.live,
		accounts: {
			total: accountCount,
			enabled: enabledCount,
			disabled: disabledCount,
			coolingDown: coolingCount,
			rateLimited: rateLimitedCount,
		},
		activeIndex: accountCount > 0 ? activeIndex + 1 : null,
		forecast: {
			summary: forecastSummary,
			recommendation,
			probeErrors,
			accounts: serializeForecastResults(forecastResults, liveQuotaByIndex, refreshFailures),
		},
	};

	if (options.outPath) {
		const outputPath = resolve(process.cwd(), options.outPath);
		await fs.mkdir(dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
	}

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}

	console.log(`Report generated at ${report.generatedAt}`);
	console.log(`Storage: ${report.storagePath}`);
	console.log(
		`Accounts: ${report.accounts.total} total (${report.accounts.enabled} enabled, ${report.accounts.disabled} disabled, ${report.accounts.coolingDown} cooling, ${report.accounts.rateLimited} rate-limited)`,
	);
	if (report.activeIndex !== null) {
		console.log(`Active account: ${report.activeIndex}`);
	}
	console.log(
		`Forecast: ${report.forecast.summary.ready} ready, ${report.forecast.summary.delayed} delayed, ${report.forecast.summary.unavailable} unavailable`,
	);
	if (report.forecast.recommendation.recommendedIndex !== null) {
		console.log(
			`Recommendation: account ${report.forecast.recommendation.recommendedIndex + 1} (${report.forecast.recommendation.reason})`,
		);
	} else {
		console.log(`Recommendation: ${report.forecast.recommendation.reason}`);
	}
	if (options.outPath) {
		console.log(`Report written: ${resolve(process.cwd(), options.outPath)}`);
	}
	if (report.forecast.probeErrors.length > 0) {
		console.log(`Probe notes: ${report.forecast.probeErrors.length}`);
	}
	return 0;
}

type FixOutcome =
	| "healthy"
	| "disabled-hard-failure"
	| "warning-soft-failure"
	| "already-disabled";

interface FixAccountReport {
	index: number;
	label: string;
	outcome: FixOutcome;
	message: string;
}

function summarizeFixReports(
	reports: FixAccountReport[],
): {
	healthy: number;
	disabled: number;
	warnings: number;
	skipped: number;
} {
	let healthy = 0;
	let disabled = 0;
	let warnings = 0;
	let skipped = 0;
	for (const report of reports) {
		if (report.outcome === "healthy") healthy += 1;
		else if (report.outcome === "disabled-hard-failure") disabled += 1;
		else if (report.outcome === "warning-soft-failure") warnings += 1;
		else skipped += 1;
	}
	return { healthy, disabled, warnings, skipped };
}

interface VerifyFlaggedReport {
	index: number;
	label: string;
	outcome: "restored" | "healthy-flagged" | "still-flagged" | "restore-skipped";
	message: string;
}

function createEmptyAccountStorage(): AccountStorageV3 {
	const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
	for (const family of MODEL_FAMILIES) {
		activeIndexByFamily[family] = 0;
	}
	return {
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily,
	};
}

function findExistingAccountIndexForFlagged(
	storage: AccountStorageV3,
	flagged: FlaggedAccountMetadataV1,
	nextRefreshToken: string,
	nextAccountId: string | undefined,
	nextEmail: string | undefined,
): number {
	const flaggedEmail = sanitizeEmail(flagged.email);
	const candidateAccountId = nextAccountId ?? flagged.accountId;
	const candidateEmail = sanitizeEmail(nextEmail) ?? flaggedEmail;
	const nextMatchIndex = findMatchingAccountIndex(storage.accounts, {
		accountId: candidateAccountId,
		email: candidateEmail,
		refreshToken: nextRefreshToken,
	});
	if (nextMatchIndex !== undefined) {
		return nextMatchIndex;
	}

	const flaggedMatchIndex = findMatchingAccountIndex(storage.accounts, {
		accountId: candidateAccountId,
		email: candidateEmail,
		refreshToken: flagged.refreshToken,
	});
	return flaggedMatchIndex ?? -1;
}

function upsertRecoveredFlaggedAccount(
	storage: AccountStorageV3,
	flagged: FlaggedAccountMetadataV1,
	refreshResult: TokenSuccess,
	now: number,
): { restored: boolean; changed: boolean; message: string } {
	const nextEmail = sanitizeEmail(extractAccountEmail(refreshResult.access, refreshResult.idToken)) ?? flagged.email;
	const nextAccountId = extractAccountId(refreshResult.access) ?? flagged.accountId;
	const existingIndex = findExistingAccountIndexForFlagged(
		storage,
		flagged,
		refreshResult.refresh,
		nextAccountId,
		nextEmail,
	);

	if (existingIndex >= 0) {
		const existing = storage.accounts[existingIndex];
		if (!existing) {
			return { restored: false, changed: false, message: "existing account entry is missing" };
		}
		let changed = false;
		if (existing.refreshToken !== refreshResult.refresh) {
			existing.refreshToken = refreshResult.refresh;
			changed = true;
		}
		if (existing.accessToken !== refreshResult.access) {
			existing.accessToken = refreshResult.access;
			changed = true;
		}
		if (existing.expiresAt !== refreshResult.expires) {
			existing.expiresAt = refreshResult.expires;
			changed = true;
		}
		if (nextEmail && nextEmail !== existing.email) {
			existing.email = nextEmail;
			changed = true;
		}
		if (nextAccountId && nextAccountId !== existing.accountId) {
			existing.accountId = nextAccountId;
			existing.accountIdSource = "token";
			changed = true;
		}
		if (existing.enabled === false) {
			existing.enabled = true;
			changed = true;
		}
		if (existing.accountLabel !== flagged.accountLabel && flagged.accountLabel) {
			existing.accountLabel = flagged.accountLabel;
			changed = true;
		}
		existing.lastUsed = now;
		return {
			restored: true,
			changed,
			message: `restored into existing account ${existingIndex + 1}`,
		};
	}

	if (storage.accounts.length >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
		return {
			restored: false,
			changed: false,
			message: `cannot restore (max ${ACCOUNT_LIMITS.MAX_ACCOUNTS} accounts reached)`,
		};
	}

	storage.accounts.push({
		refreshToken: refreshResult.refresh,
		accessToken: refreshResult.access,
		expiresAt: refreshResult.expires,
		accountId: nextAccountId,
		accountIdSource: nextAccountId ? "token" : flagged.accountIdSource,
		accountLabel: flagged.accountLabel,
		email: nextEmail,
		addedAt: flagged.addedAt ?? now,
		lastUsed: now,
		enabled: true,
	});
	return {
		restored: true,
		changed: true,
		message: `restored as account ${storage.accounts.length}`,
	};
}

async function runVerifyFlagged(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printVerifyFlaggedUsage();
		return 0;
	}

	const parsedArgs = parseVerifyFlaggedArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printVerifyFlaggedUsage();
		return 1;
	}
	const options = parsedArgs.options;

	setStoragePath(null);
	const flaggedStorage = await loadFlaggedAccounts();
	if (flaggedStorage.accounts.length === 0) {
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						command: "verify-flagged",
						total: 0,
						restored: 0,
						healthyFlagged: 0,
						stillFlagged: 0,
						changed: false,
						dryRun: options.dryRun,
						restore: options.restore,
						reports: [] as VerifyFlaggedReport[],
					},
					null,
					2,
				),
			);
			return 0;
		}
		console.log("No flagged accounts to check.");
		return 0;
	}

	let storage = await loadAccounts();
	if (!storage) {
		storage = createEmptyAccountStorage();
	}
	let storageChanged = false;
	let flaggedChanged = false;
	const reports: VerifyFlaggedReport[] = [];
	const nextFlaggedAccounts: FlaggedAccountMetadataV1[] = [];
	const now = Date.now();

	for (let i = 0; i < flaggedStorage.accounts.length; i += 1) {
		const flagged = flaggedStorage.accounts[i];
		if (!flagged) continue;
		const label = formatAccountLabel(flagged, i);
		const result = await queuedRefresh(flagged.refreshToken);

		if (result.type === "success") {
			if (!options.restore) {
				const nextFlagged: FlaggedAccountMetadataV1 = {
					...flagged,
					refreshToken: result.refresh,
					accessToken: result.access,
					expiresAt: result.expires,
					accountId: extractAccountId(result.access) ?? flagged.accountId,
					accountIdSource: extractAccountId(result.access) ? "token" : flagged.accountIdSource,
					email: sanitizeEmail(extractAccountEmail(result.access, result.idToken)) ?? flagged.email,
					lastUsed: now,
					lastError: undefined,
				};
				nextFlaggedAccounts.push(nextFlagged);
				if (JSON.stringify(nextFlagged) !== JSON.stringify(flagged)) {
					flaggedChanged = true;
				}
				reports.push({
					index: i,
					label,
					outcome: "healthy-flagged",
					message: "session is healthy (left in flagged list due to --no-restore)",
				});
				continue;
			}

			const upsertResult = upsertRecoveredFlaggedAccount(storage, flagged, result, now);
			if (upsertResult.restored) {
				storageChanged = storageChanged || upsertResult.changed;
				flaggedChanged = true;
				reports.push({
					index: i,
					label,
					outcome: "restored",
					message: upsertResult.message,
				});
				continue;
			}

			const updatedFlagged: FlaggedAccountMetadataV1 = {
				...flagged,
				refreshToken: result.refresh,
				accessToken: result.access,
				expiresAt: result.expires,
				accountId: extractAccountId(result.access) ?? flagged.accountId,
				accountIdSource: extractAccountId(result.access) ? "token" : flagged.accountIdSource,
				email: sanitizeEmail(extractAccountEmail(result.access, result.idToken)) ?? flagged.email,
				lastUsed: now,
				lastError: upsertResult.message,
			};
			nextFlaggedAccounts.push(updatedFlagged);
			if (JSON.stringify(updatedFlagged) !== JSON.stringify(flagged)) {
				flaggedChanged = true;
			}
			reports.push({
				index: i,
				label,
				outcome: "restore-skipped",
				message: upsertResult.message,
			});
			continue;
		}

		const detail = normalizeFailureDetail(result.message, result.reason);
		const failedFlagged: FlaggedAccountMetadataV1 = {
			...flagged,
			lastError: detail,
		};
		nextFlaggedAccounts.push(failedFlagged);
		if ((flagged.lastError ?? "") !== detail) {
			flaggedChanged = true;
		}
		reports.push({
			index: i,
			label,
			outcome: "still-flagged",
			message: detail,
		});
	}

	const remainingFlagged = nextFlaggedAccounts.length;
	const restored = reports.filter((report) => report.outcome === "restored").length;
	const healthyFlagged = reports.filter((report) => report.outcome === "healthy-flagged").length;
	const stillFlagged = reports.filter((report) => report.outcome === "still-flagged").length;
	const changed = storageChanged || flaggedChanged;

	if (!options.dryRun) {
		if (storageChanged) {
			normalizeDoctorIndexes(storage);
			await saveAccounts(storage);
		}
		if (flaggedChanged) {
			await saveFlaggedAccounts({
				version: 1,
				accounts: nextFlaggedAccounts,
			});
		}
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					command: "verify-flagged",
					total: flaggedStorage.accounts.length,
					restored,
					healthyFlagged,
					stillFlagged,
					remainingFlagged,
					changed,
					dryRun: options.dryRun,
					restore: options.restore,
					reports,
				},
				null,
				2,
			),
		);
		return 0;
	}

	console.log(
		stylePromptText(
			`Checking ${flaggedStorage.accounts.length} flagged account(s)...`,
			"accent",
		),
	);
	for (const report of reports) {
		const tone = report.outcome === "restored"
			? "success"
			: report.outcome === "healthy-flagged"
				? "warning"
				: report.outcome === "restore-skipped"
					? "warning"
					: "danger";
		const marker = report.outcome === "restored"
			? "✓"
			: report.outcome === "healthy-flagged"
				? "!"
				: report.outcome === "restore-skipped"
					? "!"
					: "✗";
		console.log(
			`${stylePromptText(marker, tone)} ${stylePromptText(`${report.index + 1}. ${report.label}`, "accent")} ${stylePromptText("|", "muted")} ${styleAccountDetailText(report.message, tone)}`,
		);
	}
	console.log("");
	console.log(formatResultSummary([
		{ text: `${restored} restored`, tone: restored > 0 ? "success" : "muted" },
		{ text: `${healthyFlagged} healthy (kept flagged)`, tone: healthyFlagged > 0 ? "warning" : "muted" },
		{ text: `${stillFlagged} still flagged`, tone: stillFlagged > 0 ? "danger" : "muted" },
	]));
	if (options.dryRun) {
		console.log(stylePromptText("Preview only: no changes were saved.", "warning"));
	} else if (!changed) {
		console.log(stylePromptText("No storage changes were needed.", "muted"));
	}

	return 0;
}

async function runFix(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printFixUsage();
		return 0;
	}

	const parsedArgs = parseFixArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printFixUsage();
		return 1;
	}
	const options = parsedArgs.options;
	const display = DEFAULT_DASHBOARD_DISPLAY_SETTINGS;
	const quotaCache = options.live ? await loadQuotaCache() : null;
	let quotaCacheChanged = false;

	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.log("No accounts configured.");
		return 0;
	}

	const now = Date.now();
	const activeIndex = resolveActiveIndex(storage, "codex");
	let changed = false;
	const reports: FixAccountReport[] = [];
	const refreshFailures = new Map<number, TokenFailure>();
	const hardDisabledIndexes: number[] = [];

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);

		if (account.enabled === false) {
			reports.push({
				index: i,
				label,
				outcome: "already-disabled",
				message: "already disabled",
			});
			continue;
		}

		if (hasUsableAccessToken(account, now)) {
			if (options.live) {
				const currentAccessToken = account.accessToken;
				const probeAccountId = currentAccessToken
					? (account.accountId ?? extractAccountId(currentAccessToken))
					: undefined;
				if (probeAccountId && currentAccessToken) {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: currentAccessToken,
							model: options.model,
						});
						if (quotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(quotaCache, account, snapshot) || quotaCacheChanged;
						}
						reports.push({
							index: i,
							label,
							outcome: "healthy",
							message: display.showQuotaDetails
								? `live session OK (${formatCompactQuotaSnapshot(snapshot)})`
								: "live session OK",
						});
						continue;
					} catch (error) {
						const message = normalizeFailureDetail(
							error instanceof Error ? error.message : String(error),
							undefined,
						);
						reports.push({
							index: i,
							label,
							outcome: "warning-soft-failure",
							message: `live probe failed (${message}), trying refresh fallback`,
						});
					}
				}
			}

			const refreshWarning = hasLikelyInvalidRefreshToken(account.refreshToken)
				? " (refresh token looks stale; re-login recommended)"
				: "";
			reports.push({
				index: i,
				label,
				outcome: "healthy",
				message: `access token still valid${refreshWarning}`,
			});
			continue;
		}

		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type === "success") {
			const nextEmail = sanitizeEmail(extractAccountEmail(refreshResult.access, refreshResult.idToken));
			const nextAccountId = extractAccountId(refreshResult.access);
			let accountChanged = false;

			if (account.refreshToken !== refreshResult.refresh) {
				account.refreshToken = refreshResult.refresh;
				accountChanged = true;
			}
			if (account.accessToken !== refreshResult.access) {
				account.accessToken = refreshResult.access;
				accountChanged = true;
			}
			if (account.expiresAt !== refreshResult.expires) {
				account.expiresAt = refreshResult.expires;
				accountChanged = true;
			}
			if (nextEmail && nextEmail !== account.email) {
				account.email = nextEmail;
				accountChanged = true;
			}
			if (!account.accountId && nextAccountId) {
				account.accountId = nextAccountId;
				account.accountIdSource = "token";
				accountChanged = true;
			}

			if (accountChanged) changed = true;
			if (options.live) {
				const probeAccountId = account.accountId ?? nextAccountId;
				if (probeAccountId) {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: refreshResult.access,
							model: options.model,
						});
						if (quotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(quotaCache, account, snapshot) || quotaCacheChanged;
						}
						reports.push({
							index: i,
							label,
							outcome: "healthy",
							message: display.showQuotaDetails
								? `refresh + live probe succeeded (${formatCompactQuotaSnapshot(snapshot)})`
								: "refresh + live probe succeeded",
						});
						continue;
					} catch (error) {
						const message = normalizeFailureDetail(
							error instanceof Error ? error.message : String(error),
							undefined,
						);
						reports.push({
							index: i,
							label,
							outcome: "warning-soft-failure",
							message: `refresh succeeded but live probe failed: ${message}`,
						});
						continue;
					}
				}
			}
			reports.push({
				index: i,
				label,
				outcome: "healthy",
				message: "refresh succeeded",
			});
			continue;
		}

		const detail = normalizeFailureDetail(refreshResult.message, refreshResult.reason);
		refreshFailures.set(i, {
			...refreshResult,
			message: detail,
		});
		if (isHardRefreshFailure(refreshResult)) {
			account.enabled = false;
			changed = true;
			hardDisabledIndexes.push(i);
			reports.push({
				index: i,
				label,
				outcome: "disabled-hard-failure",
				message: detail,
			});
		} else {
			reports.push({
				index: i,
				label,
				outcome: "warning-soft-failure",
				message: detail,
			});
		}
	}

	if (hardDisabledIndexes.length > 0) {
		const enabledCount = storage.accounts.filter((account) => account.enabled !== false).length;
		if (enabledCount === 0) {
			const fallbackIndex =
				hardDisabledIndexes.includes(activeIndex) ? activeIndex : hardDisabledIndexes[0];
			const fallback = typeof fallbackIndex === "number"
				? storage.accounts[fallbackIndex]
				: undefined;
			if (fallback && fallback.enabled === false) {
				fallback.enabled = true;
				changed = true;
				const existingReport = reports.find(
					(report) =>
						report.index === fallbackIndex &&
						report.outcome === "disabled-hard-failure",
				);
				if (existingReport) {
					existingReport.outcome = "warning-soft-failure";
					existingReport.message = `${existingReport.message} (kept enabled to avoid lockout; re-login required)`;
				}
			}
		}
	}

	const forecastResults = evaluateForecastAccounts(
		storage.accounts.map((account, index) => ({
			index,
			account,
			isCurrent: index === activeIndex,
			now,
			refreshFailure: refreshFailures.get(index),
		})),
	);
	const recommendation = recommendForecastAccount(forecastResults);
	const reportSummary = summarizeFixReports(reports);

	if (changed && !options.dryRun) {
		await saveAccounts(storage);
	}

	if (options.json) {
		if (quotaCache && quotaCacheChanged) {
			await saveQuotaCache(quotaCache);
		}
		console.log(
			JSON.stringify(
				{
					command: "fix",
					dryRun: options.dryRun,
					liveProbe: options.live,
					model: options.model,
					changed,
					summary: reportSummary,
					recommendation,
					recommendedSwitchCommand:
						recommendation.recommendedIndex !== null &&
							recommendation.recommendedIndex !== activeIndex
							? `codex auth switch ${recommendation.recommendedIndex + 1}`
							: null,
					reports,
				},
				null,
				2,
			),
		);
		return 0;
	}

	console.log(stylePromptText(`Auto-fix scan (${options.dryRun ? "preview" : "apply"})`, "accent"));
	console.log(formatResultSummary([
		{ text: `${reportSummary.healthy} working`, tone: "success" },
		{ text: `${reportSummary.disabled} disabled`, tone: reportSummary.disabled > 0 ? "danger" : "muted" },
		{
			text: `${reportSummary.warnings} warning${reportSummary.warnings === 1 ? "" : "s"}`,
			tone: reportSummary.warnings > 0 ? "warning" : "muted",
		},
		{ text: `${reportSummary.skipped} already disabled`, tone: "muted" },
	]));
	if (display.showPerAccountRows) {
		console.log("");
		for (const report of reports) {
			const prefix =
				report.outcome === "healthy"
					? "✓"
					: report.outcome === "disabled-hard-failure"
						? "✗"
						: report.outcome === "warning-soft-failure"
							? "!"
							: "-";
			const tone = report.outcome === "healthy"
				? "success"
				: report.outcome === "disabled-hard-failure"
					? "danger"
					: report.outcome === "warning-soft-failure"
						? "warning"
						: "muted";
			console.log(
				`${stylePromptText(prefix, tone)} ${stylePromptText(`${report.index + 1}. ${report.label}`, "accent")} ${stylePromptText("|", "muted")} ${styleAccountDetailText(report.message, tone === "success" ? "muted" : tone)}`,
			);
		}
	} else {
		console.log("");
		console.log(stylePromptText("Per-account lines are hidden in dashboard settings.", "muted"));
	}

	if (display.showRecommendations) {
		console.log("");
		if (recommendation.recommendedIndex !== null) {
			const target = recommendation.recommendedIndex + 1;
			console.log(`${stylePromptText("Best next account:", "accent")} ${stylePromptText(String(target), "success")}`);
			console.log(`${stylePromptText("Why:", "accent")} ${stylePromptText(recommendation.reason, "muted")}`);
			if (recommendation.recommendedIndex !== activeIndex) {
				console.log(`${stylePromptText("Switch now with:", "accent")} codex auth switch ${target}`);
			}
		} else {
			console.log(`${stylePromptText("Note:", "accent")} ${stylePromptText(recommendation.reason, "muted")}`);
		}
	}
	if (quotaCache && quotaCacheChanged) {
		await saveQuotaCache(quotaCache);
	}

	if (changed && options.dryRun) {
		console.log(`\n${stylePromptText("Preview only: no changes were saved.", "warning")}`);
	} else if (changed) {
		console.log(`\n${stylePromptText("Saved updates.", "success")}`);
	} else {
		console.log(`\n${stylePromptText("No changes were needed.", "muted")}`);
	}

	return 0;
}

type DoctorSeverity = "ok" | "warn" | "error";

interface DoctorCheck {
	key: string;
	severity: DoctorSeverity;
	message: string;
	details?: string;
}

interface DoctorFixAction {
	key: string;
	message: string;
}

function hasPlaceholderEmail(value: string | undefined): boolean {
	if (!value) return false;
	const email = value.trim().toLowerCase();
	if (!email) return false;
	return (
		email.endsWith("@example.com") ||
		email.includes("account1@example.com") ||
		email.includes("account2@example.com") ||
		email.includes("account3@example.com")
	);
}

function normalizeDoctorIndexes(storage: AccountStorageV3): boolean {
	const total = storage.accounts.length;
	const nextActive = total === 0 ? 0 : Math.max(0, Math.min(storage.activeIndex, total - 1));
	let changed = false;
	if (storage.activeIndex !== nextActive) {
		storage.activeIndex = nextActive;
		changed = true;
	}
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const raw = storage.activeIndexByFamily[family];
		const fallback = storage.activeIndex;
		const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
		const clamped = total === 0 ? 0 : Math.max(0, Math.min(candidate, total - 1));
		if (storage.activeIndexByFamily[family] !== clamped) {
			storage.activeIndexByFamily[family] = clamped;
			changed = true;
		}
	}
	return changed;
}

function applyDoctorFixes(storage: AccountStorageV3): { changed: boolean; actions: DoctorFixAction[] } {
	let changed = false;
	const actions: DoctorFixAction[] = [];

	if (normalizeDoctorIndexes(storage)) {
		changed = true;
		actions.push({
			key: "active-index",
			message: "Normalized active account indexes",
		});
	}

	const seenRefreshTokens = new Map<string, number>();
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;

		const refreshToken = account.refreshToken.trim();
		const existingTokenIndex = seenRefreshTokens.get(refreshToken);
		if (typeof existingTokenIndex === "number") {
			if (account.enabled !== false) {
				account.enabled = false;
				changed = true;
				actions.push({
					key: "duplicate-refresh-token",
					message: `Disabled duplicate token entry on account ${i + 1} (kept account ${existingTokenIndex + 1})`,
				});
			}
		} else {
			seenRefreshTokens.set(refreshToken, i);
		}

		const tokenEmail = sanitizeEmail(extractAccountEmail(account.accessToken));
		if (
			tokenEmail &&
			(!sanitizeEmail(account.email) || hasPlaceholderEmail(account.email))
		) {
			account.email = tokenEmail;
			changed = true;
			actions.push({
				key: "email-from-token",
				message: `Updated account ${i + 1} email from token claims`,
			});
		}

		const tokenAccountId = extractAccountId(account.accessToken);
		if (!account.accountId && tokenAccountId) {
			account.accountId = tokenAccountId;
			account.accountIdSource = "token";
			changed = true;
			actions.push({
				key: "account-id-from-token",
				message: `Filled missing accountId for account ${i + 1}`,
			});
		}
	}

	const enabledCount = storage.accounts.filter((account) => account.enabled !== false).length;
	if (storage.accounts.length > 0 && enabledCount === 0) {
		const index = resolveActiveIndex(storage, "codex");
		const candidate = storage.accounts[index] ?? storage.accounts[0];
		if (candidate) {
			candidate.enabled = true;
			changed = true;
			actions.push({
				key: "enabled-accounts",
				message: `Re-enabled account ${index + 1} to avoid an all-disabled pool`,
			});
		}
	}

	if (normalizeDoctorIndexes(storage)) {
		changed = true;
	}

	return { changed, actions };
}

async function runDoctor(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printDoctorUsage();
		return 0;
	}

	const parsedArgs = parseDoctorArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printDoctorUsage();
		return 1;
	}
	const options = parsedArgs.options;

	setStoragePath(null);
	const storagePath = getStoragePath();
	const checks: DoctorCheck[] = [];
	const addCheck = (check: DoctorCheck): void => {
		checks.push(check);
	};

	addCheck({
		key: "storage-file",
		severity: existsSync(storagePath) ? "ok" : "warn",
		message: existsSync(storagePath)
			? "Account storage file found"
			: "Account storage file does not exist yet (first login pending)",
		details: storagePath,
	});

	if (existsSync(storagePath)) {
		try {
			const stat = await fs.stat(storagePath);
			addCheck({
				key: "storage-readable",
				severity: stat.size > 0 ? "ok" : "warn",
				message: stat.size > 0 ? "Storage file is readable" : "Storage file is empty",
				details: `${stat.size} bytes`,
			});
		} catch (error) {
			addCheck({
				key: "storage-readable",
				severity: "error",
				message: "Unable to read storage file metadata",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const codexAuthPath = getCodexCliAuthPath();
	const codexConfigPath = getCodexCliConfigPath();
	let codexAuthEmail: string | undefined;
	let codexAuthAccountId: string | undefined;

	addCheck({
		key: "codex-auth-file",
		severity: existsSync(codexAuthPath) ? "ok" : "warn",
		message: existsSync(codexAuthPath)
			? "Codex auth file found"
			: "Codex auth file does not exist",
		details: codexAuthPath,
	});

	if (existsSync(codexAuthPath)) {
		try {
			const raw = await fs.readFile(codexAuthPath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object") {
				const payload = parsed as Record<string, unknown>;
				const tokens = payload.tokens && typeof payload.tokens === "object"
					? (payload.tokens as Record<string, unknown>)
					: null;
				const accessToken = tokens && typeof tokens.access_token === "string"
					? tokens.access_token
					: undefined;
				const idToken = tokens && typeof tokens.id_token === "string"
					? tokens.id_token
					: undefined;
				const accountIdFromFile = tokens && typeof tokens.account_id === "string"
					? tokens.account_id
					: undefined;
				const emailFromFile = typeof payload.email === "string" ? payload.email : undefined;
				codexAuthEmail = sanitizeEmail(emailFromFile ?? extractAccountEmail(accessToken, idToken));
				codexAuthAccountId = accountIdFromFile ?? extractAccountId(accessToken);
			}
			addCheck({
				key: "codex-auth-readable",
				severity: "ok",
				message: "Codex auth file is readable",
				details:
					codexAuthEmail || codexAuthAccountId
						? `email=${codexAuthEmail ?? "unknown"}, accountId=${codexAuthAccountId ?? "unknown"}`
						: undefined,
			});
		} catch (error) {
			addCheck({
				key: "codex-auth-readable",
				severity: "error",
				message: "Unable to read Codex auth file",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}

	addCheck({
		key: "codex-config-file",
		severity: existsSync(codexConfigPath) ? "ok" : "warn",
		message: existsSync(codexConfigPath)
			? "Codex config file found"
			: "Codex config file does not exist",
		details: codexConfigPath,
	});

	let codexAuthStoreMode: string | undefined;
	if (existsSync(codexConfigPath)) {
		try {
			const configRaw = await fs.readFile(codexConfigPath, "utf-8");
			const match = configRaw.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"\s*$/m);
			if (match?.[1]) {
				codexAuthStoreMode = match[1].trim();
			}
		} catch (error) {
			addCheck({
				key: "codex-auth-store",
				severity: "warn",
				message: "Unable to read Codex auth-store config",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (!checks.some((check) => check.key === "codex-auth-store")) {
		addCheck({
			key: "codex-auth-store",
			severity: codexAuthStoreMode === "file" ? "ok" : "warn",
			message:
				codexAuthStoreMode === "file"
					? "Codex auth storage is set to file"
					: "Codex auth storage is not explicitly set to file",
			details: codexAuthStoreMode ? `mode=${codexAuthStoreMode}` : "mode=unset",
		});
	}

	const codexCliState = await loadCodexCliState({ forceRefresh: true });
	addCheck({
		key: "codex-cli-state",
		severity: codexCliState ? "ok" : "warn",
		message: codexCliState
			? "Codex CLI state loaded"
			: "Codex CLI state unavailable",
		details: codexCliState?.path,
	});

	const storage = await loadAccounts();
	let fixChanged = false;
	let fixActions: DoctorFixAction[] = [];
	if (options.fix && storage && storage.accounts.length > 0) {
		const fixed = applyDoctorFixes(storage);
		fixChanged = fixed.changed;
		fixActions = fixed.actions;
		if (fixChanged && !options.dryRun) {
			await saveAccounts(storage);
		}
		addCheck({
			key: "auto-fix",
			severity: fixChanged ? "warn" : "ok",
			message: fixChanged
				? options.dryRun
					? `Prepared ${fixActions.length} fix(es) (dry-run)`
					: `Applied ${fixActions.length} fix(es)`
				: "No safe auto-fixes needed",
		});
	}
	if (!storage || storage.accounts.length === 0) {
		addCheck({
			key: "accounts",
			severity: "warn",
			message: "No accounts configured",
		});
	} else {
		addCheck({
			key: "accounts",
			severity: "ok",
			message: `Loaded ${storage.accounts.length} account(s)`,
		});

		const activeIndex = resolveActiveIndex(storage, "codex");
		const activeExists = activeIndex >= 0 && activeIndex < storage.accounts.length;
		addCheck({
			key: "active-index",
			severity: activeExists ? "ok" : "error",
			message: activeExists
				? `Active index is valid (${activeIndex + 1})`
				: "Active index is out of range",
		});

		const disabledCount = storage.accounts.filter((a) => a.enabled === false).length;
		addCheck({
			key: "enabled-accounts",
			severity: disabledCount >= storage.accounts.length ? "error" : "ok",
			message:
				disabledCount >= storage.accounts.length
					? "All accounts are disabled"
					: `${storage.accounts.length - disabledCount} enabled / ${disabledCount} disabled`,
		});

		const seenRefreshTokens = new Set<string>();
		let duplicateTokenCount = 0;
		for (const account of storage.accounts) {
			const token = account.refreshToken.trim();
			if (seenRefreshTokens.has(token)) {
				duplicateTokenCount += 1;
			} else {
				seenRefreshTokens.add(token);
			}
		}
		addCheck({
			key: "duplicate-refresh-token",
			severity: duplicateTokenCount > 0 ? "warn" : "ok",
			message:
				duplicateTokenCount > 0
					? `Detected ${duplicateTokenCount} duplicate refresh token entr${duplicateTokenCount === 1 ? "y" : "ies"}`
					: "No duplicate refresh tokens detected",
		});

		const seenEmails = new Set<string>();
		let duplicateEmailCount = 0;
		let placeholderEmailCount = 0;
		let likelyInvalidRefreshTokenCount = 0;
		for (const account of storage.accounts) {
			const email = sanitizeEmail(account.email);
			if (!email) continue;
			if (seenEmails.has(email)) duplicateEmailCount += 1;
			seenEmails.add(email);
			if (hasPlaceholderEmail(email)) placeholderEmailCount += 1;
			if (hasLikelyInvalidRefreshToken(account.refreshToken)) {
				likelyInvalidRefreshTokenCount += 1;
			}
		}
		addCheck({
			key: "duplicate-email",
			severity: duplicateEmailCount > 0 ? "warn" : "ok",
			message:
				duplicateEmailCount > 0
					? `Detected ${duplicateEmailCount} duplicate email entr${duplicateEmailCount === 1 ? "y" : "ies"}`
					: "No duplicate emails detected",
		});
		addCheck({
			key: "placeholder-email",
			severity: placeholderEmailCount > 0 ? "warn" : "ok",
			message:
				placeholderEmailCount > 0
					? `${placeholderEmailCount} account(s) appear to be placeholder/demo entries`
					: "No placeholder emails detected",
		});
		addCheck({
			key: "refresh-token-shape",
			severity: likelyInvalidRefreshTokenCount > 0 ? "warn" : "ok",
			message:
				likelyInvalidRefreshTokenCount > 0
					? `${likelyInvalidRefreshTokenCount} account(s) have likely invalid refresh token format`
					: "Refresh token format looks normal",
		});

		const now = Date.now();
		const forecastResults = evaluateForecastAccounts(
			storage.accounts.map((account, index) => ({
				index,
				account,
				isCurrent: index === activeIndex,
				now,
			})),
		);
		const recommendation = recommendForecastAccount(forecastResults);
		if (recommendation.recommendedIndex !== null && recommendation.recommendedIndex !== activeIndex) {
			addCheck({
				key: "recommended-switch",
				severity: "warn",
				message: `A healthier account is available: switch to ${recommendation.recommendedIndex + 1}`,
				details: recommendation.reason,
			});
		} else {
			addCheck({
				key: "recommended-switch",
				severity: "ok",
				message: "Current account aligns with forecast recommendation",
			});
		}

		if (activeExists) {
			const activeAccount = storage.accounts[activeIndex];
			const managerActiveEmail = sanitizeEmail(activeAccount?.email);
			const managerActiveAccountId = activeAccount?.accountId;
			const codexActiveEmail = sanitizeEmail(codexCliState?.activeEmail) ?? codexAuthEmail;
			const codexActiveAccountId = codexCliState?.activeAccountId ?? codexAuthAccountId;
			const isEmailMismatch =
				!!managerActiveEmail &&
				!!codexActiveEmail &&
				managerActiveEmail !== codexActiveEmail;
			const isAccountIdMismatch =
				!!managerActiveAccountId &&
				!!codexActiveAccountId &&
				managerActiveAccountId !== codexActiveAccountId;

			addCheck({
				key: "active-selection-sync",
				severity: isEmailMismatch || isAccountIdMismatch ? "warn" : "ok",
				message:
					isEmailMismatch || isAccountIdMismatch
						? "Manager active account and Codex active account are not aligned"
						: "Manager active account and Codex active account are aligned",
				details: `manager=${managerActiveEmail ?? managerActiveAccountId ?? "unknown"} | codex=${codexActiveEmail ?? codexActiveAccountId ?? "unknown"}`,
			});

			if (options.fix && activeAccount) {
				let syncAccessToken = activeAccount.accessToken;
				let syncRefreshToken = activeAccount.refreshToken;
				let syncExpiresAt = activeAccount.expiresAt;
				let syncIdToken: string | undefined;
				let storageChangedFromDoctorSync = false;

				if (!hasUsableAccessToken(activeAccount, now)) {
					if (options.dryRun) {
						fixActions.push({
							key: "doctor-refresh",
							message: `Prepared active-account token refresh for account ${activeIndex + 1} (dry-run)`,
						});
					} else {
						const refreshResult = await queuedRefresh(activeAccount.refreshToken);
						if (refreshResult.type === "success") {
							const refreshedEmail = sanitizeEmail(
								extractAccountEmail(refreshResult.access, refreshResult.idToken),
							);
							const refreshedAccountId = extractAccountId(refreshResult.access);
							activeAccount.accessToken = refreshResult.access;
							activeAccount.refreshToken = refreshResult.refresh;
							activeAccount.expiresAt = refreshResult.expires;
							if (refreshedEmail) activeAccount.email = refreshedEmail;
							if (refreshedAccountId) {
								activeAccount.accountId = refreshedAccountId;
								activeAccount.accountIdSource = "token";
							}
							syncAccessToken = refreshResult.access;
							syncRefreshToken = refreshResult.refresh;
							syncExpiresAt = refreshResult.expires;
							syncIdToken = refreshResult.idToken;
							storageChangedFromDoctorSync = true;
							fixActions.push({
								key: "doctor-refresh",
								message: `Refreshed active account tokens for account ${activeIndex + 1}`,
							});
						} else {
							addCheck({
								key: "doctor-refresh",
								severity: "warn",
								message: "Unable to refresh active account before Codex sync",
								details: normalizeFailureDetail(refreshResult.message, refreshResult.reason),
							});
						}
					}
				}

				if (storageChangedFromDoctorSync) {
					fixChanged = true;
					if (!options.dryRun) {
						await saveAccounts(storage);
					}
				}

				if (!options.dryRun) {
					const synced = await setCodexCliActiveSelection({
						accountId: activeAccount.accountId,
						email: activeAccount.email,
						accessToken: syncAccessToken,
						refreshToken: syncRefreshToken,
						expiresAt: syncExpiresAt,
						...(syncIdToken ? { idToken: syncIdToken } : {}),
					});
					if (synced) {
						fixChanged = true;
						fixActions.push({
							key: "codex-active-sync",
							message: "Synced manager active account into Codex auth state",
						});
					} else {
						addCheck({
							key: "codex-active-sync",
							severity: "warn",
							message: "Failed to sync manager active account into Codex auth state",
						});
					}
				} else {
					fixActions.push({
						key: "codex-active-sync",
						message: "Prepared Codex active-account sync (dry-run)",
					});
				}
			}
		}
	}

	const summary = checks.reduce(
		(acc, check) => {
			acc[check.severity] += 1;
			return acc;
		},
		{ ok: 0, warn: 0, error: 0 },
	);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					command: "doctor",
					storagePath,
					summary,
					checks,
					fix: {
						enabled: options.fix,
						dryRun: options.dryRun,
						changed: fixChanged,
						actions: fixActions,
					},
				},
				null,
				2,
			),
		);
		return summary.error > 0 ? 1 : 0;
	}

	console.log("Doctor diagnostics");
	console.log(`Storage: ${storagePath}`);
	console.log(`Summary: ${summary.ok} ok, ${summary.warn} warnings, ${summary.error} errors`);
	console.log("");
	for (const check of checks) {
		const marker = check.severity === "ok" ? "✓" : check.severity === "warn" ? "!" : "✗";
		console.log(`${marker} ${check.key}: ${check.message}`);
		if (check.details) {
			console.log(`  ${check.details}`);
		}
	}
	if (options.fix) {
		console.log("");
		if (fixActions.length > 0) {
			console.log(`Auto-fix actions (${options.dryRun ? "dry-run" : "applied"}):`);
			for (const action of fixActions) {
				console.log(`  - ${action.message}`);
			}
		} else {
			console.log("Auto-fix actions: none");
		}
	}

	return summary.error > 0 ? 1 : 0;
}

async function clearAccountsAndReset(): Promise<void> {
	await clearAccounts();
}

async function handleManageAction(
	storage: AccountStorageV3,
	menuResult: Awaited<ReturnType<typeof promptLoginMode>>,
): Promise<void> {
	if (typeof menuResult.switchAccountIndex === "number") {
		const index = menuResult.switchAccountIndex;
		await runSwitch([String(index + 1)]);
		return;
	}

	if (typeof menuResult.deleteAccountIndex === "number") {
		const idx = menuResult.deleteAccountIndex;
		if (idx >= 0 && idx < storage.accounts.length) {
			storage.accounts.splice(idx, 1);
			storage.activeIndex = 0;
			storage.activeIndexByFamily = {};
			for (const family of MODEL_FAMILIES) {
				storage.activeIndexByFamily[family] = 0;
			}
			await saveAccounts(storage);
			console.log(`Deleted account ${idx + 1}.`);
		}
		return;
	}

	if (typeof menuResult.toggleAccountIndex === "number") {
		const idx = menuResult.toggleAccountIndex;
		const account = storage.accounts[idx];
		if (account) {
			account.enabled = account.enabled === false;
			await saveAccounts(storage);
			console.log(
				`${account.enabled === false ? "Disabled" : "Enabled"} account ${idx + 1}.`,
			);
		}
		return;
	}

	if (typeof menuResult.refreshAccountIndex === "number") {
		const idx = menuResult.refreshAccountIndex;
		const existing = storage.accounts[idx];
		if (!existing) return;

		const tokenResult = await runOAuthFlow(true);
		if (tokenResult.type !== "success") {
			console.error(`Refresh failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`);
			return;
		}

		const resolved = resolveAccountSelection(tokenResult);
		await persistAccountPool([resolved], false);
		await syncSelectionToCodex(resolved);
		console.log(`Refreshed account ${idx + 1}.`);
	}
}

async function runAuthLogin(): Promise<number> {
	setStoragePath(null);
	let pendingMenuQuotaRefresh: Promise<void> | null = null;
	let menuQuotaRefreshStatus: string | undefined;
	loginFlow:
	while (true) {
		let existingStorage = await loadAccounts();
		if (existingStorage && existingStorage.accounts.length > 0) {
			while (true) {
				existingStorage = await loadAccounts();
				if (!existingStorage || existingStorage.accounts.length === 0) {
					break;
				}
				const currentStorage = existingStorage;
				const displaySettings = await loadDashboardDisplaySettings();
				applyUiThemeFromDashboardSettings(displaySettings);
				const quotaCache = await loadQuotaCache();
				const shouldAutoFetchLimits = displaySettings.menuAutoFetchLimits ?? true;
				const showFetchStatus = displaySettings.menuShowFetchStatus ?? true;
				const quotaTtlMs = displaySettings.menuQuotaTtlMs ?? DEFAULT_MENU_QUOTA_REFRESH_TTL_MS;
				if (shouldAutoFetchLimits && !pendingMenuQuotaRefresh) {
					const staleCount = countMenuQuotaRefreshTargets(currentStorage, quotaCache, quotaTtlMs);
					if (staleCount > 0) {
						if (showFetchStatus) {
							menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [0/${staleCount}]`;
						}
						pendingMenuQuotaRefresh = refreshQuotaCacheForMenu(
							currentStorage,
							quotaCache,
							quotaTtlMs,
							(current, total) => {
								if (!showFetchStatus) return;
								menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [${current}/${total}]`;
							},
						)
							.then(() => undefined)
							.catch(() => undefined)
							.finally(() => {
								menuQuotaRefreshStatus = undefined;
								pendingMenuQuotaRefresh = null;
							});
					}
				}
				const flaggedStorage = await loadFlaggedAccounts();

				const menuResult = await promptLoginMode(
					toExistingAccountInfo(currentStorage, quotaCache, displaySettings),
					{
						flaggedCount: flaggedStorage.accounts.length,
						statusMessage: showFetchStatus ? () => menuQuotaRefreshStatus : undefined,
					},
				);

				if (menuResult.mode === "cancel") {
					console.log("Cancelled.");
					return 0;
				}
				if (menuResult.mode === "check") {
					await runActionPanel("Quick Check", "Checking local session + live status", async () => {
						await runHealthCheck({ forceRefresh: false, liveProbe: true });
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "deep-check") {
					await runActionPanel("Deep Check", "Refreshing and testing all accounts", async () => {
						await runHealthCheck({ forceRefresh: true, liveProbe: true });
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "forecast") {
					await runActionPanel("Best Account", "Comparing accounts", async () => {
						await runForecast(["--live"]);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "fix") {
					await runActionPanel("Auto-Fix", "Checking and fixing common issues", async () => {
						await runFix(["--live"]);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "settings") {
					await configureUnifiedSettings(displaySettings);
					continue;
				}
				if (menuResult.mode === "verify-flagged") {
					await runActionPanel("Problem Account Check", "Checking problem accounts", async () => {
						await runVerifyFlagged([]);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "fresh" && menuResult.deleteAll) {
					await runActionPanel("Reset Accounts", "Deleting all saved accounts", async () => {
						await clearAccountsAndReset();
						console.log("Cleared saved accounts from active storage. Recovery snapshots remain available.");
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "manage") {
					const requiresInteractiveOAuth = typeof menuResult.refreshAccountIndex === "number";
					if (requiresInteractiveOAuth) {
						await handleManageAction(currentStorage, menuResult);
						continue;
					}
					await runActionPanel("Applying Change", "Updating selected account", async () => {
						await handleManageAction(currentStorage, menuResult);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "add") {
					break;
				}
			}
		}

		const refreshedStorage = await loadAccounts();
		const existingCount = refreshedStorage?.accounts.length ?? 0;
		let forceNewLogin = existingCount > 0;
		while (true) {
			const tokenResult = await runOAuthFlow(forceNewLogin);
			if (tokenResult.type !== "success") {
				if (isUserCancelledOAuth(tokenResult)) {
					if (existingCount > 0) {
						console.log(stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"));
						continue loginFlow;
					}
					console.log("Cancelled.");
					return 0;
				}
				console.error(`Login failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`);
				return 1;
			}

			const resolved = resolveAccountSelection(tokenResult);
			await persistAccountPool([resolved], false);
			await syncSelectionToCodex(resolved);

			const latestStorage = await loadAccounts();
			const count = latestStorage?.accounts.length ?? 1;
			console.log(`Added account. Total: ${count}`);
			if (count >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
				console.log(`Reached maximum account limit (${ACCOUNT_LIMITS.MAX_ACCOUNTS}).`);
				break;
			}

			const addAnother = await promptAddAnotherAccount(count);
			if (!addAnother) break;
			forceNewLogin = true;
		}
		continue loginFlow;
	}
}

async function runSwitch(args: string[]): Promise<number> {
	setStoragePath(null);
	const indexArg = args[0];
	if (!indexArg) {
		console.error("Missing index. Usage: codex auth switch <index>");
		return 1;
	}
	const parsed = Number.parseInt(indexArg, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		console.error(`Invalid index: ${indexArg}`);
		return 1;
	}
	const targetIndex = parsed - 1;

	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.error("No accounts configured.");
		return 1;
	}
	if (targetIndex < 0 || targetIndex >= storage.accounts.length) {
		console.error(`Index out of range. Valid range: 1-${storage.accounts.length}`);
		return 1;
	}

	const account = storage.accounts[targetIndex];
	if (!account) {
		console.error(`Account ${parsed} not found.`);
		return 1;
	}

	storage.activeIndex = targetIndex;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		storage.activeIndexByFamily[family] = targetIndex;
	}
	const wasDisabled = account.enabled === false;
	if (wasDisabled) {
		account.enabled = true;
	}
	const switchNow = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken: string | undefined;

	if (!hasUsableAccessToken(account, switchNow)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type === "success") {
			const tokenAccountId = extractAccountId(refreshResult.access);
			const nextEmail = sanitizeEmail(extractAccountEmail(refreshResult.access, refreshResult.idToken));
			if (account.refreshToken !== refreshResult.refresh) {
				account.refreshToken = refreshResult.refresh;
			}
			if (account.accessToken !== refreshResult.access) {
				account.accessToken = refreshResult.access;
			}
			if (account.expiresAt !== refreshResult.expires) {
				account.expiresAt = refreshResult.expires;
			}
			if (nextEmail && nextEmail !== account.email) {
				account.email = nextEmail;
			}
			if (tokenAccountId && tokenAccountId !== account.accountId) {
				account.accountId = tokenAccountId;
				account.accountIdSource = "token";
			}
			syncAccessToken = refreshResult.access;
			syncRefreshToken = refreshResult.refresh;
			syncExpiresAt = refreshResult.expires;
			syncIdToken = refreshResult.idToken;
		} else {
			console.warn(
				`Switch validation refresh failed for account ${parsed}: ${normalizeFailureDetail(refreshResult.message, refreshResult.reason)}.`,
			);
		}
	}

	account.lastUsed = switchNow;
	account.lastSwitchReason = "rotation";
	await saveAccounts(storage);

	const synced = await setCodexCliActiveSelection({
		accountId: account.accountId,
		email: account.email,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
	if (!synced) {
		console.warn(
			`Switched account ${parsed} locally, but Codex auth sync did not complete. Multi-auth routing will still use this account.`,
		);
	}

	console.log(
		`Switched to account ${parsed}: ${formatAccountLabel(account, targetIndex)}${wasDisabled ? " (re-enabled)" : ""}`,
	);
	return 0;
}

export async function autoSyncActiveAccountToCodex(): Promise<boolean> {
	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		return false;
	}

	const activeIndex = resolveActiveIndex(storage, "codex");
	if (activeIndex < 0 || activeIndex >= storage.accounts.length) {
		return false;
	}

	const account = storage.accounts[activeIndex];
	if (!account) {
		return false;
	}

	const now = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken: string | undefined;
	let changed = false;

	if (!hasUsableAccessToken(account, now)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type === "success") {
			const tokenAccountId = extractAccountId(refreshResult.access);
			const nextEmail = sanitizeEmail(extractAccountEmail(refreshResult.access, refreshResult.idToken));
			if (account.refreshToken !== refreshResult.refresh) {
				account.refreshToken = refreshResult.refresh;
				changed = true;
			}
			if (account.accessToken !== refreshResult.access) {
				account.accessToken = refreshResult.access;
				changed = true;
			}
			if (account.expiresAt !== refreshResult.expires) {
				account.expiresAt = refreshResult.expires;
				changed = true;
			}
			if (nextEmail && nextEmail !== account.email) {
				account.email = nextEmail;
				changed = true;
			}
			if (tokenAccountId && tokenAccountId !== account.accountId) {
				account.accountId = tokenAccountId;
				account.accountIdSource = "token";
				changed = true;
			}
			syncAccessToken = refreshResult.access;
			syncRefreshToken = refreshResult.refresh;
			syncExpiresAt = refreshResult.expires;
			syncIdToken = refreshResult.idToken;
		}
	}

	if (changed) {
		await saveAccounts(storage);
	}

	return setCodexCliActiveSelection({
		accountId: account.accountId,
		email: account.email,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
}

export async function runCodexMultiAuthCli(rawArgs: string[]): Promise<number> {
	const startupDisplaySettings = await loadDashboardDisplaySettings();
	applyUiThemeFromDashboardSettings(startupDisplaySettings);

	const args = [...rawArgs];
	if (args.length === 0) {
		printUsage();
		return 0;
	}
	if (args[0] === "--help" || args[0] === "-h") {
		printUsage();
		return 0;
	}

	const [root, sub, ...rest] = args;
	if (root !== "auth") {
		printUsage();
		return 1;
	}

	const command = sub ?? "login";
	if (command === "--help" || command === "-h") {
		printUsage();
		return 0;
	}
	if (command === "login") {
		return runAuthLogin();
	}
	if (command === "list" || command === "status") {
		await showAccountStatus();
		return 0;
	}
	if (command === "switch") {
		return runSwitch(rest);
	}
	if (command === "check") {
		await runHealthCheck({ liveProbe: true });
		return 0;
	}
	if (command === "features") {
		return runFeaturesReport();
	}
	if (command === "verify-flagged") {
		return runVerifyFlagged(rest);
	}
	if (command === "forecast") {
		return runForecast(rest);
	}
	if (command === "report") {
		return runReport(rest);
	}
	if (command === "fix") {
		return runFix(rest);
	}
	if (command === "doctor") {
		return runDoctor(rest);
	}

	console.error(`Unknown command: ${command}`);
	printUsage();
	return 1;
}
