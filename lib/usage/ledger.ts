import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { logWarn } from "../logger.js";
import { isRecord, sleep } from "../utils.js";
import {
	normalizeUsageLedgerRow,
	usageRowToJsonLine,
} from "./redaction.js";
import type {
	UsageLedgerAppendInput,
	UsageLedgerOperation,
	UsageLedgerPaths,
	UsageLedgerQuery,
	UsageLedgerOutcome,
	UsageLedgerRow,
	UsageLedgerSource,
	UsageSummary,
	UsageSummaryBucket,
	UsageSummaryGroupBy,
	UsageSummaryQuery,
	UsageTokenCounts,
} from "./types.js";

const USAGE_DIR_NAME = "usage";
const USAGE_LEDGER_FILE_NAME = "usage-ledger.jsonl";
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);
let appendQueue: Promise<void> = Promise.resolve();

const VALID_SOURCES = new Set<UsageLedgerSource>([
	"runtime-proxy",
	"plugin-host",
	"local-bridge",
	"cli",
	"unknown",
]);
const VALID_OPERATIONS = new Set<UsageLedgerOperation>([
	"responses",
	"models",
	"auth-refresh",
	"diagnostic",
	"unknown",
]);
const VALID_OUTCOMES = new Set<UsageLedgerOutcome>([
	"success",
	"failure",
	"blocked",
	"cancelled",
]);

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function normalizeTimestamp(value: number | Date | string | undefined): number | null {
	if (value === undefined) return null;
	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isFinite(time) ? time : null;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

async function appendFileWithRetry(path: string, line: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.appendFile(path, line, { encoding: "utf8", mode: 0o600 });
			return;
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= 4) {
				throw error;
			}
			await sleep(10 * 2 ** attempt);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("usage ledger append retry exhausted");
}

async function readFileWithRetry(path: string): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await fs.readFile(path, "utf8");
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= 4) {
				throw error;
			}
			await sleep(10 * 2 ** attempt);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("usage ledger read retry exhausted");
}

async function renameWithRetry(from: string, to: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= 4) {
				throw error;
			}
			await sleep(10 * 2 ** attempt);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("usage ledger rotate retry exhausted");
}

export function getUsageLedgerPaths(): UsageLedgerPaths {
	const dir = join(getCodexMultiAuthDir(), USAGE_DIR_NAME);
	return {
		dir,
		current: join(dir, USAGE_LEDGER_FILE_NAME),
	};
}

export async function appendUsageLedgerRow(
	input: UsageLedgerAppendInput,
): Promise<UsageLedgerRow> {
	const row = normalizeUsageLedgerRow(input);
	const { dir, current } = getUsageLedgerPaths();
	const line = usageRowToJsonLine(row);
	const task = async (): Promise<void> => {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await appendFileWithRetry(current, line);
	};
	const queued = appendQueue.catch(() => undefined).then(task);
	appendQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	await queued;
	return row;
}

function normalizeParsedUsageRow(value: unknown): UsageLedgerRow | null {
	if (!isRecord(value)) return null;
	if (value.version !== 1) return null;
	if (typeof value.id !== "string" || value.id.trim().length === 0) return null;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
		return null;
	}
	if (!isRecord(value.tokens)) return null;

	const source =
		typeof value.source === "string" &&
		VALID_SOURCES.has(value.source as UsageLedgerSource)
			? (value.source as UsageLedgerSource)
			: "unknown";
	const operation =
		typeof value.operation === "string" &&
		VALID_OPERATIONS.has(value.operation as UsageLedgerOperation)
			? (value.operation as UsageLedgerOperation)
			: "unknown";
	const outcome =
		typeof value.outcome === "string" &&
		VALID_OUTCOMES.has(value.outcome as UsageLedgerOutcome)
			? (value.outcome as UsageLedgerOutcome)
			: "failure";
	const tokens: UsageTokenCounts = {
		inputTokens:
			typeof value.tokens.inputTokens === "number" &&
			Number.isFinite(value.tokens.inputTokens)
				? Math.max(0, Math.trunc(value.tokens.inputTokens))
				: 0,
		outputTokens:
			typeof value.tokens.outputTokens === "number" &&
			Number.isFinite(value.tokens.outputTokens)
				? Math.max(0, Math.trunc(value.tokens.outputTokens))
				: 0,
		cachedInputTokens:
			typeof value.tokens.cachedInputTokens === "number" &&
			Number.isFinite(value.tokens.cachedInputTokens)
				? Math.max(0, Math.trunc(value.tokens.cachedInputTokens))
				: 0,
		reasoningTokens:
			typeof value.tokens.reasoningTokens === "number" &&
			Number.isFinite(value.tokens.reasoningTokens)
				? Math.max(0, Math.trunc(value.tokens.reasoningTokens))
				: 0,
		totalTokens:
			typeof value.tokens.totalTokens === "number" &&
			Number.isFinite(value.tokens.totalTokens)
				? Math.max(0, Math.trunc(value.tokens.totalTokens))
				: 0,
	};
	const account = isRecord(value.account)
		? {
				accountHash:
					typeof value.account.accountHash === "string" &&
					value.account.accountHash.startsWith("sha256:")
						? value.account.accountHash
						: undefined,
				emailHash:
					typeof value.account.emailHash === "string" &&
					value.account.emailHash.startsWith("sha256:")
						? value.account.emailHash
						: undefined,
				index:
					typeof value.account.index === "number" &&
					Number.isInteger(value.account.index) &&
					value.account.index >= 0
						? value.account.index
						: undefined,
			}
		: null;
	const normalizedAccount =
		account?.accountHash || account?.emailHash || account?.index !== undefined
			? account
			: null;

	return {
		version: 1,
		id: value.id,
		createdAt: value.createdAt,
		source,
		operation,
		outcome,
		model: typeof value.model === "string" ? value.model : null,
		projectKey: typeof value.projectKey === "string" ? value.projectKey : null,
		account: normalizedAccount,
		requestId: typeof value.requestId === "string" ? value.requestId : null,
		statusCode:
			typeof value.statusCode === "number" &&
			Number.isInteger(value.statusCode) &&
			value.statusCode >= 100 &&
			value.statusCode <= 599
				? value.statusCode
				: null,
		errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
		durationMs:
			typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
				? Math.max(0, Math.trunc(value.durationMs))
				: null,
		tokens,
		costUsd:
			typeof value.costUsd === "number" && Number.isFinite(value.costUsd)
				? Math.max(0, value.costUsd)
				: null,
	};
}

