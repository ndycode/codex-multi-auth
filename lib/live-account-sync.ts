import { type FSWatcher, promises as fs, watch as fsWatch } from "node:fs";
import { basename, dirname } from "node:path";
import { createLogger } from "./logger.js";
import { appendSyncHistoryEntry } from "./sync-history.js";

const log = createLogger("live-account-sync");

export interface LiveAccountSyncOptions {
	debounceMs?: number;
	pollIntervalMs?: number;
}

export interface LiveAccountSyncSnapshot {
	path: string | null;
	running: boolean;
	lastKnownMtimeMs: number | null;
	lastSyncAt: number | null;
	reloadCount: number;
	errorCount: number;
}

const EMPTY_LIVE_ACCOUNT_SYNC_SNAPSHOT: LiveAccountSyncSnapshot = {
	path: null,
	running: false,
	lastKnownMtimeMs: null,
	lastSyncAt: null,
	reloadCount: 0,
	errorCount: 0,
};

let lastLiveAccountSyncSnapshot: LiveAccountSyncSnapshot = {
	...EMPTY_LIVE_ACCOUNT_SYNC_SNAPSHOT,
};

export function getLastLiveAccountSyncSnapshot(): LiveAccountSyncSnapshot {
	return { ...lastLiveAccountSyncSnapshot };
}

export function __resetLastLiveAccountSyncSnapshotForTests(): void {
	lastLiveAccountSyncSnapshot = { ...EMPTY_LIVE_ACCOUNT_SYNC_SNAPSHOT };
}

/**
 * Convert an fs.watch filename value to a UTF-8 string or null.
 *
 * @param filename - The value supplied by fs.watch listeners; may be a `string`, `Buffer`, or `null`. Buffers are decoded as UTF-8.
 * @returns `filename` as a UTF-8 string, or `null` when the input is `null`.
 */
function normalizeFsWatchFilename(
	filename: string | Buffer | null,
): string | null {
	if (filename === null) return null;
	if (typeof filename === "string") return filename;
	return filename.toString("utf-8");
}

/**
 * Read the file modification time (mtime) for a given filesystem path in milliseconds.
 *
 * This is a point-in-time snapshot — the value may change immediately due to concurrent writes and callers
 * should not assume stability across subsequent operations. On some platforms (notably Windows) timestamp
 * resolution can be coarse; callers should account for that when comparing mtime values.
 *
 * Treat `path` as sensitive when logging: redact any tokens or secrets before emitting it.
 *
 * @param path - Filesystem path to inspect
 * @returns The file's mtime in milliseconds, or `null` if the path does not exist or the mtime is not finite
 */
async function readMtimeMs(path: string): Promise<number | null> {
	try {
		const stats = await fs.stat(path);
		return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EBUSY" || code === "EACCES") return null;
		throw error;
	}
}

function summarizeWatchPath(path: string | null): string {
	if (!path) return "<unknown>";
	return basename(path);
}

/**
 * Watches account storage and triggers a reload callback when file content
 * changes. Uses fs.watch + polling fallback for Windows reliability.
 */
export class LiveAccountSync {
	private readonly reload: () => Promise<void>;
	private readonly debounceMs: number;
	private readonly pollIntervalMs: number;
	private watcher: FSWatcher | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private currentPath: string | null = null;
	private running = false;
	private lastKnownMtimeMs: number | null = null;
	private lastSyncAt: number | null = null;
	private reloadCount = 0;
	private errorCount = 0;
	private reloadInFlight: Promise<void> | null = null;
	constructor(
		reload: () => Promise<void>,
		options: LiveAccountSyncOptions = {},
	) {
		this.reload = reload;
		this.debounceMs = Math.max(50, Math.floor(options.debounceMs ?? 250));
		this.pollIntervalMs = Math.max(
			500,
			Math.floor(options.pollIntervalMs ?? 2_000),
		);
		this.publishSnapshot();
	}

