import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
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

async function importLiveAccountSyncWithFsMock(options?: {
  watch?: (
    path: string,
    options: { persistent: boolean },
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => { close: () => void };
  stat?: typeof import("node:fs").promises.stat;
}) {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      watch: options?.watch ?? actual.watch,
      promises: {
        ...actual.promises,
        stat: options?.stat ?? actual.promises.stat,
      },
    };
  });

  return import("../lib/live-account-sync.js");
}

describe("live-account-sync edge cases", () => {
  let workDir = "";
  let storagePath = "";

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    workDir = await fs.mkdtemp(join(tmpdir(), "codex-live-sync-edge-"));
    storagePath = join(workDir, "openai-codex-accounts.json");
    await fs.writeFile(
      storagePath,
      JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
      "utf8",
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("node:fs");
    if (workDir) {
      await removeWithRetry(workDir, { recursive: true, force: true });
    }
  });

  it("clamps intervals and short-circuits empty-path / pre-run calls", async () => {
    const { LiveAccountSync } = await importLiveAccountSyncWithFsMock();
    const reload = vi.fn(async () => undefined);
    const sync = new LiveAccountSync(reload, {
      debounceMs: 1.1,
      pollIntervalMs: 2.2,
    });

    expect(Reflect.get(sync, "debounceMs")).toBe(50);
    expect(Reflect.get(sync, "pollIntervalMs")).toBe(500);

    await sync.syncToPath("");
    expect(sync.getSnapshot().running).toBe(false);
    expect(sync.getSnapshot().path).toBeNull();

    const pollOnce = Reflect.get(sync, "pollOnce") as () => Promise<void>;
    const runReload = Reflect.get(sync, "runReload") as (
      reason: "watch" | "poll",
    ) => Promise<void>;
    await Reflect.apply(
      pollOnce as (...args: unknown[]) => unknown,
      sync as object,
      [],
    );
    await Reflect.apply(
      runReload as (...args: unknown[]) => unknown,
      sync as object,
      ["watch"],
    );

    expect(reload).not.toHaveBeenCalled();
  });

  it("handles non-finite mtime and watch setup failures", async () => {
    const watchMock = vi.fn(() => {
      throw "watch-failed";
    });
    const statMock = vi.fn(async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === storagePath) {
        return { mtimeMs: Number.NaN } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return fs.stat(...args);
    });

    const { LiveAccountSync } = await importLiveAccountSyncWithFsMock({
      watch: watchMock,
      stat: statMock,
    });
    const sync = new LiveAccountSync(async () => undefined, {
      debounceMs: 50,
      pollIntervalMs: 500,
    });

    await sync.syncToPath(storagePath);

    const snapshot = sync.getSnapshot();
    expect(snapshot.running).toBe(true);
    expect(snapshot.lastKnownMtimeMs).toBeNull();
    expect(snapshot.errorCount).toBeGreaterThan(0);
    expect(watchMock).toHaveBeenCalled();
    sync.stop();
  });

  it("treats retryable stat read errors as missing mtime", async () => {
    const watchMock = vi.fn((_dir, _options, _listener) => ({
      close: vi.fn(),
    }));
    const statMock = vi.fn(async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === storagePath) {
        const error = new Error("busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return fs.stat(...args);
    });

    const { LiveAccountSync } = await importLiveAccountSyncWithFsMock({
      watch: watchMock,
      stat: statMock,
    });
    const sync = new LiveAccountSync(async () => undefined, {
      debounceMs: 50,
      pollIntervalMs: 500,
    });

    await sync.syncToPath(storagePath);
    expect(sync.getSnapshot().lastKnownMtimeMs).toBeNull();
    sync.stop();
  });

  it("handles watch callbacks for null and buffer filenames and ignores unrelated names", async () => {
    let callback:
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    const closeMock = vi.fn();
    const watchMock = vi.fn(
      (
        _dir: string,
        _options: { persistent: boolean },
        listener: (eventType: string, filename: string | Buffer | null) => void,
      ) => {
        callback = listener;
        return { close: closeMock };
      },
    );
    const statMock = vi.fn(async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === storagePath) {
        return { mtimeMs: 1_000 } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return fs.stat(...args);
    });

    const { LiveAccountSync } = await importLiveAccountSyncWithFsMock({
      watch: watchMock,
      stat: statMock,
    });
    const reload = vi.fn(async () => undefined);
    const sync = new LiveAccountSync(reload, {
      debounceMs: 50,
      pollIntervalMs: 500,
    });

    await sync.syncToPath(storagePath);
    await sync.syncToPath(storagePath);
    expect(watchMock).toHaveBeenCalledTimes(1);

    callback?.("change", null);
    await vi.advanceTimersByTimeAsync(80);
    expect(reload).toHaveBeenCalledTimes(1);

    const name = basename(storagePath);
    callback?.("change", Buffer.from(name, "utf8"));
    await vi.advanceTimersByTimeAsync(80);
    expect(reload).toHaveBeenCalledTimes(2);

    callback?.("change", Buffer.from(`${name}.tmp`, "utf8"));
    await vi.advanceTimersByTimeAsync(80);
    expect(reload).toHaveBeenCalledTimes(3);

    callback?.("change", Buffer.from("unrelated.json", "utf8"));
    await vi.advanceTimersByTimeAsync(80);
    expect(reload).toHaveBeenCalledTimes(3);

    sync.stop();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("counts poll-triggered reload failures with non-Error throws", async () => {
    const watchMock = vi.fn((_dir, _options, _listener) => ({
      close: vi.fn(),
    }));
    let statReads = 0;
    const statMock = vi.fn(async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === storagePath) {
        statReads += 1;
        if (statReads === 1) {
          return { mtimeMs: 1_000 } as Awaited<ReturnType<typeof fs.stat>>;
        }
        return { mtimeMs: 2_000 } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return fs.stat(...args);
    });
    const { LiveAccountSync } = await importLiveAccountSyncWithFsMock({
      watch: watchMock,
      stat: statMock,
    });
    const reload = vi.fn(async () => {
      throw "reload-string-failure";
    });
    const sync = new LiveAccountSync(reload, {
      debounceMs: 50,
      pollIntervalMs: 500,
    });

    await sync.syncToPath(storagePath);
    await vi.advanceTimersByTimeAsync(800);

    const snapshot = sync.getSnapshot();
    expect(snapshot.errorCount).toBeGreaterThan(0);
    expect(snapshot.reloadCount).toBe(0);
    sync.stop();
  });
});
