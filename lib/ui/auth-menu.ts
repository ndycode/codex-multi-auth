import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ANSI, isTTY } from "./ansi.js";
import { confirm } from "./confirm.js";
import { getUiRuntimeOptions } from "./runtime.js";
import { select, type MenuItem, type SelectPanel } from "./select.js";
import { paintUiText, formatUiBadge, quotaToneFromLeftPercent } from "./format.js";
import { UI_COPY, formatCheckFlaggedLabel } from "./copy.js";

export type AccountStatus =
	| "active"
	| "ok"
	| "rate-limited"
	| "cooldown"
	| "disabled"
	| "error"
	| "flagged"
	| "unknown";

export interface AccountInfo {
	index: number;
	sourceIndex?: number;
	quickSwitchNumber?: number;
	accountId?: string;
	accountLabel?: string;
	email?: string;
	addedAt?: number;
	lastUsed?: number;
	status?: AccountStatus;
	quotaSummary?: string;
	quota5hLeftPercent?: number;
	quota5hResetAtMs?: number;
	quota7dLeftPercent?: number;
	quota7dResetAtMs?: number;
	quotaRateLimited?: boolean;
	isCurrentAccount?: boolean;
	enabled?: boolean;
	showStatusBadge?: boolean;
	showCurrentBadge?: boolean;
	showLastUsed?: boolean;
	showQuotaCooldown?: boolean;
	showHintsForUnselectedRows?: boolean;
	highlightCurrentRow?: boolean;
	focusStyle?: "row-invert" | "chip";
	statuslineFields?: string[];
}

export interface AuthMenuOptions {
	flaggedCount?: number;
	statusMessage?: string | (() => string | undefined);
}

export type AuthMenuAction =
	| { type: "add" }
	| { type: "forecast" }
	| { type: "fix" }
	| { type: "settings" }
	| { type: "fresh" }
	| { type: "check" }
	| { type: "deep-check" }
	| { type: "verify-flagged" }
	| { type: "select-account"; account: AccountInfo }
	| { type: "set-current-account"; account: AccountInfo }
	| { type: "refresh-account"; account: AccountInfo }
	| { type: "toggle-account"; account: AccountInfo }
	| { type: "delete-account"; account: AccountInfo }
	| { type: "search" }
	| { type: "delete-all" }
	| { type: "cancel" };

export type AccountAction = "back" | "delete" | "refresh" | "toggle" | "set-current" | "cancel";

interface AuthActionDescriptor {
	section: "quick" | "advanced" | "danger";
	label: string;
	value: Exclude<AuthMenuAction, { type: "select-account" | "set-current-account" | "refresh-account" | "toggle-account" | "delete-account" }>;
	color: MenuItem<AuthMenuAction>["color"];
	description: string;
	searchText: string;
}

function resolveCliVersionLabel(): string | null {
	const raw = (process.env.CODEX_MULTI_AUTH_CLI_VERSION ?? "").trim();
	if (raw.length === 0) return null;
	return raw.startsWith("v") ? raw : `v${raw}`;
}

function mainMenuTitleWithVersion(): string {
	const versionLabel = resolveCliVersionLabel();
	if (!versionLabel) return UI_COPY.mainMenu.title;
	return `${UI_COPY.mainMenu.title} (${versionLabel})`;
}

function sanitizeTerminalText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();
}

function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "never";
	const days = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toLocaleDateString();
}

