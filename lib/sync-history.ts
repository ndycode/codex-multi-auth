import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCliSyncRun } from "./codex-cli/sync.js";
import type { LiveAccountSyncSnapshot } from "./live-account-sync.js";
import { createLogger } from "./logger.js";
import { getCodexLogDir } from "./runtime-paths.js";

const log = createLogger("sync-history");

const HISTORY_FILE_NAME = "sync-history.ndjson";
const LATEST_FILE_NAME = "sync-history-latest.json";
const MAX_HISTORY_ENTRIES = 200;
const RETRYABLE_REMOVE_CODES = new Set([
	"EBUSY",
	"EPERM",
	"ENOTEMPTY",
	"EACCES",
]);
const RETRYABLE_RENAME_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const RETRYABLE_APPEND_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);
const RETRYABLE_READ_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);

type SyncHistoryKind = "codex-cli-sync" | "live-account-sync";

export interface CodexCliSyncHistoryEntry {
	kind: "codex-cli-sync";
	recordedAt: number;
	run: CodexCliSyncRun;
}

export interface LiveAccountSyncHistoryEntry {
	kind: "live-account-sync";
	recordedAt: number;
	reason: "watch" | "poll" | "manual";
	outcome: "success" | "error";
	path: string | null;
	message?: string;
	snapshot: LiveAccountSyncSnapshot;
}

export type SyncHistoryEntry =
	| CodexCliSyncHistoryEntry
	| LiveAccountSyncHistoryEntry;

interface SyncHistoryPaths {
	directory: string;
	historyPath: string;
	latestPath: string;
}

let historyDirOverride: string | null = null;
let historyMutex: Promise<void> = Promise.resolve();
let lastAppendError: string | null = null;
let lastAppendPaths: SyncHistoryPaths | null = null;
const pendingHistoryWrites = new Set<Promise<void>>();

function getHistoryDirectory(): string {
	return historyDirOverride ?? getCodexLogDir();
}

export function getSyncHistoryPaths(): SyncHistoryPaths {
	const directory = getHistoryDirectory();
	return {
		directory,
		historyPath: join(directory, HISTORY_FILE_NAME),
		latestPath: join(directory, LATEST_FILE_NAME),
	};
}

function cloneEntry<T extends SyncHistoryEntry | null>(entry: T): T {
	if (!entry) return entry;
	return JSON.parse(JSON.stringify(entry)) as T;
}

function serializeEntry(entry: SyncHistoryEntry): string {
	return JSON.stringify(entry);
}

export interface PrunedSyncHistory {
	entries: SyncHistoryEntry[];
	removed: number;
	latest: SyncHistoryEntry | null;
}

function withHistoryLock<T>(fn: () => Promise<T>): Promise<T> {
	const previous = historyMutex;
	let release: () => void = () => {};
	historyMutex = new Promise<void>((resolve) => {
		release = resolve;
	});
	return previous.then(fn).finally(() => release());
}

async function waitForPendingHistoryWrites(): Promise<void> {
	while (pendingHistoryWrites.size > 0) {
		await Promise.allSettled(Array.from(pendingHistoryWrites));
	}
}

function trackPendingHistoryWrite<T>(promise: Promise<T>): Promise<T> {
	const trackedPromise = promise.then(
		() => undefined,
		() => undefined,
	);
	pendingHistoryWrites.add(trackedPromise);
	return promise.finally(() => {
		pendingHistoryWrites.delete(trackedPromise);
	});
}

async function ensureHistoryDir(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

function isSyncHistoryEntry(value: unknown): value is SyncHistoryEntry {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<SyncHistoryEntry>;
	if (
		candidate.kind !== "codex-cli-sync" &&
		candidate.kind !== "live-account-sync"
	) {
		return false;
	}
	return typeof candidate.recordedAt === "number";
}

function parseEntry(line: string): SyncHistoryEntry | null {
	try {
		const parsed = JSON.parse(line) as unknown;
		return isSyncHistoryEntry(parsed) ? cloneEntry(parsed) : null;
	} catch (error) {
		log.debug("Failed to parse sync history entry", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function parseHistoryContent(content: string): SyncHistoryEntry[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => parseEntry(line))
		.filter((entry): entry is SyncHistoryEntry => entry !== null);
}

async function loadHistoryEntriesFromDisk(
	paths: SyncHistoryPaths,
): Promise<SyncHistoryEntry[]> {
	const content = await fs.readFile(paths.historyPath, "utf8").catch((error) => {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return "";
		}
		throw error;
	});
	if (!content) {
		return [];
	}
	return parseHistoryContent(content);
}

async function loadHistoryEntriesFromDiskWithRetry(
	paths: SyncHistoryPaths,
): Promise<SyncHistoryEntry[]> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await loadHistoryEntriesFromDisk(paths);
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (
				!code ||
				!RETRYABLE_READ_CODES.has(code) ||
				attempt === 4
			) {
				throw error;
			}
			await waitForHistoryRetry(attempt);
		}
	}
	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to load sync history entries.");
}

