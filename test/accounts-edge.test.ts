import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthAuthDetails } from "../lib/types.js";
import {
	createCodexCliStateMocks,
	createCodexCliSyncMocks,
	createCodexCliWriterMocks,
	createStorageMocks,
	pickMocks,
	storageAccountFixture,
} from "./helpers/cli-test-fixtures.js";

// Shared mock groups (test/helpers/cli-test-fixtures.ts); the vi.mock
// factories below resolve the helper lazily so hoisting stays safe. Storage
// and codex-cli state are narrowed to the exact set this suite used to
// override so every other export stays the actual implementation.
const storageMocks = pickMocks(createStorageMocks(), [
	"loadAccounts",
	"saveAccounts",
	"withAccountStorageTransaction",
]);
const codexCliStateMocks = pickMocks(createCodexCliStateMocks(), [
	"loadCodexCliState",
]);
const codexCliSyncMocks = createCodexCliSyncMocks();
const codexCliWriterMocks = createCodexCliWriterMocks();
// Bespoke: only this suite overrides rotation's hybrid selector on top of the
// actual module, so it stays outside the shared factories.
const mockSelectHybridAccount = vi.fn();

vi.mock("../lib/storage.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).storageModuleMock(
		storageMocks,
	),
);

vi.mock("../lib/codex-cli/state.js", async () =>
	(
		await import("./helpers/cli-test-fixtures.js")
	).codexCliStateActualModuleMock(codexCliStateMocks),
);

vi.mock("../lib/codex-cli/sync.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).codexCliSyncModuleMock(
		codexCliSyncMocks,
	),
);

