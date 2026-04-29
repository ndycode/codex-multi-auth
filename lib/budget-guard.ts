import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import type { UsageSummary } from "./usage/index.js";
import { isRecord, sleep } from "./utils.js";

export type BudgetWindow = "hour" | "day" | "week" | "month";

export interface BudgetLimit {
	key: string;
	window: BudgetWindow;
	maxRequests?: number;
	maxTokens?: number;
	maxCostUsd?: number;
	updatedAt: number;
}

export interface BudgetGuardStore {
	version: 1;
	limits: Record<string, BudgetLimit>;
}

export interface BudgetGuardEvaluation {
	key: string;
	window: BudgetWindow;
	allowed: boolean;
	reasons: string[];
	usage: {
		requests: number;
		totalTokens: number;
		costUsd: number;
	};
	limits: {
		maxRequests: number | null;
		maxTokens: number | null;
		maxCostUsd: number | null;
	};
}

const BUDGET_GUARD_FILE_NAME = "budget-guards.json";
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);
const VALID_WINDOWS = new Set<BudgetWindow>(["hour", "day", "week", "month"]);
let writeQueue: Promise<void> = Promise.resolve();

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function normalizeKey(value: string): string | null {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
	return normalized.length > 0 ? normalized.slice(0, 100) : null;
}

function normalizePositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function normalizeLimit(key: string, value: unknown): BudgetLimit | null {
	if (!isRecord(value)) return null;
	const window =
		typeof value.window === "string" && VALID_WINDOWS.has(value.window as BudgetWindow)
			? (value.window as BudgetWindow)
			: null;
	if (!window) return null;
	return {
		key,
		window,
		maxRequests: normalizePositiveNumber(value.maxRequests),
		maxTokens: normalizePositiveNumber(value.maxTokens),
		maxCostUsd: normalizePositiveNumber(value.maxCostUsd),
		updatedAt:
			typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
				? value.updatedAt
				: 0,
	};
}

function emptyStore(): BudgetGuardStore {
	return { version: 1, limits: {} };
}

function normalizeStore(value: unknown): BudgetGuardStore {
	if (!isRecord(value) || value.version !== 1) return emptyStore();
	const limits: Record<string, BudgetLimit> = {};
	if (isRecord(value.limits)) {
		for (const [rawKey, raw] of Object.entries(value.limits)) {
			const key = normalizeKey(rawKey);
			if (!key) continue;
			const limit = normalizeLimit(key, raw);
			if (limit) limits[key] = limit;
		}
	}
	return { version: 1, limits };
}

async function readFileWithRetry(path: string): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await fs.readFile(path, "utf8");
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= 4) throw error;
			await sleep(10 * 2 ** attempt);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("budget guard read retry exhausted");
}

export function getBudgetGuardPath(): string {
	return join(getCodexMultiAuthDir(), BUDGET_GUARD_FILE_NAME);
}

export function normalizeBudgetKey(value: string): string | null {
	return normalizeKey(value);
}

export async function loadBudgetGuardStore(): Promise<BudgetGuardStore> {
	const path = getBudgetGuardPath();
	if (!existsSync(path)) return emptyStore();
	try {
		return normalizeStore(JSON.parse(await readFileWithRetry(path)) as unknown);
	} catch (error) {
		logWarn(
			`Failed to load budget guards from ${basename(path)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return emptyStore();
	}
}

export async function saveBudgetGuardStore(store: BudgetGuardStore): Promise<void> {
	const path = getBudgetGuardPath();
	const payload = normalizeStore(store);
	const task = async (): Promise<void> => {
		await fs.mkdir(getCodexMultiAuthDir(), { recursive: true, mode: 0o700 });
		const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		let moved = false;
		try {
			await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					await fs.rename(tempPath, path);
					moved = true;
					return;
				} catch (error) {
					if (!isRetryableFsError(error) || attempt >= 4) throw error;
					await sleep(10 * 2 ** attempt);
				}
			}
		} finally {
			if (!moved) {
				try {
					await fs.unlink(tempPath);
				} catch {
					// Best-effort temp cleanup.
				}
			}
		}
	};
	const queued = writeQueue.catch(() => undefined).then(task);
	writeQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	await queued;
}

export function upsertBudgetLimit(
	store: BudgetGuardStore,
	limit: Omit<BudgetLimit, "updatedAt">,
	now = Date.now(),
): BudgetLimit {
	const key = normalizeKey(limit.key);
	if (!key) throw new Error("Budget key is required");
	const next = normalizeLimit(key, { ...limit, key, updatedAt: now });
	if (!next) throw new Error("Invalid budget limit");
	store.limits[key] = next;
	return next;
}

export function getBudgetWindowStart(window: BudgetWindow, now = Date.now()): number {
	const date = new Date(now);
	if (window === "hour") {
		date.setUTCMinutes(0, 0, 0);
		return date.getTime();
	}
	if (window === "day") {
		date.setUTCHours(0, 0, 0, 0);
		return date.getTime();
	}
	if (window === "week") {
		date.setUTCHours(0, 0, 0, 0);
		const day = date.getUTCDay();
		const mondayOffset = day === 0 ? 6 : day - 1;
		date.setUTCDate(date.getUTCDate() - mondayOffset);
		return date.getTime();
	}
	date.setUTCDate(1);
	date.setUTCHours(0, 0, 0, 0);
	return date.getTime();
}

export function evaluateBudgetGuard(
	limit: BudgetLimit,
	summary: UsageSummary,
): BudgetGuardEvaluation {
	const reasons: string[] = [];
	if (
		typeof limit.maxRequests === "number" &&
		summary.totals.requests >= limit.maxRequests
	) {
		reasons.push(`request limit reached (${summary.totals.requests}/${limit.maxRequests})`);
	}
	if (
		typeof limit.maxTokens === "number" &&
		summary.totals.totalTokens >= limit.maxTokens
	) {
		reasons.push(`token limit reached (${summary.totals.totalTokens}/${limit.maxTokens})`);
	}
	if (
		typeof limit.maxCostUsd === "number" &&
		summary.totals.costUsd >= limit.maxCostUsd
	) {
		reasons.push(
			`cost limit reached (${summary.totals.costUsd.toFixed(6)}/${limit.maxCostUsd.toFixed(6)})`,
		);
	}
	return {
		key: limit.key,
		window: limit.window,
		allowed: reasons.length === 0,
		reasons,
		usage: {
			requests: summary.totals.requests,
			totalTokens: summary.totals.totalTokens,
			costUsd: summary.totals.costUsd,
		},
		limits: {
			maxRequests: limit.maxRequests ?? null,
			maxTokens: limit.maxTokens ?? null,
			maxCostUsd: limit.maxCostUsd ?? null,
		},
	};
}

export function resetBudgetGuardWriteQueueForTests(): void {
	writeQueue = Promise.resolve();
}

