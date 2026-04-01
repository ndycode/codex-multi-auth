import { createLogger } from "./logger.js";
import { refreshExpiringAccounts } from "./proactive-refresh.js";
import type { AccountManager } from "./accounts.js";
import { CodexAuthError } from "./errors.js";
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

	private async applyRefreshOutcome(
		manager: AccountManager,
		sourceAccount: ReturnType<AccountManager["getAccountsSnapshot"]>[number],
		result: Awaited<ReturnType<typeof refreshExpiringAccounts>> extends Map<
			number,
			infer TValue
		>
			? TValue
			: never,
	): Promise<boolean> {
		switch (result.reason) {
			case "success": {
				if (result.tokenResult?.type !== "success") {
					const account = manager.getAccountByIdentity(sourceAccount);
					if (!account) return false;
					manager.markAccountCoolingDown(account, this.bufferMs, "network-error");
					this.stats.failed += 1;
					this.stats.networkFailed += 1;
					return true;
				}

				const refreshedAuth = {
					type: "oauth" as const,
					access: result.tokenResult.access,
					refresh: result.tokenResult.refresh,
					expires: result.tokenResult.expires,
					multiAccount: true,
				};
				try {
					const committedAccount = await manager.commitRefreshedAuth(
						sourceAccount,
						refreshedAuth,
					);
					if (!committedAccount) {
						const account =
							manager.getAccountByIdentity(sourceAccount, refreshedAuth) ??
							manager.getAccountByIdentity(sourceAccount);
						if (account) {
							manager.markAccountCoolingDown(
								account,
								this.bufferMs,
								"network-error",
							);
						}
						this.stats.failed += 1;
						this.stats.networkFailed += 1;
						return !!account;
					}
				} catch (error) {
					log.warn("Refresh guardian commit failed", {
						sourceIndex: sourceAccount.index,
						error: error instanceof Error ? error.message : String(error),
					});
					const account =
						manager.getAccountByIdentity(sourceAccount, refreshedAuth) ??
						manager.getAccountByIdentity(sourceAccount);
					const cooldownReason: CooldownReason =
						error instanceof CodexAuthError && !error.retryable
							? "auth-failure"
							: "network-error";
					if (account) {
						manager.markAccountCoolingDown(account, this.bufferMs, cooldownReason);
					}
					this.stats.failed += 1;
					if (cooldownReason === "auth-failure") this.stats.authFailed += 1;
					else this.stats.networkFailed += 1;
					return !!account;
				}
				this.stats.refreshed += 1;
				return false;
			}
			case "failed": {
				const account = manager.getAccountByIdentity(sourceAccount);
				if (!account) return false;
				const cooldownReason = this.classifyFailureReason(result.tokenResult);
				manager.markAccountCoolingDown(account, this.bufferMs, cooldownReason);
				this.stats.failed += 1;
				if (cooldownReason === "rate-limit") this.stats.rateLimited += 1;
				else if (cooldownReason === "auth-failure") this.stats.authFailed += 1;
				else this.stats.networkFailed += 1;
				return true;
			}
			case "not_needed":
				this.stats.notNeeded += 1;
				return false;
			case "no_refresh_token": {
				const account = manager.getAccountByIdentity(sourceAccount);
				if (!account) return false;
				manager.markAccountCoolingDown(account, this.bufferMs, "auth-failure");
				manager.setAccountEnabled(account.index, false);
				this.stats.noRefreshToken += 1;
				this.stats.failed += 1;
				this.stats.authFailed += 1;
				return true;
			}
		}
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

			const eligibleSnapshot = snapshot.filter((account) => !manager.isAccountCoolingDown(account));
			if (eligibleSnapshot.length === 0) {
				this.stats.runs += 1;
				this.stats.lastRunAt = Date.now();
				return;
			}

			let requiresSave = false;
			const refreshResults = await refreshExpiringAccounts(
				eligibleSnapshot,
				this.bufferMs,
				async (sourceAccount, result) => {
					const saveNeeded = await this.applyRefreshOutcome(
						manager,
						sourceAccount,
						result,
					);
					if (saveNeeded) {
						requiresSave = true;
					}
				},
			);
			if (refreshResults.size === 0) {
				this.stats.runs += 1;
				this.stats.lastRunAt = Date.now();
				return;
			}

			if (requiresSave) {
				manager.saveToDiskDebounced();
			}
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