function parseJsonlRows(content: string, label: string): UsageLedgerRow[] {
	const rows: UsageLedgerRow[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			const row = normalizeParsedUsageRow(parsed);
			if (row) {
				rows.push(row);
			}
		} catch (error) {
			logWarn(
				`Skipped malformed usage ledger row in ${label}:${index + 1}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return rows;
}

async function listLedgerFiles(includeArchives: boolean): Promise<string[]> {
	const { dir, current } = getUsageLedgerPaths();
	if (!includeArchives) {
		return existsSync(current) ? [current] : [];
	}
	if (!existsSync(dir)) {
		return [];
	}
	const entries = await fs.readdir(dir);
	return entries
		.filter((entry) => /^usage-ledger(?:\.\d{8}T\d{6}\d{3}Z)?\.jsonl$/.test(entry))
		.sort()
		.map((entry) => join(dir, entry));
}

function filterRows(
	rows: UsageLedgerRow[],
	query: UsageLedgerQuery,
): UsageLedgerRow[] {
	const since = normalizeTimestamp(query.since);
	const until = normalizeTimestamp(query.until);
	return rows.filter((row) => {
		if (since !== null && row.createdAt < since) return false;
		if (until !== null && row.createdAt > until) return false;
		return true;
	});
}

export async function readUsageLedgerRows(
	query: UsageLedgerQuery = {},
): Promise<UsageLedgerRow[]> {
	const rows: UsageLedgerRow[] = [];
	for (const file of await listLedgerFiles(query.includeArchives === true)) {
		try {
			rows.push(...parseJsonlRows(await readFileWithRetry(file), basename(file)));
		} catch (error) {
			logWarn(
				`Failed to read usage ledger ${basename(file)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return filterRows(rows, query).sort((a, b) => a.createdAt - b.createdAt);
}

function createBucket(key: string): UsageSummaryBucket {
	return {
		key,
		requests: 0,
		successes: 0,
		failures: 0,
		blocked: 0,
		cancelled: 0,
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
	};
}

function getBucketKey(row: UsageLedgerRow, by: UsageSummaryGroupBy): string {
	switch (by) {
		case "account":
			return row.account?.accountHash ?? row.account?.emailHash ?? "unknown";
		case "project":
			return row.projectKey ?? "global";
		case "outcome":
			return row.outcome;
		case "day":
			return new Date(row.createdAt).toISOString().slice(0, 10);
		case "model":
			return row.model ?? "unknown";
	}
}

function addRowToBucket(bucket: UsageSummaryBucket, row: UsageLedgerRow): void {
	bucket.requests += 1;
	if (row.outcome === "success") bucket.successes += 1;
	if (row.outcome === "failure") bucket.failures += 1;
	if (row.outcome === "blocked") bucket.blocked += 1;
	if (row.outcome === "cancelled") bucket.cancelled += 1;
	bucket.inputTokens += row.tokens.inputTokens;
	bucket.outputTokens += row.tokens.outputTokens;
	bucket.cachedInputTokens += row.tokens.cachedInputTokens;
	bucket.reasoningTokens += row.tokens.reasoningTokens;
	bucket.totalTokens += row.tokens.totalTokens;
	bucket.costUsd = Number((bucket.costUsd + (row.costUsd ?? 0)).toFixed(8));
}

export async function summarizeUsageLedger(
	query: UsageSummaryQuery = {},
): Promise<UsageSummary> {
	const by = query.by ?? "model";
	const rows = await readUsageLedgerRows(query);
	const totals = createBucket("total");
	const buckets = new Map<string, UsageSummaryBucket>();
	for (const row of rows) {
		addRowToBucket(totals, row);
		const key = getBucketKey(row, by);
		const bucket = buckets.get(key) ?? createBucket(key);
		addRowToBucket(bucket, row);
		buckets.set(key, bucket);
	}

	return {
		since: normalizeTimestamp(query.since),
		until: normalizeTimestamp(query.until),
		by,
		totals,
		buckets: [...buckets.values()].sort((a, b) =>
			a.key.localeCompare(b.key),
		),
	};
}

export async function rotateUsageLedger(options: {
	now?: number;
	ifLargerThanBytes?: number;
} = {}): Promise<string | null> {
	const { dir, current } = getUsageLedgerPaths();
	if (!existsSync(current)) {
		return null;
	}
	const stat = await fs.stat(current);
	if (
		typeof options.ifLargerThanBytes === "number" &&
		stat.size <= options.ifLargerThanBytes
	) {
		return null;
	}
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const stamp = new Date(options.now ?? Date.now())
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(".", "");
	const rotated = join(dir, `usage-ledger.${stamp}.jsonl`);
	await renameWithRetry(current, rotated);
	return rotated;
}

export function resetUsageLedgerQueueForTests(): void {
	appendQueue = Promise.resolve();
}
