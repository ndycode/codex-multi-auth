import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildNamedBackupPath,
	getNamedBackups,
	loadAccounts,
	restoreAccountsFromBackup,
	saveAccounts,
	setStoragePathDirect,
} from "../lib/storage.js";

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	const retryable = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !retryable.has(code) || attempt === 5) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("storage last backup restore", () => {
	const testRoot = join(
		tmpdir(),
		`codex-last-backup-${Math.random().toString(36).slice(2)}`,
	);
	let storagePath: string;

	beforeEach(async () => {
		await fs.mkdir(testRoot, { recursive: true });
		storagePath = join(testRoot, "openai-codex-accounts.json");
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await removeWithRetry(testRoot, { recursive: true, force: true });
	});

	it("returns an empty array when the named backups directory is missing", async () => {
		await expect(getNamedBackups()).resolves.toEqual([]);
	});

	it("returns an empty array when every named backup has zero accounts", async () => {
		const emptyOnePath = buildNamedBackupPath("empty-one");
		const emptyTwoPath = buildNamedBackupPath("empty-two");
		await fs.mkdir(dirname(emptyOnePath), { recursive: true });
		for (const backupPath of [emptyOnePath, emptyTwoPath]) {
			await fs.writeFile(
				backupPath,
				JSON.stringify({
					version: 3,
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
					accounts: [],
				}),
				"utf-8",
			);
		}

		await expect(getNamedBackups()).resolves.toEqual([]);
	});

	it("prefers the most recently modified valid named backup with accounts", async () => {
		const oldBackupPath = buildNamedBackupPath("backup-old");
		const newBackupPath = buildNamedBackupPath("backup-new");
		await fs.mkdir(dirname(oldBackupPath), { recursive: true });
		await fs.writeFile(
			oldBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "old-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);
		await fs.writeFile(
			newBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{ refreshToken: "new-refresh-1", addedAt: 1, lastUsed: 1 },
					{ refreshToken: "new-refresh-2", addedAt: 2, lastUsed: 2 },
				],
			}),
			"utf-8",
		);
		await fs.utimes(oldBackupPath, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-01T00:00:00.000Z"));
		await fs.utimes(newBackupPath, new Date("2026-03-02T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z"));

		const backups = await getNamedBackups();

		expect(backups[0]).toMatchObject({
			path: newBackupPath,
			fileName: "backup-new.json",
			accountCount: 2,
		});

		expect(backups.map((backup) => backup.fileName)).toEqual([
			"backup-new.json",
			"backup-old.json",
		]);
	});

	it("skips a backup that disappears before stat and falls back to the next valid backup", async () => {
		const flakyBackupPath = buildNamedBackupPath("backup-flaky");
		const stableBackupPath = buildNamedBackupPath("backup-stable");
		await fs.mkdir(dirname(flakyBackupPath), { recursive: true });
		await fs.writeFile(
			flakyBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "flaky-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);
		await fs.writeFile(
			stableBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "stable-refresh", addedAt: 2, lastUsed: 2 }],
			}),
			"utf-8",
		);
		await fs.utimes(flakyBackupPath, new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-03T00:00:00.000Z"));
		await fs.utimes(stableBackupPath, new Date("2026-03-02T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z"));

		const originalStat = fs.stat.bind(fs);
		const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
			if (String(path) === flakyBackupPath) {
				await fs.rm(flakyBackupPath, { force: true });
				const error = new Error(
					`ENOENT: no such file or directory, stat '${flakyBackupPath}'`,
				) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return originalStat(
				path as Parameters<typeof originalStat>[0],
				options as Parameters<typeof originalStat>[1],
			);
		});

		const backups = await getNamedBackups();

		statSpy.mockRestore();
		expect(backups[0]).toMatchObject({
			path: stableBackupPath,
			fileName: "backup-stable.json",
			accountCount: 1,
		});
	});

	it("restores a named backup into active storage", async () => {
		const backupPath = buildNamedBackupPath("backup-restore");
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 1,
				activeIndexByFamily: { codex: 1 },
				accounts: [
					{ refreshToken: "refresh-1", addedAt: 1, lastUsed: 1 },
					{ refreshToken: "refresh-2", addedAt: 2, lastUsed: 2 },
				],
			}),
			"utf-8",
		);
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [{ refreshToken: "current-refresh", addedAt: 10, lastUsed: 10 }],
		});

		const restored = await restoreAccountsFromBackup(backupPath);
		const loaded = await loadAccounts();

		expect(restored.accounts).toHaveLength(2);
		expect(restored.activeIndex).toBe(1);
		expect(loaded?.accounts).toHaveLength(2);
		expect(loaded?.activeIndex).toBe(1);
		expect(loaded?.accounts[1]?.refreshToken).toBe("refresh-2");
	});
});
