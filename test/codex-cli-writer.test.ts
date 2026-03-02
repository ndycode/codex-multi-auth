import { promises as fsPromises } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCodexCliMetricsSnapshot,
  resetCodexCliMetricsForTests,
} from "../lib/codex-cli/observability.js";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";

describe("codex-cli writer", () => {
  let tempDir: string;
  let accountsPath: string;
  let authPath: string;
  let previousPath: string | undefined;
  let previousAuthPath: string | undefined;
  let previousSync: string | undefined;

  beforeEach(async () => {
    previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
    previousAuthPath = process.env.CODEX_CLI_AUTH_PATH;
    previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
    tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-writer-"));
    accountsPath = join(tempDir, "accounts.json");
    authPath = join(tempDir, "auth.json");
    process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
    process.env.CODEX_CLI_AUTH_PATH = authPath;
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
    clearCodexCliStateCache();
    resetCodexCliMetricsForTests();
  });

  afterEach(async () => {
    clearCodexCliStateCache();
    if (previousPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
    else process.env.CODEX_CLI_ACCOUNTS_PATH = previousPath;
    if (previousAuthPath === undefined) delete process.env.CODEX_CLI_AUTH_PATH;
    else process.env.CODEX_CLI_AUTH_PATH = previousAuthPath;
    if (previousSync === undefined)
      delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
    else process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
    resetCodexCliMetricsForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns false when neither accounts.json nor auth.json exists", async () => {
    const updated = await setCodexCliActiveSelection({ accountId: "missing" });
    expect(updated).toBe(false);
    expect(getCodexCliMetricsSnapshot().writeFailures).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("matches by email, preserves non-record entries, and writes string expires_at as ISO time", async () => {
    const expiresAtMs = 1_710_000_000_000;
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            "noise-entry",
            {
              accountId: 123,
              email: "target@example.com",
              expires_at: String(expiresAtMs),
              auth: {
                tokens: {
                  access_token: "target-access",
                  refresh_token: "target-refresh",
                },
              },
            },
            {
              accountId: "acc_other",
              email: "other@example.com",
              auth: {
                tokens: {
                  access_token: "other-access",
                  refresh_token: "other-refresh",
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
          tokens: {
            access_token: "old-access",
            id_token: "old-id",
            refresh_token: "old-refresh",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const updated = await setCodexCliActiveSelection({
      email: "TARGET@EXAMPLE.COM",
    });
    expect(updated).toBe(true);

    const writtenAccounts = JSON.parse(
      await readFile(accountsPath, "utf-8"),
    ) as {
      activeEmail?: string;
      accounts?: unknown[];
    };
    expect(writtenAccounts.activeEmail).toBe("target@example.com");
    expect(writtenAccounts.accounts?.[0]).toBe("noise-entry");

    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      last_refresh?: string;
      tokens?: { access_token?: string; refresh_token?: string };
    };
    expect(writtenAuth.email).toBe("target@example.com");
    expect(writtenAuth.tokens?.access_token).toBe("target-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("target-refresh");
    expect(writtenAuth.last_refresh).toBe(new Date(expiresAtMs).toISOString());
  });

  it("returns false for malformed auth payload objects", async () => {
    await writeFile(authPath, "[]", "utf-8");

    const updated = await setCodexCliActiveSelection({
      accountId: "acc_a",
      accessToken: "access-a",
      refreshToken: "refresh-a",
    });
    expect(updated).toBe(false);
  });

  it("returns false when auth payload has no usable access/refresh tokens", async () => {
    await writeFile(authPath, JSON.stringify({ tokens: {} }, null, 2), "utf-8");

    const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
    expect(updated).toBe(false);
  });

  it("returns false when accounts payload cannot be parsed", async () => {
    await writeFile(accountsPath, "{ not-json", "utf-8");

    const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
    expect(updated).toBe(false);
  });

  it("retries EPERM rename and eventually succeeds", async () => {
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

    const realRename = fsPromises.rename.bind(fsPromises);
    let attempts = 0;
    const renameSpy = vi.spyOn(fsPromises, "rename");
    renameSpy.mockImplementation(async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("busy") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return realRename(...args);
    });

    try {
      const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
      expect(updated).toBe(true);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("returns false when rename remains busy across all retries", async () => {
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

    const renameSpy = vi.spyOn(fsPromises, "rename");
    renameSpy.mockImplementation(async () => {
      const error = new Error("still busy") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    });

    try {
      const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
      expect(updated).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("uses auth token fallback/default auth mode when selected account lacks tokens", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
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
          auth_mode: 123,
          tokens: {
            access_token: "fallback-access",
            refresh_token: "fallback-refresh",
            id_token: "fallback-id",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const updated = await setCodexCliActiveSelection({
      accountId: "acc_a",
      email: "fallback@example.com",
    });
    expect(updated).toBe(true);

    const writtenAccounts = JSON.parse(
      await readFile(accountsPath, "utf-8"),
    ) as {
      activeEmail?: string;
    };
    expect(writtenAccounts.activeEmail).toBe("fallback@example.com");

    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      auth_mode?: unknown;
      email?: string;
      tokens?: {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
      };
    };
    expect(writtenAuth.auth_mode).toBe("chatgpt");
    expect(writtenAuth.email).toBe("fallback@example.com");
    expect(writtenAuth.tokens?.access_token).toBe("fallback-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("fallback-refresh");
    expect(writtenAuth.tokens?.id_token).toBe("fallback-id");
  });

  it("writes auth from explicit selection when persisted tokens payload is not an object", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: [],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const updated = await setCodexCliActiveSelection({
      accountId: "acc_direct",
      email: "direct@example.com",
      accessToken: "direct-access",
      refreshToken: "direct-refresh",
    });
    expect(updated).toBe(true);

    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      tokens?: {
        account_id?: string;
        access_token?: string;
        refresh_token?: string;
      };
    };
    expect(writtenAuth.email).toBe("direct@example.com");
    expect(writtenAuth.tokens?.account_id).toBe("acc_direct");
    expect(writtenAuth.tokens?.access_token).toBe("direct-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("direct-refresh");
  });

  it("surfaces auth-path errors when accounts file is absent", async () => {
    await writeFile(authPath, "{not-json", "utf-8");

    const updated = await setCodexCliActiveSelection({
      accountId: "acc_only_auth",
      accessToken: "a",
      refreshToken: "r",
    });
    expect(updated).toBe(false);
  });
});
