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
 * Produce a concise, human-readable relative time for a millisecond timestamp.
 *
 * @param timestamp - Milliseconds since the Unix epoch; if falsy or undefined, the function returns `"never"`.
 * @returns `today`, `yesterday`, `Nd ago`, `Nw ago`, or a locale-formatted date string for older timestamps.
 *
 * @remarks
 * Concurrency: results depend on the current system clock and may change if the system time is modified concurrently.
 * Filesystem: this function performs no filesystem access and is unaffected by Windows filesystem semantics.
 * Security: no sensitive tokens are produced or exposed by this function (safe for token-redaction contexts).
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

/**
 * Format a millisecond timestamp as the current locale's short date string.
 *
 * This is a pure, synchronous formatter with no side effects; it uses the runtime locale and does not perform any I/O, is safe for concurrent use, and has no special handling for Windows filesystem paths or token redaction.
 *
 * @param timestamp - Milliseconds since the UNIX epoch; if `undefined` or falsy the function returns `"unknown"`
 * @returns The locale-formatted date string for `timestamp`, or `"unknown"` when `timestamp` is falsy
 */
function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toLocaleDateString();
}

/**
 * Render a compact, styled status badge for an account using the current UI runtime options.
 *
 * Produces a short labeled badge (for example, "active" or "rate-limited") rendered with the configured UI badge style; when UI v2 is not enabled a legacy ANSI-styled fallback is used. This function is pure, safe to call concurrently, and does not read or write the filesystem; note that legacy ANSI styling may not display correctly on older Windows consoles. The output contains only the status label and styling and does not include or expose secrets/tokens.
 *
 * @param status - The account status to render a badge for; if `undefined`, an "unknown" badge is returned.
 * @returns The rendered badge string for display. 
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
 * Builds a one-line display title for an account prefixed by its quick-switch number.
 *
 * Uses quickSwitchNumber when present, otherwise uses index + 1. Chooses the display label in priority order: email, accountLabel, accountId, then the fallback "Account N".
 *
 * @param account - AccountInfo whose quickSwitchNumber, index, email, accountLabel, and accountId are used to compose the title.
 * @returns The account title formatted as "N. Label".
 *
 * Concurrency: safe for concurrent reads; the function has no side effects.
 * Windows filesystem: not applicable.
 * Token redaction: this function does not mask or redact identifiers; redact sensitive values before calling if required.
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
 * Builds a lowercase, space-separated search key from an account's identifying fields.
 *
 * @param account - Account object; uses `email`, `accountLabel`, `accountId`, and `quickSwitchNumber` (falls back to `index + 1`)
 * @returns A space-separated, lowercase string suitable for full-text matching (email, label, id, quick-switch number)
 *
 * Concurrency: pure and side-effect-free — safe to call concurrently.
 * Filesystem: no filesystem access or Windows-specific behavior.
 * Security: resulting string may contain sensitive identifiers; redact tokens/PII before logging or external transmission.
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
 * Selects the display color name for an account row based on its status and whether it is the current account.
 *
 * This function is pure, safe to call concurrently, performs no filesystem access (including on Windows), and does not emit or expose sensitive tokens.
 *
 * @param account - Account metadata; uses `isCurrentAccount`, `highlightCurrentRow`, and `status` to determine the color
 * @returns The color name to apply to the account row: `green`, `yellow`, or `red`
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
 * Map an account status to a UI tone used for coloring and emphasis.
 *
 * @param status - The account status to map; may be undefined.
 * @returns `success` for `active`/`ok`, `warning` for `rate-limited`/`cooldown`, `danger` for `disabled`/`error`/`flagged`, `muted` for unknown or `undefined`
 *
 * @remarks
 * - Concurrency: pure and side-effect free; safe for concurrent use.
 * - Filesystem: has no filesystem interactions or platform-specific behavior (including Windows).
 * - Security: does not inspect, redact, or transmit tokens or sensitive data.
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
 * Produce the textual status for an account, defaulting to "unknown".
 *
 * This function is pure and has no side effects; it is safe for concurrent use,
 * does not interact with the filesystem (Windows or otherwise), and does not
 * reveal or redact any tokens or sensitive data.
 *
 * @param status - The account status or `undefined`
 * @returns The provided `status` string, or `"unknown"` if `status` is `undefined`
 */
function statusText(status: AccountStatus | undefined): string {
	return status ?? "unknown";
}

