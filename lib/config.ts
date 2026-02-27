import { readFileSync, existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginConfig } from "./types.js";
import { logWarn } from "./logger.js";
import { PluginConfigSchema, getValidationErrors } from "./schemas.js";
import { getCodexHomeDir, getCodexMultiAuthDir, getLegacyOpenCodeDir } from "./runtime-paths.js";
import {
	getUnifiedSettingsPath,
	loadUnifiedPluginConfigSync,
	saveUnifiedPluginConfig,
	saveUnifiedPluginConfigSync,
} from "./unified-settings.js";

const CONFIG_DIR = getCodexMultiAuthDir();
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const LEGACY_CODEX_CONFIG_PATH = join(getCodexHomeDir(), "codex-multi-auth-config.json");
const LEGACY_OPENCODE_CONFIG_PATH = join(
	getLegacyOpenCodeDir(),
	"codex-multi-auth-config.json",
);
const LEGACY_OPENCODE_AUTH_CONFIG_PATH = join(
	getLegacyOpenCodeDir(),
	"openai-codex-auth-config.json",
);
const TUI_COLOR_PROFILES = new Set(["truecolor", "ansi16", "ansi256"]);
const TUI_GLYPH_MODES = new Set(["ascii", "unicode", "auto"]);
const UNSUPPORTED_CODEX_POLICIES = new Set(["strict", "fallback"]);
const emittedConfigWarnings = new Set<string>();

export type UnsupportedCodexPolicy = "strict" | "fallback";

function logConfigWarnOnce(message: string): void {
	if (emittedConfigWarnings.has(message)) {
		return;
	}
	emittedConfigWarnings.add(message);
	logWarn(message);
}

export function __resetConfigWarningCacheForTests(): void {
	emittedConfigWarnings.clear();
}

/**
 * Determine the active plugin configuration file path, preferring an explicit environment override, then the unified config path, then legacy locations.
 *
 * @returns The resolved config file path, or `null` when no config file is present.
 *
 * @remarks
 * - If `CODEX_MULTI_AUTH_CONFIG_PATH` is set and non-empty, that path is returned as-is.
 * - When a legacy path is selected a single warning is emitted (the warning will not include sensitive token values).
 * - The function only checks existence; it does not read or write files. Concurrent callers may observe the same result but external filesystem changes can affect later calls.
 * - On Windows, filesystem case-sensitivity follows the OS/filesystem semantics and may affect path resolution.
function resolvePluginConfigPath(): string | null {
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();
	if (envPath.length > 0) {
		return envPath;
	}

	if (existsSync(CONFIG_PATH)) {
		return CONFIG_PATH;
	}

	if (existsSync(LEGACY_CODEX_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy config path ${LEGACY_CODEX_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_CODEX_CONFIG_PATH;
	}

	if (existsSync(LEGACY_OPENCODE_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy OpenCode config path ${LEGACY_OPENCODE_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_OPENCODE_CONFIG_PATH;
	}

	if (existsSync(LEGACY_OPENCODE_AUTH_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy OpenCode config path ${LEGACY_OPENCODE_AUTH_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_OPENCODE_AUTH_CONFIG_PATH;
	}

	return null;
}

/**
 * Default plugin configuration
 * CODEX_MODE is enabled by default for better Codex CLI parity
 */
export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
	codexMode: true,
	codexTuiV2: true,
	codexTuiColorProfile: "truecolor",
	codexTuiGlyphMode: "ascii",
	fastSession: false,
	fastSessionStrategy: "hybrid",
	fastSessionMaxInputItems: 30,
	retryAllAccountsRateLimited: true,
	retryAllAccountsMaxWaitMs: 0,
	retryAllAccountsMaxRetries: Infinity,
	unsupportedCodexPolicy: "strict",
	fallbackOnUnsupportedCodexModel: false,
	fallbackToGpt52OnUnsupportedGpt53: true,
	unsupportedCodexFallbackChain: {},
	tokenRefreshSkewMs: 60_000,
	rateLimitToastDebounceMs: 60_000,
	toastDurationMs: 5_000,
	perProjectAccounts: true,
	sessionRecovery: true,
	autoResume: true,
	parallelProbing: false,
	parallelProbingMaxConcurrency: 2,
	emptyResponseMaxRetries: 2,
	emptyResponseRetryDelayMs: 1_000,
	pidOffsetEnabled: false,
	fetchTimeoutMs: 60_000,
	streamStallTimeoutMs: 45_000,
	liveAccountSync: true,
	liveAccountSyncDebounceMs: 250,
	liveAccountSyncPollMs: 2_000,
	sessionAffinity: true,
	sessionAffinityTtlMs: 20 * 60_000,
	sessionAffinityMaxEntries: 512,
	proactiveRefreshGuardian: true,
	proactiveRefreshIntervalMs: 60_000,
	proactiveRefreshBufferMs: 5 * 60_000,
	networkErrorCooldownMs: 6_000,
	serverErrorCooldownMs: 4_000,
	storageBackupEnabled: true,
	preemptiveQuotaEnabled: true,
	preemptiveQuotaRemainingPercent5h: 5,
	preemptiveQuotaRemainingPercent7d: 5,
	preemptiveQuotaMaxDeferralMs: 2 * 60 * 60_000,
};

