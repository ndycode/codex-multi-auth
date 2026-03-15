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

async function trimHistoryFileIfNeeded(paths: SyncHistoryPaths): Promise<void> {
	const content = await fs.readFile(paths.historyPath, "utf8").catch((error) => {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return "";
		}
		throw error;
	});
	if (!content) {
		return;
	}
	const lines = content.split(/\r?\n/).filter(Boolean);
	if (lines.length <= MAX_HISTORY_ENTRIES) {
		return;
	}
	const trimmedContent = `${lines.slice(-MAX_HISTORY_ENTRIES).join("\n")}\n`;
	await fs.writeFile(paths.historyPath, trimmedContent, {
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
		await fs.appendFile(paths.historyPath, `${serializeEntry(entry)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await trimHistoryFileIfNeeded(paths);
		await fs.writeFile(paths.latestPath, `${JSON.stringify(entry, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
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
		const content = await fs.readFile(getSyncHistoryPaths().historyPath, "utf8");
		const parsed = content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => parseEntry(line))
			.filter((entry): entry is SyncHistoryEntry => entry !== null);
		const filtered = kind
			? parsed.filter((entry) => entry.kind === kind)
			: parsed;
		if (typeof limit === "number" && limit > 0) {
			return filtered.slice(-limit).map((entry) => cloneEntry(entry));
		}
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
}

export function __getLastSyncHistoryErrorForTests(): string | null {
	return lastAppendError;
}

export function __getLastSyncHistoryPathsForTests(): SyncHistoryPaths | null {
	return lastAppendPaths ? { ...lastAppendPaths } : null;
}
