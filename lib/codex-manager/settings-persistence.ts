import {
	loadDashboardDisplaySettings,
	saveDashboardDisplaySettings,
	getDashboardSettingsPath,
	type DashboardDisplaySettings,
} from "../dashboard-settings.js";
import { loadPluginConfig, savePluginConfig } from "../config.js";
import { getUnifiedSettingsPath } from "../unified-settings.js";
import type { PluginConfig } from "../types.js";
import { sleep } from "../utils.js";

const RETRYABLE_SETTINGS_WRITE_CODES = new Set(["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]);
const SETTINGS_WRITE_MAX_ATTEMPTS = 4;
const SETTINGS_WRITE_BASE_DELAY_MS = 20;
const SETTINGS_WRITE_MAX_DELAY_MS = 30_000;
const settingsWriteQueues = new Map<string, Promise<void>>();

export function resetSettingsWriteQueuesForTesting(): void {
	if (process.env.NODE_ENV !== "test") {
		return;
	}
	settingsWriteQueues.clear();
}

function readErrorNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function getErrorStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const record = error as Record<string, unknown>;
	return readErrorNumber(record.status) ?? readErrorNumber(record.statusCode);
}

function getRetryAfterMs(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const record = error as Record<string, unknown>;
	return (
		readErrorNumber(record.retryAfterMs) ??
		readErrorNumber(record.retry_after_ms) ??
		readErrorNumber(record.retryAfter) ??
		readErrorNumber(record.retry_after)
	);
}

function isRetryableSettingsWriteError(error: unknown): boolean {
	const statusCode = getErrorStatusCode(error);
	if (statusCode === 429) return true;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_SETTINGS_WRITE_CODES.has(code);
}

function resolveRetryDelayMs(error: unknown, attempt: number): number {
	const retryAfterMs = getRetryAfterMs(error);
	if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
		return Math.max(10, Math.min(SETTINGS_WRITE_MAX_DELAY_MS, Math.round(retryAfterMs)));
	}
	return Math.min(SETTINGS_WRITE_MAX_DELAY_MS, SETTINGS_WRITE_BASE_DELAY_MS * 2 ** attempt);
}

async function enqueueSettingsWrite<T>(pathKey: string, task: () => Promise<T>): Promise<T> {
	const previous = settingsWriteQueues.get(pathKey) ?? Promise.resolve();
	const queued = previous.catch(() => {}).then(task);
	const queueTail = queued.then(
		() => undefined,
		() => undefined,
	);
	settingsWriteQueues.set(pathKey, queueTail);
	try {
		return await queued;
	} finally {
		if (settingsWriteQueues.get(pathKey) === queueTail) {
			settingsWriteQueues.delete(pathKey);
		}
	}
}

function resolvePluginConfigSavePathKey(): string {
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();
	return envPath.length > 0 ? envPath : getUnifiedSettingsPath();
}

function formatPersistError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function warnPersistFailure(scope: string, error: unknown): void {
	console.warn(`Settings save failed (${scope}) after retries: ${formatPersistError(error)}`);
}

export async function withQueuedRetry<T>(pathKey: string, task: () => Promise<T>): Promise<T> {
	return enqueueSettingsWrite(pathKey, async () => {
		let lastError: unknown;
		for (let attempt = 0; attempt < SETTINGS_WRITE_MAX_ATTEMPTS; attempt += 1) {
			try {
				return await task();
			} catch (error) {
				lastError = error;
				if (!isRetryableSettingsWriteError(error) || attempt + 1 >= SETTINGS_WRITE_MAX_ATTEMPTS) {
					throw error;
				}
				await sleep(resolveRetryDelayMs(error, attempt));
			}
		}
		throw lastError instanceof Error ? lastError : new Error("settings save retry exhausted");
	});
}

export async function persistDashboardSettingsSelection(
	selected: DashboardDisplaySettings,
	keys: readonly (keyof DashboardDisplaySettings)[],
	scope: string,
	helpers: {
		cloneSettings: (settings: DashboardDisplaySettings) => DashboardDisplaySettings;
		mergeSettingsForKeys: (
			base: DashboardDisplaySettings,
			selected: DashboardDisplaySettings,
			keys: readonly (keyof DashboardDisplaySettings)[],
		) => DashboardDisplaySettings;
	},
): Promise<DashboardDisplaySettings> {
	const fallback = helpers.cloneSettings(selected);
	try {
		return await withQueuedRetry(getDashboardSettingsPath(), async () => {
			const latest = helpers.cloneSettings(await loadDashboardDisplaySettings());
			const merged = helpers.mergeSettingsForKeys(latest, selected, keys);
			await saveDashboardDisplaySettings(merged);
			return merged;
		});
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}

export async function persistBackendConfigSelection(
	selected: PluginConfig,
	scope: string,
	helpers: {
		cloneConfig: (config: PluginConfig) => PluginConfig;
		buildPatch: (config: PluginConfig) => Partial<PluginConfig>;
	},
): Promise<PluginConfig> {
	const fallback = helpers.cloneConfig(selected);
	try {
		await withQueuedRetry(resolvePluginConfigSavePathKey(), async () => {
			await savePluginConfig(helpers.buildPatch(selected));
		});
		return helpers.cloneConfig(loadPluginConfig());
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}