/**
 * Provides a shallow copy of the default plugin configuration.
 *
 * The returned object is a shallow clone of DEFAULT_PLUGIN_CONFIG; nested objects are shared with the original, so avoid mutating nested fields concurrently. When this configuration is persisted, platform filesystem semantics (including Windows path normalization and permissions) apply. The configuration may contain sensitive tokens or secrets — ensure persistence and logging paths perform appropriate redaction.
 *
 * @returns A shallow copy of the default PluginConfig suitable as a baseline configuration
 */
export function getDefaultPluginConfig(): PluginConfig {
	return { ...DEFAULT_PLUGIN_CONFIG };
}

/**
 * Load and return the effective plugin configuration by merging any user-provided settings with defaults.
 *
 * Loads configuration from the unified settings store if present; otherwise reads from the active config file
 * (env override, legacy locations, or CONFIG_PATH), validates the result, emits up to three validation warnings,
 * and attempts to migrate file-based configs into the unified settings store when appropriate. If loading fails
 * or no user configuration is available, returns a copy of the default plugin configuration.
 *
 * Notes:
 * - Concurrency: callers should avoid concurrently writing the same config file from multiple processes; this
 *   function performs only reads (and a best-effort migration write) and does not provide cross-process locking.
 * - Windows filesystems: path resolution and migration use OS paths; callers on Windows should ensure environment
 *   variables and file permissions allow reading/writing the resolved config paths.
 * - Token redaction: sensitive token values present in user config are preserved in the returned object but any
 *   warnings or logged messages will not print token values.
 *
 * @returns The merged PluginConfig (defaults overridden by any validated user settings)
 */
