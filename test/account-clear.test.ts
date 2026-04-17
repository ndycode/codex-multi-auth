import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountStorageArtifacts } from "../lib/storage/account-clear.js";

// Use os.tmpdir() instead of process.cwd() so the test never leaves stray
// tmp-accounts.* artifacts at the repo root. Previously these files leaked
// into the worktree and tripped repo hygiene checks (AUDIT-M31 / E-02).
const testTmpRoot = join(tmpdir(), "codex-multi-auth-account-clear-tests");

describe("account clear helper", () => {
	beforeEach(async () => {
		await fs.mkdir(testTmpRoot, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		// Best-effort cleanup so re-running the suite does not accumulate state.
		try {
			await fs.rm(testTmpRoot, { recursive: true, force: true });
		} catch {
			// Ignore: rm can race with antivirus scanners on Windows; next run
			// will retry the directory creation.
		}
	});

	it("clears primary, wal, and backups after writing marker", async () => {
		await expect(
			clearAccountStorageArtifacts({
				path: join(testTmpRoot, "tmp-accounts.json"),
				resetMarkerPath: join(testTmpRoot, "tmp-accounts.marker"),
				walPath: join(testTmpRoot, "tmp-accounts.wal"),
				backupPaths: [join(testTmpRoot, "tmp-accounts.json.bak")],
				logError: vi.fn(),
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		"EBUSY",
		"EPERM",
	] as const)("retries transient %s errors when clearing required artifacts", async (code) => {
		vi.useFakeTimers();
		const unlinkSpy = vi.spyOn(fs, "unlink");
		let attempts = 0;
		unlinkSpy.mockImplementation(async (targetPath) => {
			if (String(targetPath).endsWith("tmp-accounts.json") && attempts < 2) {
				attempts += 1;
				const error = new Error(code) as NodeJS.ErrnoException;
				error.code = code;
				throw error;
			}
			return undefined as never;
		});

		const clearPromise = clearAccountStorageArtifacts({
			path: join(testTmpRoot, "tmp-accounts.json"),
			resetMarkerPath: join(testTmpRoot, "tmp-accounts.marker"),
			walPath: join(testTmpRoot, "tmp-accounts.wal"),
			backupPaths: [],
			logError: vi.fn(),
		});

		await vi.runAllTimersAsync();
		await expect(clearPromise).resolves.toBeUndefined();
		expect(unlinkSpy).toHaveBeenCalled();
	});
});
