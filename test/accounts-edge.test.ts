import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthAuthDetails } from "../lib/types.js";

const mockLoadAccounts = vi.fn();
const mockSaveAccounts = vi.fn();
const mockLoadCodexCliState = vi.fn();
const mockSyncAccountStorageFromCodexCli = vi.fn();
const mockSetCodexCliActiveSelection = vi.fn();
const mockSelectHybridAccount = vi.fn();

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  return {
    ...actual,
    loadAccounts: mockLoadAccounts,
    saveAccounts: mockSaveAccounts,
  };
});

vi.mock("../lib/codex-cli/state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/codex-cli/state.js")>();
  return {
    ...actual,
    loadCodexCliState: mockLoadCodexCliState,
  };
});

vi.mock("../lib/codex-cli/sync.js", () => ({
  syncAccountStorageFromCodexCli: mockSyncAccountStorageFromCodexCli,
}));

vi.mock("../lib/codex-cli/writer.js", () => ({
  setCodexCliActiveSelection: mockSetCodexCliActiveSelection,
}));

vi.mock("../lib/rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/rotation.js")>();
  return {
    ...actual,
    selectHybridAccount: mockSelectHybridAccount,
  };
});

function buildStoredAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    refreshToken: "stored-refresh",
    addedAt: Date.now() - 10_000,
    lastUsed: Date.now() - 5_000,
    ...overrides,
  };
}

function buildStored(
  accounts: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    version: 3,
    activeIndex: 0,
    accounts,
  };
}

function setPrivate(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}

function getPrivate<T>(target: object, key: string): T {
  return Reflect.get(target, key) as T;
}

async function importAccountsModule() {
  vi.resetModules();
  return import("../lib/accounts.js");
}

