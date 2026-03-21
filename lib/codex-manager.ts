import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	formatWaitTime,
	getAccountIdCandidates,
	resolveRequestAccountId,
	sanitizeEmail,
	selectBestAccountCandidate,
	shouldUpdateAccountIdFromToken,
} from "./accounts.js";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	REDIRECT_URI,
} from "./auth/auth.js";
import {
	copyTextToClipboard,
	isBrowserLaunchSuppressed,
	openBrowserUrl,
} from "./auth/browser.js";
import { startLocalOAuthServer } from "./auth/server.js";
import {
	type ExistingAccountInfo,
	promptAddAnotherAccount,
	promptLoginMode,
} from "./cli.js";
import {
	getCodexCliAuthPath,
	getCodexCliConfigPath,
	loadCodexCliState,
} from "./codex-cli/state.js";
import { setCodexCliActiveSelection } from "./codex-cli/writer.js";
import {
	type BestCliOptions,
	runBestCommand,
} from "./codex-manager/commands/best.js";
import { runCheckCommand } from "./codex-manager/commands/check.js";
import { runConfigExplainCommand } from "./codex-manager/commands/config-explain.js";
import {
	type DoctorCliOptions,
	runDoctorCommand,
} from "./codex-manager/commands/doctor.js";
import {
	type FixCliOptions,
	runFixCommand,
} from "./codex-manager/commands/fix.js";
import { runForecastCommand } from "./codex-manager/commands/forecast.js";
import { runReportCommand } from "./codex-manager/commands/report.js";
import {
	runFeaturesCommand,
	runStatusCommand,
} from "./codex-manager/commands/status.js";
import { runSwitchCommand } from "./codex-manager/commands/switch.js";
import {
	runVerifyFlaggedCommand,
	type VerifyFlaggedCliOptions,
} from "./codex-manager/commands/verify-flagged.js";
import {
	applyUiThemeFromDashboardSettings,
	configureUnifiedSettings,
	resolveMenuLayoutMode,
} from "./codex-manager/settings-hub.js";
import { getPluginConfigExplainReport } from "./config.js";
import { ACCOUNT_LIMITS } from "./constants.js";
import {
	type DashboardAccountSortMode,
	type DashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	loadDashboardDisplaySettings,
} from "./dashboard-settings.js";
import {
	evaluateForecastAccounts,
	type ForecastAccountResult,
	isHardRefreshFailure,
	recommendForecastAccount,
	summarizeForecast,
} from "./forecast.js";
import { createLogger } from "./logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import {
	loadQuotaCache,
	type QuotaCacheData,
	type QuotaCacheEntry,
	saveQuotaCache,
} from "./quota-cache.js";
import {
	type CodexQuotaSnapshot,
	fetchCodexQuotaSnapshot,
	formatQuotaSnapshotLine,
} from "./quota-probe.js";
import { queuedRefresh } from "./refresh-queue.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	clearAccounts,
	type FlaggedAccountMetadataV1,
	findMatchingAccountIndex,
	formatStorageErrorHint,
	getNamedBackups,
	getStoragePath,
	loadAccounts,
	loadFlaggedAccounts,
	type NamedBackupSummary,
	restoreAccountsFromBackup,
	StorageError,
	saveAccounts,
	saveFlaggedAccounts,
	setStoragePath,
	withAccountAndFlaggedStorageTransaction,
	withAccountStorageTransaction,
} from "./storage.js";
import type { AccountIdSource, TokenResult } from "./types.js";
import { ANSI } from "./ui/ansi.js";
import { confirm } from "./ui/confirm.js";
import { UI_COPY } from "./ui/copy.js";
import { paintUiText, quotaToneFromLeftPercent } from "./ui/format.js";
import { getUiRuntimeOptions } from "./ui/runtime.js";
import { type MenuItem, select } from "./ui/select.js";

