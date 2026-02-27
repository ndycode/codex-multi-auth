import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ANSI, isTTY } from "./ansi.js";
import { confirm } from "./confirm.js";
import { getUiRuntimeOptions } from "./runtime.js";
import { select, type MenuItem } from "./select.js";
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

/**
 * Format a millisecond timestamp into a concise, human-friendly relative time string.
 *
 * @param timestamp - Milliseconds since the UNIX epoch, or `undefined`/falsy to indicate "never"
 * @returns `"never"` if `timestamp` is missing or falsy; otherwise one of: `"today"`, `"yesterday"`, `"{N}d ago"`, `"{N}w ago"`, or the locale date string for older dates
 *
 * Concurrency: Pure and side-effect free (safe for concurrent use). Filesystem: No filesystem interaction or Windows-specific behavior. Security: Produces no secrets and does not perform token redaction.
 */
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

/**
 * Produce a UI-styled status badge string for the given account status.
 *
 * The returned string is a text badge appropriate for the current UI runtime (v2 paint or legacy ANSI).
 * This function is pure and safe to call concurrently. It has no filesystem interactions and does not
 * perform or require any token redaction; the badge content is derived solely from the provided status.
 *
 * @param status - The account status to render (may be undefined)
 * @returns A formatted badge string representing the provided status (e.g., "active", "rate-limited", "unknown")
 */
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

/**
 * Builds a display title for an account using its quick-switch number and primary identifier.
 *
 * @param account - The account object; `quickSwitchNumber` is used if present, otherwise `index + 1` is used.
 * @returns The formatted title in the form "`<number>. <base>`", where `<base>` is the first non-empty value of `email`, `accountLabel`, or `accountId`, falling back to `"Account <number>"`.
 */
function accountTitle(account: AccountInfo): string {
	const accountNumber = account.quickSwitchNumber ?? (account.index + 1);
	const base =
		account.email?.trim() ||
		account.accountLabel?.trim() ||
		account.accountId?.trim() ||
		`Account ${accountNumber}`;
	return `${accountNumber}. ${base}`;
}

/**
 * Builds a normalized, lowercased search string from an account's key identifying fields.
 *
 * This synchronous utility concatenates the account's email, label, ID, and quick-switch number (or index+1)
 * into a single space-separated, lowercased string suitable for search matching. It does not perform I/O or
 * access the filesystem and has no concurrency side effects. The result may contain account identifiers; avoid
 * logging or exposing it where tokens or other secrets must be redacted.
 *
 * @param account - The account whose searchable fields will be combined
 * @returns A single lowercased string containing the account's non-empty identifying fields separated by spaces
 */
function accountSearchText(account: AccountInfo): string {
	return [
		account.email,
		account.accountLabel,
		account.accountId,
		String(account.quickSwitchNumber ?? (account.index + 1)),
	]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join(" ")
		.toLowerCase();
}

/**
 * Choose a row color for an account based on its status and whether it is the current account.
 *
 * @param account - Account metadata used to determine color; `isCurrentAccount`, `highlightCurrentRow`, and `status` are considered.
 * @returns The color name: `"green"`, `"yellow"`, or `"red"` indicating the visual tone for the account row.
 *
 * Concurrency: This is a pure, synchronous helper and is safe for concurrent use.
 * Filesystem: No filesystem interaction or Windows-specific behavior.
 * Token redaction: Does not process or emit sensitive tokens.
 */
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

/**
 * Map an account status to a UI tone used for coloring and badges.
 *
 * Pure and synchronous (safe for concurrent calls); does not access the filesystem and does not expose or redact tokens.
 *
 * @param status - The account status to evaluate (may be undefined)
 * @returns `"success"` for healthy statuses, `"warning"` for rate/limit states, `"danger"` for error/disabled/flagged statuses, `"muted"` for unknown or undefined
 */
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

/**
 * Normalize an account status into a safe display string.
 *
 * @param status - The account status or `undefined`
 * @returns The provided `status` string, or `"unknown"` when `status` is `undefined`
 */
function statusText(status: AccountStatus | undefined): string {
	return status ?? "unknown";
}

/**
 * Clamp and round a percent value to an integer in the range 0–100, or return null for invalid input.
 *
 * @param value - The percent value to normalize; may be undefined or non-finite.
 * @returns The normalized integer percent between 0 and 100 inclusive, or `null` if `value` is missing or not a finite number.
 */
