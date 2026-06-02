import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sleep } from "../lib/utils.js";

// Windows-safe recursive remove with EBUSY/EPERM backoff, mirroring the
// removeDirectoryWithRetry helper in codex-bin-wrapper.test.ts. A bare fs.rm
// can flake on Windows when an antivirus/indexer briefly locks the just-written
// snapshot file.
function isRetriableFsError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return code === "EBUSY" || code === "EPERM";
}

async function removeDirectoryWithRetry(dir: string): Promise<void> {
  const backoffMs = [20, 60, 120];
  let lastError: unknown;
  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetriableFsError(error) || attempt === backoffMs.length) {
        break;
      }
      await sleep(backoffMs[attempt]);
    }
  }
  throw lastError;
}

describe("runtime observability snapshot dir hardening", () => {
  let tempRoot: string;
  let snapshotDir: string;
  let originalDir: string | undefined;
  let originalVitest: string | undefined;

  beforeEach(async () => {
    originalDir = process.env.CODEX_MULTI_AUTH_DIR;
    originalVitest = process.env.VITEST;
    tempRoot = await fs.mkdtemp(join(tmpdir(), "codex-obs-dirmode-"));
    // Pin the multi-auth dir to a deterministic temp subdir; getCodexMultiAuthDir
    // returns CODEX_MULTI_AUTH_DIR verbatim when set.
    snapshotDir = join(tempRoot, "multi-auth");
    process.env.CODEX_MULTI_AUTH_DIR = snapshotDir;
    // PERSIST_RUNTIME_SNAPSHOT is computed at module load as VITEST !== "true",
    // so blank it before the dynamic import to enable on-disk persistence.
    process.env.VITEST = "";
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalDir === undefined) {
      delete process.env.CODEX_MULTI_AUTH_DIR;
    } else {
      process.env.CODEX_MULTI_AUTH_DIR = originalDir;
    }
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    await removeDirectoryWithRetry(tempRoot);
  });

  it.skipIf(process.platform === "win32")(
    "re-asserts owner-only (0o700) dir mode on a pre-existing permissive dir",
    async () => {
      // Upgrade path: the multi-auth dir already exists with permissive perms,
      // so mkdir({ mode: 0o700 }) is a no-op and only the explicit chmod can
      // tighten it.
      await fs.mkdir(snapshotDir, { recursive: true });
      await fs.chmod(snapshotDir, 0o777);
      expect(statSync(snapshotDir).mode & 0o777).toBe(0o777);

      const mod = await import("../lib/runtime/runtime-observability.js");
      mod.mutateRuntimeObservabilitySnapshot((snapshot) => {
        snapshot.responsesRequests = 1;
      });

      const snapshotPath = join(snapshotDir, "runtime-observability.json");
      await vi.waitFor(() => {
        expect(statSync(snapshotPath).isFile()).toBe(true);
      });

      // chmod runs before the snapshot file is written, so the dir is tightened
      // by the time the file exists.
      expect(statSync(snapshotDir).mode & 0o777).toBe(0o700);
    },
  );
});
