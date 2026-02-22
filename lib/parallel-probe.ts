import type { ManagedAccount, AccountManager } from "./accounts.js";
import type { ModelFamily } from "./prompts/codex.js";
import { createLogger } from "./logger.js";
import {
	getHealthTracker,
	getTokenTracker,
	type AccountWithMetrics,
} from "./rotation.js";
import { clearExpiredRateLimits, isRateLimitedForFamily } from "./accounts/rate-limits.js";

const log = createLogger("parallel-probe");

export interface ProbeCandidate {
	account: ManagedAccount;
	controller: AbortController;
}

export interface ProbeResult<T> {
	type: "success" | "failure";
	account: ManagedAccount;
	response?: T;
	error?: Error;
}

export interface ParallelProbeOptions {
	maxConcurrency: number;
	timeoutMs: number;
}

/**
 * Get top N candidates ranked by hybrid score WITHOUT mutating AccountManager state.
 * Uses getAccountsSnapshot() and ranks by health + tokens + freshness.
 */
export function getTopCandidates(
	accountManager: AccountManager,
	modelFamily: ModelFamily,
	model: string | null,
	maxCandidates: number,
): ManagedAccount[] {
	const accounts = accountManager.getAccountsSnapshot();
	if (accounts.length === 0) return [];

	const quotaKey = model ? `${modelFamily}:${model}` : modelFamily;
	const healthTracker = getHealthTracker();
	const tokenTracker = getTokenTracker();

	const accountsWithMetrics: (AccountWithMetrics & { account: ManagedAccount })[] = [];

	for (const account of accounts) {
		clearExpiredRateLimits(account);
		const isRateLimited = isRateLimitedForFamily(account, modelFamily, model);
		const isCoolingDown = account.coolingDownUntil !== undefined && account.coolingDownUntil > Date.now();
		const isAvailable = !isRateLimited && !isCoolingDown;

		accountsWithMetrics.push({
			index: account.index,
			isAvailable,
			lastUsed: account.lastUsed,
			account,
		});
	}

	const available = accountsWithMetrics.filter((a) => a.isAvailable);
	if (available.length === 0) return [];

	const now = Date.now();
	const scored = available.map((a) => {
		const health = healthTracker.getScore(a.index, quotaKey);
		const tokens = tokenTracker.getTokens(a.index, quotaKey);
		const hoursSinceUsed = (now - a.lastUsed) / (1000 * 60 * 60);
		const score = health * 2 + tokens * 5 + hoursSinceUsed * 2.0;
		return { ...a, score };
	});

	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, maxCandidates).map((s) => s.account);
}

/**
 * Probe accounts in parallel with first-success-wins racing.
 * Immediately aborts losing candidates when a winner is found.
 */
export async function probeAccountsInParallel<T>(
	candidates: ProbeCandidate[],
	probeFn: (account: ManagedAccount, signal: AbortSignal) => Promise<T>,
	_options: Partial<ParallelProbeOptions> = {},
): Promise<ProbeResult<T> | null> {
	if (candidates.length === 0) {
		return null;
	}

	if (candidates.length === 1) {
		const candidate = candidates[0];
		if (!candidate) return null;
		const { account, controller } = candidate;
		try {
			const response = await probeFn(account, controller.signal);
			return { type: "success", account, response };
		} catch (error) {
			return { type: "failure", account, error: error as Error };
		}
	}

	log.debug(`Probing ${candidates.length} accounts in parallel`);

	let winner: ProbeResult<T> | null = null;
	let resolvedCount = 0;

	return new Promise<ProbeResult<T> | null>((resolve) => {
		for (const { account, controller } of candidates) {
			probeFn(account, controller.signal)
				.then((response) => {
					if (!winner) {
						winner = { type: "success", account, response };
						log.debug(`Parallel probe succeeded with account ${account.index + 1}`);

						for (const c of candidates) {
							if (c.account.index !== account.index) {
								c.controller.abort();
							}
						}
						resolve(winner);
					}
				})
				.catch((_error) => {
					resolvedCount++;
					if (resolvedCount === candidates.length && !winner) {
						resolve(null);
					}
				});
		}
	});
}

export function createProbeCandidates(accounts: ManagedAccount[]): ProbeCandidate[] {
	return accounts.map((account) => ({
		account,
		controller: new AbortController(),
	}));
}
