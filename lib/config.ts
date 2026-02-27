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

export function getDefaultPluginConfig(): PluginConfig {
	return { ...DEFAULT_PLUGIN_CONFIG };
}

/**
 * Load plugin configuration from ~/.codex/multi-auth/config.json
 * with compatibility fallbacks for previous Codex/OpenCode locations.
 * Falls back to defaults if file doesn't exist or is invalid
 *
 * @returns Plugin configuration
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

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

export function getStreamStallTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
		pluginConfig.streamStallTimeoutMs,
		45_000,
		{ min: 1_000 },
	);
}

export function getLiveAccountSync(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC",
		pluginConfig.liveAccountSync,
		true,
	);
}

export function getLiveAccountSyncDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS",
		pluginConfig.liveAccountSyncDebounceMs,
		250,
		{ min: 50 },
	);
}

export function getLiveAccountSyncPollMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS",
		pluginConfig.liveAccountSyncPollMs,
		2_000,
		{ min: 500 },
	);
}

export function getSessionAffinity(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SESSION_AFFINITY",
		pluginConfig.sessionAffinity,
		true,
	);
}

export function getSessionAffinityTtlMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SESSION_AFFINITY_TTL_MS",
		pluginConfig.sessionAffinityTtlMs,
		20 * 60_000,
		{ min: 1_000 },
	);
}

export function getSessionAffinityMaxEntries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES",
		pluginConfig.sessionAffinityMaxEntries,
		512,
		{ min: 8 },
	);
}

export function getProactiveRefreshGuardian(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN",
		pluginConfig.proactiveRefreshGuardian,
		true,
	);
}

export function getProactiveRefreshIntervalMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS",
		pluginConfig.proactiveRefreshIntervalMs,
		60_000,
		{ min: 5_000 },
	);
}

export function getProactiveRefreshBufferMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS",
		pluginConfig.proactiveRefreshBufferMs,
		5 * 60_000,
		{ min: 30_000 },
	);
}

export function getNetworkErrorCooldownMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS",
		pluginConfig.networkErrorCooldownMs,
		6_000,
		{ min: 0 },
	);
}

export function getServerErrorCooldownMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS",
		pluginConfig.serverErrorCooldownMs,
		4_000,
		{ min: 0 },
	);
}

export function getStorageBackupEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_STORAGE_BACKUP_ENABLED",
		pluginConfig.storageBackupEnabled,
		true,
	);
}

export function getPreemptiveQuotaEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED",
		pluginConfig.preemptiveQuotaEnabled,
		true,
	);
}

export function getPreemptiveQuotaRemainingPercent5h(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT",
		pluginConfig.preemptiveQuotaRemainingPercent5h,
		5,
		{ min: 0, max: 100 },
	);
}

export function getPreemptiveQuotaRemainingPercent7d(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT",
		pluginConfig.preemptiveQuotaRemainingPercent7d,
		5,
		{ min: 0, max: 100 },
	);
}

export function getPreemptiveQuotaMaxDeferralMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS",
		pluginConfig.preemptiveQuotaMaxDeferralMs,
		2 * 60 * 60_000,
		{ min: 1_000 },
	);
}
