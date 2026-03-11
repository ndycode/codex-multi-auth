import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exportNamedBackupFile,
	normalizeNamedBackupFileName,
	resolveNamedBackupPath,
} from "../lib/named-backup-export.js";
import {
	exportAccounts,
	getStoragePath,
	loadAccounts,
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

describe("named backup export", () => {
	const testRoot = join(
		tmpdir(),
		`codex-named-backup-${Math.random().toString(36).slice(2)}`,
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

	it("normalizes backup-2026-03-09 to a .json file in the local backup namespace", () => {
		expect(normalizeNamedBackupFileName("backup-2026-03-09")).toBe(
			"backup-2026-03-09.json",
		);

		const resolvedPath = resolveNamedBackupPath(
			"backup-2026-03-09",
			storagePath,
		);
		expect(resolvedPath).toBe(
			join(dirname(storagePath), "backups", "backup-2026-03-09.json"),
		);
	});

	it.each(["", "   "])("rejects blank backup name %j", (input) => {
		expect(() => normalizeNamedBackupFileName(input)).toThrow(
			/non-empty filename/,
		);
	});

	it.each([
		"backup/2026-03-09",
		String.raw`backup\2026-03-09`,
		"../backup-2026-03-09",
	])("rejects traversal-style backup name %j", (input) => {
		expect(() => normalizeNamedBackupFileName(input)).toThrow();
	});

	it.each([
		["backup.rotate.snapshot", /rotation-style/],
		["backup.tmp", /temporary suffixes/],
		["backup.wal", /temporary suffixes/],
		["backup.tmp.json", /temporary suffixes/],
	])("rejects recovery-conflicting backup name %j", (input, pattern) => {
		expect(() => normalizeNamedBackupFileName(input)).toThrow(pattern);
	});

	it("fails on an existing backup file by default", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct-1",
					refreshToken: "refresh-1",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		const destination = resolveNamedBackupPath(
			"backup-2026-03-09",
			storagePath,
		);
		await fs.mkdir(dirname(destination), { recursive: true });
		await fs.writeFile(destination, "already-here", "utf-8");

		await expect(
			exportNamedBackupFile("backup-2026-03-09", {
				getStoragePath,
				exportAccounts,
			}),
		).rejects.toThrow(/already exists/);
	});

	it("allows only one concurrent export for the same backup name by default", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct-concurrent",
					refreshToken: "refresh-concurrent",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		const results = await Promise.allSettled([
			exportNamedBackupFile("backup-2026-03-09-concurrent", {
				getStoragePath,
				exportAccounts,
			}),
			exportNamedBackupFile("backup-2026-03-09-concurrent", {
				getStoragePath,
				exportAccounts,
			}),
		]);

		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<string> =>
				result.status === "fulfilled",
		);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(String(rejected[0]?.reason)).toMatch(/already exists/);

		const backupPath = fulfilled[0]?.value;
		expect(backupPath).toBeDefined();
		if (!backupPath) {
			throw new Error("Expected one concurrent export to succeed");
		}

		const exported = JSON.parse(await fs.readFile(backupPath, "utf-8")) as {
			accounts: Array<{ accountId?: string }>;
		};
		expect(exported.accounts[0]?.accountId).toBe("acct-concurrent");
	});

	it("never resolves outside the intended local backup namespace", () => {
		const safePath = resolveNamedBackupPath("backup-2026-03-09", storagePath);
		expect(safePath.startsWith(join(dirname(storagePath), "backups"))).toBe(
			true,
		);
		expect(dirname(safePath)).toBe(join(dirname(storagePath), "backups"));

		expect(() => resolveNamedBackupPath("../escape", storagePath)).toThrow();
		expect(() =>
			resolveNamedBackupPath(String.raw`..\escape`, storagePath),
		).toThrow();
	});

	it("rejects backup roots that escape through a symlinked backups directory", async () => {
		const externalRoot = join(testRoot, "outside-backups");
		const backupRoot = join(dirname(storagePath), "backups");
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct-symlink",
					refreshToken: "refresh-symlink",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		await fs.mkdir(externalRoot, { recursive: true });
		await fs.symlink(
			externalRoot,
			backupRoot,
			process.platform === "win32" ? "junction" : "dir",
		);

		await expect(
			exportNamedBackupFile("backup-2026-03-12", {
				getStoragePath,
				exportAccounts,
			}),
		).rejects.toThrow(/escapes the backup root/);
	});

	it("creates the backup directory before delegating export", async () => {
		const calls: string[] = [];
		await exportNamedBackupFile("backup-2026-03-12-create", {
			getStoragePath,
			exportAccounts: async (filePath) => {
				calls.push(filePath);
				expect(existsSync(dirname(filePath))).toBe(true);
			},
		});

		expect(calls).toHaveLength(1);
		expect(existsSync(join(dirname(storagePath), "backups"))).toBe(true);
	});

	it("exports the current storage JSON into the resolved named backup file", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct-1",
					refreshToken: "refresh-1",
					addedAt: 10,
					lastUsed: 20,
				},
			],
		});

		const backupPath = await exportNamedBackupFile("backup-2026-03-09", {
			getStoragePath,
			exportAccounts,
		});

		expect(backupPath).toBe(
			join(dirname(storagePath), "backups", "backup-2026-03-09.json"),
		);
		expect(existsSync(backupPath)).toBe(true);

		const exported = JSON.parse(await fs.readFile(backupPath, "utf-8")) as {
			accounts: Array<{ accountId?: string }>;
		};
		expect(exported.accounts[0]?.accountId).toBe("acct-1");
	});

	it("overwrites an existing backup when force is enabled", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct-force",
					refreshToken: "refresh-force",
					addedAt: 10,
					lastUsed: 20,
				},
			],
		});

		const destination = resolveNamedBackupPath(
			"backup-2026-03-10",
			storagePath,
		);
		await fs.mkdir(dirname(destination), { recursive: true });
		await fs.writeFile(destination, JSON.stringify({ stale: true }), "utf-8");

		const backupPath = await exportNamedBackupFile(
			"backup-2026-03-10",
			{
				getStoragePath,
				exportAccounts,
			},
			{ force: true },
		);

		expect(backupPath).toBe(destination);
		const exported = JSON.parse(await fs.readFile(backupPath, "utf-8")) as {
			accounts: Array<{ accountId?: string }>;
			stale?: boolean;
		};
		expect(exported.stale).toBeUndefined();
		expect(exported.accounts[0]?.accountId).toBe("acct-force");
	});

	it("exports named backups without deadlocking inside a storage transaction", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acct-transaction",
					refreshToken: "refresh-transaction",
					addedAt: 30,
					lastUsed: 40,
				},
			],
		});

		const { withAccountStorageTransaction } = await import("../lib/storage.js");
		const backupPath = await withAccountStorageTransaction(
			async (current, persist) => {
				const account = current?.accounts[0];
				expect(account).toBeDefined();
				if (account) {
					await persist({
						...current,
						accounts: current.accounts.map((entry, index) =>
							index === 0
								? { ...entry, accountId: "acct-transaction-updated" }
								: entry,
						),
					});
				}
				return await exportNamedBackupFile(
					"backup-2026-03-11",
					{
						getStoragePath,
						exportAccounts,
					},
					{ force: true },
				);
			},
		);

		expect(existsSync(backupPath)).toBe(true);
		const exported = JSON.parse(await fs.readFile(backupPath, "utf-8")) as {
			accounts: Array<{ accountId?: string }>;
		};
		expect(exported.accounts[0]?.accountId).toBe("acct-transaction-updated");
		const persisted = await loadAccounts();
		expect(persisted?.accounts[0]?.accountId).toBe("acct-transaction-updated");
	});
});
