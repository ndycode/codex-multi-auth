import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import {
	loadAccounts,
	getBackupMetadata,
	saveAccounts,
	setStorageBackupEnabled,
	setStoragePathDirect,
	clearAccounts,
	getRestoreAssessment,
} from "../lib/storage.js";

function getRestoreEligibility(value: unknown): { restoreEligible?: boolean; restoreReason?: string } {
	if (value && typeof value === "object" && "restoreEligible" in value) {
		const candidate = value as { restoreEligible?: unknown; restoreReason?: unknown };
		return {
			restoreEligible: typeof candidate.restoreEligible === "boolean" ? candidate.restoreEligible : undefined,
			restoreReason: typeof candidate.restoreReason === "string" ? candidate.restoreReason : undefined,
		};
	}
	return {};
}

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
		await removeWithRetry(workDir, { recursive: true, force: true });
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

		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		try {
			process.env.HOME = workDir;
			process.env.USERPROFILE = workDir;

			const recovered = await loadAccounts();
			expect(recovered?.accounts).toHaveLength(1);
			expect(recovered?.accounts[0]?.accountId).toBe("from-discovered-backup");

			const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
				accounts?: Array<{ accountId?: string }>;
			};
			expect(persisted.accounts?.[0]?.accountId).toBe("from-discovered-backup");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
		}
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

	it("surfaces restore eligibility when account pool is missing", async () => {
		await fs.rm(storagePath, { force: true });

		const recovered = await loadAccounts();
		const eligibility = getRestoreEligibility(recovered);

		expect(eligibility.restoreEligible).toBe(true);
		expect(eligibility.restoreReason).toBe("missing-storage");
	});

	it("surfaces restore eligibility when account pool is empty", async () => {
		await fs.writeFile(
			storagePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);

		const recovered = await loadAccounts();
		const eligibility = getRestoreEligibility(recovered);

		expect(eligibility.restoreEligible).toBe(true);
		expect(eligibility.restoreReason).toBe("empty-storage");
	});

	it("suppresses restore eligibility after intentional reset but flags unexpected empty state", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "token-reset",
					accountId: "reset-account",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await clearAccounts();
		const afterIntentionalReset = await loadAccounts();
		const intentionalEligibility = getRestoreEligibility(afterIntentionalReset);
		expect(intentionalEligibility.restoreEligible).toBe(false);

		await saveAccounts({ version: 3, activeIndex: 0, accounts: [] });
		const afterAccidentalEmpty = await loadAccounts();
		const accidentalEligibility = getRestoreEligibility(afterAccidentalEmpty);
		expect(accidentalEligibility.restoreEligible).toBe(true);
	});

	it("assesses restore state with latest snapshot metadata", async () => {
		const backupPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "backup-refresh",
					accountId: "from-backup",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
		await fs.writeFile(`${storagePath}.bak`, JSON.stringify(backupPayload), "utf-8");

		const assessment = await getRestoreAssessment();

		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("missing-storage");
		expect(assessment.latestSnapshot?.path).toBe(`${storagePath}.bak`);
		expect(assessment.backupMetadata.accounts.latestValidPath).toBe(`${storagePath}.bak`);
	});

	it("ignores Codex CLI mirror files during restore assessment", async () => {
		const codexCliAccountsPath = join(workDir, "accounts.json");
		const codexCliAuthPath = join(workDir, "auth.json");
		await fs.writeFile(
			codexCliAccountsPath,
			JSON.stringify({
				activeAccountId: "mirror-account",
				accounts: [
					{
						accountId: "mirror-account",
						email: "mirror@example.com",
						auth: {
							tokens: {
								access_token: "mirror-access",
								refresh_token: "mirror-refresh",
							},
						},
					},
				],
			}),
			"utf-8",
		);
		await fs.writeFile(
			codexCliAuthPath,
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					access_token: "mirror-access",
					refresh_token: "mirror-refresh",
					account_id: "mirror-account",
				},
			}),
			"utf-8",
		);

		const recovered = await loadAccounts();
		const eligibility = getRestoreEligibility(recovered);
		expect(recovered?.accounts).toHaveLength(0);
		expect(eligibility.restoreEligible).toBe(true);
		expect(eligibility.restoreReason).toBe("missing-storage");

		const assessment = await getRestoreAssessment();
		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("missing-storage");
		expect(assessment.latestSnapshot).toBeUndefined();
		expect(assessment.backupMetadata.accounts.latestValidPath).toBeUndefined();
		expect(
			assessment.backupMetadata.accounts.snapshots.some(
				(snapshot) => snapshot.path === codexCliAccountsPath || snapshot.path === codexCliAuthPath,
			),
		).toBe(false);
	});

	it("returns restore eligibility and snapshot when storage is empty", async () => {
		await fs.writeFile(
			storagePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);

		const assessment = await getRestoreAssessment();

		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("empty-storage");
		expect(assessment.latestSnapshot?.path).toBe(storagePath);
	});

	it("suppresses restore once after intentional reset marker", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "token-reset",
					accountId: "reset-account",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await clearAccounts();

		const suppressed = await getRestoreAssessment();
		expect(suppressed.restoreEligible).toBe(false);
		expect(suppressed.restoreReason).toBe("intentional-reset");

		await saveAccounts({ version: 3, activeIndex: 0, accounts: [] });

		const eligibleAfterReset = await getRestoreAssessment();
		expect(eligibleAfterReset.restoreEligible).toBe(true);
		expect(eligibleAfterReset.restoreReason).toBe("empty-storage");
	});

	it("does not revive WAL contents after reset assessment runs before load", async () => {
		const walPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "stale-refresh",
					accountId: "stale-account",
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

		await saveAccounts(walPayload);
		await clearAccounts();
		await fs.writeFile(`${storagePath}.wal`, JSON.stringify(walEntry), "utf-8");

		const assessment = await getRestoreAssessment();
		expect(assessment.restoreEligible).toBe(false);
		expect(assessment.restoreReason).toBe("intentional-reset");

		const reloaded = await loadAccounts();
		expect(reloaded?.accounts).toHaveLength(0);
		expect(getRestoreEligibility(reloaded).restoreReason).toBe("intentional-reset");
	});

	it("suppresses WAL recovery when a reset marker appears while the WAL is being read", async () => {
		const walPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "racing-refresh",
					accountId: "racing-account",
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

		const originalReadFile = fs.readFile.bind(fs);
		const originalWriteFile = fs.writeFile.bind(fs);
		const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
			const [targetPath] = args;
			if (targetPath === `${storagePath}.wal`) {
				await originalWriteFile(
					`${storagePath}.reset-intent`,
					JSON.stringify({ version: 1, createdAt: Date.now() }),
					"utf-8",
				);
			}
			return originalReadFile(...args);
		});

		try {
			const reloaded = await loadAccounts();
			expect(reloaded?.accounts).toHaveLength(0);
			expect(getRestoreEligibility(reloaded).restoreReason).toBe("intentional-reset");
		} finally {
			readSpy.mockRestore();
		}
	});

	it("excludes reset markers from discovered backup metadata", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "marker-refresh",
					accountId: "marker-account",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await clearAccounts();

		const metadata = await getBackupMetadata();
		expect(
			metadata.accounts.snapshots.some((snapshot) =>
				snapshot.path.endsWith(".reset-intent"),
			),
		).toBe(false);
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

	it("exposes snapshot metadata and ignores cache-like artifacts", async () => {
		await fs.writeFile(storagePath, "{invalid-json", "utf-8");

		const walPayload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "wal-refresh-meta",
					accountId: "wal-account",
					addedAt: 10,
					lastUsed: 10,
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

		await fs.writeFile(
			`${storagePath}.bak`,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "bak-refresh-meta",
						accountId: "bak-account",
						addedAt: 5,
						lastUsed: 5,
					},
				],
			}),
			"utf-8",
		);

		await fs.writeFile(`${storagePath}.cache`, "noise", "utf-8");
		await fs.writeFile(
			`${storagePath}.manual-meta-checkpoint`,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "manual-refresh-meta",
						accountId: "manual-account",
						addedAt: 7,
						lastUsed: 7,
					},
				],
			}),
			"utf-8",
		);

		const metadata = await getBackupMetadata();
		const accountSnapshots = metadata.accounts.snapshots;
		const cacheEntries = accountSnapshots.filter((snapshot) => snapshot.path.endsWith(".cache"));
		expect(cacheEntries).toHaveLength(0);
		expect(metadata.accounts.latestValidPath).toBe(`${storagePath}.manual-meta-checkpoint`);
		const discovered = accountSnapshots.find((snapshot) => snapshot.path.endsWith("manual-meta-checkpoint"));
		expect(discovered?.kind).toBe("accounts-discovered-backup");
		expect(discovered?.valid).toBe(true);
		expect(discovered?.accountCount).toBe(1);
		expect(metadata.accounts.snapshotCount).toBeGreaterThanOrEqual(4);
	});

	it("prefers the newest valid discovered snapshot in backup metadata", async () => {
		const olderManualPath = `${storagePath}.manual-older`;
		const newerManualPath = `${storagePath}.manual-newer`;

		await fs.writeFile(
			olderManualPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "older-refresh", accountId: "older", addedAt: 1, lastUsed: 1 }],
			}),
			"utf-8",
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await fs.writeFile(
			newerManualPath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "newer-refresh", accountId: "newer", addedAt: 2, lastUsed: 2 }],
			}),
			"utf-8",
		);

		const metadata = await getBackupMetadata();
		expect(metadata.accounts.latestValidPath).toBe(newerManualPath);
	});
});

