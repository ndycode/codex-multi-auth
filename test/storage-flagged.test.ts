import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFlaggedAccounts,
	getBackupMetadata,
	getFlaggedAccountsPath,
	getStoragePath,
	loadFlaggedAccounts,
	saveFlaggedAccounts,
	setStoragePathDirect,
} from "../lib/storage.js";
import { loadFlaggedAccountsFromFile } from "../lib/storage/flagged-storage-file.js";
import { describeFlaggedSnapshot } from "../lib/storage/snapshot-inspectors.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return;
			}
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("flagged account storage", () => {
	const testRoot = join(
		tmpdir(),
		`codex-flagged-${Math.random().toString(36).slice(2)}`,
	);
	let storagePath = "";

	beforeEach(async () => {
		await fs.mkdir(testRoot, { recursive: true });
		storagePath = join(
			testRoot,
			`accounts-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setStoragePathDirect(null);
		await removeWithRetry(testRoot, { recursive: true, force: true });
	});

	it("returns an empty flagged storage object when files are absent", async () => {
		const flagged = await loadFlaggedAccounts();
		expect(flagged).toEqual({ version: 1, accounts: [] });
	});

	it("normalizes and de-duplicates flagged accounts on save/load", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "  duplicate-token  ",
					accountId: "acct-1",
					accountIdSource: "org",
					accountLabel: "work",
					email: "user@example.com",
					enabled: true,
					lastSwitchReason: "rate-limit",
					rateLimitResetTimes: { codex: 12345, invalid: "skip" as never },
					coolingDownUntil: 45678,
					cooldownReason: "auth-failure",
					addedAt: 100,
					lastUsed: 120,
					flaggedAt: 150,
					flaggedReason: "quota",
					lastError: "429",
				},
				{
					refreshToken: "duplicate-token",
					accountId: "acct-2",
					accountIdSource: "manual",
					addedAt: 200,
					lastUsed: 220,
					flaggedAt: 250,
				},
				{
					refreshToken: "",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				} as never,
			],
		});

		const flagged = await loadFlaggedAccounts();

		expect(flagged.accounts).toHaveLength(1);
		expect(flagged.accounts[0]).toEqual(
			expect.objectContaining({
				refreshToken: "duplicate-token",
				accountId: "acct-2",
				accountIdSource: "manual",
				flaggedAt: 250,
			}),
		);
	});

	it("preserves \"best\" as a flagged account switch reason on load", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "best-token",
					lastSwitchReason: "best",
					flaggedAt: 10,
					addedAt: 5,
					lastUsed: 9,
				},
			],
		});

		const flagged = await loadFlaggedAccounts();

		expect(flagged.accounts[0]?.lastSwitchReason).toBe("best");
	});

	it("migrates legacy blocked-account file to flagged-account storage", async () => {
		const legacyPath = join(
			dirname(getStoragePath()),
			"openai-codex-blocked-accounts.json",
		);
		await fs.mkdir(dirname(legacyPath), { recursive: true });
		await fs.writeFile(
			legacyPath,
			JSON.stringify(
				{
					version: 1,
					accounts: [
						{
							refreshToken: "legacy-token",
							flaggedAt: 999,
							addedAt: 900,
							lastUsed: 950,
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const flagged = await loadFlaggedAccounts();

		expect(flagged.accounts).toHaveLength(1);
		expect(flagged.accounts[0]?.refreshToken).toBe("legacy-token");
		expect(existsSync(legacyPath)).toBe(false);
		expect(existsSync(getFlaggedAccountsPath())).toBe(true);
	});

	it("returns empty storage when legacy migration content is invalid", async () => {
		const legacyPath = join(
			dirname(getStoragePath()),
			"openai-codex-blocked-accounts.json",
		);
		await fs.mkdir(dirname(legacyPath), { recursive: true });
		await fs.writeFile(legacyPath, "not-json", "utf-8");

		const flagged = await loadFlaggedAccounts();

		expect(flagged).toEqual({ version: 1, accounts: [] });
		expect(existsSync(legacyPath)).toBe(true);
	});

	it("clears flagged storage and tolerates missing files", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "clear-me",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "keep-backup",
					flaggedAt: 2,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		expect(existsSync(getFlaggedAccountsPath())).toBe(true);
		expect(existsSync(`${getFlaggedAccountsPath()}.bak`)).toBe(true);

		await clearFlaggedAccounts();
		await clearFlaggedAccounts();

		expect(existsSync(getFlaggedAccountsPath())).toBe(false);
		expect(existsSync(`${getFlaggedAccountsPath()}.bak`)).toBe(false);
	});

	it("does not revive flagged accounts from backups after clear", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "revive-test",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "revive-test",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "revive-test-2",
					flaggedAt: 2,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		await clearFlaggedAccounts();

		const flagged = await loadFlaggedAccounts();
		expect(flagged.accounts).toHaveLength(0);
	});

	it("suppresses flagged accounts when clear cannot delete the primary file after writing the reset marker", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "stale-primary",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		const flaggedPath = getFlaggedAccountsPath();
		const originalUnlink = fs.unlink.bind(fs);
		const unlinkSpy = vi
			.spyOn(fs, "unlink")
			.mockImplementation(async (targetPath) => {
				if (targetPath === flaggedPath) {
					const error = new Error(
						"EPERM primary delete",
					) as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return originalUnlink(targetPath);
			});

		await expect(clearFlaggedAccounts()).rejects.toThrow(
			"EPERM primary delete",
		);

		const flagged = await loadFlaggedAccounts();
		expect(existsSync(flaggedPath)).toBe(true);
		expect(flagged.accounts).toHaveLength(0);

		unlinkSpy.mockRestore();
	});

	it("recovers flagged backups when the primary file exists but read fails", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "primary-flagged",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "backup-flagged",
					flaggedAt: 2,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		const flaggedPath = getFlaggedAccountsPath();
		const originalReadFile = fs.readFile.bind(fs);
		const readSpy = vi
			.spyOn(fs, "readFile")
			.mockImplementation(async (...args) => {
				const [targetPath] = args;
				if (targetPath === flaggedPath) {
					const error = new Error(
						"EPERM flagged read",
					) as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return originalReadFile(...args);
			});

		const flagged = await loadFlaggedAccounts();
		expect(flagged.accounts).toHaveLength(1);
		expect(flagged.accounts[0]?.refreshToken).toBe("primary-flagged");
		expect(existsSync(flaggedPath)).toBe(true);

		readSpy.mockRestore();
	});

	it("retries transient flagged primary read errors before falling back to backup", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "older-flagged",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "latest-flagged",
					flaggedAt: 2,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		const flaggedPath = getFlaggedAccountsPath();
		const originalReadFile = fs.readFile.bind(fs);
		let primaryReadAttempts = 0;
		const readSpy = vi
			.spyOn(fs, "readFile")
			.mockImplementation(async (...args) => {
				const [targetPath] = args;
				if (targetPath === flaggedPath) {
					primaryReadAttempts += 1;
					if (primaryReadAttempts === 1) {
						const error = new Error("EBUSY flagged read") as NodeJS.ErrnoException;
						error.code = "EBUSY";
						throw error;
					}
				}
				return originalReadFile(...args);
			});

		try {
			const flagged = await loadFlaggedAccounts();
			expect(flagged.accounts).toHaveLength(1);
			expect(flagged.accounts[0]?.refreshToken).toBe("latest-flagged");
			expect(primaryReadAttempts).toBe(2);
			expect(
				readSpy.mock.calls.some(
					([targetPath]) => targetPath === `${flaggedPath}.bak`,
				),
			).toBe(false);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("skips invalid latest flagged backups and falls back to older valid snapshots", async () => {
		const flaggedPath = getFlaggedAccountsPath();
		await fs.mkdir(dirname(flaggedPath), { recursive: true });
		await fs.writeFile(
			`${flaggedPath}.bak`,
			JSON.stringify({ version: 99, accounts: "broken" }),
			"utf8",
		);
		await fs.writeFile(
			`${flaggedPath}.bak.1`,
			JSON.stringify({
				version: 1,
				accounts: [
					{
						refreshToken: "valid-older-backup",
						flaggedAt: 3,
						addedAt: 3,
						lastUsed: 3,
					},
				],
			}),
			"utf8",
		);

		const flagged = await loadFlaggedAccounts();

		expect(flagged.accounts).toHaveLength(1);
		expect(flagged.accounts[0]?.refreshToken).toBe("valid-older-backup");
	});

	it("honors the reset marker even when it appears during backup recovery", async () => {
		const backupPath = `${getFlaggedAccountsPath()}.bak`;
		const resetMarkerPath = `${getFlaggedAccountsPath()}.reset-intent`;
		await fs.writeFile(
			backupPath,
			JSON.stringify({
				version: 1,
				accounts: [
					{
						refreshToken: "backup-race",
						flaggedAt: 1,
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			"utf8",
		);

		const originalReadFile = fs.readFile.bind(fs);
		const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
			const [targetPath] = args;
			const result = await originalReadFile(...args);
			if (targetPath === backupPath) {
				await fs.writeFile(resetMarkerPath, "reset", "utf8");
			}
			return result;
		});

		try {
			const flagged = await loadFlaggedAccounts();
			expect(flagged.accounts).toHaveLength(0);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("clears discovered flagged backup artifacts so manual snapshots cannot revive after clear", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "manual-backup-revive-test",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		const manualBackupPath = `${getFlaggedAccountsPath()}.manual-checkpoint`;
		await fs.copyFile(getFlaggedAccountsPath(), manualBackupPath);

		await clearFlaggedAccounts();

		const flagged = await loadFlaggedAccounts();
		expect(existsSync(manualBackupPath)).toBe(false);
		expect(flagged.accounts).toHaveLength(0);
	});

	it("suppresses flagged backup revival when clear only partially deletes backup artifacts", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "partial-delete-primary",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "partial-delete-secondary",
					flaggedAt: 2,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		const flaggedPath = getFlaggedAccountsPath();
		const backupPath = `${flaggedPath}.bak`;
		const originalUnlink = fs.unlink.bind(fs);
		const unlinkSpy = vi
			.spyOn(fs, "unlink")
			.mockImplementation(async (targetPath) => {
				if (targetPath === backupPath) {
					const error = new Error(
						"EACCES backup delete",
					) as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return originalUnlink(targetPath);
			});

		await clearFlaggedAccounts();

		const flagged = await loadFlaggedAccounts();
		expect(existsSync(backupPath)).toBe(true);
		expect(flagged.accounts).toHaveLength(0);

		unlinkSpy.mockRestore();
	});

	it("emits snapshot metadata for flagged account backups", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "first-flagged",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "first-flagged",
					flaggedAt: 1,
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "second-flagged",
					flaggedAt: 2,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		const metadata = await getBackupMetadata();
		const flagged = metadata.flaggedAccounts;
		expect(flagged.snapshotCount).toBeGreaterThanOrEqual(2);
		expect(flagged.latestValidPath).toBe(getFlaggedAccountsPath());
		const primary = flagged.snapshots.find(
			(snapshot) => snapshot.kind === "flagged-primary",
		);
		const backup = flagged.snapshots.find(
			(snapshot) => snapshot.kind === "flagged-backup",
		);
		expect(primary?.flaggedCount).toBe(2);
		expect(backup?.valid).toBe(true);
		expect(backup?.flaggedCount).toBe(1);
	});

	it("cleans temporary file when flagged save fails", async () => {
		const flaggedPath = getFlaggedAccountsPath();
		const originalRename = fs.rename.bind(fs);

		const renameSpy = vi
			.spyOn(fs, "rename")
			.mockImplementation(async (oldPath, newPath) => {
				if (newPath === flaggedPath) {
					const error = new Error(
						"forced rename failure",
					) as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return originalRename(oldPath, newPath);
			});

		await expect(
			saveFlaggedAccounts({
				version: 1,
				accounts: [
					{
						refreshToken: "tmp-cleanup",
						flaggedAt: 1,
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
		).rejects.toThrow("forced rename failure");

		const parent = dirname(flaggedPath);
		const entries = existsSync(parent) ? await fs.readdir(parent) : [];
		const tmpArtifacts = entries.filter(
			(entry) => entry.includes("flagged") && entry.endsWith(".tmp"),
		);
		expect(tmpArtifacts).toHaveLength(0);

		renameSpy.mockRestore();
	});
});


describe("flagged storage extracted helpers", () => {
	it("retries transient Windows read locks before parsing", async () => {
		const normalizeFlaggedStorage = vi.fn((data) => data as never);
		const readFile = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
			.mockRejectedValueOnce(Object.assign(new Error("again"), { code: "EAGAIN" }))
			.mockResolvedValueOnce('{"version":1,"accounts":[]}');
		await expect(
			loadFlaggedAccountsFromFile("flagged.json", {
				readFile,
				normalizeFlaggedStorage,
				sleep: vi.fn(async () => {}),
			}),
		).resolves.toEqual({ version: 1, accounts: [] });
		expect(readFile).toHaveBeenCalledTimes(3);
		expect(normalizeFlaggedStorage).toHaveBeenCalledWith({ version: 1, accounts: [] });
	});

	it("does not retry non-retryable permission errors", async () => {
		const sleep = vi.fn(async () => {});
		const readFile = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EPERM" }));
		await expect(
			loadFlaggedAccountsFromFile("flagged.json", {
				readFile,
				normalizeFlaggedStorage: vi.fn(),
				sleep,
			}),
		).rejects.toThrow("permission denied");
		expect(readFile).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("rethrows after retry budget is exhausted for windows lock errors", async () => {
		const sleep = vi.fn(async () => {});
		const readFile = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error("locked"), { code: "EBUSY" }));
		await expect(
			loadFlaggedAccountsFromFile("flagged.json", {
				readFile,
				normalizeFlaggedStorage: vi.fn(),
				sleep,
			}),
		).rejects.toThrow("locked");
		expect(readFile).toHaveBeenCalledTimes(4);
		expect(sleep).toHaveBeenNthCalledWith(1, 10);
		expect(sleep).toHaveBeenNthCalledWith(2, 20);
		expect(sleep).toHaveBeenNthCalledWith(3, 40);
	});


	it("propagates malformed JSON parse errors", async () => {
		await expect(
			loadFlaggedAccountsFromFile("flagged.json", {
				readFile: vi.fn(async () => "{"),
				normalizeFlaggedStorage: vi.fn(),
			}),
		).rejects.toBeInstanceOf(SyntaxError);
	});

	it("returns invalid existing metadata after transient read retries are exhausted", async () => {
		const logWarn = vi.fn();
		await expect(
			describeFlaggedSnapshot("flagged.json", "flagged-accounts", {
				index: 0,
				statSnapshot: vi.fn(async () => ({ exists: true, bytes: 12, mtimeMs: 34 })),
				loadFlaggedAccountsFromPath: vi.fn(async () => {
					throw Object.assign(new Error("locked"), { code: "EBUSY" });
				}),
				logWarn,
			}),
		).resolves.toEqual({
			kind: "flagged-accounts",
			path: "flagged.json",
			index: 0,
			exists: true,
			valid: false,
			bytes: 12,
			mtimeMs: 34,
		});
		expect(logWarn).toHaveBeenCalledWith(
			"Failed to inspect flagged snapshot",
			expect.objectContaining({ path: "flagged.json" }),
		);
	});

	it("does not log successful backup recovery when persisting the recovery fails", async () => {
		const { loadFlaggedAccountsState } = await import(
			"../lib/storage/flagged-storage-io.js"
		);
		const fixtureRoot = join(
			tmpdir(),
			`codex-flagged-io-${Math.random().toString(36).slice(2)}`,
		);
		const flaggedPath = join(fixtureRoot, "flagged.json");
		const resetMarkerPath = `${flaggedPath}.reset`;
		const logError = vi.fn();
		const logInfo = vi.fn();

		try {
			await fs.mkdir(fixtureRoot, { recursive: true });
			await fs.writeFile(
				`${flaggedPath}.bak`,
				JSON.stringify(
					{
						version: 1,
						accounts: [
							{
								refreshToken: "backup-token",
								flaggedAt: 1,
								addedAt: 1,
								lastUsed: 1,
							},
						],
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(
				loadFlaggedAccountsState({
					path: flaggedPath,
					legacyPath: `${flaggedPath}.legacy`,
					resetMarkerPath,
					normalizeFlaggedStorage: (data) => data as never,
					persistRecoveredBackup: vi.fn(async () => {
						throw new Error("persist failed");
					}),
					saveFlaggedAccounts: vi.fn(async () => {}),
					logError,
					logInfo,
				}),
			).resolves.toEqual({
				version: 1,
				accounts: [
					{
						refreshToken: "backup-token",
						flaggedAt: 1,
						addedAt: 1,
						lastUsed: 1,
					},
				],
			});
			expect(logError).toHaveBeenCalledWith(
				"Failed to persist recovered flagged account storage",
				expect.objectContaining({ from: `${flaggedPath}.bak`, to: flaggedPath }),
			);
			expect(logInfo).not.toHaveBeenCalled();
		} finally {
			await removeWithRetry(fixtureRoot, { recursive: true, force: true });
		}
	});
});
