import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import {
	HealthScoreTracker,
	TokenBucketTracker,
	selectHybridAccount,
	type AccountWithMetrics,
} from "../../lib/rotation.js";
import {
	withRoutingMutex,
	__resetRoutingMutexForTests,
	type RoutingMutexMode,
} from "../../lib/routing-mutex.js";

/**
 * HI-05 concurrency coverage for `selectHybridAccount`.
 *
 * The companion `rotation-concurrency.property.test.ts` exercises the routing
 * mutex against a simulated cursor / cooldown map. That file documents the
 * critical-section invariants the rotation pipeline relies on, but it does
 * not call `selectHybridAccount` directly. This file fills that gap: it
 * spawns N parallel `selectHybridAccount` calls that each mutate the shared
 * `HealthScoreTracker` / `TokenBucketTracker` / per-account `isAvailable`
 * state inside the critical section, and asserts that under
 * `routingMutex === "enabled"` the selector never hands the same slot to two
 * concurrent callers when only one slot is available.
 *
 * Rationale:
 *   `selectHybridAccount` itself is pure w.r.t. its inputs, but real callers
 *   interleave selection with mutation of the trackers and the pool's
 *   `isAvailable` view (drain tokens, record rate-limit, flip availability).
 *   Without serialization, two concurrent callers can observe the same
 *   "last remaining available" slot and both pick it — the exact TOCTOU the
 *   routing mutex is meant to close.
 */

type SelectionObservation = {
	/** Index returned by selectHybridAccount inside the critical section. */
	chosenIndex: number | null;
	/**
	 * `true` when this caller entered the critical section and observed the
	 * pool state written by a previous caller (post-release visibility).
	 */
	sawPredecessorWrite: boolean;
};

interface MutablePool {
	accounts: AccountWithMetrics[];
	healthTracker: HealthScoreTracker;
	tokenTracker: TokenBucketTracker;
	/** Serialization observer — must stay <= 1 under enabled mode. */
	concurrentCallers: number;
	maxConcurrentCallers: number;
	/** Ordered record of what each critical section chose. */
	history: SelectionObservation[];
}

function createMutablePool(accountCount: number): MutablePool {
	const now = Date.now();
	const accounts: AccountWithMetrics[] = Array.from(
		{ length: accountCount },
		(_, index) => ({
			index,
			isAvailable: true,
			lastUsed: now - (accountCount - index),
		}),
	);
	return {
		accounts,
		healthTracker: new HealthScoreTracker(),
		tokenTracker: new TokenBucketTracker(),
		concurrentCallers: 0,
		maxConcurrentCallers: 0,
		history: [],
	};
}

/**
 * One caller's unit of work: take the mutex, read pool, call the real
 * `selectHybridAccount`, then mutate the same shared state the next caller
 * will see (flip isAvailable on the winner, drain its tokens, bump lastUsed).
 *
 * The `setImmediate` yield between read and write is what exposes the race
 * when no mutex is present — two concurrent tasks see the same `isAvailable`
 * view and both claim the same last-remaining slot.
 */
async function selectAndConsumeOnce(
	pool: MutablePool,
	mode: RoutingMutexMode,
): Promise<SelectionObservation> {
	const observation = await withRoutingMutex(mode, async () => {
		pool.concurrentCallers += 1;
		if (pool.concurrentCallers > pool.maxConcurrentCallers) {
			pool.maxConcurrentCallers = pool.concurrentCallers;
		}
		try {
			const preAvailable = pool.accounts.filter((a) => a.isAvailable).length;
			const selected = selectHybridAccount(
				pool.accounts,
				pool.healthTracker,
				pool.tokenTracker,
			);
			// Simulate decision latency between read and write so interleaving
			// races would manifest if the mutex were absent or broken.
			await new Promise((r) => setImmediate(r));

			let chosenIndex: number | null = null;
			if (selected) {
				chosenIndex = selected.index;
				// Critical-section write: flip availability + mutate trackers.
				// The next caller through this section must observe these writes.
				const target = pool.accounts[selected.index];
				if (target) {
					target.isAvailable = false;
					target.lastUsed = Date.now();
				}
				pool.tokenTracker.drain(selected.index, undefined, 100);
				pool.healthTracker.recordRateLimit(selected.index);
			}

			// Post-release visibility check: a new caller after at least one
			// predecessor should see strictly fewer available slots than the
			// first caller did (monotone non-increasing under mutex).
			const sawPredecessorWrite =
				pool.history.length > 0 && preAvailable < pool.accounts.length;

			return {
				chosenIndex,
				sawPredecessorWrite,
			} satisfies SelectionObservation;
		} finally {
			pool.concurrentCallers -= 1;
		}
	});
	pool.history.push(observation);
	return observation;
}

