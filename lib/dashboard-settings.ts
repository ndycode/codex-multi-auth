import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { logWarn } from "./logger.js";
import { sleep } from "./utils.js";
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
const RETRYABLE_READ_CODES = new Set(["EBUSY", "EPERM", "EAGAIN"]);
const LEGACY_READ_MAX_ATTEMPTS = 4;
const LEGACY_READ_BASE_DELAY_MS = 20;

/**
 * Checks whether a value is a non-null object that can be treated as a string-keyed record.
 *
 * @param value - Value to test
 * @returns `true` if `value` is an object and not `null` (narrowed to `Record<string, unknown>`), `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRetryableReadError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_READ_CODES.has(code);
}

async function readLegacySettingsFile(path: string): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt < LEGACY_READ_MAX_ATTEMPTS; attempt += 1) {
		try {
			return await fs.readFile(path, "utf8");
		} catch (error) {
			if (!isRetryableReadError(error) || attempt + 1 >= LEGACY_READ_MAX_ATTEMPTS) {
				throw error;
			}
			lastError = error;
			await sleep(LEGACY_READ_BASE_DELAY_MS * 2 ** attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Failed to read legacy dashboard settings");
}

/**
 * Coerces a value to a boolean, using a provided fallback when the input is not a boolean.
 *
 * @param value - The input to evaluate; only `true` and `false` are accepted as boolean values
 * @param fallback - The boolean to return when `value` is not a boolean
 * @returns The boolean `value` if it is a boolean, otherwise `fallback`
 */
function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Normalize an input value into a dashboard theme preset.
 *
 * @param value - Untrusted input to coerce to a theme preset
 * @returns `"blue"` if `value` is exactly `"blue"`, `"green"` otherwise
 */
function normalizeThemePreset(value: unknown): DashboardThemePreset {
	return value === "blue" ? "blue" : "green";
}

/**
 * Normalize an input value into an allowed dashboard accent color, defaulting to green.
 *
 * @param value - Input value to coerce into an accent color
 * @returns `'cyan'`, `'blue'`, or `'yellow'` if `value` matches one of those strings; otherwise `'green'`
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
 * Validate a dashboard layout mode, allowing only "expanded-rows".
 *
 * @param value - Candidate value to validate as a layout mode
 * @param fallback - Value to return when `value` is not `"expanded-rows"`
 * @returns `"expanded-rows"` if `value` strictly equals that string, otherwise `fallback`
 */
function normalizeLayoutMode(
	value: unknown,
	fallback: DashboardLayoutMode,
): DashboardLayoutMode {
	return value === "expanded-rows" ? "expanded-rows" : fallback;
}

/**
 * Coerces an arbitrary value into the dashboard focus style.
 *
 * @param value - Value to coerce into a DashboardFocusStyle
 * @returns The normalized focus style; always `'row-invert'`.
 */
function normalizeFocusStyle(value: unknown): DashboardFocusStyle {
	return value === "row-invert" ? "row-invert" : "row-invert";
}

/**
 * Normalize a numeric TTL (milliseconds) into a validated, rounded, bounded integer.
 *
 * @param value - The input value to normalize; if not a finite number, the function falls back.
 * @param fallback - Value returned when `value` is not a finite number.
 * @returns A rounded integer number of milliseconds between 60,000 and 1,800,000 (30 minutes), or `fallback` if `value` is invalid.
 */
function normalizeQuotaTtlMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.max(60_000, Math.min(30 * 60_000, rounded));
}

/**
 * Normalize a candidate account sort mode to a known mode.
 *
 * @param value - The input value to validate as an account sort mode
 * @param fallback - Mode to use if `value` is not a recognized sort mode
 * @returns The validated `DashboardAccountSortMode`: `ready-first` or `manual` if `value` matches, otherwise `fallback`
 */
function normalizeAccountSortMode(value: unknown, fallback: DashboardAccountSortMode): DashboardAccountSortMode {
	if (value === "ready-first" || value === "manual") {
		return value;
	}
	return fallback;
}

