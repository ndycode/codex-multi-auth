import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assessNamedBackupRestore,
	getNamedBackupsDirectoryPath,
	loadAccounts,
	restoreNamedBackup,
	saveAccounts,
	setStorageBackupEnabled,
	setStoragePathDirect,
} from "../lib/storage.js";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("storage recovery paths", () => {
	let workDir = "";
	let storagePath = "";

	beforeEach(async () => {
		workDir = join(
			tmpdir(),
			`codex-storage-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		storagePath = join(workDir, "openai-codex-accounts.json");
		await fs.mkdir(workDir, { recursive: true });
		setStoragePathDirect(storagePath);
		setStorageBackupEnabled(true);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		setStorageBackupEnabled(true);
		await fs.rm(workDir, { recursive: true, force: true });
	});

	it("recovers from WAL journal when primary storage is unreadable", async () => {
		await fs.writeFile(storagePath, "{invalid-json", "utf-8");

		const walPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "wal-refresh",
					accountId: "from-wal",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
		const walContent = JSON.stringify(walPayload);
		const walEntry = {
			version: 1,
			createdAt: Date.now(),
			path: storagePath,
			checksum: sha256(walContent),
			content: walContent,
		};
		await fs.writeFile(`${storagePath}.wal`, JSON.stringify(walEntry), "utf-8");

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.accountId).toBe("from-wal");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ accountId?: string }>;
		};
		expect(persisted.accounts?.[0]?.accountId).toBe("from-wal");
	});

	it("recovers from backup file when WAL is unavailable", async () => {
		await fs.writeFile(storagePath, "{still-invalid", "utf-8");

		const backupPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "backup-refresh",
					accountId: "from-backup",
					addedAt: 2,
					lastUsed: 2,
				},
			],
		};
		await fs.writeFile(
			`${storagePath}.bak`,
			JSON.stringify(backupPayload),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.accountId).toBe("from-backup");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ accountId?: string }>;
		};
		expect(persisted.accounts?.[0]?.accountId).toBe("from-backup");
	});

	it("falls back to historical backup snapshots when the latest backup is unreadable", async () => {
		await fs.writeFile(storagePath, "{broken-primary", "utf-8");
		await fs.writeFile(`${storagePath}.bak`, "{broken-latest-backup", "utf-8");

		const historicalBackupPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "historical-refresh",
					accountId: "from-backup-history",
					addedAt: 4,
					lastUsed: 4,
				},
			],
		};
		await fs.writeFile(
			`${storagePath}.bak.1`,
			JSON.stringify(historicalBackupPayload),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.accountId).toBe("from-backup-history");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ accountId?: string }>;
		};
		expect(persisted.accounts?.[0]?.accountId).toBe("from-backup-history");
	});

	it("falls back to .bak.2 when newer backups are unreadable", async () => {
		await fs.writeFile(storagePath, "{broken-primary", "utf-8");
		await fs.writeFile(`${storagePath}.bak`, "{broken-bak", "utf-8");
		await fs.writeFile(`${storagePath}.bak.1`, "{broken-bak-1", "utf-8");

		const oldestBackupPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "deep-refresh",
					accountId: "from-backup-2",
					addedAt: 5,
					lastUsed: 5,
				},
			],
		};
		await fs.writeFile(
			`${storagePath}.bak.2`,
			JSON.stringify(oldestBackupPayload),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.accountId).toBe("from-backup-2");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ accountId?: string }>;
		};
		expect(persisted.accounts?.[0]?.accountId).toBe("from-backup-2");
	});

	it("recovers from discovered non-standard backup artifact when primary file is missing", async () => {
		const discoveredBackupPath = `${storagePath}.manual-before-dedupe-2026-03-03T00-25-19-753Z`;
		await fs.writeFile(
			discoveredBackupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "manual-refresh",
						accountId: "from-discovered-backup",
						addedAt: 6,
						lastUsed: 6,
					},
				],
			}),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.accountId).toBe("from-discovered-backup");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ accountId?: string }>;
		};
		expect(persisted.accounts?.[0]?.accountId).toBe("from-discovered-backup");
	});

	it("auto-promotes backup when primary storage matches synthetic fixture pattern", async () => {
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						email: "account1@example.com",
						refreshToken: "fake_refresh_token_1",
						accountId: "acc_1",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						email: "account2@example.com",
						refreshToken: "fake_refresh_token_2",
						accountId: "acc_2",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			"utf-8",
		);
		await fs.writeFile(
			`${storagePath}.manual-before-dedupe-2026-03-03T00-25-19-753Z`,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						email: "realuser@gmail.com",
						refreshToken: "real-refresh-token",
						accountId: "real-account",
						addedAt: 2,
						lastUsed: 2,
					},
				],
			}),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.email).toBe("realuser@gmail.com");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ email?: string }>;
		};
		expect(persisted.accounts?.[0]?.email).toBe("realuser@gmail.com");
	});

	it("auto-promotes backup when synthetic fixture accounts are missing accountId fields", async () => {
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						email: "account1@example.com",
						refreshToken: "fake_refresh_token_1_for_testing_only",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						email: "account2@example.com",
						refreshToken: "fake_refresh_token_2_for_testing_only",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			"utf-8",
		);
		await fs.writeFile(
			`${storagePath}.manual-pre-recovery-test-latest`,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						email: "realuser2@gmail.com",
						refreshToken: "real-refresh-token-2",
						accountId: "real-account-2",
						addedAt: 2,
						lastUsed: 2,
					},
				],
			}),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.email).toBe("realuser2@gmail.com");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ email?: string }>;
		};
		expect(persisted.accounts?.[0]?.email).toBe("realuser2@gmail.com");
	});

	it("rejects saving synthetic fixture payload over real account storage", async () => {
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						email: "realuser@gmail.com",
						refreshToken: "real-refresh-token",
						accountId: "real-account",
						addedAt: 10,
						lastUsed: 10,
					},
				],
			}),
			"utf-8",
		);

		await expect(
			saveAccounts({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: {},
				accounts: [
					{
						email: "account1@example.com",
						refreshToken: "fake_refresh_token_1",
						accountId: "acc_1",
						addedAt: 11,
						lastUsed: 11,
					},
				],
			}),
		).rejects.toThrow("Refusing to overwrite non-synthetic account storage");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ email?: string }>;
		};
		expect(persisted.accounts?.[0]?.email).toBe("realuser@gmail.com");
	});

	it("refuses restore when backup would exceed account limit", async () => {
		const backupsDir = join(dirname(storagePath), "backups");
		await fs.mkdir(backupsDir, { recursive: true });
		const backupName = "too-many";
		const backupPath = join(backupsDir, `${backupName}.json`);
		const oversizedAccounts = Array.from({ length: 30 }, (_, i) => ({
			refreshToken: `ref-${i}`,
			accountId: `acc-${i}`,
			addedAt: i,
			lastUsed: i,
		}));
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: oversizedAccounts,
			}),
			"utf-8",
		);

		const assessment = await assessNamedBackupRestore(backupName);
		expect(assessment.wouldExceedLimit).toBe(true);
		expect(assessment.imported).toBeNull();
		expect(assessment.skipped).toBeNull();
		expect(assessment.activeAccountPreview).toEqual({
			current: null,
			next: null,
			outcome: "blocked",
			changed: false,
		});
		expect(assessment.namedBackupRestorePreview?.activeAccount).toEqual(
			assessment.activeAccountPreview,
		);
		expect(assessment.namedBackupRestorePreview?.conflicts).toEqual([]);

		await expect(restoreNamedBackup(backupName)).rejects.toThrow(/exceed/i);
	});

	it("cleans up stale staged backup artifacts during load", async () => {
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "primary-refresh",
						accountId: "primary",
						addedAt: 6,
						lastUsed: 6,
					},
				],
			}),
			"utf-8",
		);

		const staleArtifacts = [
			`${storagePath}.bak.rotate.12345.abc123.latest.tmp`,
			`${storagePath}.bak.1.rotate.12345.abc123.slot-1.tmp`,
			`${storagePath}.bak.2.rotate.12345.abc123.slot-2.tmp`,
		];
		for (const staleArtifactPath of staleArtifacts) {
			await fs.writeFile(staleArtifactPath, "stale", "utf-8");
			expect(existsSync(staleArtifactPath)).toBe(true);
		}
		const unrelatedArtifactPath = `${storagePath}.rotate.12345.abc123.latest.tmp`;
		await fs.writeFile(unrelatedArtifactPath, "keep", "utf-8");
		expect(existsSync(unrelatedArtifactPath)).toBe(true);

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.accountId).toBe("primary");

		for (const staleArtifactPath of staleArtifacts) {
			expect(existsSync(staleArtifactPath)).toBe(false);
		}
		expect(existsSync(unrelatedArtifactPath)).toBe(true);
	});

	it("does not use backup recovery when backups are disabled", async () => {
		setStorageBackupEnabled(false);
		await fs.writeFile(storagePath, "{broken-primary", "utf-8");
		await fs.writeFile(
			`${storagePath}.bak`,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "backup-refresh",
						accountId: "disabled-backup",
						addedAt: 3,
						lastUsed: 3,
					},
				],
			}),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered).toBeNull();
	});

	it("previews restore conflicts and active outcome before applying backup", async () => {
		const currentStorage = {
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: {},
			accounts: [
				{
					email: "keep@example.com",
					refreshToken: "rt-keep",
					accountId: "keep",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					email: "replace@example.com",
					refreshToken: "rt-old",
					accountId: "replace",
					addedAt: 1,
					lastUsed: 2,
				},
			],
		};
		await saveAccounts(currentStorage);

		const backupDir = getNamedBackupsDirectoryPath();
		await fs.mkdir(backupDir, { recursive: true });
		const backupPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "replace@example.com",
					refreshToken: "rt-new",
					accountId: "replace",
					addedAt: 3,
					lastUsed: 5,
				},
				{
					email: "new@example.com",
					refreshToken: "rt-new-1",
					accountId: "new-1",
					addedAt: 3,
					lastUsed: 3,
				},
				{
					email: "duplicate@example.com",
					refreshToken: "dup-1",
					accountId: "dup-1",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					email: "duplicate@example.com",
					refreshToken: "dup-2",
					accountId: "dup-2",
					addedAt: 2,
					lastUsed: 2,
				},
				{
					email: "keep@example.com",
					refreshToken: "rt-keep-bak",
					accountId: "keep-bak",
					addedAt: 0,
					lastUsed: 0,
				},
			],
		};
		await fs.writeFile(
			join(backupDir, "preview.json"),
			JSON.stringify(backupPayload),
			"utf-8",
		);

		const assessment = await assessNamedBackupRestore("preview", {
			currentStorage,
		});

		expect(assessment.valid).toBe(true);
		expect(assessment.backupAccountCount).toBe(5);
		expect(assessment.dedupedBackupAccountCount).toBe(4);
		expect(assessment.imported).toBe(2);
		expect(assessment.skipped).toBe(3);
		expect(assessment.conflictsWithinBackup).toBe(1);
		expect(assessment.conflictsWithExisting).toBe(1);
		expect(assessment.overlappingAccountConflicts).toEqual([
			{
				backupIndex: 0,
				backupEmail: "replace@example.com",
				backupAccountId: "replace",
				currentIndex: 1,
				currentEmail: "replace@example.com",
				currentAccountId: "replace",
				reasons: ["accountId", "email"],
				resolution: "backup-kept",
			},
			{
				backupIndex: 4,
				backupEmail: "keep@example.com",
				backupAccountId: "keep-bak",
				currentIndex: 0,
				currentEmail: "keep@example.com",
				currentAccountId: "keep",
				reasons: ["email"],
				resolution: "current-kept",
			},
		]);
		expect(assessment.replacedExistingCount).toBe(1);
		expect(assessment.keptBackupCount).toBe(3);
		expect(assessment.activeAccountOutcome).toBe("unchanged");
		expect(assessment.activeAccountPreview).toEqual({
			current: {
				index: 1,
				email: "replace@example.com",
				accountId: "replace",
			},
			next: {
				index: 1,
				email: "replace@example.com",
				accountId: "replace",
			},
			outcome: "unchanged",
			changed: false,
		});
		expect(assessment.namedBackupRestorePreview).toBeDefined();
		expect(assessment.namedBackupRestorePreview?.activeAccount).toEqual(
			assessment.activeAccountPreview,
		);
		const previewConflicts =
			assessment.namedBackupRestorePreview?.conflicts ?? [];
		expect(previewConflicts).toHaveLength(2);
		expect(previewConflicts[0]?.backup).toEqual({
			index: 0,
			email: "replace@example.com",
			accountId: "replace",
		});
		expect(previewConflicts[0]?.current).toEqual({
			index: 1,
			email: "replace@example.com",
			accountId: "replace",
		});
		expect(previewConflicts[1]?.backup?.email).toBe("keep@example.com");
		expect(previewConflicts[1]?.current?.email).toBe("keep@example.com");
		expect(assessment.nextActiveEmail).toBe("replace@example.com");
		expect(assessment.currentActiveEmail).toBe("replace@example.com");
	});
});