function statusBadge(status: AccountStatus | undefined): string {
	const ui = getUiRuntimeOptions();
	const withTone = (
		label: string,
		tone: "accent" | "success" | "warning" | "danger" | "muted",
	): string => {
		if (ui.v2Enabled) return formatUiBadge(ui, label, tone);
		if (tone === "accent") return `${ANSI.bgGreen}${ANSI.black}[${label}]${ANSI.reset}`;
		if (tone === "success") return `${ANSI.bgGreen}${ANSI.black}[${label}]${ANSI.reset}`;
		if (tone === "warning") return `${ANSI.bgYellow}${ANSI.black}[${label}]${ANSI.reset}`;
		if (tone === "danger") return `${ANSI.bgRed}${ANSI.white}[${label}]${ANSI.reset}`;
		return `${ANSI.inverse}[${label}]${ANSI.reset}`;
	};

	if (ui.v2Enabled) {
		switch (status) {
			case "active":
				return withTone("active", "success");
			case "ok":
				return withTone("ok", "success");
			case "rate-limited":
				return withTone("rate-limited", "warning");
			case "cooldown":
				return withTone("cooldown", "warning");
			case "flagged":
				return withTone("flagged", "danger");
			case "disabled":
				return withTone("disabled", "danger");
			case "error":
				return withTone("error", "danger");
			default:
				return withTone("unknown", "muted");
		}
	}

	switch (status) {
		case "active":
			return withTone("active", "success");
		case "ok":
			return withTone("ok", "success");
		case "rate-limited":
			return withTone("rate-limited", "warning");
		case "cooldown":
			return withTone("cooldown", "warning");
		case "flagged":
			return withTone("flagged", "danger");
		case "disabled":
			return withTone("disabled", "danger");
		case "error":
			return withTone("error", "danger");
		default:
			return withTone("unknown", "muted");
	}
}

function accountTitle(account: AccountInfo): string {
	const accountNumber = account.quickSwitchNumber ?? (account.index + 1);
	const base =
		sanitizeTerminalText(account.email) ||
		sanitizeTerminalText(account.accountLabel) ||
		sanitizeTerminalText(account.accountId) ||
		`Account ${accountNumber}`;
	return `${accountNumber}. ${base}`;
}

function accountSearchText(account: AccountInfo): string {
	return [
		sanitizeTerminalText(account.email),
		sanitizeTerminalText(account.accountLabel),
		sanitizeTerminalText(account.accountId),
		String(account.quickSwitchNumber ?? (account.index + 1)),
	]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join(" ")
		.toLowerCase();
}

function accountRowColor(account: AccountInfo): MenuItem<AuthMenuAction>["color"] {
	if (account.isCurrentAccount && account.highlightCurrentRow !== false) return "green";
	switch (account.status) {
		case "active":
		case "ok":
			return "green";
		case "rate-limited":
		case "cooldown":
			return "yellow";
		case "disabled":
		case "error":
		case "flagged":
			return "red";
		default:
			return "yellow";
	}
}

function statusTone(status: AccountStatus | undefined): "success" | "warning" | "danger" | "muted" {
	switch (status) {
		case "active":
		case "ok":
			return "success";
		case "rate-limited":
		case "cooldown":
			return "warning";
		case "disabled":
		case "error":
		case "flagged":
			return "danger";
		default:
			return "muted";
	}
}

function statusText(status: AccountStatus | undefined): string {
	return status ?? "unknown";
}

function normalizeQuotaPercent(value: number | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function parseLeftPercentFromSummary(summary: string, windowLabel: "5h" | "7d"): number | null {
	const segments = summary.split("|");
	for (const segment of segments) {
		const trimmed = segment.trim().toLowerCase();
		if (!trimmed.startsWith(`${windowLabel} `)) continue;
		const percentToken = trimmed.slice(windowLabel.length).trim().split(/\s+/)[0] ?? "";
		const parsed = Number.parseInt(percentToken.replace("%", ""), 10);
		if (!Number.isFinite(parsed)) continue;
		return Math.max(0, Math.min(100, parsed));
	}
	return null;
}

function formatDurationCompact(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = totalSeconds % 60;
		return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
	}
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) {
		const minutes = totalMinutes % 60;
		return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
	}
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function formatLimitCooldown(resetAtMs: number | undefined): string | null {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs)) return null;
	const remaining = resetAtMs - Date.now();
	if (remaining <= 0) return "reset ready";
	return `reset ${formatDurationCompact(remaining)}`;
}

