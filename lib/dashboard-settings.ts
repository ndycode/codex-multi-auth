import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { logWarn } from "./logger.js";
import {
	getUnifiedSettingsPath,
	loadUnifiedDashboardSettings,
	saveUnifiedDashboardSettings,
} from "./unified-settings.js";

export type DashboardThemePreset = "green" | "blue";
export type DashboardAccentColor = "green" | "cyan" | "blue" | "yellow";
export type DashboardAccountSortMode = "manual" | "ready-first";
export type DashboardLayoutMode = "compact-details" | "expanded-rows";
export type DashboardFocusStyle = "row-invert";

export interface DashboardDisplaySettings {
	showPerAccountRows: boolean;
	showQuotaDetails: boolean;
	showForecastReasons: boolean;
	showRecommendations: boolean;
	showLiveProbeNotes: boolean;
	actionAutoReturnMs?: number;
	actionPauseOnKey?: boolean;
	menuAutoFetchLimits?: boolean;
	menuSortEnabled?: boolean;
	menuSortMode?: DashboardAccountSortMode;
	menuSortPinCurrent?: boolean;
	menuSortQuickSwitchVisibleRow?: boolean;
	uiThemePreset?: DashboardThemePreset;
	uiAccentColor?: DashboardAccentColor;
	menuShowStatusBadge?: boolean;
	menuShowCurrentBadge?: boolean;
	menuShowLastUsed?: boolean;
	menuShowQuotaSummary?: boolean;
	menuShowQuotaCooldown?: boolean;
	menuShowFetchStatus?: boolean;
	menuShowDetailsForUnselectedRows?: boolean;
	menuLayoutMode?: DashboardLayoutMode;
	menuQuotaTtlMs?: number;
	menuFocusStyle?: DashboardFocusStyle;
	menuHighlightCurrentRow?: boolean;
	menuStatuslineFields?: DashboardStatuslineField[];
}

export type DashboardStatuslineField = "last-used" | "limits" | "status";

export const DASHBOARD_DISPLAY_SETTINGS_VERSION = 1 as const;

export const DEFAULT_DASHBOARD_DISPLAY_SETTINGS: DashboardDisplaySettings = {
	showPerAccountRows: true,
	showQuotaDetails: true,
	showForecastReasons: true,
	showRecommendations: true,
	showLiveProbeNotes: true,
	actionAutoReturnMs: 2_000,
	actionPauseOnKey: true,
	menuAutoFetchLimits: true,
	menuSortEnabled: true,
	menuSortMode: "ready-first",
	menuSortPinCurrent: false,
	menuSortQuickSwitchVisibleRow: true,
	uiThemePreset: "green",
	uiAccentColor: "green",
	menuShowStatusBadge: true,
	menuShowCurrentBadge: true,
	menuShowLastUsed: true,
	menuShowQuotaSummary: true,
	menuShowQuotaCooldown: true,
	menuShowFetchStatus: true,
	menuShowDetailsForUnselectedRows: false,
	menuLayoutMode: "compact-details",
	menuQuotaTtlMs: 5 * 60_000,
	menuFocusStyle: "row-invert",
	menuHighlightCurrentRow: true,
	menuStatuslineFields: ["last-used", "limits", "status"],
};

const DASHBOARD_SETTINGS_PATH = join(getCodexMultiAuthDir(), "dashboard-settings.json");

/**
 * Determines whether a value is a non-null object that can be treated as a string-keyed record.
 *
 * @param value - The value to test
 * @returns `true` if `value` is an object and not `null`, `false` otherwise
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Normalize an unknown value to a boolean, using a fallback when the value is not a boolean.
 *
 * This function has no side effects, does not perform I/O, and does not redact or inspect tokens; it is safe for concurrent use.
 *
 * @param value - The value to normalize
 * @param fallback - The fallback boolean to use when `value` is not a boolean
 * @returns The boolean `value` if `value` is a boolean, otherwise `fallback`
 */
function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Normalize an arbitrary value into a DashboardThemePreset.
 *
 * This function is pure and has no concurrency or filesystem effects; it behaves the same on Windows and does not read or expose tokens.
 *
 * @param value - The input value to interpret as a theme preset
 * @returns `blue` if `value` is exactly `"blue"`, `green` otherwise
 */
