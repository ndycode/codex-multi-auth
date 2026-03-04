import { readFileSync, existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginConfig } from "./types.js";
import { logWarn } from "./logger.js";
import { PluginConfigSchema, getValidationErrors } from "./schemas.js";
import { getCodexHomeDir, getCodexMultiAuthDir, getLegacyCodexDir } from "./runtime-paths.js";
import {
	getUnifiedSettingsPath,
	loadUnifiedPluginConfigSync,
	saveUnifiedPluginConfig,
} from "./unified-settings.js";

const CONFIG_DIR = getCodexMultiAuthDir();
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CODEX_HOME_DIR = getCodexHomeDir();
const LEGACY_CODEX_DIR = getLegacyCodexDir();
const IS_CUSTOM_CODEX_HOME = CODEX_HOME_DIR !== LEGACY_CODEX_DIR;
const LEGACY_CODEX_HOME_CONFIG_PATH = join(CODEX_HOME_DIR, "codex-multi-auth-config.json");
const LEGACY_CODEX_HOME_AUTH_CONFIG_PATH = join(
	CODEX_HOME_DIR,
	"openai-codex-auth-config.json",
);
const LEGACY_CODEX_CONFIG_PATH = join(
	LEGACY_CODEX_DIR,
	"codex-multi-auth-config.json",
);
const LEGACY_CODEX_AUTH_CONFIG_PATH = join(
	LEGACY_CODEX_DIR,
	"openai-codex-auth-config.json",
);
const TUI_COLOR_PROFILES = new Set(["truecolor", "ansi16", "ansi256"]);
const TUI_GLYPH_MODES = new Set(["ascii", "unicode", "auto"]);
const UNSUPPORTED_CODEX_POLICIES = new Set(["strict", "fallback"]);
const emittedConfigWarnings = new Set<string>();
const configSaveQueues = new Map<string, Promise<void>>();
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);

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
 * Determines the filesystem path to the plugin configuration file, preferring an explicit environment override and falling back to current and legacy locations.
 *
 * The lookup order is:
 * 1. `CODEX_MULTI_AUTH_CONFIG_PATH` environment variable (if set and non-empty)
 * 2. current CONFIG_PATH
 * 3. legacy config locations (with a one-time migration warning)
 *
 * Concurrency: the function is synchronous and relies on the filesystem state at call time; callers should handle concurrent config writes externally.
 *
 * Windows: path existence checks use Node's filesystem semantics (case sensitivity and symlink behavior follow the host OS).
 *
 * Security: the returned path may reference files containing sensitive tokens; callers MUST redact or avoid logging full paths or file contents.
 *
 * @returns The resolved config file path as a string, or `null` if no config file was found.
 */