function formatQuotaBar(
	leftPercent: number | null,
	ui: ReturnType<typeof getUiRuntimeOptions>,
): string {
	const width = 10;
	const ratio = leftPercent === null ? 0 : leftPercent / 100;
	const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
	const filledText = "█".repeat(filled);
	const emptyText = "▒".repeat(width - filled);
	if (ui.v2Enabled) {
		const tone = leftPercent === null ? "muted" : quotaToneFromLeftPercent(leftPercent);
		const filledSegment = filledText.length > 0 ? paintUiText(ui, filledText, tone) : "";
		const emptySegment = emptyText.length > 0 ? paintUiText(ui, emptyText, "muted") : "";
		return `${filledSegment}${emptySegment}`;
	}
	if (leftPercent === null) return `${ANSI.dim}${emptyText}${ANSI.reset}`;
	const color = leftPercent <= 15 ? ANSI.red : leftPercent <= 35 ? ANSI.yellow : ANSI.green;
	const filledSegment = filledText.length > 0 ? `${color}${filledText}${ANSI.reset}` : "";
	const emptySegment = emptyText.length > 0 ? `${ANSI.dim}${emptyText}${ANSI.reset}` : "";
	return `${filledSegment}${emptySegment}`;
}

function formatQuotaPercent(
	leftPercent: number | null,
	ui: ReturnType<typeof getUiRuntimeOptions>,
): string | null {
	if (leftPercent === null) return null;
	const percentText = `${leftPercent}%`;
	if (!ui.v2Enabled) {
		const color = leftPercent <= 15 ? ANSI.red : leftPercent <= 35 ? ANSI.yellow : ANSI.green;
		return `${color}${percentText}${ANSI.reset}`;
	}
	const tone = quotaToneFromLeftPercent(leftPercent);
	return paintUiText(ui, percentText, tone);
}

function formatQuotaWindow(
	label: "5h" | "7d",
	leftPercent: number | null,
	resetAtMs: number | undefined,
	showCooldown: boolean,
	ui: ReturnType<typeof getUiRuntimeOptions>,
): string {
	const labelText = ui.v2Enabled ? paintUiText(ui, label, "muted") : label;
	const bar = formatQuotaBar(leftPercent, ui);
	const percent = formatQuotaPercent(leftPercent, ui);
	if (!showCooldown) {
		return percent ? `${labelText} ${bar} ${percent}` : `${labelText} ${bar}`;
	}
	const cooldown = formatLimitCooldown(resetAtMs);
	if (!cooldown) {
		return percent ? `${labelText} ${bar} ${percent}` : `${labelText} ${bar}`;
	}
	const cooldownText = ui.v2Enabled ? paintUiText(ui, cooldown, "muted") : cooldown;
	if (!percent) {
		return `${labelText} ${bar} ${cooldownText}`;
	}
	return `${labelText} ${bar} ${percent} ${cooldownText}`;
}

function formatQuotaSummary(account: AccountInfo, ui: ReturnType<typeof getUiRuntimeOptions>): string {
	const summary = account.quotaSummary ?? "";
	const showCooldown = account.showQuotaCooldown !== false;
	const left5h = normalizeQuotaPercent(account.quota5hLeftPercent) ?? parseLeftPercentFromSummary(summary, "5h");
	const left7d = normalizeQuotaPercent(account.quota7dLeftPercent) ?? parseLeftPercentFromSummary(summary, "7d");
	const segments: string[] = [];

	if (left5h !== null || typeof account.quota5hResetAtMs === "number") {
		segments.push(formatQuotaWindow("5h", left5h, account.quota5hResetAtMs, showCooldown, ui));
	}
	if (left7d !== null || typeof account.quota7dResetAtMs === "number") {
		segments.push(formatQuotaWindow("7d", left7d, account.quota7dResetAtMs, showCooldown, ui));
	}
	if (account.quotaRateLimited || summary.toLowerCase().includes("rate-limited")) {
		segments.push(ui.v2Enabled ? paintUiText(ui, "rate-limited", "danger") : `${ANSI.red}rate-limited${ANSI.reset}`);
	}

	if (segments.length === 0) {
		if (!summary) return "";
		return ui.v2Enabled ? paintUiText(ui, summary, "muted") : summary;
	}

	const separator = ui.v2Enabled ? ` ${paintUiText(ui, "|", "muted")} ` : " | ";
	return segments.join(separator);
}

