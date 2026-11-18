import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeErrnoError(
  message: string,
  code: "EBUSY" | "EPERM",
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("quota cache", () => {
  let tempDir: string;
  let originalDir: string | undefined;

  beforeEach(async () => {
    originalDir = process.env.CODEX_MULTI_AUTH_DIR;
    tempDir = await fs.mkdtemp(join(tmpdir(), "codex-multi-auth-quota-"));
    process.env.CODEX_MULTI_AUTH_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalDir === undefined) {
      delete process.env.CODEX_MULTI_AUTH_DIR;
    } else {
      process.env.CODEX_MULTI_AUTH_DIR = originalDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips bounded priming evidence and replaces it after a new observation", async () => {
    const { loadQuotaCache, saveQuotaCache } = await import("../lib/quota-cache.js");
    const entry = {updatedAt: 1000, status: 200, model: "fixture", planType: "promax", primary: {usedPercent: 0}, secondary: {windowMinutes: 0}, primingFailure: "timed out" as const};
    await saveQuotaCache({byAccountId: {}, byEmail: {}, byWorkspace: {scope: entry}});
    const failed = await loadQuotaCache();
    expect(failed.byWorkspace?.scope?.primingFailure).toBe("timed out");
    const {primingFailure: _failure, ...clean} = entry;
    await saveQuotaCache({byAccountId: {}, byEmail: {}, byWorkspace: {scope: {...clean, updatedAt: 2000, primingCompleted: true}}}, failed);
    const completed = await loadQuotaCache();
    expect(completed.byWorkspace?.scope).toMatchObject({primingCompleted: true});
    expect(completed.byWorkspace?.scope?.primingFailure).toBeUndefined();
  });

  it("rejects malformed persisted priming evidence", async () => {
    const { loadQuotaCache, getQuotaCachePath } = await import("../lib/quota-cache.js");
    await fs.writeFile(getQuotaCachePath(), JSON.stringify({version:1,byAccountId:{fixture:{updatedAt:1000,status:200,model:"fixture",primary:{},secondary:{},primingFailure:["timed out"],primingCompleted:"true"}},byEmail:{}}));
    const loaded = await loadQuotaCache();
    expect(loaded.byAccountId.fixture?.primingFailure).toBeUndefined();
    expect(loaded.byAccountId.fixture?.primingCompleted).toBeUndefined();
  });

  it.each(["completed", "failed"] as const)("retains a later %s priming result without overwriting concurrent quota", async outcome => {
    const { loadQuotaCache, saveQuotaCache } = await import("../lib/quota-cache.js");
    const { updateQuotaCacheForWorkspace, cloneQuotaCacheData } = await import("../lib/codex-manager/quota-cache-helpers.js");
    const { quotaWorkspaceKey } = await import("../lib/quota-readiness.js");
    const account = { recordId: "fixture", accountId: "personal", refreshToken: "fixture", addedAt: 1, lastUsed: 1 };
    const key = quotaWorkspaceKey(account, "personal")!;
    const baseline = await loadQuotaCache();
    const priming = cloneQuotaCacheData(baseline), plain = cloneQuotaCacheData(baseline);
    const clock = vi.spyOn(Date, "now").mockReturnValue(3000);
    try {
      updateQuotaCacheForWorkspace(priming, account, "personal", {
        observedAt: 1000, status: 200, model: "fixture", planType: "promax", primary: { usedPercent: 0 }, secondary: {},
        ...(outcome === "completed" ? { primingCompleted: true } : { primingFailure: "timed out" as const }),
      }, [account]);
    } finally { clock.mockRestore(); }
    updateQuotaCacheForWorkspace(plain, account, "personal", { observedAt: 2000, status: 200, model: "fixture", planType: "promax", primary: { usedPercent: 10 }, secondary: {} }, [account]);
    await saveQuotaCache(plain, baseline);
    await saveQuotaCache(priming, baseline);
    let saved = await loadQuotaCache();
    for (const entry of [saved.byWorkspace?.[key], saved.byAccountId.personal]) {
      expect(entry).toMatchObject({ updatedAt: 2000, primary: { usedPercent: 10 } });
      expect(outcome === "completed" ? entry?.primingCompleted : entry?.primingFailure).toBe(outcome === "completed" ? true : "timed out");
    }
    // A delayed save of that same plain check must not erase the later outcome.
    await saveQuotaCache(plain, baseline);
    saved = await loadQuotaCache();
    expect(outcome === "completed" ? saved.byWorkspace?.[key]?.primingCompleted : saved.byWorkspace?.[key]?.primingFailure).toBe(outcome === "completed" ? true : "timed out");
    // A genuinely subsequent observation supersedes the old outcome.
    const newer = cloneQuotaCacheData(saved);
    updateQuotaCacheForWorkspace(newer, account, "personal", { observedAt: 4000, status: 200, model: "fixture", primary: { usedPercent: 20 }, secondary: {} }, [account]);
    await saveQuotaCache(newer, saved);
    expect((await loadQuotaCache()).byWorkspace?.[key]?.primingCompleted).toBeUndefined();
    expect((await loadQuotaCache()).byWorkspace?.[key]?.primingFailure).toBeUndefined();
  });

  it.each([false, true])("keeps overlapping successful priming when failure saves first: %s", async failureFirst => {
    const { loadQuotaCache, saveQuotaCache } = await import("../lib/quota-cache.js");
    const baseline = await loadQuotaCache();
    const quota = { status: 200, model: "fixture", planType: "promax", primary: { usedPercent: 0 }, secondary: {} };
    const completed = { byAccountId: {}, byEmail: {}, byWorkspace: { personal: { ...quota, updatedAt: 1000, primingCompleted: true, primingObservedAt: 3000 } } };
    const failed = { byAccountId: {}, byEmail: {}, byWorkspace: { personal: { ...quota, updatedAt: 2000, primingFailure: "timed out" as const, primingObservedAt: 4000 } } };
    for (const proposal of failureFirst ? [failed, completed] : [completed, failed]) {
      await saveQuotaCache(proposal, baseline);
    }
    const saved = await loadQuotaCache();
    expect(saved.byWorkspace?.personal).toMatchObject({ updatedAt: 2000, primingCompleted: true, primingObservedAt: 3000 });
    expect(saved.byWorkspace?.personal?.primingFailure).toBeUndefined();
    // A later attempt starts after completion: the earlier success cannot mask its failure.
    await saveQuotaCache({ ...failed, byWorkspace: { personal: { ...failed.byWorkspace.personal, updatedAt: 5000, primingObservedAt: 6000 } } }, saved);
    const later = (await loadQuotaCache()).byWorkspace?.personal;
    expect(later?.primingCompleted).toBeUndefined();
    expect(later?.primingFailure).toBe("timed out");
  });

  it("returns empty cache by default", async () => {
    const { loadQuotaCache } = await import("../lib/quota-cache.js");
    const data = await loadQuotaCache();
    expect(data).toEqual({ byAccountId: {}, byEmail: {} });
  });

  it("saves and reloads quota entries", async () => {
    const { loadQuotaCache, saveQuotaCache, getQuotaCachePath } =
      await import("../lib/quota-cache.js");

    await saveQuotaCache({
      byAccountId: {
        acc_1: {
          updatedAt: Date.now(),
          status: 200,
          model: "gpt-5-codex",
          planType: "plus",
          primary: { usedPercent: 40, windowMinutes: 300 },
          secondary: { usedPercent: 20, windowMinutes: 10080 },
        },
      },
      byEmail: {},
    });

    const loaded = await loadQuotaCache();
    expect(loaded.byAccountId.acc_1?.primary.usedPercent).toBe(40);

    const fileContent = await fs.readFile(getQuotaCachePath(), "utf8");
    expect(fileContent).toContain('"version": 1');
  });

  it("persists scoped automatic observations through a real cache reload", async () => {
    const { loadQuotaCache, saveQuotaCache } = await import("../lib/quota-cache.js");
    const { updateQuotaCacheForWorkspace, cloneQuotaCacheData } = await import("../lib/codex-manager/quota-cache-helpers.js");
    const { findQuotaCacheEntryForAccount } = await import("../lib/quota-readiness.js");
    const account = { recordId: "fixture-record", accountId: "org", refreshToken: "fixture", addedAt: 1, lastUsed: 1, workspaces: [{ id: "personal", enabled: true }] };
    const cache = await loadQuotaCache();
    updateQuotaCacheForWorkspace(cache, account, "personal", { status: 200, model: "fixture", primary: { usedPercent: 23 }, secondary: {} }, [account]);
    await saveQuotaCache(cloneQuotaCacheData(cache));
    const loaded = await loadQuotaCache();
    expect(findQuotaCacheEntryForAccount(loaded, account, [account])?.primary.usedPercent).toBe(23);
    expect(findQuotaCacheEntryForAccount(loaded, account, [account], undefined, "org")).toBeNull();
  });

  it("never falls back to a stored binding when a workspace selection does not resolve", async () => {
    const { loadQuotaCache, saveQuotaCache } = await import("../lib/quota-cache.js");
    const { findQuotaCacheEntryForAccount } = await import("../lib/quota-readiness.js");
    // Token identity exists only in the access token, and the saved workspace
    // index no longer resolves — the email-keyed binding is not the selection.
    const tokenOnly = {
      recordId: "fixture-record-1",
      email: "tokenonly@example.com",
      workspaces: [{ id: "ws-a", enabled: true }, { id: "ws-b", enabled: true }],
      currentWorkspaceIndex: 7,
    };
    const bindingOnly = { recordId: "fixture-record-2", email: "binding@example.com" };
    await saveQuotaCache({
      byAccountId: {},
      byEmail: {
        "tokenonly@example.com": { updatedAt: 1000, status: 200, model: "fixture", planType: "pro", primary: { usedPercent: 55 }, secondary: {} },
        "binding@example.com": { updatedAt: 1000, status: 200, model: "fixture", planType: "pro", primary: { usedPercent: 66 }, secondary: {} },
      },
    });
    const loaded = await loadQuotaCache();
    expect(findQuotaCacheEntryForAccount(loaded, tokenOnly, [tokenOnly, bindingOnly])).toBeNull();
    // A workspace-less token-only account still resolves its own binding entry.
    expect(findQuotaCacheEntryForAccount(loaded, bindingOnly, [tokenOnly, bindingOnly])?.primary.usedPercent).toBe(66);
  });

  it("stages atomic writes through tempPathFor and leaves no .tmp behind", async () => {
    // End-to-end check of the staging contract this PR centralizes: the save
    // must write a sibling named by tempPathFor (<target>.<pid>.<ms>.<hex8>.tmp,
    // crypto-backed nonce), rename it onto the target, and leave the directory
    // free of staging leftovers.
    const renameSpy = vi.spyOn(fs, "rename");
    try {
      const { saveQuotaCache, getQuotaCachePath } = await import(
        "../lib/quota-cache.js"
      );

      await saveQuotaCache({ byAccountId: {}, byEmail: {} });

      const cachePath = getQuotaCachePath();
      const renameCall = renameSpy.mock.calls.find(
        ([, dest]) => String(dest) === cachePath,
      );
      expect(renameCall).toBeDefined();
      const stagedPath = String(renameCall?.[0]);
      expect(stagedPath.startsWith(`${cachePath}.`)).toBe(true);
      expect(stagedPath).toMatch(
        new RegExp(`\\.${process.pid}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`),
      );

      const leftovers = (await fs.readdir(tempDir)).filter((name) =>
        name.endsWith(".tmp"),
      );
      expect(leftovers).toEqual([]);
      await expect(fs.readFile(cachePath, "utf8")).resolves.toContain(
        '"version": 1',
      );
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("keeps the cache directory owner-only (0o700) on POSIX", async () => {
    // The quota cache sits alongside at-rest secrets; the dir must not be
    // world-listable. mode is a no-op on win32 (ACL-based), so skip there.
    if (process.platform === "win32") return;
    // beforeEach already created tempDir, so this exercises the chmod-on-an-
    // EXISTING-dir path (mkdir's mode only applies to a fresh dir). Loosen it to
    // 0o755 first; if saveQuotaCache failed to re-assert 0o700 the test fails.
    await fs.chmod(tempDir, 0o755);
    const { saveQuotaCache } = await import("../lib/quota-cache.js");
    await saveQuotaCache({ byAccountId: {}, byEmail: {} });
    const stats = await fs.stat(tempDir);
    // Low 9 perm bits should be rwx------ (0o700).
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it("ignores cache files with unsupported version", async () => {
    const { loadQuotaCache, getQuotaCachePath } =
      await import("../lib/quota-cache.js");
    await fs.writeFile(
      getQuotaCachePath(),
      JSON.stringify({
        version: 2,
        byAccountId: {
          acc_1: {
            updatedAt: Date.now(),
            status: 200,
            model: "gpt-5-codex",
            primary: { usedPercent: 10 },
            secondary: { usedPercent: 5 },
          },
        },
        byEmail: {},
      }),
      "utf8",
    );

    const loaded = await loadQuotaCache();
    expect(loaded).toEqual({ byAccountId: {}, byEmail: {} });
  });

  it("retries transient EBUSY while loading cache", async () => {
    const { loadQuotaCache, getQuotaCachePath } =
      await import("../lib/quota-cache.js");
    await fs.writeFile(
      getQuotaCachePath(),
      JSON.stringify({
        version: 1,
        byAccountId: {
          acc_1: {
            updatedAt: Date.now(),
            status: 200,
            model: "gpt-5-codex",
            primary: { usedPercent: 10 },
            secondary: { usedPercent: 5 },
          },
        },
        byEmail: {},
      }),
      "utf8",
    );

    const realRead = fs.readFile.bind(fs);
    let attempts = 0;
    const readSpy = vi.spyOn(fs, "readFile");
    readSpy.mockImplementation(async (...args) => {
      if (String(args[0]) === getQuotaCachePath()) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
      }
      return realRead(...args);
    });

    try {
      const loaded = await loadQuotaCache();
      expect(loaded.byAccountId.acc_1?.model).toBe("gpt-5-codex");
      expect(attempts).toBe(2);
    } finally {
      readSpy.mockRestore();
    }
  });

  it.each(["EBUSY", "EPERM"] as const)(
    "retries atomic rename on transient %s errors",
    async (code) => {
      const { saveQuotaCache, loadQuotaCache } =
        await import("../lib/quota-cache.js");
      const realRename = fs.rename;
      const renameSpy = vi.spyOn(fs, "rename");
      let attempts = 0;
      renameSpy.mockImplementation(async (...args) => {
        if (String(args[1]).endsWith(".write-lock")) return realRename(...args);
        attempts += 1;
        if (attempts < 3) {
          const error = new Error(
            `rename failed: ${code}`,
          ) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return realRename(...args);
      });

      try {
        await saveQuotaCache({
          byAccountId: {
            acc_1: {
              updatedAt: Date.now(),
              status: 200,
              model: "gpt-5-codex",
              primary: { usedPercent: 40, windowMinutes: 300 },
              secondary: { usedPercent: 20, windowMinutes: 10080 },
            },
          },
          byEmail: {},
        });
        const loaded = await loadQuotaCache();
        expect(loaded.byAccountId.acc_1?.model).toBe("gpt-5-codex");
        expect(attempts).toBe(3);
      } finally {
        renameSpy.mockRestore();
      }
    },
  );

  it("keeps the cache file valid across concurrent save retries", async () => {
    vi.resetModules();
    const warnMock = vi.fn();
    vi.doMock("../lib/logger.js", () => ({
      logWarn: warnMock,
    }));
    const payload = {
      byAccountId: {
        acc_1: {
          updatedAt: Date.now(),
          status: 200,
          model: "gpt-5-codex",
          planType: "plus",
          primary: { usedPercent: 40, windowMinutes: 300 },
          secondary: { usedPercent: 20, windowMinutes: 10080 },
        },
      },
      byEmail: {
        "owner@example.com": {
          updatedAt: Date.now(),
          status: 200,
          model: "gpt-5-codex",
          planType: "plus",
          primary: { usedPercent: 40, windowMinutes: 300 },
          secondary: { usedPercent: 20, windowMinutes: 10080 },
        },
      },
    };
    let renameSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      const { getQuotaCachePath, loadQuotaCache, saveQuotaCache } =
        await import("../lib/quota-cache.js");
      const realRename = fs.rename.bind(fs);
      renameSpy = vi.spyOn(fs, "rename");
      let attempts = 0;
      const retryableAttempts = new Map<number, "EBUSY" | "EPERM">([
        [1, "EBUSY"],
        [2, "EPERM"],
        [4, "EBUSY"],
        [5, "EPERM"],
      ]);
      renameSpy.mockImplementation(async (...args) => {
        if (String(args[1]).endsWith(".write-lock")) return realRename(...args);
        attempts += 1;
        const code = retryableAttempts.get(attempts);
        if (code) {
          throw makeErrnoError(`rename failed: ${code}`, code);
        }
        return realRename(...args);
      });

      await Promise.all(
        Array.from({ length: 4 }, () => saveQuotaCache(payload)),
      );

      const raw = await fs.readFile(getQuotaCachePath(), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(JSON.parse(raw)).toEqual({
        version: 1,
        byAccountId: payload.byAccountId,
        byEmail: payload.byEmail,
      });
      await expect(loadQuotaCache()).resolves.toEqual(payload);
      expect(attempts).toBeGreaterThan(4);
      expect(warnMock).not.toHaveBeenCalled();

      const entries = await fs.readdir(tempDir);
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    } finally {
      renameSpy?.mockRestore();
      vi.doUnmock("../lib/logger.js");
    }
  });

  it("cleans up temp files when rename keeps failing", async () => {
    const { saveQuotaCache } = await import("../lib/quota-cache.js");
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename");
    const unlinkSpy = vi.spyOn(fs, "unlink");
    renameSpy.mockImplementation(async (...args) => {
      if (String(args[1]).endsWith(".write-lock")) return realRename(...args);
      const error = new Error("locked") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      await saveQuotaCache({
        byAccountId: {
          acc_1: {
            updatedAt: Date.now(),
            status: 200,
            model: "gpt-5-codex",
            primary: { usedPercent: 40, windowMinutes: 300 },
            secondary: { usedPercent: 20, windowMinutes: 10080 },
          },
        },
        byEmail: {},
      });

      expect(unlinkSpy.mock.calls.filter(([path]) => String(path).endsWith(".tmp"))).toHaveLength(1);
      const entries = await fs.readdir(tempDir);
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it("logs sanitized cache filename for load/save failures", async () => {
    vi.resetModules();
    const warnMock = vi.fn();
    vi.doMock("../lib/logger.js", () => ({
      logWarn: warnMock,
    }));
    try {
      const { getQuotaCachePath, loadQuotaCache, saveQuotaCache } =
        await import("../lib/quota-cache.js");
      await fs.writeFile(getQuotaCachePath(), "{}", "utf8");

      const readSpy = vi.spyOn(fs, "readFile");
      readSpy.mockRejectedValueOnce(new Error("read failed"));
      await loadQuotaCache();
      readSpy.mockRestore();

      const renameSpy = vi.spyOn(fs, "rename");
      renameSpy.mockImplementation(async () => {
        const error = new Error("rename failed") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      });
      await saveQuotaCache({ byAccountId: {}, byEmail: {} });
      renameSpy.mockRestore();

      const logMessages = warnMock.mock.calls.map((args) => String(args[0]));
      expect(
        logMessages.some((message) => message.includes("quota-cache.json")),
      ).toBe(true);
      expect(logMessages.some((message) => message.includes(tempDir))).toBe(
        false,
      );
    } finally {
      vi.doUnmock("../lib/logger.js");
    }
  });
  it("normalizes mixed valid and invalid cached entries", async () => {
    const { loadQuotaCache, getQuotaCachePath } =
      await import("../lib/quota-cache.js");
    await fs.writeFile(
      getQuotaCachePath(),
      JSON.stringify({
        version: 1,
        byAccountId: {
          "": {
            updatedAt: Date.now(),
            status: 200,
            model: "should-be-dropped",
            primary: {},
            secondary: {},
          },
          good: {
            updatedAt: Date.now(),
            status: 200,
            model: " gpt-5-codex ",
            planType: "plus",
            primary: {
              usedPercent: 55,
              windowMinutes: 60,
              resetAtMs: Date.now() + 1_000,
            },
            secondary: { usedPercent: 10, windowMinutes: 10_080 },
          },
          badType: "not-an-entry",
          missingUpdated: {
            status: 200,
            model: "missing-updated",
            primary: {},
            secondary: {},
          },
          nonStringModel: {
            updatedAt: Date.now(),
            status: 200,
            model: 123,
            primary: {},
            secondary: {},
          },
          invalidWindow: {
            updatedAt: Date.now(),
            status: 200,
            model: " model-edge ",
            planType: 123,
            primary: "invalid-window",
            secondary: {
              usedPercent: "bad",
              windowMinutes: 120,
              resetAtMs: Infinity,
            },
          },
        },
        byEmail: [],
      }),
      "utf8",
    );

    const loaded = await loadQuotaCache();
    expect(Object.keys(loaded.byAccountId)).toEqual(["good", "invalidWindow"]);
    expect(loaded.byAccountId.good?.model).toBe("gpt-5-codex");
    expect(loaded.byAccountId.good?.planType).toBe("plus");
    expect(loaded.byAccountId.invalidWindow?.planType).toBeUndefined();
    expect(loaded.byAccountId.invalidWindow?.primary).toEqual({});
    expect(loaded.byAccountId.invalidWindow?.secondary).toEqual({
      windowMinutes: 120,
    });
    expect(loaded.byEmail).toEqual({});
  });

  it("returns empty cache when parsed payload is not an object", async () => {
    const { loadQuotaCache, getQuotaCachePath } =
      await import("../lib/quota-cache.js");
    await fs.writeFile(getQuotaCachePath(), "[]", "utf8");

    const loaded = await loadQuotaCache();
    expect(loaded).toEqual({ byAccountId: {}, byEmail: {} });
  });

  it("logs stringified non-Error load/save failures", async () => {
    vi.resetModules();
    const warnMock = vi.fn();
    vi.doMock("../lib/logger.js", () => ({
      logWarn: warnMock,
    }));
    try {
      const { getQuotaCachePath, loadQuotaCache, saveQuotaCache } =
        await import("../lib/quota-cache.js");
      await fs.writeFile(getQuotaCachePath(), "{}", "utf8");

      const readSpy = vi.spyOn(fs, "readFile");
      readSpy.mockRejectedValueOnce("string-read-failure");
      await loadQuotaCache();
      readSpy.mockRestore();

      const mkdirSpy = vi.spyOn(fs, "mkdir");
      mkdirSpy.mockRejectedValueOnce("mkdir-string-failure");
      await saveQuotaCache({ byAccountId: {}, byEmail: {} });
      mkdirSpy.mockRestore();

      const messages = warnMock.mock.calls.map((args) => String(args[0]));
      expect(
        messages.some((message) => message.includes("string-read-failure")),
      ).toBe(true);
      expect(
        messages.some((message) => message.includes("mkdir-string-failure")),
      ).toBe(true);
    } finally {
      vi.doUnmock("../lib/logger.js");
    }
  });

  it("retries transient EACCES while loading cache", async () => {
    const { loadQuotaCache, getQuotaCachePath } =
      await import("../lib/quota-cache.js");
    await fs.writeFile(
      getQuotaCachePath(),
      JSON.stringify({
        version: 1,
        byAccountId: {
          acc_1: {
            updatedAt: Date.now(),
            status: 200,
            model: "gpt-5-codex",
            primary: { usedPercent: 12 },
            secondary: { usedPercent: 7 },
          },
        },
        byEmail: {},
      }),
      "utf8",
    );

    const realRead = fs.readFile.bind(fs);
    let attempts = 0;
    const readSpy = vi.spyOn(fs, "readFile");
    readSpy.mockImplementation(async (...args) => {
      if (String(args[0]) === getQuotaCachePath()) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
      return realRead(...args);
    });

    try {
      const loaded = await loadQuotaCache();
      expect(loaded.byAccountId.acc_1?.model).toBe("gpt-5-codex");
      expect(attempts).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("retries atomic rename on transient ENOTEMPTY errors", async () => {
    const { saveQuotaCache, loadQuotaCache } =
      await import("../lib/quota-cache.js");
    const realRename = fs.rename.bind(fs);
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, "rename");
    renameSpy.mockImplementation(async (...args) => {
      if (String(args[1]).endsWith(".write-lock")) return realRename(...args);
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("dir not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      return realRename(...args);
    });

    try {
      await saveQuotaCache({
        byAccountId: {
          acc_1: {
            updatedAt: Date.now(),
            status: 200,
            model: "gpt-5-codex",
            primary: { usedPercent: 40, windowMinutes: 300 },
            secondary: { usedPercent: 20, windowMinutes: 10080 },
          },
        },
        byEmail: {},
      });
      const loaded = await loadQuotaCache();
      expect(loaded.byAccountId.acc_1?.model).toBe("gpt-5-codex");
      expect(attempts).toBeGreaterThan(1);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("serializes concurrent saves so the last write wins", async () => {
    const { saveQuotaCache, loadQuotaCache, getQuotaCachePath } =
      await import("../lib/quota-cache.js");

    const makePayload = (usedPercent: number) => ({
      byAccountId: {
        acc_1: {
          updatedAt: Date.now(),
          status: 200,
          model: "gpt-5-codex",
          planType: "plus",
          primary: { usedPercent, windowMinutes: 300 },
          secondary: { usedPercent: 5, windowMinutes: 10080 },
        },
      },
      byEmail: {},
    });

    // Fire two writes back-to-back without awaiting the first; the internal
    // quotaCacheWriteQueue serializes them so the second (last) call wins and
    // the file is never left torn/interleaved.
    const first = saveQuotaCache(makePayload(11));
    const second = saveQuotaCache(makePayload(99));
    await Promise.all([first, second]);

    const raw = await fs.readFile(getQuotaCachePath(), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const loaded = await loadQuotaCache();
    expect(loaded.byAccountId.acc_1?.primary.usedPercent).toBe(99);
  });
  it("merges overlapping CLI and automatic cache changes from independent writers", async () => {
    const first = await import("../lib/quota-cache.js");
    vi.resetModules();
    const second = await import("../lib/quota-cache.js");
    const entry = (updatedAt: number) => ({updatedAt,status:200,model:"fixture",primary:{usedPercent:updatedAt},secondary:{}});
    await first.saveQuotaCache({byAccountId:{binding:entry(1)},byEmail:{}});
    const leftBase = await first.loadQuotaCache(), rightBase = await second.loadQuotaCache();
    const left = structuredClone(leftBase), right = structuredClone(rightBase);
    left.byWorkspace = {personal:entry(2)};
    right.byAccountId.binding = entry(3);
    right.byWorkspace = {other:entry(3)};
    await Promise.all([first.saveQuotaCache(left, leftBase), second.saveQuotaCache(right, rightBase)]);
    const saved = await first.loadQuotaCache();
    expect(saved.byWorkspace).toEqual({personal:entry(2),other:entry(3)});
    expect(saved.byAccountId.binding).toEqual(entry(3));
    // A repeat save from the stale CLI must not resurrect old observations.
    await first.saveQuotaCache(left, leftBase);
    expect((await first.loadQuotaCache()).byAccountId.binding).toEqual(entry(3));
  });

  it("does not apply stale cache deletion over a concurrent observation", async () => {
    const {loadQuotaCache,saveQuotaCache} = await import("../lib/quota-cache.js");
    const entry = (updatedAt: number) => ({updatedAt,status:200,model:"fixture",primary:{},secondary:{}});
    await saveQuotaCache({byAccountId:{},byEmail:{fixture:entry(1)}});
    const baseline = await loadQuotaCache();
    const proposal = structuredClone(baseline); delete proposal.byEmail.fixture;
    await saveQuotaCache({byAccountId:{},byEmail:{fixture:entry(2)}});
    await saveQuotaCache(proposal, baseline);
    expect((await loadQuotaCache()).byEmail.fixture).toEqual(entry(2));
  });

  it("leaves the latest cache intact if the locked merge read fails", async () => {
    const {loadQuotaCache,saveQuotaCache,getQuotaCachePath} = await import("../lib/quota-cache.js");
    const entry = {updatedAt:1,status:200,model:"fixture",primary:{},secondary:{}};
    await saveQuotaCache({byAccountId:{},byEmail:{},byWorkspace:{personal:entry}});
    const original = await fs.readFile(getQuotaCachePath(), "utf8");
    const realRead = fs.readFile.bind(fs);
    const read = vi.spyOn(fs,"readFile").mockImplementation(async (...args) => {
      if (String(args[0])===getQuotaCachePath()) throw Object.assign(new Error("fixture read failure"),{code:"EIO"});
      return realRead(...args);
    });
    try { await saveQuotaCache({byAccountId:{other:entry},byEmail:{}}); }
    finally { read.mockRestore(); }
    expect(await fs.readFile(getQuotaCachePath(), "utf8")).toBe(original);
    expect((await loadQuotaCache()).byWorkspace?.personal).toEqual(entry);
  });


  it("re-stamps a deliberate write that a backward clock jump would lose", async () => {
    const {loadQuotaCache,saveQuotaCache} = await import("../lib/quota-cache.js");
    const entry = (updatedAt: number, usedPercent: number) => ({updatedAt,status:200,model:"fixture",primary:{usedPercent},secondary:{}});
    // Seed disk with an observation stamped at wall time T2.
    await saveQuotaCache({byAccountId:{acc_1:entry(5_000,10)},byEmail:{}});
    const baseline = await loadQuotaCache();
    // Clock regresses to T1 < T2; the caller writes a fresh observation anyway.
    const proposal = structuredClone(baseline);
    proposal.byAccountId.acc_1 = entry(100,90);
    await saveQuotaCache(proposal, baseline);
    // The deliberate write must win the merge, re-stamped past the disk entry.
    const final = await loadQuotaCache();
    expect(final.byAccountId.acc_1?.primary.usedPercent).toBe(90);
    expect(final.byAccountId.acc_1?.updatedAt).toBe(5_001);
  });

  it("does not bump an older observation over a concurrent newer one", async () => {
    const {loadQuotaCache,saveQuotaCache} = await import("../lib/quota-cache.js");
    const entry = (updatedAt: number, usedPercent: number) => ({updatedAt,status:200,model:"fixture",primary:{usedPercent},secondary:{}});
    // Both probes share the same history entry.
    await saveQuotaCache({byAccountId:{acc_1:entry(4_000,10)},byEmail:{}});
    const baseline = await loadQuotaCache();
    // A concurrent probe lands a NEWER observation before the slower probe saves.
    await saveQuotaCache({byAccountId:{acc_1:entry(5_000,90)},byEmail:{}});
    // The slow probe's deliberate write carries an older observation stamp.
    const proposal = structuredClone(baseline);
    proposal.byAccountId.acc_1 = entry(4_500,30);
    await saveQuotaCache(proposal, baseline);
    // The raced key is not the baseline entry the caller saw, so the merge
    // must keep the newer observation instead of re-stamping the older one
    // past it.
    const final = await loadQuotaCache();
    expect(final.byAccountId.acc_1?.primary.usedPercent).toBe(90);
    expect(final.byAccountId.acc_1?.updatedAt).toBe(5_000);
  });

  it("does not bump an older observation over a concurrent one it never saw", async () => {
    // Two probes with independent module instances (separate write queues)
    // observe the same account; the older observation saves after the newer.
    const first = await import("../lib/quota-cache.js");
    vi.resetModules();
    const second = await import("../lib/quota-cache.js");
    const entry = (updatedAt: number, usedPercent: number) => ({updatedAt,status:200,model:"fixture",primary:{usedPercent},secondary:{}});
    const olderBase = await first.loadQuotaCache();
    const newerBase = await second.loadQuotaCache();
    const newer = structuredClone(newerBase);
    newer.byAccountId.acc_1 = entry(5_000,90);
    const older = structuredClone(olderBase);
    older.byAccountId.acc_1 = entry(4_000,30);
    await second.saveQuotaCache(newer, newerBase);
    await first.saveQuotaCache(older, olderBase);
    const final = await first.loadQuotaCache();
    expect(final.byAccountId.acc_1?.primary.usedPercent).toBe(90);
    expect(final.byAccountId.acc_1?.updatedAt).toBe(5_000);
  });

  it("resolves an equal-timestamp race to the later save", async () => {
    const {loadQuotaCache,saveQuotaCache} = await import("../lib/quota-cache.js");
    const entry = (updatedAt: number, usedPercent: number) => ({updatedAt,status:200,model:"fixture",primary:{usedPercent},secondary:{}});
    await saveQuotaCache({byAccountId:{acc_1:entry(5_000,10)},byEmail:{}});
    const baseline = await loadQuotaCache();
    // A concurrent writer lands a different observation at the SAME stamp.
    await saveQuotaCache({byAccountId:{acc_1:entry(5_000,90)},byEmail:{}});
    const proposal = structuredClone(baseline);
    proposal.byAccountId.acc_1 = entry(5_000,30);
    await saveQuotaCache(proposal, baseline);
    // Ties keep the `>=` winner semantics: the later save wins.
    expect((await loadQuotaCache()).byAccountId.acc_1?.primary.usedPercent).toBe(30);
  });

});
