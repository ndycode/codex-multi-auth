import { ANSI } from "./ansi.js";
import { getUiRuntimeOptions } from "./runtime.js";
import type { MenuItem } from "./select.js";
import { paintUiText, formatUiBadge, quotaToneFromLeftPercent } from "./format.js";
import { UI_COPY } from "./ui-copy.js";
import type { AccountCurrentMarker } from "../runtime/runtime-current-account.js";

export type AccountStatus =
	| "active"
	| "ok"
	| "quota-exhausted"
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
	quotaExhausted?: boolean;
	isCurrentAccount?: boolean;
	isDefaultAccount?: boolean;
	isRuntimeCurrentAccount?: boolean;
	currentMarkers?: AccountCurrentMarker[];
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

function resolveCliVersionLabel(): string | null {
	const raw = (process.env.CODEX_MULTI_AUTH_CLI_VERSION ?? "").trim();
	if (raw.length === 0) return null;
	return raw.startsWith("v") ? raw : `v${raw}`;
}

export function mainMenuTitleWithVersion(): string {
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

export function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "never";
	const days = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return new Date(timestamp).toLocaleDateString();
}

export function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toLocaleDateString();
}

export function statusBadge(status: AccountStatus | undefined): string {
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
			case "quota-exhausted":
				return withTone("quota-exhausted", "warning");
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
		case "quota-exhausted":
			return withTone("quota-exhausted", "warning");
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

export function accountTitle(account: AccountInfo): string {
	const accountNumber = account.quickSwitchNumber ?? (account.index + 1);
	const base =
		sanitizeTerminalText(account.email) ||
		sanitizeTerminalText(account.accountLabel) ||
		sanitizeTerminalText(account.accountId) ||
		`Account ${accountNumber}`;
	return `${accountNumber}. ${base}`;
}

export function accountSearchText(account: AccountInfo): string {
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

export function accountRowColor(account: AccountInfo): MenuItem<AuthMenuAction>["color"] {
	if (account.isCurrentAccount && account.highlightCurrentRow !== false) return "green";
	switch (account.status) {
		case "active":
		case "ok":
			return "green";
		case "quota-exhausted":
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
		case "quota-exhausted":
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

export function currentMarkerLabel(marker: AccountCurrentMarker): string {
	if (marker === "in-use") return "in use";
	return marker;
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
	// ui-03: honor glyph mode. The Unicode block glyphs (█/▒) render as mojibake on
	// ascii terminals, so fall back to ASCII fill/empty chars unless glyphMode is
	// explicitly "unicode". ("auto" stays ascii here to avoid environment guesses.)
	const useUnicodeBar = ui.theme.glyphMode === "unicode";
	const fillChar = useUnicodeBar ? "█" : "#";
	const emptyChar = useUnicodeBar ? "▒" : "-";
	const filledText = fillChar.repeat(filled);
	const emptyText = emptyChar.repeat(width - filled);
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
	if (account.quotaExhausted || summary.toLowerCase().includes("quota-exhausted")) {
		segments.push(ui.v2Enabled ? paintUiText(ui, "quota-exhausted", "danger") : `${ANSI.red}quota-exhausted${ANSI.reset}`);
	}

	if (segments.length === 0) {
		if (!summary) return "";
		return ui.v2Enabled ? paintUiText(ui, summary, "muted") : summary;
	}

	const separator = ui.v2Enabled ? ` ${paintUiText(ui, "|", "muted")} ` : " | ";
	return segments.join(separator);
}

export function formatAccountHint(account: AccountInfo, ui: ReturnType<typeof getUiRuntimeOptions>): string {
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

export function authMenuFocusKey(action: AuthMenuAction): string {
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