function formatAccountHint(account: AccountInfo, ui: ReturnType<typeof getUiRuntimeOptions>): string {
	const withKey = (
		key: string,
		value: string,
		tone: "heading" | "accent" | "muted" | "success" | "warning" | "danger",
	) => {
		if (!ui.v2Enabled) return `${key} ${value}`;
		if (value.includes("\x1b[")) {
			return `${paintUiText(ui, key, "muted")} ${value}`;
		}
		return `${paintUiText(ui, key, "muted")} ${paintUiText(ui, value, tone)}`;
	};

	const partsByKey = new Map<string, string>();
	if (account.showStatusBadge === false) {
		partsByKey.set("status", withKey("Status:", statusText(account.status), statusTone(account.status)));
	}
	if (account.showLastUsed !== false) {
		partsByKey.set("last-used", withKey("Last used:", formatRelativeTime(account.lastUsed), "heading"));
	}
	const quotaSummaryText = formatQuotaSummary(account, ui);
	if (quotaSummaryText) {
		partsByKey.set("limits", withKey("Limits:", quotaSummaryText, "accent"));
	}

	const fields = account.statuslineFields && account.statuslineFields.length > 0
		? account.statuslineFields
		: ["last-used", "limits", "status"];
	const orderedParts: string[] = [];
	for (const field of fields) {
		const part = partsByKey.get(field);
		if (part) orderedParts.push(part);
	}

	if (orderedParts.length === 0) {
		return "";
	}

	const separator = ui.v2Enabled ? ` ${paintUiText(ui, "|", "muted")} ` : " | ";
	if (orderedParts.length === 1) {
		return orderedParts[0] ?? "";
	}

	const firstLine = orderedParts.slice(0, 2).join(separator);
	const secondLine = orderedParts.slice(2).join(separator);
	return secondLine ? `${firstLine}${separator}${secondLine}` : firstLine;
}

async function promptSearchQuery(current: string): Promise<string> {
	if (!input.isTTY || !output.isTTY) {
		return current;
	}

	const rl = createInterface({ input, output });
	try {
		const suffix = current ? ` (${current})` : "";
		const answer = await rl.question(`Search dashboard${suffix} (blank clears): `);
		return answer.trim().toLowerCase();
	} finally {
		rl.close();
	}
}