function resolvePluginConfigPath(): string | null {
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();
	if (envPath.length > 0) {
		return envPath;
	}

	if (existsSync(CONFIG_PATH)) {
		return CONFIG_PATH;
	}

	if (IS_CUSTOM_CODEX_HOME && existsSync(LEGACY_CODEX_HOME_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy config path ${LEGACY_CODEX_HOME_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_CODEX_HOME_CONFIG_PATH;
	}

	if (existsSync(LEGACY_CODEX_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy config path ${LEGACY_CODEX_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_CODEX_CONFIG_PATH;
	}

	if (IS_CUSTOM_CODEX_HOME && existsSync(LEGACY_CODEX_HOME_AUTH_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy config path ${LEGACY_CODEX_HOME_AUTH_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_CODEX_HOME_AUTH_CONFIG_PATH;
	}

	if (existsSync(LEGACY_CODEX_AUTH_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy config path ${LEGACY_CODEX_AUTH_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_CODEX_AUTH_CONFIG_PATH;
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
	retryAllAccountsAbsoluteCeilingMs: 0,
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
 * Return a shallow copy of the default plugin configuration.
 *
 * Safe to call concurrently; performs no I/O and has no filesystem or Windows atomicity implications.
 * The returned object may include placeholder fields for secrets or tokens — callers must redact sensitive values before logging or persisting.
 *
 * @returns A shallow copy of DEFAULT_PLUGIN_CONFIG
 */
export function getDefaultPluginConfig(): PluginConfig {
	return { ...DEFAULT_PLUGIN_CONFIG };
}

/**
 * Load the plugin configuration, merging validated user settings with defaults and applying legacy fallbacks.
 *
 * Attempts to read unified settings first; if absent, falls back to legacy per-user JSON files (UTF-8 BOM is stripped on Windows before parsing).
 * Emits one-time warnings for validation or migration issues and avoids exposing sensitive tokens in logged messages.
 * This function performs filesystem reads and may write a migrated unified config; callers should avoid concurrent writers to the same config paths.
 *
 * @returns The effective PluginConfig: a shallow merge of DEFAULT_PLUGIN_CONFIG with any validated user-provided settings
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
			logConfigWarnOnce(
				`Legacy config file is still in use; settings will migrate to ${getUnifiedSettingsPath()} on next save.`,
			);
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

/**
 * Remove a leading UTF‑8 byte order mark (BOM) from the given string if present.
 *
 * This is a pure, idempotent operation with no side effects. It is commonly used to normalize text read from files (including Windows-generated files) before JSON parsing or token redaction.
 *
 * @param content - The string to normalize
 * @returns The input string without a leading UTF‑8 BOM; returns the original string if no BOM is present
 */
function stripUtf8Bom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Determines whether a value is a non-null object that can be treated as a record.
 *
 * @param value - The value to test
 * @returns `true` if `value` is a non-null object and can be treated as `Record<string, unknown>`, `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonFileAtomicWithRetry(
	filePath: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await fs.mkdir(dirname(filePath), { recursive: true });
	await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	let renamed = false;
	try {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await fs.rename(tempPath, filePath);
				renamed = true;
				return;
			} catch (error) {
				if (!isRetryableFsError(error) || attempt >= 4) {
					throw error;
				}
				await sleep(10 * 2 ** attempt);
			}
		}
	} finally {
		if (!renamed) {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Best-effort temp cleanup.
			}
		}
	}
}

async function withConfigSaveLock(path: string, task: () => Promise<void>): Promise<void> {
	const previous = configSaveQueues.get(path) ?? Promise.resolve();
	const queued = previous.catch(() => {}).then(task);
	configSaveQueues.set(path, queued);
	try {
		await queued;
	} finally {
		if (configSaveQueues.get(path) === queued) {
			configSaveQueues.delete(path);
		}
	}
}

/**
 * Read and parse a JSON configuration file and return its top-level object when present and valid.
 *
 * This function tolerates transient read/parse failures caused by concurrent writers; callers should handle a `null` return as "unavailable". Log messages include the file path and error message — callers should avoid logging or displaying raw paths that may contain sensitive tokens without redaction. On Windows, path casing or exclusive file locks can make existing files temporarily unreadable.
 *
 * @param configPath - Filesystem path to the JSON config file. Concurrent writes may cause transient read/parse failures; callers should tolerate `null`. On Windows, path casing and exclusive locks can affect readability.
 * @returns The parsed top-level JSON object as a Record<string, unknown> when the file exists and contains an object, or `null` if the file is missing, malformed, or could not be read.
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
 * Prepare a partial PluginConfig for persistence by removing undefined values,
 * omitting non-finite numbers, and shallow-copying nested object records.
 *
 * @param config - Partial plugin configuration to sanitize before saving. Note: this function does not redact or mask secrets (tokens/credentials); callers must handle redaction before writing to disk.
 * @returns A plain Record<string, unknown> suitable for JSON serialization: keys with `undefined` or non-finite numeric values are omitted and nested objects are shallow-copied.
 *
 * Concurrency: synchronous and side-effect free; callers are responsible for coordinating concurrent writes to the filesystem.
 * Filesystem: no Windows-specific path normalization or filesystem I/O is performed by this function.
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
 * Persist a partial plugin configuration to disk, merging it with existing stored settings.
 *
 * This writes the sanitized patch either to the path specified by the CODEX_MULTI_AUTH_CONFIG_PATH
 * environment variable (if set) or into the unified settings store. The function does not take
 * internal locks; callers should avoid concurrent invocations that might overwrite each other.
 * On Windows and other platforms the write behavior follows the Node.js filesystem semantics and may
 * not be atomic across processes. Callers are responsible for redacting any sensitive values
 * (tokens, secrets) before calling if redaction is required; this function writes merged values as-is.
 *
 * @param configPatch - Partial PluginConfig containing changes to persist; undefined fields are ignored.
 * @returns void
 */
export async function savePluginConfig(configPatch: Partial<PluginConfig>): Promise<void> {
	const sanitizedPatch = sanitizePluginConfigForSave(configPatch);
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();

	if (envPath.length > 0) {
		await withConfigSaveLock(envPath, async () => {
			const merged = {
				...(readConfigRecordFromPath(envPath) ?? {}),
				...sanitizedPatch,
			};
			await writeJsonFileAtomicWithRetry(envPath, merged);
		});
		return;
	}

	const unifiedPath = getUnifiedSettingsPath();
	await withConfigSaveLock(unifiedPath, async () => {
		const unifiedConfig = loadUnifiedPluginConfigSync();
		const legacyPath = unifiedConfig ? null : resolvePluginConfigPath();
		const merged = {
			...(unifiedConfig ?? (legacyPath ? readConfigRecordFromPath(legacyPath) : null) ?? {}),
			...sanitizedPatch,
		};
		await saveUnifiedPluginConfig(merged);
	});
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

/**
 * Resolves a boolean configuration value, preferring an explicit environment variable.
 *
 * Checks the environment variable named by `envName` first (using the module's boolean parsing rules);
 * if present, that value is returned. Otherwise returns `configValue` when defined, or `defaultValue`.
 *
 * This function is synchronous, has no filesystem interactions, and does not log or expose token values.
 *
 * @param envName - Name of the environment variable to check (e.g., "CODEX_FEATURE_FLAG")
 * @param configValue - Value from the plugin configuration, used when the env var is not set
 * @param defaultValue - Fallback value used when neither env nor config provide a value
 * @returns `true` or `false` according to the resolution order: environment → config → default
 */
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
 * Resolve a numeric setting using an environment override, then a config value, then a default, and clamp the result to optional bounds.
 *
 * This function prefers a numeric value from the environment variable named by `envName`, falls back to `configValue`, then to `defaultValue`, and enforces inclusive `options.min`/`options.max` when provided. It is safe to call concurrently (reads only from `process.env`), performs no filesystem I/O (including on Windows), and does not emit or log secrets or tokens; callers should handle any redaction of sensitive values before logging.
 *
 * @param envName - Environment variable name to check for an override
 * @param configValue - Configuration-provided numeric value to use if the environment variable is absent
 * @param defaultValue - Fallback numeric value used when neither env nor config provide one
 * @param options - Optional inclusive `min` and `max` bounds to clamp the resolved value
 * @returns The resolved number, clamped to `options.min`/`options.max` when specified
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
 * Choose the effective string value from an environment variable, a config value, or a default while enforcing a whitelist.
 *
 * This reads the environment variable named by `envName` once and prefers it if its trimmed/lowercased value is in `allowedValues`; otherwise it falls back to `configValue` if allowed, then to `defaultValue`. Concurrency: concurrent mutations to `process.env` may change the outcome. Filesystem: performs no filesystem I/O and has no platform-specific behavior (including Windows). Secrets: the function does not redact or log values; callers are responsible for handling sensitive values.
 *
 * @param envName - Name of the environment variable to consult first
 * @param configValue - Configuration-provided value to use if the environment value is absent or not allowed
 * @param defaultValue - Fallback value used when neither environment nor config provide an allowed value
 * @param allowedValues - Set of permitted values; only values in this set will be accepted
 * @returns The resolved value, guaranteed to be one of the values in `allowedValues`
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

export function getRetryAllAccountsAbsoluteCeilingMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS",
		pluginConfig.retryAllAccountsAbsoluteCeilingMs,
		0,
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

/**
 * Resolve the HTTP fetch timeout to use for account/token requests.
 *
 * Concurrency: value is read-only and safe to use concurrently; callers must enforce timeout usage in their request code. On Windows, filesystem-derived overrides (via env or config file) are subject to typical path encoding and newline semantics. Configuration values may contain sensitive tokens elsewhere; this function only returns a numeric timeout and does not expose or log secrets.
 *
 * @param pluginConfig - Plugin configuration object to read the `fetchTimeoutMs` fallback from
 * @returns The resolved fetch timeout in milliseconds (at least 1000)
 */
export function getFetchTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_FETCH_TIMEOUT_MS",
		pluginConfig.fetchTimeoutMs,
		60_000,
		{ min: 1_000 },
	);
}

/**
 * Compute the effective stream stall timeout used to detect stalled streams.
 *
 * This value applies across concurrent operations and should be treated as a global per-process timeout; callers may use it from multiple async contexts without additional synchronization. The function performs no filesystem I/O and has no special Windows filesystem behavior. Returned values do not contain or reveal any tokens and no redaction is performed by this function.
 *
 * @param pluginConfig - Plugin configuration that may contain a `streamStallTimeoutMs` override
 * @returns The effective stream stall timeout in milliseconds; at least 1000 ms, defaults to 45000 ms
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
 * Determine whether live account synchronization is enabled.
 *
 * Respects the environment override `CODEX_AUTH_LIVE_ACCOUNT_SYNC`, falls back to
 * `pluginConfig.liveAccountSync` when present, and defaults to `true`. This accessor performs no
 * filesystem operations (behaves the same on Windows paths) and does not mutate or log token or
 * credential material; callers are responsible for concurrency and must redact tokens before
 * logging or persisting them.
 *
 * @param pluginConfig - The plugin configuration object used as the non-environment fallback
 * @returns `true` if live account synchronization is enabled, `false` otherwise
 */
export function getLiveAccountSync(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC",
		pluginConfig.liveAccountSync,
		true,
	);
}

/**
 * Get the debounce interval, in milliseconds, used when synchronizing live accounts.
 *
 * @param pluginConfig - Plugin configuration which may contain an override for the debounce value
 * @returns The debounce interval in milliseconds; defaults to 250, and will be at least 50
 *
 * Concurrency: safe to call from multiple threads/tasks concurrently.
 * Windows filesystem: value is independent of filesystem semantics.
 * Token redaction: this value contains no secrets and is safe to log.
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
 * Determines the polling interval (in milliseconds) used by live account synchronization.
 *
 * @param pluginConfig - The plugin configuration to read the setting from.
 * @returns The effective poll interval in milliseconds; guaranteed to be at least 500.
 *
 * Notes:
 * - Concurrency: this value is used to debounce/drive polling and should be treated as a minimum per-worker interval when multiple workers run concurrently.
 * - Platform: value is independent of Windows filesystem semantics.
 * - Secrets: the returned value contains no sensitive tokens and is safe for logging (no redaction required).
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
 * Indicates whether session affinity is enabled.
 *
 * Reads the `sessionAffinity` value from `pluginConfig` and allows an environment
 * override via `CODEX_AUTH_SESSION_AFFINITY`. Safe for concurrent reads, unaffected
 * by Windows filesystem semantics, and does not expose or log authentication tokens.
 *
 * @param pluginConfig - The plugin configuration to consult for the setting
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
 * Get the session-affinity time-to-live in milliseconds.
 *
 * Reads CODEX_AUTH_SESSION_AFFINITY_TTL_MS from the environment if present, otherwise uses
 * `pluginConfig.sessionAffinityTtlMs`, falling back to 20 minutes. The returned value is
 * clamped to a minimum of 1000 ms.
 *
 * This function performs no filesystem I/O, is safe for concurrent callers, and does not
 * read or emit any token or secret material (suitable for logging without redaction).
 * Because it does no file operations, there are no Windows filesystem semantics to consider.
 *
 * @param pluginConfig - The plugin configuration to read the setting from
 * @returns The effective session-affinity TTL in milliseconds (minimum 1000)
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
 * Determine the configured maximum number of session-affinity entries.
 *
 * @param pluginConfig - The plugin configuration to read the `sessionAffinityMaxEntries` setting from.
 * @returns The effective maximum number of affinity entries (minimum 8, default 512).
 *
 * Concurrency: value is used for in-memory sizing and should be safe for concurrent use by runtime components.
 * Filesystem: value is runtime-only and unaffected by Windows filesystem semantics.
 * Security: this setting contains no secrets and is safe to log; it does not include tokens or credentials.
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
 * Controls whether the proactive refresh guardian is enabled.
 *
 * When enabled, background refreshes may run concurrently; callers should assume safe concurrent access.
 * Configuration respects cross-platform semantics (including Windows filesystem behavior) when persisting or migrating settings.
 * Any tokens or sensitive values observed during refresh operations are redacted from logs and persisted records.
 *
 * @param pluginConfig - The plugin configuration object to read the setting from
 * @returns `true` if the proactive refresh guardian is enabled, `false` otherwise.
 */
export function getProactiveRefreshGuardian(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN",
		pluginConfig.proactiveRefreshGuardian,
		true,
	);
}

/**
 * Determines the proactive refresh guardian interval in milliseconds.
 *
 * Uses the environment override `CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS` if present; otherwise uses
 * the configured `pluginConfig.proactiveRefreshIntervalMs` or the default of 60000 ms. The resulting
 * value is constrained to be at least 5000 ms.
 *
 * Concurrency assumption: callers may be invoked from multiple timers/workers concurrently.
 * Windows filesystem and token-redaction concerns do not affect this getter.
 *
 * @param pluginConfig - Plugin configuration used as the fallback source for the interval value
 * @returns The proactive refresh interval in milliseconds (>= 5000)
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
 * Get the proactive refresh guardian buffer interval in milliseconds.
 *
 * @param pluginConfig - Plugin configuration object; `proactiveRefreshBufferMs` may override the default
 * @returns The buffer interval in milliseconds: at least 30000, default 300000
 *
 * Concurrency: this value is shared across concurrent proactive-refresh workers and should be treated as a global timing setting.
 * Windows filesystem: not related to filesystem behavior.
 * Token redaction: environment values and config contents may be redacted in logs and diagnostics.
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
 * Get the network error cooldown interval used before retrying network operations.
 *
 * @param pluginConfig - Plugin configuration to read override values from
 * @returns The cooldown interval in milliseconds (greater than or equal to 0)
 *
 * Concurrency: callers may read and cache this value; it is read-only at call time.
 * Windows filesystem: no platform-specific filesystem behavior affects this setting.
 * Token redaction: this function does not expose or log sensitive tokens.
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
 * Get the cooldown duration in milliseconds to apply after a server error.
 *
 * Callers may invoke this concurrently; the returned value is read-only and safe for concurrent use.
 * This function performs no filesystem access and is unaffected by Windows path semantics.
 * It does not log or expose secrets — environment-derived values are treated as configuration, not token data.
 *
 * @param pluginConfig - Plugin configuration used to resolve the setting
 * @returns The cooldown in milliseconds to use after a server error (minimum 0, default 4000)
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
 * Determines whether periodic storage backups are enabled.
 *
 * When enabled, background backup tasks may run concurrently; backups follow platform filesystem semantics (including Windows path behavior), and persisted backup data will have sensitive tokens redacted.
 *
 * @param pluginConfig - The plugin configuration to read the setting from
 * @returns `true` if storage backup is enabled, `false` otherwise
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
 * Safe to call concurrently; this function does not access the filesystem (no Windows-specific behavior)
 * and does not expose or log any authentication tokens.
 *
 * @param pluginConfig - Plugin configuration to read the preemptive quota setting from
 * @returns `true` if preemptive quota is enabled, `false` otherwise
 */
export function getPreemptiveQuotaEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED",
		pluginConfig.preemptiveQuotaEnabled,
		true,
	);
}

/**
 * Get the configured preemptive-quota remaining percentage for 5-hour windows.
 *
 * @param pluginConfig - Plugin configuration to read the setting from. The value may be overridden by the CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT environment variable; environment override semantics are the same on Windows. Safe to call concurrently. The returned value does not contain sensitive tokens and requires no redaction.
 * @returns The percentage (0–100) used as the preemptive quota threshold for 5-hour intervals.
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
 * Determine the percentage of quota to reserve for the 7-day window.
 *
 * Resolves the effective value from the environment variable `CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT`,
 * then from `pluginConfig.preemptiveQuotaRemainingPercent7d`, falling back to `5` if unset, and clamps the result
 * to the inclusive range `0`–`100`.
 *
 * Concurrent reads are safe. Behavior is independent of Windows filesystem semantics. No sensitive tokens are included
 * or returned by this function.
 *
 * @param pluginConfig - Plugin configuration object used as a fallback when the environment variable is not set
 * @returns The reserved quota percentage for the 7-day window, an integer between `0` and `100`
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
 * Get the configured maximum deferral time (in milliseconds) for preemptive quota checks.
 *
 * Reads an environment override or the plugin configuration and enforces a minimum of 1000 ms.
 *
 * @param pluginConfig - Plugin configuration object to read the setting from
 * @returns The maximum deferral interval in milliseconds
 *
 * Concurrency: concurrent config writers may not be observed immediately by readers.
 * Filesystem note: config persistence/visibility may differ on Windows vs POSIX filesystems.
 * Security: the returned value contains no sensitive tokens and is safe to log.
 */
export function getPreemptiveQuotaMaxDeferralMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS",
		pluginConfig.preemptiveQuotaMaxDeferralMs,
		2 * 60 * 60_000,
		{ min: 1_000 },
	);
}