function normalizeQuotaPercent(value: number | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Extracts the left-percent value for a specific quota window label from a quota summary string.
 *
 * @param summary - The quota summary text containing window segments (e.g., "5h 20% | 7d 80%").
 * @param windowLabel - The window label to extract (`"5h"` or `"7d"`).
 * @returns The parsed percent clamped to the range 0–100, or `null` if the percent cannot be found or parsed.
 *
 * Notes:
 * - This function is pure and has no side effects or concurrency implications.
 * - Platform/filesystem considerations and token redaction rules do not apply to this parser. 
 */
function parseLeftPercentFromSummary(summary: string, windowLabel: "5h" | "7d"): number | null {
	const match = summary.match(new RegExp(`(?:^|\\|)\\s*${windowLabel}\\s+(\\d{1,3})%`, "i"));
	const parsed = Number.parseInt(match?.[1] ?? "", 10);
	if (!Number.isFinite(parsed)) return null;
	return Math.max(0, Math.min(100, parsed));
}

/**
 * Produce a compact human-readable duration string from milliseconds.
 *
 * Produces values like "45s", "2m 5s", "3h 4m", or "1d 2h" by rounding up to whole seconds and
 * using the largest suitable unit (seconds, minutes, hours, days) with a short compact format.
 *
 * Concurrency: pure and side-effect free; safe for concurrent use.
 * Filesystem: no filesystem access; behavior is identical on Windows and POSIX.
 * Token redaction: does not process or emit sensitive tokens.
 *
 * @param milliseconds - Duration in milliseconds (negative values are treated as zero)
 * @returns A compact duration string describing the input duration
 */
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

/**
 * Produce a human-readable cooldown indicator based on an absolute reset timestamp.
 *
 * This uses the current system clock (Date.now()) so results depend on local time and may vary across concurrent callers; it performs no filesystem I/O (safe on Windows) and does not expose or redact any tokens or secrets.
 *
 * @param resetAtMs - Absolute reset time expressed as milliseconds since the Unix epoch
 * @returns A string like `"reset 1m 30s"` or `"reset ready"`, or `null` if `resetAtMs` is missing or invalid
 */
function formatLimitCooldown(resetAtMs: number | undefined): string | null {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs)) return null;
	const remaining = resetAtMs - Date.now();
	if (remaining <= 0) return "reset ready";
	return `reset ${formatDurationCompact(remaining)}`;
}

/**
 * Renders a 10-unit quota bar showing filled and remaining capacity with UI-aware styling.
 *
 * This is a pure, synchronous formatter with no side effects or filesystem interactions. On v2 UI it uses the UI paint/tone API; on legacy UI it emits ANSI color sequences. A `null` leftPercent is treated as unknown and renders an empty (muted) bar. The output contains only visual styling tokens (ANSI or UI paint) and does not include or expose secrets; no special token-redaction is required. Behavior is identical on Windows terminals that support the respective styling sequences.
 *
 * @param leftPercent - Remaining quota percentage (0–100), or `null` when unknown
 * @param ui - UI runtime options used to choose styling (v2 paint vs legacy ANSI)
 * @returns A 10-character quota bar string with filled (block) and empty (light shaded) segments, styled according to `ui`
 */
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

/**
 * Format a quota percentage into a styled string suitable for the current UI.
 *
 * @param leftPercent - Percentage left (0–100) or `null` when unknown
 * @param ui - UI runtime options; controls v2 painting vs. legacy ANSI coloring
 * @returns A styled percent string (e.g., `42%`) or `null` if `leftPercent` is `null`
 *
 * @remarks
 * - Concurrency: synchronous and side-effect free (safe to call from multiple contexts).
 * - Filesystem (Windows): no filesystem interaction or path-specific behavior.
 * - Token redaction: does not process or redact sensitive tokens.
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

/**
 * Builds a formatted quota window segment containing the window label, quota bar, optional percent, and optional cooldown text for display.
 *
 * This function performs pure string formatting and has no side effects. It is safe for concurrent use and does not access the filesystem (including Windows-specific paths). The output does not include any secret tokens or credentials; cooldown text may include human-readable time descriptions but will not expose sensitive data.
 *
 * @param label - The quota window label, either `"5h"` or `"7d"`.
 * @param leftPercent - Remaining quota percent (0–100) or `null` when unknown.
 * @param resetAtMs - Epoch milliseconds when the quota window resets, or `undefined` if unknown.
 * @param showCooldown - Whether to include cooldown/reset text when available.
 * @param ui - Runtime UI options used for styling and painting.
 * @returns A single-line formatted string representing the quota window segment (label, bar, optional percent, and optional cooldown).
 */
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