type TokenSuccess = Extract<TokenResult, { type: "success" }>;
type TokenSuccessWithAccount = TokenSuccess & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
};
type PromptTone = "accent" | "success" | "warning" | "danger" | "muted";
const log = createLogger("codex-manager");

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
	const legacyCode =
		tone === "accent"
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

	const directMessage =
		typeof record.message === "string"
			? collapseWhitespace(record.message)
			: "";
	const directCode =
		typeof record.code === "string" ? collapseWhitespace(record.code) : "";
	if (directMessage) {
		if (
			directCode &&
			!directMessage.toLowerCase().includes(directCode.toLowerCase())
		) {
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
	const bounded =
		normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
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
	const rendered = segments.map((segment) =>
		stylePromptText(segment.text, segment.tone),
	);
	return `${stylePromptText("Result:", "accent")} ${joinStyledSegments(rendered)}`;
}

function styleQuotaSummary(summary: string): string {
	const normalized = collapseWhitespace(summary);
	if (!normalized) return stylePromptText(summary, "muted");
	const segments = normalized
		.split("|")
		.map((segment) => segment.trim())
		.filter(Boolean);
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

function styleAccountDetailText(
	detail: string,
	fallbackTone: PromptTone = "muted",
): string {
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
		const suffixTone: PromptTone =
			/re-login|stale|warning|retry|fallback/i.test(suffix)
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
	if (/re-login|stale|warning|fallback/i.test(compact))
		return stylePromptText(compact, "warning");
	if (/failed|error/i.test(compact)) return stylePromptText(compact, "danger");
	if (/ok|working|succeeded|valid/i.test(compact))
		return stylePromptText(compact, "success");
	return stylePromptText(compact, fallbackTone);
}

function riskTone(
	level: ForecastAccountResult["riskLevel"],
): "success" | "warning" | "danger" {
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
			"  codex auth login [--manual|--no-browser]",
			"  codex auth list",
			"  codex auth status",
			"  codex auth switch <index>",
			"  codex auth best [--live] [--json] [--model <model>]",
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

type AuthLoginOptions = {
	manual: boolean;
};

type ParsedAuthLoginArgs =
	| { ok: true; options: AuthLoginOptions }
	| { ok: false; message: string };

function parseAuthLoginArgs(args: string[]): ParsedAuthLoginArgs {
	const options: AuthLoginOptions = {
		manual: false,
	};

	for (const arg of args) {
		if (arg === "--manual" || arg === "--no-browser") {
			options.manual = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			printUsage();
			return { ok: false, message: "" };
		}
		return {
			ok: false,
			message: `Unknown login option: ${arg}`,
		};
	}

	return { ok: true, options };
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
	{ id: 41, name: "Auto-switch to best account command" },
];

function resolveActiveIndex(
	storage: AccountStorageV3,
	family: ModelFamily = "codex",
): number {
	const total = storage.accounts.length;
	if (total === 0) return 0;
	const rawCandidate =
		storage.activeIndexByFamily?.[family] ?? storage.activeIndex;
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

function normalizeQuotaAccountId(accountId: string | undefined): string | null {
	if (typeof accountId !== "string") return null;
	const trimmed = accountId.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function hasUniqueQuotaAccountId(
	accounts: readonly Pick<AccountMetadataV3, "accountId">[],
	account: Pick<AccountMetadataV3, "accountId">,
): boolean {
	const accountId = normalizeQuotaAccountId(account.accountId);
	if (!accountId) return false;
	let matchCount = 0;
	for (const candidate of accounts) {
		if (normalizeQuotaAccountId(candidate.accountId) !== accountId) continue;
		matchCount += 1;
		if (matchCount > 1) return false;
	}
	return matchCount === 1;
}

type QuotaEmailFallbackState = {
	matchingCount: number;
	distinctAccountIds: Set<string>;
};

function buildQuotaEmailFallbackState(
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
): ReadonlyMap<string, QuotaEmailFallbackState> {
	const stateByEmail = new Map<string, QuotaEmailFallbackState>();
	for (const account of accounts) {
		const email = normalizeQuotaEmail(account.email);
		if (!email) continue;
		const existing = stateByEmail.get(email);
		if (existing) {
			existing.matchingCount += 1;
			const accountId = normalizeQuotaAccountId(account.accountId);
			if (accountId) {
				existing.distinctAccountIds.add(accountId);
			}
			continue;
		}
		const distinctAccountIds = new Set<string>();
		const accountId = normalizeQuotaAccountId(account.accountId);
		if (accountId) {
			distinctAccountIds.add(accountId);
		}
		stateByEmail.set(email, {
			matchingCount: 1,
			distinctAccountIds,
		});
	}
	return stateByEmail;
}

function hasSafeQuotaEmailFallback(
	emailFallbackState: ReadonlyMap<string, QuotaEmailFallbackState>,
	account: Pick<AccountMetadataV3, "email">,
): boolean {
	const email = normalizeQuotaEmail(account.email);
	if (!email) return false;
	const state = emailFallbackState.get(email);
	if (!state) return false;
	// size > 1 only matters when multiple accounts share the same email but
	// disagree on accountId; a single matching account already implies size <= 1.
	if (state.distinctAccountIds.size > 1) return false;
	return state.matchingCount === 1;
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

function formatCompactQuotaWindowLabel(
	windowMinutes: number | undefined,
): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

function formatCompactQuotaPart(
	windowMinutes: number | undefined,
	usedPercent: number | undefined,
): string | null {
	const label = formatCompactQuotaWindowLabel(windowMinutes);
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return null;
	}
	const left = quotaLeftPercentFromUsed(usedPercent);
	return `${label} ${left}%`;
}

function quotaLeftPercentFromUsed(
	usedPercent: number | undefined,
): number | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return undefined;
	}
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function formatCompactQuotaSnapshot(snapshot: CodexQuotaSnapshot): string {
	const parts = [
		formatCompactQuotaPart(
			snapshot.primary.windowMinutes,
			snapshot.primary.usedPercent,
		),
		formatCompactQuotaPart(
			snapshot.secondary.windowMinutes,
			snapshot.secondary.usedPercent,
		),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
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
		formatCompactQuotaPart(
			entry.primary.windowMinutes,
			entry.primary.usedPercent,
		),
		formatCompactQuotaPart(
			entry.secondary.windowMinutes,
			entry.secondary.usedPercent,
		),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
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
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): QuotaCacheEntry | null {
	const accountId = normalizeQuotaAccountId(account.accountId);
	if (
		accountId &&
		hasUniqueQuotaAccountId(accounts, account) &&
		cache.byAccountId[accountId]
	) {
		return cache.byAccountId[accountId] ?? null;
	}
	const email = normalizeQuotaEmail(account.email);
	if (
		email &&
		hasSafeQuotaEmailFallback(emailFallbackState, account) &&
		cache.byEmail[email]
	) {
		return cache.byEmail[email] ?? null;
	}
	return null;
}

function updateQuotaCacheForAccount(
	cache: QuotaCacheData,
	account: Pick<AccountMetadataV3, "accountId" | "email">,
	snapshot: CodexQuotaSnapshot,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
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
	const accountId = normalizeQuotaAccountId(account.accountId);
	const hasUniqueAccountId =
		accountId !== null && hasUniqueQuotaAccountId(accounts, account);
	if (hasUniqueAccountId) {
		cache.byAccountId[accountId] = nextEntry;
		changed = true;
	}
	const email = normalizeQuotaEmail(account.email);
	if (
		email &&
		hasSafeQuotaEmailFallback(emailFallbackState, account) &&
		!hasUniqueAccountId
	) {
		cache.byEmail[email] = nextEntry;
		changed = true;
	} else if (email && cache.byEmail[email]) {
		delete cache.byEmail[email];
		changed = true;
	}
	return changed;
}

function cloneQuotaCacheData(cache: QuotaCacheData): QuotaCacheData {
	// Shallow spreading is safe because quota cache entries are always replaced,
	// never mutated in-place.
	return {
		byAccountId: { ...cache.byAccountId },
		byEmail: { ...cache.byEmail },
	};
}

function pruneUnsafeQuotaEmailCacheEntry(
	cache: QuotaCacheData,
	email: string | undefined,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): boolean {
	const normalizedEmail = normalizeQuotaEmail(email);
	if (!normalizedEmail || !cache.byEmail[normalizedEmail]) {
		return false;
	}
	const hasSafeFallbackAccount = accounts.some(
		(account) =>
			normalizeQuotaEmail(account.email) === normalizedEmail &&
			hasSafeQuotaEmailFallback(emailFallbackState, account),
	);
	if (hasSafeFallbackAccount) {
		return false;
	}
	delete cache.byEmail[normalizedEmail];
	return true;
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
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): { accountId: string; accessToken: string } | null {
	if (account.enabled === false) return null;
	if (!hasUsableAccessToken(account, now)) return null;

	const existing = getQuotaCacheEntryForAccount(
		cache,
		account,
		accounts,
		emailFallbackState,
	);
	if (
		existing &&
		typeof existing.updatedAt === "number" &&
		Number.isFinite(existing.updatedAt) &&
		now - existing.updatedAt < maxAgeMs
	) {
		return null;
	}

	// Menu auto-refresh is cache-backed, so only probe when the result can be
	// written behind a safe lookup key for later reuse.
	const canStore =
		(normalizeQuotaAccountId(account.accountId) !== null &&
			hasUniqueQuotaAccountId(accounts, account)) ||
		hasSafeQuotaEmailFallback(emailFallbackState, account);
	if (!canStore) return null;

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
	emailFallbackState = buildQuotaEmailFallbackState(storage.accounts),
): MenuQuotaProbeTarget[] {
	const targets: MenuQuotaProbeTarget[] = [];
	for (const account of storage.accounts) {
		const probeInput = resolveMenuQuotaProbeInput(
			account,
			cache,
			maxAgeMs,
			now,
			storage.accounts,
			emailFallbackState,
		);
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
	const emailFallbackState = buildQuotaEmailFallbackState(storage.accounts);
	let count = 0;
	for (const account of storage.accounts) {
		if (
			resolveMenuQuotaProbeInput(
				account,
				cache,
				maxAgeMs,
				now,
				storage.accounts,
				emailFallbackState,
			)
		) {
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

	const emailFallbackState = buildQuotaEmailFallbackState(storage.accounts);
	const nextCache = cloneQuotaCacheData(cache);
	const now = Date.now();
	const targets = collectMenuQuotaRefreshTargets(
		storage,
		nextCache,
		maxAgeMs,
		now,
		emailFallbackState,
	);
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
			changed =
				updateQuotaCacheForAccount(
					nextCache,
					target.account,
					snapshot,
					storage.accounts,
					emailFallbackState,
				) || changed;
		} catch {
			// Keep existing cached values if probing fails.
		}
	}

	if (changed) {
		await saveQuotaCache(nextCache);
	}

	return nextCache;
}

const ACCESS_TOKEN_FRESH_WINDOW_MS = 5 * 60 * 1000;

function hasUsableAccessToken(
	account: Pick<AccountMetadataV3, "accessToken" | "expiresAt">,
	now: number,
): boolean {
	if (!account.accessToken) return false;
	if (
		typeof account.expiresAt !== "number" ||
		!Number.isFinite(account.expiresAt)
	)
		return false;
	return account.expiresAt - now > ACCESS_TOKEN_FRESH_WINDOW_MS;
}

function hasLikelyInvalidRefreshToken(
	refreshToken: string | undefined,
): boolean {
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
	if (
		typeof account.coolingDownUntil === "number" &&
		account.coolingDownUntil > now
	) {
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
	const match = summary.match(
		new RegExp(`(?:^|\\|)\\s*${windowLabel}\\s+(\\d{1,3})%`, "i"),
	);
	const value = Number.parseInt(match?.[1] ?? "", 10);
	if (!Number.isFinite(value)) return -1;
	return Math.max(0, Math.min(100, value));
}

function readQuotaLeftPercent(
	account: ExistingAccountInfo,
	windowLabel: "5h" | "7d",
): number {
	const direct =
		windowLabel === "5h"
			? account.quota5hLeftPercent
			: account.quota7dLeftPercent;
	if (typeof direct === "number" && Number.isFinite(direct)) {
		return Math.max(0, Math.min(100, Math.round(direct)));
	}
	return parseLeftPercentFromQuotaSummary(account.quotaSummary, windowLabel);
}

function accountStatusSortBucket(
	status: ExistingAccountInfo["status"],
): number {
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

	const bucketDelta =
		accountStatusSortBucket(left.status) -
		accountStatusSortBucket(right.status);
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
		displaySettings.menuSortEnabled ??
		DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
		true;
	const sortMode: DashboardAccountSortMode =
		displaySettings.menuSortMode ??
		DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
		"ready-first";
	if (!sortEnabled || sortMode !== "ready-first") {
		return [...accounts];
	}

	const sorted = [...accounts].sort(compareReadyFirstAccounts);
	const pinCurrent =
		displaySettings.menuSortPinCurrent ??
		DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
		false;
	if (pinCurrent) {
		const currentIndex = sorted.findIndex(
			(account) => account.isCurrentAccount,
		);
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
	const emailFallbackState = buildQuotaEmailFallbackState(storage.accounts);
	const baseAccounts = storage.accounts.map((account, index) => {
		const entry = quotaCache
			? getQuotaCacheEntryForAccount(
					quotaCache,
					account,
					storage.accounts,
					emailFallbackState,
				)
			: null;
		return {
			index,
			sourceIndex: index,
			accountId: account.accountId,
			accountLabel: account.accountLabel,
			email: account.email,
			addedAt: account.addedAt,
			lastUsed: account.lastUsed,
			status: mapAccountStatus(account, index, activeIndex, now),
			quotaSummary:
				(displaySettings.menuShowQuotaSummary ?? true) && entry
					? formatAccountQuotaSummary(entry)
					: undefined,
			quota5hLeftPercent: quotaLeftPercentFromUsed(entry?.primary.usedPercent),
			quota5hResetAtMs: entry?.primary.resetAtMs,
			quota7dLeftPercent: quotaLeftPercentFromUsed(
				entry?.secondary.usedPercent,
			),
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
			statuslineFields: displaySettings.menuStatuslineFields ?? [
				"last-used",
				"limits",
				"status",
			],
		};
	});
	const orderedAccounts = applyAccountMenuOrdering(
		baseAccounts,
		displaySettings,
	);
	const quickSwitchUsesVisibleRows =
		displaySettings.menuSortQuickSwitchVisibleRow ?? true;
	return orderedAccounts.map((account, displayIndex) => ({
		...account,
		index: displayIndex,
		quickSwitchNumber: quickSwitchUsesVisibleRows
			? displayIndex + 1
			: (account.sourceIndex ?? displayIndex) + 1,
	}));
}

function resolveAccountSelection(
	tokens: TokenSuccess,
): TokenSuccessWithAccount {
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

function resolveStoredAccountIdentity(
	storedAccountId: string | undefined,
	storedAccountIdSource: AccountIdSource | undefined,
	tokenAccountId: string | undefined,
): { accountId?: string; accountIdSource?: AccountIdSource } {
	const accountId = resolveRequestAccountId(
		storedAccountId,
		storedAccountIdSource,
		tokenAccountId,
	);
	if (!accountId) {
		return {};
	}

	if (!shouldUpdateAccountIdFromToken(storedAccountIdSource, storedAccountId)) {
		return {
			accountId,
			accountIdSource: storedAccountIdSource,
		};
	}

	return {
		accountId,
		accountIdSource:
			accountId === tokenAccountId ? "token" : storedAccountIdSource,
	};
}

function applyTokenAccountIdentity(
	account: { accountId?: string; accountIdSource?: AccountIdSource },
	tokenAccountId: string | undefined,
): boolean {
	const nextIdentity = resolveStoredAccountIdentity(
		account.accountId,
		account.accountIdSource,
		tokenAccountId,
	);
	if (!nextIdentity.accountId) {
		return false;
	}
	if (
		nextIdentity.accountId === account.accountId &&
		nextIdentity.accountIdSource === account.accountIdSource
	) {
		return false;
	}

	account.accountId = nextIdentity.accountId;
	account.accountIdSource = nextIdentity.accountIdSource;
	return true;
}

async function promptManualCallback(
	state: string,
	options: { allowNonTty?: boolean } = {},
): Promise<string | null> {
	const useInteractivePrompt = input.isTTY && output.isTTY;
	if (!useInteractivePrompt && !options.allowNonTty) {
		return null;
	}

	const rl = createInterface({ input, output });
	try {
		if (useInteractivePrompt) {
			console.log("");
			console.log(stylePromptText(UI_COPY.oauth.pastePrompt, "accent"));
		}
		const answer = useInteractivePrompt
			? await rl.question("◆  ")
			: await new Promise<string | null>((resolve, reject) => {
					if (input.readableEnded || input.destroyed) {
						resolve(null);
						return;
					}
					let settled = false;
					const handleInputClosed = () => {
						if (settled) return;
						settled = true;
						input.off("end", handleInputClosed);
						input.off("close", handleInputClosed);
						resolve(null);
					};
					const finish = (value: string) => {
						if (settled) return;
						settled = true;
						input.off("end", handleInputClosed);
						input.off("close", handleInputClosed);
						resolve(value);
					};
					const fail = (error: unknown) => {
						if (settled) return;
						settled = true;
						input.off("end", handleInputClosed);
						input.off("close", handleInputClosed);
						reject(error);
					};
					rl.question("")
						.then((value) => finish(value))
						.catch((error) => {
							if (isAbortError(error) || isReadlineClosedError(error)) {
								handleInputClosed();
								return;
							}
							fail(error);
						});
					input.once("end", handleInputClosed);
					input.once("close", handleInputClosed);
				});
		if (answer === null) {
			return null;
		}
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
		if (isAbortError(error) || isReadlineClosedError(error)) {
			return null;
		}
		throw error;
	} finally {
		rl.close();
	}
}

function isReadlineClosedError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const errorCode =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code?: unknown }).code)
			: "";
	return (
		errorCode === "ERR_USE_AFTER_CLOSE" ||
		/readline was closed/i.test(error.message)
	);
}

type OAuthSignInMode = "browser" | "manual" | "restore-backup" | "cancel";
type BackupRestoreMode = "latest" | "manual" | "back";

export function formatBackupSavedAt(mtimeMs: number): string {
	return new Date(mtimeMs).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

async function promptOAuthSignInMode(
	backupOption: NamedBackupSummary | null,
	backupDiscoveryWarning: string | null = null,
): Promise<OAuthSignInMode> {
	if (!input.isTTY || !output.isTTY) {
		return "browser";
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<OAuthSignInMode>[] = [
		{
			label: UI_COPY.oauth.signInHeading,
			value: "cancel" as const,
			kind: "heading",
		},
		{ label: UI_COPY.oauth.openBrowser, value: "browser", color: "green" },
		{ label: UI_COPY.oauth.manualMode, value: "manual", color: "yellow" },
		...(backupOption
			? [
					{ separator: true, label: "", value: "cancel" as const },
					{
						label: UI_COPY.oauth.restoreHeading,
						value: "cancel" as const,
						kind: "heading" as const,
					},
					{
						label: UI_COPY.oauth.restoreSavedBackup,
						value: "restore-backup" as const,
						hint: UI_COPY.oauth.loadLastBackupHint(
							backupOption.fileName,
							backupOption.accountCount,
							formatBackupSavedAt(backupOption.mtimeMs),
						),
						color: "cyan" as const,
					},
				]
			: []),
		{ separator: true, label: "", value: "cancel" as const },
		{ label: UI_COPY.oauth.back, value: "cancel", color: "red" },
	];

	const selected = await select<OAuthSignInMode>(items, {
		message: UI_COPY.oauth.chooseModeTitle,
		subtitle: backupDiscoveryWarning
			? `${UI_COPY.oauth.chooseModeSubtitle} ${backupDiscoveryWarning}`
			: UI_COPY.oauth.chooseModeSubtitle,
		help: backupOption
			? UI_COPY.oauth.chooseModeHelpWithBackup
			: UI_COPY.oauth.chooseModeHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return "cancel";
			if (lower === "1") return "browser";
			if (lower === "2") return "manual";
			if (lower === "3" && backupOption) return "restore-backup";
			return undefined;
		},
	});

	return selected ?? "cancel";
}

async function promptBackupRestoreMode(
	latestBackup: NamedBackupSummary,
): Promise<BackupRestoreMode> {
	if (!input.isTTY || !output.isTTY) {
		return "latest";
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<BackupRestoreMode>[] = [
		{
			label: UI_COPY.oauth.loadLastBackup,
			value: "latest",
			hint: `${UI_COPY.oauth.restoreBackupLatestHint}\n${UI_COPY.oauth.manualBackupHint(
				latestBackup.accountCount,
				formatBackupSavedAt(latestBackup.mtimeMs),
			)}`,
			color: "cyan",
		},
		{
			label: UI_COPY.oauth.chooseBackupManually,
			value: "manual",
			color: "yellow",
		},
		{ label: UI_COPY.oauth.back, value: "back", color: "red" },
	];

	const selected = await select<BackupRestoreMode>(items, {
		message: UI_COPY.oauth.restoreBackupTitle,
		subtitle: UI_COPY.oauth.restoreBackupSubtitle,
		help: UI_COPY.oauth.restoreBackupHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return "back";
			if (lower === "1") return "latest";
			if (lower === "2") return "manual";
			return undefined;
		},
	});

	return selected ?? "back";
}

async function promptManualBackupSelection(
	backups: NamedBackupSummary[],
): Promise<NamedBackupSummary | null> {
	if (!input.isTTY || !output.isTTY) {
		return backups[0] ?? null;
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<NamedBackupSummary | null>[] = backups.map(
		(backup) => ({
			label: backup.fileName,
			value: backup,
			hint: UI_COPY.oauth.manualBackupHint(
				backup.accountCount,
				formatBackupSavedAt(backup.mtimeMs),
			),
			color: "cyan",
		}),
	);
	items.push({ label: UI_COPY.oauth.back, value: null, color: "red" });

	const selected = await select<NamedBackupSummary | null>(items, {
		message: UI_COPY.oauth.manualBackupTitle,
		subtitle: UI_COPY.oauth.manualBackupSubtitle,
		help: UI_COPY.oauth.manualBackupHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			if (raw.toLowerCase() === "q") return null;
			return undefined;
		},
	});

	return selected;
}

interface WaitForReturnOptions {
	promptText?: string;
	autoReturnMs?: number;
	pauseOnAnyKey?: boolean;
}

async function waitForMenuReturn(
	options: WaitForReturnOptions = {},
): Promise<void> {
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
			writeInlineStatus(UI_COPY.returnFlow.autoReturn(remainingSeconds));
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
		const question =
			promptText.length > 0 ? `${stylePromptText(promptText, "muted")} ` : "";
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
		previousLog(
			stylePromptText(
				stageText,
				failed ? "danger" : running ? "accent" : "success",
			),
		);
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
		if (running)
			previousLog(stylePromptText(UI_COPY.returnFlow.working, "muted"));
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
	output.write(
		ANSI.altScreenOff + ANSI.show + ANSI.clearScreen + ANSI.moveTo(1, 1),
	);
	if (failed) {
		throw failed;
	}
}

async function runOAuthFlow(
	forceNewLogin: boolean,
	signInMode: Extract<OAuthSignInMode, "browser" | "manual">,
): Promise<TokenResult> {
	const { pkce, state, url } = await createAuthorizationFlow({ forceNewLogin });
	let code: string | null = null;
	let oauthServer: Awaited<ReturnType<typeof startLocalOAuthServer>> | null =
		null;
	try {
		if (signInMode === "browser") {
			try {
				oauthServer = await startLocalOAuthServer({ state });
			} catch (serverError) {
				log.warn(
					"Local OAuth callback server unavailable; falling back to manual callback entry.",
					serverError instanceof Error
						? {
								message: serverError.message,
								stack: serverError.stack,
								code:
									typeof serverError === "object" &&
									serverError !== null &&
									"code" in serverError
										? String(serverError.code)
										: undefined,
							}
						: { error: String(serverError) },
				);
				oauthServer = null;
			}
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

		const waitingForCallback =
			signInMode === "browser" && oauthServer?.ready === true;
		if (waitingForCallback && oauthServer) {
			console.log(stylePromptText(UI_COPY.oauth.waitingCallback, "muted"));
			const callbackResult = await oauthServer.waitForCode(state);
			code = callbackResult?.code ?? null;
		}

		if (!code) {
			console.log(
				stylePromptText(
					waitingForCallback
						? UI_COPY.oauth.callbackMissed
						: signInMode === "manual"
							? UI_COPY.oauth.callbackBypassed
							: UI_COPY.oauth.callbackUnavailable,
					"warning",
				),
			);
			code = await promptManualCallback(state, {
				allowNonTty: signInMode === "manual",
			});
		}
	} finally {
		oauthServer?.close();
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
				? (result.accountIdSource ??
					(result.accountIdOverride ? "manual" : "token"))
				: undefined;
			const accountLabel = result.accountLabel;
			const accountEmail = sanitizeEmail(
				extractAccountEmail(result.access, result.idToken),
			);
			const existingIndex = findMatchingAccountIndex(
				accounts,
				{
					accountId,
					email: accountEmail,
					refreshToken: result.refresh,
				},
				{
					allowUniqueAccountIdFallbackWithoutEmail: true,
				},
			);

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

		const fallbackActiveIndex =
			accounts.length === 0
				? 0
				: Math.max(0, Math.min(stored?.activeIndex ?? 0, accounts.length - 1));
		const nextActiveIndex =
			accounts.length === 0
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

async function syncSelectionToCodex(
	tokens: TokenSuccessWithAccount,
): Promise<void> {
	const tokenAccountId = extractAccountId(tokens.access);
	const accountId = resolveRequestAccountId(
		tokens.accountIdOverride,
		tokens.accountIdSource,
		tokenAccountId,
	);
	const email = sanitizeEmail(
		extractAccountEmail(tokens.access, tokens.idToken),
	);
	await setCodexCliActiveSelection({
		accountId,
		email,
		accessToken: tokens.access,
		refreshToken: tokens.refresh,
		expiresAt: tokens.expires,
		idToken: tokens.idToken,
	});
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
	const workingQuotaCache = quotaCache ? cloneQuotaCacheData(quotaCache) : null;
	let quotaCacheChanged = false;
	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.log("No accounts configured.");
		return;
	}
	let quotaEmailFallbackState =
		liveProbe && quotaCache
			? buildQuotaEmailFallbackState(storage.accounts)
			: null;

	let changed = false;
	let ok = 0;
	let failed = 0;
	let warnings = 0;
	const activeIndex = resolveActiveIndex(storage, "codex");
	let activeAccountRefreshed = false;
	const now = Date.now();
	console.log(
		stylePromptText(
			forceRefresh
				? `Checking ${storage.accounts.length} account(s) with full refresh test...`
				: `Checking ${storage.accounts.length} account(s) with quick check${liveProbe ? " + live check" : ""}...`,
			"accent",
		),
	);
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
					healthDetail =
						"signed in and working (live check skipped: missing account ID)";
				} else {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: currentAccessToken,
							model: probeModel,
						});
						if (workingQuotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(
									workingQuotaCache,
									account,
									snapshot,
									storage.accounts,
									quotaEmailFallbackState ?? undefined,
								) || quotaCacheChanged;
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
			const nextEmail = sanitizeEmail(
				extractAccountEmail(result.access, result.idToken),
			);
			const previousEmail = account.email;
			let accountIdentityChanged = false;
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
				accountIdentityChanged = true;
			}
			if (applyTokenAccountIdentity(account, tokenAccountId)) {
				changed = true;
				accountIdentityChanged = true;
			}
			if (account.enabled === false) {
				account.enabled = true;
				changed = true;
			}
			if (accountIdentityChanged && liveProbe && workingQuotaCache) {
				quotaEmailFallbackState = buildQuotaEmailFallbackState(
					storage.accounts,
				);
				quotaCacheChanged =
					pruneUnsafeQuotaEmailCacheEntry(
						workingQuotaCache,
						previousEmail,
						storage.accounts,
						quotaEmailFallbackState,
					) || quotaCacheChanged;
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
					healthyMessage =
						"working now (live check skipped: missing account ID)";
				} else {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: result.access,
							model: probeModel,
						});
						if (workingQuotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(
									workingQuotaCache,
									account,
									snapshot,
									storage.accounts,
									quotaEmailFallbackState ?? undefined,
								) || quotaCacheChanged;
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
		console.log(
			stylePromptText(
				"Per-account lines are hidden in dashboard settings.",
				"muted",
			),
		);
	}
	if (workingQuotaCache && quotaCacheChanged) {
		await saveQuotaCache(workingQuotaCache);
	}

	if (changed) {
		await saveAccounts(storage);
	}

	if (
		activeAccountRefreshed &&
		activeIndex >= 0 &&
		activeIndex < storage.accounts.length
	) {
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
	console.log(
		formatResultSummary([
			{ text: `${ok} working`, tone: "success" },
			{
				text: `${failed} need re-login`,
				tone: failed > 0 ? "danger" : "muted",
			},
			{
				text: `${warnings} warning${warnings === 1 ? "" : "s"}`,
				tone: warnings > 0 ? "warning" : "muted",
			},
		]),
	);
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

function printBestUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth best [--live] [--json] [--model <model>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend before switching",
			"  --json, -j         Print machine-readable JSON output",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
			"",
			"Behavior:",
			"  - Chooses the healthiest account using forecast scoring",
			"  - Switches to the recommended account when it is not already active",
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

function parseBestArgs(args: string[]): ParsedArgsResult<BestCliOptions> {
	const options: BestCliOptions = {
		live: false,
		json: false,
		model: "gpt-5-codex",
		modelProvided: false,
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
			options.modelProvided = true;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			options.modelProvided = true;
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

function parseVerifyFlaggedArgs(
	args: string[],
): ParsedArgsResult<VerifyFlaggedCliOptions> {
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

async function runForecast(args: string[]): Promise<number> {
	return runForecastCommand(args, {
		setStoragePath,
		loadAccounts,
		resolveActiveIndex,
		loadQuotaCache,
		saveQuotaCache,
		cloneQuotaCacheData,
		buildQuotaEmailFallbackState,
		updateQuotaCacheForAccount,
		hasUsableAccessToken,
		queuedRefresh,
		fetchCodexQuotaSnapshot,
		normalizeFailureDetail,
		formatAccountLabel,
		extractAccountId,
		evaluateForecastAccounts,
		summarizeForecast,
		recommendForecastAccount,
		stylePromptText,
		formatResultSummary,
		styleQuotaSummary,
		formatCompactQuotaSnapshot,
		availabilityTone,
		riskTone,
		formatWaitTime,
		defaultDisplay: DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		formatQuotaSnapshotLine,
	});
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
	const nextMatchIndex = findMatchingAccountIndex(
		storage.accounts,
		{
			accountId: candidateAccountId,
			email: candidateEmail,
			refreshToken: nextRefreshToken,
		},
		{
			allowUniqueAccountIdFallbackWithoutEmail: true,
		},
	);
	if (nextMatchIndex !== undefined) {
		return nextMatchIndex;
	}

	const flaggedMatchIndex = findMatchingAccountIndex(
		storage.accounts,
		{
			accountId: candidateAccountId,
			email: candidateEmail,
			refreshToken: flagged.refreshToken,
		},
		{
			allowUniqueAccountIdFallbackWithoutEmail: true,
		},
	);
	return flaggedMatchIndex ?? -1;
}

function upsertRecoveredFlaggedAccount(
	storage: AccountStorageV3,
	flagged: FlaggedAccountMetadataV1,
	refreshResult: TokenSuccess,
	now: number,
): { restored: boolean; changed: boolean; message: string } {
	const nextEmail =
		sanitizeEmail(
			extractAccountEmail(refreshResult.access, refreshResult.idToken),
		) ?? flagged.email;
	const tokenAccountId = extractAccountId(refreshResult.access);
	const { accountId: nextAccountId, accountIdSource: nextAccountIdSource } =
		resolveStoredAccountIdentity(
			flagged.accountId,
			flagged.accountIdSource,
			tokenAccountId,
		);
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
			return {
				restored: false,
				changed: false,
				message: "existing account entry is missing",
			};
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
		if (
			nextAccountId !== undefined &&
			(nextAccountId !== existing.accountId ||
				nextAccountIdSource !== existing.accountIdSource)
		) {
			existing.accountId = nextAccountId;
			existing.accountIdSource = nextAccountIdSource;
			changed = true;
		}
		if (existing.enabled === false) {
			existing.enabled = true;
			changed = true;
		}
		if (
			existing.accountLabel !== flagged.accountLabel &&
			flagged.accountLabel
		) {
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
		accountIdSource: nextAccountIdSource,
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
	const nextActive =
		total === 0 ? 0 : Math.max(0, Math.min(storage.activeIndex, total - 1));
	let changed = false;
	if (storage.activeIndex !== nextActive) {
		storage.activeIndex = nextActive;
		changed = true;
	}
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const raw = storage.activeIndexByFamily[family];
		const fallback = storage.activeIndex;
		const candidate =
			typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
		const clamped =
			total === 0 ? 0 : Math.max(0, Math.min(candidate, total - 1));
		if (storage.activeIndexByFamily[family] !== clamped) {
			storage.activeIndexByFamily[family] = clamped;
			changed = true;
		}
	}
	return changed;
}

function getDoctorRefreshTokenKey(refreshToken: unknown): string | undefined {
	if (typeof refreshToken !== "string") return undefined;
	const trimmed = refreshToken.trim();
	return trimmed || undefined;
}

function applyDoctorFixes(storage: AccountStorageV3): {
	changed: boolean;
	actions: DoctorFixAction[];
} {
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

		const refreshToken = getDoctorRefreshTokenKey(account.refreshToken);
		if (!refreshToken) continue;
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

	const enabledCount = storage.accounts.filter(
		(account) => account.enabled !== false,
	).length;
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

async function clearAccountsAndReset(): Promise<void> {
	await clearAccounts();
}

async function handleManageAction(
	storage: AccountStorageV3,
	menuResult: Awaited<ReturnType<typeof promptLoginMode>>,
): Promise<void> {
	if (typeof menuResult.switchAccountIndex === "number") {
		const index = menuResult.switchAccountIndex;
		await runSwitchCommand([String(index + 1)], {
			setStoragePath,
			loadAccounts,
			persistAndSyncSelectedAccount,
		});
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

		const signInMode = await promptOAuthSignInMode(null);
		if (signInMode === "cancel") {
			console.log(stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"));
			return;
		}
		if (signInMode !== "browser" && signInMode !== "manual") {
			return;
		}

		const tokenResult = await runOAuthFlow(true, signInMode);
		if (tokenResult.type !== "success") {
			console.error(
				`Refresh failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`,
			);
			return;
		}

		const resolved = resolveAccountSelection(tokenResult);
		await persistAccountPool([resolved], false);
		await syncSelectionToCodex(resolved);
		console.log(`Refreshed account ${idx + 1}.`);
	}
}

async function runAuthLogin(args: string[]): Promise<number> {
	const parsedArgs = parseAuthLoginArgs(args);
	if (!parsedArgs.ok) {
		if (parsedArgs.message) {
			console.error(parsedArgs.message);
			printUsage();
			return 1;
		}
		return 0;
	}

	const loginOptions = parsedArgs.options;
	setStoragePath(null);
	let pendingMenuQuotaRefresh: Promise<void> | null = null;
	let menuQuotaRefreshStatus: string | undefined;
	loginFlow: while (true) {
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
				const shouldAutoFetchLimits =
					displaySettings.menuAutoFetchLimits ?? true;
				const showFetchStatus = displaySettings.menuShowFetchStatus ?? true;
				const quotaTtlMs =
					displaySettings.menuQuotaTtlMs ?? DEFAULT_MENU_QUOTA_REFRESH_TTL_MS;
				if (shouldAutoFetchLimits && !pendingMenuQuotaRefresh) {
					const staleCount = countMenuQuotaRefreshTargets(
						currentStorage,
						quotaCache,
						quotaTtlMs,
					);
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
						statusMessage: showFetchStatus
							? () => menuQuotaRefreshStatus
							: undefined,
					},
				);

				if (menuResult.mode === "cancel") {
					console.log("Cancelled.");
					return 0;
				}
				if (menuResult.mode === "check") {
					await runActionPanel(
						"Quick Check",
						"Checking local session + live status",
						async () => {
							await runHealthCheck({ forceRefresh: false, liveProbe: true });
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "deep-check") {
					await runActionPanel(
						"Deep Check",
						"Refreshing and testing all accounts",
						async () => {
							await runHealthCheck({ forceRefresh: true, liveProbe: true });
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "forecast") {
					await runActionPanel(
						"Best Account",
						"Comparing accounts",
						async () => {
							await runForecast(["--live"]);
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "fix") {
					await runActionPanel(
						"Auto-Fix",
						"Checking and fixing common issues",
						async () => {
							await runFixCommand(["--live"], {
								setStoragePath,
								loadAccounts,
								parseFixArgs,
								printFixUsage,
								loadQuotaCache,
								saveQuotaCache,
								cloneQuotaCacheData,
								buildQuotaEmailFallbackState,
								updateQuotaCacheForAccount,
								pruneUnsafeQuotaEmailCacheEntry,
								resolveActiveIndex,
								hasUsableAccessToken,
								fetchCodexQuotaSnapshot,
								formatCompactQuotaSnapshot,
								normalizeFailureDetail,
								hasLikelyInvalidRefreshToken,
								queuedRefresh,
								sanitizeEmail,
								extractAccountEmail,
								extractAccountId,
								applyTokenAccountIdentity,
								isHardRefreshFailure,
								evaluateForecastAccounts,
								recommendForecastAccount,
								saveAccounts,
								formatAccountLabel,
								stylePromptText,
								formatResultSummary,
								styleAccountDetailText,
								defaultDisplay: DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
							});
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "settings") {
					await configureUnifiedSettings(displaySettings);
					continue;
				}
				if (menuResult.mode === "verify-flagged") {
					await runActionPanel(
						"Problem Account Check",
						"Checking problem accounts",
						async () => {
							await runVerifyFlaggedCommand([], {
								setStoragePath,
								loadFlaggedAccounts,
								loadAccounts,
								queuedRefresh,
								parseVerifyFlaggedArgs,
								printVerifyFlaggedUsage,
								createEmptyAccountStorage,
								upsertRecoveredFlaggedAccount,
								resolveStoredAccountIdentity,
								extractAccountId,
								extractAccountEmail,
								sanitizeEmail,
								normalizeFailureDetail,
								withAccountAndFlaggedStorageTransaction,
								normalizeDoctorIndexes,
								saveFlaggedAccounts,
								formatAccountLabel,
								stylePromptText,
								styleAccountDetailText,
								formatResultSummary,
							});
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "fresh" && menuResult.deleteAll) {
					await runActionPanel(
						"Reset Accounts",
						"Deleting all saved accounts",
						async () => {
							await clearAccountsAndReset();
							console.log(
								"Cleared saved accounts from active storage. Recovery snapshots remain available.",
							);
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "manage") {
					const requiresInteractiveOAuth =
						typeof menuResult.refreshAccountIndex === "number";
					if (requiresInteractiveOAuth) {
						await handleManageAction(currentStorage, menuResult);
						continue;
					}
					await runActionPanel(
						"Applying Change",
						"Updating selected account",
						async () => {
							await handleManageAction(currentStorage, menuResult);
						},
						displaySettings,
					);
					continue;
				}
				if (menuResult.mode === "add") {
					break;
				}
			}
		}

		const refreshedStorage = await loadAccounts();
		let existingCount = refreshedStorage?.accounts.length ?? 0;
		let forceNewLogin = existingCount > 0;
		let onboardingBackupDiscoveryWarning: string | null = null;
		const loadNamedBackupsForOnboarding = async (): Promise<
			NamedBackupSummary[]
		> => {
			if (existingCount > 0) {
				onboardingBackupDiscoveryWarning = null;
				return [];
			}
			try {
				onboardingBackupDiscoveryWarning = null;
				return await getNamedBackups();
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				log.debug("getNamedBackups failed, skipping restore option", {
					code,
					error: error instanceof Error ? error.message : String(error),
				});
				if (code && code !== "ENOENT") {
					onboardingBackupDiscoveryWarning =
						"Named backup discovery failed. Continuing with browser or manual sign-in only.";
					console.warn(onboardingBackupDiscoveryWarning);
				} else {
					onboardingBackupDiscoveryWarning = null;
				}
				return [];
			}
		};
		let namedBackups = await loadNamedBackupsForOnboarding();
		while (true) {
			const latestNamedBackup = namedBackups[0] ?? null;
			const preferManualMode =
				loginOptions.manual || isBrowserLaunchSuppressed();
			const signInMode = preferManualMode
				? "manual"
				: await promptOAuthSignInMode(
						latestNamedBackup,
						onboardingBackupDiscoveryWarning,
					);
			if (signInMode === "cancel") {
				if (existingCount > 0) {
					console.log(
						stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"),
					);
					continue loginFlow;
				}
				console.log("Cancelled.");
				return 0;
			}
			if (signInMode === "restore-backup") {
				const latestAvailableBackup = namedBackups[0] ?? null;
				if (!latestAvailableBackup) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}
				const restoreMode = await promptBackupRestoreMode(
					latestAvailableBackup,
				);
				if (restoreMode === "back") {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const selectedBackup =
					restoreMode === "manual"
						? await promptManualBackupSelection(namedBackups)
						: latestAvailableBackup;
				if (!selectedBackup) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const confirmed = await confirm(
					UI_COPY.oauth.restoreBackupConfirm(
						selectedBackup.fileName,
						selectedBackup.accountCount,
					),
				);
				if (!confirmed) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const displaySettings = await loadDashboardDisplaySettings();
				applyUiThemeFromDashboardSettings(displaySettings);
				try {
					await runActionPanel(
						"Load Backup",
						`Loading ${selectedBackup.fileName}`,
						async () => {
							const restoredStorage = await restoreAccountsFromBackup(
								selectedBackup.path,
								{ persist: false },
							);
							const targetIndex = resolveActiveIndex(restoredStorage);
							const { synced } = await persistAndSyncSelectedAccount({
								storage: restoredStorage,
								targetIndex,
								parsed: targetIndex + 1,
								switchReason: "restore",
								preserveActiveIndexByFamily: true,
							});
							console.log(
								UI_COPY.oauth.restoreBackupLoaded(
									selectedBackup.fileName,
									restoredStorage.accounts.length,
								),
							);
							if (!synced) {
								console.warn(UI_COPY.oauth.restoreBackupSyncWarning);
							}
						},
						displaySettings,
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (error instanceof StorageError) {
						console.error(formatStorageErrorHint(error, selectedBackup.path));
					} else {
						console.error(`Backup restore failed: ${message}`);
					}
					const storageAfterRestoreAttempt = await loadAccounts().catch(
						() => null,
					);
					if ((storageAfterRestoreAttempt?.accounts.length ?? 0) > 0) {
						continue loginFlow;
					}
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}
				continue loginFlow;
			}

			if (signInMode !== "browser" && signInMode !== "manual") {
				continue;
			}

			const tokenResult = await runOAuthFlow(forceNewLogin, signInMode);
			if (tokenResult.type !== "success") {
				if (isUserCancelledOAuth(tokenResult)) {
					if (existingCount > 0) {
						console.log(
							stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"),
						);
						continue loginFlow;
					}
					console.log("Cancelled.");
					return 0;
				}
				console.error(
					`Login failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`,
				);
				return 1;
			}

			const resolved = resolveAccountSelection(tokenResult);
			await persistAccountPool([resolved], false);
			await syncSelectionToCodex(resolved);

			const latestStorage = await loadAccounts();
			const count = latestStorage?.accounts.length ?? 1;
			existingCount = count;
			namedBackups = [];
			onboardingBackupDiscoveryWarning = null;
			console.log(`Added account. Total: ${count}`);
			if (count >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
				console.log(
					`Reached maximum account limit (${ACCOUNT_LIMITS.MAX_ACCOUNTS}).`,
				);
				break;
			}

			const addAnother = await promptAddAnotherAccount(count);
			if (!addAnother) break;
			forceNewLogin = true;
		}
	}
}

async function persistAndSyncSelectedAccount({
	storage,
	targetIndex,
	parsed,
	switchReason,
	initialSyncIdToken,
	preserveActiveIndexByFamily = false,
}: {
	storage: NonNullable<Awaited<ReturnType<typeof loadAccounts>>>;
	targetIndex: number;
	parsed: number;
	switchReason: "rotation" | "best" | "restore";
	initialSyncIdToken?: string;
	preserveActiveIndexByFamily?: boolean;
}): Promise<{ synced: boolean; wasDisabled: boolean }> {
	const account = storage.accounts[targetIndex];
	if (!account) {
		throw new Error(`Account ${parsed} not found.`);
	}

	const shouldPreserveActiveIndexByFamily =
		preserveActiveIndexByFamily &&
		!!storage.activeIndexByFamily &&
		targetIndex === storage.activeIndex;
	storage.activeIndex = targetIndex;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	if (shouldPreserveActiveIndexByFamily) {
		const maxIndex = Math.max(0, storage.accounts.length - 1);
		for (const family of MODEL_FAMILIES) {
			const raw = storage.activeIndexByFamily[family];
			const candidate =
				typeof raw === "number" && Number.isFinite(raw) ? raw : targetIndex;
			storage.activeIndexByFamily[family] = Math.max(
				0,
				Math.min(candidate, maxIndex),
			);
		}
	} else {
		storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
		for (const family of MODEL_FAMILIES) {
			storage.activeIndexByFamily[family] = targetIndex;
		}
	}
	const wasDisabled = account.enabled === false;
	if (wasDisabled) {
		account.enabled = true;
	}
	const switchNow = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken = initialSyncIdToken;

	if (!hasUsableAccessToken(account, switchNow)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type === "success") {
			const tokenAccountId = extractAccountId(refreshResult.access);
			const nextEmail = sanitizeEmail(
				extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
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
			applyTokenAccountIdentity(account, tokenAccountId);
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
	account.lastSwitchReason = switchReason;
	await saveAccounts(storage);

	const synced = await setCodexCliActiveSelection({
		accountId: account.accountId,
		email: account.email,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
	return { synced, wasDisabled };
}

async function runBest(args: string[]): Promise<number> {
	return runBestCommand(args, {
		setStoragePath,
		loadAccounts,
		saveAccounts,
		parseBestArgs,
		printBestUsage,
		resolveActiveIndex,
		hasUsableAccessToken,
		queuedRefresh,
		normalizeFailureDetail,
		extractAccountId,
		extractAccountEmail,
		sanitizeEmail,
		formatAccountLabel,
		fetchCodexQuotaSnapshot,
		evaluateForecastAccounts,
		recommendForecastAccount,
		persistAndSyncSelectedAccount,
		setCodexCliActiveSelection,
	});
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
			const nextEmail = sanitizeEmail(
				extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
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
			if (applyTokenAccountIdentity(account, tokenAccountId)) {
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
		return runAuthLogin(rest);
	}
	if (command === "list" || command === "status") {
		return runStatusCommand({
			setStoragePath,
			loadAccounts,
			resolveActiveIndex,
			formatRateLimitEntry,
		});
	}
	if (command === "switch") {
		return runSwitchCommand(rest, {
			setStoragePath,
			loadAccounts,
			persistAndSyncSelectedAccount,
		});
	}
	if (command === "check") {
		return runCheckCommand({ runHealthCheck });
	}
	if (command === "features") {
		return runFeaturesCommand({ implementedFeatures: IMPLEMENTED_FEATURES });
	}
	if (command === "verify-flagged") {
		return runVerifyFlaggedCommand(rest, {
			setStoragePath,
			loadFlaggedAccounts,
			loadAccounts,
			queuedRefresh,
			parseVerifyFlaggedArgs,
			printVerifyFlaggedUsage,
			createEmptyAccountStorage,
			upsertRecoveredFlaggedAccount,
			resolveStoredAccountIdentity,
			extractAccountId,
			extractAccountEmail,
			sanitizeEmail,
			normalizeFailureDetail,
			withAccountAndFlaggedStorageTransaction,
			normalizeDoctorIndexes,
			saveFlaggedAccounts,
			formatAccountLabel,
			stylePromptText,
			styleAccountDetailText,
			formatResultSummary,
		});
	}
	if (command === "forecast") {
		return runForecast(rest);
	}
	if (command === "best") {
		return runBest(rest);
	}
	if (command === "report") {
		return runReportCommand(rest, {
			setStoragePath,
			getStoragePath,
			loadAccounts,
			resolveActiveIndex,
			queuedRefresh,
			fetchCodexQuotaSnapshot,
			formatRateLimitEntry,
			normalizeFailureDetail,
		});
	}
	if (command === "fix") {
		return runFixCommand(rest, {
			setStoragePath,
			loadAccounts,
			parseFixArgs,
			printFixUsage,
			loadQuotaCache,
			saveQuotaCache,
			cloneQuotaCacheData,
			buildQuotaEmailFallbackState,
			updateQuotaCacheForAccount,
			pruneUnsafeQuotaEmailCacheEntry,
			resolveActiveIndex,
			hasUsableAccessToken,
			fetchCodexQuotaSnapshot,
			formatCompactQuotaSnapshot,
			normalizeFailureDetail,
			hasLikelyInvalidRefreshToken,
			queuedRefresh,
			sanitizeEmail,
			extractAccountEmail,
			extractAccountId,
			applyTokenAccountIdentity,
			isHardRefreshFailure,
			evaluateForecastAccounts,
			recommendForecastAccount,
			saveAccounts,
			formatAccountLabel,
			stylePromptText,
			formatResultSummary,
			styleAccountDetailText,
			defaultDisplay: DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		});
	}
	if (command === "doctor") {
		return runDoctorCommand(rest, {
			setStoragePath,
			getStoragePath,
			getCodexCliAuthPath,
			getCodexCliConfigPath,
			loadCodexCliState,
			parseDoctorArgs,
			printDoctorUsage,
			loadAccounts,
			applyDoctorFixes,
			saveAccounts,
			resolveActiveIndex,
			evaluateForecastAccounts,
			recommendForecastAccount,
			sanitizeEmail,
			extractAccountEmail,
			extractAccountId,
			hasPlaceholderEmail,
			hasLikelyInvalidRefreshToken,
			getDoctorRefreshTokenKey,
			hasUsableAccessToken,
			queuedRefresh,
			normalizeFailureDetail,
			applyTokenAccountIdentity,
			setCodexCliActiveSelection,
		});
	}
	if (command === "config") {
		const [subcommand, ...configArgs] = rest;
		if (subcommand === "explain") {
			return runConfigExplainCommand(configArgs, {
				getReport: getPluginConfigExplainReport,
			});
		}
		console.error(`Unknown config command: ${subcommand ?? "(missing)"}`);
		return 1;
	}

	console.error(`Unknown command: ${command}`);
	printUsage();
	return 1;
}
