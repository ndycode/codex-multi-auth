import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshLeaseCoordinator } from "../lib/refresh-lease.js";

const sampleSuccessResult = {
  type: "success" as const,
  access: "access-token",
  refresh: "refresh-token-next",
  expires: Date.now() + 60_000,
};

function hashToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

describe("RefreshLeaseCoordinator", () => {
  let leaseDir = "";

  beforeEach(async () => {
    leaseDir = await mkdtemp(join(tmpdir(), "codex-refresh-lease-"));
  });

  afterEach(() => {
    leaseDir = "";
    vi.restoreAllMocks();
  });

  it("returns owner then follower with shared result", async () => {
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 5_000,
      waitTimeoutMs: 500,
      pollIntervalMs: 25,
      resultTtlMs: 2_000,
    });

    const owner = await coordinator.acquire("token-a");
    expect(owner.role).toBe("owner");
    await owner.release(sampleSuccessResult);

    const follower = await coordinator.acquire("token-a");
    expect(follower.role).toBe("follower");
    expect(follower.result).toEqual(sampleSuccessResult);
  });

  it("tightens an already-existing lease dir to 0o700 on POSIX (chmod after mkdir)", async () => {
    // Regression: mkdir(recursive, mode) does NOT re-apply mode to a dir that
    // already exists, so an upgrade over a looser (umask) dir kept its perms.
    // The coordinator must chmod the dir 0o700 on POSIX. Stub platform to linux
    // and inject an fsOps wrapper that spies on chmod.
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");
    // Pre-create the dir so mkdir's mode is a no-op (the bug scenario).
    await mkdir(leaseDir, { recursive: true });
    const chmodSpy = vi.fn(async () => undefined);
    const fsOps = {
      mkdir: fsPromises.mkdir,
      open: fsPromises.open,
      writeFile: fsPromises.writeFile,
      rename: fsPromises.rename,
      unlink: fsPromises.unlink,
      readFile: fsPromises.readFile,
      stat: fsPromises.stat,
      readdir: fsPromises.readdir,
      chmod: chmodSpy,
    };
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 5_000,
      waitTimeoutMs: 500,
      pollIntervalMs: 25,
      resultTtlMs: 2_000,
      fsOps,
    });

    const owner = await coordinator.acquire("token-perms");
    expect(owner.role).toBe("owner");
    await owner.release(sampleSuccessResult);

    expect(chmodSpy).toHaveBeenCalledWith(leaseDir, 0o700);
    platformSpy.mockRestore();
  });

  it("does not chmod the lease dir on Windows", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const chmodSpy = vi.fn(async () => undefined);
    const fsOps = {
      mkdir: fsPromises.mkdir,
      open: fsPromises.open,
      writeFile: fsPromises.writeFile,
      rename: fsPromises.rename,
      unlink: fsPromises.unlink,
      readFile: fsPromises.readFile,
      stat: fsPromises.stat,
      readdir: fsPromises.readdir,
      chmod: chmodSpy,
    };
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 5_000,
      waitTimeoutMs: 500,
      pollIntervalMs: 25,
      resultTtlMs: 2_000,
      fsOps,
    });

    const owner = await coordinator.acquire("token-win");
    expect(owner.role).toBe("owner");
    await owner.release(sampleSuccessResult);

    expect(chmodSpy).not.toHaveBeenCalled();
    platformSpy.mockRestore();
  });

  it("recovers from stale lock payload", async () => {
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 2_000,
      waitTimeoutMs: 300,
      pollIntervalMs: 20,
    });

    const tokenHash =
      "7f4a7c15f6f8c0f98d95c58f18f6f31e4f55cc4c52f8f4de4fd4d95a88e4866c";
    await mkdir(leaseDir, { recursive: true });
    await writeFile(
      join(leaseDir, `${tokenHash}.lock`),
      JSON.stringify({
        tokenHash,
        pid: 9999,
        acquiredAt: Date.now() - 10_000,
        expiresAt: Date.now() - 1_000,
      }),
      "utf8",
    );

    const handle = await coordinator.acquire("token-stale");
    expect(handle.role).toBe("owner");
    await handle.release(sampleSuccessResult);
  });

  it("supports bypass mode", async () => {
    const coordinator = new RefreshLeaseCoordinator({
      enabled: false,
      leaseDir,
    });
    const handle = await coordinator.acquire("token-b");
    expect(handle.role).toBe("bypass");
    await handle.release(sampleSuccessResult);
  });

  it("does not delete unreadable lock payloads", async () => {
    const refreshToken = "token-partial";
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 10_000,
      waitTimeoutMs: 120,
      pollIntervalMs: 25,
      resultTtlMs: 2_000,
    });
    await mkdir(leaseDir, { recursive: true });
    const tokenHash = hashToken(refreshToken);
    const lockPath = join(leaseDir, `${tokenHash}.lock`);
    await writeFile(lockPath, "{", "utf8");

    const handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("bypass");
    const lockContent = await readFile(lockPath, "utf8");
    expect(lockContent).toBe("{");
  });

  it("retries stale lock cleanup when unlink is temporarily busy", async () => {
    const refreshToken = "token-retry";
    const tokenHash = hashToken(refreshToken);
    let busyCount = 0;
    const originalUnlink = fsPromises.unlink.bind(fsPromises);
    const fsOps = {
      mkdir: fsPromises.mkdir.bind(fsPromises),
      open: fsPromises.open.bind(fsPromises),
      writeFile: fsPromises.writeFile.bind(fsPromises),
      rename: fsPromises.rename.bind(fsPromises),
      unlink: vi.fn(async (path: Parameters<typeof fsPromises.unlink>[0]) => {
        if (String(path).endsWith(".lock") && busyCount < 2) {
          busyCount += 1;
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        return originalUnlink(path);
      }),
      readFile: fsPromises.readFile.bind(fsPromises),
      stat: fsPromises.stat.bind(fsPromises),
      readdir: fsPromises.readdir.bind(fsPromises),
    };

    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 2_000,
      waitTimeoutMs: 400,
      pollIntervalMs: 20,
      resultTtlMs: 2_000,
      fsOps,
    });

    await mkdir(leaseDir, { recursive: true });
    const lockPath = join(leaseDir, `${tokenHash}.lock`);
    await writeFile(
      lockPath,
      JSON.stringify({
        tokenHash,
        pid: 1111,
        acquiredAt: Date.now() - 10_000,
        expiresAt: Date.now() - 5_000,
      }),
      "utf8",
    );

    const handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("owner");
    expect(fsOps.unlink).toHaveBeenCalled();
    expect(busyCount).toBe(2);
    await handle.release(sampleSuccessResult);
  });

  it("times out to bypass when stale lock cannot be deleted", async () => {
    const refreshToken = "token-timeout";
    const tokenHash = hashToken(refreshToken);
    const originalUnlink = fsPromises.unlink.bind(fsPromises);
    const fsOps = {
      mkdir: fsPromises.mkdir.bind(fsPromises),
      open: fsPromises.open.bind(fsPromises),
      writeFile: fsPromises.writeFile.bind(fsPromises),
      rename: fsPromises.rename.bind(fsPromises),
      unlink: vi.fn(async (path: Parameters<typeof fsPromises.unlink>[0]) => {
        if (String(path).endsWith(".lock")) {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        return originalUnlink(path);
      }),
      readFile: fsPromises.readFile.bind(fsPromises),
      stat: fsPromises.stat.bind(fsPromises),
      readdir: fsPromises.readdir.bind(fsPromises),
    };

    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 2_000,
      waitTimeoutMs: 140,
      pollIntervalMs: 25,
      resultTtlMs: 2_000,
      fsOps,
    });

    await mkdir(leaseDir, { recursive: true });
    const lockPath = join(leaseDir, `${tokenHash}.lock`);
    await writeFile(
      lockPath,
      JSON.stringify({
        tokenHash,
        pid: 2222,
        acquiredAt: Date.now() - 10_000,
        expiresAt: Date.now() - 5_000,
      }),
      "utf8",
    );

    const handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("bypass");
    expect(fsOps.unlink).toHaveBeenCalled();
    await handle.release(sampleSuccessResult);
  });
  it("treats empty refresh token as bypass", async () => {
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
    });

    const handle = await coordinator.acquire("   ");
    expect(handle.role).toBe("bypass");
    await handle.release(sampleSuccessResult);
  });

  it("parses environment toggle values in fromEnvironment", async () => {
    const originalEnv = {
      VITEST: process.env.VITEST,
      NODE_ENV: process.env.NODE_ENV,
      CODEX_AUTH_REFRESH_LEASE: process.env.CODEX_AUTH_REFRESH_LEASE,
      CODEX_AUTH_REFRESH_LEASE_DIR: process.env.CODEX_AUTH_REFRESH_LEASE_DIR,
      CODEX_AUTH_REFRESH_LEASE_TTL_MS:
        process.env.CODEX_AUTH_REFRESH_LEASE_TTL_MS,
      CODEX_AUTH_REFRESH_LEASE_WAIT_MS:
        process.env.CODEX_AUTH_REFRESH_LEASE_WAIT_MS,
      CODEX_AUTH_REFRESH_LEASE_POLL_MS:
        process.env.CODEX_AUTH_REFRESH_LEASE_POLL_MS,
      CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS:
        process.env.CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS,
    };

    try {
      process.env.VITEST = "false";
      process.env.NODE_ENV = "production";
      process.env.CODEX_AUTH_REFRESH_LEASE = "yes";
      process.env.CODEX_AUTH_REFRESH_LEASE_DIR = `${leaseDir}\n`;
      process.env.CODEX_AUTH_REFRESH_LEASE_TTL_MS = "2500";
      process.env.CODEX_AUTH_REFRESH_LEASE_WAIT_MS = "900";
      process.env.CODEX_AUTH_REFRESH_LEASE_POLL_MS = "60";
      process.env.CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS = "2500";

      const enabledCoordinator = RefreshLeaseCoordinator.fromEnvironment();
      const enabledHandle =
        await enabledCoordinator.acquire("token-env-enabled");
      expect(enabledHandle.role).toBe("owner");
      await enabledHandle.release(sampleSuccessResult);

      process.env.VITEST = "true";
      process.env.NODE_ENV = "test";
      process.env.CODEX_AUTH_REFRESH_LEASE = "maybe";
      const invalidValueCoordinator = RefreshLeaseCoordinator.fromEnvironment();
      const invalidHandle =
        await invalidValueCoordinator.acquire("token-env-invalid");
      expect(invalidHandle.role).toBe("bypass");

      process.env.CODEX_AUTH_REFRESH_LEASE = "no";
      const disabledCoordinator = RefreshLeaseCoordinator.fromEnvironment();
      const disabledHandle =
        await disabledCoordinator.acquire("token-env-disabled");
      expect(disabledHandle.role).toBe("bypass");
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("bypasses when lock open fails with non-EEXIST error", async () => {
    const fsOps = {
      mkdir: fsPromises.mkdir.bind(fsPromises),
      open: vi.fn(async () => {
        const error = new Error("permission") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
      writeFile: fsPromises.writeFile.bind(fsPromises),
      rename: fsPromises.rename.bind(fsPromises),
      unlink: fsPromises.unlink.bind(fsPromises),
      readFile: fsPromises.readFile.bind(fsPromises),
      stat: fsPromises.stat.bind(fsPromises),
      readdir: fsPromises.readdir.bind(fsPromises),
    };
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      waitTimeoutMs: 80,
      pollIntervalMs: 20,
      fsOps,
    });

    const handle = await coordinator.acquire("token-open-error");
    expect(handle.role).toBe("bypass");
    expect(fsOps.open).toHaveBeenCalled();
  });

  it("ignores mismatched result payload and stale results", async () => {
    const refreshToken = "token-result-paths";
    const tokenHash = hashToken(refreshToken);
    const resultPath = join(leaseDir, `${tokenHash}.result.json`);
    await mkdir(leaseDir, { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({
        tokenHash: "different-hash",
        createdAt: Date.now(),
        result: sampleSuccessResult,
      }),
      "utf8",
    );

    let coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      waitTimeoutMs: 120,
      pollIntervalMs: 20,
      resultTtlMs: 2_000,
    });
    let handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("owner");
    await handle.release();

    await writeFile(
      resultPath,
      JSON.stringify({
        tokenHash,
        createdAt: Date.now() - 10_000,
        result: sampleSuccessResult,
      }),
      "utf8",
    );

    coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      waitTimeoutMs: 120,
      pollIntervalMs: 20,
      resultTtlMs: 500,
    });
    handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("owner");
    await handle.release();
    await expect(fsPromises.stat(resultPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("handles lock staleness edge cases from stat and payload validation", async () => {
    const refreshToken = "token-staleness-cases";
    const tokenHash = hashToken(refreshToken);
    const lockPath = join(leaseDir, `${tokenHash}.lock`);
    await mkdir(leaseDir, { recursive: true });

    await writeFile(
      lockPath,
      JSON.stringify({ tokenHash, pid: "bad" }),
      "utf8",
    );
    let coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 2_000,
      waitTimeoutMs: 120,
      pollIntervalMs: 20,
    });
    let handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("bypass");

    await writeFile(
      lockPath,
      JSON.stringify({
        tokenHash,
        pid: process.pid,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 5_000,
      }),
      "utf8",
    );
    await fsPromises.utimes(
      lockPath,
      new Date(Date.now() - 10_000),
      new Date(Date.now() - 10_000),
    );
    coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 1_000,
      waitTimeoutMs: 160,
      pollIntervalMs: 20,
    });
    handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("owner");
    await handle.release(sampleSuccessResult);
    await fsPromises.rm(join(leaseDir, `${tokenHash}.result.json`), {
      force: true,
    });

    await writeFile(
      lockPath,
      JSON.stringify({
        tokenHash,
        pid: process.pid,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 5_000,
      }),
      "utf8",
    );
    const fsOps = {
      mkdir: fsPromises.mkdir.bind(fsPromises),
      open: fsPromises.open.bind(fsPromises),
      writeFile: fsPromises.writeFile.bind(fsPromises),
      rename: fsPromises.rename.bind(fsPromises),
      unlink: fsPromises.unlink.bind(fsPromises),
      readFile: fsPromises.readFile.bind(fsPromises),
      stat: vi.fn(async (...args: Parameters<typeof fsPromises.stat>) => {
        if (String(args[0]) === lockPath) {
          const error = new Error("access denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return fsPromises.stat(...args);
      }),
      readdir: fsPromises.readdir.bind(fsPromises),
    };

    coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 5_000,
      waitTimeoutMs: 120,
      pollIntervalMs: 20,
      fsOps,
    });
    handle = await coordinator.acquire(refreshToken);
    expect(handle.role).toBe("bypass");
  });

  it("rejects array JSON payloads in result and lock files", async () => {
    // Pins the canonical isRecord contract (lib/utils.ts): a top-level JSON
    // array must never be treated as a lease or result record, even though
    // arrays satisfy `typeof value === "object"`.
    const refreshToken = "token-array-payload";
    const tokenHash = hashToken(refreshToken);
    const lockPath = join(leaseDir, `${tokenHash}.lock`);
    const resultPath = join(leaseDir, `${tokenHash}.result.json`);
    await mkdir(leaseDir, { recursive: true });

    // An array result file must not turn the caller into a follower.
    await writeFile(resultPath, "[]\n", "utf8");
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 2_000,
      waitTimeoutMs: 120,
      pollIntervalMs: 20,
      resultTtlMs: 2_000,
    });
    const owner = await coordinator.acquire(refreshToken);
    expect(owner.role).toBe("owner");
    await owner.release();

    // An array lock file is an invalid payload: never owned, never stale, so
    // the acquire times out and bypasses instead of stealing the lock.
    await writeFile(lockPath, "[]\n", "utf8");
    const blocked = await coordinator.acquire(refreshToken);
    expect(blocked.role).toBe("bypass");
    await blocked.release();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("[]\n");
  });

  it("prunes stale artifacts while keeping non-file entries", async () => {
    await mkdir(leaseDir, { recursive: true });
    const staleLock = join(leaseDir, "stale.lock");
    const staleResult = join(leaseDir, "stale.result.json");
    const liveOther = join(leaseDir, "ignore.txt");
    const nestedDir = join(leaseDir, "nested-dir");
    await writeFile(staleLock, "{}", "utf8");
    await writeFile(staleResult, "{}", "utf8");
    await writeFile(liveOther, "keep", "utf8");
    await mkdir(nestedDir, { recursive: true });
    const oldTime = new Date(Date.now() - 60_000);
    await fsPromises.utimes(staleLock, oldTime, oldTime);
    await fsPromises.utimes(staleResult, oldTime, oldTime);

    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 2_000,
      resultTtlMs: 2_000,
    });
    const privateApi = coordinator as unknown as {
      pruneExpiredArtifacts: () => Promise<void>;
    };
    await privateApi.pruneExpiredArtifacts();

    await expect(fsPromises.stat(staleLock)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fsPromises.stat(staleResult)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fsPromises.readFile(liveOther, "utf8")).resolves.toBe("keep");
    await expect(fsPromises.stat(nestedDir)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  // Regression: lease artifacts embed OAuth token material (the result file
  // carries the refreshed access + refresh tokens). They must be created with
  // owner-only permissions (0o600 files under a 0o700 dir), not at the umask.
  // POSIX-only: Windows does not enforce these mode bits.
  (process.platform === "win32" ? it.skip : it)(
    "creates lease dir 0o700 and token result/lock files 0o600",
    async () => {
      const ownLeaseDir = join(leaseDir, "perm-check");
      const coordinator = new RefreshLeaseCoordinator({
        enabled: true,
        leaseDir: ownLeaseDir,
        leaseTtlMs: 5_000,
        waitTimeoutMs: 500,
        pollIntervalMs: 25,
        resultTtlMs: 5_000,
      });

      const owner = await coordinator.acquire("token-perms");
      expect(owner.role).toBe("owner");

      const tokenHash = hashToken("token-perms");
      const lockPath = join(ownLeaseDir, `${tokenHash}.lock`);
      const resultPath = join(ownLeaseDir, `${tokenHash}.result.json`);

      const dirMode = (await fsPromises.stat(ownLeaseDir)).mode & 0o777;
      expect(dirMode).toBe(0o700);
      const lockMode = (await fsPromises.stat(lockPath)).mode & 0o777;
      expect(lockMode).toBe(0o600);

      await owner.release(sampleSuccessResult);

      const resultMode = (await fsPromises.stat(resultPath)).mode & 0o777;
      expect(resultMode).toBe(0o600);
    },
  );

  // Cross-platform companion to the POSIX on-disk check above: assert the code
  // PASSES owner-only mode args to fs, regardless of whether the OS enforces them.
  // Runs on Windows too (where the on-disk mode assertions are skipped).
  it("passes 0o700 dir mode and 0o600 file modes to fsOps", async () => {
    const calls: { mkdir: unknown[][]; open: unknown[][]; writeFile: unknown[][] } = {
      mkdir: [],
      open: [],
      writeFile: [],
    };
    const fsOps = {
      mkdir: (...a: Parameters<typeof fsPromises.mkdir>) => {
        calls.mkdir.push(a);
        return fsPromises.mkdir(...a);
      },
      open: (...a: Parameters<typeof fsPromises.open>) => {
        calls.open.push(a);
        return fsPromises.open(...a);
      },
      writeFile: (...a: Parameters<typeof fsPromises.writeFile>) => {
        calls.writeFile.push(a);
        return fsPromises.writeFile(...a);
      },
      rename: fsPromises.rename.bind(fsPromises),
      unlink: fsPromises.unlink.bind(fsPromises),
      readFile: fsPromises.readFile.bind(fsPromises),
      stat: fsPromises.stat.bind(fsPromises),
      readdir: fsPromises.readdir.bind(fsPromises),
    };
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir: join(leaseDir, "spy-check"),
      leaseTtlMs: 5_000,
      waitTimeoutMs: 500,
      pollIntervalMs: 25,
      resultTtlMs: 5_000,
      fsOps,
    });

    const owner = await coordinator.acquire("token-spy");
    await owner.release(sampleSuccessResult);

    // leaseDir created with 0o700
    expect(
      calls.mkdir.some(
        ([p, opts]) =>
          typeof p === "string" &&
          p.includes("spy-check") &&
          typeof opts === "object" &&
          opts !== null &&
          (opts as { mode?: number }).mode === 0o700,
      ),
    ).toBe(true);
    // lock opened "wx" with 0o600
    expect(
      calls.open.some(
        ([p, flags, mode]) =>
          typeof p === "string" && p.endsWith(".lock") && flags === "wx" && mode === 0o600,
      ),
    ).toBe(true);
    // result temp file written with 0o600
    expect(
      calls.writeFile.some(
        ([p, , opts]) =>
          typeof p === "string" &&
          p.includes(".result.json") &&
          typeof opts === "object" &&
          opts !== null &&
          (opts as { mode?: number }).mode === 0o600,
      ),
    ).toBe(true);
  });
});
