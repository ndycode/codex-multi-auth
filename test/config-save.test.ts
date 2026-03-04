import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      if (code === "ENOENT") return;
      if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function makeErrnoError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("plugin config save paths", () => {
  let tempDir = "";
  const envKeys = [
    "CODEX_MULTI_AUTH_DIR",
    "CODEX_MULTI_AUTH_CONFIG_PATH",
    "CODEX_HOME",
    "CODEX_AUTH_PARALLEL_PROBING",
    "CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
  ] as const;
  const previousEnv: Partial<
    Record<(typeof envKeys)[number], string | undefined>
  > = {};

  beforeEach(async () => {
    for (const key of envKeys) {
      previousEnv[key] = process.env[key];
    }
    tempDir = await fs.mkdtemp(join(tmpdir(), "codex-config-save-"));
    process.env.CODEX_MULTI_AUTH_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    for (const key of envKeys) {
      const previous = previousEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    vi.restoreAllMocks();
    vi.resetModules();
    if (tempDir) {
      await removeWithRetry(tempDir, { recursive: true, force: true });
    }
  });

  it("merges and sanitizes env-path saves", async () => {
    const configPath = join(tempDir, "plugin-config.json");
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
    await fs.writeFile(
      configPath,
      JSON.stringify({ codexMode: true, preserved: 1 }),
      "utf8",
    );

    const { savePluginConfig } = await import("../lib/config.js");
    await savePluginConfig({
      codexTuiV2: false,
      retryAllAccountsMaxRetries: Number.POSITIVE_INFINITY,
      unsupportedCodexFallbackChain: { "gpt-5": ["gpt-4o"] },
      parallelProbing: undefined,
    });

    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.codexMode).toBe(true);
    expect(parsed.preserved).toBe(1);
    expect(parsed.codexTuiV2).toBe(false);
    expect(parsed.retryAllAccountsMaxRetries).toBeUndefined();
    expect(parsed.parallelProbing).toBeUndefined();
    expect(parsed.unsupportedCodexFallbackChain).toEqual({
      "gpt-5": ["gpt-4o"],
    });
  });

  it("recovers from malformed env-path JSON before saving", async () => {
    const configPath = join(tempDir, "plugin-config.json");
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, "{ malformed", "utf8");

    const { savePluginConfig } = await import("../lib/config.js");
    await savePluginConfig({ codexMode: false, fastSession: true });

    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.codexMode).toBe(false);
    expect(parsed.fastSession).toBe(true);
  });

  it("retries transient read contention before saving env-path config", async () => {
    const configPath = join(tempDir, "plugin-config.json");
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, JSON.stringify({ codexMode: true }), "utf8");

    const originalReadFile = fs.readFile.bind(fs);
    let busyFailures = 0;
    const readSpy = vi.spyOn(fs, "readFile");
    readSpy.mockImplementation(async (...args) => {
      const target = args[0];
      const path = typeof target === "string" ? target : String(target);
      if (path === configPath && busyFailures < 2) {
        busyFailures += 1;
        throw makeErrnoError("busy", "EBUSY");
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>));
    });

    const { savePluginConfig } = await import("../lib/config.js");
    try {
      await savePluginConfig({ codexMode: false, retries: 3 });
    } finally {
      readSpy.mockRestore();
    }

    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.codexMode).toBe(false);
    expect(parsed.retries).toBe(3);
    expect(busyFailures).toBe(2);
  });

  it("retries optimistic config conflicts and eventually succeeds", async () => {
    const configPath = join(tempDir, "plugin-config.json");
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, JSON.stringify({ seed: "a" }), "utf8");

    const originalReadFile = fs.readFile.bind(fs);
    let configReadCount = 0;
    const readSpy = vi.spyOn(fs, "readFile");
    readSpy.mockImplementation(async (...args) => {
      const target = args[0];
      const path = typeof target === "string" ? target : String(target);
      if (path === configPath) {
        configReadCount += 1;
        if (configReadCount === 2) return JSON.stringify({ seed: "b" });
        if (configReadCount === 3) return JSON.stringify({ seed: "b" });
        if (configReadCount === 4) return JSON.stringify({ seed: "c" });
        if (configReadCount === 5) return JSON.stringify({ seed: "c" });
        if (configReadCount === 6) return JSON.stringify({ seed: "c" });
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>));
    });

    const { savePluginConfig } = await import("../lib/config.js");
    try {
      await savePluginConfig({ codexMode: false });
    } finally {
      readSpy.mockRestore();
    }

    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.seed).toBe("c");
    expect(parsed.codexMode).toBe(false);
    expect(configReadCount).toBeGreaterThanOrEqual(6);
  });

  it("throws after exhausting optimistic config conflict retries", async () => {
    const configPath = join(tempDir, "plugin-config.json");
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, JSON.stringify({ seed: "a" }), "utf8");

    const originalReadFile = fs.readFile.bind(fs);
    let configReadCount = 0;
    const readSpy = vi.spyOn(fs, "readFile");
    readSpy.mockImplementation(async (...args) => {
      const target = args[0];
      const path = typeof target === "string" ? target : String(target);
      if (path === configPath) {
        configReadCount += 1;
        if (configReadCount === 2) return JSON.stringify({ seed: "b" });
        if (configReadCount === 3) return JSON.stringify({ seed: "b" });
        if (configReadCount === 4) return JSON.stringify({ seed: "c" });
        if (configReadCount === 5) return JSON.stringify({ seed: "c" });
        if (configReadCount >= 6) return JSON.stringify({ seed: "d" });
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>));
    });

    const { savePluginConfig } = await import("../lib/config.js");
    try {
      await expect(savePluginConfig({ codexMode: false })).rejects.toMatchObject({
        code: "ECONFLICT",
      });
    } finally {
      readSpy.mockRestore();
    }
  });

  it("handles mixed conflict and transient rename contention", async () => {
    const configPath = join(tempDir, "plugin-config.json");
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, JSON.stringify({ seed: "a" }), "utf8");

    const originalReadFile = fs.readFile.bind(fs);
    let configReadCount = 0;
    const readSpy = vi.spyOn(fs, "readFile");
    readSpy.mockImplementation(async (...args) => {
      const target = args[0];
      const path = typeof target === "string" ? target : String(target);
      if (path === configPath) {
        configReadCount += 1;
        if (configReadCount === 2) return JSON.stringify({ seed: "b" });
        if (configReadCount === 3) return JSON.stringify({ seed: "b" });
        if (configReadCount >= 4) return JSON.stringify({ seed: "b" });
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>));
    });

    const originalRename = fs.rename.bind(fs);
    let renameAttempts = 0;
    const renameSpy = vi.spyOn(fs, "rename");
    renameSpy.mockImplementation(async (...args) => {
      if (renameAttempts === 0) {
        renameAttempts += 1;
        throw makeErrnoError("busy rename", "EBUSY");
      }
      renameAttempts += 1;
      return originalRename(...(args as Parameters<typeof fs.rename>));
    });

    const { savePluginConfig } = await import("../lib/config.js");
    try {
      await savePluginConfig({ codexMode: false, retries: 4 });
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
    }

    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.seed).toBe("b");
    expect(parsed.codexMode).toBe(false);
    expect(parsed.retries).toBe(4);
    expect(renameAttempts).toBeGreaterThanOrEqual(2);
  });

  it("waits for lockfile release before persisting env-path config", async () => {
    const configPath = join(tempDir, "plugin-config.json");
    const lockPath = `${configPath}.lock`;
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, JSON.stringify({ codexMode: true }), "utf8");
    await fs.writeFile(lockPath, `${process.pid}\n`, "utf8");

    const unlockPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await fs.unlink(lockPath);
    })();

    const { savePluginConfig } = await import("../lib/config.js");
    const startedAt = Date.now();
    await savePluginConfig({ codexMode: false });
    const elapsed = Date.now() - startedAt;
    await unlockPromise;

    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.codexMode).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it("cleans temp files when env-path rename target is invalid", async () => {
    const invalidTarget = join(tempDir, "config-target-dir");
    process.env.CODEX_MULTI_AUTH_CONFIG_PATH = invalidTarget;
    await fs.mkdir(invalidTarget, { recursive: true });

    const { savePluginConfig } = await import("../lib/config.js");
    await expect(savePluginConfig({ codexMode: false })).rejects.toBeTruthy();

    const entries = await fs.readdir(tempDir);
    const leakedTemps = entries.filter(
      (name) => name.startsWith("config-target-dir.") && name.endsWith(".tmp"),
    );
    expect(leakedTemps).toHaveLength(0);
  });

  it("writes through unified settings when env path is unset", async () => {
    delete process.env.CODEX_MULTI_AUTH_CONFIG_PATH;

    const { savePluginConfig, loadPluginConfig } =
      await import("../lib/config.js");
    await savePluginConfig({
      codexMode: false,
      parallelProbing: true,
      parallelProbingMaxConcurrency: 7,
    });

    const loaded = loadPluginConfig();
    expect(loaded.codexMode).toBe(false);
    expect(loaded.parallelProbing).toBe(true);
    expect(loaded.parallelProbingMaxConcurrency).toBe(7);
  });

  it("resolves parallel probing settings and clamps concurrency", async () => {
    const { getParallelProbing, getParallelProbingMaxConcurrency } =
      await import("../lib/config.js");

    process.env.CODEX_AUTH_PARALLEL_PROBING = "1";
    expect(getParallelProbing({ parallelProbing: false })).toBe(true);
    process.env.CODEX_AUTH_PARALLEL_PROBING = "0";
    expect(getParallelProbing({ parallelProbing: true })).toBe(false);

    process.env.CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY = "not-a-number";
    expect(
      getParallelProbingMaxConcurrency({ parallelProbingMaxConcurrency: 4 }),
    ).toBe(4);

    process.env.CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY = "0";
    expect(
      getParallelProbingMaxConcurrency({ parallelProbingMaxConcurrency: 4 }),
    ).toBe(1);
  });

  it("normalizes fallback chain and drops invalid entries", async () => {
    const { getUnsupportedCodexFallbackChain } =
      await import("../lib/config.js");

    const chain = getUnsupportedCodexFallbackChain({
      unsupportedCodexFallbackChain: {
        " OpenAI/GPT-5.3-CODEX ": ["gpt-5.2-codex", 99 as unknown as string],
        "gpt-5.3-codex-mini": "gpt-5" as unknown as string[],
      },
    });

    expect(chain).toEqual({
      "gpt-5.3-codex": ["gpt-5.2-codex"],
    });
  });

  it("loads global legacy config and auth paths when discovered", async () => {
    delete process.env.CODEX_HOME;

    const runCase = async (legacyFilename: string) => {
      vi.resetModules();
      const existsSyncMock = vi.fn((candidate: unknown) => {
        if (typeof candidate !== "string") return false;
        const normalized = candidate.replace(/\\/g, "/");
        return normalized.endsWith(`/${legacyFilename}`);
      });
      const readFileSyncMock = vi.fn(() =>
        JSON.stringify({ codexMode: false }),
      );
      const logWarnMock = vi.fn();

      vi.doMock("node:fs", async () => {
        const actual =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: existsSyncMock,
          readFileSync: readFileSyncMock,
        };
      });
      vi.doMock("../lib/logger.js", async () => {
        const actual =
          await vi.importActual<typeof import("../lib/logger.js")>(
            "../lib/logger.js",
          );
        return {
          ...actual,
          logWarn: logWarnMock,
        };
      });

      try {
        const configModule = await import("../lib/config.js");
        const loaded = configModule.loadPluginConfig();
        expect(loaded.codexMode).toBe(false);
        expect(readFileSyncMock).toHaveBeenCalled();
        expect(logWarnMock).toHaveBeenCalledWith(
          expect.stringContaining(legacyFilename),
        );
      } finally {
        vi.doUnmock("node:fs");
        vi.doUnmock("../lib/logger.js");
      }
    };

    await runCase("codex-multi-auth-config.json");
    await runCase("openai-codex-auth-config.json");
  });
});