async function openHistoryFileWithRetry(
	historyPath: string,
): Promise<Awaited<ReturnType<typeof fs.open>>> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await fs.open(historyPath, "r");
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (
				code === "ENOENT" ||
				!code ||
				!RETRYABLE_READ_CODES.has(code) ||
				attempt === 4
			) {
				throw error;
			}
			await waitForHistoryRetry(attempt);
		}
	}
	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to open sync history file.");
}

async function readHistoryTail(
	historyPath: string,
	options: { limit: number; kind?: SyncHistoryKind },
): Promise<SyncHistoryEntry[]> {
	const { kind, limit } = options;
	const handle = await openHistoryFileWithRetry(historyPath);
	try {
		const stats = await handle.stat();
		if (stats.size === 0) {
			return [];
		}

		let position = stats.size;
		let remainder = Buffer.alloc(0);
		const chunkSize = 8 * 1024;
		const matchesNewestFirst: SyncHistoryEntry[] = [];

		while (position > 0 && matchesNewestFirst.length < limit) {
			const start = Math.max(0, position - chunkSize);
			const length = position - start;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			const chunk = buffer.subarray(0, bytesRead);
			const combined =
				remainder.length > 0 ? Buffer.concat([chunk, remainder]) : chunk;
			let lineEnd = combined.length;

			for (let index = combined.length - 1; index >= 0; index -= 1) {
				if (combined[index] !== 0x0a) {
					continue;
				}
				const line = combined
					.subarray(index + 1, lineEnd)
					.toString("utf8")
					.trim();
				lineEnd = index;
				if (!line) continue;
				const entry = parseEntry(line);
				if (!entry) continue;
				if (kind && entry.kind !== kind) continue;
				matchesNewestFirst.push(entry);
				if (matchesNewestFirst.length >= limit) {
					break;
				}
			}

			remainder = combined.subarray(0, lineEnd);
			position = start;
		}

		const leadingLine = remainder.toString("utf8").trim();
		if (matchesNewestFirst.length < limit && leadingLine) {
			const entry = parseEntry(leadingLine);
			if (entry && (!kind || entry.kind === kind)) {
				matchesNewestFirst.push(entry);
			}
		}

		return matchesNewestFirst.reverse().map((entry) => cloneEntry(entry));
	} finally {
		await handle.close();
	}
}

export function pruneSyncHistoryEntries(
	entries: SyncHistoryEntry[],
	maxEntries: number = MAX_HISTORY_ENTRIES,
): PrunedSyncHistory {
	if (entries.length === 0) {
		return { entries: [], removed: 0, latest: null };
	}

	const boundedMaxEntries = Math.max(0, maxEntries);
	const latestByKind = new Map<SyncHistoryKind, SyncHistoryEntry>();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || latestByKind.has(entry.kind)) {
			continue;
		}
		latestByKind.set(entry.kind, entry);
	}

	const requiredEntries = new Set(latestByKind.values());
	const keptEntries: SyncHistoryEntry[] = [];
	const seenEntries = new Set<SyncHistoryEntry>();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || seenEntries.has(entry)) {
			continue;
		}
		if (
			keptEntries.length < boundedMaxEntries ||
			requiredEntries.has(entry)
		) {
			keptEntries.push(entry);
			seenEntries.add(entry);
		}
	}

	const chronologicalEntries = keptEntries
		.reverse()
		.map((entry) => cloneEntry(entry));
	const latest = cloneEntry(chronologicalEntries.at(-1) ?? null);
	return {
		entries: chronologicalEntries,
		removed: entries.length - chronologicalEntries.length,
		latest,
	};
}

async function waitForHistoryRetry(attempt: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
}

async function removeHistoryFileWithRetry(targetPath: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.rm(targetPath, { force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return;
			}
			if (
				!code ||
				!RETRYABLE_REMOVE_CODES.has(code) ||
				attempt === 4
			) {
				throw error;
			}
			await waitForHistoryRetry(attempt);
		}
	}
}

async function renameHistoryFileWithRetry(
	tempPath: string,
	targetPath: string,
): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.rename(tempPath, targetPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				!code ||
				!RETRYABLE_RENAME_CODES.has(code) ||
				attempt === 4
			) {
				throw error;
			}
			await waitForHistoryRetry(attempt);
		}
	}
}

async function appendHistoryFileWithRetry(
	targetPath: string,
	content: string,
): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.appendFile(targetPath, content, {
				encoding: "utf8",
				mode: 0o600,
			});
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				!code ||
				!RETRYABLE_APPEND_CODES.has(code) ||
				attempt === 4
			) {
				throw error;
			}
			await waitForHistoryRetry(attempt);
		}
	}
}

async function rewriteLatestEntry(
	latest: SyncHistoryEntry | null,
	paths: SyncHistoryPaths,
): Promise<void> {
	if (!latest) {
		await removeHistoryFileWithRetry(paths.latestPath);
		return;
	}
	await writeHistoryFileAtomically(
		paths.latestPath,
		`${JSON.stringify(latest, null, 2)}\n`,
	);
}