export function loadPluginConfig(): PluginConfig {
	try {
		const unifiedConfig = loadUnifiedPluginConfigSync();
		let userConfig: unknown = unifiedConfig;
		let sourceKind: "unified" | "file" = "unified";

		if (!isRecord(userConfig)) {
			const configPath = resolvePluginConfigPath();
			if (!configPath) {
				return { ...DEFAULT_PLUGIN_CONFIG };
			}

			const fileContent = readFileSync(configPath, "utf-8");
			const normalizedFileContent = stripUtf8Bom(fileContent);
			userConfig = JSON.parse(normalizedFileContent) as unknown;
			sourceKind = "file";
		}

		const hasFallbackEnvOverride =
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL !== undefined ||
			process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52 !== undefined;
		if (isRecord(userConfig)) {
			const hasPolicyKey = Object.hasOwn(userConfig, "unsupportedCodexPolicy");
			const hasLegacyFallbackKey =
				Object.hasOwn(userConfig, "fallbackOnUnsupportedCodexModel") ||
				Object.hasOwn(userConfig, "fallbackToGpt52OnUnsupportedGpt53") ||
				Object.hasOwn(userConfig, "unsupportedCodexFallbackChain");
			if (!hasPolicyKey && (hasLegacyFallbackKey || hasFallbackEnvOverride)) {
				logConfigWarnOnce(
					"Legacy unsupported-model fallback settings detected without unsupportedCodexPolicy. " +
						'Using backward-compat behavior; prefer unsupportedCodexPolicy: "strict" | "fallback".',
				);
			}
		}

		const schemaErrors = getValidationErrors(PluginConfigSchema, userConfig);
		if (schemaErrors.length > 0) {
			logConfigWarnOnce(
				`Plugin config validation warnings: ${schemaErrors.slice(0, 3).join(", ")}`,
			);
		}

		if (
			sourceKind === "file" &&
			isRecord(userConfig) &&
			(process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim().length === 0
		) {
			try {
				saveUnifiedPluginConfigSync(userConfig);
			} catch (error) {
				logConfigWarnOnce(
					`Failed to migrate plugin config into ${getUnifiedSettingsPath()}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		return {
			...DEFAULT_PLUGIN_CONFIG,
			...(userConfig as Partial<PluginConfig>),
		};
	} catch (error) {
		const configPath = resolvePluginConfigPath() ?? CONFIG_PATH;
		logConfigWarnOnce(
			`Failed to load config from ${configPath}: ${(error as Error).message}`,
		);
		return { ...DEFAULT_PLUGIN_CONFIG };
	}
}

function stripUtf8Bom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Checks whether a value is a non-null object.
 *
 * This is a pure, synchronous predicate (safe for concurrent use); it does not perform any filesystem
 * operations or token redaction and is unaffected by Windows filesystem semantics.
 *
 * @param value - The value to test
 * @returns `true` if `value` is an object and not `null`, `false` otherwise
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Reads and parses a JSON configuration file at the given filesystem path and returns it as an object, or `null` if the file is missing, invalid, or not a plain object.
 *
 * This function performs a synchronous file read. It does not handle concurrent writers — callers should retry or coordinate if concurrent updates are possible. On Windows, file locks can cause reads to fail; such failures will result in `null` and a single warning being emitted.
 *
 * The function logs only the file path and the error message on failure; file contents (including any sensitive tokens) are not logged or emitted.
 *
 * @param configPath - Absolute or relative filesystem path to the JSON config file
 * @returns The parsed config as a plain object if present and valid, `null` otherwise
 */
function readConfigRecordFromPath(configPath: string): Record<string, unknown> | null {
	if (!existsSync(configPath)) return null;
	try {
		const fileContent = readFileSync(configPath, "utf-8");
		const normalizedFileContent = stripUtf8Bom(fileContent);
		const parsed = JSON.parse(normalizedFileContent) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch (error) {
		logConfigWarnOnce(
			`Failed to read config from ${configPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/**
 * Prepare a partial PluginConfig for persistence by removing undefined values and non-finite numbers and shallow-cloning nested objects.
 *
 * This function is synchronous and side-effect free; callers are responsible for concurrency control when writing the returned object to disk and for any Windows-specific filesystem semantics. It does not redact or mask secrets or tokens — sensitive values must be removed or redacted by the caller before persisting.
 *
 * @param config - The partial plugin configuration to sanitize; entries with `undefined` values or non-finite numbers are omitted, and nested objects are copied shallowly to avoid retaining references to the original.
 * @returns A plain record suitable for JSON serialization containing only the sanitized configuration entries.
 */
function sanitizePluginConfigForSave(config: Partial<PluginConfig>): Record<string, unknown> {
	const entries = Object.entries(config as Record<string, unknown>);
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of entries) {
		if (value === undefined) continue;
		if (typeof value === "number" && !Number.isFinite(value)) continue;
		if (isRecord(value)) {
			sanitized[key] = { ...value };
			continue;
		}
		sanitized[key] = value;
	}
	return sanitized;
}

/**
 * Persists a partial plugin configuration by merging it with existing configuration and saving to the active storage.
 *
 * If the CODEX_MULTI_AUTH_CONFIG_PATH environment variable is set, the patch is merged with the JSON at that path (or creates a new file) and written directly to disk. Otherwise the patch is merged with the unified settings store and saved via the unified settings API; when a legacy file exists and no unified config is present, the legacy file is used as the merge base.
 *
 * Concurrency: callers should assume concurrent invocations can overwrite each other (last write wins); external synchronization is required to avoid lost updates. Files are written with a simple write operation and are not guaranteed atomic across platforms (particularly on Windows).
 *
 * Token and secret handling: this function does not redact or transform sensitive values — callers must avoid passing secrets or ensure they are redacted before calling.
 *
 * @param configPatch - Partial plugin configuration to persist. Entries with `undefined` or non-finite numeric values are omitted before saving.
 * @returns Promise that resolves when the save operation completes. 
 */
export async function savePluginConfig(configPatch: Partial<PluginConfig>): Promise<void> {
	const sanitizedPatch = sanitizePluginConfigForSave(configPatch);
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();

	if (envPath.length > 0) {
		const merged = {
			...(readConfigRecordFromPath(envPath) ?? {}),
			...sanitizedPatch,
		};
		await fs.mkdir(dirname(envPath), { recursive: true });
		await fs.writeFile(envPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
		return;
	}

	const unifiedConfig = loadUnifiedPluginConfigSync();
	const legacyPath = unifiedConfig ? null : resolvePluginConfigPath();
	const merged = {
		...(unifiedConfig ?? (legacyPath ? readConfigRecordFromPath(legacyPath) : null) ?? {}),
		...sanitizedPatch,
	};
	await saveUnifiedPluginConfig(merged);
}

/**
 * Get the effective CODEX_MODE setting
 * Priority: environment variable > config file > default (true)
 *
 * @param pluginConfig - Plugin configuration from file
 * @returns True if CODEX_MODE should be enabled
 */
function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return value === "1";
}

function parseNumberEnv(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return undefined;
	return parsed;
}

function parseStringEnv(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveBooleanSetting(
	envName: string,
	configValue: boolean | undefined,
	defaultValue: boolean,
): boolean {
	const envValue = parseBooleanEnv(process.env[envName]);
	if (envValue !== undefined) return envValue;
	return configValue ?? defaultValue;
}

/**
 * Resolve a numeric setting using environment override, then config value, then default, and clamp it within optional bounds.
 *
 * @param envName - Environment variable name checked first (if present and numeric, it overrides other sources)
 * @param configValue - Value from the plugin configuration used when the env var is absent
 * @param defaultValue - Fallback value used when neither env nor config provide a numeric value
 * @param options - Optional bounds to enforce; `min` and `max` are inclusive
 * @returns The resolved number, clamped to the provided `min`/`max` bounds
 *
 * Concurrency: callers may invoke this concurrently; the function is pure and has no shared state.
 * Windows filesystem: unrelated to filesystem semantics.
 * Token redaction: this function does not log or expose environment values; callers should redact secrets when logging `envName`.
 */
function resolveNumberSetting(
	envName: string,
	configValue: number | undefined,
	defaultValue: number,
	options?: { min?: number; max?: number },
): number {
	const envValue = parseNumberEnv(process.env[envName]);
	const candidate = envValue ?? configValue ?? defaultValue;
	const min = options?.min ?? Number.NEGATIVE_INFINITY;
	const max = options?.max ?? Number.POSITIVE_INFINITY;
	return Math.max(min, Math.min(max, candidate));
}

/**
 * Determine the effective string setting by preferring an allowed environment value, then an allowed config value, and finally the default.
 *
 * This function is pure and safe for concurrent use; it performs no filesystem I/O and does not log or mutate inputs. Environment values are read as-is — treat any sensitive tokens stored in environment variables as redacted when logging elsewhere.
 *
 * @param envName - Name of the environment variable to check
 * @param configValue - Value from the plugin configuration to consider if no valid env value exists
 * @param defaultValue - Fallback value returned when neither env nor config provide an allowed value
 * @param allowedValues - Set of permitted string values; only values contained here will be accepted
 * @returns One of `allowedValues`: the environment value if present and allowed, otherwise the config value if allowed, otherwise `defaultValue`
 */
function resolveStringSetting<T extends string>(
	envName: string,
	configValue: T | undefined,
	defaultValue: T,
	allowedValues: ReadonlySet<string>,
): T {
	const envValue = parseStringEnv(process.env[envName]);
	if (envValue && allowedValues.has(envValue)) {
		return envValue as T;
	}
	if (configValue && allowedValues.has(configValue)) {
		return configValue;
	}
	return defaultValue;
}

export function getCodexMode(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_MODE", pluginConfig.codexMode, true);
}

export function getCodexTuiV2(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_TUI_V2", pluginConfig.codexTuiV2, true);
}

export function getCodexTuiColorProfile(
	pluginConfig: PluginConfig,
): "truecolor" | "ansi16" | "ansi256" {
	return resolveStringSetting(
		"CODEX_TUI_COLOR_PROFILE",
		pluginConfig.codexTuiColorProfile,
		"truecolor",
		TUI_COLOR_PROFILES,
	);
}

export function getCodexTuiGlyphMode(
	pluginConfig: PluginConfig,
): "ascii" | "unicode" | "auto" {
	return resolveStringSetting(
		"CODEX_TUI_GLYPHS",
		pluginConfig.codexTuiGlyphMode,
		"ascii",
		TUI_GLYPH_MODES,
	);
}

export function getFastSession(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FAST_SESSION",
		pluginConfig.fastSession,
		false,
	);
}

export function getFastSessionStrategy(pluginConfig: PluginConfig): "hybrid" | "always" {
	const env = (process.env.CODEX_AUTH_FAST_SESSION_STRATEGY ?? "").trim().toLowerCase();
	if (env === "always") return "always";
	if (env === "hybrid") return "hybrid";
	return pluginConfig.fastSessionStrategy === "always" ? "always" : "hybrid";
}

export function getFastSessionMaxInputItems(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS",
		pluginConfig.fastSessionMaxInputItems,
		30,
		{ min: 8 },
	);
}

export function getRetryAllAccountsRateLimited(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		pluginConfig.retryAllAccountsRateLimited,
		true,
	);
}

export function getRetryAllAccountsMaxWaitMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		pluginConfig.retryAllAccountsMaxWaitMs,
		0,
		{ min: 0 },
	);
}

export function getRetryAllAccountsMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		pluginConfig.retryAllAccountsMaxRetries,
		Infinity,
		{ min: 0 },
	);
}