vi.mock("../lib/codex-cli/writer.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).codexCliWriterModuleMock(
		codexCliWriterMocks,
	),
);

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
  // Shared minimal account fixture with this suite's historical timestamps
  // (addedAt/lastUsed offsets) preserved so ordering-sensitive branches see
  // the exact same data as before the migration.
  return storageAccountFixture({
    refreshToken: "stored-refresh",
    addedAt: Date.now() - 10_000,
    lastUsed: Date.now() - 5_000,
    ...overrides,
  });
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
    storageMocks.loadAccounts.mockResolvedValue(null);
    storageMocks.saveAccounts.mockResolvedValue(undefined);
    storageMocks.withAccountStorageTransaction.mockImplementation(async (handler) =>
      handler(null, async (storage) => {
        await storageMocks.saveAccounts(storage);
      }),
    );
    codexCliStateMocks.loadCodexCliState.mockResolvedValue(null);
    codexCliSyncMocks.syncAccountStorageFromCodexCli.mockImplementation(async (storage) => ({
      storage,
      changed: false,
    }));
    codexCliWriterMocks.setCodexCliActiveSelection.mockResolvedValue(undefined);
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
    storageMocks.loadAccounts.mockResolvedValue(stored);
    codexCliSyncMocks.syncAccountStorageFromCodexCli.mockResolvedValue({
      storage: stored,
      changed: true,
    });
    storageMocks.saveAccounts.mockRejectedValueOnce(new Error("persist failed"));
    codexCliStateMocks.loadCodexCliState.mockResolvedValue({ accounts: [] });

    const { AccountManager } = await importAccountsModule();
    const manager = await AccountManager.loadFromDisk();

    expect(manager.getAccountCount()).toBe(1);
    // Non-retryable error (no errno code) → single attempt, then debug-logged.
    expect(storageMocks.saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("loadFromDisk retries source-of-truth persist on transient EBUSY", async () => {
    const stored = buildStored([
      buildStoredAccount({ refreshToken: "stored-1" }),
    ]);
    storageMocks.loadAccounts.mockResolvedValue(stored);
    codexCliSyncMocks.syncAccountStorageFromCodexCli.mockResolvedValue({
      storage: stored,
      changed: true,
    });
    const ebusy = Object.assign(new Error("file busy"), { code: "EBUSY" });
    storageMocks.saveAccounts.mockRejectedValueOnce(ebusy);
    storageMocks.saveAccounts.mockResolvedValueOnce(undefined);
    codexCliStateMocks.loadCodexCliState.mockResolvedValue({ accounts: [] });

    const { AccountManager } = await importAccountsModule();
    const manager = await AccountManager.loadFromDisk();

    expect(manager.getAccountCount()).toBe(1);
    // First attempt EBUSY, second succeeds — retry helper should have called twice.
    expect(storageMocks.saveAccounts).toHaveBeenCalledTimes(2);
  });

  it("loadFromDisk exhausts retries on persistent EPERM and continues", async () => {
    const stored = buildStored([
      buildStoredAccount({ refreshToken: "stored-1" }),
    ]);
    storageMocks.loadAccounts.mockResolvedValue(stored);
    codexCliSyncMocks.syncAccountStorageFromCodexCli.mockResolvedValue({
      storage: stored,
      changed: true,
    });
    const eperm = Object.assign(new Error("permission denied"), {
      code: "EPERM",
    });
    storageMocks.saveAccounts.mockRejectedValue(eperm);
    codexCliStateMocks.loadCodexCliState.mockResolvedValue({ accounts: [] });

    const { AccountManager } = await importAccountsModule();
    const manager = await AccountManager.loadFromDisk();

    expect(manager.getAccountCount()).toBe(1);
    // Persistent EPERM exhausts the retry budget (initial + 3 retries = 4
    // attempts) before lib/accounts.ts catches and continues.
    expect(storageMocks.saveAccounts).toHaveBeenCalledTimes(4);
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

    codexCliStateMocks.loadCodexCliState.mockResolvedValue({
      accounts: [
        { email: "", accessToken: "invalid" },
        {
          email: "match@example.com",
          accessToken: "refreshed-access",
          expiresAt: now + 300_000,
          refreshToken: "refreshed-refresh",
          accountId: "account-from-cache",
        },
        {
          email: "expired@example.com",
          accessToken: "expired-access",
          expiresAt: now - 1,
          refreshToken: "expired-refresh-updated",
          accountId: "expired-id",
        },
        {
          email: "no-token@example.com",
          accessToken: "",
        },
      ],
    });

    storageMocks.saveAccounts.mockRejectedValueOnce(new Error("save failed"));

    const hydrate = getPrivate<() => Promise<void>>(
      manager as object,
      "hydrateFromCodexCli",
    );
    await hydrate.call(manager);

    const snapshot = manager.getAccountsSnapshot();
    const updated = snapshot[0];
    expect(updated?.access).toBe("refreshed-access");
    expect(updated?.refreshToken).toBe("refresh-1");
    expect(updated?.accountId).toBe("account-from-cache");
    expect(updated?.accountIdSource).toBe("token");

    const expired = snapshot[1];
    expect(expired?.access).toBe("existing-access");
    expect(expired?.refreshToken).toBe("refresh-2");
    expect(expired?.accountId).toBeUndefined();
    expect(expired?.accountIdSource).toBeUndefined();
  });

  it("does not overwrite a local refresh token with a stale usable CLI cache token", async () => {
    const now = Date.now();
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "local-refresh-new",
        email: "match@example.com",
        accessToken: "local-access",
        expiresAt: now + 120_000,
      }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);

    codexCliStateMocks.loadCodexCliState.mockResolvedValue({
      sourceUpdatedAtMs: now - 60_000,
      accounts: [
        {
          email: "match@example.com",
          accessToken: "cached-access-old",
          expiresAt: now + 300_000,
          refreshToken: "cached-refresh-old",
        },
      ],
    });

    const hydrate = getPrivate<() => Promise<void>>(
      manager as object,
      "hydrateFromCodexCli",
    );
    await hydrate.call(manager);

    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot[0]?.refreshToken).toBe("local-refresh-new");
    expect(snapshot[0]?.access).toBe("local-access");
    expect(storageMocks.saveAccounts).not.toHaveBeenCalled();
  });

  it("does not hydrate from an expired CLI cache entry", async () => {
    const now = Date.now();
    const stored = buildStored([
      buildStoredAccount({
        refreshToken: "local-refresh-placeholder",
        email: "expired@example.com",
        accessToken: "local-access",
        expiresAt: now + 120_000,
      }),
    ]);

    const { AccountManager } = await importAccountsModule();
    const manager = new AccountManager(undefined, stored as never);
    const account = manager.getAccountByIndex(0)!;
    account.refreshToken = "";

    codexCliStateMocks.loadCodexCliState.mockResolvedValue({
      sourceUpdatedAtMs: now - 60_000,
      accounts: [
        {
          email: "expired@example.com",
          accessToken: "cached-access-old",
          expiresAt: now - 1,
          refreshToken: "cached-refresh-restored",
          accountId: "expired-account-id",
        },
      ],
    });

    const hydrate = getPrivate<() => Promise<void>>(
      manager as object,
      "hydrateFromCodexCli",
    );
    await hydrate.call(manager);

    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot[0]?.refreshToken).toBe("");
    expect(snapshot[0]?.access).toBe("local-access");
    expect(snapshot[0]?.accountId).toBeUndefined();
    expect(storageMocks.saveAccounts).not.toHaveBeenCalled();
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

    codexCliStateMocks.loadCodexCliState.mockResolvedValue({
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

    expect(storageMocks.saveAccounts).not.toHaveBeenCalled();
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
    expect(codexCliWriterMocks.setCodexCliActiveSelection).not.toHaveBeenCalled();

    setPrivate(manager as object, "accounts", new Array(1));
    await manager.syncCodexCliActiveSelectionForIndex(0);
    expect(codexCliWriterMocks.setCodexCliActiveSelection).not.toHaveBeenCalled();

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
    expect(codexCliWriterMocks.setCodexCliActiveSelection).toHaveBeenCalledTimes(1);
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
    const payload = storageMocks.saveAccounts.mock.calls[0]?.[0] as {
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

    storageMocks.saveAccounts.mockRejectedValueOnce("string-save-failure");

    manager.saveToDiskDebounced(20);
    resolvePending?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(storageMocks.saveAccounts).toHaveBeenCalled();
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
});