async function writeHistoryFileAtomically(
	targetPath: string,
	content: string,
): Promise<void> {
	const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2)}`;
	try {
		await fs.writeFile(tempPath, content, {
			encoding: "utf8",
			mode: 0o600,
		});
		await renameHistoryFileWithRetry(tempPath, targetPath);
	} catch (error) {
		await removeHistoryFileWithRetry(tempPath).catch(() => {});
		throw error;
	}
}

async function trimHistoryFileIfNeeded(paths: SyncHistoryPaths): Promise<PrunedSyncHistory> {
	const entries = await loadHistoryEntriesFromDiskWithRetry(paths);
	const result = pruneSyncHistoryEntries(entries, MAX_HISTORY_ENTRIES);
	if (result.removed === 0) {
		return result;
	}
	if (result.entries.length === 0) {
		await removeHistoryFileWithRetry(paths.historyPath);
		return result;
	}
	await writeHistoryFileAtomically(
		paths.historyPath,
		`${result.entries.map((entry) => serializeEntry(entry)).join("\n")}\n`,
	);
	return result;
}

export async function appendSyncHistoryEntry(
	entry: SyncHistoryEntry,
): Promise<void> {
	const writePromise = trackPendingHistoryWrite(withHistoryLock(async () => {
		const paths = getSyncHistoryPaths();
		lastAppendPaths = paths;
		await ensureHistoryDir(paths.directory);
		await appendHistoryFileWithRetry(
			paths.historyPath,
			`${serializeEntry(entry)}\n`,
		);
		const prunedHistory = await trimHistoryFileIfNeeded(paths);
		await rewriteLatestEntry(prunedHistory.latest ?? entry, paths);
		lastAppendError = null;
	}));
	try {
		await writePromise;
	} catch (error) {
		lastAppendError = error instanceof Error ? error.message : String(error);
		log.debug("Failed to append sync history", {
			error: lastAppendError,
		});
		throw error;
	}
}

export async function readSyncHistory(
	options: { limit?: number; kind?: SyncHistoryKind } = {},
): Promise<SyncHistoryEntry[]> {
	const { kind, limit } = options;
	await waitForPendingHistoryWrites();
	try {
		const paths = getSyncHistoryPaths();
		if (typeof limit === "number" && limit > 0) {
			return await readHistoryTail(getSyncHistoryPaths().historyPath, {
				kind,
				limit,
			});
		}
		const parsed = await loadHistoryEntriesFromDiskWithRetry(paths);
		const filtered = kind
			? parsed.filter((entry) => entry.kind === kind)
			: parsed;
		return filtered.map((entry) => cloneEntry(entry));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.debug("Failed to read sync history", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return [];
	}
}

export function readLatestSyncHistorySync(): SyncHistoryEntry | null {
	try {
		const content = readFileSync(getSyncHistoryPaths().latestPath, "utf8");
		const parsed = parseEntry(content);
		return parsed ? cloneEntry(parsed) : null;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.debug("Failed to read latest sync history", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return null;
	}
}

export async function pruneSyncHistory(
	options: { maxEntries?: number } = {},
): Promise<{ removed: number; kept: number; latest: SyncHistoryEntry | null }> {
	const maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES;
	await waitForPendingHistoryWrites();
	return trackPendingHistoryWrite(withHistoryLock(async () => {
		const paths = getSyncHistoryPaths();
		await ensureHistoryDir(paths.directory);
		const entries = await loadHistoryEntriesFromDiskWithRetry(paths);
		const result = pruneSyncHistoryEntries(entries, maxEntries);
		if (result.entries.length === 0) {
			await removeHistoryFileWithRetry(paths.historyPath);
		} else {
			await writeHistoryFileAtomically(
				paths.historyPath,
				`${result.entries.map((entry) => serializeEntry(entry)).join("\n")}\n`,
			);
		}
		await rewriteLatestEntry(result.latest, paths);
		return {
			removed: result.removed,
			kept: result.entries.length,
			latest: result.latest,
		};
	}));
}

export function cloneSyncHistoryEntry(
	entry: SyncHistoryEntry | null,
): SyncHistoryEntry | null {
	return cloneEntry(entry);
}

export function configureSyncHistoryForTests(directory: string | null): void {
	historyDirOverride = directory ? directory.trim() : null;
}

export async function __resetSyncHistoryForTests(): Promise<void> {
	const paths = getSyncHistoryPaths();
	await waitForPendingHistoryWrites();
	await withHistoryLock(async () => {
		for (const target of [paths.historyPath, paths.latestPath]) {
			await removeHistoryFileWithRetry(target);
		}
	});
	lastAppendError = null;
	lastAppendPaths = null;
}

export function __getLastSyncHistoryErrorForTests(): string | null {
	return lastAppendError;
}

export function __getLastSyncHistoryPathsForTests(): SyncHistoryPaths | null {
	return lastAppendPaths ? { ...lastAppendPaths } : null;
}
