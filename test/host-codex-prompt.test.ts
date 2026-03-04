import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("host-codex-prompt", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("getHostCodexPrompt", () => {
    it("fetches fresh content when no cache exists", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("Fresh prompt content"),
        headers: new Map([["etag", '"abc123"']]),
      });

      const result = await getHostCodexPrompt();
      
      expect(result).toBe("Fresh prompt content");
      expect(mockFetch).toHaveBeenCalled();
      expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("uses cache when TTL not expired", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile)
        .mockResolvedValueOnce("Cached content")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 1000,
        }));

      const result = await getHostCodexPrompt();
      
      expect(result).toBe("Cached content");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("migrates legacy cache filenames into host-codex cache files", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("host-codex-prompt")) {
          throw new Error("ENOENT");
        }
        if (file.includes("opencode-codex-prompt-meta.json")) {
          return JSON.stringify({
            etag: '"legacy-etag"',
            lastChecked: Date.now() - 1000,
          });
        }
        if (file.includes("opencode-codex-prompt.txt")) {
          return "Legacy cached content";
        }
        throw new Error("ENOENT");
      });

      const result = await getHostCodexPrompt();

      expect(result).toBe("Legacy cached content");
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("host-codex-prompt.txt"),
        "Legacy cached content",
        "utf-8",
      );
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("host-codex-prompt-meta.json"),
        expect.stringContaining("legacy-etag"),
        "utf-8",
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("keeps working when legacy migration write partially fails", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("host-codex-prompt")) {
          throw new Error("ENOENT");
        }
        if (file.includes("opencode-codex-prompt-meta.json")) {
          return JSON.stringify({
            etag: '"legacy-etag"',
            lastChecked: Date.now() - 1000,
          });
        }
        if (file.includes("opencode-codex-prompt.txt")) {
          return "Legacy cached content";
        }
        throw new Error("ENOENT");
      });

      const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
      vi.mocked(writeFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("host-codex-prompt-meta.json") && file.includes(".tmp")) {
          throw busy;
        }
      });

      const result = await getHostCodexPrompt();

      expect(result).toBe("Legacy cached content");
      expect(writeFile).toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(rm).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses ETag for conditional request when cache expired", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile)
        .mockResolvedValueOnce("Cached content")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Map(),
      });

      const result = await getHostCodexPrompt();
      
      expect(result).toBe("Cached content");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { "If-None-Match": '"old-etag"' },
        })
      );
    });

    it("does not trust cached sourceUrl for refetch ordering", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce("Cached content")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          sourceUrl: "https://example.com/prompt.txt",
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Map(),
      });

      const result = await getHostCodexPrompt();

      expect(result).toBe("Cached content");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(String(mockFetch.mock.calls[0]?.[0])).toContain("raw.githubusercontent.com");
      expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: {} }));
    });

    it("falls back to next source when first source returns 404", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("Prompt from fallback source"),
          headers: new Map([["etag", '"fallback-etag"']]),
        });

      const result = await getHostCodexPrompt();

      expect(result).toBe("Prompt from fallback source");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]?.[0]).not.toBe(mockFetch.mock.calls[1]?.[0]);
      expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("falls back to next source when first source times out", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch
        .mockRejectedValueOnce(Object.assign(new Error("request timeout"), { name: "AbortError" }))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("Prompt from timeout fallback source"),
          headers: new Map([["etag", '"fallback-timeout-etag"']]),
        });

      const result = await getHostCodexPrompt();

      expect(result).toBe("Prompt from timeout fallback source");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]?.[0]).not.toBe(mockFetch.mock.calls[1]?.[0]);
    });

    it("times out first source after 15s and then falls back deterministically", async () => {
      vi.useFakeTimers();
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      mockFetch
        .mockImplementationOnce((_url, init) => new Promise((_, reject) => {
          const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            const reason = signal.reason;
            if (reason instanceof Error) {
              reject(reason);
              return;
            }
            reject(Object.assign(new Error("request timeout"), { name: "AbortError" }));
          }, { once: true });
        }))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("Prompt from timeout fallback source"),
          headers: new Map([["etag", '"fallback-timeout-etag"']]),
        });

      try {
        const resultPromise = getHostCodexPrompt();
        await vi.advanceTimersByTimeAsync(15_100);
        await expect(resultPromise).resolves.toBe("Prompt from timeout fallback source");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps stale-cache concurrent callers deterministic during timeout fallback refresh", async () => {
      vi.useFakeTimers();
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      vi.mocked(readFile)
        .mockResolvedValueOnce("Old cached content")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch
        .mockImplementationOnce((_url, init) => new Promise((_, reject) => {
          const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            const reason = signal.reason;
            if (reason instanceof Error) {
              reject(reason);
              return;
            }
            reject(Object.assign(new Error("request timeout"), { name: "AbortError" }));
          }, { once: true });
        }))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("Prompt from timeout fallback source"),
          headers: new Map([["etag", '"fallback-timeout-etag"']]),
        });

      try {
        const [first, second] = await Promise.all([getHostCodexPrompt(), getHostCodexPrompt()]);
        expect(first).toBe("Old cached content");
        expect(["Old cached content", "Prompt from timeout fallback source"]).toContain(second);
        await vi.advanceTimersByTimeAsync(15_100);
        expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses CODEX_CODEX_PROMPT_URL override before default sources", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      vi.stubEnv("CODEX_CODEX_PROMPT_URL", "https://example.com/custom-codex.txt");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("Prompt from env override"),
        headers: new Map([["etag", '"env-etag"']]),
      });

      const result = await getHostCodexPrompt();

      expect(result).toBe("Prompt from env override");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[0]).toBe("https://example.com/custom-codex.txt");
    });

    it("does not persist raw override URL query parameters in cache metadata", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      vi.stubEnv(
        "CODEX_PROMPT_SOURCE_URL",
        "https://example.com/custom-codex.txt?token=secret123&state=abc",
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("Prompt from env override"),
        headers: new Map([["etag", '"env-etag"']]),
      });

      await getHostCodexPrompt();

      const metaCall = vi.mocked(writeFile).mock.calls.find((call) =>
        typeof call[0] === "string" && call[0].includes("host-codex-prompt-meta.json")
      );
      const metaText = String(metaCall?.[1] ?? "");
      expect(metaText).toContain("\"sourceKey\": \"https://example.com/custom-codex.txt\"");
      expect(metaText).not.toContain("token=secret123");
      expect(metaText).not.toContain("state=abc");
    });

    it("serves stale content immediately and refreshes cache in background", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile)
        .mockResolvedValueOnce("Old cached content")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));
      
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("New content"),
        headers: new Map([["etag", '"new-etag"']]),
      });

      const first = await getHostCodexPrompt();
      
      expect(first).toBe("Old cached content");
      await vi.waitFor(() =>
        expect(writeFile).toHaveBeenCalledWith(
          expect.stringContaining("host-codex-prompt.txt"),
          "New content",
          "utf-8"
        )
      );
      await vi.waitFor(async () => {
        await expect(getHostCodexPrompt()).resolves.toBe("New content");
      });
    });

    it("deduplicates stale refresh calls when requested concurrently", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      const staleMeta = JSON.stringify({
        etag: '"old-etag"',
        lastChecked: Date.now() - 20 * 60 * 1000,
      });
      vi.mocked(readFile).mockImplementation(async (filePath) => {
        if (String(filePath).includes("host-codex-prompt-meta.json")) {
          return staleMeta;
        }
        return "Old cached content";
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("New content"),
        headers: new Map([["etag", '"new-etag"']]),
      });

      const [first, second] = await Promise.all([getHostCodexPrompt(), getHostCodexPrompt()]);
      expect(first).toBe("Old cached content");
      expect(["Old cached content", "New content"]).toContain(second);

      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(writeFile).toHaveBeenCalledWith(
          expect.stringContaining("host-codex-prompt.txt"),
          "New content",
          "utf-8"
        )
      );
    });

    it("falls back to cache on network error", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile)
        .mockResolvedValueOnce("Cached fallback content")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));
      
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await getHostCodexPrompt();
      
      expect(result).toBe("Cached fallback content");
    });

    it("throws when no cache and fetch fails", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockRejectedValue(new Error("Network error"));

      await expect(getHostCodexPrompt()).rejects.toThrow(
        "Failed to fetch codex.txt and no cache available"
      );
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it("retries transient EBUSY cache write errors and succeeds", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
      vi.mocked(writeFile)
        .mockRejectedValueOnce(busy)
        .mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("Fresh prompt content"),
        headers: new Map([["etag", '"abc123"']]),
      });

      const result = await getHostCodexPrompt();
      expect(result).toBe("Fresh prompt content");
      expect(writeFile).toHaveBeenCalled();
    });

    it("falls back to cache on non-OK response", async () => {
      const { getHostCodexPrompt } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile)
        .mockResolvedValueOnce("Cached content for 500")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Map(),
      });

      const result = await getHostCodexPrompt();
      
      expect(result).toBe("Cached content for 500");
    });
  });

  describe("getCachedPromptPrefix", () => {
    it("returns first N characters of cached content", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile).mockResolvedValue("This is a long cached prompt content");

      const result = await getCachedPromptPrefix(10);
      
      expect(result).toBe("This is a ");
    });

    it("returns null when cache does not exist", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/host-codex-prompt.js");
      
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      const result = await getCachedPromptPrefix();
      
      expect(result).toBeNull();
    });

    it("uses default of 50 characters", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/host-codex-prompt.js");
      
      const longContent = "A".repeat(100);
      vi.mocked(readFile).mockResolvedValue(longContent);

      const result = await getCachedPromptPrefix();
      
      expect(result).toBe("A".repeat(50));
    });
  });
});

