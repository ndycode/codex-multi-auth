import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFlaggedAccountsOnDisk,
	loadFlaggedAccountsState,
	saveFlaggedAccountsUnlockedToDisk,
} from "../lib/storage/flagged-storage-io.js";

// Use os.tmpdir() instead of process.cwd() so the test never leaves stray
// tmp-flagged.* artifacts at the repo root. Previously these files leaked
// into the worktree and tripped repo hygiene checks (AUDIT-M31 / E-02).
const testTmpRoot = join(tmpdir(), "codex-multi-auth-flagged-storage-tests");

describe("flagged storage io helpers", () => {
	beforeEach(async () => {
		await fs.mkdir(testTmpRoot, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(testTmpRoot, { recursive: true, force: true });
		} catch {
			// Ignore: rm can race with antivirus scanners on Windows.
		}
	});

	it("returns empty storage when files are missing", async () => {
		const result = await loadFlaggedAccountsState({
			path: join(testTmpRoot, "flagged.json"),
			legacyPath: join(testTmpRoot, "legacy.json"),
			resetMarkerPath: join(testTmpRoot, "reset"),
			normalizeFlaggedStorage: () => ({
				version: 1,
				accounts: [{ refreshToken: "x" }],
			}),
			saveFlaggedAccounts: vi.fn(),
			logError: vi.fn(),
			logInfo: vi.fn(),
		});

		expect(result).toEqual({ version: 1, accounts: [] });
	});

	it("writes flagged storage using injected helpers", async () => {
		const copyFileWithRetry = vi.fn(async () => undefined);
		const renameFileWithRetry = vi.fn(async () => undefined);
		await saveFlaggedAccountsUnlockedToDisk(
			{ version: 1, accounts: [] },
			{
				path: join(testTmpRoot, "tmp-flagged.json"),
				markerPath: join(testTmpRoot, "tmp-flagged.marker"),
				normalizeFlaggedStorage: (data) => data as never,
				copyFileWithRetry,
				renameFileWithRetry,
				logWarn: vi.fn(),
				logError: vi.fn(),
			},
		);

		expect(renameFileWithRetry).toHaveBeenCalled();
		expect(copyFileWithRetry).not.toThrow;
	});

	it("clears flagged account files with best-effort backup cleanup", async () => {
		await expect(
			clearFlaggedAccountsOnDisk({
				path: join(testTmpRoot, "tmp-flagged.json"),
				markerPath: join(testTmpRoot, "tmp-flagged.marker"),
				backupPaths: [join(testTmpRoot, "tmp-flagged.json.bak")],
				logError: vi.fn(),
			}),
		).resolves.toBeUndefined();
	});
});
