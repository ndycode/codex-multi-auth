import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";

// Shared mock groups (test/helpers/cli-test-fixtures.ts). This suite imports
// the module under test statically, so the mocked-module factories run while
// the imports above evaluate — the groups must be created inside vi.hoisted
// (which also resolves the helper itself) rather than in module-level consts.
// Storage is narrowed to the exact set this suite used to override so every
// other storage export stays the actual implementation.
const {
	storageMocks,
	codexCliStateMocks,
	codexCliSyncMocks,
	codexCliWriterMocks,
} = await vi.hoisted(async () => {
	const fixtures = await import("./helpers/cli-test-fixtures.js");
	return {
		storageMocks: fixtures.pickMocks(fixtures.createStorageMocks(), [
			"loadAccounts",
			"saveAccounts",
			"withAccountStorageTransaction",
		]),
		codexCliStateMocks: fixtures.createCodexCliStateMocks(),
		codexCliSyncMocks: fixtures.createCodexCliSyncMocks(),
		codexCliWriterMocks: fixtures.createCodexCliWriterMocks(),
	};
});

vi.mock("../lib/storage.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).storageModuleMock(
		storageMocks,
	),
);

vi.mock("../lib/codex-cli/sync.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).codexCliSyncModuleMock(
		codexCliSyncMocks,
	),
);

vi.mock("../lib/codex-cli/state.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).codexCliStateModuleMock(
		codexCliStateMocks,
	),
);

vi.mock("../lib/codex-cli/writer.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).codexCliWriterModuleMock(
		codexCliWriterMocks,
	),
);

describe("AccountManager loadFromDisk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.loadAccounts.mockResolvedValue(null);
    storageMocks.saveAccounts.mockResolvedValue(undefined);
    storageMocks.withAccountStorageTransaction.mockImplementation(
      async (handler) =>
        handler(null, async (storage) => {
          await storageMocks.saveAccounts(storage);
        }),
    );
    codexCliSyncMocks.syncAccountStorageFromCodexCli.mockResolvedValue({
      changed: false,
      storage: null,
    });
    codexCliStateMocks.loadCodexCliState.mockResolvedValue(null);
    codexCliWriterMocks.setCodexCliActiveSelection.mockResolvedValue(undefined);
  });

  it("persists Codex CLI source-of-truth storage when sync reports change", async () => {
    const now = Date.now();
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

    storageMocks.loadAccounts.mockResolvedValue(stored);
    codexCliSyncMocks.syncAccountStorageFromCodexCli.mockResolvedValue({
      changed: true,
      storage: synced,
    });

    const manager = await AccountManager.loadFromDisk();

    expect(storageMocks.saveAccounts).toHaveBeenCalledWith(synced);
    expect(manager.getAccountCount()).toBe(2);
    expect(manager.getCurrentAccount()?.refreshToken).toBe("stored-refresh");
  });

  it("swallows source-of-truth persist failures and still returns a manager", async () => {
    const now = Date.now();
    const synced = {
      version: 3 as const,
      activeIndex: 0,
      accounts: [{ refreshToken: "synced-refresh", addedAt: now, lastUsed: now }],
    };

    codexCliSyncMocks.syncAccountStorageFromCodexCli.mockResolvedValue({
      changed: true,
      storage: synced,
    });
    storageMocks.saveAccounts.mockRejectedValueOnce(new Error("forced persist failure"));

    const manager = await AccountManager.loadFromDisk();

    expect(manager.getAccountCount()).toBe(1);
    expect(manager.getCurrentAccount()?.refreshToken).toBe("synced-refresh");
  });

  it("hydrates missing access/accountId fields from Codex CLI token cache", async () => {
    const now = Date.now();
    storageMocks.loadAccounts.mockResolvedValue({
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
    codexCliStateMocks.loadCodexCliState.mockResolvedValue({
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
    expect(storageMocks.saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("ignores expired Codex CLI cache entries entirely", async () => {
    const now = Date.now();
    storageMocks.loadAccounts.mockResolvedValue({
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
    codexCliStateMocks.loadCodexCliState.mockResolvedValue({
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
    expect(account?.accountIdSource).toBeUndefined();
    expect(storageMocks.saveAccounts).not.toHaveBeenCalled();
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
    expect(
      codexCliWriterMocks.setCodexCliActiveSelection,
    ).not.toHaveBeenCalled();

    await manager.syncCodexCliActiveSelectionForIndex(0);
    expect(
      codexCliWriterMocks.setCodexCliActiveSelection,
    ).toHaveBeenCalledTimes(1);
    expect(codexCliWriterMocks.setCodexCliActiveSelection).toHaveBeenCalledWith(
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

  it("getNextForFamily falls back to stale accounts when no fresh option exists", () => {
    const now = Date.now();
    const manager = new AccountManager(undefined, {
      version: 3 as const,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "stale-1",
          accessToken: "access-1",
          expiresAt: now + 60_000,
          addedAt: now,
          lastUsed: now,
        },
        {
          refreshToken: "stale-2",
          accessToken: "access-2",
          expiresAt: now + 120_000,
          addedAt: now,
          lastUsed: now - 5_000,
        },
      ],
    } as never);

    const selected = manager.getNextForFamily("codex");
    expect(selected?.refreshToken).toBe("stale-1");
  });

  it("getNextForFamily follows cursor order instead of access-token freshness", () => {
    const now = Date.now();
    const manager = new AccountManager(undefined, {
      version: 3 as const,
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
      accounts: [
        {
          refreshToken: "stale-1",
          accessToken: "access-1",
          expiresAt: now + 60_000,
          addedAt: now,
          lastUsed: now,
        },
        {
          refreshToken: "token-fresh",
          accessToken: "access-fresh",
          expiresAt: now + 10 * 60_000,
          addedAt: now,
          lastUsed: now - 5_000,
        },
      ],
    } as never);

    const selected = manager.getNextForFamily("codex");
    expect(selected?.refreshToken).toBe("stale-1");
  });
});
