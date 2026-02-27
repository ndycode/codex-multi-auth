import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { createLogger } from "./logger.js";

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

/**
 * Convert an fs.watch filename value into a UTF-8 string or `null`.
 *
 * @param filename - The filename value emitted by `fs.watch` (string, Buffer, or `null`)
 * @returns `filename` decoded as a UTF-8 string, or `null` if the input is `null`
 */
function normalizeFsWatchFilename(filename: string | Buffer | null): string | null {
	if (filename === null) return null;
	if (typeof filename === "string") return filename;
	return filename.toString("utf-8");
}

/**
 * Read the file modification time (mtime) in milliseconds for the given path.
 *
 * Concurrency: this observes the filesystem state at the time of the call; concurrent writes may change the mtime immediately after reading.
 * Platform notes: filesystem timestamp resolution can vary (notably coarser on some Windows filesystems), so mtime may appear unchanged for rapid updates.
 * Security: `path` may contain sensitive tokens; callers should redact or avoid logging it in plaintext.
 *
 * @param path - Filesystem path to read
 * @returns The file's modification time in milliseconds, or `null` if the file does not exist or the mtime is not a finite number
 * @throws Any filesystem error other than ENOENT (which is returned as `null`)
 */
async function readMtimeMs(path: string): Promise<number | null> {
	try {
		const stats = await fs.stat(path);
		return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		throw error;
	}
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

	constructor(reload: () => Promise<void>, options: LiveAccountSyncOptions = {}) {
		this.reload = reload;
		this.debounceMs = Math.max(50, Math.floor(options.debounceMs ?? 250));
		this.pollIntervalMs = Math.max(500, Math.floor(options.pollIntervalMs ?? 2_000));
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
			this.watcher = fsWatch(targetDir, { persistent: false }, (_eventType, filename) => {
				const name = normalizeFsWatchFilename(filename);
				if (!name) {
					this.scheduleReload("watch");
					return;
				}

				if (name === targetName || name.startsWith(`${targetName}.`)) {
					this.scheduleReload("watch");
				}
			});
		} catch (error) {
			this.errorCount += 1;
			log.warn("Failed to start fs.watch for account storage", {
				path,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		this.pollTimer = setInterval(() => {
			void this.pollOnce();
		}, this.pollIntervalMs);
		if (typeof this.pollTimer === "object" && "unref" in this.pollTimer && typeof this.pollTimer.unref === "function") {
			this.pollTimer.unref();
		}

		this.running = true;
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
				path: this.currentPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async runReload(reason: "watch" | "poll"): Promise<void> {
		if (!this.running || !this.currentPath) return;
		if (this.reloadInFlight) {
			await this.reloadInFlight;
			return;
		}

		this.reloadInFlight = (async () => {
			try {
				await this.reload();
				this.lastSyncAt = Date.now();
				this.reloadCount += 1;
				this.lastKnownMtimeMs = await readMtimeMs(this.currentPath as string);
				log.debug("Reloaded account manager from live storage update", {
					reason,
					path: this.currentPath,
				});
			} catch (error) {
				this.errorCount += 1;
				log.warn("Live account sync reload failed", {
					reason,
					path: this.currentPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();

		try {
			await this.reloadInFlight;
		} finally {
			this.reloadInFlight = null;
		}
	}
}
