import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";

const {
  commitPendingCodexCliSyncRunMock,
  commitCodexCliSyncRunFailureMock,
} = vi.hoisted(() => ({
  commitPendingCodexCliSyncRunMock: vi.fn(),
  commitCodexCliSyncRunFailureMock: vi.fn(),
}));

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    loadAccounts: vi.fn(),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../lib/codex-cli/sync.js", () => ({
  commitPendingCodexCliSyncRun: commitPendingCodexCliSyncRunMock,
  commitCodexCliSyncRunFailure: commitCodexCliSyncRunFailureMock,
  syncAccountStorageFromCodexCli: vi.fn(),
}));

vi.mock("../lib/codex-cli/state.js", () => ({
  loadCodexCliState: vi.fn(),
}));

vi.mock("../lib/codex-cli/writer.js", () => ({
  setCodexCliActiveSelection: vi.fn().mockResolvedValue(undefined),
}));

import { loadAccounts, saveAccounts } from "../lib/storage.js";
import { syncAccountStorageFromCodexCli } from "../lib/codex-cli/sync.js";
import { loadCodexCliState } from "../lib/codex-cli/state.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";

describe("AccountManager loadFromDisk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commitPendingCodexCliSyncRunMock.mockReset();
    commitCodexCliSyncRunFailureMock.mockReset();
    vi.mocked(loadAccounts).mockResolvedValue(null);
    vi.mocked(saveAccounts).mockResolvedValue(undefined);
    vi.mocked(syncAccountStorageFromCodexCli).mockResolvedValue({
      changed: false,
      storage: null,
      pendingRun: null,
    });
    vi.mocked(loadCodexCliState).mockResolvedValue(null);
    vi.mocked(setCodexCliActiveSelection).mockResolvedValue(undefined);
  });

  it("persists Codex CLI source-of-truth storage when sync reports change", async () => {
    const now = Date.now();
    const pendingRun = {
      revision: 1,
      run: {
        outcome: "changed" as const,
        runAt: now,
        sourcePath: "source.json",
        targetPath: "target.json",
        summary: {
          sourceAccountCount: 1,
          targetAccountCountBefore: 1,
          targetAccountCountAfter: 2,
          addedAccountCount: 1,
          updatedAccountCount: 0,
          unchangedAccountCount: 0,
          destinationOnlyPreservedCount: 1,
          selectionChanged: false,
        },
      },
    };
    const stored = {
      version: 3 as const,
      activeIndex: 0,
      accounts: [{ refreshToken: "stored-refresh", addedAt: now, lastUsed: now }],
    };
    const synced = {
      version: 3 as const,
      activeIndex: 0,
      accounts: [
        { refreshToken: "stored-refresh", addedAt: now, lastUsed: now },
        { refreshToken: "synced-refresh", addedAt: now + 1, lastUsed: now + 1 },
      ],
    };

    vi.mocked(loadAccounts).mockResolvedValue(stored);
    vi.mocked(syncAccountStorageFromCodexCli).mockResolvedValue({
      changed: true,
      storage: synced,
      pendingRun,
    });

    const manager = await AccountManager.loadFromDisk();

    expect(saveAccounts).toHaveBeenCalledWith(synced);
    expect(commitPendingCodexCliSyncRunMock).toHaveBeenCalledWith(pendingRun);
    expect(commitCodexCliSyncRunFailureMock).not.toHaveBeenCalled();
    expect(manager.getAccountCount()).toBe(2);
    expect(manager.getCurrentAccount()?.refreshToken).toBe("stored-refresh");
  });

  it("swallows source-of-truth persist failures and still returns a manager", async () => {
    const now = Date.now();
    const pendingRun = {
      revision: 2,
      run: {
        outcome: "changed" as const,
        runAt: now,
        sourcePath: "source.json",
        targetPath: "target.json",
        summary: {
          sourceAccountCount: 1,
          targetAccountCountBefore: 0,
          targetAccountCountAfter: 1,
          addedAccountCount: 1,
          updatedAccountCount: 0,
          unchangedAccountCount: 0,
          destinationOnlyPreservedCount: 0,
          selectionChanged: false,
        },
      },
    };
    const synced = {
      version: 3 as const,
      activeIndex: 0,
      accounts: [{ refreshToken: "synced-refresh", addedAt: now, lastUsed: now }],
    };

    vi.mocked(syncAccountStorageFromCodexCli).mockResolvedValue({
      changed: true,
      storage: synced,
      pendingRun,
    });
    const saveError = new Error("forced persist failure");
    vi.mocked(saveAccounts).mockRejectedValueOnce(saveError);

    const manager = await AccountManager.loadFromDisk();

    expect(commitPendingCodexCliSyncRunMock).not.toHaveBeenCalled();
    expect(commitCodexCliSyncRunFailureMock).toHaveBeenCalledWith(
      pendingRun,
      saveError,
    );
    expect(manager.getAccountCount()).toBe(1);
    expect(manager.getCurrentAccount()?.refreshToken).toBe("synced-refresh");
  });

  it("hydrates missing access/accountId fields from Codex CLI token cache", async () => {
    const now = Date.now();
    vi.mocked(loadAccounts).mockResolvedValue({
      version: 3 as const,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-1",
          email: "user@example.com",
          addedAt: now,
          lastUsed: now,
        },
      ],
    });
    vi.mocked(loadCodexCliState).mockResolvedValue({
      path: "codex-state.json",
      accounts: [
        {
          email: "USER@EXAMPLE.COM",
          accessToken: "cached-access-token",
          expiresAt: now + 120_000,
          accountId: "acct-123",
        },
      ],
    });

    const manager = await AccountManager.loadFromDisk();
    const account = manager.getCurrentAccount();

    expect(account?.access).toBe("cached-access-token");
    expect(account?.expires).toBe(now + 120_000);
    expect(account?.accountId).toBe("acct-123");
    expect(account?.accountIdSource).toBe("token");
    expect(saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("skips expired Codex CLI cache entries and does not persist", async () => {
    const now = Date.now();
    vi.mocked(loadAccounts).mockResolvedValue({
      version: 3 as const,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-1",
          email: "user@example.com",
          addedAt: now,
          lastUsed: now,
        },
      ],
    });
    vi.mocked(loadCodexCliState).mockResolvedValue({
      path: "codex-state.json",
      accounts: [
        {
          email: "user@example.com",
          accessToken: "expired-access-token",
          expiresAt: now - 1,
          accountId: "acct-expired",
        },
      ],
    });

    const manager = await AccountManager.loadFromDisk();
    const account = manager.getCurrentAccount();

    expect(account?.access).toBeUndefined();
    expect(account?.accountId).toBeUndefined();
    expect(saveAccounts).not.toHaveBeenCalled();
  });

  it("syncCodexCliActiveSelectionForIndex ignores invalid indices and syncs a valid one", async () => {
    const now = Date.now();
    const manager = new AccountManager(undefined, {
      version: 3 as const,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-1",
          accountId: "acct-1",
          email: "one@example.com",
          accessToken: "access-1",
          expiresAt: now + 10_000,
          addedAt: now,
          lastUsed: now,
        } as never,
      ],
    });

    await manager.syncCodexCliActiveSelectionForIndex(-1);
    await manager.syncCodexCliActiveSelectionForIndex(9);
    expect(setCodexCliActiveSelection).not.toHaveBeenCalled();

    await manager.syncCodexCliActiveSelectionForIndex(0);
    expect(setCodexCliActiveSelection).toHaveBeenCalledTimes(1);
    expect(setCodexCliActiveSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        email: "one@example.com",
        refreshToken: "refresh-1",
      }),
    );
  });

  it("getNextForFamily skips disabled/rate-limited/cooldown accounts", () => {
    const now = Date.now();
    const manager = new AccountManager(undefined, {
      version: 3 as const,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "disabled",
          enabled: false,
          addedAt: now,
          lastUsed: now,
        },
        {
          refreshToken: "cooldown",
          coolingDownUntil: now + 60_000,
          cooldownReason: "auth-failure",
          addedAt: now,
          lastUsed: now,
        },
        {
          refreshToken: "rate-limited",
          rateLimitResetTimes: { codex: now + 60_000 },
          addedAt: now,
          lastUsed: now,
        },
        {
          refreshToken: "available",
          addedAt: now,
          lastUsed: now,
        },
      ],
    } as never);

    const selected = manager.getNextForFamily("codex");
    expect(selected?.refreshToken).toBe("available");
  });

  it("getNextForFamily returns null when all accounts are unavailable", () => {
    const now = Date.now();
    const manager = new AccountManager(undefined, {
      version: 3 as const,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "disabled",
          enabled: false,
          addedAt: now,
          lastUsed: now,
        },
        {
          refreshToken: "cooldown",
          coolingDownUntil: now + 60_000,
          cooldownReason: "network-error",
          addedAt: now,
          lastUsed: now,
        },
      ],
    } as never);

    expect(manager.getNextForFamily("codex")).toBeNull();
  });
});
