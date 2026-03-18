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
const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

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
let historyEntryCountEstimate: number | null = null;
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
	if (pendingHistoryWrites.size === 0) return;
	await Promise.allSettled(Array.from(pendingHistoryWrites));
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

async function readHistoryTail(
	historyPath: string,
	options: { limit: number; kind?: SyncHistoryKind },
): Promise<SyncHistoryEntry[]> {
	const { kind, limit } = options;
	const handle = await fs.open(historyPath, "r");
	try {
		const stats = await handle.stat();
		if (stats.size === 0) {
			return [];
		}

		let position = stats.size;
		let remainder = "";
		const chunkSize = 8 * 1024;
		const matchesNewestFirst: SyncHistoryEntry[] = [];

		while (position > 0 && matchesNewestFirst.length < limit) {
			const start = Math.max(0, position - chunkSize);
			const length = position - start;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			const combined = buffer.toString("utf8", 0, bytesRead) + remainder;
			const lines = combined.split("\n");
			remainder = lines.shift() ?? "";

			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const line = lines[index]?.trim();
				if (!line) continue;
				const entry = parseEntry(line);
				if (!entry) continue;
				if (kind && entry.kind !== kind) continue;
				matchesNewestFirst.push(entry);
				if (matchesNewestFirst.length >= limit) {
					break;
				}
			}

			position = start;
		}

		const leadingLine = remainder.trim();
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

async function rewriteLatestEntry(
	latest: SyncHistoryEntry | null,
	paths: SyncHistoryPaths,
): Promise<void> {
	if (!latest) {
		await fs.rm(paths.latestPath, { force: true });
		return;
	}
	await fs.writeFile(paths.latestPath, `${JSON.stringify(latest, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

async function trimHistoryFileIfNeeded(paths: SyncHistoryPaths): Promise<PrunedSyncHistory> {
	const entries = await loadHistoryEntriesFromDisk(paths);
	const result = pruneSyncHistoryEntries(entries, MAX_HISTORY_ENTRIES);
	if (result.removed === 0) {
		return result;
	}
	if (result.entries.length === 0) {
		await fs.rm(paths.historyPath, { force: true });
		return result;
	}
	await fs.writeFile(
		paths.historyPath,
		`${result.entries.map((entry) => serializeEntry(entry)).join("\n")}\n`,
		{
			encoding: "utf8",
			mode: 0o600,
		},
	);
	return result;
}

export async function appendSyncHistoryEntry(
	entry: SyncHistoryEntry,
): Promise<void> {
	const writePromise = withHistoryLock(async () => {
		const paths = getSyncHistoryPaths();
		lastAppendPaths = paths;
		await ensureHistoryDir(paths.directory);
		if (historyEntryCountEstimate === null) {
			historyEntryCountEstimate = (await loadHistoryEntriesFromDisk(paths)).length;
		}
		await fs.appendFile(paths.historyPath, `${serializeEntry(entry)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		historyEntryCountEstimate += 1;
		const shouldTrim = historyEntryCountEstimate > MAX_HISTORY_ENTRIES;
		const prunedHistory = shouldTrim
			? await trimHistoryFileIfNeeded(paths)
			: {
					entries: [],
					removed: 0,
					latest: entry,
				};
		if (shouldTrim) {
			historyEntryCountEstimate = prunedHistory.entries.length;
		}
		await rewriteLatestEntry(prunedHistory.latest ?? entry, paths);
		lastAppendError = null;
	});
	pendingHistoryWrites.add(writePromise);
	try {
		await writePromise;
	} catch (error) {
		lastAppendError = error instanceof Error ? error.message : String(error);
		log.debug("Failed to append sync history", {
			error: lastAppendError,
		});
		throw error;
	} finally {
		pendingHistoryWrites.delete(writePromise);
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
			return readHistoryTail(paths.historyPath, {
				kind,
				limit,
			});
		}
		const parsed = await loadHistoryEntriesFromDisk(paths);
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
	return withHistoryLock(async () => {
		const paths = getSyncHistoryPaths();
		await ensureHistoryDir(paths.directory);
		const entries = await loadHistoryEntriesFromDisk(paths);
		const result = pruneSyncHistoryEntries(entries, maxEntries);
		if (result.entries.length === 0) {
			await fs.rm(paths.historyPath, { force: true });
		} else {
			await fs.writeFile(
				paths.historyPath,
				`${result.entries.map((entry) => serializeEntry(entry)).join("\n")}\n`,
				{
					encoding: "utf8",
					mode: 0o600,
				},
			);
		}
		await rewriteLatestEntry(result.latest, paths);
		lastAppendPaths = paths;
		lastAppendError = null;
		historyEntryCountEstimate = result.entries.length;
		return {
			removed: result.removed,
			kept: result.entries.length,
			latest: result.latest,
		};
	});
}

export function cloneSyncHistoryEntry(
	entry: SyncHistoryEntry | null,
): SyncHistoryEntry | null {
	return cloneEntry(entry);
}

export function configureSyncHistoryForTests(directory: string | null): void {
	historyDirOverride = directory ? directory.trim() : null;
	historyEntryCountEstimate = null;
}

export async function __resetSyncHistoryForTests(): Promise<void> {
	const paths = getSyncHistoryPaths();
	await waitForPendingHistoryWrites();
	await withHistoryLock(async () => {
		for (const target of [paths.historyPath, paths.latestPath]) {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					await fs.rm(target, { force: true });
					break;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (
						!code ||
						!RETRYABLE_REMOVE_CODES.has(code) ||
						attempt === 4
					) {
						throw error;
					}
					await new Promise((resolve) =>
						setTimeout(resolve, 25 * 2 ** attempt),
					);
				}
			}
		}
	});
	lastAppendError = null;
	lastAppendPaths = null;
	historyEntryCountEstimate = 0; // Files were just deleted; no disk reread is needed on the next append.
}

export function __getLastSyncHistoryErrorForTests(): string | null {
	return lastAppendError;
}

export function __getLastSyncHistoryPathsForTests(): SyncHistoryPaths | null {
	return lastAppendPaths ? { ...lastAppendPaths } : null;
}
