import type { SelectOption } from "@opentui/core";
import {
	buildAuthAccountDetailViewModel,
	buildAuthDashboardViewModel,
	type AuthAccountViewModel,
	type AuthDashboardViewModel,
} from "../../lib/codex-manager/auth-ui-controller.js";
import { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } from "../../lib/dashboard-settings.js";

const DEFAULT_STATUSLINE_FIELDS = ["last-used", "limits", "status"] as const;

const ACCOUNT_ACTION_HOTKEYS = {
	back: "Q",
	toggle: "E",
	"set-current": "S",
	refresh: "R",
	delete: "D",
} as const;

export interface OpenTuiAccountDetailPanel {
	eyebrow: string;
	title: string;
	subtitle: string;
	metaLines: string[];
	actionLines: string[];
}

function sanitizeTerminalText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const ansiPattern = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");
	const controlPattern = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
	return value
		.replace(ansiPattern, "")
		.replace(controlPattern, "")
		.trim();
}

function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "never";
	const days = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toLocaleDateString();
}

function formatResetTime(timestamp: number | undefined): string {
	if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return "unknown";
	const time = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const now = new Date();
	const sameDay =
		now.getFullYear() === date.getFullYear() &&
		now.getMonth() === date.getMonth() &&
		now.getDate() === date.getDate();
	return sameDay ? time : `${time} ${date.toLocaleDateString()}`;
}

