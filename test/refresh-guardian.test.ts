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
		setAccountEnabled: vi.fn(),
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
						tokenResult: {
							type: "failed",
							reason: "invalid_response",
							message: "invalid payload",
						},
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
		expect(stats.authFailed).toBe(1);
		expect(stats.networkFailed).toBe(0);
		expect(stats.rateLimited).toBe(0);
		expect(stats.notNeeded).toBe(0);
		expect(stats.noRefreshToken).toBe(0);
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

	it("resolves refreshed account using stable refresh token when indices shift", async () => {
		const originalA = createManagedAccount(0);
		const originalB = createManagedAccount(1);
		const liveB = { ...originalB, index: 0 };
		const liveA = { ...originalA, index: 1 };
		const snapshots = [[originalA, originalB], [liveB, liveA]];
		let readCount = 0;
		const manager = {
			getAccountsSnapshot: vi.fn(() => snapshots[Math.min(readCount++, snapshots.length - 1)]),
			getAccountByIndex: vi.fn((index: number) => [liveB, liveA].find((account) => account.index === index) ?? null),
			clearAuthFailures: vi.fn(),
			markAccountCoolingDown: vi.fn(),
			saveToDiskDebounced: vi.fn(),
		} as unknown as AccountManager;
		const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
		const guardian = new RefreshGuardian(() => manager, { bufferMs: 60_000, intervalMs: 5_000 });

		refreshExpiringAccountsMock.mockResolvedValue(
			new Map([
				[
					1,
					{
						refreshed: true,
						reason: "success",
						tokenResult: {
							type: "success",
							access: "access-shifted",
							refresh: "refresh-shifted",
							expires: Date.now() + 3_600_000,
						},
					},
				],
			]),
		);

		await guardian.tick();

		expect(applyRefreshResultMock).toHaveBeenCalledTimes(1);
		expect(applyRefreshResultMock).toHaveBeenCalledWith(
			liveB,
			expect.objectContaining({ type: "success" }),
		);
		expect((manager.clearAuthFailures as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(liveB);
	});

	it("classifies failure reasons and handles no-op branches", async () => {
		const accountA = createManagedAccount(0);
		const accountB = createManagedAccount(1);
		const accountC = createManagedAccount(2);
		const accountD = createManagedAccount(3);
		const accountE = createManagedAccount(4);
		const manager = createManagerMock([accountA, accountB, accountC, accountD, accountE]);
		const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
		const guardian = new RefreshGuardian(() => manager, { bufferMs: 60_000, intervalMs: 5_000 });

		refreshExpiringAccountsMock.mockResolvedValue(
			new Map([
				[0, { refreshed: false, reason: "not_needed" }],
				[1, { refreshed: false, reason: "no_refresh_token" }],
				[
					2,
					{
						refreshed: true,
						reason: "failed",
						tokenResult: {
							type: "failed",
							reason: "http_error",
							statusCode: 429,
							message: "rate limited",
						},
					},
				],
				[
					3,
					{
						refreshed: true,
						reason: "failed",
						tokenResult: {
							type: "failed",
							reason: "network_error",
							message: "timeout",
						},
					},
				],
				[
					4,
					{
						refreshed: true,
						reason: "failed",
						tokenResult: {
							type: "failed",
							reason: "http_error",
							statusCode: 401,
							message: "expired",
						},
					},
				],
			]),
		);

		await guardian.tick();

		expect((manager.setAccountEnabled as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(1, false);
		expect((manager.markAccountCoolingDown as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(
			1,
			accountB,
			60_000,
			"auth-failure",
		);
		expect((manager.markAccountCoolingDown as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(
			2,
			accountC,
			60_000,
			"rate-limit",
		);
		expect((manager.markAccountCoolingDown as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(
			3,
			accountD,
			60_000,
			"network-error",
		);
		expect((manager.markAccountCoolingDown as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(
			4,
			accountE,
			60_000,
			"auth-failure",
		);

		const stats = guardian.getStats();
		expect(stats.runs).toBe(1);
		expect(stats.refreshed).toBe(0);
		expect(stats.failed).toBe(4);
		expect(stats.notNeeded).toBe(1);
		expect(stats.noRefreshToken).toBe(1);
		expect(stats.rateLimited).toBe(1);
		expect(stats.networkFailed).toBe(1);
		expect(stats.authFailed).toBe(2);
	});

	it("handles account removal during tick without throwing", async () => {
		const originalA = createManagedAccount(0);
		const originalB = createManagedAccount(1);
		const liveAfterRemoval = [{ ...originalB }];
		let snapshotReads = 0;

		const manager = {
			getAccountsSnapshot: vi.fn(() => {
				snapshotReads += 1;
				if (snapshotReads === 1) return [originalA, originalB];
				return liveAfterRemoval;
			}),
			getAccountByIndex: vi.fn((index: number) => liveAfterRemoval[index] ?? null),
			clearAuthFailures: vi.fn(),
			markAccountCoolingDown: vi.fn(),
			setAccountEnabled: vi.fn(),
			saveToDiskDebounced: vi.fn(),
		} as unknown as AccountManager;

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
							access: "removed-access",
							refresh: "removed-refresh",
							expires: Date.now() + 3_600_000,
						},
					},
				],
				[
					1,
					{
						refreshed: true,
						reason: "failed",
						tokenResult: {
							type: "failed",
							reason: "http_error",
							statusCode: 429,
							message: "rate limit",
						},
					},
				],
			]),
		);

		await expect(guardian.tick()).resolves.toBeUndefined();
		expect(applyRefreshResultMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ refreshToken: originalA.refreshToken }),
			expect.anything(),
		);
		expect((manager.markAccountCoolingDown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			expect.objectContaining({ refreshToken: originalB.refreshToken }),
			60_000,
			"rate-limit",
		);
	});
});