/**
 * Normalize a numeric percent to an integer between 0 and 100.
 *
 * Accepts a numeric value and returns the nearest integer clamped to the 0–100 range; returns `null` for undefined, non-number, or non-finite inputs.
 *
 * This function is pure and side-effect-free: it is safe for concurrent use, performs no filesystem I/O (including on Windows), and does not retain or log tokens or sensitive data.
 *
 * @param value - The percent value to normalize (may be undefined)
 * @returns The rounded percent constrained to 0–100, or `null` if `value` is invalid
 */
function normalizeQuotaPercent(value: number | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Extracts and returns the numeric percentage for a named quota window (e.g., "5h" or "7d") from a summary string.
 *
 * This function is pure and has no side effects (safe for concurrent calls). It does not perform any filesystem I/O and has no platform-specific behavior on Windows. It does not redact or sanitize tokens; do not pass sensitive tokens expecting redaction.
 *
 * @param summary - Summary text containing window segments (for example: "5h 80% | 7d 90%")
 * @param windowLabel - The window label to locate within `summary` ("5h" or "7d")
 * @returns The parsed percentage clamped to 0–100, or `null` if the label or a valid percentage is not found
 */
function parseLeftPercentFromSummary(summary: string, windowLabel: "5h" | "7d"): number | null {
	const match = summary.match(new RegExp(`(?:^|\\|)\\s*${windowLabel}\\s+(\\d{1,3})%`, "i"));
	const parsed = Number.parseInt(match?.[1] ?? "", 10);
	if (!Number.isFinite(parsed)) return null;
	return Math.max(0, Math.min(100, parsed));
}

/**
 * Format a duration in milliseconds into a compact human-readable string (examples: "5s", "2m 30s", "1h 5m", "3d 4h").
 *
 * Concurrency: pure and thread-safe; safe for concurrent calls.
 * Filesystem: does not access the filesystem and is unaffected by Windows path semantics.
 * Token redaction: produces plain text only and does not include or redact any secrets or tokens.
 *
 * @param milliseconds - Duration in milliseconds; negative values are treated as zero.
 * @returns A compact duration string using units `s`, `m`, `h`, and `d`, showing up to the two largest units (e.g., seconds, minutes+seconds, hours+minutes, or days+hours).
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
 * Produces a human-readable cooldown indicator for a future reset timestamp.
 *
 * Returns `null` when `resetAtMs` is not a finite number. If the reset time is in the past or now, returns `"reset ready"`. Otherwise returns `"reset {duration}"` where `{duration}` is a compact representation of the remaining time (e.g., `5m`, `2h`).
 *
 * Concurrency: callers should expect the result to reflect the current system clock at the moment of invocation; concurrent invocations may yield different remaining times. This function performs no I/O and is unaffected by platform filesystem semantics (including Windows). It does not include or expose sensitive tokens.
 *
 * @param resetAtMs - Reset timestamp in milliseconds since the Unix epoch
 * @returns `null` if `resetAtMs` is invalid, `"reset ready"` if the reset time has passed, or a `"reset {duration}"` string for a future reset
 */
function formatLimitCooldown(resetAtMs: number | undefined): string | null {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs)) return null;
	const remaining = resetAtMs - Date.now();
	if (remaining <= 0) return "reset ready";
	return `reset ${formatDurationCompact(remaining)}`;
}