function formatLeftPercent(value: number | undefined): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatCompactQuotaSummary(summary: string): string {
	const parts = Array.from(summary.matchAll(/(\d+[hdm])\s+(\d{1,3})%/gi)).map((match) =>
		`${match[1]?.toLowerCase() ?? "quota"}${match[2] ?? ""}`
	);
	if (/rate-limited/i.test(summary)) {
		parts.push("limit");
	}
	if (parts.length > 0) {
		return Array.from(new Set(parts)).join(" ");
	}
	const sanitized = sanitizeTerminalText(summary);
	if (!sanitized) return "";
	if (/\berror\b|failed|invalid|expired/i.test(sanitized)) return "error";
	return sanitized
		.replace(/[(),:]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.slice(0, 3)
		.join(" ");
}

function resolveAccountIdentity(account: AuthAccountViewModel): string {
	const accountNumber = account.quickSwitchNumber ?? (account.index + 1);
	return (
		sanitizeTerminalText(account.email) ||
		sanitizeTerminalText(account.accountLabel) ||
		sanitizeTerminalText(account.accountId) ||
		`Account ${accountNumber}`
	);
}

function resolveStatusBadge(account: AuthAccountViewModel): string | null {
	if (account.showStatusBadge === false || !account.status) return null;
	switch (account.status) {
		case "active":
			return "[act]";
		case "rate-limited":
			return "[limit]";
		case "cooldown":
			return "[cool]";
		case "disabled":
			return "[off]";
		case "error":
			return "[err]";
		case "flagged":
			return "[flag]";
		default:
			return `[${account.status}]`;
	}
}

function resolveStatuslineFields(account: AuthAccountViewModel): readonly string[] {
	return account.statuslineFields && account.statuslineFields.length > 0
		? account.statuslineFields
		: DEFAULT_STATUSLINE_FIELDS;
}

function resolveAccountStateLine(account: AuthAccountViewModel): string {
	const stateParts: string[] = [account.status ?? "unknown"];
	if (account.isCurrentAccount) stateParts.push("current");
	if (account.enabled === false) {
		stateParts.push("paused");
	}
	if (account.quotaRateLimited) stateParts.push("limited");
	return `State: ${stateParts.join(" | ")}`;
}

function resolveQuotaDetailLines(account: AuthAccountViewModel): string[] {
	const lines: string[] = [];
	const quota5h = formatLeftPercent(account.quota5hLeftPercent);
	const quota7d = formatLeftPercent(account.quota7dLeftPercent);
	if (quota5h) {
		lines.push(`5h left ${quota5h} @ ${formatResetTime(account.quota5hResetAtMs)}`);
	}
	if (quota7d) {
		lines.push(`7d left ${quota7d} @ ${formatResetTime(account.quota7dResetAtMs)}`);
	}
	if (lines.length === 0 && account.quotaSummary) {
		lines.push(`Limits: ${sanitizeTerminalText(account.quotaSummary) ?? account.quotaSummary}`);
	}
	return lines;
}

function resolveAccountAlertLine(account: AuthAccountViewModel): string {
	if (account.quotaRateLimited) return "Alert: rate-limited";
	switch (account.status) {
		case "cooldown":
			return "Alert: cooldown active";
		case "disabled":
			return "Alert: excluded from rotation";
		case "error":
			return "Alert: re-login recommended";
		case "flagged":
			return "Alert: verify before reuse";
		case "active":
			return "Alert: current selection";
		default:
			return "Alert: ready";
	}
}

function resolveAccountActionHint(
	actionId: keyof typeof ACCOUNT_ACTION_HOTKEYS,
): string {
	switch (actionId) {
		case "back":
			return `${ACCOUNT_ACTION_HOTKEYS.back} Back`;
		case "toggle":
			return `${ACCOUNT_ACTION_HOTKEYS.toggle} Toggle rotation`;
		case "set-current":
			return `${ACCOUNT_ACTION_HOTKEYS["set-current"]} Set current`;
		case "refresh":
			return `${ACCOUNT_ACTION_HOTKEYS.refresh} Re-login OAuth`;
		case "delete":
			return `${ACCOUNT_ACTION_HOTKEYS.delete} Delete (typed)`;
	}
}

function buildSummaryPartMap(account: AuthAccountViewModel): Map<string, string> {
	const parts = new Map<string, string>();
	if (account.showLastUsed !== false) {
		parts.set("last-used", formatRelativeTime(account.lastUsed));
	}
	if (account.quotaSummary) {
		parts.set("limits", formatCompactQuotaSummary(account.quotaSummary));
	} else if (account.showQuotaCooldown !== false && account.quotaRateLimited) {
		parts.set("limits", "limit");
	}
	if (account.showStatusBadge === false && account.status) {
		parts.set("status", `status ${account.status}`);
	}
	return parts;
}

function buildAccountSummary(account: AuthAccountViewModel): string {
	const partMap = buildSummaryPartMap(account);
	const orderedParts = resolveStatuslineFields(account)
		.map((field) => partMap.get(field))
		.filter((part): part is string => typeof part === "string" && part.length > 0);
	return orderedParts.join(" ");
}

export function resolveOpenTuiAccountSourceIndex(account: AuthAccountViewModel): number {
	if (typeof account.sourceIndex === "number" && Number.isFinite(account.sourceIndex)) {
		return Math.max(0, Math.floor(account.sourceIndex));
	}
	if (typeof account.index === "number" && Number.isFinite(account.index)) {
		return Math.max(0, Math.floor(account.index));
	}
	return -1;
}

export function formatOpenTuiAccountRow(account: AuthAccountViewModel): string {
	const accountNumber = account.quickSwitchNumber ?? (account.index + 1);
	const head = [`${accountNumber}.`];
	if (account.showCurrentBadge !== false && account.isCurrentAccount) {
		head.push("*");
	}
	head.push(resolveAccountIdentity(account));
	const statusBadge = resolveStatusBadge(account);
	if (statusBadge) {
		head.push(statusBadge);
	}
	const summary = buildAccountSummary(account);
	return summary.length > 0 ? `${head.join(" ")} ${summary}` : head.join(" ");
}

export function filterOpenTuiDashboardAccounts(
	dashboard: AuthDashboardViewModel,
	searchQuery: string,
): AuthAccountViewModel[] {
	const normalized = searchQuery.trim().toLowerCase();
	if (normalized.length === 0) return dashboard.accounts;
	return dashboard.accounts.filter((account) => {
		const candidates = [
			account.email,
			account.accountLabel,
			account.accountId,
			String(account.quickSwitchNumber ?? (account.index + 1)),
		];
		return candidates.some((candidate) =>
			typeof candidate === "string" && candidate.toLowerCase().includes(normalized)
		);
	});
}

function resolveVisibleQuickSwitchMap(accounts: AuthAccountViewModel[]): {
	byNumber: Map<number, AuthAccountViewModel>;
	duplicates: Set<number>;
} {
	const byNumber = new Map<number, AuthAccountViewModel>();
	const duplicates = new Set<number>();
	for (const account of accounts) {
		const quickSwitchNumber = account.quickSwitchNumber ?? (account.index + 1);
		if (byNumber.has(quickSwitchNumber)) {
			duplicates.add(quickSwitchNumber);
			continue;
		}
		byNumber.set(quickSwitchNumber, account);
	}
	return { byNumber, duplicates };
}

export function resolveOpenTuiQuickSwitchAccount(
	dashboard: AuthDashboardViewModel,
	searchQuery: string,
	raw: string,
): AuthAccountViewModel | null {
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 9) return null;
	const visibleAccounts = filterOpenTuiDashboardAccounts(dashboard, searchQuery);
	const { byNumber, duplicates } = resolveVisibleQuickSwitchMap(visibleAccounts);
	if (duplicates.has(parsed)) return null;
	return byNumber.get(parsed) ?? null;
}