export function getUnsupportedCodexPolicy(
	pluginConfig: PluginConfig,
): UnsupportedCodexPolicy {
	const envPolicy = parseStringEnv(process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY);
	if (envPolicy && UNSUPPORTED_CODEX_POLICIES.has(envPolicy)) {
		return envPolicy as UnsupportedCodexPolicy;
	}

	const configPolicy =
		typeof pluginConfig.unsupportedCodexPolicy === "string"
			? pluginConfig.unsupportedCodexPolicy.toLowerCase()
			: undefined;
	if (configPolicy && UNSUPPORTED_CODEX_POLICIES.has(configPolicy)) {
		return configPolicy as UnsupportedCodexPolicy;
	}

	const legacyEnvFallback = parseBooleanEnv(
		process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL,
	);
	if (legacyEnvFallback !== undefined) {
		return legacyEnvFallback ? "fallback" : "strict";
	}

	if (typeof pluginConfig.fallbackOnUnsupportedCodexModel === "boolean") {
		return pluginConfig.fallbackOnUnsupportedCodexModel
			? "fallback"
			: "strict";
	}

	return "strict";
}

export function getFallbackOnUnsupportedCodexModel(pluginConfig: PluginConfig): boolean {
	return getUnsupportedCodexPolicy(pluginConfig) === "fallback";
}

