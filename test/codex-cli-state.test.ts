import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCodexCliWarningCacheForTests,
  clearCodexCliStateCache,
  isCodexCliSyncEnabled,
  loadCodexCliState,
  lookupCodexCliTokensByEmail,
} from "../lib/codex-cli/state.js";
import {
  getCodexCliMetricsSnapshot,
  resetCodexCliMetricsForTests,
} from "../lib/codex-cli/observability.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
describe("codex-cli state", () => {
  let tempDir: string;
  let accountsPath: string;
  let authPath: string;
  let configPath: string;
  let previousPath: string | undefined;
  let previousAuthPath: string | undefined;
  let previousConfigPath: string | undefined;
  let previousSync: string | undefined;
  let previousLegacySync: string | undefined;
  let previousEnforceFileStore: string | undefined;
  beforeEach(async () => {
    previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
    previousAuthPath = process.env.CODEX_CLI_AUTH_PATH;
    previousConfigPath = process.env.CODEX_CLI_CONFIG_PATH;
    previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
    previousLegacySync = process.env.CODEX_AUTH_SYNC_CODEX_CLI;
    previousEnforceFileStore =
      process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
    tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-state-"));
    accountsPath = join(tempDir, "accounts.json");
    authPath = join(tempDir, "auth.json");
    configPath = join(tempDir, "config.toml");
    process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
    process.env.CODEX_CLI_AUTH_PATH = authPath;
    process.env.CODEX_CLI_CONFIG_PATH = configPath;
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
    process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "1";
    delete process.env.CODEX_AUTH_SYNC_CODEX_CLI;
    clearCodexCliStateCache();
    __resetCodexCliWarningCacheForTests();
    resetCodexCliMetricsForTests();
  });
  afterEach(async () => {
    clearCodexCliStateCache();
    __resetCodexCliWarningCacheForTests();
    if (previousPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
    else process.env.CODEX_CLI_ACCOUNTS_PATH = previousPath;
    if (previousAuthPath === undefined) delete process.env.CODEX_CLI_AUTH_PATH;
    else process.env.CODEX_CLI_AUTH_PATH = previousAuthPath;
    if (previousConfigPath === undefined) delete process.env.CODEX_CLI_CONFIG_PATH;
    else process.env.CODEX_CLI_CONFIG_PATH = previousConfigPath;
    if (previousSync === undefined)
      delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
    else process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
    if (previousLegacySync === undefined)
      delete process.env.CODEX_AUTH_SYNC_CODEX_CLI;
    else process.env.CODEX_AUTH_SYNC_CODEX_CLI = previousLegacySync;
    if (previousEnforceFileStore === undefined) {
      delete process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
    } else {
      process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE =
        previousEnforceFileStore;
    }
    resetCodexCliMetricsForTests();
    await rm(tempDir, { recursive: true, force: true });
  });
  it("loads Codex CLI accounts and active selection", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          codexMultiAuthSyncVersion: 123456,
          activeAccountId: "acc_b",
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: { access_token: "x.y.z", refresh_token: "refresh-b" },
              },
              active: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state?.activeAccountId).toBe("acc_b");
    expect(state?.accounts.length).toBe(2);
    expect(state?.syncVersion).toBe(123456);
    expect(typeof state?.sourceUpdatedAtMs).toBe("number");
    const lookup = await lookupCodexCliTokensByEmail("B@EXAMPLE.com");
    expect(lookup?.refreshToken).toBe("refresh-b");
    expect(lookup?.accountId).toBe("acc_b");
  });
  it("coalesces concurrent cache-miss loads into one file read", async () => {
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
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
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
    const readSpy = vi.spyOn(fsPromises, "readFile");
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => loadCodexCliState()),
      );
      expect(results.every((state) => state?.activeAccountId === "acc_a")).toBe(
        true,
      );
      const accountReads = readSpy.mock.calls.filter(
        (args) => String(args[0]) === accountsPath,
      );
      expect(accountReads.length).toBe(1);
    } finally {
      readSpy.mockRestore();
    }
  });
  it("retries transient read/stat lock errors before failing", async () => {
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
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
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
    const realReadFile = fsPromises.readFile.bind(fsPromises);
    const realStat = fsPromises.stat.bind(fsPromises);
    let accountsReadAttempts = 0;
    let accountsStatAttempts = 0;
    const readSpy = vi.spyOn(fsPromises, "readFile");
    const statSpy = vi.spyOn(fsPromises, "stat");
    readSpy.mockImplementation(async (...args) => {
      if (String(args[0]) === accountsPath) {
        accountsReadAttempts += 1;
        if (accountsReadAttempts === 1) {
          const error = new Error("locked") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      }
      return realReadFile(...args);
    });
    statSpy.mockImplementation(async (...args) => {
      if (String(args[0]) === accountsPath) {
        accountsStatAttempts += 1;
        if (accountsStatAttempts === 1) {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
      }
      return realStat(...args);
    });
    try {
      const state = await loadCodexCliState({ forceRefresh: true });
      expect(state?.accounts[0]?.accountId).toBe("acc_a");
      expect(accountsReadAttempts).toBe(2);
      expect(accountsStatAttempts).toBe(2);
    } finally {
      readSpy.mockRestore();
      statSpy.mockRestore();
    }
  });
  it("falls back to Codex auth.json when accounts.json is missing", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token:
              "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NfYXV0aCJ9LCJlbWFpbCI6ImF1dGhAZXhhbXBsZS5jb20ifQ.",
            refresh_token: "refresh-auth",
            account_id: "acc_auth",
          },
          last_refresh: "2026-02-25T21:36:07.864Z",
        },
        null,
        2,
      ),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state?.path).toBe(authPath);
    expect(state?.accounts.length).toBe(1);
    expect(state?.activeAccountId).toBe("acc_auth");
    expect(state?.activeEmail).toBe("auth@example.com");
    const lookup = await lookupCodexCliTokensByEmail("AUTH@EXAMPLE.COM");
    expect(lookup?.refreshToken).toBe("refresh-auth");
    expect(lookup?.accountId).toBe("acc_auth");
  });
  it("falls back to auth.json when accounts.json is malformed", async () => {
    await writeFile(accountsPath, "{ malformed json", "utf-8");
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token:
              "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NfYXV0aCJ9LCJlbWFpbCI6ImF1dGhAZXhhbXBsZS5jb20ifQ.",
            refresh_token: "refresh-auth",
            account_id: "acc_auth",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state?.path).toBe(authPath);
    expect(state?.activeAccountId).toBe("acc_auth");
    expect(state?.accounts.length).toBe(1);
  });
  it("derives active selection from per-account active flag", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              active: true,
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state?.accounts[0]?.accountId).toBe("acc_a");
    expect(state?.activeEmail).toBe("a@example.com");
  });
  it("returns null for malformed Codex CLI payload", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify({ accounts: { accountId: "acc_a" } }, null, 2),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state).toBeNull();
  });
  it("returns null when sync is disabled", async () => {
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "0";
    clearCodexCliStateCache();
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state).toBeNull();
    const lookup = await lookupCodexCliTokensByEmail("a@example.com");
    expect(lookup).toBeNull();
  });
  it("prefers modern sync env over legacy env", () => {
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
    process.env.CODEX_AUTH_SYNC_CODEX_CLI = "0";
    expect(isCodexCliSyncEnabled()).toBe(true);
  });
  it("tracks read/write metrics counters", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await loadCodexCliState({ forceRefresh: true });
    await setCodexCliActiveSelection({ accountId: "acc_a" });
    const metrics = getCodexCliMetricsSnapshot();
    expect(metrics.readAttempts).toBeGreaterThan(0);
    expect(metrics.readSuccesses).toBeGreaterThan(0);
    expect(metrics.writeAttempts).toBeGreaterThan(0);
    expect(metrics.writeSuccesses).toBeGreaterThan(0);
  });
  it("persists active selection back to Codex CLI state", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: { access_token: "x.y.z", refresh_token: "refresh-b" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({ accountId: "acc_b" });
    expect(updated).toBe(true);
    const written = JSON.parse(await readFile(accountsPath, "utf-8")) as {
      activeAccountId?: string;
      accounts?: Array<{ active?: boolean }>;
    };
    expect(written.activeAccountId).toBe("acc_b");
    expect(written.accounts?.[0]?.active).toBe(false);
    expect(written.accounts?.[1]?.active).toBe(true);
  });
  it("updates both accounts.json and auth.json when both files exist", async () => {
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
          tokens: {
            access_token: "old-access",
            id_token: "old-id-token",
            refresh_token: "old-refresh",
            account_id: "old-account",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({ accountId: "acc_b" });
    expect(updated).toBe(true);
    const writtenAccounts = JSON.parse(
      await readFile(accountsPath, "utf-8"),
    ) as { activeAccountId?: string; accounts?: Array<{ active?: boolean }> };
    expect(writtenAccounts.activeAccountId).toBe("acc_b");
    expect(writtenAccounts.accounts?.[0]?.active).toBe(false);
    expect(writtenAccounts.accounts?.[1]?.active).toBe(true);
    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      tokens?: {
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };
    expect(writtenAuth.tokens?.access_token).toBe("access-b");
    expect(writtenAuth.tokens?.id_token).toBe("id-b");
    expect(writtenAuth.tokens?.refresh_token).toBe("refresh-b");
    expect(writtenAuth.tokens?.account_id).toBe("acc_b");
  });
  it("prefers explicit selection tokens over stale accounts.json tokens", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: {
                  access_token: "stale-access",
                  id_token: "stale-id",
                  refresh_token: "stale-refresh",
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
          tokens: {
            access_token: "old-access",
            id_token: "old-id-token",
            refresh_token: "old-refresh",
            account_id: "old-account",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({
      accountId: "acc_b",
      email: "explicit@example.com",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      idToken: "fresh-id-token",
    });
    expect(updated).toBe(true);
    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      tokens?: {
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
      };
    };
    expect(writtenAuth.email).toBe("explicit@example.com");
    expect(writtenAuth.tokens?.access_token).toBe("fresh-access");
    expect(writtenAuth.tokens?.id_token).toBe("fresh-id-token");
    expect(writtenAuth.tokens?.refresh_token).toBe("fresh-refresh");
  });
  it("persists active selection by email match when accountId is omitted", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
              auth: {
                tokens: { access_token: "x.y.z", refresh_token: "refresh-b" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({
      email: "B@EXAMPLE.COM",
    });
    expect(updated).toBe(true);
    const written = JSON.parse(await readFile(accountsPath, "utf-8")) as {
      activeAccountId?: string;
      activeEmail?: string;
    };
    expect(written.activeAccountId).toBe("acc_b");
    expect(written.activeEmail).toBe("b@example.com");
  });
  it("returns false when selection has no matching Codex CLI account", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({
      accountId: "missing-account",
    });
    expect(updated).toBe(false);
  });
  it("still updates auth.json when accounts.json has no match", async () => {
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
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: "old-access",
            id_token: "old-id-token",
            refresh_token: "old-refresh",
            account_id: "old-account",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({
      accountId: "missing-account",
      email: "b@example.com",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
    });
    expect(updated).toBe(true);
    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      tokens?: {
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
      };
    };
    expect(writtenAuth.email).toBe("b@example.com");
    expect(writtenAuth.tokens?.access_token).toBe("fresh-access");
    expect(writtenAuth.tokens?.id_token).toBe("fresh-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("fresh-refresh");
  });
  it("does not update auth.json when no account match and selection lacks tokens", async () => {
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
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: "old-access",
            id_token: "old-id-token",
            refresh_token: "old-refresh",
            account_id: "old-account",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const before = await readFile(authPath, "utf-8");
    const updated = await setCodexCliActiveSelection({
      accountId: "missing-account",
      email: "b@example.com",
    });
    expect(updated).toBe(false);
    const after = await readFile(authPath, "utf-8");
    expect(after).toBe(before);
  });
  it("returns false when writer sync is disabled", async () => {
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "0";
    clearCodexCliStateCache();
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
    expect(updated).toBe(false);
  });
  it("returns false for malformed writer payload", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify({ accounts: { accountId: "acc_a" } }, null, 2),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
    expect(updated).toBe(false);
  });
  it("writes selected tokens to Codex auth.json when accounts.json is absent", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: "old.access.token",
            id_token: "old.id.token",
            refresh_token: "old-refresh",
            account_id: "old-id",
          },
          last_refresh: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf-8",
    );
    const updated = await setCodexCliActiveSelection({
      accountId: "acc_new",
      email: "new@example.com",
      accessToken: "new.access.token",
      refreshToken: "new-refresh-token",
      expiresAt: Date.parse("2026-03-01T00:00:00.000Z"),
    });
    expect(updated).toBe(true);
    const written = JSON.parse(await readFile(authPath, "utf-8")) as {
      tokens?: {
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };
    expect(written.tokens?.access_token).toBe("new.access.token");
    expect(written.tokens?.id_token).toBe("new.access.token");
    expect(written.tokens?.refresh_token).toBe("new-refresh-token");
    expect(written.tokens?.account_id).toBe("acc_new");
  });
  it("creates auth.json when both accounts.json and auth.json are absent", async () => {
    const updated = await setCodexCliActiveSelection({
      accountId: "acc_new",
      email: "new@example.com",
      accessToken: "new.access.token",
      refreshToken: "new-refresh-token",
      expiresAt: Date.parse("2026-03-01T00:00:00.000Z"),
    });
    expect(updated).toBe(true);

    const written = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      tokens?: {
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };
    expect(written.email).toBe("new@example.com");
    expect(written.tokens?.access_token).toBe("new.access.token");
    expect(written.tokens?.id_token).toBe("new.access.token");
    expect(written.tokens?.refresh_token).toBe("new-refresh-token");
    expect(written.tokens?.account_id).toBe("acc_new");
  });
  it("honors legacy sync env values and emits warning metric once", () => {
    delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
    process.env.CODEX_AUTH_SYNC_CODEX_CLI = "0";
    expect(isCodexCliSyncEnabled()).toBe(false);
    process.env.CODEX_AUTH_SYNC_CODEX_CLI = "1";
    expect(isCodexCliSyncEnabled()).toBe(true);
    expect(isCodexCliSyncEnabled()).toBe(true);
    expect(getCodexCliMetricsSnapshot().legacySyncEnvUses).toBe(1);
  });
  it("records a read miss when neither accounts.json nor auth.json exists", async () => {
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state).toBeNull();
    expect(getCodexCliMetricsSnapshot().readMisses).toBeGreaterThanOrEqual(1);
  });
  it("parses string booleans and numbers while filtering invalid account entries", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            123,
            { accountId: "missing" },
            {
              account_id: "acc_true",
              username: "TRUE@EXAMPLE.COM",
              access_token: "true.access.token",
              refresh_token: "true-refresh",
              is_active: "1",
              expires_at: "1710000000000",
            },
            {
              id: "acc_false",
              user_email: "FALSE@EXAMPLE.COM",
              access_token: "false.access.token",
              refresh_token: "false-refresh",
              active: "0",
              expiresAt: "1710000005000",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state?.accounts).toHaveLength(2);
    expect(state?.activeAccountId).toBe("acc_true");
    expect(state?.activeEmail).toBe("true@example.com");
    expect(state?.accounts[0]?.isActive).toBe(true);
    expect(state?.accounts[0]?.expiresAt).toBe(1710000000000);
    expect(state?.accounts[1]?.isActive).toBe(false);
    expect(state?.accounts[1]?.expiresAt).toBe(1710000005000);
  });
  it("derives expiration from JWT and uses auth accountId/email fallbacks", async () => {
    const jwtPayload = Buffer.from(
      JSON.stringify({ exp: 4_100_000_000 }),
      "utf-8",
    ).toString("base64url");
    const accessToken = `eyJhbGciOiJub25lIn0.${jwtPayload}.`;
    await writeFile(
      authPath,
      JSON.stringify(
        {
          email: "Auth@Example.COM",
          codexMultiAuthSyncVersion: "777",
          tokens: {
            access_token: accessToken,
            refresh_token: "refresh-auth",
            accountId: " acc_from_auth_field ",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const state = await loadCodexCliState({ forceRefresh: true });
    expect(state?.activeAccountId).toBe("acc_from_auth_field");
    expect(state?.activeEmail).toBe("auth@example.com");
    expect(state?.syncVersion).toBe(777);
    expect(state?.accounts[0]?.expiresAt).toBe(4_100_000_000_000);
  });
  it("returns null when auth payload tokens are missing or tokenless", async () => {
    await writeFile(authPath, JSON.stringify({ tokens: [] }, null, 2), "utf-8");
    expect(await loadCodexCliState({ forceRefresh: true })).toBeNull();
    await writeFile(
      authPath,
      JSON.stringify({ tokens: { id_token: "id-only" } }, null, 2),
      "utf-8",
    );
    clearCodexCliStateCache();
    expect(await loadCodexCliState({ forceRefresh: true })).toBeNull();
  });
  it("falls back to null when auth state cannot be read", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        { tokens: { access_token: "a.b.c", refresh_token: "refresh-auth" } },
        null,
        2,
      ),
      "utf-8",
    );
    const realReadFile = fsPromises.readFile.bind(fsPromises);
    const readSpy = vi.spyOn(fsPromises, "readFile");
    readSpy.mockImplementation(async (...args) => {
      if (String(args[0]) === authPath) {
        const error = new Error("auth read failed") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return realReadFile(...args);
    });
    try {
      const state = await loadCodexCliState({ forceRefresh: true });
      expect(state).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
  });
  it("continues with undefined source mtime when stat retries are exhausted", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi.spyOn(fsPromises, "stat");
    statSpy.mockImplementation(async (...args) => {
      if (String(args[0]) === accountsPath) {
        const error = new Error("locked stat") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return realStat(...args);
    });
    try {
      const state = await loadCodexCliState({ forceRefresh: true });
      expect(state?.accounts[0]?.accountId).toBe("acc_a");
      expect(state?.sourceUpdatedAtMs).toBeUndefined();
    } finally {
      statSpy.mockRestore();
    }
  });
  it("returns null after non-retryable account read errors", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
              auth: {
                tokens: { access_token: "a.b.c", refresh_token: "refresh-a" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const realReadFile = fsPromises.readFile.bind(fsPromises);
    const readSpy = vi.spyOn(fsPromises, "readFile");
    readSpy.mockImplementation(async (...args) => {
      if (String(args[0]) === accountsPath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realReadFile(...args);
    });
    try {
      expect(await loadCodexCliState({ forceRefresh: true })).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
  });
  it("returns null for lookup with blank email or missing access token", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        { accounts: [{ email: "a@example.com", refresh_token: "refresh-a" }] },
        null,
        2,
      ),
      "utf-8",
    );
    expect(await lookupCodexCliTokensByEmail("   ")).toBeNull();
    expect(await lookupCodexCliTokensByEmail("a@example.com")).toBeNull();
  });
});