function normalizeThemePreset(value: unknown): DashboardThemePreset {
	return value === "blue" ? "blue" : "green";
}

/**
 * Normalize a user-provided accent color to one of the supported dashboard accent values.
 *
 * @param value - Candidate accent value to normalize (any type)
 * @returns The normalized `DashboardAccentColor`: `"cyan"`, `"blue"`, `"yellow"`, or `"green"` (default)
 */
function normalizeAccentColor(value: unknown): DashboardAccentColor {
	switch (value) {
		case "cyan":
			return "cyan";
		case "blue":
			return "blue";
		case "yellow":
			return "yellow";
		default:
			return "green";
	}
}

/**
 * Normalize a layout mode value, defaulting to the provided fallback when invalid.
 *
 * This function is synchronous, has no filesystem side effects, and does not perform any token handling or redaction; it is safe to call concurrently.
 *
 * @param value - The input value to validate as a layout mode
 * @param fallback - The layout mode to return when `value` is not `"expanded-rows"`
 * @returns `"expanded-rows"` if `value` strictly equals that string, otherwise `fallback`
 */
function normalizeLayoutMode(
	value: unknown,
	fallback: DashboardLayoutMode,
): DashboardLayoutMode {
	return value === "expanded-rows" ? "expanded-rows" : fallback;
}

/**
 * Normalize a dashboard focus style value to a valid DashboardFocusStyle.
 *
 * This function is deterministic and side-effect free; it is safe for concurrent use.
 * It does not access the filesystem (no Windows-specific behavior) and does not handle or redact tokens.
 *
 * @param value - Input value to normalize
 * @returns The normalized focus style value, always `"row-invert"`
 */
function normalizeFocusStyle(value: unknown): DashboardFocusStyle {
	return value === "row-invert" ? "row-invert" : "row-invert";
}

/**
 * Normalize a candidate quota TTL (milliseconds) into a valid bounded millisecond value.
 *
 * Returns the nearest integer millisecond clamped to the range 60,000 — 1,800,000.
 *
 * @param value - Candidate TTL in milliseconds; if not a finite number, `fallback` is used
 * @param fallback - Millisecond value to use when `value` is invalid
 * @returns A rounded millisecond value between 60,000 and 1,800,000 inclusive
 *
 * Concurrency: pure and side-effect free. Filesystem: not applicable. Token handling: not applicable.
 */
function normalizeQuotaTtlMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.max(60_000, Math.min(30 * 60_000, rounded));
}

/**
 * Normalize a value into a valid dashboard account sort mode.
 *
 * This is a pure, concurrency-safe helper: it performs no I/O, is unaffected by Windows filesystem semantics,
 * and does not log or expose tokens or secrets.
 *
 * @param value - Candidate value to normalize (may be any type)
 * @param fallback - Mode to return when `value` is not a supported mode
 * @returns `'ready-first'` or `'manual'` when `value` matches one of those, otherwise `fallback`
 */
function normalizeAccountSortMode(value: unknown, fallback: DashboardAccountSortMode): DashboardAccountSortMode {
	if (value === "ready-first" || value === "manual") {
		return value;
	}
	return fallback;
}

/**
 * Normalize an auto-return timeout (milliseconds) into the allowed range.
 *
 * @param value - The input value to normalize; if not a finite number the `fallback` is used
 * @param fallback - Value returned when `value` is invalid
 * @returns The timeout in milliseconds rounded to an integer and clamped to the range 0–10000, or `fallback` if `value` is not a finite number
 */
function normalizeAutoReturnMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.max(0, Math.min(10_000, rounded));
}

/**
 * Produces a validated, deduplicated list of statusline fields from an arbitrary value.
 *
 * @param value - Input expected to be an array of strings; accepted items are `"last-used"`, `"limits"`, and `"status"`. Non-string entries and unknown values are ignored; duplicate entries are removed while preserving first occurrence order.
 * @returns An array of allowed `DashboardStatuslineField` values in the original order; if the input is not an array or yields no valid fields, returns the default statusline fields.
 *
 * Concurrency: Pure and safe for concurrent use. Windows filesystem: not applicable. Token redaction: does not handle or emit sensitive tokens. */