export function getFallbackToGpt52OnUnsupportedGpt53(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FALLBACK_GPT53_TO_GPT52",
		pluginConfig.fallbackToGpt52OnUnsupportedGpt53,
		true,
	);
}

export function getUnsupportedCodexFallbackChain(
	pluginConfig: PluginConfig,
): Record<string, string[]> {
	const chain = pluginConfig.unsupportedCodexFallbackChain;
	if (!chain || typeof chain !== "object") {
		return {};
	}

	const normalizeModel = (value: string): string => {
		const trimmed = value.trim().toLowerCase();
		if (!trimmed) return "";
		const stripped = trimmed.includes("/")
			? (trimmed.split("/").pop() ?? trimmed)
			: trimmed;
		return stripped.replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");
	};

	const normalized: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(chain)) {
		if (typeof key !== "string" || !Array.isArray(value)) continue;
		const normalizedKey = normalizeModel(key);
		if (!normalizedKey) continue;

		const targets = value
			.map((target) => (typeof target === "string" ? normalizeModel(target) : ""))
			.filter((target) => target.length > 0);

		if (targets.length > 0) {
			normalized[normalizedKey] = targets;
		}
	}

	return normalized;
}

export function getTokenRefreshSkewMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		pluginConfig.tokenRefreshSkewMs,
		60_000,
		{ min: 0 },
	);
}

export function getRateLimitToastDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		pluginConfig.rateLimitToastDebounceMs,
		60_000,
		{ min: 0 },
	);
}

export function getSessionRecovery(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SESSION_RECOVERY",
		pluginConfig.sessionRecovery,
		true,
	);
}

export function getAutoResume(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_AUTO_RESUME",
		pluginConfig.autoResume,
		true,
	);
}

