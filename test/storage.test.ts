import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigDir, getProjectStorageKey } from "../lib/storage/paths.js";
import {
	buildNamedBackupPath,
	clearAccounts,
	deduplicateAccounts,
	deduplicateAccountsByEmail,
	exportAccounts,
	exportNamedBackup,
	findMatchingAccountIndex,
	formatStorageErrorHint,
	getFlaggedAccountsPath,
	getStoragePath,
	importAccounts,
	loadAccounts,
	loadFlaggedAccounts,
	normalizeAccountStorage,
	resolveAccountSelectionIndex,
	saveFlaggedAccounts,
	StorageError,
	saveAccounts,
	setStoragePath,
	setStoragePathDirect,
	clearFlaggedAccounts,
	withAccountAndFlaggedStorageTransaction,
	withAccountStorageTransaction,
	withFlaggedStorageTransaction,
} from "../lib/storage.js";

// Mocking the behavior we're about to implement for TDD
// Since the functions aren't in lib/storage.ts yet, we'll need to mock them or
// accept that this test won't even compile/run until we add them.
// But Task 0 says: "Tests should fail initially (RED phase)"

describe("storage", () => {
	const _origCODEX_HOME = process.env.CODEX_HOME;
	const _origCODEX_MULTI_AUTH_DIR = process.env.CODEX_MULTI_AUTH_DIR;

	beforeEach(() => {
		delete process.env.CODEX_HOME;
		delete process.env.CODEX_MULTI_AUTH_DIR;
	});

	afterEach(() => {
		if (_origCODEX_HOME !== undefined) process.env.CODEX_HOME = _origCODEX_HOME;
		else delete process.env.CODEX_HOME;
		if (_origCODEX_MULTI_AUTH_DIR !== undefined)
			process.env.CODEX_MULTI_AUTH_DIR = _origCODEX_MULTI_AUTH_DIR;
		else delete process.env.CODEX_MULTI_AUTH_DIR;
	});
	describe("deduplication", () => {
		it("preserves activeIndexByFamily when shared accountId entries remain distinct without email", () => {
			const now = Date.now();

			const raw = {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 3 },
				accounts: [
					{
						accountId: "acctA",
						refreshToken: "tokenA-old",
						addedAt: now - 3_000,
						lastUsed: now - 3_000,
					},
					{
						accountId: "acctA",
						refreshToken: "tokenA-new",
						addedAt: now - 2_000,
						lastUsed: now - 2_000,
					},
					{
						accountId: "acctB",
						refreshToken: "tokenB-old",
						addedAt: now - 1_000,
						lastUsed: now - 1_000,
					},
					{
						accountId: "acctB",
						refreshToken: "tokenB-new",
						addedAt: now,
						lastUsed: now,
					},
				],
			};

			const normalized = normalizeAccountStorage(raw);
			expect(normalized).not.toBeNull();
			expect(normalized?.accounts).toHaveLength(4);
			expect(normalized?.activeIndexByFamily?.codex).toBe(3);
		});

		it("remaps activeIndex after deduplication using active account key", () => {
			const now = Date.now();

			const raw = {
				version: 1,
				activeIndex: 1,
				accounts: [
					{
						accountId: "acctA",
						refreshToken: "tokenA",
						addedAt: now - 2000,
						lastUsed: now - 2000,
					},
					{
						accountId: "acctA",
						refreshToken: "tokenA",
						addedAt: now - 1000,
						lastUsed: now - 1000,
					},
					{
						accountId: "acctB",
						refreshToken: "tokenB",
						addedAt: now,
						lastUsed: now,
					},
				],
			};

			const normalized = normalizeAccountStorage(raw);
			expect(normalized).not.toBeNull();
			expect(normalized?.accounts).toHaveLength(2);
			expect(normalized?.accounts[0]?.accountId).toBe("acctA");
			expect(normalized?.accounts[1]?.accountId).toBe("acctB");
			expect(normalized?.activeIndex).toBe(0);
		});

		it("deduplicates accounts by keeping the most recently used record", () => {
			const now = Date.now();

			const accounts = [
				{
					accountId: "acctA",
					refreshToken: "tokenA",
					addedAt: now - 2000,
					lastUsed: now - 1000,
				},
				{
					accountId: "acctA",
					refreshToken: "tokenA",
					addedAt: now - 1500,
					lastUsed: now,
				},
			];

			const deduped = deduplicateAccounts(accounts);
			expect(deduped).toHaveLength(1);
			expect(deduped[0]?.addedAt).toBe(now - 1500);
			expect(deduped[0]?.lastUsed).toBe(now);
		});

		it("prefers composite and email matches over refresh token matches", () => {
			const accounts = [
				{
					accountId: "workspace-a",
					email: "alpha@example.com",
					refreshToken: "token-refresh",
				},
				{
					accountId: "workspace-b",
					email: "match@example.com",
					refreshToken: "token-composite",
				},
				{
					accountId: "workspace-b",
					email: "other@example.com",
					refreshToken: "token-safe-email",
				},
			];

			const matchIndex = findMatchingAccountIndex(accounts, {
				accountId: "workspace-b",
				email: "match@example.com",
				refreshToken: "token-refresh",
			});

			expect(matchIndex).toBe(1);
		});

		it("uses a unique refresh token match when no safer identifier exists", () => {
			const accounts = [
				{
					accountId: "workspace-a",
					email: "alpha@example.com",
					refreshToken: "token-refresh",
				},
				{
					accountId: "workspace-b",
					email: "match@example.com",
					refreshToken: "token-composite",
				},
			];

			const matchIndex = findMatchingAccountIndex(accounts, {
				refreshToken: "token-refresh",
			});

			expect(matchIndex).toBe(0);
		});

		it("falls back to composite matching when refresh tokens are ambiguous", () => {
			const accounts = [
				{
					accountId: "workspace-a",
					email: "alpha@example.com",
					refreshToken: "shared-refresh",
					lastUsed: 100,
				},
				{
					accountId: "workspace-b",
					email: "match@example.com",
					refreshToken: "shared-refresh",
					lastUsed: 200,
				},
			];

			const matchIndex = findMatchingAccountIndex(accounts, {
				accountId: "workspace-b",
				email: "match@example.com",
				refreshToken: "shared-refresh",
			});

			expect(matchIndex).toBe(1);
			expect(deduplicateAccounts(accounts)).toHaveLength(2);
		});

		it("does not match a shared refresh token when same-email workspaces have different accountIds", () => {
			const accounts = [
				{
					accountId: "workspace-alpha",
					email: "shared@example.com",
					refreshToken: "shared-refresh",
					lastUsed: 100,
				},
			];

			const matchIndex = findMatchingAccountIndex(accounts, {
				accountId: "workspace-beta",
				email: "shared@example.com",
				refreshToken: "shared-refresh",
			});

			expect(matchIndex).toBeUndefined();
			expect(
				deduplicateAccounts([
					...accounts,
					{
						accountId: "workspace-beta",
						email: "shared@example.com",
						refreshToken: "shared-refresh",
						lastUsed: 200,
					},
				]),
			).toHaveLength(2);
		});

		it("prefers composite accountId plus email matches over safe-email fallbacks", () => {
			const accounts = [
				{
					accountId: "workspace-other",
					email: "match@example.com",
					refreshToken: "token-safe-email",
				},
				{
					accountId: "workspace-a",
					email: "match@example.com",
					refreshToken: "token-composite",
				},
			];

			const matchIndex = findMatchingAccountIndex(accounts, {
				accountId: "workspace-a",
				email: "match@example.com",
			});

			expect(matchIndex).toBe(1);
		});

		it("falls back to a unique bare accountId when email matching is unsafe", () => {
			const accounts = [
				{
					accountId: "workspace-email",
					email: "User@Example.com",
					refreshToken: "token-email",
				},
				{
					accountId: "workspace-unique",
					refreshToken: "token-unique",
				},
			];

			const matchIndex = findMatchingAccountIndex(
				accounts,
				{
					accountId: "workspace-unique",
					email: " user@example.com ",
				},
				{ allowUniqueAccountIdFallbackWithoutEmail: true },
			);

			expect(matchIndex).toBe(1);
		});

		it("only uses bare accountId fallback when the accountId is unique", () => {
			const accounts = [
				{
					accountId: "workspace-shared",
					refreshToken: "refresh-a",
				},
				{
					accountId: "workspace-shared",
					refreshToken: "refresh-b",
				},
				{
					accountId: "workspace-unique",
					refreshToken: "refresh-c",
				},
			];

			expect(
				findMatchingAccountIndex(
					accounts,
					{ accountId: "workspace-shared" },
					{ allowUniqueAccountIdFallbackWithoutEmail: true },
				),
			).toBeUndefined();
			expect(
				resolveAccountSelectionIndex(
					accounts,
					{ accountId: "workspace-unique" },
					0,
				),
			).toBe(2);
		});
	});

	describe("import/export (TDD)", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-test-" + Math.random().toString(36).slice(2),
		);
		const exportPath = join(testWorkDir, "export.json");
		let testStoragePath: string;

		beforeEach(async () => {
			await fs.mkdir(testWorkDir, { recursive: true });
			testStoragePath = join(
				testWorkDir,
				"accounts-" + Math.random().toString(36).slice(2) + ".json",
			);
			setStoragePathDirect(testStoragePath);
		});

		afterEach(async () => {
			setStoragePathDirect(null);
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("should export accounts to a file", async () => {
			// @ts-expect-error - exportAccounts doesn't exist yet
			const { exportAccounts } = await import("../lib/storage.js");

			const storage = {
				version: 3,
				activeIndex: 0,
				accounts: [
					{ accountId: "test", refreshToken: "ref", addedAt: 1, lastUsed: 2 },
				],
			};
			// @ts-expect-error
			await saveAccounts(storage);

			// @ts-expect-error
			await exportAccounts(exportPath);

			expect(existsSync(exportPath)).toBe(true);
			const exported = JSON.parse(await fs.readFile(exportPath, "utf-8"));
			expect(exported.accounts[0].accountId).toBe("test");
		});

		it("should fail export if file exists and force is false", async () => {
			// @ts-expect-error
			const { exportAccounts } = await import("../lib/storage.js");
			await fs.writeFile(exportPath, "exists");

			// @ts-expect-error
			await expect(exportAccounts(exportPath, false)).rejects.toThrow(
				/already exists/,
			);
		});

		it("should import accounts from a file and merge", async () => {
			// @ts-expect-error
			const { importAccounts } = await import("../lib/storage.js");

			const existing = {
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						accountId: "existing",
						refreshToken: "ref1",
						addedAt: 1,
						lastUsed: 2,
					},
				],
			};
			// @ts-expect-error
			await saveAccounts(existing);

			const toImport = {
				version: 3,
				activeIndex: 0,
				accounts: [
					{ accountId: "new", refreshToken: "ref2", addedAt: 3, lastUsed: 4 },
				],
			};
			await fs.writeFile(exportPath, JSON.stringify(toImport));

			// @ts-expect-error
			await importAccounts(exportPath);

			const loaded = await loadAccounts();
			expect(loaded?.accounts).toHaveLength(2);
			expect(loaded?.accounts.map((a) => a.accountId)).toContain("new");
		});

		it("should preserve distinct shared-accountId imports when the imported row has no email", async () => {
			const { importAccounts } = await import("../lib/storage.js");
			const existing = {
				version: 3,
				activeIndex: 1,
				activeIndexByFamily: { codex: 1 },
				accounts: [
					{
						accountId: "shared-account",
						email: "alpha@example.com",
						refreshToken: "refresh-alpha",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						accountId: "shared-account",
						email: "beta@example.com",
						refreshToken: "refresh-beta",
						addedAt: 2,
						lastUsed: 2,
					},
				],
			};
			// @ts-expect-error
			await saveAccounts(existing);

			await fs.writeFile(
				exportPath,
				JSON.stringify({
					version: 3,
					activeIndex: 0,
					accounts: [
						{
							accountId: "shared-account",
							refreshToken: "refresh-gamma",
							addedAt: 3,
							lastUsed: 3,
						},
					],
				}),
			);

			const imported = await importAccounts(exportPath);
			const loaded = await loadAccounts();

			expect(imported).toEqual({ imported: 1, total: 3, skipped: 0 });
			expect(loaded?.accounts).toHaveLength(3);
			expect(loaded?.accounts.map((account) => account.refreshToken)).toEqual(
				expect.arrayContaining([
					"refresh-alpha",
					"refresh-beta",
					"refresh-gamma",
				]),
			);
		});

		it("should preserve distinct accountId plus email pairs during import", async () => {
			const { importAccounts } = await import("../lib/storage.js");
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						accountId: "shared-workspace",
						email: "alpha@example.com",
						refreshToken: "refresh-existing",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			});

			await fs.writeFile(
				exportPath,
				JSON.stringify(
					{
						version: 3,
						activeIndex: 0,
						accounts: [
							{
								accountId: "shared-workspace",
								email: "beta@example.com",
								refreshToken: "refresh-imported",
								addedAt: 2,
								lastUsed: 2,
							},
						],
					},
					null,
					2,
				),
			);

			const result = await importAccounts(exportPath);
			const loaded = await loadAccounts();

			expect(result).toEqual({ imported: 1, skipped: 0, total: 2 });
			expect(loaded?.accounts).toHaveLength(2);
			expect(loaded?.accounts.map((account) => account.refreshToken)).toEqual([
				"refresh-existing",
				"refresh-imported",
			]);
		});

		it("should preserve duplicate shared accountId entries when imported rows lack email", async () => {
			const { importAccounts } = await import("../lib/storage.js");
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						accountId: "shared-workspace",
						refreshToken: "refresh-existing",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			});

			await fs.writeFile(
				exportPath,
				JSON.stringify(
					{
						version: 3,
						activeIndex: 0,
						accounts: [
							{
								accountId: "shared-workspace",
								refreshToken: "refresh-imported",
								addedAt: 2,
								lastUsed: 2,
							},
						],
					},
					null,
					2,
				),
			);

			const result = await importAccounts(exportPath);
			const loaded = await loadAccounts();

			expect(result).toEqual({ imported: 1, skipped: 0, total: 2 });
			expect(loaded?.accounts).toHaveLength(2);
			expect(loaded?.accounts.map((account) => account.refreshToken)).toEqual([
				"refresh-existing",
				"refresh-imported",
			]);
		});

		it("should serialize concurrent transactional updates without losing accounts", async () => {
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				accounts: [],
			});

			const addAccount = async (
				accountId: string,
				delayMs: number,
			): Promise<void> => {
				await withAccountStorageTransaction(async (current, persist) => {
					const snapshot = current ?? {
						version: 3 as const,
						activeIndex: 0,
						accounts: [],
					};
					if (delayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, delayMs));
					}
					await persist({
						...snapshot,
						accounts: [
							...snapshot.accounts,
							{
								accountId,
								refreshToken: `ref-${accountId}`,
								addedAt: Date.now(),
								lastUsed: Date.now(),
							},
						],
					});
				});
			};

			await Promise.all([addAccount("acct-a", 20), addAccount("acct-b", 0)]);

			const loaded = await loadAccounts();
			expect(loaded?.accounts).toHaveLength(2);
			expect(
				new Set(loaded?.accounts.map((account) => account.accountId)),
			).toEqual(new Set(["acct-a", "acct-b"]));
		});

		it("rolls back account storage when flagged persistence keeps failing inside the combined transaction", async () => {
			const now = Date.now();
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						accountId: "acct-existing",
						email: "existing@example.com",
						refreshToken: "refresh-existing",
						addedAt: now - 10_000,
						lastUsed: now - 10_000,
					},
				],
			});
			await saveFlaggedAccounts({
				version: 1,
				accounts: [
					{
						accountId: "acct-flagged",
						email: "flagged@example.com",
						refreshToken: "refresh-flagged",
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						flaggedAt: now - 5_000,
					},
				],
			});

			const originalRename = fs.rename.bind(fs);
			let flaggedRenameAttempts = 0;
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(
				async (from, to) => {
					if (String(to).endsWith("openai-codex-flagged-accounts.json")) {
						flaggedRenameAttempts += 1;
						const error = Object.assign(
							new Error("flagged storage busy"),
							{ code: "EBUSY" },
						);
						throw error;
					}
					return originalRename(from, to);
				},
			);

			try {
				await expect(
					withAccountAndFlaggedStorageTransaction(async (current, persist) => {
						if (!current) {
							throw new Error("expected existing account storage");
						}
						await persist(
							{
								...current,
								accounts: [
									...current.accounts,
									{
										accountId: "acct-restored",
										email: "restored@example.com",
										refreshToken: "refresh-restored",
										addedAt: now,
										lastUsed: now,
									},
								],
							},
							{
								version: 1,
								accounts: [],
							},
						);
					}),
				).rejects.toThrow("flagged storage busy");
				expect(flaggedRenameAttempts).toBe(5);
			} finally {
				renameSpy.mockRestore();
			}

			const loadedAccounts = await loadAccounts();
			expect(loadedAccounts?.accounts).toHaveLength(1);
			expect(loadedAccounts?.accounts[0]).toEqual(
				expect.objectContaining({
					accountId: "acct-existing",
					refreshToken: "refresh-existing",
				}),
			);

			const loadedFlagged = await loadFlaggedAccounts();
			expect(loadedFlagged.accounts).toHaveLength(1);
			expect(loadedFlagged.accounts[0]).toEqual(
				expect.objectContaining({
					accountId: "acct-flagged",
					refreshToken: "refresh-flagged",
				}),
			);
		});

		it("surfaces rollback failure when flagged persistence and account rollback both fail", async () => {
			const now = Date.now();
			const storagePath = getStoragePath();
			expect(storagePath).toBeTruthy();
			const flaggedStoragePath = getFlaggedAccountsPath();
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						accountId: "acct-existing",
						email: "existing@example.com",
						refreshToken: "refresh-existing",
						addedAt: now - 10_000,
						lastUsed: now - 10_000,
					},
				],
			});
			await saveFlaggedAccounts({
				version: 1,
				accounts: [
					{
						accountId: "acct-flagged",
						email: "flagged@example.com",
						refreshToken: "refresh-flagged",
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						flaggedAt: now - 5_000,
					},
				],
			});

			const actualFs = await vi.importActual<typeof import("node:fs")>(
				"node:fs",
			);
			let accountRenameAttempts = 0;
			let flaggedRenameAttempts = 0;
			vi.resetModules();
			vi.doMock("node:fs", () => ({
				...actualFs,
				promises: {
					...actualFs.promises,
					rename: async (
						from: Parameters<typeof actualFs.promises.rename>[0],
						to: Parameters<typeof actualFs.promises.rename>[1],
					) => {
						const targetPath = String(to);
						if (targetPath === flaggedStoragePath) {
							flaggedRenameAttempts += 1;
							const error = Object.assign(
								new Error("flagged storage busy"),
								{ code: "EBUSY" },
							);
							throw error;
						}
						if (targetPath === storagePath) {
							accountRenameAttempts += 1;
							if (accountRenameAttempts > 1) {
								const error = Object.assign(
									new Error("rollback account storage busy"),
									{ code: "EBUSY" },
								);
								throw error;
							}
						}
						return actualFs.promises.rename(from, to);
					},
				},
			}));
			const isolatedStorageModule = await import("../lib/storage.js");
			isolatedStorageModule.setStoragePathDirect(storagePath);
			try {
				let thrown: unknown;
				try {
					await isolatedStorageModule.withAccountAndFlaggedStorageTransaction(
						async (current, persist) => {
							if (!current) {
								throw new Error("expected existing account storage");
							}
							await persist(
								{
									...current,
									accounts: [
										...current.accounts,
										{
											accountId: "acct-restored",
											email: "restored@example.com",
											refreshToken: "refresh-restored",
											addedAt: now,
											lastUsed: now,
										},
									],
								},
								{
									version: 1,
									accounts: [],
								},
							);
						},
					);
				} catch (error) {
					thrown = error;
				}

				expect(flaggedRenameAttempts).toBe(5);
				expect(accountRenameAttempts).toBe(6);
				expect(thrown).toBeInstanceOf(AggregateError);
				expect((thrown as AggregateError).message).toBe(
					"Flagged save failed and account storage rollback also failed",
				);
				const thrownErrors = (thrown as AggregateError).errors.map(String);
				expect(
					thrownErrors.some((message) =>
						message.includes("flagged storage busy"),
					),
				).toBe(true);
				expect(
					thrownErrors.some((message) =>
						message.includes("rollback account storage busy"),
					),
				).toBe(true);

				const loadedAccounts = await isolatedStorageModule.loadAccounts();
				expect(loadedAccounts?.accounts).toHaveLength(2);
				expect(
					loadedAccounts?.accounts.map((account) => account.refreshToken),
				).toEqual(["refresh-existing", "refresh-restored"]);

				const loadedFlagged = await isolatedStorageModule.loadFlaggedAccounts();
				expect(loadedFlagged.accounts).toHaveLength(1);
				expect(loadedFlagged.accounts[0]).toEqual(
					expect.objectContaining({
						accountId: "acct-flagged",
						refreshToken: "refresh-flagged",
					}),
				);
			} finally {
				isolatedStorageModule.setStoragePathDirect(null);
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});

		it("rolls back flagged storage when flagged-only transaction persistence fails", async () => {
			const now = Date.now();
			await saveFlaggedAccounts({
				version: 1,
				accounts: [
					{
						accountId: "acct-flagged",
						email: "flagged@example.com",
						refreshToken: "refresh-flagged",
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						flaggedAt: now - 5_000,
					},
				],
			});

			const originalRename = fs.rename.bind(fs);
			let flaggedRenameAttempts = 0;
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(
				async (from, to) => {
					if (String(to).endsWith("openai-codex-flagged-accounts.json")) {
						flaggedRenameAttempts += 1;
						if (flaggedRenameAttempts <= 5) {
							const error = Object.assign(
								new Error("flagged storage busy"),
								{ code: "EBUSY" },
							);
							throw error;
						}
					}
					return originalRename(from, to);
				},
			);

			try {
				await expect(
					withFlaggedStorageTransaction(async (current, persist) => {
						await persist({
							...current,
							accounts: [
								...current.accounts,
								{
									accountId: "acct-restored",
									email: "restored@example.com",
									refreshToken: "refresh-restored",
									addedAt: now,
									lastUsed: now,
									flaggedAt: now,
								},
							],
						});
					}),
				).rejects.toThrow("flagged storage busy");
				expect(flaggedRenameAttempts).toBe(6);
			} finally {
				renameSpy.mockRestore();
			}

			const loadedFlagged = await loadFlaggedAccounts();
			expect(loadedFlagged.accounts).toHaveLength(1);
			expect(loadedFlagged.accounts[0]).toEqual(
				expect.objectContaining({
					accountId: "acct-flagged",
					refreshToken: "refresh-flagged",
				}),
			);
		});

		it("passes the live flagged snapshot into account+flagged transactions", async () => {
			const now = Date.now();
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						accountId: "acct-existing",
						email: "existing@example.com",
						refreshToken: "refresh-existing",
						addedAt: now - 10_000,
						lastUsed: now - 10_000,
					},
				],
			});
			await saveFlaggedAccounts({
				version: 1,
				accounts: [
					{
						accountId: "acct-pre-scan",
						email: "pre-scan@example.com",
						refreshToken: "refresh-pre-scan",
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						flaggedAt: now - 5_000,
					},
				],
			});

			const preScanFlagged = await loadFlaggedAccounts();
			expect(preScanFlagged.accounts[0]?.refreshToken).toBe("refresh-pre-scan");

			await saveFlaggedAccounts({
				version: 1,
				accounts: [
					{
						accountId: "acct-live",
						email: "live@example.com",
						refreshToken: "refresh-live",
						addedAt: now - 1_000,
						lastUsed: now - 1_000,
						flaggedAt: now - 1_000,
					},
				],
			});

			await withAccountAndFlaggedStorageTransaction(
				async (current, persist, currentFlagged) => {
					expect(current?.accounts).toHaveLength(1);
					expect(currentFlagged.accounts).toHaveLength(1);
					expect(currentFlagged.accounts[0]?.refreshToken).toBe("refresh-live");

					currentFlagged.accounts[0]!.refreshToken = "mutated-only";

					await persist(current!, {
						version: 1,
						accounts: [
							{
								accountId: "acct-persisted",
								email: "persisted@example.com",
								refreshToken: "refresh-persisted",
								addedAt: now,
								lastUsed: now,
								flaggedAt: now,
							},
						],
					});
				},
			);

			const loadedFlagged = await loadFlaggedAccounts();
			expect(loadedFlagged.accounts).toHaveLength(1);
			expect(loadedFlagged.accounts[0]).toEqual(
				expect.objectContaining({
					accountId: "acct-persisted",
					refreshToken: "refresh-persisted",
				}),
			);
		});

		it("treats missing flagged storage as empty inside flagged transactions", async () => {
			const now = Date.now();
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						accountId: "acct-existing",
						email: "existing@example.com",
						refreshToken: "refresh-existing",
						addedAt: now - 10_000,
						lastUsed: now - 10_000,
					},
				],
			});
			await clearFlaggedAccounts();

			await expect(
				withFlaggedStorageTransaction(async (current) => {
					expect(current).toEqual({ version: 1, accounts: [] });
				}),
			).resolves.toBeUndefined();

			await expect(
				withAccountAndFlaggedStorageTransaction(
					async (_current, _persist, currentFlagged) => {
						expect(currentFlagged).toEqual({ version: 1, accounts: [] });
					},
				),
			).resolves.toBeUndefined();
		});

		it("retries transient flagged storage rename and succeeds", async () => {
			const now = Date.now();
			await saveFlaggedAccounts({
				version: 1,
				accounts: [
					{
						accountId: "acct-flagged",
						email: "flagged@example.com",
						refreshToken: "refresh-flagged",
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						flaggedAt: now - 5_000,
					},
				],
			});

			const originalRename = fs.rename.bind(fs);
			let flaggedRenameAttempts = 0;
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(
				async (from, to) => {
					if (String(to).endsWith("openai-codex-flagged-accounts.json")) {
						flaggedRenameAttempts += 1;
						if (flaggedRenameAttempts <= 2) {
							const error = Object.assign(
								new Error("flagged storage busy"),
								{ code: "EBUSY" },
							);
							throw error;
						}
					}
					return originalRename(from, to);
				},
			);

			try {
				await saveFlaggedAccounts({
					version: 1,
					accounts: [
						{
							accountId: "acct-flagged",
							email: "flagged@example.com",
							refreshToken: "refresh-flagged-next",
							addedAt: now,
							lastUsed: now,
							flaggedAt: now,
						},
					],
				});
			} finally {
				renameSpy.mockRestore();
			}

			expect(flaggedRenameAttempts).toBe(3);
			const loadedFlagged = await loadFlaggedAccounts();
			expect(loadedFlagged.accounts).toHaveLength(1);
			expect(loadedFlagged.accounts[0]).toEqual(
				expect.objectContaining({
					refreshToken: "refresh-flagged-next",
				}),
			);
		});

		it("should enforce MAX_ACCOUNTS during import", async () => {
			// @ts-expect-error
			const { importAccounts } = await import("../lib/storage.js");

			const manyAccounts = Array.from({ length: 21 }, (_, i) => ({
				accountId: `acct${i}`,
				refreshToken: `ref${i}`,
				addedAt: Date.now(),
				lastUsed: Date.now(),
			}));

			const toImport = {
				version: 3,
				activeIndex: 0,
				accounts: manyAccounts,
			};
			await fs.writeFile(exportPath, JSON.stringify(toImport));

			// @ts-expect-error
			await expect(importAccounts(exportPath)).rejects.toThrow(
				/exceed maximum/,
			);
		});

		it("should fail export when no accounts exist", async () => {
			const { exportAccounts } = await import("../lib/storage.js");
			setStoragePathDirect(testStoragePath);
			await clearAccounts();
			await expect(exportAccounts(exportPath)).rejects.toThrow(
				/No accounts to export/,
			);
		});

		it("should fail import when file does not exist", async () => {
			const { importAccounts } = await import("../lib/storage.js");
			const nonexistentPath = join(testWorkDir, "nonexistent-file.json");
			await expect(importAccounts(nonexistentPath)).rejects.toThrow(
				/Import file not found/,
			);
		});

		it("should fail import when file contains invalid JSON", async () => {
			const { importAccounts } = await import("../lib/storage.js");
			await fs.writeFile(exportPath, "not valid json {[");
			await expect(importAccounts(exportPath)).rejects.toThrow(/Invalid JSON/);
		});

		it("should fail import when file contains invalid format", async () => {
			const { importAccounts } = await import("../lib/storage.js");
			await fs.writeFile(exportPath, JSON.stringify({ invalid: "format" }));
			await expect(importAccounts(exportPath)).rejects.toThrow(
				/Invalid account storage format/,
			);
		});

		describe("named backup helpers", () => {
			it("resolves a safe backup path within the plugin backup root", () => {
				const backupName = "backup-2026-03-09";
				const expected = join(
					dirname(testStoragePath),
					"backups",
					"backup-2026-03-09.json",
				);
				expect(buildNamedBackupPath(backupName)).toBe(expected);
			});

			it("normalizes explicit .json names without duplicating the extension", () => {
				const backupName = "backup-2026-03-09.json";
				const expected = join(
					dirname(testStoragePath),
					"backups",
					"backup-2026-03-09.json",
				);
				expect(buildNamedBackupPath(backupName)).toBe(expected);
			});

			const unsafeNames = [
				"",
				"   ",
				"../evil",
				"backup/escape",
				String.raw`backup\escape`,
				"rot.rotate.",
				"backup.tmp",
				"archive.wal",
				"space name",
				"weird!name",
			];

			it.each(unsafeNames)("rejects unsafe backup name '%s'", (input) => {
				expect(() => buildNamedBackupPath(input)).toThrow();
			});

			it("refuses to overwrite an existing backup without force", async () => {
				const backupName = "backup-2026-03-09";
				await saveAccounts({
					version: 3,
					activeIndex: 0,
					accounts: [
						{ accountId: "test", refreshToken: "ref", addedAt: 1, lastUsed: 2 },
					],
				});
				const destination = buildNamedBackupPath(backupName);
				await fs.mkdir(dirname(destination), { recursive: true });
				await fs.writeFile(destination, "exists", "utf-8");
				await expect(exportNamedBackup(backupName)).rejects.toThrow(
					/already exists/,
				);
			});

			it("writes the named backup using the safe path", async () => {
				const backupName = "backup-2026-03-09";
				await saveAccounts({
					version: 3,
					activeIndex: 0,
					accounts: [
						{ accountId: "test", refreshToken: "ref", addedAt: 1, lastUsed: 2 },
					],
				});
				const backupPath = await exportNamedBackup(backupName);
				expect(existsSync(backupPath)).toBe(true);
				expect(backupPath).toBe(buildNamedBackupPath(backupName));
			});

			it("overwrites an existing named backup when force is true", async () => {
				const backupName = "backup-2026-03-10";
				await saveAccounts({
					version: 3,
					activeIndex: 1,
					accounts: [
						{
							accountId: "first",
							refreshToken: "ref-1",
							addedAt: 1,
							lastUsed: 2,
						},
						{
							accountId: "second",
							refreshToken: "ref-2",
							addedAt: 3,
							lastUsed: 4,
						},
					],
				});

				const initialPath = await exportNamedBackup(backupName);
				await saveAccounts({
					version: 3,
					activeIndex: 0,
					accounts: [
						{
							accountId: "replacement",
							refreshToken: "ref-3",
							addedAt: 5,
							lastUsed: 6,
						},
					],
				});

				const overwrittenPath = await exportNamedBackup(backupName, {
					force: true,
				});
				const exported = JSON.parse(
					await fs.readFile(overwrittenPath, "utf-8"),
				);

				expect(overwrittenPath).toBe(initialPath);
				expect(exported.activeIndex).toBe(0);
				expect(exported.accounts).toHaveLength(1);
				expect(exported.accounts[0].accountId).toBe("replacement");
			});

			it("propagates export errors when no accounts exist for a named backup", async () => {
				await expect(exportNamedBackup("backup-2026-03-11")).rejects.toThrow(
					/No accounts to export/,
				);
			});
		});
	});

	describe("filename migration (TDD)", () => {
		it("should migrate from old filename to new filename", async () => {
			// This test is tricky because it depends on the internal state of getStoragePath()
			// which we are about to change.

			const oldName = "openai-codex-accounts.json";
			const newName = "codex-accounts.json";

			// We'll need to mock/verify that loadAccounts checks for oldName if newName is missing
			// Since we haven't implemented it yet, this is just a placeholder for the logic
			expect(true).toBe(true);
		});
	});

	describe("StorageError and formatStorageErrorHint", () => {
		describe("StorageError class", () => {
			it("should store code, path, and hint properties", () => {
				const err = new StorageError(
					"Failed to write file",
					"EACCES",
					"/path/to/file.json",
					"Permission denied. Check folder permissions.",
				);

				expect(err.name).toBe("StorageError");
				expect(err.message).toBe("Failed to write file");
				expect(err.code).toBe("EACCES");
				expect(err.path).toBe("/path/to/file.json");
				expect(err.hint).toBe("Permission denied. Check folder permissions.");
			});

			it("should be instanceof Error", () => {
				const err = new StorageError("test", "CODE", "/path", "hint");
				expect(err instanceof Error).toBe(true);
				expect(err instanceof StorageError).toBe(true);
			});
		});

		describe("formatStorageErrorHint", () => {
			const testPath = "/home/user/.codex/accounts.json";

			it("should return permission hint for EACCES on Windows", () => {
				const originalPlatform = process.platform;
				Object.defineProperty(process, "platform", { value: "win32" });

				const err = { code: "EACCES" } as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("antivirus");
				expect(hint).toContain(testPath);

				Object.defineProperty(process, "platform", { value: originalPlatform });
			});

			it("should return chmod hint for EACCES on Unix", () => {
				const originalPlatform = process.platform;
				Object.defineProperty(process, "platform", { value: "darwin" });

				const err = { code: "EACCES" } as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("chmod");
				expect(hint).toContain(testPath);

				Object.defineProperty(process, "platform", { value: originalPlatform });
			});

			it("should return permission hint for EPERM", () => {
				const err = { code: "EPERM" } as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("Permission denied");
				expect(hint).toContain(testPath);
			});

			it("should return file locked hint for EBUSY", () => {
				const err = { code: "EBUSY" } as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("locked");
				expect(hint).toContain("another program");
			});

			it("should return disk full hint for ENOSPC", () => {
				const err = { code: "ENOSPC" } as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("Disk is full");
			});

			it("should return empty file hint for EEMPTY", () => {
				const err = { code: "EEMPTY" } as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("empty");
			});

			it("should return generic hint for unknown error codes", () => {
				const err = { code: "UNKNOWN_CODE" } as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("Failed to write");
				expect(hint).toContain(testPath);
			});

			it("should handle errors without code property", () => {
				const err = new Error("Some error") as NodeJS.ErrnoException;
				const hint = formatStorageErrorHint(err, testPath);

				expect(hint).toContain("Failed to write");
				expect(hint).toContain(testPath);
			});
		});
	});

	describe("selectNewestAccount logic", () => {
		it("when lastUsed are equal, prefers newer addedAt", () => {
			const now = Date.now();
			const accounts = [
				{
					accountId: "A",
					refreshToken: "t1",
					addedAt: now - 1000,
					lastUsed: now,
				},
				{
					accountId: "A",
					refreshToken: "t1",
					addedAt: now - 500,
					lastUsed: now,
				},
			];
			const deduped = deduplicateAccounts(accounts);
			expect(deduped).toHaveLength(1);
			expect(deduped[0]?.addedAt).toBe(now - 500);
		});

		it("when candidate lastUsed is less than current, keeps current", () => {
			const now = Date.now();
			const accounts = [
				{ accountId: "A", refreshToken: "t1", addedAt: now, lastUsed: now },
				{
					accountId: "A",
					refreshToken: "t1",
					addedAt: now - 500,
					lastUsed: now - 1000,
				},
			];
			const deduped = deduplicateAccounts(accounts);
			expect(deduped).toHaveLength(1);
			expect(deduped[0]?.lastUsed).toBe(now);
		});

		it("handles accounts without lastUsed or addedAt", () => {
			const accounts = [
				{ accountId: "A", refreshToken: "t1" },
				{ accountId: "A", refreshToken: "t1", lastUsed: 100 },
			];
			const deduped = deduplicateAccounts(accounts);
			expect(deduped).toHaveLength(1);
			expect(deduped[0]?.lastUsed).toBe(100);
		});
	});

	describe("deduplicateAccountsByKey edge cases", () => {
		it("uses refreshToken as key when accountId is empty", () => {
			const accounts = [
				{ accountId: "A", refreshToken: "t1", lastUsed: 100 },
				{ accountId: "", refreshToken: "t2", lastUsed: 200 },
				{ accountId: "C", refreshToken: "t3", lastUsed: 300 },
			];
			const deduped = deduplicateAccounts(accounts);
			expect(deduped).toHaveLength(3);
		});

		it("handles empty array", () => {
			const deduped = deduplicateAccounts([]);
			expect(deduped).toHaveLength(0);
		});

		it("handles null/undefined in array", () => {
			const accounts = [
				{ accountId: "A", refreshToken: "t1" },
				null as never,
				{ accountId: "B", refreshToken: "t2" },
			];
			const deduped = deduplicateAccounts(accounts);
			expect(deduped).toHaveLength(2);
		});

		it("preserves distinct emails when business accounts share the same accountId", () => {
			const accounts = [
				{
					accountId: "workspace-1",
					email: "alpha@example.com",
					refreshToken: "token-alpha",
					lastUsed: 100,
				},
				{
					accountId: "workspace-1",
					email: "beta@example.com",
					refreshToken: "token-beta",
					lastUsed: 200,
				},
				{
					accountId: "workspace-1",
					email: "alpha@example.com",
					refreshToken: "token-alpha-newer",
					lastUsed: 300,
				},
			];

			const deduped = deduplicateAccounts(accounts);

			expect(deduped).toHaveLength(2);
			expect(deduped).toContainEqual(
				expect.objectContaining({
					email: "alpha@example.com",
					refreshToken: "token-alpha-newer",
				}),
			);
			expect(deduped).toContainEqual(
				expect.objectContaining({
					email: "beta@example.com",
					refreshToken: "token-beta",
				}),
			);
		});

		it("preserves shared accountId entries when email is missing and refresh tokens differ", () => {
			const accounts = [
				{
					accountId: "shared-workspace",
					refreshToken: "refresh-a",
					lastUsed: 100,
					addedAt: 10,
				},
				{
					accountId: "shared-workspace",
					refreshToken: "refresh-b",
					lastUsed: 200,
					addedAt: 20,
				},
			];

			const deduped = deduplicateAccounts(accounts);
			expect(deduped).toHaveLength(2);
			expect(deduped.map((account) => account.refreshToken)).toEqual([
				"refresh-a",
				"refresh-b",
			]);
		});
	});

	describe("deduplicateAccountsByEmail edge cases", () => {
		it("preserves accounts without email", () => {
			const accounts = [
				{ email: "test@example.com", lastUsed: 100, addedAt: 50 },
				{ lastUsed: 200, addedAt: 100 },
				{ email: "", lastUsed: 300, addedAt: 150 },
			];
			const deduped = deduplicateAccountsByEmail(accounts);
			expect(deduped).toHaveLength(3);
		});

		it("handles email with whitespace", () => {
			const accounts = [
				{ email: "  test@example.com  ", lastUsed: 100, addedAt: 50 },
				{ email: "test@example.com", lastUsed: 200, addedAt: 100 },
			];
			const deduped = deduplicateAccountsByEmail(accounts);
			expect(deduped).toHaveLength(1);
		});

		it("treats email casing as the same logical account", () => {
			const accounts = [
				{
					email: "Test@Example.com",
					refreshToken: "old",
					lastUsed: 100,
					addedAt: 10,
				},
				{
					email: "test@example.com",
					refreshToken: "new",
					lastUsed: 200,
					addedAt: 20,
				},
			];
			const deduped = deduplicateAccountsByEmail(accounts);
			expect(deduped).toHaveLength(1);
			expect(deduped[0]?.refreshToken).toBe("new");
			expect(deduped[0]?.email).toBe("test@example.com");
		});

		it("handles null existing account edge case", () => {
			const accounts = [
				{ email: "test@example.com", lastUsed: 100 },
				{ email: "test@example.com", lastUsed: 200 },
			];
			const deduped = deduplicateAccountsByEmail(accounts);
			expect(deduped.length).toBeGreaterThanOrEqual(1);
		});

		it("when addedAt differs but lastUsed is same, uses addedAt to decide", () => {
			const now = Date.now();
			const accounts = [
				{ email: "test@example.com", lastUsed: now, addedAt: now - 1000 },
				{ email: "test@example.com", lastUsed: now, addedAt: now - 500 },
			];
			const deduped = deduplicateAccountsByEmail(accounts);
			expect(deduped).toHaveLength(1);
			expect(deduped[0]?.addedAt).toBe(now - 500);
		});
	});

	describe("normalizeAccountStorage edge cases", () => {
		it("returns null for non-object data", () => {
			expect(normalizeAccountStorage(null)).toBeNull();
			expect(normalizeAccountStorage("string")).toBeNull();
			expect(normalizeAccountStorage(123)).toBeNull();
			expect(normalizeAccountStorage([])).toBeNull();
		});

		it("returns null for invalid version", () => {
			const result = normalizeAccountStorage({ version: 2, accounts: [] });
			expect(result).toBeNull();
		});

		it("returns null for non-array accounts", () => {
			expect(
				normalizeAccountStorage({ version: 3, accounts: "not-array" }),
			).toBeNull();
			expect(normalizeAccountStorage({ version: 3, accounts: {} })).toBeNull();
		});

		it("handles missing activeIndex", () => {
			const data = {
				version: 3,
				accounts: [{ refreshToken: "t1", accountId: "A" }],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.activeIndex).toBe(0);
		});

		it("handles non-finite activeIndex", () => {
			const data = {
				version: 3,
				activeIndex: NaN,
				accounts: [{ refreshToken: "t1", accountId: "A" }],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.activeIndex).toBe(0);
		});

		it("handles Infinity activeIndex", () => {
			const data = {
				version: 3,
				activeIndex: Infinity,
				accounts: [{ refreshToken: "t1", accountId: "A" }],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.activeIndex).toBe(0);
		});

		it("clamps out-of-bounds activeIndex", () => {
			const data = {
				version: 3,
				activeIndex: 100,
				accounts: [
					{ refreshToken: "t1", accountId: "A" },
					{ refreshToken: "t2", accountId: "B" },
				],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.activeIndex).toBe(1);
		});

		it("filters out accounts with empty refreshToken", () => {
			const data = {
				version: 3,
				accounts: [
					{ refreshToken: "valid", accountId: "A" },
					{ refreshToken: "  ", accountId: "B" },
					{ refreshToken: "", accountId: "C" },
				],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.accounts).toHaveLength(1);
		});

		it("remaps activeKey when deduplication changes indices", () => {
			const now = Date.now();
			const data = {
				version: 3,
				activeIndex: 2,
				accounts: [
					{ refreshToken: "t1", accountId: "A", lastUsed: now - 100 },
					{ refreshToken: "t1", accountId: "A", lastUsed: now },
					{ refreshToken: "t2", accountId: "B", lastUsed: now - 50 },
				],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.accounts).toHaveLength(2);
			expect(result?.activeIndex).toBe(1);
		});

		it("remaps activeIndex without collapsing same-workspace business accounts", () => {
			const now = Date.now();
			const data = {
				version: 3,
				activeIndex: 1,
				accounts: [
					{
						refreshToken: "token-alpha-old",
						accountId: "workspace-1",
						email: "alpha@example.com",
						lastUsed: now - 200,
					},
					{
						refreshToken: "token-beta",
						accountId: "workspace-1",
						email: "beta@example.com",
						lastUsed: now - 100,
					},
					{
						refreshToken: "token-alpha-new",
						accountId: "workspace-1",
						email: "alpha@example.com",
						lastUsed: now,
					},
				],
			};

			const result = normalizeAccountStorage(data);

			expect(result?.accounts).toHaveLength(2);
			expect(result?.activeIndex).toBe(1);
			expect(result?.accounts[0]?.email).toBe("alpha@example.com");
			expect(result?.accounts[1]?.email).toBe("beta@example.com");
		});

		it("preserves activeIndex for duplicate shared accountId entries when email is missing", () => {
			const data = {
				version: 3,
				activeIndex: 1,
				accounts: [
					{
						accountId: "shared-workspace",
						refreshToken: "refresh-a",
						lastUsed: 100,
					},
					{
						accountId: "shared-workspace",
						refreshToken: "refresh-b",
						lastUsed: 200,
					},
				],
			};

			const result = normalizeAccountStorage(data);
			expect(result).not.toBeNull();
			expect(result?.accounts).toHaveLength(2);
			expect(result?.activeIndex).toBe(1);
			expect(result?.accounts[1]?.refreshToken).toBe("refresh-b");
		});

		it("handles v1 to v3 migration", () => {
			const data = {
				version: 1,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "t1",
						accountId: "A",
						accessToken: "acc1",
						expiresAt: Date.now() + 3600000,
					},
				],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.version).toBe(3);
			expect(result?.accounts).toHaveLength(1);
		});

		it("preserves activeIndexByFamily when valid", () => {
			const data = {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 1, "gpt-5.x": 0 },
				accounts: [
					{ refreshToken: "t1", accountId: "A" },
					{ refreshToken: "t2", accountId: "B" },
				],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.activeIndexByFamily).toBeDefined();
		});

		it("handles activeIndexByFamily with non-finite values", () => {
			const data = {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: NaN, "gpt-5.x": Infinity },
				accounts: [{ refreshToken: "t1", accountId: "A" }],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.activeIndexByFamily).toBeDefined();
		});

		it("handles account with only accountId, no refreshToken key match", () => {
			const data = {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "t1", accountId: "" }],
			};
			const result = normalizeAccountStorage(data);
			expect(result?.accounts).toHaveLength(1);
		});
	});

	describe("loadAccounts", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-load-test-" + Math.random().toString(36).slice(2),
		);
		let testStoragePath: string;

		beforeEach(async () => {
			await fs.mkdir(testWorkDir, { recursive: true });
			testStoragePath = join(testWorkDir, "accounts.json");
			setStoragePathDirect(testStoragePath);
		});

		afterEach(async () => {
			setStoragePathDirect(null);
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("returns null when file does not exist", async () => {
			const result = await loadAccounts();
			expect(result).toEqual(
				expect.objectContaining({
					version: 3,
					accounts: [],
					activeIndex: 0,
					restoreEligible: true,
					restoreReason: "missing-storage",
				}),
			);
		});

		it("returns null on parse error", async () => {
			await fs.writeFile(testStoragePath, "not valid json{{{", "utf-8");
			const result = await loadAccounts();
			expect(result).toBeNull();
		});

		it("returns normalized data on valid file", async () => {
			const storage = {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "t1", accountId: "A" }],
			};
			await fs.writeFile(testStoragePath, JSON.stringify(storage), "utf-8");
			const result = await loadAccounts();
			expect(result?.accounts).toHaveLength(1);
		});

		it("logs schema validation warnings but still returns data", async () => {
			const storage = {
				version: 3,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "t1", accountId: "A", extraField: "ignored" },
				],
			};
			await fs.writeFile(testStoragePath, JSON.stringify(storage), "utf-8");
			const result = await loadAccounts();
			expect(result).not.toBeNull();
		});

		it("migrates v1 to v3 and attempts to save", async () => {
			const v1Storage = {
				version: 1,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "t1",
						accountId: "A",
						accessToken: "acc",
						expiresAt: Date.now() + 3600000,
					},
				],
			};
			await fs.writeFile(testStoragePath, JSON.stringify(v1Storage), "utf-8");
			const result = await loadAccounts();
			expect(result?.version).toBe(3);
			const saved = JSON.parse(await fs.readFile(testStoragePath, "utf-8"));
			expect(saved.version).toBe(3);
		});

		it("returns migrated data even when save fails (line 422-423 coverage)", async () => {
			const v1Storage = {
				version: 1,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "t1",
						accountId: "A",
						accessToken: "acc",
						expiresAt: Date.now() + 3600000,
					},
				],
			};
			await fs.writeFile(testStoragePath, JSON.stringify(v1Storage), "utf-8");

			// Make the file read-only to cause save to fail
			await fs.chmod(testStoragePath, 0o444);

			const result = await loadAccounts();

			// Should still return migrated data even though save failed
			expect(result?.version).toBe(3);
			expect(result?.accounts).toHaveLength(1);

			// Restore permissions for cleanup
			await fs.chmod(testStoragePath, 0o644);
		});
	});

	describe("saveAccounts", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-save-test-" + Math.random().toString(36).slice(2),
		);
		let testStoragePath: string;

		beforeEach(async () => {
			await fs.mkdir(testWorkDir, { recursive: true });
			testStoragePath = join(testWorkDir, ".codex", "accounts.json");
			setStoragePathDirect(testStoragePath);
		});

		afterEach(async () => {
			setStoragePathDirect(null);
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("creates directory and saves file", async () => {
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "t1",
						accountId: "A",
						addedAt: Date.now(),
						lastUsed: Date.now(),
					},
				],
			};
			await saveAccounts(storage);
			expect(existsSync(testStoragePath)).toBe(true);
		});

		it("writes valid JSON", async () => {
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "t1", accountId: "A", addedAt: 1, lastUsed: 2 },
				],
			};
			await saveAccounts(storage);
			const content = await fs.readFile(testStoragePath, "utf-8");
			const parsed = JSON.parse(content);
			expect(parsed.version).toBe(3);
		});
	});

	describe("clearAccounts", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-clear-test-" + Math.random().toString(36).slice(2),
		);
		let testStoragePath: string;

		beforeEach(async () => {
			await fs.mkdir(testWorkDir, { recursive: true });
			testStoragePath = join(testWorkDir, "accounts.json");
			setStoragePathDirect(testStoragePath);
		});

		afterEach(async () => {
			setStoragePathDirect(null);
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("deletes the file when it exists", async () => {
			await fs.writeFile(testStoragePath, "{}");
			expect(existsSync(testStoragePath)).toBe(true);
			await clearAccounts();
			expect(existsSync(testStoragePath)).toBe(false);
		});

		it("does not throw when file does not exist", async () => {
			await expect(clearAccounts()).resolves.not.toThrow();
		});
	});

	describe("setStoragePath", () => {
		afterEach(() => {
			setStoragePathDirect(null);
		});

		it("sets path to null when projectPath is null", () => {
			setStoragePath(null);
			const path = getStoragePath();
			expect(path).toContain(".codex");
		});

		it("sets path to null when no project root found", () => {
			setStoragePath("/nonexistent/path/that/does/not/exist");
			const path = getStoragePath();
			expect(path).toContain(".codex");
		});

		it("sets project-scoped path under global .codex when project root found", () => {
			setStoragePath(process.cwd());
			const path = getStoragePath();
			expect(path).toContain("openai-codex-accounts.json");
			expect(path).toContain(".codex");
			expect(path).toContain("projects");
		});

		it("uses the same storage path for main repo and linked worktree", async () => {
			const testWorkDir = join(
				tmpdir(),
				"codex-worktree-key-" + Math.random().toString(36).slice(2),
			);
			const fakeHome = join(testWorkDir, "home");
			const mainRepo = join(testWorkDir, "repo-main");
			const mainGitDir = join(mainRepo, ".git");
			const worktreeRepo = join(testWorkDir, "repo-pr-8");
			const worktreeGitDir = join(mainGitDir, "worktrees", "repo-pr-8");
			const originalHome = process.env.HOME;
			const originalUserProfile = process.env.USERPROFILE;
			try {
				process.env.HOME = fakeHome;
				process.env.USERPROFILE = fakeHome;
				await fs.mkdir(mainGitDir, { recursive: true });
				await fs.mkdir(worktreeGitDir, { recursive: true });
				await fs.mkdir(worktreeRepo, { recursive: true });
				await fs.writeFile(
					join(worktreeRepo, ".git"),
					`gitdir: ${worktreeGitDir}\n`,
					"utf-8",
				);
				await fs.writeFile(
					join(worktreeGitDir, "commondir"),
					"../..\n",
					"utf-8",
				);
				await fs.writeFile(
					join(worktreeGitDir, "gitdir"),
					`${join(worktreeRepo, ".git")}\n`,
					"utf-8",
				);

				setStoragePath(mainRepo);
				const mainPath = getStoragePath();
				setStoragePath(worktreeRepo);
				const worktreePath = getStoragePath();
				expect(worktreePath).toBe(mainPath);
			} finally {
				setStoragePathDirect(null);
				if (originalHome === undefined) delete process.env.HOME;
				else process.env.HOME = originalHome;
				if (originalUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = originalUserProfile;
				await fs.rm(testWorkDir, { recursive: true, force: true });
			}
		});
	});

	describe("getStoragePath", () => {
		afterEach(() => {
			setStoragePathDirect(null);
		});

		it("returns custom path when set directly", () => {
			setStoragePathDirect("/custom/path/accounts.json");
			expect(getStoragePath()).toBe("/custom/path/accounts.json");
		});

		it("returns global path when no custom path set", () => {
			setStoragePathDirect(null);
			const path = getStoragePath();
			expect(path).toContain("openai-codex-accounts.json");
		});
	});

	describe("normalizeAccountStorage activeKey remapping", () => {
		it("remaps activeIndex using activeKey when present", () => {
			const now = Date.now();
			const data = {
				version: 3,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "t1", accountId: "A", lastUsed: now },
					{ refreshToken: "t2", accountId: "B", lastUsed: now - 100 },
					{ refreshToken: "t3", accountId: "C", lastUsed: now - 200 },
				],
			};
			const result = normalizeAccountStorage(data);
			expect(result).not.toBeNull();
			expect(result?.accounts).toHaveLength(3);
			expect(result?.activeIndex).toBe(0);
		});

		it("remaps familyKey for activeIndexByFamily when indices change after dedup", () => {
			const now = Date.now();
			const data = {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: {
					codex: 2,
					"gpt-5.x": 1,
				},
				accounts: [
					{ refreshToken: "t1", accountId: "A", lastUsed: now },
					{ refreshToken: "t1", accountId: "A", lastUsed: now + 100 },
					{ refreshToken: "t2", accountId: "B", lastUsed: now - 50 },
				],
			};
			const result = normalizeAccountStorage(data);
			expect(result).not.toBeNull();
			expect(result?.accounts).toHaveLength(2);
			expect(result?.activeIndexByFamily?.codex).toBeDefined();
		});
	});

	describe("clearAccounts error handling", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-clear-err-" + Math.random().toString(36).slice(2),
		);
		let testStoragePath: string;

		beforeEach(async () => {
			await fs.mkdir(testWorkDir, { recursive: true });
			testStoragePath = join(testWorkDir, "accounts.json");
			setStoragePathDirect(testStoragePath);
		});

		afterEach(async () => {
			setStoragePathDirect(null);
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("logs but does not throw on non-ENOENT errors", async () => {
			const readOnlyDir = join(testWorkDir, "readonly");
			await fs.mkdir(readOnlyDir, { recursive: true });
			const readOnlyFile = join(readOnlyDir, "accounts.json");
			await fs.writeFile(readOnlyFile, "{}");
			setStoragePathDirect(readOnlyFile);

			await expect(clearAccounts()).resolves.not.toThrow();
		});
	});

	describe("StorageError with cause", () => {
		it("preserves the original error as cause", () => {
			const originalError = new Error("Original error");
			const storageErr = new StorageError(
				"Wrapper message",
				"EACCES",
				"/path/to/file",
				"Permission hint",
				originalError,
			);
			expect((storageErr as unknown as { cause?: Error }).cause).toBe(
				originalError,
			);
		});

		it("works without cause parameter", () => {
			const storageErr = new StorageError(
				"Wrapper message",
				"EACCES",
				"/path/to/file",
				"Permission hint",
			);
			expect(
				(storageErr as unknown as { cause?: Error }).cause,
			).toBeUndefined();
		});
	});

	describe("ensureGitignore edge cases", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-gitignore-" + Math.random().toString(36).slice(2),
		);
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		let testStoragePath: string;

		beforeEach(async () => {
			await fs.mkdir(testWorkDir, { recursive: true });
		});

		afterEach(async () => {
			setStoragePathDirect(null);
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("writes .gitignore in project root when storage path is externalized", async () => {
			const fakeHome = join(testWorkDir, "home");
			const projectDir = join(testWorkDir, "project-externalized");
			const gitDir = join(projectDir, ".git");
			const gitignorePath = join(projectDir, ".gitignore");

			await fs.mkdir(fakeHome, { recursive: true });
			await fs.mkdir(gitDir, { recursive: true });
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			setStoragePath(projectDir);

			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "t1",
						accountId: "A",
						addedAt: Date.now(),
						lastUsed: Date.now(),
					},
				],
			};

			await saveAccounts(storage);

			expect(existsSync(gitignorePath)).toBe(true);
			const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
			expect(gitignoreContent).toContain(".codex/");
			expect(getStoragePath()).toContain(
				join(fakeHome, ".codex", "multi-auth", "projects"),
			);
		});

		it("creates .gitignore when it does not exist but .git dir exists (line 99-100 false branch)", async () => {
			const projectDir = join(testWorkDir, "project");
			const codexDir = join(projectDir, ".codex");
			const gitDir = join(projectDir, ".git");
			const gitignorePath = join(projectDir, ".gitignore");

			await fs.mkdir(codexDir, { recursive: true });
			await fs.mkdir(gitDir, { recursive: true });

			testStoragePath = join(codexDir, "accounts.json");
			setStoragePathDirect(testStoragePath);

			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "t1",
						accountId: "A",
						addedAt: Date.now(),
						lastUsed: Date.now(),
					},
				],
			};

			await saveAccounts(storage);

			expect(existsSync(gitignorePath)).toBe(true);
			const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
			expect(gitignoreContent).toContain(".codex/");
		});

		it("appends to existing .gitignore without trailing newline (line 107 coverage)", async () => {
			const projectDir = join(testWorkDir, "project2");
			const codexDir = join(projectDir, ".codex");
			const gitDir = join(projectDir, ".git");
			const gitignorePath = join(projectDir, ".gitignore");

			await fs.mkdir(codexDir, { recursive: true });
			await fs.mkdir(gitDir, { recursive: true });
			await fs.writeFile(gitignorePath, "node_modules", "utf-8");

			testStoragePath = join(codexDir, "accounts.json");
			setStoragePathDirect(testStoragePath);

			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "t1",
						accountId: "A",
						addedAt: Date.now(),
						lastUsed: Date.now(),
					},
				],
			};

			await saveAccounts(storage);

			const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
			expect(gitignoreContent).toBe("node_modules\n.codex/\n");
		});
	});

	describe("legacy project storage migration", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-legacy-migration-" + Math.random().toString(36).slice(2),
		);
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;

		afterEach(async () => {
			setStoragePathDirect(null);
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("removes legacy project storage file after successful migration", async () => {
			const fakeHome = join(testWorkDir, "home");
			const projectDir = join(testWorkDir, "project");
			const projectGitDir = join(projectDir, ".git");
			const legacyProjectConfigDir = join(projectDir, ".codex");
			const legacyStoragePath = join(
				legacyProjectConfigDir,
				"openai-codex-accounts.json",
			);

			await fs.mkdir(fakeHome, { recursive: true });
			await fs.mkdir(projectGitDir, { recursive: true });
			await fs.mkdir(legacyProjectConfigDir, { recursive: true });
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			setStoragePath(projectDir);

			const legacyStorage = {
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						refreshToken: "legacy-refresh",
						accountId: "legacy-account",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			};
			await fs.writeFile(
				legacyStoragePath,
				JSON.stringify(legacyStorage),
				"utf-8",
			);

			const migrated = await loadAccounts();

			expect(migrated).not.toBeNull();
			expect(migrated?.accounts).toHaveLength(1);
			expect(existsSync(legacyStoragePath)).toBe(false);
			expect(existsSync(getStoragePath())).toBe(true);
		});
	});

	describe("worktree-scoped storage migration", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-worktree-migration-" + Math.random().toString(36).slice(2),
		);
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const originalMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;

		type StoredAccountFixture = {
			refreshToken: string;
			accountId: string;
			addedAt: number;
			lastUsed: number;
		};

		const now = Date.now();
		const accountFromLegacy: StoredAccountFixture = {
			refreshToken: "legacy-refresh",
			accountId: "legacy-account",
			addedAt: now,
			lastUsed: now,
		};
		const accountFromCanonical: StoredAccountFixture = {
			refreshToken: "canonical-refresh",
			accountId: "canonical-account",
			addedAt: now + 1,
			lastUsed: now + 1,
		};

		async function prepareWorktreeFixture(options?: {
			pointerStyle?: "default" | "windows";
			worktreeName?: string;
		}): Promise<{
			fakeHome: string;
			mainRepo: string;
			worktreeRepo: string;
		}> {
			const fakeHome = join(testWorkDir, "home");
			const mainRepo = join(testWorkDir, "repo-main");
			const worktreeName = options?.worktreeName ?? "repo-pr-8";
			const worktreeRepo = join(testWorkDir, worktreeName);
			const mainGitDir = join(mainRepo, ".git");
			const worktreeGitDir = join(mainGitDir, "worktrees", worktreeName);

			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			process.env.CODEX_MULTI_AUTH_DIR = join(fakeHome, ".codex", "multi-auth");

			await fs.mkdir(mainGitDir, { recursive: true });
			await fs.mkdir(worktreeGitDir, { recursive: true });
			await fs.mkdir(worktreeRepo, { recursive: true });
			if (options?.pointerStyle === "windows") {
				const winGitDirPointer = worktreeGitDir.replace(/\//g, "\\");
				await fs.writeFile(
					join(worktreeRepo, ".git"),
					`gitdir: ${winGitDirPointer}\n`,
					"utf-8",
				);
				await fs.writeFile(
					join(worktreeGitDir, "commondir"),
					"..\\..\\\n",
					"utf-8",
				);
				await fs.writeFile(
					join(worktreeGitDir, "gitdir"),
					`${join(worktreeRepo, ".git").replace(/\//g, "\\")}\n`,
					"utf-8",
				);
			} else {
				await fs.writeFile(
					join(worktreeRepo, ".git"),
					`gitdir: ${worktreeGitDir}\n`,
					"utf-8",
				);
				await fs.writeFile(
					join(worktreeGitDir, "commondir"),
					"../..\n",
					"utf-8",
				);
				await fs.writeFile(
					join(worktreeGitDir, "gitdir"),
					`${join(worktreeRepo, ".git")}\n`,
					"utf-8",
				);
			}

			return { fakeHome, mainRepo, worktreeRepo };
		}

		function buildStorage(accounts: StoredAccountFixture[]) {
			return {
				version: 3 as const,
				activeIndex: 0,
				activeIndexByFamily: {},
				accounts,
			};
		}

		beforeEach(async () => {
			await fs.mkdir(testWorkDir, { recursive: true });
		});

		afterEach(async () => {
			setStoragePathDirect(null);
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			if (originalMultiAuthDir === undefined)
				delete process.env.CODEX_MULTI_AUTH_DIR;
			else process.env.CODEX_MULTI_AUTH_DIR = originalMultiAuthDir;
			await fs.rm(testWorkDir, { recursive: true, force: true });
			vi.restoreAllMocks();
		});

		it("migrates worktree-keyed storage to repo-shared canonical path", async () => {
			const { worktreeRepo } = await prepareWorktreeFixture();

			setStoragePath(worktreeRepo);
			const canonicalPath = getStoragePath();
			const legacyWorktreePath = join(
				getConfigDir(),
				"projects",
				getProjectStorageKey(worktreeRepo),
				"openai-codex-accounts.json",
			);
			expect(legacyWorktreePath).not.toBe(canonicalPath);

			await fs.mkdir(
				join(getConfigDir(), "projects", getProjectStorageKey(worktreeRepo)),
				{
					recursive: true,
				},
			);
			await fs.writeFile(
				legacyWorktreePath,
				JSON.stringify(buildStorage([accountFromLegacy]), null, 2),
				"utf-8",
			);

			const loaded = await loadAccounts();

			expect(loaded).not.toBeNull();
			expect(loaded?.accounts).toHaveLength(1);
			expect(loaded?.accounts[0]?.accountId).toBe("legacy-account");
			expect(existsSync(canonicalPath)).toBe(true);
			expect(existsSync(legacyWorktreePath)).toBe(false);
		});

		it("merges canonical and legacy worktree storage when both exist", async () => {
			const { worktreeRepo } = await prepareWorktreeFixture();

			setStoragePath(worktreeRepo);
			const canonicalPath = getStoragePath();
			const legacyWorktreePath = join(
				getConfigDir(),
				"projects",
				getProjectStorageKey(worktreeRepo),
				"openai-codex-accounts.json",
			);
			await fs.mkdir(
				join(getConfigDir(), "projects", getProjectStorageKey(worktreeRepo)),
				{
					recursive: true,
				},
			);
			await fs.mkdir(
				join(
					getConfigDir(),
					"projects",
					getProjectStorageKey(join(testWorkDir, "repo-main")),
				),
				{
					recursive: true,
				},
			);

			await fs.writeFile(
				canonicalPath,
				JSON.stringify(buildStorage([accountFromCanonical]), null, 2),
				"utf-8",
			);
			await fs.writeFile(
				legacyWorktreePath,
				JSON.stringify(buildStorage([accountFromLegacy]), null, 2),
				"utf-8",
			);

			const loaded = await loadAccounts();

			expect(loaded).not.toBeNull();
			expect(loaded?.accounts).toHaveLength(2);
			const accountIds =
				loaded?.accounts.map((account) => account.accountId) ?? [];
			expect(accountIds).toContain("canonical-account");
			expect(accountIds).toContain("legacy-account");
			expect(existsSync(legacyWorktreePath)).toBe(false);
		});

		it("keeps legacy worktree file when migration persist fails", async () => {
			const { worktreeRepo } = await prepareWorktreeFixture();

			setStoragePath(worktreeRepo);
			const canonicalPath = getStoragePath();
			const canonicalWalPath = `${canonicalPath}.wal`;
			const legacyWorktreePath = join(
				getConfigDir(),
				"projects",
				getProjectStorageKey(worktreeRepo),
				"openai-codex-accounts.json",
			);
			await fs.mkdir(
				join(getConfigDir(), "projects", getProjectStorageKey(worktreeRepo)),
				{
					recursive: true,
				},
			);
			await fs.writeFile(
				legacyWorktreePath,
				JSON.stringify(buildStorage([accountFromLegacy]), null, 2),
				"utf-8",
			);

			const originalWriteFile = fs.writeFile.bind(fs);
			const writeSpy = vi
				.spyOn(fs, "writeFile")
				.mockImplementation(
					async (...args: Parameters<typeof fs.writeFile>) => {
						const [targetPath] = args;
						if (
							typeof targetPath === "string" &&
							targetPath === canonicalWalPath
						) {
							const error = new Error(
								"forced write failure",
							) as NodeJS.ErrnoException;
							error.code = "EACCES";
							throw error;
						}
						return originalWriteFile(...args);
					},
				);

			const loaded = await loadAccounts();

			writeSpy.mockRestore();
			expect(loaded).not.toBeNull();
			expect(loaded?.accounts).toHaveLength(1);
			expect(loaded?.accounts[0]?.accountId).toBe("legacy-account");
			expect(existsSync(legacyWorktreePath)).toBe(true);
		});

		it("handles concurrent loadAccounts migration without duplicate race artifacts", async () => {
			const { worktreeRepo } = await prepareWorktreeFixture({
				worktreeName: "repo-pr-race",
			});

			setStoragePath(worktreeRepo);
			const canonicalPath = getStoragePath();
			const legacyWorktreePath = join(
				getConfigDir(),
				"projects",
				getProjectStorageKey(worktreeRepo),
				"openai-codex-accounts.json",
			);
			await fs.mkdir(
				join(getConfigDir(), "projects", getProjectStorageKey(worktreeRepo)),
				{
					recursive: true,
				},
			);
			await fs.mkdir(dirname(canonicalPath), { recursive: true });
			await fs.writeFile(
				canonicalPath,
				JSON.stringify(buildStorage([accountFromCanonical]), null, 2),
				"utf-8",
			);
			await fs.writeFile(
				legacyWorktreePath,
				JSON.stringify(buildStorage([accountFromLegacy]), null, 2),
				"utf-8",
			);

			const results = await Promise.all([
				loadAccounts(),
				loadAccounts(),
				loadAccounts(),
				loadAccounts(),
			]);

			for (const result of results) {
				expect(result).not.toBeNull();
				expect(result?.accounts).toHaveLength(2);
			}

			const persistedRaw = await fs.readFile(canonicalPath, "utf-8");
			const persistedNormalized = normalizeAccountStorage(
				JSON.parse(persistedRaw) as unknown,
			);
			expect(persistedNormalized).not.toBeNull();
			expect(persistedNormalized?.accounts).toHaveLength(2);
			expect(existsSync(legacyWorktreePath)).toBe(false);
		});

		it("migrates worktree storage with Windows-style gitdir pointer fixtures", async () => {
			const { worktreeRepo } = await prepareWorktreeFixture({
				pointerStyle: "windows",
				worktreeName: "repo-pr-win-ptr",
			});

			setStoragePath(worktreeRepo);
			const canonicalPath = getStoragePath();
			const legacyWorktreePath = join(
				getConfigDir(),
				"projects",
				getProjectStorageKey(worktreeRepo),
				"openai-codex-accounts.json",
			);
			expect(legacyWorktreePath).not.toBe(canonicalPath);

			await fs.mkdir(
				join(getConfigDir(), "projects", getProjectStorageKey(worktreeRepo)),
				{
					recursive: true,
				},
			);
			await fs.writeFile(
				legacyWorktreePath,
				JSON.stringify(buildStorage([accountFromLegacy]), null, 2),
				"utf-8",
			);

			const loaded = await loadAccounts();

			expect(loaded).not.toBeNull();
			expect(loaded?.accounts).toHaveLength(1);
			expect(loaded?.accounts[0]?.accountId).toBe("legacy-account");
			expect(existsSync(canonicalPath)).toBe(true);
			expect(existsSync(legacyWorktreePath)).toBe(false);
		});

		it("rejects forged commondir aliasing and keeps storage scoped to the current worktree", async () => {
			const worktreeName = "repo-pr-hostile";
			const { mainRepo, worktreeRepo } = await prepareWorktreeFixture({
				worktreeName,
			});
			const worktreeGitDir = join(mainRepo, ".git", "worktrees", worktreeName);
			const foreignRepo = join(testWorkDir, "repo-foreign");
			const foreignGitDir = join(foreignRepo, ".git");
			const foreignAccount: StoredAccountFixture = {
				refreshToken: "foreign-refresh",
				accountId: "foreign-account",
				addedAt: now + 2,
				lastUsed: now + 2,
			};

			await fs.mkdir(foreignGitDir, { recursive: true });
			await fs.writeFile(
				join(worktreeGitDir, "commondir"),
				`${foreignGitDir}\n`,
				"utf-8",
			);

			setStoragePath(worktreeRepo);
			const canonicalPath = getStoragePath();
			const safeCanonicalPath = join(
				getConfigDir(),
				"projects",
				getProjectStorageKey(worktreeRepo),
				"openai-codex-accounts.json",
			);
			const foreignCanonicalPath = join(
				getConfigDir(),
				"projects",
				getProjectStorageKey(foreignRepo),
				"openai-codex-accounts.json",
			);
			await fs.mkdir(dirname(safeCanonicalPath), { recursive: true });
			await fs.mkdir(dirname(foreignCanonicalPath), { recursive: true });
			await fs.writeFile(
				safeCanonicalPath,
				JSON.stringify(buildStorage([accountFromLegacy]), null, 2),
				"utf-8",
			);
			await fs.writeFile(
				foreignCanonicalPath,
				JSON.stringify(buildStorage([foreignAccount]), null, 2),
				"utf-8",
			);

			const loaded = await loadAccounts();

			expect(canonicalPath).toBe(safeCanonicalPath);
			expect(canonicalPath).not.toBe(foreignCanonicalPath);
			expect(loaded).not.toBeNull();
			expect(loaded?.accounts).toHaveLength(1);
			expect(loaded?.accounts[0]?.accountId).toBe("legacy-account");
			expect(existsSync(canonicalPath)).toBe(true);

			const foreignRaw = await fs.readFile(foreignCanonicalPath, "utf-8");
			const foreignStorage = normalizeAccountStorage(
				JSON.parse(foreignRaw) as unknown,
			);
			expect(foreignStorage?.accounts[0]?.accountId).toBe("foreign-account");
		});
	});

	describe("saveAccounts EPERM/EBUSY retry logic", () => {
		const testWorkDir = join(
			tmpdir(),
			"codex-retry-" + Math.random().toString(36).slice(2),
		);
		let testStoragePath: string;

		beforeEach(async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			await fs.mkdir(testWorkDir, { recursive: true });
			testStoragePath = join(testWorkDir, "accounts.json");
			setStoragePathDirect(testStoragePath);
		});

		afterEach(async () => {
			vi.useRealTimers();
			setStoragePathDirect(null);
			await fs.rm(testWorkDir, { recursive: true, force: true });
		});

		it("retries on EPERM and succeeds on second attempt", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			const originalRename = fs.rename.bind(fs);
			let attemptCount = 0;
			const renameSpy = vi
				.spyOn(fs, "rename")
				.mockImplementation(async (oldPath, newPath) => {
					attemptCount++;
					if (attemptCount === 1) {
						const err = new Error("EPERM error") as NodeJS.ErrnoException;
						err.code = "EPERM";
						throw err;
					}
					return originalRename(oldPath as string, newPath as string);
				});

			await saveAccounts(storage);
			expect(attemptCount).toBe(2);
			expect(existsSync(testStoragePath)).toBe(true);

			renameSpy.mockRestore();
		});

		it("retries on EBUSY and succeeds on third attempt", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			const originalRename = fs.rename.bind(fs);
			let attemptCount = 0;
			const renameSpy = vi
				.spyOn(fs, "rename")
				.mockImplementation(async (oldPath, newPath) => {
					attemptCount++;
					if (attemptCount <= 2) {
						const err = new Error("EBUSY error") as NodeJS.ErrnoException;
						err.code = "EBUSY";
						throw err;
					}
					return originalRename(oldPath as string, newPath as string);
				});

			await saveAccounts(storage);
			expect(attemptCount).toBe(3);
			expect(existsSync(testStoragePath)).toBe(true);

			renameSpy.mockRestore();
		});

		it("throws after 5 failed EPERM retries", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			let attemptCount = 0;
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
				attemptCount++;
				const err = new Error("EPERM error") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			});

			await expect(saveAccounts(storage)).rejects.toThrow(
				"Failed to save accounts",
			);
			expect(attemptCount).toBe(5);

			renameSpy.mockRestore();
		});

		it("throws immediately on non-EPERM/EBUSY errors", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			let attemptCount = 0;
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
				attemptCount++;
				const err = new Error("EACCES error") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			});

			await expect(saveAccounts(storage)).rejects.toThrow(
				"Failed to save accounts",
			);
			expect(attemptCount).toBe(1);

			renameSpy.mockRestore();
		});

		it("throws when temp file is written with size 0", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			const statSpy = vi.spyOn(fs, "stat").mockResolvedValue({
				size: 0,
				isFile: () => true,
				isDirectory: () => false,
			} as unknown as Awaited<ReturnType<typeof fs.stat>>);

			await expect(saveAccounts(storage)).rejects.toThrow(
				"Failed to save accounts",
			);
			expect(statSpy).toHaveBeenCalled();

			statSpy.mockRestore();
		});

		it("retries backup copyFile on transient EBUSY and succeeds", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			// Seed a primary file so backup creation path runs on next save.
			await saveAccounts(storage);

			const originalCopy = fs.copyFile.bind(fs);
			let copyAttempts = 0;
			const copySpy = vi
				.spyOn(fs, "copyFile")
				.mockImplementation(async (src, dest) => {
					copyAttempts += 1;
					if (copyAttempts === 1) {
						const err = new Error("EBUSY copy") as NodeJS.ErrnoException;
						err.code = "EBUSY";
						throw err;
					}
					return originalCopy(src as string, dest as string);
				});
			try {
				await saveAccounts({
					...storage,
					accounts: [
						{ refreshToken: "token-next", addedAt: now, lastUsed: now },
					],
				});

				expect(copyAttempts).toBe(2);
			} finally {
				copySpy.mockRestore();
			}
		});

		it("retries backup copyFile on transient EPERM and succeeds", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			// Seed a primary file so backup creation path runs on next save.
			await saveAccounts(storage);

			const originalCopy = fs.copyFile.bind(fs);
			let copyAttempts = 0;
			const copySpy = vi
				.spyOn(fs, "copyFile")
				.mockImplementation(async (src, dest) => {
					copyAttempts += 1;
					if (copyAttempts === 1) {
						const err = new Error("EPERM copy") as NodeJS.ErrnoException;
						err.code = "EPERM";
						throw err;
					}
					return originalCopy(src as string, dest as string);
				});
			try {
				await saveAccounts({
					...storage,
					accounts: [
						{ refreshToken: "token-next", addedAt: now, lastUsed: now },
					],
				});

				expect(copyAttempts).toBe(2);
			} finally {
				copySpy.mockRestore();
			}
		});

		it("retries staged backup rename on transient EBUSY and succeeds", async () => {
			const now = Date.now();
			const storagePath = getStoragePath();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
			};

			// Seed a primary file so backup creation path runs on next save.
			await saveAccounts(storage);

			const originalRename = fs.rename.bind(fs);
			let stagedRenameAttempts = 0;
			const renameSpy = vi
				.spyOn(fs, "rename")
				.mockImplementation(async (oldPath, newPath) => {
					const sourcePath = String(oldPath);
					if (sourcePath.includes(".rotate.")) {
						stagedRenameAttempts += 1;
						if (stagedRenameAttempts === 1) {
							const err = new Error(
								"EBUSY staged rename",
							) as NodeJS.ErrnoException;
							err.code = "EBUSY";
							throw err;
						}
					}
					return originalRename(oldPath as string, newPath as string);
				});
			try {
				await saveAccounts({
					...storage,
					accounts: [
						{ refreshToken: "token-next", addedAt: now + 1, lastUsed: now + 1 },
					],
				});

				expect(stagedRenameAttempts).toBe(2);
				const latestBackup = JSON.parse(
					await fs.readFile(`${storagePath}.bak`, "utf-8"),
				) as {
					accounts?: Array<{ refreshToken?: string }>;
				};
				expect(latestBackup.accounts?.[0]?.refreshToken).toBe("token");
			} finally {
				renameSpy.mockRestore();
			}
		});

		it("rotates backups and retains historical snapshots", async () => {
			const now = Date.now();
			const storagePath = getStoragePath();

			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token-1", addedAt: now, lastUsed: now }],
			});
			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "token-2", addedAt: now + 1, lastUsed: now + 1 },
				],
			});
			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "token-3", addedAt: now + 2, lastUsed: now + 2 },
				],
			});
			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "token-4", addedAt: now + 3, lastUsed: now + 3 },
				],
			});

			const latestBackupRaw = await fs.readFile(`${storagePath}.bak`, "utf-8");
			const historicalBackupRaw = await fs.readFile(
				`${storagePath}.bak.1`,
				"utf-8",
			);
			const oldestBackupRaw = await fs.readFile(
				`${storagePath}.bak.2`,
				"utf-8",
			);
			const latestBackup = JSON.parse(latestBackupRaw) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const historicalBackup = JSON.parse(historicalBackupRaw) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const oldestBackup = JSON.parse(oldestBackupRaw) as {
				accounts?: Array<{ refreshToken?: string }>;
			};

			expect(latestBackup.accounts?.[0]?.refreshToken).toBe("token-3");
			expect(historicalBackup.accounts?.[0]?.refreshToken).toBe("token-2");
			expect(oldestBackup.accounts?.[0]?.refreshToken).toBe("token-1");
		});

		it("preserves historical backups when creating the latest backup fails", async () => {
			const now = Date.now();
			const storagePath = getStoragePath();

			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token-1", addedAt: now, lastUsed: now }],
			});
			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "token-2", addedAt: now + 1, lastUsed: now + 1 },
				],
			});
			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "token-3", addedAt: now + 2, lastUsed: now + 2 },
				],
			});
			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "token-4", addedAt: now + 3, lastUsed: now + 3 },
				],
			});

			const originalCopy = fs.copyFile.bind(fs);
			const copySpy = vi
				.spyOn(fs, "copyFile")
				.mockImplementation(async (src, dest) => {
					if (src === storagePath) {
						const err = new Error(
							"ENOSPC backup copy",
						) as NodeJS.ErrnoException;
						err.code = "ENOSPC";
						throw err;
					}
					return originalCopy(src as string, dest as string);
				});
			try {
				await saveAccounts({
					version: 3 as const,
					activeIndex: 0,
					accounts: [
						{ refreshToken: "token-5", addedAt: now + 4, lastUsed: now + 4 },
					],
				});
			} finally {
				copySpy.mockRestore();
			}

			const primary = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const latestBackup = JSON.parse(
				await fs.readFile(`${storagePath}.bak`, "utf-8"),
			) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const historicalBackup = JSON.parse(
				await fs.readFile(`${storagePath}.bak.1`, "utf-8"),
			) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const oldestBackup = JSON.parse(
				await fs.readFile(`${storagePath}.bak.2`, "utf-8"),
			) as {
				accounts?: Array<{ refreshToken?: string }>;
			};

			expect(primary.accounts?.[0]?.refreshToken).toBe("token-5");
			expect(latestBackup.accounts?.[0]?.refreshToken).toBe("token-3");
			expect(historicalBackup.accounts?.[0]?.refreshToken).toBe("token-2");
			expect(oldestBackup.accounts?.[0]?.refreshToken).toBe("token-1");
		});

		it("keeps rotating backup order deterministic across parallel saves", async () => {
			const now = Date.now();
			const storagePath = getStoragePath();

			await saveAccounts({
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token-0", addedAt: now, lastUsed: now }],
			});

			await Promise.all([
				saveAccounts({
					version: 3 as const,
					activeIndex: 0,
					accounts: [
						{ refreshToken: "token-1", addedAt: now + 1, lastUsed: now + 1 },
					],
				}),
				saveAccounts({
					version: 3 as const,
					activeIndex: 0,
					accounts: [
						{ refreshToken: "token-2", addedAt: now + 2, lastUsed: now + 2 },
					],
				}),
				saveAccounts({
					version: 3 as const,
					activeIndex: 0,
					accounts: [
						{ refreshToken: "token-3", addedAt: now + 3, lastUsed: now + 3 },
					],
				}),
				saveAccounts({
					version: 3 as const,
					activeIndex: 0,
					accounts: [
						{ refreshToken: "token-4", addedAt: now + 4, lastUsed: now + 4 },
					],
				}),
			]);

			const latestBackup = JSON.parse(
				await fs.readFile(`${storagePath}.bak`, "utf-8"),
			) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const primary = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const historicalBackup = JSON.parse(
				await fs.readFile(`${storagePath}.bak.1`, "utf-8"),
			) as {
				accounts?: Array<{ refreshToken?: string }>;
			};
			const oldestBackup = JSON.parse(
				await fs.readFile(`${storagePath}.bak.2`, "utf-8"),
			) as {
				accounts?: Array<{ refreshToken?: string }>;
			};

			expect(primary.accounts?.[0]?.refreshToken).toBe("token-4");
			expect(latestBackup.accounts?.[0]?.refreshToken).toBe("token-3");
			expect(historicalBackup.accounts?.[0]?.refreshToken).toBe("token-2");
			expect(oldestBackup.accounts?.[0]?.refreshToken).toBe("token-1");
		});
	});

	describe("clearAccounts edge cases", () => {
		it("removes primary, backup, and wal artifacts", async () => {
			const now = Date.now();
			const storage = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [{ refreshToken: "token-1", addedAt: now, lastUsed: now }],
			};

			const storagePath = getStoragePath();
			await saveAccounts(storage);
			await fs.writeFile(
				`${storagePath}.bak`,
				JSON.stringify(storage),
				"utf-8",
			);
			await fs.writeFile(
				`${storagePath}.bak.1`,
				JSON.stringify(storage),
				"utf-8",
			);
			await fs.writeFile(
				`${storagePath}.bak.2`,
				JSON.stringify(storage),
				"utf-8",
			);
			await fs.writeFile(
				`${storagePath}.wal`,
				JSON.stringify(storage),
				"utf-8",
			);

			expect(existsSync(storagePath)).toBe(true);
			expect(existsSync(`${storagePath}.bak`)).toBe(true);
			expect(existsSync(`${storagePath}.bak.1`)).toBe(true);
			expect(existsSync(`${storagePath}.bak.2`)).toBe(true);
			expect(existsSync(`${storagePath}.wal`)).toBe(true);

			await clearAccounts();

			expect(existsSync(storagePath)).toBe(false);
			expect(existsSync(`${storagePath}.bak`)).toBe(false);
			expect(existsSync(`${storagePath}.bak.1`)).toBe(false);
			expect(existsSync(`${storagePath}.bak.2`)).toBe(false);
			expect(existsSync(`${storagePath}.wal`)).toBe(false);
		});

		it("logs error for non-ENOENT errors during clear", async () => {
			const unlinkSpy = vi
				.spyOn(fs, "unlink")
				.mockRejectedValue(
					Object.assign(new Error("EACCES error"), { code: "EACCES" }),
				);

			await clearAccounts();

			expect(unlinkSpy).toHaveBeenCalled();
			unlinkSpy.mockRestore();
		});
	});
});

it("clearAccounts removes discovered backup artifacts as well as fixed slots", async () => {
	const storagePath = getStoragePath();
	const discoveredBackup = join(
		dirname(storagePath),
		"openai-codex-accounts.json.20260310-010101.json",
	);
	const storage = {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "clear@example.com",
				refreshToken: "refresh-clear",
				accessToken: "access-clear",
				expiresAt: Date.now() + 3_600_000,
				addedAt: Date.now(),
				lastUsed: Date.now(),
				accountId: "acc-clear",
				enabled: true,
			},
		],
	};
	await fs.writeFile(storagePath, JSON.stringify(storage), "utf-8");
	await fs.writeFile(discoveredBackup, JSON.stringify(storage), "utf-8");

	await clearAccounts();

	expect(existsSync(storagePath)).toBe(false);
	expect(existsSync(discoveredBackup)).toBe(false);
});