describe("accounts edge branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAccounts.mockResolvedValue(null);
    mockSaveAccounts.mockResolvedValue(undefined);
    mockLoadCodexCliState.mockResolvedValue(null);
    mockSyncAccountStorageFromCodexCli.mockImplementation(async (storage) => ({
      storage,
      changed: false,
    }));
    mockSetCodexCliActiveSelection.mockResolvedValue(undefined);
    mockSelectHybridAccount.mockImplementation(
      (accounts: { index: number; isAvailable: boolean }[]) => {
        const available = accounts.find((candidate) => candidate.isAvailable);
        return available ? { index: available.index } : null;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loadFromDisk tolerates sync persistence failures", async () => {
    const stored = buildStored([
      buildStoredAccount({ refreshToken: "stored-1" }),
    ]);
    mockLoadAccounts.mockResolvedValue(stored);
    mockSyncAccountStorageFromCodexCli.mockResolvedValue({
      storage: stored,
      changed: true,
    });
    mockSaveAccounts.mockRejectedValueOnce(new Error("persist failed"));
    mockLoadCodexCliState.mockResolvedValue({ accounts: [] });

    const { AccountManager } = await importAccountsModule();
    const manager = await AccountManager.loadFromDisk();

    expect(manager.getAccountCount()).toBe(1);
    expect(mockSaveAccounts).toHaveBeenCalledTimes(1);
  });

  it("hydrates from Codex CLI cache and catches save failures", async () => {
    const now = Date.now();
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-1",
        email: "match@example.com",
        accessToken: "",
        expiresAt: now - 5_000,
      }),
      buildStoredAccount({
        refreshToken: "refresh-2",
        email: "expired@example.com",
        accessToken: "existing-access",
        expiresAt: now + 120_000,
      }),
      buildStoredAccount({
        refreshToken: "refresh-3",
      }),
      buildStoredAccount({
        refreshToken: "refresh-4",
        email: "missing@example.com",
        accessToken: "existing-access",
        expiresAt: now + 120_000,
      }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    mockLoadCodexCliState.mockResolvedValue({
      accounts: [
        { email: "", accessToken: "invalid" },
        {
          email: "match@example.com",
          accessToken: "refreshed-access",
          expiresAt: now + 300_000,
          accountId: "account-from-cache",
        },
        {
          email: "expired@example.com",
          accessToken: "expired-access",
          expiresAt: now - 1,
          accountId: "expired-id",
        },
        {
          email: "no-token@example.com",
          accessToken: "",
        },
      ],
    });

    mockSaveAccounts.mockRejectedValueOnce(new Error("save failed"));

    const hydrate = getPrivate<() => Promise<void>>(
      manager as object,
      "hydrateFromCodexCli",
    );
    await hydrate.call(manager);

    const snapshot = manager.getAccountsSnapshot();
    const updated = snapshot[0];
    expect(updated?.access).toBe("refreshed-access");
    expect(updated?.accountId).toBe("account-from-cache");
    expect(updated?.accountIdSource).toBe("token");

    const expired = snapshot[1];
    expect(expired?.access).toBe("existing-access");
    expect(expired?.accountId).toBeUndefined();
  });

  it("returns early when Codex CLI state has no usable cache entries", async () => {
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-1",
        email: "user@example.com",
      }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    mockLoadCodexCliState.mockResolvedValue({
      accounts: [
        { email: "", accessToken: "x" },
        { email: "missing-token@example.com", accessToken: "" },
      ],
    });

    const hydrate = getPrivate<() => Promise<void>>(
      manager as object,
      "hydrateFromCodexCli",
    );
    await hydrate.call(manager);

    expect(mockSaveAccounts).not.toHaveBeenCalled();
  });

  it("handles invalid indices and sparse accounts for active selection sync", async () => {
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-1",
        accessToken: "access-1",
      }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    await manager.syncCodexCliActiveSelectionForIndex(Number.NaN);
    await manager.syncCodexCliActiveSelectionForIndex(-1);
    await manager.syncCodexCliActiveSelectionForIndex(99);
    expect(mockSetCodexCliActiveSelection).not.toHaveBeenCalled();

    setPrivate(manager as object, "accounts", new Array(1));
    await manager.syncCodexCliActiveSelectionForIndex(0);
    expect(mockSetCodexCliActiveSelection).not.toHaveBeenCalled();

    setPrivate(manager as object, "accounts", [
      {
        index: 0,
        refreshToken: "refresh-1",
        access: "access-1",
        expires: Date.now() + 60_000,
        addedAt: Date.now() - 10_000,
        lastUsed: Date.now() - 5_000,
        rateLimitResetTimes: {},
        enabled: true,
      },
    ]);

    await manager.syncCodexCliActiveSelectionForIndex(0);
    expect(mockSetCodexCliActiveSelection).toHaveBeenCalledTimes(1);
  });

  it("covers sparse and disabled account branches in family selectors", async () => {
    const stored = buildStored([
      buildStoredAccount({ refreshToken: "refresh-1" }),
      buildStoredAccount({ refreshToken: "refresh-2" }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    const sparseAccounts = [
      undefined,
      {
        index: 1,
        refreshToken: "refresh-2",
        enabled: false,
        addedAt: Date.now() - 10_000,
        lastUsed: Date.now() - 5_000,
        rateLimitResetTimes: {},
      },
    ];
    setPrivate(manager as object, "accounts", sparseAccounts);

    const currentByFamily = getPrivate<Record<string, number>>(
      manager as object,
      "currentAccountIndexByFamily",
    );
    const cursorByFamily = getPrivate<Record<string, number>>(
      manager as object,
      "cursorByFamily",
    );

    currentByFamily.codex = 0;
    cursorByFamily.codex = 0;

    expect(manager.getCurrentAccountForFamily("codex")).toBeNull();
    expect(manager.getCurrentOrNextForFamily("codex")).toBeNull();
    expect(manager.getNextForFamily("codex")).toBeNull();

    currentByFamily.codex = 1;
    mockSelectHybridAccount.mockReturnValueOnce(null);
    expect(manager.getCurrentOrNextForFamilyHybrid("codex")).toBeNull();

    currentByFamily.codex = 0;
    mockSelectHybridAccount.mockReturnValueOnce({ index: 999 });
    expect(manager.getCurrentOrNextForFamilyHybrid("codex")).toBeNull();
  });

  it("covers remove/set-by-index guard branches including sparse slots", async () => {
    const stored = buildStored([
      buildStoredAccount({ refreshToken: "refresh-1" }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    expect(manager.removeAccountByIndex(Number.NaN)).toBe(false);
    expect(manager.removeAccountByIndex(-1)).toBe(false);
    expect(manager.removeAccountByIndex(99)).toBe(false);

    expect(manager.setAccountEnabled(Number.NaN, true)).toBeNull();
    expect(manager.setAccountEnabled(-1, true)).toBeNull();
    expect(manager.setAccountEnabled(99, true)).toBeNull();

    setPrivate(manager as object, "accounts", new Array(1));

    expect(manager.removeAccountByIndex(0)).toBe(false);
    expect(manager.setAccountEnabled(0, true)).toBeNull();
  });

  it("saves disabled accounts and flushes an in-flight pending save", async () => {
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-1",
        enabled: false,
        accessToken: "",
      }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    await manager.saveToDisk();
    const payload = mockSaveAccounts.mock.calls[0]?.[0] as {
      accounts: Array<{ enabled?: boolean }>;
    };
    expect(payload.accounts[0]?.enabled).toBe(false);

    let resolvePending: (() => void) | null = null;
    const pendingSave = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    setPrivate(manager as object, "pendingSave", pendingSave);

    const flushPromise = manager.flushPendingSave();
    resolvePending?.();
    await flushPromise;
  });

  it("waits on pending save inside debounced save and handles non-Error failures", async () => {
    vi.useFakeTimers();
    const stored = buildStored([
      buildStoredAccount({ refreshToken: "refresh-1" }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    let resolvePending: (() => void) | null = null;
    const pendingSave = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    setPrivate(manager as object, "pendingSave", pendingSave);

    mockSaveAccounts.mockRejectedValueOnce("string-save-failure");

    manager.saveToDiskDebounced(20);
    resolvePending?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSaveAccounts).toHaveBeenCalled();
  });

  it("covers getMinWaitTimeForFamily when all accounts are disabled", async () => {
    const stored = buildStored([
      buildStoredAccount({ refreshToken: "refresh-1", enabled: false }),
      buildStoredAccount({ refreshToken: "refresh-2", enabled: false }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    expect(manager.getMinWaitTimeForFamily("codex")).toBe(0);
  });

  it("matches fallback auth by refresh token and preserves existing account id when token lacks one", async () => {
    const now = Date.now();
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-token",
        accountId: "existing-account-id",
        accountIdSource: "manual",
      }),
    ]);

    const emailPayload = Buffer.from(
      JSON.stringify({ email: "edge@example.com" }),
    ).toString("base64");
    const auth: OAuthAuthDetails = {
      type: "oauth",
      access: `header.${emailPayload}.signature`,
      refresh: "refresh-token",
      expires: now + 60_000,
    };

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(auth, stored as never);

    const account = manager.getCurrentAccount();
    expect(account?.refreshToken).toBe("refresh-token");
    expect(account?.accountId).toBe("existing-account-id");
    expect(account?.accountIdSource).toBe("manual");
    expect(account?.email).toBe("edge@example.com");
  });

  it("retries on storage conflicts and merges concurrent disk accounts", async () => {
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-local",
        email: "local@example.com",
      }),
    ]);

    const latestDisk = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-concurrent",
        email: "concurrent@example.com",
      }),
    ]);

    const conflictError = Object.assign(new Error("conflict"), {
      code: "ECONFLICT",
    });
    mockSaveAccounts
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce(undefined);
    mockLoadAccounts.mockResolvedValueOnce(latestDisk);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    await manager.saveToDisk();

    expect(mockSaveAccounts).toHaveBeenCalledTimes(2);
    const retriedPayload = mockSaveAccounts.mock.calls[1]?.[0] as {
      accounts: Array<{ refreshToken: string }>;
    };
    const refreshTokens = retriedPayload.accounts.map((account) => account.refreshToken);
    expect(refreshTokens).toContain("refresh-local");
    expect(refreshTokens).toContain("refresh-concurrent");
  });

  it("retries on transient EBUSY saves and merges concurrent disk accounts", async () => {
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-local",
        email: "local@example.com",
      }),
    ]);

    const latestDisk = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-concurrent",
        email: "concurrent@example.com",
      }),
    ]);

    const busyError = Object.assign(new Error("busy"), {
      code: "EBUSY",
    });
    mockSaveAccounts
      .mockRejectedValueOnce(busyError)
      .mockResolvedValueOnce(undefined);
    mockLoadAccounts.mockResolvedValueOnce(latestDisk);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    await manager.saveToDisk();

    expect(mockSaveAccounts).toHaveBeenCalledTimes(2);
    const retriedPayload = mockSaveAccounts.mock.calls[1]?.[0] as {
      accounts: Array<{ refreshToken: string }>;
    };
    const refreshTokens = retriedPayload.accounts.map((account) => account.refreshToken);
    expect(refreshTokens).toContain("refresh-local");
    expect(refreshTokens).toContain("refresh-concurrent");
  });

  it("preserves existing rate-limit map entries when conflict merge receives empty map", async () => {
    const now = Date.now();
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-local",
        email: "local@example.com",
        rateLimitResetTimes: { codex: now + 60_000 },
      }),
    ]);

    const latestDisk = buildStored([
      buildStoredAccount({
        refreshToken: "refresh-local",
        email: "local@example.com",
        rateLimitResetTimes: {},
      }),
    ]);

    const conflictError = Object.assign(new Error("conflict"), {
      code: "ECONFLICT",
    });
    mockSaveAccounts
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce(undefined);
    mockLoadAccounts.mockResolvedValueOnce(latestDisk);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    await manager.saveToDisk();

    const retriedPayload = mockSaveAccounts.mock.calls[1]?.[0] as {
      accounts: Array<{ refreshToken: string; rateLimitResetTimes?: Record<string, number> }>;
    };
    const mergedLocal = retriedPayload.accounts.find(
      (account) => account.refreshToken === "refresh-local",
    );
    expect(mergedLocal?.rateLimitResetTimes?.codex).toBe(now + 60_000);
  });
});
