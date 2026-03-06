import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

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

  it("cleans up temp files when rename keeps failing", async () => {
    const { saveQuotaCache } = await import("../lib/quota-cache.js");
    const renameSpy = vi.spyOn(fs, "rename");
    const unlinkSpy = vi.spyOn(fs, "unlink");
    renameSpy.mockImplementation(async () => {
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

      const tmpUnlinks = unlinkSpy.mock.calls.filter((call) =>
        String(call[0]).endsWith(".tmp"),
      );
      expect(tmpUnlinks).toHaveLength(1);
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

  it("serializes concurrent saveQuotaCache writers across processes", async () => {
    const { loadQuotaCache } = await import("../lib/quota-cache.js");
    const workerScriptPath = join(tempDir, "quota-cache-worker.mjs");
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "dist", "lib", "quota-cache.js"),
    ).href;
    const workerCount = 4;
    const iterations = 8;

    await fs.writeFile(
      workerScriptPath,
      `const [moduleUrl, rootDir, workerIdRaw, workerCountRaw, iterationsRaw] = process.argv.slice(2);
process.env.CODEX_MULTI_AUTH_DIR = rootDir;
const workerId = Number(workerIdRaw);
const workerCount = Number(workerCountRaw);
const iterations = Number(iterationsRaw);
const { saveQuotaCache } = await import(moduleUrl);
for (let i = 0; i < iterations; i += 1) {
  const byAccountId = {};
  for (let w = 0; w < workerCount; w += 1) {
    byAccountId[\`acc_\${w}\`] = {
      updatedAt: Date.now(),
      status: 200,
      model: \`writer-\${workerId}-iter-\${i}\`,
      primary: { usedPercent: w + i, windowMinutes: 300 },
      secondary: { usedPercent: workerId, windowMinutes: 10080 },
    };
  }
  await saveQuotaCache({ byAccountId, byEmail: {} });
}
`,
      "utf8",
    );

    const runWorker = (workerId: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            workerScriptPath,
            moduleUrl,
            tempDir,
            String(workerId),
            String(workerCount),
            String(iterations),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`quota worker ${workerId} exited with ${code}: ${stderr}`));
        });
      });

    await Promise.all(Array.from({ length: workerCount }, (_, workerId) => runWorker(workerId)));

    const loaded = await loadQuotaCache();
    const keys = Object.keys(loaded.byAccountId).sort();
    expect(keys).toEqual(["acc_0", "acc_1", "acc_2", "acc_3"]);
    for (const key of keys) {
      expect(loaded.byAccountId[key]?.model.startsWith("writer-")).toBe(true);
      expect(typeof loaded.byAccountId[key]?.primary.usedPercent).toBe("number");
    }
  });
});
