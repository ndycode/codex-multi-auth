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

  it("does not cache a failed refresh result; only success is served to followers", async () => {
    // Regression: a `failed` result carries no token material. If the owner cached
    // it, readFreshResult would serve the failure to every follower for the whole
    // result TTL, blocking a real refresh (and escalating to cooldowns). A failed
    // release must leave NO result cache — the next caller becomes owner and
    // retries — while a success is still shared with followers.
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
      leaseTtlMs: 5_000,
      waitTimeoutMs: 500,
      pollIntervalMs: 25,
      resultTtlMs: 5_000,
    });

    const failedResult = {
      type: "failed" as const,
      reason: "network_error" as const,
      message: "boom",
    };

    const owner = await coordinator.acquire("token-fail");
    expect(owner.role).toBe("owner");
    await owner.release(failedResult);

    // A failure was NOT cached: the next caller acquires as owner, not a follower
    // holding the stale failure.
    const afterFailure = await coordinator.acquire("token-fail");
    expect(afterFailure.role).toBe("owner");
    expect(afterFailure.result).toBeUndefined();
    await afterFailure.release(sampleSuccessResult);

    // Happy path intact: a success IS served to a subsequent follower.
    const follower = await coordinator.acquire("token-fail");
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

  it.each([process.pid, 99999999])("does not reclaim an expired lock, even after owner exit: %s", async pid => {
    const token = "expired-owner";
    const lockPath = join(leaseDir, `${hashToken(token)}.lock`);
    const payload = JSON.stringify({tokenHash: hashToken(token), pid, acquiredAt: 1, expiresAt: 2, nonce: "owner"});
    await writeFile(lockPath, payload);
    const coordinator = new RefreshLeaseCoordinator({leaseDir, waitTimeoutMs: 0});
    expect((await coordinator.acquire(token)).role).toBe("blocked");
    expect(await readFile(lockPath, "utf8")).toBe(payload);
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
    expect(handle.role).toBe("blocked");
    const lockContent = await readFile(lockPath, "utf8");
    expect(lockContent).toBe("{");
  });

  it("blocks an empty refresh token", async () => {
    const coordinator = new RefreshLeaseCoordinator({
      enabled: true,
      leaseDir,
    });

    const handle = await coordinator.acquire("   ");
    expect(handle.role).toBe("blocked");
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

  it("blocks when lock open fails with non-EEXIST error", async () => {
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
    expect(handle.role).toBe("blocked");
    expect(fsOps.open).toHaveBeenCalled();
  });

  it.each([
    ["write", "EIO"],
    ["close", "EPERM"],
  ])("removes its own lock when the %s after an exclusive open fails (%s)", async (step, code) => {
    const fail = () => Object.assign(new Error(`${step} failed`), { code });
    const fsOps = {
      mkdir: fsPromises.mkdir.bind(fsPromises),
      open: vi.fn(async (path: string, flags: string, mode: number) => {
        const handle = await fsPromises.open(path, flags, mode);
        return {
          writeFile: async (...args: Parameters<typeof handle.writeFile>) => {
            if (step === "write") throw fail();
            return handle.writeFile(...args);
          },
          close: async () => {
            await handle.close();
            if (step === "close") throw fail();
          },
        };
      }) as unknown as typeof fsPromises.open,
      writeFile: fsPromises.writeFile.bind(fsPromises),
      rename: fsPromises.rename.bind(fsPromises),
      unlink: vi.fn(fsPromises.unlink.bind(fsPromises)),
      readFile: fsPromises.readFile.bind(fsPromises),
      stat: fsPromises.stat.bind(fsPromises),
      readdir: fsPromises.readdir.bind(fsPromises),
    };
    const refreshToken = `token-orphan-${step}`;
    const lockPath = join(leaseDir, `${hashToken(refreshToken)}.lock`);
    const failing = new RefreshLeaseCoordinator({ enabled: true, leaseDir, waitTimeoutMs: 80, pollIntervalMs: 20, fsOps });

    const handle = await failing.acquire(refreshToken);

    expect(handle.role).toBe("blocked");
    expect(fsOps.unlink).toHaveBeenCalledWith(lockPath);
    await expect(fsPromises.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    // Once the filesystem recovers, the token can be refreshed again instead
    // of waiting out a lock nobody will ever release.
    const healthy = new RefreshLeaseCoordinator({ enabled: true, leaseDir, waitTimeoutMs: 80, pollIntervalMs: 20 });
    const owner = await healthy.acquire(refreshToken);
    expect(owner.role).toBe("owner");
    await owner.release();
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

  it("does not use old mtime to steal a live lock", async () => {
    const token = "old-mtime";
    const coordinator = new RefreshLeaseCoordinator({leaseDir, waitTimeoutMs: 0});
    const owner = await coordinator.acquire(token);
    const lockPath = join(leaseDir, `${hashToken(token)}.lock`);
    const oldTime = new Date(0);
    await fsPromises.utimes(lockPath, oldTime, oldTime);
    expect((await coordinator.acquire(token)).role).toBe("blocked");
    await owner.release(sampleSuccessResult);
    expect((await coordinator.acquire(token)).role).toBe("follower");
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
    // the acquire times out and blocks instead of stealing the lock.
    await writeFile(lockPath, "[]\n", "utf8");
    const blocked = await coordinator.acquire(refreshToken);
    expect(blocked.role).toBe("blocked");
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

    await expect(readFile(staleLock, "utf8")).resolves.toBe("{}");
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
  it("rechecks a result published between cache lookup and lock acquisition", async () => {
    const token = "publish-race";
    const tokenHash = hashToken(token);
    let published = false;
    const coordinator = new RefreshLeaseCoordinator({leaseDir, waitTimeoutMs: 0, fsOps: {
      ...fsPromises,
      open: async (...args: Parameters<typeof fsPromises.open>) => {
        if (!published) {
          published = true;
          await writeFile(join(leaseDir, `${tokenHash}.result.json`), JSON.stringify({tokenHash, createdAt: Date.now(), result: sampleSuccessResult}));
        }
        return fsPromises.open(...args);
      },
    }});
    const handle = await coordinator.acquire(token);
    expect(handle.role).toBe("follower");
    expect(handle.result).toEqual(sampleSuccessResult);
  });

  it("retains the lock if rotated credentials cannot be published", async () => {
    const token = "publish-failure";
    const coordinator = new RefreshLeaseCoordinator({leaseDir, waitTimeoutMs: 0, fsOps: {
      ...fsPromises, rename: async () => { throw Object.assign(new Error("busy"), {code: "EBUSY"}); },
    }});
    const owner = await coordinator.acquire(token);
    await expect(owner.release(sampleSuccessResult)).rejects.toThrow("busy");
    await owner.release();
    expect((await coordinator.acquire(token)).role).toBe("blocked");
  });
});