export function getToastDurationMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_TOAST_DURATION_MS",
		pluginConfig.toastDurationMs,
		5_000,
		{ min: 1_000 },
	);
}

export function getPerProjectAccounts(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PER_PROJECT_ACCOUNTS",
		pluginConfig.perProjectAccounts,
		true,
	);
}

export function getParallelProbing(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PARALLEL_PROBING",
		pluginConfig.parallelProbing,
		false,
	);
}

export function getParallelProbingMaxConcurrency(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
		pluginConfig.parallelProbingMaxConcurrency,
		2,
		{ min: 1 },
	);
}

export function getEmptyResponseMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
		pluginConfig.emptyResponseMaxRetries,
		2,
		{ min: 0 },
	);
}

export function getEmptyResponseRetryDelayMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS",
		pluginConfig.emptyResponseRetryDelayMs,
		1_000,
		{ min: 0 },
	);
}

export function getPidOffsetEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PID_OFFSET_ENABLED",
		pluginConfig.pidOffsetEnabled,
		false,
	);
}

export function getFetchTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_FETCH_TIMEOUT_MS",
		pluginConfig.fetchTimeoutMs,
		60_000,
		{ min: 1_000 },
	);
}

/**
 * Get the configured stream stall timeout in milliseconds.
 *
 * @param pluginConfig - Plugin configuration to resolve the setting from
 * @returns The stream stall timeout in milliseconds (default 45000, minimum enforced 1000)
 *
 * Notes:
 * - Concurrency: safe to call concurrently; it performs no I/O or shared-state mutation.
 * - Windows filesystem: not applicable (no file access).
 * - Token redaction: this function does not read, log, or expose any tokens or secrets.
 */
export function getStreamStallTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
		pluginConfig.streamStallTimeoutMs,
		45_000,
		{ min: 1_000 },
	);
}

/**
 * Determines whether live account synchronization is enabled.
 *
 * @param pluginConfig - Plugin configuration to read the setting from; an explicit environment variable override (CODEX_AUTH_LIVE_ACCOUNT_SYNC) takes precedence over this config value.
 * @returns `true` if live account synchronization is enabled, `false` otherwise.
 *
 * @remarks
 * Concurrency: setting is read-only and safe to call concurrently. Windows filesystem semantics do not affect this read-only resolution. Any sensitive values sourced from environment variables are handled/redacted by higher-level logging and persistence layers, not by this getter.
 */
export function getLiveAccountSync(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC",
		pluginConfig.liveAccountSync,
		true,
	);
}

/**
 * Resolve the effective debounce interval (in milliseconds) used for live account sync.
 *
 * This value may be overridden by the environment variable `CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS`.
 * Concurrency: pure/read-only; no side effects and safe to call concurrently.
 * Windows filesystem: not applicable to this setting.
 * Token redaction: this function does not access or expose any secrets or tokens.
 *
 * @param pluginConfig - Plugin configuration object to read the setting from
 * @returns The debounce interval in milliseconds (default 250, minimum 50)
 */
export function getLiveAccountSyncDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS",
		pluginConfig.liveAccountSyncDebounceMs,
		250,
		{ min: 50 },
	);
}

/**
 * Returns the configured polling interval (in milliseconds) used by live account sync.
 *
 * @param pluginConfig - Plugin configuration to read the setting from; the function reads `liveAccountSyncPollMs`.
 * @returns The resolved polling interval in milliseconds, at least 500 and defaulting to 2000.
 */
export function getLiveAccountSyncPollMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS",
		pluginConfig.liveAccountSyncPollMs,
		2_000,
		{ min: 500 },
	);
}

/**
 * Determines whether session affinity is enabled for the plugin.
 *
 * This value may be overridden by the environment variable `CODEX_AUTH_SESSION_AFFINITY`.
 * Concurrency assumption: enabling session affinity assumes the caller can tolerate stable session-to-account bindings across concurrent requests.
 * Windows filesystem behavior: unrelated to filesystem; no special handling required on Windows.
 * Token redaction: returned boolean does not expose tokens or secrets.
 *
 * @param pluginConfig - Plugin configuration object to read the sessionAffinity setting from
 * @returns `true` if session affinity is enabled, `false` otherwise
 */
export function getSessionAffinity(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SESSION_AFFINITY",
		pluginConfig.sessionAffinity,
		true,
	);
}