/**
 * Build a human-readable quota summary for an account, formatted according to the provided UI options.
 *
 * Produces a combined string describing 5-hour and 7-day quota windows (percent, progress bar, optional cooldown)
 * and a rate-limited indicator when present; returns an empty string when no quota information is available.
 *
 * @param account - Account information; reads quotaSummary, quota5hLeftPercent, quota5hResetAtMs, quota7dLeftPercent, quota7dResetAtMs, quotaRateLimited, and showQuotaCooldown to compose the summary.
 * @param ui - Runtime UI options that control visual styling (v2 paint vs legacy ANSI).
 * @returns A formatted quota summary string suitable for display in menus or hints.
 *
 * Concurrency: pure formatting function with no side effects; safe to call from concurrent UI flows.
 * Windows filesystem: not applicable.
 * Token redaction: does not inspect or emit sensitive tokens; only formats numeric, textual, and status fields from the account. 
 */
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

/**
 * Build a one- or two-line hint string for an account containing status, last-used, and quota/limit parts,
 * applying UI-aware coloring and the account's preferred field order.
 *
 * @param account - Account record; fields consulted: `showStatusBadge`, `showLastUsed`, `statuslineFields`, `lastUsed`, `status`, and quota-related fields used by `formatQuotaSummary`.
 * @param ui - Runtime UI options (used to choose v2 vs legacy rendering and to paint text).
 * @returns The composed hint string (may include ANSI/v2-painted fragments) or an empty string when no parts are available.
 *
 * @remarks
 * Concurrency: pure formatting function with no side effects; safe to call from concurrent contexts. 
 * Filesystem: formatting is platform-independent (no Windows-specific behavior). 
 * Token redaction: this function does not perform secret/token redaction; any values passed in `account` should be redacted upstream if required.
 */
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

/**
 * Prompts the user for a search query, using the provided current value as the default hint.
 *
 * If standard input or output is not a TTY (e.g., non-interactive/CI environments or piped I/O), this function returns `current` unchanged.
 *
 * Concurrency: do not call concurrently with other prompts that share the same stdin/stdout; simultaneous prompts may interfere.
 *
 * Note: User input may contain sensitive tokens; callers are responsible for redaction before logging or persisting.
 *
 * @param current - The existing query to show as a default hint; an empty string indicates no current query.
 * @returns The user's response trimmed and converted to lowercase, or `current` if prompting is not possible.
 */
async function promptSearchQuery(current: string): Promise<string> {
	if (!input.isTTY || !output.isTTY) {
		return current;
	}

	const rl = createInterface({ input, output });
	try {
		const suffix = current ? ` (${current})` : "";
		const answer = await rl.question(`Search${suffix} (blank clears): `);
		return answer.trim().toLowerCase();
	} finally {
		rl.close();
	}
}

/**
 * Produce a stable focus key string for a given authentication menu action.
 *
 * @param action - The AuthMenuAction to generate a focus key for.
 * @returns A stable string key: `account:<sourceIndex|index>` for account-specific actions, or `action:<type>` for generic actions.
 *
 * Concurrency: safe to call concurrently; it is deterministic and has no side effects.
 * Windows filesystem: returned string is a simple identifier and has no filesystem interactions.
 * Token redaction: output contains only numeric indices and action types; it does not include sensitive tokens or secrets.
 */
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

/**
 * Display an interactive authentication menu and return the user's chosen action.
 *
 * Presents a searchable, focusable list of global actions and accounts (with badges, hints, quick-switch numbers,
 * and per-item confirmation flows). Supports detailed compact help toggle, incremental search, numeric quick-switch (1–9),
 * and confirmation for destructive operations. The function loops until a terminal action (select, add, delete, cancel, etc.)
 * is chosen and returns that action.
 *
 * Concurrency: intended for single concurrent invocation in a TTY UI; do not call concurrently from multiple tasks.
 * Filesystem/OS: this UI performs no filesystem writes and is safe on Windows consoles and other platforms.
 * Sensitive data: account display fields are limited to account identifiers (email, label, id, quick-switch number);
 * secrets/tokens are not shown or are redacted by design.
 *
 * @param accounts - The list of accounts to display and operate on; each item may include UI hints (badges, quota info, focus style).
 * @param options - Optional behavior flags and dynamic status text (e.g., flaggedCount and statusMessage).
 * @returns The selected AuthMenuAction describing the user's chosen menu action.
 */
