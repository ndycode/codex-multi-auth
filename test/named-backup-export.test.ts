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
	saveAccounts,
	setStoragePathDirect,
} from "../lib/storage.js";

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
		await fs.rm(testRoot, { recursive: true, force: true });
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
		"backup.rotate.snapshot",
		"backup.tmp",
		"backup.wal",
	])("rejects recovery-conflicting backup name %j", (input) => {
		expect(() => normalizeNamedBackupFileName(input)).toThrow();
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
});