/**
 * Get the configured session-affinity TTL in milliseconds.
 *
 * Resolves the effective TTL from environment overrides, the provided plugin config, or the default (20 minutes). The returned value is clamped to a minimum of 1000 ms. This setting is treated as a global timing parameter; callers should assume it can be read concurrently from multiple threads or processes and must not rely on filesystem semantics or per-process persistence. This value does not affect token redaction or storage formats.
 *
 * @param pluginConfig - Plugin configuration to read the session affinity TTL from
 * @returns The session-affinity TTL in milliseconds (at least 1000)
 */
export function getSessionAffinityTtlMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SESSION_AFFINITY_TTL_MS",
		pluginConfig.sessionAffinityTtlMs,
		20 * 60_000,
		{ min: 1_000 },
	);
}

/**
 * Determine the maximum number of session-affinity entries to keep.
 *
 * @param pluginConfig - Plugin configuration to read the configured value from
 * @returns The maximum number of entries (at least 8, default 512). Can be overridden by the CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES environment variable
 */
export function getSessionAffinityMaxEntries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES",
		pluginConfig.sessionAffinityMaxEntries,
		512,
		{ min: 8 },
	);
}

/**
 * Determines whether the proactive token refresh guardian is enabled.
 *
 * The environment variable `CODEX_AUTH_PROACTIVE_GUARDIAN` takes precedence over the
 * value in `pluginConfig`. This getter is safe for concurrent reads and does not
 * perform filesystem operations (so it is unaffected by Windows path semantics).
 * The returned value does not expose or include any secret tokens and is safe for
 * logging or telemetry subject to existing token redaction rules.
 *
 * @param pluginConfig - Plugin configuration used when the environment does not override the setting
 * @returns `true` if proactive refresh guardian is enabled, `false` otherwise
 */
export function getProactiveRefreshGuardian(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN",
		pluginConfig.proactiveRefreshGuardian,
		true,
	);
}

/**
 * Get the effective proactive refresh guardian interval in milliseconds.
 *
 * The returned value reflects environment-variable overrides and the plugin configuration,
 * and is constrained to a minimum of 5,000 ms.
 *
 * Concurrency: intended for use by a single guardian loop per process; callers should
 * coordinate if multiple workers may run concurrently.
 *
 * Platform notes: this getter performs no filesystem I/O and has no Windows-specific behavior.
 *
 * Security: this function does not expose or return sensitive tokens; do not log raw tokens here.
 *
 * @param pluginConfig - Plugin configuration to consult for the default value
 * @returns The interval, in milliseconds, used by the proactive refresh guardian (>= 5000)
 */
export function getProactiveRefreshIntervalMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS",
		pluginConfig.proactiveRefreshIntervalMs,
		60_000,
		{ min: 5_000 },
	);
}

/**
 * Get the effective proactive refresh buffer interval in milliseconds.
 *
 * Resolves the value from the environment override `CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS`, then the plugin configuration, and falls back to 5 minutes if absent; the returned value will be at least 30,000 ms.
 *
 * @param pluginConfig - The plugin configuration to consult for the setting
 * @returns The proactive refresh buffer interval in milliseconds (at least 30000)
 *
 * @remarks
 * - Concurrency: safe to call concurrently from multiple threads/tasks.
 * - Windows filesystem: not applicable to this setting.
 * - Token redaction: no sensitive tokens are read or returned by this function.
 */
export function getProactiveRefreshBufferMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS",
		pluginConfig.proactiveRefreshBufferMs,
		5 * 60_000,
		{ min: 30_000 },
	);
}

/**
 * Determine the effective network error cooldown interval in milliseconds.
 *
 * @param pluginConfig - Plugin configuration to resolve the setting from; treated as read-only and safe for concurrent access.
 *                      This function performs no filesystem I/O (unaffected by Windows path semantics) and does not redact or expose tokens.
 * @returns The cooldown interval in milliseconds (defaults to 6000, minimum 0).
 */
export function getNetworkErrorCooldownMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS",
		pluginConfig.networkErrorCooldownMs,
		6_000,
		{ min: 0 },
	);
}

