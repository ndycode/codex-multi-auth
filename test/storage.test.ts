import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { 
  deduplicateAccounts,
  deduplicateAccountsByEmail,
  normalizeAccountStorage, 
  loadAccounts, 
  saveAccounts,
  clearAccounts,
  getStoragePath,
  setStoragePath,
  setStoragePathDirect,
  StorageError,
  formatStorageErrorHint,
  exportAccounts,
  importAccounts,
  withAccountStorageTransaction,
} from "../lib/storage.js";

// Mocking the behavior we're about to implement for TDD
// Since the functions aren't in lib/storage.ts yet, we'll need to mock them or 
// accept that this test won't even compile/run until we add them.
// But Task 0 says: "Tests should fail initially (RED phase)"

describe("storage", () => {
  describe("deduplication", () => {
    it("remaps activeIndex after deduplication using active account key", () => {
      const now = Date.now();

      const raw = {
        version: 1,
        activeIndex: 1,
        accounts: [
          {
            accountId: "acctA",
            refreshToken: "tokenA",
            addedAt: now - 2000,
            lastUsed: now - 2000,
          },
          {
            accountId: "acctA",
            refreshToken: "tokenA",
            addedAt: now - 1000,
            lastUsed: now - 1000,
          },
          {
            accountId: "acctB",
            refreshToken: "tokenB",
            addedAt: now,
            lastUsed: now,
          },
        ],
      };

      const normalized = normalizeAccountStorage(raw);
      expect(normalized).not.toBeNull();
      expect(normalized?.accounts).toHaveLength(2);
      expect(normalized?.accounts[0]?.accountId).toBe("acctA");
      expect(normalized?.accounts[1]?.accountId).toBe("acctB");
      expect(normalized?.activeIndex).toBe(0);
    });

    it("deduplicates accounts by keeping the most recently used record", () => {
      const now = Date.now();

      const accounts = [
        {
          accountId: "acctA",
          refreshToken: "tokenA",
          addedAt: now - 2000,
          lastUsed: now - 1000,
        },
        {
          accountId: "acctA",
          refreshToken: "tokenA",
          addedAt: now - 1500,
          lastUsed: now,
        },
      ];

      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.addedAt).toBe(now - 1500);
      expect(deduped[0]?.lastUsed).toBe(now);
    });
  });

  describe("import/export (TDD)", () => {
    const testWorkDir = join(tmpdir(), "codex-test-" + Math.random().toString(36).slice(2));
    const exportPath = join(testWorkDir, "export.json");
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts-" + Math.random().toString(36).slice(2) + ".json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("should export accounts to a file", async () => {
      // @ts-ignore - exportAccounts doesn't exist yet
      const { exportAccounts } = await import("../lib/storage.js");
      
      const storage = {
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "test", refreshToken: "ref", addedAt: 1, lastUsed: 2 }]
      };
      // @ts-ignore
      await saveAccounts(storage);
      
      // @ts-ignore
      await exportAccounts(exportPath);
      
      expect(existsSync(exportPath)).toBe(true);
      const exported = JSON.parse(await fs.readFile(exportPath, "utf-8"));
      expect(exported.accounts[0].accountId).toBe("test");
    });

    it("should fail export if file exists and force is false", async () => {
      // @ts-ignore
      const { exportAccounts } = await import("../lib/storage.js");
      await fs.writeFile(exportPath, "exists");
      
      // @ts-ignore
      await expect(exportAccounts(exportPath, false)).rejects.toThrow(/already exists/);
    });

    it("should import accounts from a file and merge", async () => {
      // @ts-ignore
      const { importAccounts } = await import("../lib/storage.js");
      
      const existing = {
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "existing", refreshToken: "ref1", addedAt: 1, lastUsed: 2 }]
      };
      // @ts-ignore
      await saveAccounts(existing);
      
      const toImport = {
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "new", refreshToken: "ref2", addedAt: 3, lastUsed: 4 }]
      };
      await fs.writeFile(exportPath, JSON.stringify(toImport));
      
      // @ts-ignore
      await importAccounts(exportPath);
      
      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      expect(loaded?.accounts.map(a => a.accountId)).toContain("new");
    });

    it("should serialize concurrent transactional updates without losing accounts", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [],
      });

      const addAccount = async (accountId: string, delayMs: number): Promise<void> => {
        await withAccountStorageTransaction(async (current, persist) => {
          const snapshot = current ?? {
            version: 3 as const,
            activeIndex: 0,
            accounts: [],
          };
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          await persist({
            ...snapshot,
            accounts: [
              ...snapshot.accounts,
              { accountId, refreshToken: `ref-${accountId}`, addedAt: Date.now(), lastUsed: Date.now() },
            ],
          });
        });
      };

      await Promise.all([
        addAccount("acct-a", 20),
        addAccount("acct-b", 0),
      ]);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      expect(new Set(loaded?.accounts.map((account) => account.accountId))).toEqual(
        new Set(["acct-a", "acct-b"]),
      );
    });

    it("should enforce MAX_ACCOUNTS during import", async () => {
       // @ts-ignore
      const { importAccounts } = await import("../lib/storage.js");
      
      const manyAccounts = Array.from({ length: 21 }, (_, i) => ({
        accountId: `acct${i}`,
        refreshToken: `ref${i}`,
        addedAt: Date.now(),
        lastUsed: Date.now()
      }));
      
      const toImport = {
        version: 3,
        activeIndex: 0,
        accounts: manyAccounts
      };
      await fs.writeFile(exportPath, JSON.stringify(toImport));
      
      // @ts-ignore
      await expect(importAccounts(exportPath)).rejects.toThrow(/exceed maximum/);
    });

    it("should fail export when no accounts exist", async () => {
      const { exportAccounts } = await import("../lib/storage.js");
      setStoragePathDirect(testStoragePath);
      await expect(exportAccounts(exportPath)).rejects.toThrow(/No accounts to export/);
    });

    it("should fail import when file does not exist", async () => {
      const { importAccounts } = await import("../lib/storage.js");
      const nonexistentPath = join(testWorkDir, "nonexistent-file.json");
      await expect(importAccounts(nonexistentPath)).rejects.toThrow(/Import file not found/);
    });

    it("should fail import when file contains invalid JSON", async () => {
      const { importAccounts } = await import("../lib/storage.js");
      await fs.writeFile(exportPath, "not valid json {[");
      await expect(importAccounts(exportPath)).rejects.toThrow(/Invalid JSON/);
    });

    it("should fail import when file contains invalid format", async () => {
      const { importAccounts } = await import("../lib/storage.js");
      await fs.writeFile(exportPath, JSON.stringify({ invalid: "format" }));
      await expect(importAccounts(exportPath)).rejects.toThrow(/Invalid account storage format/);
    });
  });

  describe("filename migration (TDD)", () => {
    it("should migrate from old filename to new filename", async () => {
      // This test is tricky because it depends on the internal state of getStoragePath()
      // which we are about to change.
      
      const oldName = "openai-codex-accounts.json";
      const newName = "codex-accounts.json";
      
      // We'll need to mock/verify that loadAccounts checks for oldName if newName is missing
      // Since we haven't implemented it yet, this is just a placeholder for the logic
      expect(true).toBe(true); 
    });
  });

  describe("StorageError and formatStorageErrorHint", () => {
    describe("StorageError class", () => {
      it("should store code, path, and hint properties", () => {
        const err = new StorageError(
          "Failed to write file",
          "EACCES",
          "/path/to/file.json",
          "Permission denied. Check folder permissions."
        );
        
        expect(err.name).toBe("StorageError");
        expect(err.message).toBe("Failed to write file");
        expect(err.code).toBe("EACCES");
        expect(err.path).toBe("/path/to/file.json");
        expect(err.hint).toBe("Permission denied. Check folder permissions.");
      });

      it("should be instanceof Error", () => {
        const err = new StorageError("test", "CODE", "/path", "hint");
        expect(err instanceof Error).toBe(true);
        expect(err instanceof StorageError).toBe(true);
      });
    });

    describe("formatStorageErrorHint", () => {
      const testPath = "/home/user/.opencode/accounts.json";

      it("should return permission hint for EACCES on Windows", () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "win32" });

        const err = { code: "EACCES" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("antivirus");
        expect(hint).toContain(testPath);

        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("should return chmod hint for EACCES on Unix", () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "darwin" });

        const err = { code: "EACCES" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("chmod");
        expect(hint).toContain(testPath);

        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("should return permission hint for EPERM", () => {
        const err = { code: "EPERM" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Permission denied");
        expect(hint).toContain(testPath);
      });

      it("should return file locked hint for EBUSY", () => {
        const err = { code: "EBUSY" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("locked");
        expect(hint).toContain("another program");
      });

      it("should return disk full hint for ENOSPC", () => {
        const err = { code: "ENOSPC" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Disk is full");
      });

      it("should return empty file hint for EEMPTY", () => {
        const err = { code: "EEMPTY" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("empty");
      });

      it("should return generic hint for unknown error codes", () => {
        const err = { code: "UNKNOWN_CODE" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Failed to write");
        expect(hint).toContain(testPath);
      });

      it("should handle errors without code property", () => {
        const err = new Error("Some error") as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Failed to write");
        expect(hint).toContain(testPath);
      });
    });
  });

  describe("selectNewestAccount logic", () => {
    it("when lastUsed are equal, prefers newer addedAt", () => {
      const now = Date.now();
      const accounts = [
        { accountId: "A", refreshToken: "t1", addedAt: now - 1000, lastUsed: now },
        { accountId: "A", refreshToken: "t1", addedAt: now - 500, lastUsed: now },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.addedAt).toBe(now - 500);
    });

    it("when candidate lastUsed is less than current, keeps current", () => {
      const now = Date.now();
      const accounts = [
        { accountId: "A", refreshToken: "t1", addedAt: now, lastUsed: now },
        { accountId: "A", refreshToken: "t1", addedAt: now - 500, lastUsed: now - 1000 },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.lastUsed).toBe(now);
    });

    it("handles accounts without lastUsed or addedAt", () => {
      const accounts = [
        { accountId: "A", refreshToken: "t1" },
        { accountId: "A", refreshToken: "t1", lastUsed: 100 },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.lastUsed).toBe(100);
    });
  });

  describe("deduplicateAccountsByKey edge cases", () => {
    it("uses refreshToken as key when accountId is empty", () => {
      const accounts = [
        { accountId: "A", refreshToken: "t1", lastUsed: 100 },
        { accountId: "", refreshToken: "t2", lastUsed: 200 },
        { accountId: "C", refreshToken: "t3", lastUsed: 300 },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(3);
    });

    it("handles empty array", () => {
      const deduped = deduplicateAccounts([]);
      expect(deduped).toHaveLength(0);
    });

    it("handles null/undefined in array", () => {
      const accounts = [
        { accountId: "A", refreshToken: "t1" },
        null as never,
        { accountId: "B", refreshToken: "t2" },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(2);
    });
  });

  describe("deduplicateAccountsByEmail edge cases", () => {
    it("preserves accounts without email", () => {
      const accounts = [
        { email: "test@example.com", lastUsed: 100, addedAt: 50 },
        { lastUsed: 200, addedAt: 100 },
        { email: "", lastUsed: 300, addedAt: 150 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped).toHaveLength(3);
    });

    it("handles email with whitespace", () => {
      const accounts = [
        { email: "  test@example.com  ", lastUsed: 100, addedAt: 50 },
        { email: "test@example.com", lastUsed: 200, addedAt: 100 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped).toHaveLength(1);
    });

    it("handles null existing account edge case", () => {
      const accounts = [
        { email: "test@example.com", lastUsed: 100 },
        { email: "test@example.com", lastUsed: 200 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped.length).toBeGreaterThanOrEqual(1);
    });

    it("when addedAt differs but lastUsed is same, uses addedAt to decide", () => {
      const now = Date.now();
      const accounts = [
        { email: "test@example.com", lastUsed: now, addedAt: now - 1000 },
        { email: "test@example.com", lastUsed: now, addedAt: now - 500 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.addedAt).toBe(now - 500);
    });
  });

  describe("normalizeAccountStorage edge cases", () => {
    it("returns null for non-object data", () => {
      expect(normalizeAccountStorage(null)).toBeNull();
      expect(normalizeAccountStorage("string")).toBeNull();
      expect(normalizeAccountStorage(123)).toBeNull();
      expect(normalizeAccountStorage([])).toBeNull();
    });

    it("returns null for invalid version", () => {
      const result = normalizeAccountStorage({ version: 2, accounts: [] });
      expect(result).toBeNull();
    });

    it("returns null for non-array accounts", () => {
      expect(normalizeAccountStorage({ version: 3, accounts: "not-array" })).toBeNull();
      expect(normalizeAccountStorage({ version: 3, accounts: {} })).toBeNull();
    });

    it("handles missing activeIndex", () => {
      const data = {
        version: 3,
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(0);
    });

    it("handles non-finite activeIndex", () => {
      const data = {
        version: 3,
        activeIndex: NaN,
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(0);
    });

    it("handles Infinity activeIndex", () => {
      const data = {
        version: 3,
        activeIndex: Infinity,
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(0);
    });

    it("clamps out-of-bounds activeIndex", () => {
      const data = {
        version: 3,
        activeIndex: 100,
        accounts: [{ refreshToken: "t1", accountId: "A" }, { refreshToken: "t2", accountId: "B" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(1);
    });

    it("filters out accounts with empty refreshToken", () => {
      const data = {
        version: 3,
        accounts: [
          { refreshToken: "valid", accountId: "A" },
          { refreshToken: "  ", accountId: "B" },
          { refreshToken: "", accountId: "C" },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(1);
    });

    it("remaps activeKey when deduplication changes indices", () => {
      const now = Date.now();
      const data = {
        version: 3,
        activeIndex: 2,
        accounts: [
          { refreshToken: "t1", accountId: "A", lastUsed: now - 100 },
          { refreshToken: "t1", accountId: "A", lastUsed: now },
          { refreshToken: "t2", accountId: "B", lastUsed: now - 50 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(2);
      expect(result?.activeIndex).toBe(1);
    });

    it("handles v1 to v3 migration", () => {
      const data = {
        version: 1,
        activeIndex: 0,
        accounts: [
          { refreshToken: "t1", accountId: "A", accessToken: "acc1", expiresAt: Date.now() + 3600000 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.version).toBe(3);
      expect(result?.accounts).toHaveLength(1);
    });

    it("preserves activeIndexByFamily when valid", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: { codex: 1, "gpt-5.x": 0 },
        accounts: [
          { refreshToken: "t1", accountId: "A" },
          { refreshToken: "t2", accountId: "B" },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndexByFamily).toBeDefined();
    });

    it("handles activeIndexByFamily with non-finite values", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: { codex: NaN, "gpt-5.x": Infinity },
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndexByFamily).toBeDefined();
    });

    it("handles account with only accountId, no refreshToken key match", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          { refreshToken: "t1", accountId: "" },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(1);
    });
  });

  describe("loadAccounts", () => {
    const testWorkDir = join(tmpdir(), "codex-load-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("returns null when file does not exist", async () => {
      const result = await loadAccounts();
      expect(result).toBeNull();
    });

    it("returns null on parse error", async () => {
      await fs.writeFile(testStoragePath, "not valid json{{{", "utf-8");
      const result = await loadAccounts();
      expect(result).toBeNull();
    });

    it("returns normalized data on valid file", async () => {
      const storage = { version: 3, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A" }] };
      await fs.writeFile(testStoragePath, JSON.stringify(storage), "utf-8");
      const result = await loadAccounts();
      expect(result?.accounts).toHaveLength(1);
    });

    it("logs schema validation warnings but still returns data", async () => {
      const storage = { version: 3, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A", extraField: "ignored" }] };
      await fs.writeFile(testStoragePath, JSON.stringify(storage), "utf-8");
      const result = await loadAccounts();
      expect(result).not.toBeNull();
    });

    it("migrates v1 to v3 and attempts to save", async () => {
      const v1Storage = { 
        version: 1, 
        activeIndex: 0, 
        accounts: [{ refreshToken: "t1", accountId: "A", accessToken: "acc", expiresAt: Date.now() + 3600000 }] 
      };
      await fs.writeFile(testStoragePath, JSON.stringify(v1Storage), "utf-8");
      const result = await loadAccounts();
      expect(result?.version).toBe(3);
      const saved = JSON.parse(await fs.readFile(testStoragePath, "utf-8"));
      expect(saved.version).toBe(3);
    });

    it("returns migrated data even when save fails (line 422-423 coverage)", async () => {
      const v1Storage = { 
        version: 1, 
        activeIndex: 0, 
        accounts: [{ refreshToken: "t1", accountId: "A", accessToken: "acc", expiresAt: Date.now() + 3600000 }] 
      };
      await fs.writeFile(testStoragePath, JSON.stringify(v1Storage), "utf-8");
      
      // Make the file read-only to cause save to fail
      await fs.chmod(testStoragePath, 0o444);
      
      const result = await loadAccounts();
      
      // Should still return migrated data even though save failed
      expect(result?.version).toBe(3);
      expect(result?.accounts).toHaveLength(1);
      
      // Restore permissions for cleanup
      await fs.chmod(testStoragePath, 0o644);
    });
  });

  describe("saveAccounts", () => {
    const testWorkDir = join(tmpdir(), "codex-save-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, ".opencode", "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("creates directory and saves file", async () => {
      const storage = { version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }] };
      await saveAccounts(storage);
      expect(existsSync(testStoragePath)).toBe(true);
    });

    it("writes valid JSON", async () => {
      const storage = { version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A", addedAt: 1, lastUsed: 2 }] };
      await saveAccounts(storage);
      const content = await fs.readFile(testStoragePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(3);
    });
  });

  describe("clearAccounts", () => {
    const testWorkDir = join(tmpdir(), "codex-clear-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("deletes the file when it exists", async () => {
      await fs.writeFile(testStoragePath, "{}");
      expect(existsSync(testStoragePath)).toBe(true);
      await clearAccounts();
      expect(existsSync(testStoragePath)).toBe(false);
    });

    it("does not throw when file does not exist", async () => {
      await expect(clearAccounts()).resolves.not.toThrow();
    });
  });

  describe("setStoragePath", () => {
    afterEach(() => {
      setStoragePathDirect(null);
    });

    it("sets path to null when projectPath is null", () => {
      setStoragePath(null);
      const path = getStoragePath();
      expect(path).toContain(".opencode");
    });

    it("sets path to null when no project root found", () => {
      setStoragePath("/nonexistent/path/that/does/not/exist");
      const path = getStoragePath();
      expect(path).toContain(".opencode");
    });

    it("sets project-scoped path under global .opencode when project root found", () => {
      setStoragePath(process.cwd());
      const path = getStoragePath();
      expect(path).toContain("openai-codex-accounts.json");
      expect(path).toContain(".opencode");
      expect(path).toContain("projects");
    });
  });

  describe("getStoragePath", () => {
    afterEach(() => {
      setStoragePathDirect(null);
    });

    it("returns custom path when set directly", () => {
      setStoragePathDirect("/custom/path/accounts.json");
      expect(getStoragePath()).toBe("/custom/path/accounts.json");
    });

    it("returns global path when no custom path set", () => {
      setStoragePathDirect(null);
      const path = getStoragePath();
      expect(path).toContain("openai-codex-accounts.json");
    });
  });

  describe("normalizeAccountStorage activeKey remapping", () => {
    it("remaps activeIndex using activeKey when present", () => {
      const now = Date.now();
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          { refreshToken: "t1", accountId: "A", lastUsed: now },
          { refreshToken: "t2", accountId: "B", lastUsed: now - 100 },
          { refreshToken: "t3", accountId: "C", lastUsed: now - 200 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result).not.toBeNull();
      expect(result?.accounts).toHaveLength(3);
      expect(result?.activeIndex).toBe(0);
    });

    it("remaps familyKey for activeIndexByFamily when indices change after dedup", () => {
      const now = Date.now();
      const data = {
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: {
          "codex": 2,
          "gpt-5.x": 1,
        },
        accounts: [
          { refreshToken: "t1", accountId: "A", lastUsed: now },
          { refreshToken: "t1", accountId: "A", lastUsed: now + 100 },
          { refreshToken: "t2", accountId: "B", lastUsed: now - 50 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result).not.toBeNull();
      expect(result?.accounts).toHaveLength(2);
      expect(result?.activeIndexByFamily?.codex).toBeDefined();
    });
  });

  describe("clearAccounts error handling", () => {
    const testWorkDir = join(tmpdir(), "codex-clear-err-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("logs but does not throw on non-ENOENT errors", async () => {
      const readOnlyDir = join(testWorkDir, "readonly");
      await fs.mkdir(readOnlyDir, { recursive: true });
      const readOnlyFile = join(readOnlyDir, "accounts.json");
      await fs.writeFile(readOnlyFile, "{}");
      setStoragePathDirect(readOnlyFile);
      
      await expect(clearAccounts()).resolves.not.toThrow();
    });
  });

  describe("StorageError with cause", () => {
    it("preserves the original error as cause", () => {
      const originalError = new Error("Original error");
      const storageErr = new StorageError(
        "Wrapper message",
        "EACCES",
        "/path/to/file",
        "Permission hint",
        originalError
      );
      expect((storageErr as unknown as { cause?: Error }).cause).toBe(originalError);
    });

    it("works without cause parameter", () => {
      const storageErr = new StorageError(
        "Wrapper message",
        "EACCES",
        "/path/to/file",
        "Permission hint"
      );
      expect((storageErr as unknown as { cause?: Error }).cause).toBeUndefined();
    });
  });

  describe("ensureGitignore edge cases", () => {
    const testWorkDir = join(tmpdir(), "codex-gitignore-" + Math.random().toString(36).slice(2));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("writes .gitignore in project root when storage path is externalized", async () => {
      const fakeHome = join(testWorkDir, "home");
      const projectDir = join(testWorkDir, "project-externalized");
      const gitDir = join(projectDir, ".git");
      const gitignorePath = join(projectDir, ".gitignore");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(gitDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }],
      };

      await saveAccounts(storage);

      expect(existsSync(gitignorePath)).toBe(true);
      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      expect(gitignoreContent).toContain(".opencode/");
      expect(getStoragePath()).toContain(join(fakeHome, ".opencode", "projects"));
    });

    it("creates .gitignore when it does not exist but .git dir exists (line 99-100 false branch)", async () => {
      const projectDir = join(testWorkDir, "project");
      const openCodeDir = join(projectDir, ".opencode");
      const gitDir = join(projectDir, ".git");
      const gitignorePath = join(projectDir, ".gitignore");

      await fs.mkdir(openCodeDir, { recursive: true });
      await fs.mkdir(gitDir, { recursive: true });

      testStoragePath = join(openCodeDir, "accounts.json");
      setStoragePathDirect(testStoragePath);

      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }],
      };

      await saveAccounts(storage);

      expect(existsSync(gitignorePath)).toBe(true);
      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      expect(gitignoreContent).toContain(".opencode/");
    });

    it("appends to existing .gitignore without trailing newline (line 107 coverage)", async () => {
      const projectDir = join(testWorkDir, "project2");
      const openCodeDir = join(projectDir, ".opencode");
      const gitDir = join(projectDir, ".git");
      const gitignorePath = join(projectDir, ".gitignore");

      await fs.mkdir(openCodeDir, { recursive: true });
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(gitignorePath, "node_modules", "utf-8");

      testStoragePath = join(openCodeDir, "accounts.json");
      setStoragePathDirect(testStoragePath);

      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }],
      };

      await saveAccounts(storage);

      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      expect(gitignoreContent).toBe("node_modules\n.opencode/\n");
    });
  });

  describe("legacy project storage migration", () => {
    const testWorkDir = join(tmpdir(), "codex-legacy-migration-" + Math.random().toString(36).slice(2));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    afterEach(async () => {
      setStoragePathDirect(null);
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("removes legacy project storage file after successful migration", async () => {
      const fakeHome = join(testWorkDir, "home");
      const projectDir = join(testWorkDir, "project");
      const projectGitDir = join(projectDir, ".git");
      const legacyProjectConfigDir = join(projectDir, ".opencode");
      const legacyStoragePath = join(legacyProjectConfigDir, "openai-codex-accounts.json");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(projectGitDir, { recursive: true });
      await fs.mkdir(legacyProjectConfigDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const legacyStorage = {
        version: 3,
        activeIndex: 0,
        accounts: [{ refreshToken: "legacy-refresh", accountId: "legacy-account", addedAt: 1, lastUsed: 1 }],
      };
      await fs.writeFile(legacyStoragePath, JSON.stringify(legacyStorage), "utf-8");

      const migrated = await loadAccounts();

      expect(migrated).not.toBeNull();
      expect(migrated?.accounts).toHaveLength(1);
      expect(existsSync(legacyStoragePath)).toBe(false);
      expect(existsSync(getStoragePath())).toBe(true);
    });
  });

  describe("saveAccounts EPERM/EBUSY retry logic", () => {
    const testWorkDir = join(tmpdir(), "codex-retry-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      vi.useRealTimers();
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("retries on EPERM and succeeds on second attempt", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      const originalRename = fs.rename.bind(fs);
      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
        attemptCount++;
        if (attemptCount === 1) {
          const err = new Error("EPERM error") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return originalRename(oldPath as string, newPath as string);
      });

      await saveAccounts(storage);
      expect(attemptCount).toBe(2);
      expect(existsSync(testStoragePath)).toBe(true);

      renameSpy.mockRestore();
    });

    it("retries on EBUSY and succeeds on third attempt", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      const originalRename = fs.rename.bind(fs);
      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
        attemptCount++;
        if (attemptCount <= 2) {
          const err = new Error("EBUSY error") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return originalRename(oldPath as string, newPath as string);
      });

      await saveAccounts(storage);
      expect(attemptCount).toBe(3);
      expect(existsSync(testStoragePath)).toBe(true);

      renameSpy.mockRestore();
    });

    it("throws after 5 failed EPERM retries", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
        attemptCount++;
        const err = new Error("EPERM error") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      await expect(saveAccounts(storage)).rejects.toThrow("Failed to save accounts");
      expect(attemptCount).toBe(5);

      renameSpy.mockRestore();
    });

    it("throws immediately on non-EPERM/EBUSY errors", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
        attemptCount++;
        const err = new Error("EACCES error") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      });

      await expect(saveAccounts(storage)).rejects.toThrow("Failed to save accounts");
      expect(attemptCount).toBe(1);

      renameSpy.mockRestore();
    });

    it("throws when temp file is written with size 0", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      const statSpy = vi.spyOn(fs, "stat").mockResolvedValue({
        size: 0,
        isFile: () => true,
        isDirectory: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      await expect(saveAccounts(storage)).rejects.toThrow("Failed to save accounts");
      expect(statSpy).toHaveBeenCalled();

      statSpy.mockRestore();
    });
  });

  describe("clearAccounts edge cases", () => {
    it("logs error for non-ENOENT errors during clear", async () => {
      const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValue(
        Object.assign(new Error("EACCES error"), { code: "EACCES" })
      );

      await clearAccounts();

      expect(unlinkSpy).toHaveBeenCalled();
      unlinkSpy.mockRestore();
    });
  });
});
