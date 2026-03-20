import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildNamedBackupPath,
	getLatestNamedBackup,
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

		const latest = await getLatestNamedBackup();

		expect(latest).toMatchObject({
			path: newBackupPath,
			fileName: "backup-new.json",
			accountCount: 2,
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