/**
 * Determines the cooldown period (in milliseconds) to wait after a server error before retrying.
 *
 * This value is resolved from the CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS environment variable (if present),
 * otherwise from pluginConfig.serverErrorCooldownMs, falling back to 4000 ms and constrained to be >= 0.
 *
 * Concurrency: safe to call from multiple threads/processes — it only reads configuration values and returns a number.
 * Windows: environment-variable parsing behaves the same as other platforms.
 * Token redaction: this function does not read or expose sensitive tokens.
 *
 * @param pluginConfig - The plugin configuration to read the server error cooldown from
 * @returns The cooldown duration in milliseconds
 */
export function getServerErrorCooldownMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS",
		pluginConfig.serverErrorCooldownMs,
		4_000,
		{ min: 0 },
	);
}

/**
 * Determines whether persistent storage backups are enabled.
 *
 * @param pluginConfig - The plugin configuration to consult for the setting
 * @returns `true` if storage backup is enabled, `false` otherwise.
 *
 * @remarks
 * - Concurrency: safe to call concurrently from multiple threads/tasks.
 * - Filesystem: this function does not perform any filesystem operations and has no Windows-specific behavior.
 * - Privacy: returns a boolean only and does not expose or log tokens or secrets.
 */
export function getStorageBackupEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_STORAGE_BACKUP_ENABLED",
		pluginConfig.storageBackupEnabled,
		true,
	);
}

/**
 * Determines whether preemptive quota checks are enabled.
 *
 * Safe for concurrent use; performs no filesystem I/O (behavior identical on Windows) and does not expose or log sensitive tokens.
 *
 * @param pluginConfig - Plugin configuration to read the `preemptiveQuotaEnabled` setting from
 * @returns `true` if preemptive quota checks are enabled, `false` otherwise
 */
export function getPreemptiveQuotaEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED",
		pluginConfig.preemptiveQuotaEnabled,
		true,
	);
}

/**
 * Retrieves the configured preemptive quota remaining percentage for the 5-hour window.
 *
 * Resolves the value from the `CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT` environment variable if present; otherwise uses `pluginConfig.preemptiveQuotaRemainingPercent5h` or the default of 5. The resulting value is constrained to the range 0–100.
 *
 * Concurrency: pure and safe for concurrent calls; no shared mutable state or I/O.
 * File-system / Windows: does not access the file system and has no platform-specific behavior.
 * Token redaction: does not read or return secret tokens; callers should treat environment values as sensitive when logging.
 *
 * @param pluginConfig - Plugin configuration used as the fallback source when the environment variable is not set
 * @returns The percentage (0–100) to use for 5-hour preemptive quota checks
 */
export function getPreemptiveQuotaRemainingPercent5h(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT",
		pluginConfig.preemptiveQuotaRemainingPercent5h,
		5,
		{ min: 0, max: 100 },
	);
}

/**
 * Determine the effective 7-day preemptive quota remaining percentage.
 *
 * The value is taken from the environment variable `CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT` if present,
 * otherwise from `pluginConfig.preemptiveQuotaRemainingPercent7d`, falling back to 5. The result is clamped
 * to the range 0–100.
 *
 * Safe to call concurrently; performs no filesystem I/O and behaves consistently on Windows. This function
 * does not expose or log sensitive tokens.
 *
 * @param pluginConfig - Plugin configuration object to read the configured default from
 * @returns The percentage (0–100) of remaining quota used for 7-day preemptive quota decisions
 */
export function getPreemptiveQuotaRemainingPercent7d(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT",
		pluginConfig.preemptiveQuotaRemainingPercent7d,
		5,
		{ min: 0, max: 100 },
	);
}

/**
 * Resolve the maximum preemptive-quota deferral interval in milliseconds.
 *
 * Resolves the effective `preemptiveQuotaMaxDeferralMs` by considering environment overrides and
 * the provided plugin configuration; enforces a minimum of 1000 ms and defaults to 2 hours when
 * unspecified. Concurrency: callers can read this concurrently; no internal mutation occurs.
 * Windows filesystem note: value resolution is platform-agnostic (no filesystem access).
 * Token redaction: this function does not log or expose secrets.
 *
 * @param pluginConfig - Plugin configuration used as the fallback source when no environment override is set
 * @returns The maximum deferral interval in milliseconds (at least 1000 ms, default 7,200,000 ms)
 */
export function getPreemptiveQuotaMaxDeferralMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS",
		pluginConfig.preemptiveQuotaMaxDeferralMs,
		2 * 60 * 60_000,
		{ min: 1_000 },
	);
}