function normalizeStatuslineFields(value: unknown): DashboardStatuslineField[] {
	const defaultFields = [...(DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuStatuslineFields ?? [])];
	if (!Array.isArray(value)) return defaultFields;

	const allowed = new Set<DashboardStatuslineField>(["last-used", "limits", "status"]);
	const fields: DashboardStatuslineField[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		if (!allowed.has(entry as DashboardStatuslineField)) continue;
		const typed = entry as DashboardStatuslineField;
		if (!fields.includes(typed)) {
			fields.push(typed);
		}
	}

	return fields.length > 0 ? fields : defaultFields;
}

/**
 * Produces a plain JSON-serializable record from a DashboardDisplaySettings object.
 *
 * This is a pure, side-effect-free conversion: it copies all top-level fields as-is,
 * is safe for concurrent use, does not perform any token redaction, and does not
 * apply any Windows-specific filesystem path normalization.
 *
 * @param value - The dashboard settings to convert
 * @returns A plain Record<string, unknown> containing the same top-level fields and values as `value`
 */
function toJsonRecord(value: DashboardDisplaySettings): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value)) {
		record[key] = fieldValue;
	}
	return record;
}

/**
 * Gets the filesystem path to the dashboard settings file within the unified settings store.
 *
 * This path is stable for the current runtime and may be used for reading legacy settings or diagnostics.
 * Concurrency: callers should coordinate external writes/reads (no internal locking is provided).
 * Windows: path will use platform-native separators and may contain UNC or drive-letter forms.
 * Security: the returned path may reference files that contain sensitive tokens; callers must redact or handle contents accordingly.
 *
 * @returns Absolute filesystem path to the unified dashboard settings file
 */
export function getDashboardSettingsPath(): string {
	return getUnifiedSettingsPath();
}

/**
 * Normalize an untrusted input into a complete DashboardDisplaySettings object.
 *
 * Produces a validated, fully-populated settings object using defaults and derived values
 * (e.g., layout derived from legacy flags). The function is pure and side-effect-free,
 * safe for concurrent use, and does not access the filesystem or perform I/O; its behavior
 * is independent of Windows filesystem semantics. It also does not persist, log, or redact
 * tokens/credentials — it only validates and normalizes fields.
 *
 * @param value - An untrusted value (typically parsed JSON) to validate and normalize into DashboardDisplaySettings
 * @returns A complete DashboardDisplaySettings object with defaults applied and derived fields resolved
 */
export function normalizeDashboardDisplaySettings(
	value: unknown,
): DashboardDisplaySettings {
	if (!isRecord(value)) {
		return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
	}
	const derivedLayoutMode = normalizeLayoutMode(
		value.menuLayoutMode,
		value.menuShowDetailsForUnselectedRows === true ? "expanded-rows" : "compact-details",
	);
	return {
		showPerAccountRows: normalizeBoolean(
			value.showPerAccountRows,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showPerAccountRows,
		),
		showQuotaDetails: normalizeBoolean(
			value.showQuotaDetails,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showQuotaDetails,
		),
		showForecastReasons: normalizeBoolean(
			value.showForecastReasons,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showForecastReasons,
		),
		showRecommendations: normalizeBoolean(
			value.showRecommendations,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showRecommendations,
		),
		showLiveProbeNotes: normalizeBoolean(
			value.showLiveProbeNotes,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showLiveProbeNotes,
		),
		actionAutoReturnMs: normalizeAutoReturnMs(
			value.actionAutoReturnMs,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.actionAutoReturnMs ?? 2_000,
		),
		actionPauseOnKey: normalizeBoolean(
			value.actionPauseOnKey,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.actionPauseOnKey ?? true,
		),
		menuAutoFetchLimits: normalizeBoolean(
			value.menuAutoFetchLimits,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuAutoFetchLimits ?? true,
		),
		menuSortEnabled: normalizeBoolean(
			value.menuSortEnabled,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? false,
		),
		menuSortMode: normalizeAccountSortMode(
			value.menuSortMode,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first",
		),
		menuSortPinCurrent: normalizeBoolean(
			value.menuSortPinCurrent,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ?? true,
		),
		menuSortQuickSwitchVisibleRow: normalizeBoolean(
			value.menuSortQuickSwitchVisibleRow,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortQuickSwitchVisibleRow ?? true,
		),
		uiThemePreset: normalizeThemePreset(
			value.uiThemePreset,
		),
		uiAccentColor: normalizeAccentColor(
			value.uiAccentColor,
		),
		menuShowStatusBadge: normalizeBoolean(
			value.menuShowStatusBadge,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowStatusBadge ?? true,
		),
		menuShowCurrentBadge: normalizeBoolean(
			value.menuShowCurrentBadge,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowCurrentBadge ?? true,
		),
		menuShowLastUsed: normalizeBoolean(
			value.menuShowLastUsed,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowLastUsed ?? true,
		),
		menuShowQuotaSummary: normalizeBoolean(
			value.menuShowQuotaSummary,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowQuotaSummary ?? true,
		),
		menuShowQuotaCooldown: normalizeBoolean(
			value.menuShowQuotaCooldown,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowQuotaCooldown ?? true,
		),
		menuShowFetchStatus: normalizeBoolean(
			value.menuShowFetchStatus,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowFetchStatus ?? true,
		),
		menuShowDetailsForUnselectedRows: derivedLayoutMode === "expanded-rows",
		menuLayoutMode: derivedLayoutMode,
		menuQuotaTtlMs: normalizeQuotaTtlMs(
			value.menuQuotaTtlMs,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuQuotaTtlMs ?? 5 * 60_000,
		),
		menuFocusStyle: normalizeFocusStyle(value.menuFocusStyle),
		menuHighlightCurrentRow: normalizeBoolean(
			value.menuHighlightCurrentRow,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuHighlightCurrentRow ?? true,
		),
		menuStatuslineFields: normalizeStatuslineFields(value.menuStatuslineFields),
	};
}

