/**
 * Routing Mutex Module (PR-N / R4)
 *
 * Provides an in-memory, promise-chain-based async mutex used to serialize
 * cursor mutation sites in the account rotation pipeline (see `lib/accounts.ts`).
 *
 * Concurrency background:
 *   The legacy rotation path reads `activeIndex` / `activeIndexByFamily`, picks
 *   a candidate, and then writes the cursor back without any lock. Two
 *   simultaneous requests can therefore (a) observe the same `activeIndex`,
 *   (b) both decide to rotate to the same candidate, and (c) race on
 *   `markSwitched` / `markAccountCoolingDown`. The resulting "lost update"
 *   window allows the same account to be chosen twice inside a single
 *   cooldown window.
 *
 * Rollout:
 *   Gated behind `PluginConfig.routingMutex` = `"legacy" | "enabled"`.
 *   Default is `"legacy"` for one full release cycle so existing users see
 *   zero behaviour change. When flipped to `"enabled"` the mutex serializes
 *   every cursor-mutation critical section through `runExclusive`.
 *
 * Non-goals:
 *   - No new runtime dependency. This file intentionally avoids importing
 *     `async-mutex` or similar npm packages.
 *   - No cross-process coordination. The pool manager is a single in-process
 *     singleton; OS-level mutexes are out of scope for this PR.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type RoutingMutexMode = "enabled" | "legacy";

/**
 * Single selection decision emitted by the rotation pipeline.
 *
 * Threaded through the fetch loop so downstream consumers (observability,
 * why-selected trace, failure-policy telemetry) can inspect *why* a
 * particular account was picked for a given request without recomputing
 * scores.
 *
 * All fields are optional except the core identity + reason + timestamp so
 * the record can be produced from both the legacy fast-path and the full
 * scoring path.
 */
export interface SelectionRecord {
	/** Index of the selected account inside the managed pool. */
	accountIndex: number;
	/** Stable account identifier (accountId, email, or runtime key). */
	accountId: string;
	/** Coarse-grained classification of why this account was selected. */
	reason: "initial" | "rotation" | "rate-limit" | "best" | "restore" | "manual";
	/** Wall-clock timestamp (ms since epoch) when the decision was made. */
	timestamp: number;
	/** Quota tracker key (e.g. `"codex"` or `"codex:gpt-5-codex"`) when scoped. */
	trackerKeyQuota?: string;
	/** Health score (0-100) used when ranking candidates. */
	health?: number;
	/** Token bucket remaining count used when ranking candidates. */
	tokens?: number;
	/** Final hybrid score used during selection. */
	score?: number;
}

/**
 * Minimal async mutex contract. Intentionally small so we can swap in a
 * different implementation (e.g. with debounced fairness) without breaking
 * callers.
 */
export interface AsyncMutex {
	/**
	 * Run `fn` while holding the mutex. The mutex is released automatically
	 * whether `fn` resolves or throws. Errors are propagated to the caller.
	 */
	runExclusive<T>(fn: () => Promise<T> | T): Promise<T>;
	/** Returns true while some critical section is executing. */
	isLocked(): boolean;
	/** Number of queued (not yet running) tasks. */
	queueLength(): number;
}

/**
 * Create a promise-chain async mutex.
 *
 * Implementation notes:
 *   - Serialization is achieved by chaining each new task onto the previous
 *     task's completion settle. Using `.catch(() => {})` on the chain head
 *     prevents a rejected task from poisoning subsequent waiters.
 *   - `runExclusive` always returns a fresh promise that resolves/rejects
 *     with the task's own result.
 *   - `isLocked` and `queueLength` are bookkeeping counters; they do not
 *     influence execution order.
 */
export function createAsyncMutex(): AsyncMutex {
	let tail: Promise<void> = Promise.resolve();
	let running = 0;
	let queued = 0;

	const runExclusive = async <T>(fn: () => Promise<T> | T): Promise<T> => {
		queued += 1;
		const previous = tail;
		let release: (() => void) | undefined;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		tail = next;
		try {
			await previous.catch(() => {
				// Swallow upstream failures; each task reports its own error
				// via the returned promise. This keeps the chain alive.
			});
			queued = Math.max(0, queued - 1);
			running += 1;
			return await fn();
		} finally {
			running = Math.max(0, running - 1);
			release?.();
		}
	};

	return {
		runExclusive,
		isLocked: () => running > 0,
		queueLength: () => queued,
	};
}

let routingMutexInstance: AsyncMutex | null = null;

/**
 * Reentrancy guard for `withRoutingMutex`.
 *
 * The underlying `runExclusive` queue is a strictly non-reentrant FIFO: a task
 * that is *already* holding the mutex and then calls `withRoutingMutex` again
 * would enqueue behind itself and deadlock (the outer task can never settle
 * because it is awaiting the inner task, which can never start because the
 * outer task still holds the lock).
 *
 * This mirrors `isStorageLockHeld` / `storageLockHeldContext` in
 * `lib/storage/transactions.ts`. When a critical section needs to span several
 * cursor mutations that each route through `withRoutingMutex` (e.g. the runtime
 * proxy holds the mutex around `chooseAccount` selection AND the later
 * `persistRuntimeActiveAccount` commit), the nested calls must run inline
 * within the already-held section instead of re-acquiring.
 */
const routingMutexHeldContext = new AsyncLocalStorage<true>();

/**
 * Reports whether the caller is already running inside a `withRoutingMutex`
 * critical section (in `"enabled"` mode). Callers that may run both standalone
 * and nested under a held mutex use this to avoid re-acquiring and deadlocking.
 */
export function isRoutingMutexHeld(): boolean {
	return routingMutexHeldContext.getStore() === true;
}

/**
 * Singleton accessor for the rotation critical-section mutex.
 *
 * Callers in `lib/accounts.ts` use this when the plugin config flag
 * `routingMutex === "enabled"`; the legacy mode bypasses the mutex entirely
 * (no wait, no allocation).
 */
export function getRoutingMutex(): AsyncMutex {
	if (!routingMutexInstance) {
		routingMutexInstance = createAsyncMutex();
	}
	return routingMutexInstance;
}

/**
 * Test-only reset so each vitest file starts from a clean mutex state.
 * Not exported through `lib/index.ts`.
 */
export function __resetRoutingMutexForTests(): void {
	routingMutexInstance = null;
}

/**
 * Run `fn` under the routing mutex when `mode === "enabled"`, otherwise run
 * it inline. Hot-path helper used by account-pool mutation sites so the
 * flag check stays O(1) per call.
 *
 * Reentrant: if the caller is already inside a held `withRoutingMutex` section
 * (`isRoutingMutexHeld()` is true), `fn` runs inline rather than re-acquiring
 * the non-reentrant FIFO queue, which would otherwise deadlock. When the lock
 * is acquired, `fn` runs inside `routingMutexHeldContext` so any nested
 * `withRoutingMutex` calls it makes are detected as reentrant.
 */
export async function withRoutingMutex<T>(
	mode: RoutingMutexMode,
	fn: () => Promise<T> | T,
): Promise<T> {
	if (mode === "enabled") {
		if (isRoutingMutexHeld()) {
			// Already inside the critical section for this async context: run
			// inline so we don't enqueue behind ourselves and deadlock.
			return await fn();
		}
		return getRoutingMutex().runExclusive(() =>
			routingMutexHeldContext.run(true, fn),
		);
	}
	return await fn();
}
