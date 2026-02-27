import { createLogger } from "./logger.js";
import { applyRefreshResult, refreshExpiringAccounts } from "./proactive-refresh.js";
import type { AccountManager } from "./accounts.js";

const log = createLogger("refresh-guardian");

export interface RefreshGuardianOptions {
	intervalMs?: number;
	bufferMs?: number;
}

export interface RefreshGuardianStats {
	runs: number;
	refreshed: number;
	failed: number;
	lastRunAt: number | null;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class RefreshGuardian {
	private readonly getAccountManager: () => AccountManager | null;
	private readonly intervalMs: number;
	private readonly bufferMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private stats: RefreshGuardianStats = {
		runs: 0,
		refreshed: 0,
		failed: 0,
		lastRunAt: null,
	};

	constructor(
		getAccountManager: () => AccountManager | null,
		options: RefreshGuardianOptions = {},
	) {
		this.getAccountManager = getAccountManager;
		this.intervalMs = Math.max(5_000, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
		this.bufferMs = Math.max(30_000, Math.floor(options.bufferMs ?? 5 * 60_000));
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		if (typeof this.timer === "object" && "unref" in this.timer && typeof this.timer.unref === "function") {
			this.timer.unref();
		}
		log.debug("Refresh guardian started", {
			intervalMs: this.intervalMs,
			bufferMs: this.bufferMs,
		});
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	getStats(): RefreshGuardianStats {
		return { ...this.stats };
	}

	async tick(): Promise<void> {
		if (this.running) return;
		const manager = this.getAccountManager();
		if (!manager) return;
		this.running = true;
		try {
			const snapshot = manager.getAccountsSnapshot().filter((account) => account.enabled !== false);
			if (snapshot.length === 0) {
				return;
			}

			const refreshResults = await refreshExpiringAccounts(snapshot, this.bufferMs);
			if (refreshResults.size === 0) {
				this.stats.runs += 1;
				this.stats.lastRunAt = Date.now();
				return;
			}

			for (const [accountIndex, result] of refreshResults.entries()) {
				const account = manager.getAccountByIndex(accountIndex);
				if (!account) continue;

				if (result.reason === "success" && result.tokenResult?.type === "success") {
					applyRefreshResult(account, result.tokenResult);
					manager.clearAuthFailures(account);
					this.stats.refreshed += 1;
				} else if (result.reason === "failed") {
					manager.markAccountCoolingDown(account, this.bufferMs, "auth-failure");
					this.stats.failed += 1;
				}
			}

			manager.saveToDiskDebounced();
			this.stats.runs += 1;
			this.stats.lastRunAt = Date.now();
		} catch (error) {
			log.warn("Refresh guardian tick failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.running = false;
		}
	}
}
