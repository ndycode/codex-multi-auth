import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { AccountManager, ManagedAccount } from "../lib/accounts.js";

const refreshExpiringAccountsMock = vi.fn();
const applyRefreshResultMock = vi.fn();

vi.mock("../lib/proactive-refresh.js", () => ({
	refreshExpiringAccounts: refreshExpiringAccountsMock,
	applyRefreshResult: applyRefreshResultMock,
}));

function createManagedAccount(index: number): ManagedAccount {
	return {
		index,
		refreshToken: `refresh-${index}`,
		addedAt: Date.now() - 10_000,
		lastUsed: Date.now() - 5_000,
		rateLimitResetTimes: {},
		enabled: true,
	};
}

function createManagerMock(accounts: ManagedAccount[]): AccountManager {
	return {
		getAccountsSnapshot: vi.fn(() => accounts),
		getAccountByIndex: vi.fn((index: number) => accounts.find((account) => account.index === index) ?? null),
		clearAuthFailures: vi.fn(),
		markAccountCoolingDown: vi.fn(),
		saveToDiskDebounced: vi.fn(),
	} as unknown as AccountManager;
}

describe("refresh-guardian", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-26T00:00:00.000Z"));
		refreshExpiringAccountsMock.mockReset();
		applyRefreshResultMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("applies refresh outcomes and updates stats", async () => {
		const accountA = createManagedAccount(0);
		const accountB = createManagedAccount(1);
		const manager = createManagerMock([accountA, accountB]);
		const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
		const guardian = new RefreshGuardian(() => manager, { bufferMs: 60_000, intervalMs: 5_000 });

		refreshExpiringAccountsMock.mockResolvedValue(
			new Map([
				[
					0,
					{
						refreshed: true,
						reason: "success",
						tokenResult: {
							type: "success",
							access: "access-0",
							refresh: "refresh-0-new",
							expires: Date.now() + 3_600_000,
						},
					},
				],
				[
					1,
					{
						refreshed: true,
						reason: "failed",
					},
				],
			]),
		);

		await guardian.tick();

		expect(refreshExpiringAccountsMock).toHaveBeenCalledTimes(1);
		expect(applyRefreshResultMock).toHaveBeenCalledTimes(1);
		expect(applyRefreshResultMock).toHaveBeenCalledWith(
			accountA,
			expect.objectContaining({ type: "success" }),
		);
		expect((manager.clearAuthFailures as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(accountA);
		expect((manager.markAccountCoolingDown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			accountB,
			60_000,
			"auth-failure",
		);
		expect((manager.saveToDiskDebounced as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

		const stats = guardian.getStats();
		expect(stats.runs).toBe(1);
		expect(stats.refreshed).toBe(1);
		expect(stats.failed).toBe(1);
		expect(stats.lastRunAt).not.toBeNull();
	});

	it("skips overlapping tick executions", async () => {
		const accountA = createManagedAccount(0);
		const manager = createManagerMock([accountA]);
		const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
		const guardian = new RefreshGuardian(() => manager, { intervalMs: 5_000 });

		let release: (() => void) | null = null;
		const pending = new Promise<Map<number, unknown>>((resolve) => {
			release = () => resolve(new Map());
		});
		refreshExpiringAccountsMock.mockReturnValue(pending);

		const first = guardian.tick();
		const second = guardian.tick();
		expect(refreshExpiringAccountsMock).toHaveBeenCalledTimes(1);

		release?.();
		await first;
		await second;
	});

	it("runs on interval start and stops cleanly", async () => {
		const manager = createManagerMock([]);
		const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
		const guardian = new RefreshGuardian(() => manager, { intervalMs: 5_000 });
		const tickSpy = vi.spyOn(guardian, "tick").mockResolvedValue(undefined);

		guardian.start();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(tickSpy).toHaveBeenCalledTimes(1);

		guardian.stop();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(tickSpy).toHaveBeenCalledTimes(1);
	});
});

