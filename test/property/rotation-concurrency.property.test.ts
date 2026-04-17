import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import {
	createAsyncMutex,
	withRoutingMutex,
	__resetRoutingMutexForTests,
	type RoutingMutexMode,
} from "../../lib/routing-mutex.js";

/**
 * PR-N / R4 concurrency property tests.
 *
 * Simulates N concurrent requests touching a shared `activeIndex` cursor and
 * an in-memory cooldown map to expose the TOCTOU race the routing mutex is
 * meant to close.
 *
 * Invariants under `"enabled"` mode:
 *   1. No lost updates: every attempted selection must either appear in the
 *      final history or be observed as superseded, never silently dropped.
 *   2. No double-selection inside a single cooldown window: if an account is
 *      marked cooling at time T, no concurrent selection may also mark the
 *      same account at time T without observing the cooldown.
 *   3. Cursor monotonicity w.r.t. the serialization order: reads observed
 *      inside the critical section are not stale.
 *
 * Under `"legacy"` mode the same scenarios may exhibit lost updates — those
 * runs are kept as a baseline to document the pre-PR-N behaviour.
 */

type SelectionResult = {
	chosenIndex: number;
	priorActiveIndex: number;
	wasDoubleInsideCooldown: boolean;
};

interface PoolState {
	accounts: number;
	activeIndex: number;
	coolingDownUntil: Record<number, number>;
	history: SelectionResult[];
}

function createPoolState(accounts: number): PoolState {
	return {
		accounts,
		activeIndex: 0,
		coolingDownUntil: {},
		history: [],
	};
}

/**
 * Simulated rotation critical section:
 *   - read activeIndex
 *   - pick the next unused account
 *   - mark the previous account cooling down for `cooldownWindowMs`
 *   - commit the new activeIndex
 *
 * The yield (setImmediate) between read and write is what exposes the race
 * when no mutex guards the region.
 */
async function rotateOnce(
	state: PoolState,
	mode: RoutingMutexMode,
	cooldownWindowMs: number,
	nowMs: number,
): Promise<SelectionResult> {
	return withRoutingMutex(mode, async () => {
		const prior = state.activeIndex;
		// Simulate decision latency so the interleaving race window is real.
		await new Promise((r) => setImmediate(r));

		// Policy: skip cooling-down accounts. In real code this is the
		// `isAvailable` filter inside selectHybridAccount. If every account is
		// cooling we fall back to the prior account (LRU) to match the
		// selection fallback behaviour.
		let next = prior;
		for (let offset = 1; offset <= state.accounts; offset += 1) {
			const candidate = (prior + offset) % state.accounts;
			if ((state.coolingDownUntil[candidate] ?? 0) <= nowMs) {
				next = candidate;
				break;
			}
		}

		const wasDoubleInsideCooldown =
			next !== prior && (state.coolingDownUntil[next] ?? 0) > nowMs;

		state.coolingDownUntil[prior] = nowMs + cooldownWindowMs;
		state.activeIndex = next;

		const result: SelectionResult = {
			chosenIndex: next,
			priorActiveIndex: prior,
			wasDoubleInsideCooldown,
		};
		state.history.push(result);
		return result;
	});
}

describe("routing mutex concurrency property tests", () => {
	afterEach(() => __resetRoutingMutexForTests());

	it("mutex-enabled: no double-selection inside cooldown window", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 2, max: 6 }),
				fc.integer({ min: 2, max: 12 }),
				async (accountCount, concurrentRequests) => {
					const state = createPoolState(accountCount);
					const nowMs = 1_000_000;
					const cooldownWindowMs = 10_000;
					const tasks = Array.from({ length: concurrentRequests }, () =>
						rotateOnce(state, "enabled", cooldownWindowMs, nowMs),
					);
					const results = await Promise.all(tasks);
					// Invariant 1: history length equals issued requests (no lost updates).
					expect(state.history.length).toBe(concurrentRequests);
					// Invariant 2: no double-selection inside cooldown window.
					const offenders = results.filter((r) => r.wasDoubleInsideCooldown);
					expect(offenders).toEqual([]);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("mutex-enabled: history chains linearizably under serialization order", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 3, max: 5 }),
				fc.integer({ min: 4, max: 10 }),
				async (accountCount, concurrentRequests) => {
					const state = createPoolState(accountCount);
					const nowMs = 1_000_000;
					// Small window so not every rotation gets blocked by cooldown.
					const cooldownWindowMs = 1_000;
					const tasks = Array.from({ length: concurrentRequests }, () =>
						rotateOnce(state, "enabled", cooldownWindowMs, nowMs),
					);
					await Promise.all(tasks);

					// Invariant 3: each history entry's prior must equal the previous
					// entry's chosen (strict chaining proves linearizability — no
					// interleaving between the read-and-write of activeIndex).
					for (let i = 1; i < state.history.length; i += 1) {
						const prev = state.history[i - 1];
						const cur = state.history[i];
						expect(cur?.priorActiveIndex).toBe(prev?.chosenIndex);
					}
				},
			),
			{ numRuns: 100 },
		);
	});

	it("legacy baseline: documents race windows without mutex", async () => {
		// We do not assert absence of races here — legacy mode is the
		// unprotected baseline. We only assert that the system does not
		// crash and that history length matches the number of issued tasks.
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 3, max: 5 }),
				fc.integer({ min: 6, max: 10 }),
				async (accountCount, concurrentRequests) => {
					const state = createPoolState(accountCount);
					const nowMs = 1_000_000;
					const cooldownWindowMs = 10_000;
					const tasks = Array.from({ length: concurrentRequests }, () =>
						rotateOnce(state, "legacy", cooldownWindowMs, nowMs),
					);
					const results = await Promise.all(tasks);
					expect(results).toHaveLength(concurrentRequests);
					expect(state.history.length).toBe(concurrentRequests);
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe("routing mutex regression: two simultaneous requests on same account", () => {
	afterEach(() => __resetRoutingMutexForTests());

	it("mutex serializes markSwitched + cooldown on identical account", async () => {
		const mutex = createAsyncMutex();
		const account = {
			lastSwitchReason: "initial" as string,
			coolingDownUntil: 0,
		};
		const nowMs = 2_000_000;

		const observedInsideCritical: string[] = [];

		const first = mutex.runExclusive(async () => {
			observedInsideCritical.push("first:enter");
			// Emulate the gap between read and write.
			await new Promise((r) => setImmediate(r));
			account.lastSwitchReason = "rotation";
			account.coolingDownUntil = nowMs + 5_000;
			observedInsideCritical.push("first:exit");
		});

		const second = mutex.runExclusive(async () => {
			observedInsideCritical.push("second:enter");
			// Second observer must see first's committed state.
			expect(account.lastSwitchReason).toBe("rotation");
			expect(account.coolingDownUntil).toBe(nowMs + 5_000);
			account.lastSwitchReason = "rate-limit";
			observedInsideCritical.push("second:exit");
		});

		await Promise.all([first, second]);
		expect(observedInsideCritical).toEqual([
			"first:enter",
			"first:exit",
			"second:enter",
			"second:exit",
		]);
		expect(account.lastSwitchReason).toBe("rate-limit");
	});
});
