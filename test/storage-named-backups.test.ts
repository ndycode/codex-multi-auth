import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNamedBackupRoot } from "../lib/named-backup-export.js";
import { collectNamedBackups } from "../lib/storage/named-backups.js";

async function removeWithRetry(targetPath: string): Promise<void> {
	const retryable = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !retryable.has(code) || attempt === 5) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("storage named backups helper", () => {
	let rootDir = "";

	beforeEach(async () => {
		rootDir = join(
			tmpdir(),
			`codex-storage-named-backups-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(rootDir, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetry(rootDir);
	});

	it("returns empty when the backup directory is missing", async () => {
		const result = await collectNamedBackups(rootDir, {
			loadAccountsFromPath: vi.fn(),
			logDebug: vi.fn(),
		});

		expect(result).toEqual([]);
	});

	it("collects only valid non-empty json backups sorted by newest mtime", async () => {
		const backupRoot = getNamedBackupRoot(rootDir);
		await fs.mkdir(backupRoot, { recursive: true });
		const olderPath = join(backupRoot, "older.json");
		const newerPath = join(backupRoot, "newer.json");
		const ignoredPath = join(backupRoot, "ignored.txt");
		await fs.writeFile(olderPath, "{}", "utf8");
		await fs.writeFile(newerPath, "{}", "utf8");
		await fs.writeFile(ignoredPath, "nope", "utf8");
		const now = Date.now();
		await fs.utimes(olderPath, now / 1000 - 5, now / 1000 - 5);
		await fs.utimes(newerPath, now / 1000, now / 1000);

		const result = await collectNamedBackups(rootDir, {
			loadAccountsFromPath: async (path) => ({
				normalized:
					path === olderPath
						? { accounts: [{ id: "a" }] }
						: path === newerPath
							? { accounts: [{ id: "b" }, { id: "c" }] }
							: null,
			}),
			logDebug: vi.fn(),
		});

		expect(result.map((entry) => entry.fileName)).toEqual([
			"newer.json",
			"older.json",
		]);
		expect(result.map((entry) => entry.accountCount)).toEqual([2, 1]);
	});

	it("logs and skips invalid backup candidates", async () => {
		const backupRoot = getNamedBackupRoot(rootDir);
		await fs.mkdir(backupRoot, { recursive: true });
		const badPath = join(backupRoot, "bad.json");
		await fs.writeFile(badPath, "{}", "utf8");
		const logDebug = vi.fn();

		const result = await collectNamedBackups(rootDir, {
			loadAccountsFromPath: async () => {
				throw new Error("boom");
			},
			logDebug,
		});

		expect(result).toEqual([]);
		expect(logDebug).toHaveBeenCalledWith(
			"Skipping named backup candidate after loadAccountsFromPath/fs.stat failure",
			expect.objectContaining({
				candidatePath: badPath,
				fileName: "bad.json",
			}),
		);
	});
});
