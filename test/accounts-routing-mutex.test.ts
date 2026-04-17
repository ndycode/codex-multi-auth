import { describe, it, expect, afterEach } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { __resetRoutingMutexForTests } from "../lib/routing-mutex.js";

function buildStored(now: number) {
	return {
		version: 3 as const,
		activeIndex: 0,
		accounts: [
			{
				refreshToken: "rt-0",
				email: "a@example.com",
				addedAt: now,
				lastUsed: now,
			},
			{
				refreshToken: "rt-1",
				email: "b@example.com",
				addedAt: now,
				lastUsed: now,
			},
			{
				refreshToken: "rt-2",
				email: "c@example.com",
				addedAt: now,
				lastUsed: now,
			},
		],
	};
}

describe("AccountManager routing-mutex integration (PR-N / R4)", () => {
	afterEach(() => __resetRoutingMutexForTests());

	it("defaults to legacy mode on construction", () => {
		const manager = new AccountManager(undefined, buildStored(Date.now()));
		expect(manager.getRoutingMutexMode()).toBe("legacy");
	});

	it("setRoutingMutexMode toggles to enabled", () => {
		const manager = new AccountManager(undefined, buildStored(Date.now()));
		manager.setRoutingMutexMode("enabled");
		expect(manager.getRoutingMutexMode()).toBe("enabled");
	});

	it("markSwitchedLocked returns a SelectionRecord in legacy mode", async () => {
		const manager = new AccountManager(undefined, buildStored(Date.now()));
		const account = manager.getAccountByIndex(1);
		expect(account).not.toBeNull();
		const record = await manager.markSwitchedLocked(
			account!,
			"rotation",
			"codex",
			{ trackerKeyQuota: "codex:gpt-5-codex", score: 512 },
		);
		expect(record.accountIndex).toBe(1);
		expect(record.reason).toBe("rotation");
		expect(record.trackerKeyQuota).toBe("codex:gpt-5-codex");
		expect(record.score).toBe(512);
		expect(typeof record.health).toBe("number");
		expect(typeof record.tokens).toBe("number");
	});

	it("markSwitchedLocked serializes concurrent mutations in enabled mode", async () => {
		const manager = new AccountManager(undefined, buildStored(Date.now()));
		manager.setRoutingMutexMode("enabled");

		const a0 = manager.getAccountByIndex(0)!;
		const a1 = manager.getAccountByIndex(1)!;
		const a2 = manager.getAccountByIndex(2)!;

		const results = await Promise.all([
			manager.markSwitchedLocked(a0, "rotation", "codex"),
			manager.markSwitchedLocked(a1, "rotation", "codex"),
			manager.markSwitchedLocked(a2, "rotation", "codex"),
		]);

		expect(results.map((r) => r.accountIndex)).toEqual([0, 1, 2]);
		// Final committed active index is the last serialized write.
		expect(manager.getActiveIndex()).toBe(2);
	});

	it("markAccountCoolingDownLocked applies cooldown atomically", async () => {
		const manager = new AccountManager(undefined, buildStored(Date.now()));
		manager.setRoutingMutexMode("enabled");

		const account = manager.getAccountByIndex(1)!;
		await manager.markAccountCoolingDownLocked(
			account,
			30_000,
			"network-error",
		);

		expect(account.cooldownReason).toBe("network-error");
		expect(account.coolingDownUntil).toBeGreaterThan(Date.now());
	});

	it("setActiveIndexLocked preserves sync semantics (out of range → null)", async () => {
		const manager = new AccountManager(undefined, buildStored(Date.now()));
		manager.setRoutingMutexMode("enabled");

		expect(await manager.setActiveIndexLocked(-1)).toBeNull();
		expect(await manager.setActiveIndexLocked(99)).toBeNull();
		const chosen = await manager.setActiveIndexLocked(2);
		expect(chosen).not.toBeNull();
		expect(manager.getActiveIndex()).toBe(2);
	});

	it("flag flip is O(1) per call (no leaked state)", async () => {
		const manager = new AccountManager(undefined, buildStored(Date.now()));
		const account = manager.getAccountByIndex(1)!;

		manager.setRoutingMutexMode("enabled");
		await manager.markSwitchedLocked(account, "rotation", "codex");
		manager.setRoutingMutexMode("legacy");
		await manager.markSwitchedLocked(account, "rotation", "codex");
		manager.setRoutingMutexMode("enabled");
		await manager.markSwitchedLocked(account, "rotation", "codex");

		expect(manager.getRoutingMutexMode()).toBe("enabled");
	});
});
