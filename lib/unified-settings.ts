import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	promises as fs,
} from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "./runtime-paths.js";

type JsonRecord = Record<string, unknown>;

export const UNIFIED_SETTINGS_VERSION = 1 as const;

const UNIFIED_SETTINGS_PATH = join(getCodexMultiAuthDir(), "settings.json");

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object";
}

function cloneRecord(value: unknown): JsonRecord | null {
	if (!isRecord(value)) return null;
	return { ...value };
}

function readSettingsRecordSync(): JsonRecord | null {
	if (!existsSync(UNIFIED_SETTINGS_PATH)) {
		return null;
	}

	try {
		const raw = readFileSync(UNIFIED_SETTINGS_PATH, "utf8");
		return cloneRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}

async function readSettingsRecordAsync(): Promise<JsonRecord | null> {
	if (!existsSync(UNIFIED_SETTINGS_PATH)) {
		return null;
	}

	try {
		const raw = await fs.readFile(UNIFIED_SETTINGS_PATH, "utf8");
		return cloneRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}

function normalizeForWrite(record: JsonRecord): JsonRecord {
	return {
		...record,
		version: UNIFIED_SETTINGS_VERSION,
	};
}

function writeSettingsRecordSync(record: JsonRecord): void {
	mkdirSync(getCodexMultiAuthDir(), { recursive: true });
	const payload = normalizeForWrite(record);
	writeFileSync(UNIFIED_SETTINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeSettingsRecordAsync(record: JsonRecord): Promise<void> {
	await fs.mkdir(getCodexMultiAuthDir(), { recursive: true });
	const payload = normalizeForWrite(record);
	await fs.writeFile(UNIFIED_SETTINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function getUnifiedSettingsPath(): string {
	return UNIFIED_SETTINGS_PATH;
}

export function loadUnifiedPluginConfigSync(): JsonRecord | null {
	const record = readSettingsRecordSync();
	if (!record) return null;
	return cloneRecord(record.pluginConfig);
}

export function saveUnifiedPluginConfigSync(pluginConfig: JsonRecord): void {
	const record = readSettingsRecordSync() ?? {};
	record.pluginConfig = { ...pluginConfig };
	writeSettingsRecordSync(record);
}

export async function saveUnifiedPluginConfig(pluginConfig: JsonRecord): Promise<void> {
	const record = await readSettingsRecordAsync() ?? {};
	record.pluginConfig = { ...pluginConfig };
	await writeSettingsRecordAsync(record);
}

export async function loadUnifiedDashboardSettings(): Promise<JsonRecord | null> {
	const record = await readSettingsRecordAsync();
	if (!record) return null;
	return cloneRecord(record.dashboardDisplaySettings);
}

export async function saveUnifiedDashboardSettings(
	dashboardDisplaySettings: JsonRecord,
): Promise<void> {
	const record = await readSettingsRecordAsync() ?? {};
	record.dashboardDisplaySettings = { ...dashboardDisplaySettings };
	await writeSettingsRecordAsync(record);
}
