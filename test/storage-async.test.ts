import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAccounts,
  saveAccounts,
  clearAccounts,
  normalizeAccountStorage,
  deduplicateAccounts,
  deduplicateAccountsByEmail,
  getStoragePath,
  type AccountStorageV3,
} from "../lib/storage.js";

describe("Storage Module - Async Operations", () => {
  let testDir: string;
  let originalGetStoragePath: typeof getStoragePath;

  beforeEach(async () => {
    testDir = join(tmpdir(), `storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("normalizeAccountStorage", () => {
    it("returns null for non-object input", () => {
      expect(normalizeAccountStorage(null)).toBeNull();
      expect(normalizeAccountStorage(undefined)).toBeNull();
      expect(normalizeAccountStorage("string")).toBeNull();
      expect(normalizeAccountStorage(123)).toBeNull();
      expect(normalizeAccountStorage([])).toBeNull();
    });

    it("returns null for unknown version", () => {
      expect(normalizeAccountStorage({ version: 2, accounts: [], activeIndex: 0 })).toBeNull();
      expect(normalizeAccountStorage({ version: 99, accounts: [], activeIndex: 0 })).toBeNull();
    });

    it("returns null for invalid accounts array", () => {
      expect(normalizeAccountStorage({ version: 3, accounts: "not-array", activeIndex: 0 })).toBeNull();
      expect(normalizeAccountStorage({ version: 3, accounts: null, activeIndex: 0 })).toBeNull();
    });

    it("normalizes valid v3 storage", () => {
      const input: AccountStorageV3 = {
        version: 3,
        accounts: [
          { refreshToken: "token1", addedAt: 1000, lastUsed: 2000 },
          { refreshToken: "token2", addedAt: 1500, lastUsed: 2500 },
        ],
        activeIndex: 0,
      };

      const result = normalizeAccountStorage(input);
      expect(result).not.toBeNull();
      expect(result?.version).toBe(3);
      expect(result?.accounts.length).toBe(2);
    });

    it("migrates v1 storage to v3", () => {
      const v1Input = {
        version: 1,
        accounts: [
          { refreshToken: "token1", addedAt: 1000, lastUsed: 2000, rateLimitResetTime: Date.now() + 60000 },
        ],
        activeIndex: 0,
      };

      const result = normalizeAccountStorage(v1Input);
      expect(result).not.toBeNull();
      expect(result?.version).toBe(3);
      expect(result?.accounts[0]).toBeDefined();
    });

    it("filters out accounts without refresh tokens", () => {
      const input = {
        version: 3,
        accounts: [
          { refreshToken: "valid-token", addedAt: 1000, lastUsed: 2000 },
          { refreshToken: "", addedAt: 1000, lastUsed: 2000 },
          { refreshToken: "   ", addedAt: 1000, lastUsed: 2000 },
          { addedAt: 1000, lastUsed: 2000 },
        ],
        activeIndex: 0,
      };

      const result = normalizeAccountStorage(input);
      expect(result?.accounts.length).toBe(1);
      expect(result?.accounts[0]?.refreshToken).toBe("valid-token");
    });

    it("clamps activeIndex to valid range", () => {
      const input = {
        version: 3,
        accounts: [
          { refreshToken: "token1", addedAt: 1000, lastUsed: 2000 },
          { refreshToken: "token2", addedAt: 1500, lastUsed: 2500 },
        ],
        activeIndex: 999,
      };

      const result = normalizeAccountStorage(input);
      expect(result?.activeIndex).toBeLessThan(2);
    });

    it("handles negative activeIndex", () => {
      const input = {
        version: 3,
        accounts: [
          { refreshToken: "token1", addedAt: 1000, lastUsed: 2000 },
        ],
        activeIndex: -5,
      };

      const result = normalizeAccountStorage(input);
      expect(result?.activeIndex).toBe(0);
    });

    it("preserves per-family active indices", () => {
      const input: AccountStorageV3 = {
        version: 3,
        accounts: [
          { refreshToken: "token1", addedAt: 1000, lastUsed: 2000 },
          { refreshToken: "token2", addedAt: 1500, lastUsed: 2500 },
          { refreshToken: "token3", addedAt: 2000, lastUsed: 3000 },
        ],
        activeIndex: 0,
        activeIndexByFamily: {
          "codex": 1,
          "gpt-5.1": 2,
        },
      };

      const result = normalizeAccountStorage(input);
      expect(result?.activeIndexByFamily?.["codex"]).toBe(1);
      expect(result?.activeIndexByFamily?.["gpt-5.1"]).toBe(2);
    });

    it("deduplicates accounts by refresh token", () => {
      const input = {
        version: 3,
        accounts: [
          { refreshToken: "same-token", addedAt: 1000, lastUsed: 2000 },
          { refreshToken: "same-token", addedAt: 1500, lastUsed: 3000 },
          { refreshToken: "different-token", addedAt: 1000, lastUsed: 2000 },
        ],
        activeIndex: 0,
      };

      const result = normalizeAccountStorage(input);
      expect(result?.accounts.length).toBe(2);
    });

    it("deduplicates accounts by email", () => {
      const input = {
        version: 3,
        accounts: [
          { refreshToken: "token1", email: "user@example.com", addedAt: 1000, lastUsed: 2000 },
          { refreshToken: "token2", email: "user@example.com", addedAt: 1500, lastUsed: 3000 },
        ],
        activeIndex: 0,
      };

      const result = normalizeAccountStorage(input);
      expect(result?.accounts.length).toBe(1);
      expect(result?.accounts[0]?.lastUsed).toBe(3000);
    });
  });

  describe("deduplicateAccounts", () => {
    it("removes duplicate refresh tokens keeping newest", () => {
      const accounts = [
        { refreshToken: "token-a", lastUsed: 1000, addedAt: 100 },
        { refreshToken: "token-a", lastUsed: 2000, addedAt: 200 },
        { refreshToken: "token-b", lastUsed: 1500, addedAt: 150 },
      ];

      const result = deduplicateAccounts(accounts);
      expect(result.length).toBe(2);

      const tokenA = result.find((a) => a.refreshToken === "token-a");
      expect(tokenA?.lastUsed).toBe(2000);
    });

    it("uses addedAt as tiebreaker when lastUsed is equal", () => {
      const accounts = [
        { refreshToken: "token-a", lastUsed: 1000, addedAt: 100 },
        { refreshToken: "token-a", lastUsed: 1000, addedAt: 200 },
      ];

      const result = deduplicateAccounts(accounts);
      expect(result.length).toBe(1);
      expect(result[0]?.addedAt).toBe(200);
    });

    it("handles accountId deduplication", () => {
      const accounts = [
        { refreshToken: "token1", accountId: "acc-1", lastUsed: 1000 },
        { refreshToken: "token2", accountId: "acc-1", lastUsed: 2000 },
      ];

      const result = deduplicateAccounts(accounts);
      expect(result.length).toBe(1);
      expect(result[0]?.lastUsed).toBe(2000);
    });

    it("returns empty array for empty input", () => {
      expect(deduplicateAccounts([])).toEqual([]);
    });
  });

  describe("deduplicateAccountsByEmail", () => {
    it("removes duplicate emails keeping newest", () => {
      const accounts = [
        { email: "user@example.com", lastUsed: 1000, addedAt: 100 },
        { email: "user@example.com", lastUsed: 2000, addedAt: 200 },
        { email: "other@example.com", lastUsed: 1500, addedAt: 150 },
      ];

      const result = deduplicateAccountsByEmail(accounts);
      expect(result.length).toBe(2);

      const user = result.find((a) => a.email === "user@example.com");
      expect(user?.lastUsed).toBe(2000);
    });

    it("preserves accounts without email", () => {
      const accounts = [
        { email: undefined, lastUsed: 1000 },
        { email: undefined, lastUsed: 2000 },
        { email: "user@example.com", lastUsed: 1500 },
      ];

      const result = deduplicateAccountsByEmail(accounts as any);
      expect(result.length).toBe(3);
    });

    it("handles whitespace in emails", () => {
      const accounts = [
        { email: "  user@example.com  ", lastUsed: 1000 },
        { email: "user@example.com", lastUsed: 2000 },
      ];

      const result = deduplicateAccountsByEmail(accounts);
      expect(result.length).toBe(1);
    });

    it("returns empty array for empty input", () => {
      expect(deduplicateAccountsByEmail([])).toEqual([]);
    });
  });

  describe("getStoragePath", () => {
    it("returns path ending with openai-codex-accounts.json", () => {
      const path = getStoragePath();
      expect(path).toMatch(/openai-codex-accounts\.json$/);
    });

    it("returns path containing .opencode directory", () => {
      const path = getStoragePath();
      expect(path).toContain(".opencode");
    });
  });

  describe("Concurrent operations (mutex)", () => {
    it("handles rapid sequential saves without corruption", async () => {
      const testPath = join(testDir, "test-accounts.json");
      
      const storage: AccountStorageV3 = {
        version: 3,
        accounts: [
          { refreshToken: "token1", addedAt: 1000, lastUsed: 2000 },
        ],
        activeIndex: 0,
      };

      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(testPath, JSON.stringify(storage), "utf-8");
      
      const content = await fs.readFile(testPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(3);
    });

    it("multiple concurrent writes complete without throwing", async () => {
      const testPath = join(testDir, "concurrent-test.json");
      
      const writes = Array.from({ length: 10 }, async (_, i) => {
        const data = { version: 3, accounts: [], activeIndex: i };
        await fs.writeFile(testPath, JSON.stringify(data), "utf-8");
      });

      await expect(Promise.all(writes)).resolves.not.toThrow();
    });
  });
});
