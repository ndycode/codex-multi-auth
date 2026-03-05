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
    getAccountByIndex: vi.fn(
      (index: number) =>
        accounts.find((account) => account.index === index) ?? null,
    ),
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

  it("clamps defaults, ignores duplicate start calls, and allows idempotent stop", async () => {
    const accountA = createManagedAccount(0);
    const manager = createManagerMock([accountA]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager);
    const tickSpy = vi.spyOn(guardian, "tick").mockResolvedValue(undefined);

    expect(Reflect.get(guardian, "intervalMs")).toBe(60_000);
    expect(Reflect.get(guardian, "bufferMs")).toBe(300_000);

    guardian.start();
    guardian.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    guardian.stop();
    guardian.stop();
  });

  it("returns early when manager is missing or no accounts are enabled", async () => {
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const missingManagerGuardian = new RefreshGuardian(() => null, {
      intervalMs: 5_000,
    });
    await expect(missingManagerGuardian.tick()).resolves.toBeUndefined();
    expect(missingManagerGuardian.getStats().runs).toBe(0);

    const disabledManager = createManagerMock([
      { ...createManagedAccount(0), enabled: false },
      { ...createManagedAccount(1), enabled: false },
    ]);
    const disabledGuardian = new RefreshGuardian(() => disabledManager, {
      intervalMs: 5_000,
      bufferMs: 60_000,
    });
    await expect(disabledGuardian.tick()).resolves.toBeUndefined();
    expect(refreshExpiringAccountsMock).not.toHaveBeenCalled();
    expect(disabledGuardian.getStats().runs).toBe(0);
  });

  it("records run stats when no accounts require proactive refresh", async () => {
    const accountA = createManagedAccount(0);
    const manager = createManagerMock([accountA]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      intervalMs: 5_000,
      bufferMs: 60_000,
    });

    refreshExpiringAccountsMock.mockResolvedValue(new Map());

    await guardian.tick();

    expect(
      manager.saveToDiskDebounced as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    const stats = guardian.getStats();
    expect(stats.runs).toBe(1);
    expect(stats.lastRunAt).not.toBeNull();
    expect(stats.lastTickDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.avgTickDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("applies refresh outcomes and updates stats", async () => {
    const accountA = createManagedAccount(0);
    const accountB = createManagedAccount(1);
    const manager = createManagerMock([accountA, accountB]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      bufferMs: 60_000,
      intervalMs: 5_000,
    });

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
    expect(
      manager.clearAuthFailures as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(accountA);
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(accountB, 60_000, "auth-failure");
    expect(
      manager.saveToDiskDebounced as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(1);

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
    expect(stats.lastTickDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.avgTickDurationMs).toBeGreaterThanOrEqual(0);
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
    const snapshots = [
      [originalA, originalB],
      [liveB, liveA],
    ];
    let readCount = 0;
    const manager = {
      getAccountsSnapshot: vi.fn(
        () => snapshots[Math.min(readCount++, snapshots.length - 1)],
      ),
      getAccountByIndex: vi.fn(
        (index: number) =>
          [liveB, liveA].find((account) => account.index === index) ?? null,
      ),
      clearAuthFailures: vi.fn(),
      markAccountCoolingDown: vi.fn(),
      saveToDiskDebounced: vi.fn(),
    } as unknown as AccountManager;
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      bufferMs: 60_000,
      intervalMs: 5_000,
    });

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
    expect(
      manager.clearAuthFailures as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(liveB);
  });

  it("disambiguates duplicate refresh tokens using stable account identity", async () => {
    const accountA = {
      ...createManagedAccount(0),
      refreshToken: "shared-refresh-token",
      accountId: "acc-a",
      email: "a@example.com",
    };
    const accountB = {
      ...createManagedAccount(1),
      refreshToken: "shared-refresh-token",
      accountId: "acc-b",
      email: "b@example.com",
    };
    const liveA = { ...accountA, index: 10 };
    const liveB = { ...accountB, index: 20 };
    const snapshots = [
      [accountA, accountB],
      [liveB, liveA],
    ];
    let readCount = 0;
    const manager = {
      getAccountsSnapshot: vi.fn(
        () => snapshots[Math.min(readCount++, snapshots.length - 1)],
      ),
      getAccountByIndex: vi.fn(
        (index: number) =>
          snapshots[1]?.find((account) => account.index === index) ?? null,
      ),
      clearAuthFailures: vi.fn(),
      markAccountCoolingDown: vi.fn(),
      saveToDiskDebounced: vi.fn(),
    } as unknown as AccountManager;
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      bufferMs: 60_000,
      intervalMs: 5_000,
    });

    refreshExpiringAccountsMock.mockResolvedValue(
      new Map([
        [
          0,
          {
            refreshed: true,
            reason: "success",
            tokenResult: {
              type: "success",
              access: "access-updated",
              refresh: "refresh-updated",
              expires: Date.now() + 3_600_000,
            },
          },
        ],
      ]),
    );

    await guardian.tick();

    expect(applyRefreshResultMock).toHaveBeenCalledTimes(1);
    expect(applyRefreshResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: 10, accountId: "acc-a" }),
      expect.objectContaining({ type: "success" }),
    );
    expect(applyRefreshResultMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ index: 20, accountId: "acc-b" }),
      expect.anything(),
    );
  });

  it("falls back to snapshot index for no-refresh-token outcomes", async () => {
    const accountA = {
      ...createManagedAccount(0),
      refreshToken: "",
    };
    const manager = createManagerMock([accountA]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      bufferMs: 60_000,
      intervalMs: 5_000,
    });

    refreshExpiringAccountsMock.mockResolvedValue(
      new Map([
        [
          0,
          {
            refreshed: false,
            reason: "no_refresh_token",
          },
        ],
      ]),
    );

    await guardian.tick();

    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(accountA, 60_000, "auth-failure");
    expect(
      manager.setAccountEnabled as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(0, false);
    const stats = guardian.getStats();
    expect(stats.noRefreshToken).toBe(1);
    expect(stats.authFailed).toBe(1);
  });

  it("classifies failure reasons and handles no-op branches", async () => {
    const accountA = createManagedAccount(0);
    const accountB = createManagedAccount(1);
    const accountC = createManagedAccount(2);
    const accountD = createManagedAccount(3);
    const accountE = createManagedAccount(4);
    const manager = createManagerMock([
      accountA,
      accountB,
      accountC,
      accountD,
      accountE,
    ]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      bufferMs: 60_000,
      intervalMs: 5_000,
    });

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

    expect(
      manager.setAccountEnabled as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(1, false);
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(1, accountB, 60_000, "auth-failure");
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(2, accountC, 60_000, "rate-limit");
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(3, accountD, 60_000, "network-error");
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(4, accountE, 60_000, "auth-failure");

    const stats = guardian.getStats();
    expect(stats.runs).toBe(1);
    expect(stats.refreshed).toBe(0);
    expect(stats.failed).toBe(4);
    expect(stats.notNeeded).toBe(1);
    expect(stats.noRefreshToken).toBe(1);
    expect(stats.rateLimited).toBe(1);
    expect(stats.networkFailed).toBe(1);
    expect(stats.authFailed).toBe(2);
    expect(stats.lastTickDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.avgTickDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("covers additional failure-classification and skip branches", async () => {
    const accountA = createManagedAccount(0);
    const accountB = createManagedAccount(1);
    const accountC = createManagedAccount(2);
    const accountD = createManagedAccount(3);
    const accountE = createManagedAccount(4);
    const accountF = createManagedAccount(5);
    const initialSnapshot = [
      accountA,
      accountB,
      accountC,
      accountD,
      accountE,
      accountF,
    ];
    const liveSnapshot = [accountA, accountB, accountC, accountD, accountE];
    let snapshotReads = 0;

    const manager = {
      getAccountsSnapshot: vi.fn(() => {
        if (snapshotReads === 0) {
          snapshotReads += 1;
          return initialSnapshot;
        }
        return liveSnapshot;
      }),
      getAccountByIndex: vi.fn(
        (index: number) =>
          liveSnapshot.find((account) => account.index === index) ?? null,
      ),
      clearAuthFailures: vi.fn(),
      markAccountCoolingDown: vi.fn(),
      setAccountEnabled: vi.fn(),
      saveToDiskDebounced: vi.fn(),
    } as unknown as AccountManager;
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      bufferMs: 60_000,
      intervalMs: 5_000,
    });

    refreshExpiringAccountsMock.mockResolvedValue(
      new Map([
        [
          0,
          {
            refreshed: true,
            reason: "failed",
          },
        ],
        [
          1,
          {
            refreshed: true,
            reason: "success",
            tokenResult: {
              type: "failed",
              reason: "network_error",
              message: "timeout",
            },
          },
        ],
        [
          2,
          {
            refreshed: true,
            reason: "failed",
            tokenResult: {
              type: "failed",
              reason: "missing_refresh",
              message: "missing refresh",
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
              reason: "http_error",
              statusCode: 403,
              message: "forbidden",
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
              statusCode: 500,
              message: "server error",
            },
          },
        ],
        [
          5,
          {
            refreshed: true,
            reason: "failed",
            tokenResult: {
              type: "failed",
              reason: "network_error",
              message: "unreachable account",
            },
          },
        ],
        [
          999,
          {
            refreshed: true,
            reason: "failed",
            tokenResult: {
              type: "failed",
              reason: "network_error",
              message: "unknown source account",
            },
          },
        ],
      ]),
    );

    await guardian.tick();

    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(5);
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(1, accountA, 60_000, "network-error");
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(2, accountB, 60_000, "network-error");
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(3, accountC, 60_000, "auth-failure");
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(4, accountD, 60_000, "auth-failure");
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(5, accountE, 60_000, "network-error");
    expect(
      manager.saveToDiskDebounced as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(1);

    const stats = guardian.getStats();
    expect(stats.runs).toBe(1);
    expect(stats.refreshed).toBe(0);
    expect(stats.failed).toBe(5);
    expect(stats.rateLimited).toBe(0);
    expect(stats.authFailed).toBe(2);
    expect(stats.networkFailed).toBe(3);
    expect(stats.lastTickDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.avgTickDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles thrown errors in tick and always resets running state", async () => {
    const accountA = createManagedAccount(0);
    const manager = createManagerMock([accountA]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      intervalMs: 5_000,
      bufferMs: 60_000,
    });

    refreshExpiringAccountsMock.mockRejectedValueOnce(
      new Error("refresh failed"),
    );
    await expect(guardian.tick()).resolves.toBeUndefined();
    expect(Reflect.get(guardian, "running")).toBe(false);

    refreshExpiringAccountsMock.mockRejectedValueOnce("refresh-string-failed");
    await expect(guardian.tick()).resolves.toBeUndefined();
    expect(Reflect.get(guardian, "running")).toBe(false);
  });

  it("records max tick duration for failed ticks even when runs are not counted", async () => {
    const accountA = createManagedAccount(0);
    const manager = createManagerMock([accountA]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      intervalMs: 5_000,
      bufferMs: 60_000,
    });

    const nowSpy = vi.spyOn(performance, "now");
    nowSpy
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(145)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(255);
    refreshExpiringAccountsMock.mockRejectedValueOnce(new Error("first failure"));
    refreshExpiringAccountsMock.mockRejectedValueOnce(new Error("second failure"));

    await guardian.tick();
    await guardian.tick();

    const stats = guardian.getStats();
    expect(stats.runs).toBe(0);
    expect(stats.lastTickDurationMs).toBe(55);
    expect(stats.maxTickDurationMs).toBe(55);
    expect(stats.cumulativeTickDurationMs).toBe(0);
    expect(stats.avgTickDurationMs).toBe(0);
  });

  it("tracks guardian tick duration aggregates", async () => {
    const accountA = createManagedAccount(0);
    const manager = createManagerMock([accountA]);
    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      intervalMs: 5_000,
      bufferMs: 60_000,
    });
    refreshExpiringAccountsMock.mockResolvedValue(new Map());

    const nowSpy = vi.spyOn(performance, "now");
    nowSpy
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(25)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(60);

    await guardian.tick();
    await guardian.tick();

    const stats = guardian.getStats();
    expect(stats.runs).toBe(2);
    expect(stats.lastTickDurationMs).toBe(30);
    expect(stats.maxTickDurationMs).toBe(30);
    expect(stats.cumulativeTickDurationMs).toBe(45);
    expect(stats.avgTickDurationMs).toBe(23);
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
      getAccountByIndex: vi.fn(
        (index: number) =>
          liveAfterRemoval.find((account) => account.index === index) ?? null,
      ),
      clearAuthFailures: vi.fn(),
      markAccountCoolingDown: vi.fn(),
      setAccountEnabled: vi.fn(),
      saveToDiskDebounced: vi.fn(),
    } as unknown as AccountManager;

    const { RefreshGuardian } = await import("../lib/refresh-guardian.js");
    const guardian = new RefreshGuardian(() => manager, {
      bufferMs: 60_000,
      intervalMs: 5_000,
    });

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
    expect(
      manager.markAccountCoolingDown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: originalB.refreshToken }),
      60_000,
      "rate-limit",
    );
  });
});
