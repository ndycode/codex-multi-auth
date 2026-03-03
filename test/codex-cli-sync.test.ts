import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageV3 } from "../lib/storage.js";
import * as codexCliState from "../lib/codex-cli/state.js";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import {
  getActiveSelectionForFamily,
  syncAccountStorageFromCodexCli,
} from "../lib/codex-cli/sync.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";

describe("codex-cli sync", () => {
  let tempDir: string;
  let accountsPath: string;
  let authPath: string;
  let configPath: string;
  let previousPath: string | undefined;
  let previousAuthPath: string | undefined;
  let previousConfigPath: string | undefined;
  let previousSync: string | undefined;
  let previousEnforceFileStore: string | undefined;

  beforeEach(async () => {
    previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
    previousAuthPath = process.env.CODEX_CLI_AUTH_PATH;
    previousConfigPath = process.env.CODEX_CLI_CONFIG_PATH;
    previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
    previousEnforceFileStore =
      process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
    tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-sync-"));
    accountsPath = join(tempDir, "accounts.json");
    authPath = join(tempDir, "auth.json");
    configPath = join(tempDir, "config.toml");
    process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
    process.env.CODEX_CLI_AUTH_PATH = authPath;
    process.env.CODEX_CLI_CONFIG_PATH = configPath;
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
    process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "1";
    clearCodexCliStateCache();
  });

  afterEach(async () => {
    clearCodexCliStateCache();
    if (previousPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
    else process.env.CODEX_CLI_ACCOUNTS_PATH = previousPath;
    if (previousAuthPath === undefined) delete process.env.CODEX_CLI_AUTH_PATH;
    else process.env.CODEX_CLI_AUTH_PATH = previousAuthPath;
    if (previousConfigPath === undefined) delete process.env.CODEX_CLI_CONFIG_PATH;
    else process.env.CODEX_CLI_CONFIG_PATH = previousConfigPath;
    if (previousSync === undefined)
      delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
    else process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
    if (previousEnforceFileStore === undefined) {
      delete process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
    } else {
      process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE =
        previousEnforceFileStore;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("merges Codex CLI accounts and sets active index", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          activeAccountId: "acc_c",
          accounts: [
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: {
                  access_token: "b.access.token",
                  refresh_token: "refresh-b",
                },
              },
            },
            {
              accountId: "acc_c",
              email: "c@example.com",
              auth: {
                tokens: {
                  access_token: "c.access.token",
                  refresh_token: "refresh-c",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
        {
          accountId: "acc_b",
          email: "b@example.com",
          refreshToken: "refresh-b-old",
          addedAt: 2,
          lastUsed: 2,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.changed).toBe(true);
    expect(result.storage?.accounts.length).toBe(3);

    const mergedB = result.storage?.accounts.find(
      (account) => account.accountId === "acc_b",
    );
    expect(mergedB?.refreshToken).toBe("refresh-b");

    const active = result.storage?.accounts[result.storage.activeIndex ?? 0];
    expect(active?.accountId).toBe("acc_c");
  });

  it("creates storage from Codex CLI accounts when local storage is missing", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              email: "a@example.com",
              active: true,
              auth: {
                tokens: {
                  access_token: "a.access.token",
                  refresh_token: "refresh-a",
                },
              },
            },
            {
              email: "b@example.com",
              auth: {
                tokens: {
                  access_token: "b.access.token",
                  refresh_token: "refresh-b",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await syncAccountStorageFromCodexCli(null);
    expect(result.changed).toBe(true);
    expect(result.storage?.accounts.length).toBe(2);
    expect(result.storage?.accounts[0]?.refreshToken).toBe("refresh-a");
    expect(result.storage?.activeIndex).toBe(0);
  });

  it("matches existing account by normalized email", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              email: "user@example.com",
              auth: {
                tokens: {
                  access_token: "new.access.token",
                  refresh_token: "refresh-new",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          email: "USER@EXAMPLE.COM",
          refreshToken: "refresh-old",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.changed).toBe(true);
    expect(result.storage?.accounts.length).toBe(1);
    expect(result.storage?.accounts[0]?.refreshToken).toBe("refresh-new");
  });

  it("returns unchanged storage when sync is disabled", async () => {
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "0";
    clearCodexCliStateCache();

    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.changed).toBe(false);
    expect(result.storage).toBe(current);
  });

  it("keeps local active selection when local write is newer than codex snapshot", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: "local.access.token",
            refresh_token: "local-refresh-token",
            account_id: "acc_a",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await setCodexCliActiveSelection({
      accountId: "acc_a",
      accessToken: "local.access.token",
      refreshToken: "local-refresh-token",
    });

    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          codexMultiAuthSyncVersion: Date.now() - 120_000,
          activeAccountId: "acc_b",
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: {
                  access_token: "a.access",
                  refresh_token: "refresh-a",
                },
              },
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: {
                  access_token: "b.access",
                  refresh_token: "refresh-b",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearCodexCliStateCache();

    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
        {
          accountId: "acc_b",
          email: "b@example.com",
          refreshToken: "refresh-b",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.storage?.activeIndex).toBe(0);
  });

  it("keeps local active selection when local state is newer by sub-second gap and syncVersion exists", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: "local.access.token",
            refresh_token: "local-refresh-token",
            account_id: "acc_a",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await setCodexCliActiveSelection({
      accountId: "acc_a",
      accessToken: "local.access.token",
      refreshToken: "local-refresh-token",
    });

    const staleSyncVersion = Date.now() - 500;
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          codexMultiAuthSyncVersion: staleSyncVersion,
          activeAccountId: "acc_b",
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: {
                  access_token: "a.access",
                  refresh_token: "refresh-a",
                },
              },
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: {
                  access_token: "b.access",
                  refresh_token: "refresh-b",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearCodexCliStateCache();

    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
        {
          accountId: "acc_b",
          email: "b@example.com",
          refreshToken: "refresh-b",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.storage?.activeIndex).toBe(0);
  });

  it("marks changed when local index normalization mutates storage while codex selection is skipped", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: "local.access.token",
            refresh_token: "local-refresh-token",
            account_id: "acc_a",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await setCodexCliActiveSelection({
      accountId: "acc_a",
      accessToken: "local.access.token",
      refreshToken: "local-refresh-token",
    });

    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          codexMultiAuthSyncVersion: Date.now() - 120_000,
          activeAccountId: "acc_b",
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: {
                  access_token: "a.access",
                  refresh_token: "refresh-a",
                },
              },
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: {
                  access_token: "b.access",
                  refresh_token: "refresh-b",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearCodexCliStateCache();

    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
        {
          accountId: "acc_b",
          email: "b@example.com",
          refreshToken: "refresh-b",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 99,
      activeIndexByFamily: { codex: 99 },
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.changed).toBe(true);
    expect(result.storage?.activeIndex).toBe(1);
    expect(result.storage?.activeIndexByFamily?.codex).toBe(1);
  });

  it("serializes concurrent active-selection writes to keep accounts/auth aligned", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: {
                  access_token: "access-a",
                  id_token: "id-a",
                  refresh_token: "refresh-a",
                },
              },
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: {
                  access_token: "access-b",
                  id_token: "id-b",
                  refresh_token: "refresh-b",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          email: "a@example.com",
          tokens: {
            access_token: "access-a",
            id_token: "id-a",
            refresh_token: "refresh-a",
            account_id: "acc_a",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const [first, second] = await Promise.all([
      setCodexCliActiveSelection({ accountId: "acc_a" }),
      setCodexCliActiveSelection({ accountId: "acc_b" }),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);

    const writtenAccounts = JSON.parse(
      await readFile(accountsPath, "utf-8"),
    ) as {
      activeAccountId?: string;
      activeEmail?: string;
      accounts?: Array<{ accountId?: string; active?: boolean }>;
    };
    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      tokens?: { account_id?: string };
    };

    expect(writtenAccounts.activeAccountId).toBe("acc_b");
    expect(writtenAccounts.activeEmail).toBe("b@example.com");
    expect(writtenAccounts.accounts?.[0]?.active).toBe(false);
    expect(writtenAccounts.accounts?.[1]?.active).toBe(true);
    expect(writtenAuth.tokens?.account_id).toBe("acc_b");
    expect(writtenAuth.email).toBe("b@example.com");
  });
  it("ignores Codex snapshots that do not include refresh tokens", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              access_token: "access-only",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await syncAccountStorageFromCodexCli(null);
    expect(result.changed).toBe(false);
    expect(result.storage?.accounts).toHaveLength(0);
    expect(result.storage?.activeIndex).toBe(0);
  });

  it("matches existing account by refresh token when accountId is absent", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              email: "updated@example.com",
              auth: {
                tokens: {
                  access_token: "new-access",
                  refresh_token: "refresh-a",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          accountIdSource: "token",
          email: "a@example.com",
          refreshToken: "refresh-a",
          accessToken: "old-access",
          enabled: true,
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.changed).toBe(true);
    expect(result.storage?.accounts[0]?.accessToken).toBe("new-access");
    expect(result.storage?.accounts[0]?.email).toBe("updated@example.com");
  });

  it("returns unchanged when Codex state and local selection are already aligned", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          activeAccountId: "acc_a",
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: {
                  access_token: "access-a",
                  refresh_token: "refresh-a",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const familyIndexes = Object.fromEntries(
      MODEL_FAMILIES.map((family) => [family, 0]),
    );
    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          accountIdSource: "token",
          email: "a@example.com",
          refreshToken: "refresh-a",
          accessToken: "access-a",
          enabled: true,
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: familyIndexes,
    };

    const result = await syncAccountStorageFromCodexCli(current);
    expect(result.changed).toBe(false);
    expect(result.storage).toEqual(current);
  });

  it("returns current storage when state loading throws", async () => {
    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const loadSpy = vi
      .spyOn(codexCliState, "loadCodexCliState")
      .mockRejectedValue(new Error("forced load failure"));

    try {
      const result = await syncAccountStorageFromCodexCli(current);
      expect(result.changed).toBe(false);
      expect(result.storage).toBe(current);
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("applies active selection using normalized email when accountId is absent", async () => {
    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
        {
          accountId: "acc_b",
          email: "b@example.com",
          refreshToken: "refresh-b",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { codex: 0 },
    };

    const loadSpy = vi
      .spyOn(codexCliState, "loadCodexCliState")
      .mockResolvedValue({
        path: "mock",
        accounts: [
          {
            accountId: "acc_a",
            email: "a@example.com",
            accessToken: "a.access.token",
            refreshToken: "refresh-a",
          },
          {
            accountId: "acc_b",
            email: "b@example.com",
            accessToken: "b.access.token",
            refreshToken: "refresh-b",
          },
        ],
        activeEmail: "  B@EXAMPLE.COM  ",
      });

    try {
      const result = await syncAccountStorageFromCodexCli(current);
      expect(result.storage?.activeIndex).toBe(1);
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("initializes family indexes when local storage omits activeIndexByFamily", async () => {
    const current: AccountStorageV3 = {
      version: 3,
      accounts: [
        {
          accountId: "acc_a",
          email: "a@example.com",
          refreshToken: "refresh-a",
          addedAt: 1,
          lastUsed: 1,
        },
        {
          accountId: "acc_b",
          email: "b@example.com",
          refreshToken: "refresh-b",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 1,
    };

    const loadSpy = vi
      .spyOn(codexCliState, "loadCodexCliState")
      .mockResolvedValue({
        path: "mock",
        accounts: [
          {
            accountId: "acc_a",
            email: "a@example.com",
            accessToken: "a.access.token",
            refreshToken: "refresh-a",
          },
        ],
        activeAccountId: "acc_a",
        syncVersion: undefined,
        sourceUpdatedAtMs: undefined,
      });

    try {
      const result = await syncAccountStorageFromCodexCli(current);
      expect(result.storage?.activeIndex).toBe(0);
      for (const family of MODEL_FAMILIES) {
        expect(result.storage?.activeIndexByFamily?.[family]).toBe(0);
      }
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("clamps and defaults active selection indexes by model family", () => {
    const family = MODEL_FAMILIES[0];
    expect(
      getActiveSelectionForFamily(
        {
          version: 3,
          accounts: [],
          activeIndex: 99,
          activeIndexByFamily: {},
        },
        family,
      ),
    ).toBe(0);

    expect(
      getActiveSelectionForFamily(
        {
          version: 3,
          accounts: [
            { refreshToken: "a", addedAt: 1, lastUsed: 1 },
            { refreshToken: "b", addedAt: 1, lastUsed: 1 },
          ],
          activeIndex: 1,
          activeIndexByFamily: { [family]: Number.NaN },
        },
        family,
      ),
    ).toBe(1);

    expect(
      getActiveSelectionForFamily(
        {
          version: 3,
          accounts: [
            { refreshToken: "a", addedAt: 1, lastUsed: 1 },
            { refreshToken: "b", addedAt: 1, lastUsed: 1 },
          ],
          activeIndex: 1,
          activeIndexByFamily: { [family]: -3 },
        },
        family,
      ),
    ).toBe(0);
  });
});
