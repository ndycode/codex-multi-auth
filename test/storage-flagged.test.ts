import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearFlaggedAccounts,
  getFlaggedAccountsPath,
  getStoragePath,
  loadFlaggedAccounts,
  saveFlaggedAccounts,
  setStoragePathDirect,
} from "../lib/storage.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
  targetPath: string,
  options: { recursive?: boolean; force?: boolean },
): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(targetPath, options);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

describe("flagged account storage", () => {
  const testRoot = join(tmpdir(), `codex-flagged-${Math.random().toString(36).slice(2)}`);
  let storagePath = "";

  beforeEach(async () => {
    await fs.mkdir(testRoot, { recursive: true });
    storagePath = join(testRoot, `accounts-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    setStoragePathDirect(storagePath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setStoragePathDirect(null);
    await removeWithRetry(testRoot, { recursive: true, force: true });
  });

  it("returns an empty flagged storage object when files are absent", async () => {
    const flagged = await loadFlaggedAccounts();
    expect(flagged).toEqual({ version: 1, accounts: [] });
  });

  it("normalizes and de-duplicates flagged accounts on save/load", async () => {
    await saveFlaggedAccounts({
      version: 1,
      accounts: [
        {
          refreshToken: "  duplicate-token  ",
          accountId: "acct-1",
          accountIdSource: "org",
          accountLabel: "work",
          email: "user@example.com",
          enabled: true,
          lastSwitchReason: "rate-limit",
          rateLimitResetTimes: { codex: 12345, invalid: "skip" as never },
          coolingDownUntil: 45678,
          cooldownReason: "auth-failure",
          addedAt: 100,
          lastUsed: 120,
          flaggedAt: 150,
          flaggedReason: "quota",
          lastError: "429",
        },
        {
          refreshToken: "duplicate-token",
          accountId: "acct-2",
          accountIdSource: "manual",
          addedAt: 200,
          lastUsed: 220,
          flaggedAt: 250,
        },
        {
          refreshToken: "",
          flaggedAt: 1,
          addedAt: 1,
          lastUsed: 1,
        } as never,
      ],
    });

    const flagged = await loadFlaggedAccounts();

    expect(flagged.accounts).toHaveLength(1);
    expect(flagged.accounts[0]).toEqual(
      expect.objectContaining({
        refreshToken: "duplicate-token",
        accountId: "acct-2",
        accountIdSource: "manual",
        flaggedAt: 250,
      }),
    );
  });

  it("migrates legacy blocked-account file to flagged-account storage", async () => {
    const legacyPath = join(dirname(getStoragePath()), "openai-codex-blocked-accounts.json");
    await fs.mkdir(dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          accounts: [
            {
              refreshToken: "legacy-token",
              flaggedAt: 999,
              addedAt: 900,
              lastUsed: 950,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const flagged = await loadFlaggedAccounts();

    expect(flagged.accounts).toHaveLength(1);
    expect(flagged.accounts[0]?.refreshToken).toBe("legacy-token");
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(getFlaggedAccountsPath())).toBe(true);
  });

  it("returns empty storage when legacy migration content is invalid", async () => {
    const legacyPath = join(dirname(getStoragePath()), "openai-codex-blocked-accounts.json");
    await fs.mkdir(dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, "not-json", "utf-8");

    const flagged = await loadFlaggedAccounts();

    expect(flagged).toEqual({ version: 1, accounts: [] });
    expect(existsSync(legacyPath)).toBe(true);
  });

  it("clears flagged storage and tolerates missing files", async () => {
    await saveFlaggedAccounts({
      version: 1,
      accounts: [
        {
          refreshToken: "clear-me",
          flaggedAt: 1,
          addedAt: 1,
          lastUsed: 1,
        },
      ],
    });

    expect(existsSync(getFlaggedAccountsPath())).toBe(true);

    await clearFlaggedAccounts();
    await clearFlaggedAccounts();

    expect(existsSync(getFlaggedAccountsPath())).toBe(false);
  });

  it.each(["EPERM", "EBUSY"] as const)(
    "retries transient %s when clearing flagged storage",
    async (code) => {
      await saveFlaggedAccounts({
        version: 1,
        accounts: [
          {
            refreshToken: "retry-me",
            flaggedAt: 1,
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      });

      const flaggedPath = getFlaggedAccountsPath();
      const realUnlink = fs.unlink.bind(fs);
      let failedOnce = false;
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (targetPath) => {
        if (targetPath === flaggedPath && !failedOnce) {
          failedOnce = true;
          const error = new Error("locked") as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return realUnlink(targetPath);
      });

      try {
        await expect(clearFlaggedAccounts()).resolves.toBe(true);
        expect(existsSync(flaggedPath)).toBe(false);
        expect(
          unlinkSpy.mock.calls.filter(([targetPath]) => targetPath === flaggedPath),
        ).toHaveLength(2);
      } finally {
        unlinkSpy.mockRestore();
      }
    },
  );

  it.each(["EPERM", "EBUSY"] as const)(
    "returns false when clearing flagged storage exhausts retryable %s failures",
    async (code) => {
      await saveFlaggedAccounts({
        version: 1,
        accounts: [
          {
            refreshToken: "stuck-flagged",
            flaggedAt: 1,
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      });

      const flaggedPath = getFlaggedAccountsPath();
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (targetPath) => {
        if (targetPath === flaggedPath) {
          const error = new Error("still locked") as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      });

      try {
        await expect(clearFlaggedAccounts()).resolves.toBe(false);
        expect(existsSync(flaggedPath)).toBe(true);
        expect(
          unlinkSpy.mock.calls.filter(([targetPath]) => targetPath === flaggedPath),
        ).toHaveLength(5);
      } finally {
        unlinkSpy.mockRestore();
      }
    },
  );

  it("cleans temporary file when flagged save fails", async () => {
    const flaggedPath = getFlaggedAccountsPath();
    const originalRename = fs.rename.bind(fs);

    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (newPath === flaggedPath) {
        const error = new Error("forced rename failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalRename(oldPath, newPath);
    });

    await expect(
      saveFlaggedAccounts({
        version: 1,
        accounts: [
          {
            refreshToken: "tmp-cleanup",
            flaggedAt: 1,
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      }),
    ).rejects.toThrow("forced rename failure");

    const parent = dirname(flaggedPath);
    const entries = existsSync(parent) ? await fs.readdir(parent) : [];
    const tmpArtifacts = entries.filter((entry) => entry.includes("flagged") && entry.endsWith(".tmp"));
    expect(tmpArtifacts).toHaveLength(0);

    renameSpy.mockRestore();
  });
});