/**
 * Render a 10-character visual bar representing remaining quota.
 *
 * @param leftPercent - Percentage of quota left (0–100) or `null` when unknown
 * @param ui - Runtime UI options that determine rendering mode and styling
 * @returns A 10-character string composed of filled and empty segments; segments are colorized when `ui.v2Enabled` is true and dimmed when `leftPercent` is `null`
 *
 * @remarks
 * - Concurrency: pure and safe for concurrent use.
 * - Filesystem: performs no filesystem operations and has no Windows-specific filesystem behavior.
 * - Tokens/redaction: does not emit, process, or redact authentication tokens or secrets.
 */
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
 * Builds a compact quota window string showing the window label, a visual bar, an optional percentage, and an optional cooldown indicator.
 *
 * The output adapts to the provided UI runtime options (e.g., v2 styling) and omits parts when values are unavailable. Safe to call concurrently; this function performs no filesystem I/O (including on Windows) and does not include or emit sensitive tokens.
 *
 * @param label - The quota window label ("5h" or "7d")
 * @param leftPercent - Remaining quota percent (0–100) or `null` when unknown
 * @param resetAtMs - Timestamp (ms) when the quota resets, or `undefined` if unknown
 * @param showCooldown - If `true`, include a cooldown/readiness indicator when applicable
 * @param ui - Runtime UI options that control styling and rendering
 * @returns The composed quota window string (label, bar, optional percent, optional cooldown)
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
 * Build a compact, styled quota summary for an account.
 *
 * @param account - Account data used to derive 5h/7d quota segments, cooldowns, and rate-limited status
 * @param ui - UI runtime options that control styling and v2 vs legacy rendering
 * @returns The formatted quota summary string; returns an empty string if no quota information is available
 *
 * Concurrency: pure and safe for concurrent calls.
 * Filesystem: does not perform filesystem I/O or platform-specific (Windows) operations.
 * Token redaction: does not expose authentication tokens; only formats provided summary text and numeric quota values.
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
 * Build a compact, display-ready hint for an account containing status, last-used time, and quota limits, formatted for the current UI mode.
 *
 * Concurrency: pure and safe to call concurrently; it does not mutate inputs. Filesystem: performs no filesystem or platform-specific I/O (including Windows). Token redaction: formats provided account values as-is and does not redact secrets or tokens.
 *
 * @param account - AccountInfo whose status, timestamps, quota fields, and display flags control which hint parts are included and their order.
 * @param ui - UI runtime options that determine painting, v2 styling, and tone mapping.
 * @returns The composed hint string (parts joined by a muted separator, possibly multi-line) or an empty string when no hint parts apply.
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
 * Prompt the user to enter a search query, showing the existing query as a suffix when available.
 *
 * When running in a non-TTY environment this function returns the provided `current` value unchanged.
 * Concurrency: prompts share the process stdin/stdout and must not be invoked concurrently; callers should serialize prompt calls.
 * Windows: behavior is consistent on Windows terminals; line endings are normalized by the readline interface.
 * Security: this function does not redact input; callers must handle redaction or secure handling of any tokens or secrets entered.
 *
 * @param current - Existing query to display as a suffix (shown as ` (current)`); an empty answer clears the query.
 * @returns The user's trimmed, lowercased query string, or `current` if stdin/stdout are not a TTY.
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
 * Produce a stable focus key for an AuthMenuAction.
 *
 * The key uniquely identifies either an account-scoped item or a global action so UI state (focus/selection)
 * can be preserved and compared across renders.
 *
 * Concurrency: pure and side-effect free; safe to call concurrently.
 * Filesystem note: the key may contain characters such as `:` and must be sanitized before use as a filename on Windows.
 * Security: the key never includes secrets or tokens and is safe for logging.
 *
 * @param action - The action to produce a focus key for
 * @returns `account:<sourceIndex|index>` for account-scoped actions, `action:<type>` for non-account actions
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
 * Present an interactive account management menu and return the user's chosen action.
 *
 * @param accounts - List of accounts to display and operate on; each item may include rendering hints and quick-switch numbers.
 * @param options - Optional menu behavior overrides (e.g., flaggedCount, statusMessage).
 * @returns The selected AuthMenuAction describing the user's choice (add, select-account, delete-account, refresh-account, set-current-account, toggle-account, delete-all, search, cancel, etc.).
 *
 * @remarks
 * Concurrency: this function is intended for single-user, interactive use and is not safe for concurrent invocations that share the same stdin/stdout streams.
 *
 * Filesystem (Windows): no filesystem modification is performed by this function; any downstream actions triggered by the returned action may have platform-specific filesystem considerations on Windows.
 *
 * Token redaction: UI output produced by this menu must not expose raw authentication tokens; any sensitive identifiers shown to the user should be redacted or truncated by callers or the formatting helpers before rendering.
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
 * Present an interactive action menu for a single account and return the user's chosen action.
 *
 * Displays account title, status, added/last-used info, and prompts the user to choose one of: back, toggle enable/disable, set-current, refresh, or delete.
 *
 * Concurrency: intended for single interactive use — do not call concurrently from multiple fronts in the same process.
 * Windows filesystem: no filesystem operations are performed by this function; behavior is not affected by Windows path semantics.
 * Token redaction: this function does not print or persist authentication tokens; callers are responsible for ensuring any sensitive account fields are redacted before logging.
 *
 * @param account - The AccountInfo record to inspect and act upon
 * @returns The selected AccountAction, or `"cancel"` if the user aborts the interaction
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