	async syncToPath(path: string): Promise<void> {
		if (!path) return;
		if (this.currentPath === path && this.running) return;
		this.stop();

		this.currentPath = path;
		this.lastKnownMtimeMs = await readMtimeMs(path);
		const targetDir = dirname(path);
		const targetName = basename(path);

		try {
			this.watcher = fsWatch(
				targetDir,
				{ persistent: false },
				(_eventType, filename) => {
					const name = normalizeFsWatchFilename(filename);
					if (!name) {
						this.scheduleReload("watch");
						return;
					}

					if (name === targetName || name.startsWith(`${targetName}.`)) {
						this.scheduleReload("watch");
					}
				},
			);
		} catch (error) {
			this.errorCount += 1;
			log.warn("Failed to start fs.watch for account storage", {
				path: summarizeWatchPath(path),
				error: error instanceof Error ? error.message : String(error),
			});
		}

		this.pollTimer = setInterval(() => {
			void this.pollOnce();
		}, this.pollIntervalMs);
		if (
			typeof this.pollTimer === "object" &&
			"unref" in this.pollTimer &&
			typeof this.pollTimer.unref === "function"
		) {
			this.pollTimer.unref();
		}

		this.running = true;
		this.publishSnapshot();
	}

	stop(): void {
		this.running = false;
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.publishSnapshot();
	}

	getSnapshot(): LiveAccountSyncSnapshot {
		return {
			path: this.currentPath,
			running: this.running,
			lastKnownMtimeMs: this.lastKnownMtimeMs,
			lastSyncAt: this.lastSyncAt,
			reloadCount: this.reloadCount,
			errorCount: this.errorCount,
		};
	}

	private publishSnapshot(): void {
		lastLiveAccountSyncSnapshot = this.getSnapshot();
	}

	private async recordHistory(
		reason: "watch" | "poll" | "manual",
		outcome: "success" | "error",
		message?: string,
	): Promise<void> {
		const snapshot = this.getSnapshot();
		const entry = {
			kind: "live-account-sync" as const,
			recordedAt: Date.now(),
			reason,
			outcome,
			path: this.currentPath,
			message,
			snapshot,
		};
		await appendSyncHistoryEntry(entry);
	}

	private scheduleReload(reason: "watch" | "poll"): void {
		if (!this.running) return;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			void this.runReload(reason);
		}, this.debounceMs);
	}

	private async pollOnce(): Promise<void> {
		if (!this.running || !this.currentPath) return;
		try {
			const currentMtime = await readMtimeMs(this.currentPath);
			if (currentMtime !== this.lastKnownMtimeMs) {
				this.lastKnownMtimeMs = currentMtime;
				this.scheduleReload("poll");
			}
		} catch (error) {
			this.errorCount += 1;
			log.debug("Live account sync poll failed", {
				path: summarizeWatchPath(this.currentPath),
				error: error instanceof Error ? error.message : String(error),
			});
			this.publishSnapshot();
		}
	}

	private async runReload(reason: "watch" | "poll"): Promise<void> {
		if (!this.running || !this.currentPath) return;
		const targetPath = this.currentPath;
		if (this.reloadInFlight) {
			await this.reloadInFlight;
			return;
		}

		this.reloadInFlight = (async () => {
			try {
				await this.reload();
				this.lastSyncAt = Date.now();
				this.reloadCount += 1;
				this.lastKnownMtimeMs = await readMtimeMs(targetPath);
				log.debug("Reloaded account manager from live storage update", {
					reason,
					path: summarizeWatchPath(targetPath),
				});
				await this.recordHistory(reason, "success");
			} catch (error) {
				this.errorCount += 1;
				log.warn("Live account sync reload failed", {
					reason,
					path: summarizeWatchPath(targetPath),
					error: error instanceof Error ? error.message : String(error),
				});
				await this.recordHistory(
					reason,
					"error",
					error instanceof Error ? error.message : String(error),
				);
			}
		})();

		try {
			await this.reloadInFlight;
		} finally {
			this.reloadInFlight = null;
			this.publishSnapshot();
		}
	}
}
