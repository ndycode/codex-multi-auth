import { createLogger } from "./logger.js";
import { applyRefreshResult, refreshExpiringAccounts } from "./proactive-refresh.js";
import type { AccountManager } from "./accounts.js";
import type { CooldownReason } from "./storage.js";
import type { TokenResult } from "./types.js";

const log = createLogger("refresh-guardian");

export interface RefreshGuardianOptions {
	intervalMs?: number;
	bufferMs?: number;
}

export interface RefreshGuardianStats {
	runs: number;
	refreshed: number;
	failed: number;
	notNeeded: number;
	noRefreshToken: number;
	rateLimited: number;
	networkFailed: number;
	authFailed: number;
	lastRunAt: number | null;
	lastTickDurationMs: number;
	maxTickDurationMs: number;
	cumulativeTickDurationMs: number;
	avgTickDurationMs: number;
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
		notNeeded: 0,
		noRefreshToken: 0,
		rateLimited: 0,
		networkFailed: 0,
		authFailed: 0,
		lastRunAt: null,
		lastTickDurationMs: 0,
		maxTickDurationMs: 0,
		cumulativeTickDurationMs: 0,
		avgTickDurationMs: 0,
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

	private classifyFailureReason(tokenResult: TokenResult | undefined): CooldownReason {
		if (!tokenResult || tokenResult.type !== "failed") {
			return "network-error";
		}

		const statusCode = tokenResult.statusCode;
		if (statusCode === 429) return "rate-limit";
		if (tokenResult.reason === "network_error") return "network-error";
		if (tokenResult.reason === "missing_refresh") return "auth-failure";
		if (tokenResult.reason === "invalid_response") return "auth-failure";
		if (
			tokenResult.reason === "http_error" &&
			(statusCode === 400 || statusCode === 401 || statusCode === 403)
		) {
			return "auth-failure";
		}
		return "network-error";
	}

	async tick(): Promise<void> {
		if (this.running) return;
		const manager = this.getAccountManager();
		if (!manager) return;
		this.running = true;
		const tickStart = performance.now();
		let countedRun = false;
		try {
			const snapshot = manager.getAccountsSnapshot().filter((account) => account.enabled !== false);
			if (snapshot.length === 0) {
				return;
			}

			const refreshResults = await refreshExpiringAccounts(snapshot, this.bufferMs);
			if (refreshResults.size === 0) {
				this.stats.runs += 1;
				countedRun = true;
				this.stats.lastRunAt = Date.now();
				return;
			}

			const snapshotByIndex = new Map<number, (typeof snapshot)[number]>();
			for (const candidate of snapshot) {
				snapshotByIndex.set(candidate.index, candidate);
			}
			const liveAccounts = manager.getAccountsSnapshot();
			const liveIndexByRefreshToken = new Map<string, number>();
			for (let i = 0; i < liveAccounts.length; i += 1) {
				const candidate = liveAccounts[i];
				if (!candidate?.refreshToken) continue;
				liveIndexByRefreshToken.set(candidate.refreshToken, i);
			}

			for (const [accountIndex, result] of refreshResults.entries()) {
				const sourceAccount = snapshotByIndex.get(accountIndex);
				if (!sourceAccount) continue;
				const resolvedIndex = liveIndexByRefreshToken.get(sourceAccount.refreshToken);
				const account =
					typeof resolvedIndex === "number"
						? manager.getAccountByIndex(resolvedIndex)
						: null;
				if (!account) continue;

				switch (result.reason) {
					case "success":
						if (result.tokenResult?.type === "success") {
							applyRefreshResult(account, result.tokenResult);
							manager.clearAuthFailures(account);
							this.stats.refreshed += 1;
						} else {
							manager.markAccountCoolingDown(account, this.bufferMs, "network-error");
							this.stats.failed += 1;
							this.stats.networkFailed += 1;
						}
						break;
					case "failed": {
						const cooldownReason = this.classifyFailureReason(result.tokenResult);
						manager.markAccountCoolingDown(account, this.bufferMs, cooldownReason);
						this.stats.failed += 1;
						if (cooldownReason === "rate-limit") this.stats.rateLimited += 1;
						else if (cooldownReason === "auth-failure") this.stats.authFailed += 1;
						else this.stats.networkFailed += 1;
						break;
					}
					case "not_needed":
						this.stats.notNeeded += 1;
						break;
					case "no_refresh_token":
						manager.markAccountCoolingDown(account, this.bufferMs, "auth-failure");
						manager.setAccountEnabled(account.index, false);
						this.stats.noRefreshToken += 1;
						this.stats.failed += 1;
						this.stats.authFailed += 1;
						break;
				}
			}

			manager.saveToDiskDebounced();
			this.stats.runs += 1;
			countedRun = true;
			this.stats.lastRunAt = Date.now();
		} catch (error) {
			log.warn("Refresh guardian tick failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			const durationMs = Math.round(performance.now() - tickStart);
			this.stats.lastTickDurationMs = durationMs;
			if (countedRun) {
				this.stats.maxTickDurationMs = Math.max(this.stats.maxTickDurationMs, durationMs);
				this.stats.cumulativeTickDurationMs += durationMs;
				this.stats.avgTickDurationMs = Math.round(
					this.stats.cumulativeTickDurationMs / this.stats.runs,
				);
			}
			this.running = false;
		}
	}
}