export function buildOpenTuiAccountOptions(accounts: AuthAccountViewModel[]): SelectOption[] {
	return accounts.map((account) => ({
		name: formatOpenTuiAccountRow(account),
		description: "",
	}));
}

export function buildOpenTuiAccountDetailPanel(account: AuthAccountViewModel): OpenTuiAccountDetailPanel {
	const detail = buildAuthAccountDetailViewModel(account);
	const metaLines = [
		resolveAccountStateLine(account),
		`Added: ${formatDate(account.addedAt)}`,
		`Used: ${formatRelativeTime(account.lastUsed)}`,
		...resolveQuotaDetailLines(account),
		resolveAccountAlertLine(account),
	].filter((line) => line.trim().length > 0);
	return {
		eyebrow: "focus / account",
		title: detail.title,
		subtitle: sanitizeTerminalText(account.accountId)
			? `ID ${sanitizeTerminalText(account.accountId)}`
			: resolveAccountIdentity(account),
		metaLines,
		actionLines: detail.actions.map((action) => resolveAccountActionHint(action.id)),
	};
}

export function resolveOpenTuiDashboardStatus(dashboard: AuthDashboardViewModel): string | undefined {
	const raw = dashboard.menuOptions.statusMessage;
	if (typeof raw === "function") {
		const resolved = raw();
		return typeof resolved === "string" && resolved.trim().length > 0 ? resolved.trim() : undefined;
	}
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function createDefaultOpenTuiDashboard(): AuthDashboardViewModel {
	const now = Date.now();
	return buildAuthDashboardViewModel({
		storage: {
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "acc_alpha",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 3_600_000,
					addedAt: now - 400_000,
					lastUsed: now - 86_400_000,
					enabled: true,
				},
				{
					email: "beta@example.com",
					accountId: "acc_beta",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 200_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
				{
					email: "gamma@example.com",
					accountId: "acc_gamma",
					refreshToken: "refresh-gamma",
					accessToken: "access-gamma",
					expiresAt: now + 3_600_000,
					addedAt: now - 100_000,
					lastUsed: now - 172_800_000,
					enabled: true,
				},
			],
		},
		quotaCache: {
			byAccountId: {},
			byEmail: {
				"alpha@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 80, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 70, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
				"beta@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 0, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 0, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
				"gamma@example.com": {
					updatedAt: now,
					status: 429,
					model: "gpt-5-codex",
					primary: { usedPercent: 50, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 20, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
			},
		},
		displaySettings: {
			...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		},
		flaggedCount: 1,
		statusMessage: "Loading live limits...",
	});
}
