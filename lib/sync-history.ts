import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCliSyncRun } from "./codex-cli/sync.js";
import type { LiveAccountSyncSnapshot } from "./live-account-sync.js";
import { createLogger } from "./logger.js";
import { getCodexLogDir } from "./runtime-paths.js";

const log = createLogger("sync-history");

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