/**
 * Loads dashboard display settings, falling back to defaults and migrating legacy settings when present.
 *
 * Attempts to read settings from the unified settings store; if absent, reads a legacy JSON file at the
 * dashboard settings path, normalizes the values, and migrates them into the unified store when possible.
 * If the legacy file is missing or any I/O/parse error occurs, returns the default settings. Migration
 * failures are ignored to preserve legacy fallback behavior.
 *
 * Concurrency: callers should assume other processes may concurrently read or write settings; this function
 * does not provide cross-process locking. On Windows, file reads may observe transient sharing/locking issues
 * which will cause a fallback to defaults. Any sensitive tokens present in legacy files are not specially
 * redacted by this loader; callers and the migration path are responsible for token handling and redaction.
 *
 * @returns The normalized dashboard display settings object.
 */
export async function loadDashboardDisplaySettings(): Promise<DashboardDisplaySettings> {
	const unifiedSettings = await loadUnifiedDashboardSettings();
	if (unifiedSettings) {
		return normalizeDashboardDisplaySettings(unifiedSettings);
	}

	if (!existsSync(DASHBOARD_SETTINGS_PATH)) {
		return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
	}

	try {
		const raw = await fs.readFile(DASHBOARD_SETTINGS_PATH, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) {
			return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
		}
		const normalized = normalizeDashboardDisplaySettings(parsed.settings);
		try {
			await saveUnifiedDashboardSettings(toJsonRecord(normalized));
		} catch {
			// Keep legacy fallback behavior even if migration write fails.
		}
		return normalized;
	} catch (error) {
		logWarn(
			`Failed to load dashboard settings from ${DASHBOARD_SETTINGS_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
	}
}

/**
 * Persist dashboard display settings to the unified settings store after normalizing them.
 *
 * Normalizes `settings` with file-local rules then saves the resulting plain record via the unified
 * settings API. Concurrent saves are not coordinated by this function; the last write wins.
 * This function does not perform secret or token redaction — callers must ensure no sensitive
 * values are present. Behavior of underlying storage (e.g., file locking or atomic writes) may
 * vary by platform (Windows filesystem semantics depend on the unified settings implementation).
 *
 * @param settings - The display settings to normalize and persist
 * @returns void
 */
export async function saveDashboardDisplaySettings(
	settings: DashboardDisplaySettings,
): Promise<void> {
	const normalized = normalizeDashboardDisplaySettings(settings);
	await saveUnifiedDashboardSettings(toJsonRecord(normalized));
}