function formatAccountPanel(account: AccountInfo): SelectPanel {
	const status = statusText(account.status);
	const lines = [
		`Email: ${account.email ?? account.accountLabel ?? account.accountId ?? `Account ${account.index + 1}`}`,
		`Status: ${status}`,
		`Last used: ${formatRelativeTime(account.lastUsed)}`,
		`Added: ${formatDate(account.addedAt)}`,
	];

	const quotaSummary = formatQuotaSummary(account, getUiRuntimeOptions()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	if (quotaSummary.trim().length > 0) {
		lines.push(`Limits: ${quotaSummary}`);
	}

	if (typeof account.quota5hResetAtMs === "number") {
		const cooldown = formatLimitCooldown(account.quota5hResetAtMs);
		if (cooldown) lines.push(`5h window: ${cooldown}`);
	}
	if (typeof account.quota7dResetAtMs === "number") {
		const cooldown = formatLimitCooldown(account.quota7dResetAtMs);
		if (cooldown) lines.push(`7d window: ${cooldown}`);
	}

	return {
		tag: account.isCurrentAccount ? "Current Account" : "Account Details",
		title: account.email ?? account.accountLabel ?? account.accountId ?? `Account ${account.index + 1}`,
		body: lines.join("\n"),
		footer: "Enter opens account actions. Hotkeys: S set current, R re-login, E toggle, D delete, Q back.",
	};
}

function createActionDescriptors(flaggedCount: number): AuthActionDescriptor[] {
	return [
		{
			section: "quick",
			label: UI_COPY.mainMenu.addAccount,
			value: { type: "add" },
			color: "green",
			description: "Start a browser-first sign-in flow with a safe fallback for manual or incognito callback paste.",
			searchText: "add login oauth browser manual sign in account",
		},
		{
			section: "quick",
			label: UI_COPY.mainMenu.checkAccounts,
			value: { type: "check" },
			color: "green",
			description: "Run the main health check to refresh session health, quota summaries, and current availability.",
			searchText: "check health quota verify current availability",
		},
		{
			section: "quick",
			label: UI_COPY.mainMenu.bestAccount,
			value: { type: "forecast" },
			color: "green",
			description: "Recommend the healthiest account to switch to based on readiness, limits, and recent state.",
			searchText: "best forecast recommend switch healthiest account",
		},
		{
			section: "quick",
			label: UI_COPY.mainMenu.fixIssues,
			value: { type: "fix" },
			color: "green",
			description: "Attempt focused repair steps for broken or stale auth state without leaving the dashboard.",
			searchText: "fix repair refresh issues auth stale problem",
		},
		{
			section: "quick",
			label: UI_COPY.mainMenu.settings,
			value: { type: "settings" },
			color: "green",
			description: "Open the searchable settings hub to tune dashboard layout, behavior, theme, backend, and preview mode.",
			searchText: "settings theme behavior backend layout preview search",
		},
		{
			section: "advanced",
			label: UI_COPY.mainMenu.refreshChecks,
			value: { type: "deep-check" },
			color: "green",
			description: "Run a deeper refresh across stored accounts to re-check limits and session freshness.",
			searchText: "advanced deep check refresh all accounts limits",
		},
		{
			section: "advanced",
			label: formatCheckFlaggedLabel(flaggedCount),
			value: { type: "verify-flagged" },
			color: flaggedCount > 0 ? "red" : "yellow",
			description: flaggedCount > 0
				? `Re-check the ${flaggedCount} problem account${flaggedCount === 1 ? "" : "s"} that need attention.`
				: "No problem accounts are currently flagged, but this check can confirm that state.",
			searchText: "verify flagged problem accounts warnings disabled",
		},
		{
			section: "danger",
			label: UI_COPY.mainMenu.removeAllAccounts,
			value: { type: "delete-all" },
			color: "red",
			description: "Delete every stored account in this pool. This is destructive and should be used sparingly.",
			searchText: "delete all remove accounts danger destructive",
		},
	];
}

function formatActionPanel(
	action: AuthActionDescriptor,
	searchQuery: string,
	statusText: string | undefined,
): SelectPanel {
	const searchNote = searchQuery ? `Active search: ${searchQuery}` : "Search can target actions, settings, and accounts.";
	const footer = [statusText, searchNote].filter(Boolean).join(" | ");
	return {
		tag: action.section === "danger" ? "Danger Zone" : action.section === "advanced" ? "Advanced Check" : "Quick Action",
		title: action.label,
		body: action.description,
		footer,
	};
}

function authMenuFocusKey(action: AuthMenuAction): string {
	switch (action.type) {
		case "select-account":
		case "set-current-account":
		case "refresh-account":
		case "toggle-account":
		case "delete-account":
			return `account:${action.account.sourceIndex ?? action.account.index}`;
		case "add":
		case "forecast":
		case "fix":
		case "settings":
		case "fresh":
		case "check":
		case "deep-check":
		case "verify-flagged":
		case "search":
		case "delete-all":
		case "cancel":
			return `action:${action.type}`;
	}
}

export async function showAuthMenu(
	accounts: AccountInfo[],
	options: AuthMenuOptions = {},
): Promise<AuthMenuAction> {
	const flaggedCount = options.flaggedCount ?? 0;
	const ui = getUiRuntimeOptions();
	const actionDescriptors = createActionDescriptors(flaggedCount);
	let showDetailedHelp = false;
	let searchQuery = "";
	let focusKey = "action:add";
	while (true) {
		const normalizedSearch = searchQuery.trim().toLowerCase();
		const matchesSearch = (value: string): boolean =>
			normalizedSearch.length === 0 || value.toLowerCase().includes(normalizedSearch);
		const matchingQuickActions = actionDescriptors.filter((action) =>
			action.section === "quick" && matchesSearch(`${action.label} ${action.searchText}`)
		);
		const matchingAdvancedActions = actionDescriptors.filter((action) =>
			action.section === "advanced" && matchesSearch(`${action.label} ${action.searchText}`)
		);
		const matchingDangerActions = actionDescriptors.filter((action) =>
			action.section === "danger" && matchesSearch(`${action.label} ${action.searchText}`)
		);
		const visibleAccounts = normalizedSearch.length > 0
			? accounts.filter((account) =>
				accountSearchText(account).includes(normalizedSearch) ||
				`account saved profile ${statusText(account.status)}`.includes(normalizedSearch)
			)
			: accounts;
		const visibleByNumber = new Map<number, AccountInfo>();
		const duplicateQuickSwitchNumbers = new Set<number>();
		for (const account of visibleAccounts) {
			const quickSwitchNumber = account.quickSwitchNumber ?? (account.index + 1);
			if (visibleByNumber.has(quickSwitchNumber)) {
				duplicateQuickSwitchNumbers.add(quickSwitchNumber);
				continue;
			}
			visibleByNumber.set(quickSwitchNumber, account);
		}

		const items: MenuItem<AuthMenuAction>[] = [];
		const pushActionSection = (
			headingLabel: string,
			sectionActions: AuthActionDescriptor[],
		): void => {
			if (sectionActions.length === 0) return;
			items.push({ label: headingLabel, value: { type: "cancel" }, kind: "heading" });
			for (const action of sectionActions) {
				items.push({
					label: action.label,
					value: action.value,
					color: action.color,
				});
			}
			items.push({ label: "", value: { type: "cancel" }, separator: true });
		};

		pushActionSection(UI_COPY.mainMenu.quickStart, matchingQuickActions);
		pushActionSection(UI_COPY.mainMenu.moreChecks, matchingAdvancedActions);
		if (visibleAccounts.length > 0 || normalizedSearch.length === 0) {
			items.push({ label: UI_COPY.mainMenu.accounts, value: { type: "cancel" }, kind: "heading" });
		}

		const noDashboardMatches =
			matchingQuickActions.length === 0 &&
			matchingAdvancedActions.length === 0 &&
			matchingDangerActions.length === 0 &&
			visibleAccounts.length === 0;
		if (noDashboardMatches) {
			items.push({
				label: UI_COPY.mainMenu.noSearchMatches,
				value: { type: "cancel" },
				disabled: true,
			});
		} else if (visibleAccounts.length > 0) {
			items.push(
				...visibleAccounts.map((account) => {
					const currentBadge = account.isCurrentAccount && account.showCurrentBadge !== false
						? (ui.v2Enabled ? ` ${formatUiBadge(ui, "current", "accent")}` : ` ${ANSI.cyan}[current]${ANSI.reset}`)
						: "";
					const badge = account.showStatusBadge === false ? "" : statusBadge(account.status);
					const statusSuffix = badge ? ` ${badge}` : "";
					const title = ui.v2Enabled
						? paintUiText(ui, accountTitle(account), account.isCurrentAccount ? "accent" : "heading")
						: accountTitle(account);
					const label = `${title}${currentBadge}${statusSuffix}`;
					const hint = formatAccountHint(account, ui);
					const hasHint = hint.length > 0;
					const hintText = ui.v2Enabled
						? (hasHint ? hint : undefined)
						: (hasHint ? hint : undefined);
					return {
						label,
						hint: hintText,
						color: accountRowColor(account),
						value: { type: "select-account" as const, account },
					};
				}),
			);
		}

		if (matchingDangerActions.length > 0) {
			items.push({ label: "", value: { type: "cancel" }, separator: true });
			items.push({ label: UI_COPY.mainMenu.dangerZone, value: { type: "cancel" }, kind: "heading" });
			items.push(
				...matchingDangerActions.map((action) => ({
					label: action.label,
					value: action.value,
					color: action.color,
				})),
			);
		}

		const compactHelp = UI_COPY.mainMenu.helpCompact;
		const detailedHelp = UI_COPY.mainMenu.helpDetailed;
		const showHintsForUnselectedRows = visibleAccounts[0]?.showHintsForUnselectedRows ??
			accounts[0]?.showHintsForUnselectedRows ??
			false;
		const focusStyle = visibleAccounts[0]?.focusStyle ??
			accounts[0]?.focusStyle ??
			"row-invert";
		const resolveStatusMessage = (): string | undefined => {
			const raw = typeof options.statusMessage === "function"
				? options.statusMessage()
				: options.statusMessage;
			return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
		};
		const buildSubtitle = (): string | undefined => {
			const parts: string[] = [];
			if (normalizedSearch.length > 0) {
				parts.push(`${UI_COPY.mainMenu.searchSubtitlePrefix} ${normalizedSearch}`);
			}
			const statusText = resolveStatusMessage();
			if (statusText) {
				parts.push(statusText);
			}
			if (parts.length === 0) return undefined;
			return parts.join(" | ");
		};
		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading") return false;
			return authMenuFocusKey(item.value) === focusKey;
		});

		const result = await select(items, {
			message: mainMenuTitleWithVersion(),
			subtitle: buildSubtitle(),
			dynamicSubtitle: buildSubtitle,
			help: showDetailedHelp ? detailedHelp : compactHelp,
			clearScreen: true,
			selectedEmphasis: "minimal",
			focusStyle,
			showHintsForUnselected: showHintsForUnselectedRows,
			shellMode: ui.mode,
			refreshIntervalMs: 200,
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			theme: ui.theme,
			panel: ({ selectedItem }) => {
				if (showDetailedHelp) {
					const statusText = resolveStatusMessage();
					return {
						tag: "Help",
						title: "Dashboard Shortcuts",
						body: detailedHelp.replace(/\s+\|\s+/g, "\n"),
						footer: [
							statusText,
							normalizedSearch ? `Search results for "${normalizedSearch}"` : undefined,
						].filter(Boolean).join(" | "),
					};
				}

				const selected = selectedItem?.value;
				if (!selected) return undefined;
				if (selected.type === "select-account") {
					return formatAccountPanel(selected.account);
				}

				const descriptor = actionDescriptors.find((action) => action.value.type === selected.type);
				if (!descriptor) {
					return undefined;
				}
				return formatActionPanel(descriptor, normalizedSearch, resolveStatusMessage());
			},
			onInput: (input, context) => {
				const lower = input.toLowerCase();
				if (lower === "?") {
					showDetailedHelp = !showDetailedHelp;
					context.requestRerender();
					return undefined;
				}
				if (lower === "q") {
					return { type: "cancel" as const };
				}
				if (lower === "/") {
					return { type: "search" as const };
				}
				const parsed = Number.parseInt(input, 10);
				if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 9) {
					if (duplicateQuickSwitchNumbers.has(parsed)) {
						return undefined;
					}
					const direct = visibleByNumber.get(parsed);
					if (direct) {
						return { type: "set-current-account" as const, account: direct };
					}
				}

				const selected = context.items[context.cursor];
				if (!selected || selected.separator || selected.disabled || selected.kind === "heading") {
					return undefined;
				}
				if (selected.value.type !== "select-account") return undefined;
				return undefined;
			},
			onCursorChange: ({ cursor }) => {
				const selected = items[cursor];
				if (!selected || selected.separator || selected.disabled || selected.kind === "heading") return;
				focusKey = authMenuFocusKey(selected.value);
			},
		});

		if (!result) return { type: "cancel" };
		if (result.type === "search") {
			searchQuery = await promptSearchQuery(searchQuery);
			focusKey = "action:search";
			continue;
		}
		if (result.type === "delete-all") {
			const confirmed = await confirm("Delete all accounts?");
			if (!confirmed) continue;
		}
		if (result.type === "delete-account") {
			const confirmed = await confirm(`Delete ${accountTitle(result.account)}?`);
			if (!confirmed) continue;
		}
		if (result.type === "refresh-account") {
			const confirmed = await confirm(`Re-authenticate ${accountTitle(result.account)}?`);
			if (!confirmed) continue;
		}
		focusKey = authMenuFocusKey(result);
		return result;
	}
}

