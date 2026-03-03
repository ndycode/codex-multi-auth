import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadAccounts,
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
		workDir = join(tmpdir(), `codex-storage-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		await fs.writeFile(`${storagePath}.bak`, JSON.stringify(backupPayload), "utf-8");

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
		await fs.writeFile(`${storagePath}.bak.1`, JSON.stringify(historicalBackupPayload), "utf-8");

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
		await fs.writeFile(`${storagePath}.bak.2`, JSON.stringify(oldestBackupPayload), "utf-8");

		const recovered = await loadAccounts();
		expect(recovered?.accounts).toHaveLength(1);
		expect(recovered?.accounts[0]?.accountId).toBe("from-backup-2");

		const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
			accounts?: Array<{ accountId?: string }>;
		};
		expect(persisted.accounts?.[0]?.accountId).toBe("from-backup-2");
	});

	it("cleans up stale staged backup artifacts during load", async () => {
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "primary-refresh", accountId: "primary", addedAt: 6, lastUsed: 6 }],
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
				accounts: [{ refreshToken: "backup-refresh", accountId: "disabled-backup", addedAt: 3, lastUsed: 3 }],
			}),
			"utf-8",
		);

		const recovered = await loadAccounts();
		expect(recovered).toBeNull();
	});
});

