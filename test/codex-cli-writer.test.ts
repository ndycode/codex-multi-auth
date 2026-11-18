import * as bindingLock from "../lib/runtime/native-binding-lock.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
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
import {
  ensureCodexCliFileAuthStore,
  readTopLevelCodexCliAuthStoreMode,
  setCodexCliActiveSelection,
} from "../lib/codex-cli/writer.js";

describe("codex-cli writer", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-writer-"));
    accountsPath = join(tempDir, "accounts.json");
    authPath = join(tempDir, "auth.json");
    configPath = join(tempDir, "config.toml");
    process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
    process.env.CODEX_CLI_AUTH_PATH = authPath;
    process.env.CODEX_CLI_CONFIG_PATH = configPath;
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
    process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "1";
    clearCodexCliStateCache();
    resetCodexCliMetricsForTests();
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
    resetCodexCliMetricsForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

	it("preserves the desktop credentials when native app binding is active", async () => {
		const auth = JSON.stringify({ tokens: { access_token: "desktop-access", refresh_token: "desktop-refresh" } });
		await writeFile(authPath, auth);
		await writeFile(configPath, '# codex-multi-auth native provider begin\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:43210"\n# codex-multi-auth native provider end\n');
		expect(await setCodexCliActiveSelection({ accountId: "inference", accessToken: "inference-access", refreshToken: "inference-refresh" })).toBe(false);
		expect(await readFile(authPath, "utf8")).toBe(auth);
	});


  it("serializes the native config check and auth write with binding", async()=>{
    const original=JSON.stringify({tokens:{access_token:"desktop",refresh_token:"desktop-refresh"}});
    await writeFile(authPath,original);await writeFile(configPath,'model_provider="openai"\n');
    let entered!:()=>void, release!:()=>void, attempted!:()=>void;
    const inside=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r), attempt=new Promise<void>(r=>attempted=r);
    const held=withFileTransactionLock(`${configPath}.native-bind`,async()=>{entered();await gate;});
    await inside;
    const read=fsPromises.readFile.bind(fsPromises), rename=fsPromises.rename.bind(fsPromises);
    const reader=vi.spyOn(fsPromises,"readFile").mockImplementation(async(...args)=>{
      const value=await read(...args);if(String(args[0])===configPath)attempted();return value;
    });
    const renamer=vi.spyOn(fsPromises,"rename").mockImplementation(async(...args)=>{
      if(String(args[1]).endsWith(".native-bind.write-lock"))attempted();return rename(...args);
    });
    const writing=setCodexCliActiveSelection({accountId:"inference",accessToken:"inference",refreshToken:"inference-refresh"});
    try{
      await attempt;
      await writeFile(configPath,'# codex-multi-auth native provider begin\nmodel_provider="openai"\nopenai_base_url="http://127.0.0.1:43210"\n# codex-multi-auth native provider end\n');
    }finally{release();await held;}
    try{expect(await writing).toBe(false);expect(await readFile(authPath,"utf8")).toBe(original);}
    finally{reader.mockRestore();renamer.mockRestore();}
  });


  it("resolves false after real native binding contention times out", async()=>{
    const original=JSON.stringify({tokens:{access_token:"desktop",refresh_token:"desktop-refresh"}});
    await writeFile(authPath,original);
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
    const held=withFileTransactionLock(`${configPath}.native-bind`,async()=>{entered();await gate;});
    await started;
    try {
      await expect(setCodexCliActiveSelection({accountId:"inference",accessToken:"fixture",refreshToken:"fixture-refresh"})).resolves.toBe(false);
      expect(await readFile(authPath,"utf8")).toBe(original);
    } finally {release();await held;}
  },20000);
  it.each(["ELOCKED", "EPERM"])("resolves false when binding lock acquisition fails with %s",async code=>{
    const original=JSON.stringify({tokens:{access_token:"desktop",refresh_token:"desktop-refresh"}});
    await writeFile(authPath,original);
    const lock=vi.spyOn(bindingLock,"withNativeBindingLock").mockRejectedValueOnce(Object.assign(Error("fixture failure"),{code}));
    try {
      await expect(setCodexCliActiveSelection({accountId:"inference",accessToken:"fixture",refreshToken:"fixture-refresh"})).resolves.toBe(false);
      expect(await readFile(authPath,"utf8")).toBe(original);
      expect(getCodexCliMetricsSnapshot().writeFailures).toBe(1);
    } finally {lock.mockRestore();}
  });

  it("resolves false instead of rejecting when the native binding lock cannot be set up", async () => {
    const mkdtemp = fsPromises.mkdtemp.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async (...args) => {
      if (String(args[0]).includes(".native-bind")) throw Object.assign(Error("fixture denied"), { code: "EACCES" });
      return mkdtemp(...args);
    });
    try {
      await expect(setCodexCliActiveSelection({ accountId: "inference", accessToken: "inference", refreshToken: "inference-refresh" })).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it("returns false when neither accounts.json nor auth.json exists", async () => {
    const updated = await setCodexCliActiveSelection({ accountId: "missing" });
    expect(updated).toBe(false);
    expect(getCodexCliMetricsSnapshot().writeFailures).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("writes the token's chatgpt_account_id instead of an org id (#700)", async () => {
    const jwt = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    const accessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
    });

    await setCodexCliActiveSelection({
      accountId: "org-AbC123",
      accessToken,
      refreshToken: "r",
    });
    let written = JSON.parse(await readFile(authPath, "utf-8")) as {
      tokens?: { account_id?: string };
    };
    expect(written.tokens?.account_id).toBe("ws-uuid-1");

    // explicit non-org workspace selections are preserved
    await setCodexCliActiveSelection({
      accountId: "team-ws-uuid",
      accessToken,
      refreshToken: "r",
    });
    written = JSON.parse(await readFile(authPath, "utf-8"));
    expect(written.tokens?.account_id).toBe("team-ws-uuid");

    // no claim in either token: never write the org id, drop the field
    await setCodexCliActiveSelection({
      accountId: "org-AbC123",
      accessToken: "opaque-access",
      refreshToken: "r",
    });
    written = JSON.parse(await readFile(authPath, "utf-8"));
    expect(written.tokens?.account_id).toBeUndefined();
  });

  it("falls back to the id_token's chatgpt_account_id for an org id (#700)", async () => {
    const jwt = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    const idToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-2" },
    });

    await setCodexCliActiveSelection({
      accountId: "ORG-AbC123",
      accessToken: "opaque-access",
      idToken,
      refreshToken: "r",
    });
    const written = JSON.parse(await readFile(authPath, "utf-8")) as {
      tokens?: { account_id?: string };
    };
    expect(written.tokens?.account_id).toBe("ws-uuid-2");
  });

  it("sanitises a stale org account_id already in auth.json when no accountId is selected (#700)", async () => {
    const jwt = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    const accessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-3" },
    });
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "old-access",
          refresh_token: "old-refresh",
          account_id: "org-Stale",
        },
      }),
      "utf-8",
    );

    await setCodexCliActiveSelection({ accessToken, refreshToken: "r" });
    const written = JSON.parse(await readFile(authPath, "utf-8")) as {
      tokens?: { account_id?: string };
    };
    expect(written.tokens?.account_id).toBe("ws-uuid-3");
  });

  it("does not carry the previous workspace id onto new tokens without an accountId (#700)", async () => {
    const jwt = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    const writeExisting = (accountId: string) =>
      writeFile(
        authPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: "old-access",
            refresh_token: "old-refresh",
            account_id: accountId,
          },
        }),
        "utf-8",
      );
    const readAccountId = async () =>
      (JSON.parse(await readFile(authPath, "utf-8")) as {
        tokens?: { account_id?: string };
      }).tokens?.account_id;

    await writeExisting("ws-previous-account");
    await setCodexCliActiveSelection({
      accessToken: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "ws-new-account" },
      }),
      refreshToken: "r",
    });
    expect(await readAccountId()).toBe("ws-new-account");

    // a token without any claim gives nothing better, so the id is kept
    await writeExisting("ws-previous-account");
    await setCodexCliActiveSelection({ accessToken: "opaque-access", refreshToken: "r" });
    expect(await readAccountId()).toBe("ws-previous-account");
  });

  it("keeps a same-identity id_token when a resync passes no idToken", async () => {
    const jwt = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    const auth = { chatgpt_account_id: "ws-uuid-1" };
    const idToken = jwt({ sub: "user-1", email: "a@example.com", "https://api.openai.com/auth": auth });
    const refreshedAccess = jwt({ sub: "user-1", exp: 2, "https://api.openai.com/auth": auth });
    const otherUserAccess = jwt({ sub: "user-2", "https://api.openai.com/auth": auth });
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwt({ sub: "user-1", exp: 1, "https://api.openai.com/auth": auth }),
          refresh_token: "old-refresh",
          id_token: idToken,
          account_id: "ws-uuid-1",
        },
      }),
      "utf-8",
    );

    await setCodexCliActiveSelection({
      accountId: "org-AbC123",
      accessToken: refreshedAccess,
      refreshToken: "r2",
    });
    let written = JSON.parse(await readFile(authPath, "utf-8")) as {
      tokens?: { id_token?: string };
    };
    expect(written.tokens?.id_token).toBe(idToken);

    // a different user in the same workspace does not inherit it
    await setCodexCliActiveSelection({
      accountId: "ws-uuid-1",
      accessToken: otherUserAccess,
      refreshToken: "r3",
    });
    written = JSON.parse(await readFile(authPath, "utf-8"));
    expect(written.tokens?.id_token).toBe(otherUserAccess);
  });

  it("creates auth.json when missing and selection includes tokens", async () => {
    const updated = await setCodexCliActiveSelection({
      accountId: "acc_new",
      email: "new@example.com",
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(updated).toBe(true);

    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      tokens?: {
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };
    expect(writtenAuth.email).toBe("new@example.com");
    expect(writtenAuth.tokens?.access_token).toBe("new-access");
    expect(writtenAuth.tokens?.id_token).toBe("new-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("new-refresh");
    expect(writtenAuth.tokens?.account_id).toBe("acc_new");
  });

  it("forces file-backed Codex auth store in config.toml", async () => {
    const updated = await setCodexCliActiveSelection({
      accountId: "acc_new",
      email: "new@example.com",
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(updated).toBe(true);

    const writtenConfig = await readFile(configPath, "utf-8");
    expect(writtenConfig).toContain('cli_auth_credentials_store = "file"');
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
      if (String(args[1]).includes(".write-lock")) return realRename(...args);
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

    const realRename = fsPromises.rename.bind(fsPromises);
    const renameSpy = vi.spyOn(fsPromises, "rename");
    renameSpy.mockImplementation(async (...args) => {
      if (String(args[1]).includes(".write-lock")) return realRename(...args);
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
        id_token?: string;
        refresh_token?: string;
      };
    };
    expect(writtenAuth.email).toBe("direct@example.com");
    expect(writtenAuth.tokens?.account_id).toBe("acc_direct");
    expect(writtenAuth.tokens?.access_token).toBe("direct-access");
    expect(writtenAuth.tokens?.id_token).toBe("direct-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("direct-refresh");
  });

  it("falls back id_token to selected access token when idToken is missing", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          email: "old@example.com",
          tokens: {
            access_token: "old-access",
            refresh_token: "old-refresh",
            id_token: "old-id-token",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const updated = await setCodexCliActiveSelection({
      accountId: "acc_new",
      email: "new@example.com",
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(updated).toBe(true);

    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      email?: string;
      tokens?: {
        account_id?: string;
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
      };
    };
    expect(writtenAuth.email).toBe("new@example.com");
    expect(writtenAuth.tokens?.account_id).toBe("acc_new");
    expect(writtenAuth.tokens?.access_token).toBe("new-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("new-refresh");
    expect(writtenAuth.tokens?.id_token).toBe("new-access");
  });

  it("enriches active accounts.json entry with complete token payload including id_token", async () => {
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          accounts: [
            {
              accountId: "acc_a",
              email: "a@example.com",
            },
            {
              accountId: "acc_b",
              email: "b@example.com",
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
            refresh_token: "old-refresh",
            id_token: "old-id",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const updated = await setCodexCliActiveSelection({
      accountId: "acc_b",
      email: "B@EXAMPLE.COM",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
    });
    expect(updated).toBe(true);

    const writtenAccounts = JSON.parse(await readFile(accountsPath, "utf-8")) as {
      accounts?: Array<{
        accountId?: string;
        email?: string;
        active?: boolean;
        auth?: {
          tokens?: {
            access_token?: string;
            refresh_token?: string;
            id_token?: string;
          };
        };
      }>;
    };
    const active = writtenAccounts.accounts?.find((entry) => entry.active === true);
    expect(active?.accountId).toBe("acc_b");
    expect(active?.email).toBe("b@example.com");
    expect(active?.auth?.tokens?.access_token).toBe("fresh-access");
    expect(active?.auth?.tokens?.refresh_token).toBe("fresh-refresh");
    expect(active?.auth?.tokens?.id_token).toBe("fresh-access");
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

  it("rejects partial token payloads to avoid mixing stale auth tokens", async () => {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "old-access",
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
      accountId: "acc_partial",
      email: "partial@example.com",
      accessToken: "new-access-only",
    });
    expect(updated).toBe(false);

    const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
      tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
      email?: string;
    };
    expect(writtenAuth.tokens?.access_token).toBe("old-access");
    expect(writtenAuth.tokens?.refresh_token).toBe("old-refresh");
    expect(writtenAuth.tokens?.account_id).toBe("old-account");
    expect(writtenAuth.email).toBeUndefined();
  });

  // Issue #641: the official CLI reads config.toml directly, so third-party
  // front-ends that exec it (CodexBar, editor extensions) keep hitting the macOS
  // login keychain until the persisted value is pinned to "file".
  describe("ensureCodexCliFileAuthStore", () => {
    it("rewrites a keychain-backed store to file", async () => {
      await writeFile(
        configPath,
        'model = "gpt-5.3-codex"\ncli_auth_credentials_store = "keychain"\n',
        "utf-8",
      );

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      const written = await readFile(configPath, "utf-8");
      expect(written).toContain('cli_auth_credentials_store = "file"');
      expect(written).not.toContain('cli_auth_credentials_store = "keychain"');
      expect(written).toContain('model = "gpt-5.3-codex"');
    });

    it("is a no-op when the store is already file", async () => {
      const original = 'cli_auth_credentials_store = "file"\n';
      await writeFile(configPath, original, "utf-8");

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(false);
      expect(await readFile(configPath, "utf-8")).toBe(original);
    });

    // A TOML literal string is as valid as a basic string; rewriting it would
    // churn a healthy config on every wrapper startup.
    it("is a no-op when the store is a literal-string file", async () => {
      const original = "cli_auth_credentials_store = 'file'\n";
      await writeFile(configPath, original, "utf-8");

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(false);
      expect(await readFile(configPath, "utf-8")).toBe(original);
    });

    it("rewrites a literal-string keychain value", async () => {
      await writeFile(
        configPath,
        "cli_auth_credentials_store = 'keychain'\n",
        "utf-8",
      );

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      expect(await readFile(configPath, "utf-8")).toBe(
        'cli_auth_credentials_store = "file"\n',
      );
    });

    it("creates the config file when it does not exist", async () => {
      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      expect(await readFile(configPath, "utf-8")).toBe(
        'cli_auth_credentials_store = "file"\n',
      );
    });

    // Rewriting the profile-scoped key in place would mangle a deliberate
    // per-profile setting while leaving the top-level default on the keychain,
    // so the prompts would keep coming.
    it("leaves profile-scoped assignments alone and adds a top-level one", async () => {
      await writeFile(
        configPath,
        '[profiles.work]\ncli_auth_credentials_store = "keychain"\n',
        "utf-8",
      );

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      const written = await readFile(configPath, "utf-8");
      expect(written).toContain('cli_auth_credentials_store = "keychain"');
      expect(
        written.indexOf('cli_auth_credentials_store = "file"'),
      ).toBeLessThan(written.indexOf("[profiles.work]"));
      expect(readTopLevelCodexCliAuthStoreMode(written)).toBe("file");
    });

    // Rewriting a CRLF config as LF is an edit the user never asked for, and
    // this path now runs on every wrapper startup rather than only on switch.
    it("preserves CRLF line endings", async () => {
      await writeFile(
        configPath,
        'model = "gpt-5.3-codex"\r\ncli_auth_credentials_store = "keychain"\r\n',
        "utf-8",
      );

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      const written = await readFile(configPath, "utf-8");
      expect(written).toBe(
        'model = "gpt-5.3-codex"\r\ncli_auth_credentials_store = "file"\r\n',
      );
      expect(written).not.toMatch(/[^\r]\n/);
    });

    it("preserves LF line endings when inserting a new key", async () => {
      await writeFile(configPath, 'model = "gpt-5.3-codex"\n', "utf-8");

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      expect(await readFile(configPath, "utf-8")).not.toContain("\r");
    });

    // A continuation line of a multi-line array starts with "[" but is not a
    // table header. Treating it as one would cut the top-level scan short and
    // append a second top-level key -- a duplicate, which is invalid TOML and
    // would stop the official CLI from starting.
    it("does not mistake a multi-line array entry for a table header", async () => {
      await writeFile(
        configPath,
        'pairs = [\n[1, 2],\n]\ncli_auth_credentials_store = "keychain"\n',
        "utf-8",
      );

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      const written = await readFile(configPath, "utf-8");
      expect(
        written.match(/^\s*cli_auth_credentials_store\s*=/gm) ?? [],
      ).toHaveLength(1);
      expect(written).toContain('cli_auth_credentials_store = "file"');
      expect(written).toContain("[1, 2],");
    });

    it("still treats a commented table header as ending top-level scope", async () => {
      await writeFile(
        configPath,
        "[profiles.work] # work profile\ncli_auth_credentials_store = 'keychain'\n",
        "utf-8",
      );

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(true);
      const written = await readFile(configPath, "utf-8");
      expect(written).toContain("cli_auth_credentials_store = 'keychain'");
      expect(readTopLevelCodexCliAuthStoreMode(written)).toBe("file");
    });

    it("respects the enforcement opt-out", async () => {
      process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "0";
      const original = 'cli_auth_credentials_store = "keychain"\n';
      await writeFile(configPath, original, "utf-8");

      expect(await ensureCodexCliFileAuthStore(configPath)).toBe(false);
      expect(await readFile(configPath, "utf-8")).toBe(original);
    });

    it("defaults to the resolved Codex CLI config path", async () => {
      expect(await ensureCodexCliFileAuthStore()).toBe(true);
      expect(await readFile(configPath, "utf-8")).toContain(
        'cli_auth_credentials_store = "file"',
      );
    });
  });

  it("does not acquire a filesystem lock when active-selection sync is disabled",async()=>{
    process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI="0";
    const lock=vi.spyOn(bindingLock,"withNativeBindingLock");
    try {
      expect(await setCodexCliActiveSelection({accountId:"fixture",accessToken:"fixture-access",refreshToken:"fixture-refresh"})).toBe(false);
      expect(lock).not.toHaveBeenCalled();
    } finally {lock.mockRestore();}
  });

  describe("readTopLevelCodexCliAuthStoreMode", () => {
    it("reads a top-level assignment and ignores trailing comments", () => {
      expect(
        readTopLevelCodexCliAuthStoreMode(
          'cli_auth_credentials_store = "keychain" # legacy\n',
        ),
      ).toBe("keychain");
    });

    it("reads literal-string values", () => {
      expect(
        readTopLevelCodexCliAuthStoreMode(
          "cli_auth_credentials_store = 'file'\n",
        ),
      ).toBe("file");
    });

    it("ignores assignments scoped to a table", () => {
      expect(
        readTopLevelCodexCliAuthStoreMode(
          '[profiles.work]\ncli_auth_credentials_store = "file"\n',
        ),
      ).toBeNull();
    });

    it("returns null when unset", () => {
      expect(readTopLevelCodexCliAuthStoreMode('model = "gpt-5.3-codex"\n')).toBeNull();
    });
  });
});
