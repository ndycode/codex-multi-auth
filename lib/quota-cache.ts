import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";

export interface QuotaCacheWindow {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
}

export interface QuotaCacheEntry {
	updatedAt: number;
	status: number;
	model: string;
	planType?: string;
	primary: QuotaCacheWindow;
	secondary: QuotaCacheWindow;
}

export interface QuotaCacheData {
	byAccountId: Record<string, QuotaCacheEntry>;
	byEmail: Record<string, QuotaCacheEntry>;
}

interface QuotaCacheFile {
	version: 1;
	byAccountId: Record<string, QuotaCacheEntry>;
	byEmail: Record<string, QuotaCacheEntry>;
}

const QUOTA_CACHE_PATH = join(getCodexMultiAuthDir(), "quota-cache.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function normalizeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeWindow(value: unknown): QuotaCacheWindow {
	if (!isRecord(value)) return {};
	return {
		usedPercent: normalizeNumber(value.usedPercent),
		windowMinutes: normalizeNumber(value.windowMinutes),
		resetAtMs: normalizeNumber(value.resetAtMs),
	};
}

function normalizeEntry(value: unknown): QuotaCacheEntry | null {
	if (!isRecord(value)) return null;
	const updatedAt = normalizeNumber(value.updatedAt);
	const status = normalizeNumber(value.status);
	const model = typeof value.model === "string" ? value.model : "";
	if (
		typeof updatedAt !== "number" ||
		typeof status !== "number" ||
		model.trim().length === 0
	) {
		return null;
	}

	return {
		updatedAt,
		status,
		model: model.trim(),
		planType: typeof value.planType === "string" ? value.planType : undefined,
		primary: normalizeWindow(value.primary),
		secondary: normalizeWindow(value.secondary),
	};
}

function normalizeEntryMap(value: unknown): Record<string, QuotaCacheEntry> {
	if (!isRecord(value)) return {};
	const entries: Record<string, QuotaCacheEntry> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof key !== "string" || key.trim().length === 0) continue;
		const normalized = normalizeEntry(raw);
		if (!normalized) continue;
		entries[key] = normalized;
	}
	return entries;
}

export function getQuotaCachePath(): string {
	return QUOTA_CACHE_PATH;
}

export async function loadQuotaCache(): Promise<QuotaCacheData> {
	if (!existsSync(QUOTA_CACHE_PATH)) {
		return { byAccountId: {}, byEmail: {} };
	}

	try {
		const content = await fs.readFile(QUOTA_CACHE_PATH, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (!isRecord(parsed)) {
			return { byAccountId: {}, byEmail: {} };
		}

		return {
			byAccountId: normalizeEntryMap(parsed.byAccountId),
			byEmail: normalizeEntryMap(parsed.byEmail),
		};
	} catch (error) {
		logWarn(
			`Failed to load quota cache from ${QUOTA_CACHE_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { byAccountId: {}, byEmail: {} };
	}
}

export async function saveQuotaCache(data: QuotaCacheData): Promise<void> {
	const payload: QuotaCacheFile = {
		version: 1,
		byAccountId: data.byAccountId,
		byEmail: data.byEmail,
	};

	try {
		await fs.mkdir(getCodexMultiAuthDir(), { recursive: true });
		await fs.writeFile(QUOTA_CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} catch (error) {
		logWarn(
			`Failed to save quota cache to ${QUOTA_CACHE_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