/**
 * Coerces an untrusted value to an integer millisecond timeout between 0 and 10000.
 *
 * This rounds and clamps numeric input; if the input is not a finite number the provided
 * fallback is returned. Safe to call concurrently. Filesystem semantics, Windows atomicity,
 * and unified-settings token redaction are not applicable to this operation.
 *
 * @param value - The untrusted input to normalize
 * @param fallback - The numeric fallback to use when `value` is invalid
 * @returns A millisecond timeout value between 0 and 10000 inclusive
 */
function normalizeAutoReturnMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.max(0, Math.min(10_000, rounded));
}

/**
 * Coerces an arbitrary value into a deduplicated, order-preserving list of allowed statusline fields.
 *
 * @param value - The input to normalize; may be any value. Non-string entries, unknown fields, and duplicates are discarded.
 * @returns An array of `DashboardStatuslineField` in their original order with duplicates removed. If the input is not an array or yields no valid fields, returns the default statusline fields.
 */
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
 * Convert a DashboardDisplaySettings object into a plain record suitable for JSON serialization and persistence.
 *
 * @param value - The dashboard display settings to serialize
 * @returns A shallow Record<string, unknown> containing the same keys and values as `value`, ready for JSON encoding
 *
 * Notes:
 * - This function performs no I/O and is safe to call concurrently.
 * - It does not perform any token redaction or platform-specific path normalization; behavior is identical across platforms (including Windows).
 */
function toJsonRecord(value: DashboardDisplaySettings): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value)) {
		record[key] = fieldValue;
	}
	return record;
}

/**
 * Filesystem path to the unified dashboard settings file.
 *
 * This path is the canonical location used by the load/save helpers. Callers should assume the file may be concurrently modified by other processes and use atomic write strategies when persisting. On Windows the returned path may contain backslashes; redact any sensitive tokens before logging or external reporting.
 *
 * @returns The absolute path to the unified dashboard settings file.
 */
export function getDashboardSettingsPath(): string {
	return getUnifiedSettingsPath();
}

/**
 * Normalize an untrusted value into a complete, validated DashboardDisplaySettings object.
 *
 * Produces a settings object where missing or invalid fields are replaced with sensible defaults,
 * layout-derived fields are resolved, numeric values are clamped to allowed ranges, and enumerations
 * are coerced to allowed values.
 *
 * Concurrency: pure and deterministic; safe to call concurrently. This function performs no I/O,
 * so Windows filesystem semantics do not apply. It does not perform token redaction or any
 * sensitive-data filtering.
 *
 * @param value - The input to normalize (may be any type, typically parsed JSON or a partial settings record)
 * @returns A DashboardDisplaySettings object with all fields validated and defaulted
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
 * Load and return the normalized dashboard display settings, migrating legacy settings when present.
 *
 * Attempts to read unified settings first; if absent, loads legacy dashboard-settings.json, normalizes
 * its contents, and tries to migrate the normalized result to the unified settings store. On any read,
 * parse, or validation error, or if no settings are found, returns the built-in defaults.
 *
 * @returns The normalized DashboardDisplaySettings to apply.
 *
 * @remarks
 * - Concurrency: callers may race with other processes performing migration or writes; callers should
 *   not assume exclusive access and should tolerate eventual consistency.
 * - Filesystem (Windows): legacy-path checks use case-insensitive filesystem semantics implicitly; ensure
 *   any external tooling accounts for that when placing or removing legacy files.
 * - Token handling: persisted settings are stored as-is; remove or redact any sensitive tokens from
 *   settings before calling this function if they must not be written unmodified to persistent stores.
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
		const raw = await readLegacySettingsFile(DASHBOARD_SETTINGS_PATH);
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
 * Persist normalized dashboard display settings to the unified settings store.
 *
 * Normalizes `settings` and writes the resulting record via the unified settings API.
 * Concurrent callers may race and overwrite each other; callers should serialize updates
 * when strong write ordering is required. On Windows, underlying filesystem writes may
 * not be atomic across processes. Any sensitive tokens or secrets present in settings
 * are written as provided; callers must remove or redact sensitive values before saving.
 *
 * @param settings - The dashboard display settings to normalize and save
 */
export async function saveDashboardDisplaySettings(
	settings: DashboardDisplaySettings,
): Promise<void> {
	const normalized = normalizeDashboardDisplaySettings(settings);
	await saveUnifiedDashboardSettings(toJsonRecord(normalized));
}