export async function showAuthMenu(
	accounts: AccountInfo[],
	options: AuthMenuOptions = {},
): Promise<AuthMenuAction> {
	const flaggedCount = options.flaggedCount ?? 0;
	const verifyLabel = formatCheckFlaggedLabel(flaggedCount);
	const ui = getUiRuntimeOptions();
	let showDetailedHelp = false;
	let searchQuery = "";
	let focusKey = "action:add";
	while (true) {
		const normalizedSearch = searchQuery.trim().toLowerCase();
		const visibleAccounts = normalizedSearch.length > 0
			? accounts.filter((account) => accountSearchText(account).includes(normalizedSearch))
			: accounts;
		const visibleByNumber = new Map<number, AccountInfo>();
		for (const account of visibleAccounts) {
			const quickSwitchNumber = account.quickSwitchNumber ?? (account.index + 1);
			visibleByNumber.set(quickSwitchNumber, account);
		}

		const items: MenuItem<AuthMenuAction>[] = [
			{ label: UI_COPY.mainMenu.quickStart, value: { type: "cancel" }, kind: "heading" },
			{ label: UI_COPY.mainMenu.addAccount, value: { type: "add" }, color: "green" },
			{ label: UI_COPY.mainMenu.checkAccounts, value: { type: "check" }, color: "green" },
			{ label: UI_COPY.mainMenu.bestAccount, value: { type: "forecast" }, color: "green" },
			{ label: UI_COPY.mainMenu.fixIssues, value: { type: "fix" }, color: "green" },
			{ label: UI_COPY.mainMenu.settings, value: { type: "settings" }, color: "green" },
			{ label: "", value: { type: "cancel" }, separator: true },
			{ label: UI_COPY.mainMenu.moreChecks, value: { type: "cancel" }, kind: "heading" },
			{ label: UI_COPY.mainMenu.refreshChecks, value: { type: "deep-check" }, color: "green" },
			{ label: verifyLabel, value: { type: "verify-flagged" }, color: flaggedCount > 0 ? "red" : "yellow" },
			{ label: "", value: { type: "cancel" }, separator: true },
			{ label: UI_COPY.mainMenu.accounts, value: { type: "cancel" }, kind: "heading" },
		];

		if (visibleAccounts.length === 0) {
			items.push({
				label: UI_COPY.mainMenu.noSearchMatches,
				value: { type: "cancel" },
				disabled: true,
			});
		} else {
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

		items.push({ label: "", value: { type: "cancel" }, separator: true });
		items.push({ label: UI_COPY.mainMenu.dangerZone, value: { type: "cancel" }, kind: "heading" });
		items.push({ label: UI_COPY.mainMenu.removeAllAccounts, value: { type: "delete-all" }, color: "red" });

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
			message: UI_COPY.mainMenu.title,
			subtitle: buildSubtitle(),
			dynamicSubtitle: buildSubtitle,
			help: showDetailedHelp ? detailedHelp : compactHelp,
			clearScreen: true,
			selectedEmphasis: "minimal",
			focusStyle,
			showHintsForUnselected: showHintsForUnselectedRows,
			refreshIntervalMs: 200,
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			theme: ui.theme,
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

/**
 * Display an interactive details menu for a single account and return the selected account action.
 *
 * Presents a header (title + status), a subtitle with added/last-used/status info, and a list of actions
 * (back, enable/disable, set-current, refresh, delete). Prompts for confirmation for destructive actions
 * and loops until a non-cancel action is confirmed or the user cancels.
 *
 * @param account - The account metadata to display (title, status, timestamps and UI flags are used to build the menu)
 * @returns The chosen AccountAction (e.g., "back", "delete", "refresh", "toggle", "set-current", or "cancel")
 *
 * Concurrency: Intended to run in a single-threaded CLI/TUI context; do not invoke concurrently for the same account UI.
 * Windows behavior: No filesystem operations are performed; interactive behavior is implemented to work with Windows consoles.
 * Token redaction: This function only displays account metadata and status; it does not expose or log authentication tokens—callers must ensure account fields do not contain secrets.
 */
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
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			theme: ui.theme,
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
