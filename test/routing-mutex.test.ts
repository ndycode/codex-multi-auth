import { describe, it, expect, afterEach } from "vitest";
import {
	createAsyncMutex,
	getRoutingMutex,
	withRoutingMutex,
	__resetRoutingMutexForTests,
	type SelectionRecord,
} from "../lib/routing-mutex.js";

describe("createAsyncMutex", () => {
	it("runExclusive serializes concurrent tasks", async () => {
		const mutex = createAsyncMutex();
		const events: string[] = [];

		const makeTask = (name: string, delayMs: number) =>
			mutex.runExclusive(async () => {
				events.push(`${name}:start`);
				await new Promise((r) => setTimeout(r, delayMs));
				events.push(`${name}:end`);
				return name;
			});

		const [a, b, c] = await Promise.all([
			makeTask("A", 10),
			makeTask("B", 5),
			makeTask("C", 1),
		]);

		// Execution must be strictly serialized: A finishes before B starts, etc.
		expect(events).toEqual([
			"A:start",
			"A:end",
			"B:start",
			"B:end",
			"C:start",
			"C:end",
		]);
		expect([a, b, c]).toEqual(["A", "B", "C"]);
	});

	it("propagates errors but keeps chain alive", async () => {
		const mutex = createAsyncMutex();

		const failing = mutex.runExclusive(async () => {
			throw new Error("boom");
		});

		await expect(failing).rejects.toThrow("boom");

		const recovered = await mutex.runExclusive(async () => "ok");
		expect(recovered).toBe("ok");
		expect(mutex.isLocked()).toBe(false);
		expect(mutex.queueLength()).toBe(0);
	});

	it("releases lock when task throws synchronously", async () => {
		const mutex = createAsyncMutex();

		const failing = mutex.runExclusive((): number => {
			throw new Error("sync-boom");
		});

		await expect(failing).rejects.toThrow("sync-boom");
		expect(mutex.isLocked()).toBe(false);

		const next = await mutex.runExclusive(() => 42);
		expect(next).toBe(42);
	});

	it("reports queue length while tasks are waiting", async () => {
		const mutex = createAsyncMutex();
		let release: (() => void) | undefined;
		const first = mutex.runExclusive(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const waiting1 = mutex.runExclusive(async () => "two");
		const waiting2 = mutex.runExclusive(async () => "three");

		// Give the chain a tick to start the first task.
		await new Promise((r) => setImmediate(r));
		expect(mutex.isLocked()).toBe(true);
		expect(mutex.queueLength()).toBeGreaterThanOrEqual(2);

		release?.();
		await first;
		expect(await waiting1).toBe("two");
		expect(await waiting2).toBe("three");
		expect(mutex.isLocked()).toBe(false);
	});
});

describe("withRoutingMutex flag gating", () => {
	afterEach(() => __resetRoutingMutexForTests());

	it("legacy mode runs inline without entering the mutex", async () => {
		let observedLocked = false;
		const result = await withRoutingMutex("legacy", () => {
			observedLocked = getRoutingMutex().isLocked();
			return "legacy-result";
		});
		expect(result).toBe("legacy-result");
		// Inline execution must not flip the shared mutex lock state.
		expect(observedLocked).toBe(false);
	});

	it("enabled mode routes through the shared mutex", async () => {
		let observedLocked = false;
		const result = await withRoutingMutex("enabled", () => {
			observedLocked = getRoutingMutex().isLocked();
			return "enabled-result";
		});
		expect(result).toBe("enabled-result");
		// While the task is running the mutex must be locked.
		expect(observedLocked).toBe(true);
	});

	it("enabled mode serializes concurrent callers", async () => {
		const order: string[] = [];
		const tasks = ["a", "b", "c", "d"].map((name) =>
			withRoutingMutex("enabled", async () => {
				order.push(`${name}:in`);
				await new Promise((r) => setTimeout(r, 1));
				order.push(`${name}:out`);
			}),
		);
		await Promise.all(tasks);
		// No interleaving: every in/out pair must be contiguous.
		for (let i = 0; i < order.length; i += 2) {
			const label = order[i]?.split(":")[0];
			expect(order[i + 1]).toBe(`${label}:out`);
		}
	});
});

describe("SelectionRecord shape", () => {
	it("accepts the minimum required fields", () => {
		const record: SelectionRecord = {
			accountIndex: 2,
			accountId: "acct_123",
			reason: "rotation",
			timestamp: Date.now(),
		};
		expect(record.accountIndex).toBe(2);
		expect(record.reason).toBe("rotation");
	});

	it("accepts the full decision payload", () => {
		const record: SelectionRecord = {
			accountIndex: 0,
			accountId: "acct_0",
			reason: "best",
			timestamp: 1_700_000_000_000,
			trackerKeyQuota: "codex:gpt-5-codex",
			health: 93,
			tokens: 48,
			score: 512,
		};
		expect(record.trackerKeyQuota).toBe("codex:gpt-5-codex");
		expect(record.score).toBe(512);
	});
});
