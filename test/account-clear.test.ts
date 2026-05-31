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
		try {
			await fs.rm(testTmpRoot, { recursive: true, force: true });
		} catch {
			// Ignore: rm can race with antivirus scanners on Windows.
		}
	});

	it("writes the reset marker before clearing primary, wal, and backups (AUDIT-M04)", async () => {
		await expect(
			clearAccountStorageArtifacts({
				path: join(testTmpRoot, "tmp-accounts.json"),
				resetMarkerPath: join(testTmpRoot, "tmp-accounts.marker"),
				walPath: join(testTmpRoot, "tmp-accounts.wal"),
				backupPaths: [join(testTmpRoot, "tmp-accounts.json.bak")],
				logError: vi.fn(),
			}),
		).resolves.toBeUndefined();
		// AUDIT-M04 / E-07: marker is written first so a mid-run failure is
		// recognisable as an intentional reset instead of accidental loss.
		await expect(
			fs.stat(join(testTmpRoot, "tmp-accounts.marker")),
		).resolves.toBeTruthy();
	});

	it.each([
		"EBUSY",
		"EPERM",
		// storage-07: ENOTEMPTY and EACCES are now in the shared retryable set too.
		"ENOTEMPTY",
		"EACCES",
	] as const)("retries transient %s errors when clearing required artifacts", async (code) => {
		// Marker write is a real fs.writeFile; stub it so the test does
		// not depend on real disk I/O and so fake timers can drain the
		// retry backoff without racing a live write.
		const writeFileSpy = vi.spyOn(fs, "writeFile");
		writeFileSpy.mockResolvedValue(undefined);

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
		expect(writeFileSpy).toHaveBeenCalledTimes(1);
		expect(unlinkSpy).toHaveBeenCalled();
	});
});
