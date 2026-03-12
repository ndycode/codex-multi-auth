import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCliSyncRun } from "./codex-cli/sync.js";
import type { LiveAccountSyncSnapshot } from "./live-account-sync.js";
import { createLogger } from "./logger.js";
import { getCodexLogDir } from "./runtime-paths.js";

const log = createLogger("sync-history");
const SYNC_HISTORY_MAX_ENTRIES = 200;

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

const HISTORY_FILE_NAME = "sync-history.ndjson";
const LATEST_FILE_NAME = "sync-history-latest.json";

let historyDirOverride: string | null = null;
let historyMutex: Promise<void> = Promise.resolve();
let lastAppendError: string | null = null;
let lastAppendPaths: SyncHistoryPaths | null = null;
const pendingHistoryWrites = new Set<Promise<void>>();

async function waitForPendingHistoryWrites(): Promise<void> {
	if (pendingHistoryWrites.size === 0) return;
	await Promise.all(Array.from(pendingHistoryWrites));
}

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

function withHistoryLock<T>(fn: () => Promise<T>): Promise<T> {
	const previous = historyMutex;
	let release: () => void = () => {};
	historyMutex = new Promise<void>((resolve) => {
		release = resolve;
	});
	return previous.then(fn).finally(() => release());
}

async function ensureHistoryDir(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

function serializeEntry(entry: SyncHistoryEntry): string {
	return JSON.stringify(entry);
}

function cloneEntry<T extends SyncHistoryEntry | null>(entry: T): T {
	if (!entry) return entry;
	return JSON.parse(JSON.stringify(entry)) as T;
}

export interface PrunedSyncHistory {
	entries: SyncHistoryEntry[];
	removed: number;
	latest: SyncHistoryEntry | null;
}

export function pruneSyncHistoryEntries(
	entries: SyncHistoryEntry[],
	maxEntries: number = SYNC_HISTORY_MAX_ENTRIES,
): PrunedSyncHistory {
	const boundedMaxEntries = Math.max(0, maxEntries);
	if (entries.length === 0) {
		return { entries: [], removed: 0, latest: null };
	}

	const latestByKind = new Map<SyncHistoryKind, SyncHistoryEntry>();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry) continue;
		if (!latestByKind.has(entry.kind)) {
			latestByKind.set(entry.kind, entry);
		}
	}

	const required = new Set(latestByKind.values());
	const kept: SyncHistoryEntry[] = [];
	const seen = new Set<SyncHistoryEntry>();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || seen.has(entry)) continue;
		const keepEntry = kept.length < boundedMaxEntries || required.has(entry);
		if (keepEntry) {
			kept.push(entry);
			seen.add(entry);
		}
	}

	const chronological = kept.reverse();
	const latest = chronological.at(-1) ?? null;
	return {
		entries: chronological,
		removed: entries.length - chronological.length,
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
	const latestContent = `${JSON.stringify(latest, null, 2)}\n`;
	await fs.writeFile(paths.latestPath, latestContent, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function appendSyncHistoryEntry(
	entry: SyncHistoryEntry,
): Promise<void> {
	const writePromise = withHistoryLock(async () => {
		const paths = getSyncHistoryPaths();
		lastAppendPaths = paths;
		await ensureHistoryDir(paths.directory);

		const line = `${serializeEntry(entry)}\n`;
		const latestContent = `${JSON.stringify(entry, null, 2)}\n`;
		await fs.appendFile(paths.historyPath, line, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.writeFile(paths.latestPath, latestContent, {
			encoding: "utf8",
			mode: 0o600,
		});
		lastAppendError = null;
	});
	pendingHistoryWrites.add(writePromise);
	await writePromise
		.catch((error) => {
			lastAppendError = error instanceof Error ? error.message : String(error);
			log.debug("Failed to append sync history", {
				error: lastAppendError,
			});
		})
		.finally(() => {
			pendingHistoryWrites.delete(writePromise);
		});
}

export async function readSyncHistory(
	options: { limit?: number; kind?: SyncHistoryKind } = {},
): Promise<SyncHistoryEntry[]> {
	const { limit, kind } = options;
	await waitForPendingHistoryWrites();
	try {
		const content = await fs.readFile(
			getSyncHistoryPaths().historyPath,
			"utf8",
		);
		const lines = content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const parsed = lines.map((line) => JSON.parse(line) as SyncHistoryEntry);
		const filtered = kind
			? parsed.filter((entry) => entry.kind === kind)
			: parsed;
		return typeof limit === "number" && limit > 0
			? filtered.slice(-limit)
			: filtered;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
		return cloneEntry(JSON.parse(content) as SyncHistoryEntry);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code && code !== "ENOENT") {
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
	const maxEntries = options.maxEntries ?? SYNC_HISTORY_MAX_ENTRIES;
	await waitForPendingHistoryWrites();
	return withHistoryLock(async () => {
		const paths = getSyncHistoryPaths();
		await ensureHistoryDir(paths.directory);
		let entries: SyncHistoryEntry[] = [];
		try {
			entries = await readSyncHistory();
		} catch {
			entries = [];
		}

		const {
			entries: prunedEntries,
			removed,
			latest,
		} = pruneSyncHistoryEntries(entries, maxEntries);
		if (prunedEntries.length === 0) {
			await fs.rm(paths.historyPath, { force: true });
		} else {
			const serialized =
				prunedEntries.map((entry) => serializeEntry(entry)).join("\n") +
				(prunedEntries.length > 0 ? "\n" : "");
			await fs.writeFile(paths.historyPath, serialized, {
				encoding: "utf8",
				mode: 0o600,
			});
		}
		await rewriteLatestEntry(latest, paths);
		lastAppendPaths = paths;
		lastAppendError = null;
		return { removed, kept: prunedEntries.length, latest };
	});
}

export function configureSyncHistoryForTests(directory: string | null): void {
	historyDirOverride = directory ? directory.trim() : null;
}

export async function __resetSyncHistoryForTests(): Promise<void> {
	const paths = getSyncHistoryPaths();
	await waitForPendingHistoryWrites();
	await withHistoryLock(async () => {
		await fs.rm(paths.historyPath, { force: true });
		await fs.rm(paths.latestPath, { force: true });
	});
	lastAppendError = null;
	lastAppendPaths = null;
}

export function cloneSyncHistoryEntry(
	entry: SyncHistoryEntry | null,
): SyncHistoryEntry | null {
	return cloneEntry(entry);
}

export function __getLastSyncHistoryErrorForTests(): string | null {
	return lastAppendError;
}

export function __getLastSyncHistoryPathsForTests(): SyncHistoryPaths | null {
	return lastAppendPaths ? { ...lastAppendPaths } : null;
}