export async function showAccountDetails(account: AccountInfo): Promise<AccountAction> {
	const ui = getUiRuntimeOptions();
	const header =
		`${accountTitle(account)} ${statusBadge(account.status)}` +
		(account.enabled === false
			? (ui.v2Enabled
				? ` ${formatUiBadge(ui, "disabled", "danger")}`
				: ` ${ANSI.red}[disabled]${ANSI.reset}`)
			: "");
	const statusLabel = account.status ?? "unknown";
	const subtitle = `Added: ${formatDate(account.addedAt)} | Used: ${formatRelativeTime(account.lastUsed)} | Status: ${statusLabel}`;
	let focusAction: AccountAction = "back";

	while (true) {
		const items: MenuItem<AccountAction>[] = [
			{ label: UI_COPY.accountDetails.back, value: "back" },
			{
				label: account.enabled === false ? UI_COPY.accountDetails.enable : UI_COPY.accountDetails.disable,
				value: "toggle",
				color: account.enabled === false ? "green" : "yellow",
			},
			{
				label: UI_COPY.accountDetails.setCurrent,
				value: "set-current",
				color: "green",
			},
			{ label: UI_COPY.accountDetails.refresh, value: "refresh", color: "green" },
			{ label: UI_COPY.accountDetails.remove, value: "delete", color: "red" },
		];
		const initialCursor = items.findIndex((item) => item.value === focusAction);
		const action = await select<AccountAction>(items, {
			message: header,
			subtitle,
			help: UI_COPY.accountDetails.help,
			clearScreen: true,
			selectedEmphasis: "minimal",
			focusStyle: account.focusStyle ?? "row-invert",
			shellMode: ui.mode,
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			theme: ui.theme,
			panel: ({ selectedItem }) => {
				const nextAction = selectedItem?.value ?? "back";
				const actionDescription = nextAction === "set-current"
					? "Make this account the active Codex account immediately."
					: nextAction === "refresh"
						? "Start a focused re-login for this account without leaving the dashboard."
						: nextAction === "toggle"
							? account.enabled === false
								? "Re-enable this account so it can rejoin rotation and checks."
								: "Disable this account while keeping it stored in the pool."
							: nextAction === "delete"
								? "Delete this account from storage. This action is destructive."
								: "Return to the main dashboard.";
				return {
					tag: "Account Actions",
					title: account.email ?? account.accountLabel ?? account.accountId ?? `Account ${account.index + 1}`,
					body: `${formatAccountPanel(account).body}\n\nSelected action: ${nextAction}\n${actionDescription}`,
					footer: "Hotkeys stay active here: S current, R re-login, E toggle, D delete, Q back.",
				};
			},
			onInput: (input) => {
				const lower = input.toLowerCase();
				if (lower === "q") return "cancel";
				if (lower === "s") return "set-current";
				if (lower === "r") return "refresh";
				if (lower === "t" || lower === "e" || lower === "x") return "toggle";
				if (lower === "d") return "delete";
				return undefined;
			},
			onCursorChange: ({ cursor }) => {
				const selected = items[cursor];
				if (!selected || selected.separator || selected.disabled || selected.kind === "heading") return;
				focusAction = selected.value;
			},
		});

		if (!action) return "cancel";
		focusAction = action;
		if (action === "delete") {
			const confirmed = await confirm(`Delete ${accountTitle(account)}?`);
			if (!confirmed) continue;
		}
		if (action === "refresh") {
			const confirmed = await confirm(`Re-authenticate ${accountTitle(account)}?`);
			if (!confirmed) continue;
		}
		return action;
	}
}

export { isTTY };