describe("selectHybridAccount concurrency (HI-05)", () => {
	afterEach(() => __resetRoutingMutexForTests());

	it("mutex-enabled: no double-selection of the same slot across parallel callers", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 2, max: 6 }),
				fc.integer({ min: 2, max: 10 }),
				async (accountCount, concurrentRequests) => {
					const pool = createMutablePool(accountCount);
					const tasks = Array.from({ length: concurrentRequests }, () =>
						selectAndConsumeOnce(pool, "enabled"),
					);
					const results = await Promise.all(tasks);

					// Invariant 1: every caller produced an observation (no lost updates).
					expect(pool.history).toHaveLength(concurrentRequests);

					// Invariant 2: no two winning callers returned the same index.
					// Once a caller wins a slot it marks the slot unavailable inside
					// the critical section; under a working mutex the next caller
					// must see that write and either pick a different slot or null.
					const winners = results
						.map((r) => r.chosenIndex)
						.filter((i): i is number => i !== null);
					const unique = new Set(winners);
					expect(unique.size).toBe(winners.length);

					// Invariant 3: winner count is bounded by account count. With
					// each caller consuming one slot, at most `accountCount` callers
					// can succeed; the rest must observe an exhausted pool and
					// return null.
					expect(winners.length).toBeLessThanOrEqual(accountCount);

					// Invariant 4: external observer proves mutual exclusion — a
					// broken mutex would let two+ tasks enter the critical section
					// concurrently and both see the same `isAvailable` view.
					expect(pool.maxConcurrentCallers).toBeLessThanOrEqual(1);
				},
			),
			{ numRuns: 50 },
		);
	});

	it("mutex-enabled: single-slot pool under N parallel callers yields exactly one winner", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 2, max: 12 }),
				async (concurrentRequests) => {
					const pool = createMutablePool(1);
					const tasks = Array.from({ length: concurrentRequests }, () =>
						selectAndConsumeOnce(pool, "enabled"),
					);
					const results = await Promise.all(tasks);

					// Exactly one caller may claim the single slot; every other
					// caller must observe it as unavailable and receive null.
					// `selectHybridAccount` returns `null` when the pool is
					// either empty or entirely unavailable (AUDIT-H2 contract).
					const winners = results.filter((r) => r.chosenIndex !== null);
					expect(winners).toHaveLength(1);
					expect(winners[0]?.chosenIndex).toBe(0);

					const losers = results.filter((r) => r.chosenIndex === null);
					expect(losers).toHaveLength(concurrentRequests - 1);

					expect(pool.maxConcurrentCallers).toBeLessThanOrEqual(1);
				},
			),
			{ numRuns: 50 },
		);
	});

	it("mutex-enabled: saturates an N-slot pool across more than N parallel callers without double-selection", async () => {
		const accountCount = 3;
		const concurrentRequests = 8;
		const pool = createMutablePool(accountCount);

		const tasks = Array.from({ length: concurrentRequests }, () =>
			selectAndConsumeOnce(pool, "enabled"),
		);
		const results = await Promise.all(tasks);

		const winners = results
			.map((r) => r.chosenIndex)
			.filter((i): i is number => i !== null);

		// Every slot must be claimed exactly once, overflow callers see null.
		expect(winners).toHaveLength(accountCount);
		expect(new Set(winners).size).toBe(accountCount);
		expect(new Set(winners)).toEqual(new Set([0, 1, 2]));

		expect(pool.maxConcurrentCallers).toBeLessThanOrEqual(1);
	});
});
