import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageV3 } from "../lib/storage.js";
import * as storageModule from "../lib/storage.js";
import * as codexCliState from "../lib/codex-cli/state.js";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import {
	__resetLastCodexCliSyncRunForTests,
	applyCodexCliSyncToStorage,
	commitCodexCliSyncRunFailure,
	commitPendingCodexCliSyncRun,
	getActiveSelectionForFamily,
	getLastCodexCliSyncRun,
	previewCodexCliSync,
	syncAccountStorageFromCodexCli,
} from "../lib/codex-cli/sync.js";
import * as writerModule from "../lib/codex-cli/writer.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES", "ETIMEDOUT"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await rm(targetPath, options);
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

describe("codex-cli sync", () => {
	let tempDir: string;
	let accountsPath: string;
	let authPath: string;
	let configPath: string;
	let targetStoragePath: string;
	let previousPath: string | undefined;
	let previousAuthPath: string | undefined;
	let previousConfigPath: string | undefined;
	let previousSync: string | undefined;
	let previousEnforceFileStore: string | undefined;

	beforeEach(async () => {
		previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
		previousAuthPath = process.env.CODEX_CLI_AUTH_PATH;
		previousConfigPath = process.env.CODEX_CLI_CONFIG_PATH;
		previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		previousEnforceFileStore =
			process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-sync-"));
		accountsPath = join(tempDir, "accounts.json");
		authPath = join(tempDir, "auth.json");
		configPath = join(tempDir, "config.toml");
		targetStoragePath = join(tempDir, "openai-codex-accounts.json");
		process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_CLI_CONFIG_PATH = configPath;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "1";
		vi.spyOn(storageModule, "getStoragePath").mockReturnValue(targetStoragePath);
		clearCodexCliStateCache();
		__resetLastCodexCliSyncRunForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCodexCliStateCache();
		__resetLastCodexCliSyncRunForTests();
		if (previousPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
		else process.env.CODEX_CLI_ACCOUNTS_PATH = previousPath;
		if (previousAuthPath === undefined) delete process.env.CODEX_CLI_AUTH_PATH;
		else process.env.CODEX_CLI_AUTH_PATH = previousAuthPath;
		if (previousConfigPath === undefined) delete process.env.CODEX_CLI_CONFIG_PATH;
		else process.env.CODEX_CLI_CONFIG_PATH = previousConfigPath;
		if (previousSync === undefined) {
			delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		} else {
			process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
		}
		if (previousEnforceFileStore === undefined) {
			delete process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
		} else {
			process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE =
				previousEnforceFileStore;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("does not seed canonical storage from Codex CLI mirror files", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_mirror",
					accounts: [
						{
							accountId: "acc_mirror",
							email: "mirror@example.com",
							auth: {
								tokens: {
									access_token: "mirror-access",
									refresh_token: "mirror-refresh",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await syncAccountStorageFromCodexCli(null);
			expect(result.changed).toBe(false);
			expect(result.storage).toBeNull();
			expect(loadSpy).not.toHaveBeenCalled();
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("does not merge or overwrite canonical storage from Codex CLI mirrors", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "b.access.token",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: Object.fromEntries(
				MODEL_FAMILIES.map((family) => [family, 0]),
			),
		};

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await syncAccountStorageFromCodexCli(current);
			expect(result.changed).toBe(false);
			expect(result.storage).toBe(current);
			expect(result.storage?.accounts).toEqual(current.accounts);
			expect(loadSpy).not.toHaveBeenCalled();
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("normalizes local indexes without reading Codex CLI mirror state", async () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					email: "b@example.com",
					refreshToken: "refresh-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 99,
			activeIndexByFamily: { codex: 99 },
		};

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await syncAccountStorageFromCodexCli(current);
			expect(result.changed).toBe(true);
			expect(result.storage).not.toBe(current);
			expect(result.storage?.activeIndex).toBe(1);
			expect(result.storage?.activeIndexByFamily?.codex).toBe(1);
			for (const family of MODEL_FAMILIES.filter((candidate) => candidate !== "codex")) {
				expect(result.storage?.activeIndexByFamily?.[family]).toBeUndefined();
			}
			expect(loadSpy).not.toHaveBeenCalled();
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("clamps NaN activeIndex to 0 and reports changed", async () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: Number.NaN,
			activeIndexByFamily: {},
		};

		const result = await syncAccountStorageFromCodexCli(current);
		expect(result.changed).toBe(true);
		expect(result.storage?.activeIndex).toBe(0);
	});

	it("previews one-way manual sync changes without mutating canonical storage", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_c",
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a-new",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_c",
							email: "c@example.com",
							auth: {
								tokens: {
									access_token: "access-c",
									refresh_token: "refresh-c",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a-old",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					email: "b@example.com",
					refreshToken: "refresh-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		const preview = await previewCodexCliSync(current, {
			forceRefresh: true,
			storageBackupEnabled: true,
		});

		expect(preview.status).toBe("ready");
		expect(preview.sourcePath).toBe(accountsPath);
		expect(preview.summary.addedAccountCount).toBe(1);
		expect(preview.summary.updatedAccountCount).toBe(1);
		expect(preview.summary.destinationOnlyPreservedCount).toBe(1);
		expect(preview.summary.selectionChanged).toBe(true);
		expect(preview.backup.enabled).toBe(true);
		expect(preview.backup.rollbackPaths).toContain(`${preview.targetPath}.bak`);
		expect(preview.backup.rollbackPaths).toContain(`${preview.targetPath}.wal`);
		const serializedPreview = JSON.stringify(preview);
		expect(serializedPreview).not.toContain("access-a-new");
		expect(serializedPreview).not.toContain("refresh-a");
		expect(serializedPreview).not.toContain("access-c");
		expect(serializedPreview).not.toContain("refresh-c");
		expect(current.accounts).toHaveLength(2);
	});

	it("skips ambiguous duplicate-email source matches instead of overwriting a local account", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							email: "dup@example.com",
							auth: {
								tokens: {
									access_token: "access-new",
									refresh_token: "refresh-new",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "dup@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					email: "dup@example.com",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		const result = await applyCodexCliSyncToStorage(current, {
			forceRefresh: true,
		});

		expect(result.changed).toBe(false);
		expect(result.pendingRun).toBeNull();
		expect(result.storage?.accounts).toEqual(current.accounts);
	});

	it("skips ambiguous duplicate-accountId source matches instead of overwriting a local account", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							accountId: "shared-id",
							auth: {
								tokens: {
									access_token: "access-new",
									refresh_token: "refresh-new",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "shared-id",
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "shared-id",
					email: "b@example.com",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		const result = await applyCodexCliSyncToStorage(current, {
			forceRefresh: true,
		});

		expect(result.changed).toBe(false);
		expect(result.pendingRun).toBeNull();
		expect(result.storage?.accounts).toEqual(current.accounts);
	});

	it("reports skipped ambiguous source snapshots in the preview summary", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							accountId: "shared-id",
							auth: {
								tokens: {
									access_token: "access-new",
									refresh_token: "refresh-new",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "shared-id",
					email: "first@example.com",
					refreshToken: "refresh-first",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "shared-id",
					email: "second@example.com",
					refreshToken: "refresh-second",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const preview = await previewCodexCliSync(current, {
			forceRefresh: true,
		});

		expect(preview.status).toBe("noop");
		expect(preview.summary.sourceAccountCount).toBe(1);
		expect(preview.statusDetail).toContain("1 source account skipped");
	});

	it("preserves the current selection when Codex CLI source has no active marker", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a",
									refresh_token: "refresh-a",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					accountIdSource: "token",
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					accountIdSource: "token",
					email: "b@example.com",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		const preview = await previewCodexCliSync(current, {
			forceRefresh: true,
		});

		expect(preview.status).toBe("noop");
		expect(preview.summary.selectionChanged).toBe(false);
	});

	it("preserves a newer persisted local selection after restart", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_a",
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const sourceTime = new Date("2026-03-13T00:00:00.000Z");
		const targetTime = new Date("2026-03-13T00:00:05.000Z");
		await utimes(accountsPath, sourceTime, sourceTime);
		await writeFile(targetStoragePath, "{\"version\":3}", "utf-8");
		await utimes(targetStoragePath, targetTime, targetTime);

		vi.spyOn(storageModule, "getLastAccountsSaveTimestamp").mockReturnValue(0);
		vi.spyOn(writerModule, "getLastCodexCliSelectionWriteTimestamp").mockReturnValue(
			0,
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					accountIdSource: "token",
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					accountIdSource: "token",
					email: "b@example.com",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		const preview = await previewCodexCliSync(current, {
			forceRefresh: true,
		});

		expect(preview.status).toBe("noop");
		expect(preview.summary.selectionChanged).toBe(false);
	});

	it("preserves a newer local selection when Codex state has no timestamp metadata", async () => {
		const state = {
			path: accountsPath,
			activeAccountId: "acc_a",
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					accessToken: "access-a",
					refreshToken: "refresh-a",
					isActive: true,
				},
				{
					accountId: "acc_b",
					email: "b@example.com",
					accessToken: "access-b",
					refreshToken: "refresh-b",
				},
			],
		};
		const targetTime = new Date("2026-03-13T00:00:05.000Z");
		await writeFile(targetStoragePath, "{\"version\":3}", "utf-8");
		await utimes(targetStoragePath, targetTime, targetTime);

		vi.spyOn(storageModule, "getLastAccountsSaveTimestamp").mockReturnValue(0);
		vi.spyOn(writerModule, "getLastCodexCliSelectionWriteTimestamp").mockReturnValue(
			0,
		);
		const loadStateSpy = vi
			.spyOn(codexCliState, "loadCodexCliState")
			.mockResolvedValue(state);

		try {
			const current: AccountStorageV3 = {
				version: 3,
				accounts: [
					{
						accountId: "acc_a",
						accountIdSource: "token",
						email: "a@example.com",
						refreshToken: "refresh-a",
						accessToken: "access-a",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						accountId: "acc_b",
						accountIdSource: "token",
						email: "b@example.com",
						refreshToken: "refresh-b",
						accessToken: "access-b",
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 1,
				activeIndexByFamily: { codex: 1 },
			};

			const preview = await previewCodexCliSync(current, {
				forceRefresh: true,
			});

			expect(preview.status).toBe("noop");
			expect(preview.summary.selectionChanged).toBe(false);
		} finally {
			loadStateSpy.mockRestore();
		}
	});

	it("preserves the local selection when the persisted target timestamp is temporarily unreadable", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_a",
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		vi.spyOn(storageModule, "getLastAccountsSaveTimestamp").mockReturnValue(0);
		vi.spyOn(writerModule, "getLastCodexCliSelectionWriteTimestamp").mockReturnValue(
			0,
		);
		vi.spyOn(storageModule, "getStoragePath").mockReturnValue("\0busy-target");

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					accountIdSource: "token",
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					accountIdSource: "token",
					email: "b@example.com",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		const preview = await previewCodexCliSync(current, {
			forceRefresh: true,
		});

		expect(preview.status).toBe("noop");
		expect(preview.summary.selectionChanged).toBe(false);
	});

	it.each(["EBUSY", "EPERM"] as const)(
		"preserves the local selection when reading the persisted target timestamp fails with %s",
		async (code) => {
			await writeFile(
				accountsPath,
				JSON.stringify(
					{
						activeAccountId: "acc_a",
						accounts: [
							{
								accountId: "acc_a",
								email: "a@example.com",
								auth: {
									tokens: {
										access_token: "access-a",
										refresh_token: "refresh-a",
									},
								},
							},
							{
								accountId: "acc_b",
								email: "b@example.com",
								auth: {
									tokens: {
										access_token: "access-b",
										refresh_token: "refresh-b",
									},
								},
							},
						],
					},
					null,
					2,
				),
				"utf-8",
			);

			vi.spyOn(storageModule, "getLastAccountsSaveTimestamp").mockReturnValue(0);
			vi.spyOn(
				writerModule,
				"getLastCodexCliSelectionWriteTimestamp",
			).mockReturnValue(0);
			vi.spyOn(storageModule, "getStoragePath").mockReturnValue(targetStoragePath);
			const statError = new Error(`${code.toLowerCase()} target`) as NodeJS.ErrnoException;
			statError.code = code;
			const nodeFs = await import("node:fs");
			const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
			const statSpy = vi
				.spyOn(nodeFs.promises, "stat")
				.mockImplementation(async (...args: Parameters<typeof originalStat>) => {
					if (args[0] === targetStoragePath) {
						throw statError;
					}
					return originalStat(...args);
				});

			const current: AccountStorageV3 = {
				version: 3,
				accounts: [
					{
						accountId: "acc_a",
						accountIdSource: "token",
						email: "a@example.com",
						refreshToken: "refresh-a",
						accessToken: "access-a",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						accountId: "acc_b",
						accountIdSource: "token",
						email: "b@example.com",
						refreshToken: "refresh-b",
						accessToken: "access-b",
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 1,
				activeIndexByFamily: { codex: 1 },
			};

			try {
				const preview = await previewCodexCliSync(current, {
					forceRefresh: true,
				});

				expect(preview.status).toBe("noop");
				expect(preview.summary.selectionChanged).toBe(false);
			} finally {
				statSpy.mockRestore();
			}
		},
	);

	it("retries a transient persisted-target EBUSY before applying the Codex selection", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_a",
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const sourceTime = new Date("2026-03-13T00:00:05.000Z");
		const targetTime = new Date("2026-03-13T00:00:00.000Z");
		await utimes(accountsPath, sourceTime, sourceTime);
		await writeFile(targetStoragePath, "{\"version\":3}", "utf-8");
		await utimes(targetStoragePath, targetTime, targetTime);

		vi.spyOn(storageModule, "getLastAccountsSaveTimestamp").mockReturnValue(0);
		vi.spyOn(writerModule, "getLastCodexCliSelectionWriteTimestamp").mockReturnValue(
			0,
		);
		vi.spyOn(storageModule, "getStoragePath").mockReturnValue(targetStoragePath);

		const nodeFs = await import("node:fs");
		const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
		let targetStatCalls = 0;
		const statSpy = vi
			.spyOn(nodeFs.promises, "stat")
			.mockImplementation(async (...args: Parameters<typeof originalStat>) => {
				if (args[0] === targetStoragePath) {
					targetStatCalls += 1;
					if (targetStatCalls === 1) {
						const error = new Error("busy target") as NodeJS.ErrnoException;
						error.code = "EBUSY";
						throw error;
					}
				}
				return originalStat(...args);
			});

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					accountIdSource: "token",
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					accountIdSource: "token",
					email: "b@example.com",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		try {
			const preview = await previewCodexCliSync(current, {
				forceRefresh: true,
			});

			expect(targetStatCalls).toBe(2);
			expect(preview.status).toBe("ready");
			expect(preview.summary.selectionChanged).toBe(true);
		} finally {
			statSpy.mockRestore();
		}
	});

	it("records a changed manual sync only after the caller commits persistence", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const result = await applyCodexCliSyncToStorage(current);
		expect(result.changed).toBe(true);
		expect(result.pendingRun).not.toBeNull();
		expect(result.storage?.accounts).toHaveLength(2);
		expect(getLastCodexCliSyncRun()).toBeNull();

		commitPendingCodexCliSyncRun(result.pendingRun);

		const lastRun = getLastCodexCliSyncRun();
		expect(lastRun?.outcome).toBe("changed");
		expect(lastRun?.sourcePath).toBe(accountsPath);
		expect(lastRun?.summary.addedAccountCount).toBe(1);
		expect(lastRun?.summary.destinationOnlyPreservedCount).toBe(1);
	});

	it("re-reads Codex CLI state on apply when forceRefresh is requested", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		await previewCodexCliSync(current, { forceRefresh: true });

		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_c",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
						{
							accountId: "acc_c",
							email: "c@example.com",
							auth: {
								tokens: {
									access_token: "access-c",
									refresh_token: "refresh-c",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await applyCodexCliSyncToStorage(current, {
				forceRefresh: true,
			});
			expect(loadSpy).toHaveBeenCalledWith(
				expect.objectContaining({ forceRefresh: true }),
			);
			expect(result.changed).toBe(true);
			expect(result.storage?.accounts.map((account) => account.accountId)).toEqual([
				"acc_a",
				"acc_b",
				"acc_c",
			]);
			expect(result.storage?.activeIndex).toBe(2);
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("preserves explicit per-family selections when Codex CLI updates the global selection", async () => {
		const alternateFamily = MODEL_FAMILIES.find((family) => family !== "codex");
		expect(alternateFamily).toBeDefined();
		if (!alternateFamily) {
			return;
		}

		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
						{
							accountId: "acc_c",
							email: "c@example.com",
							auth: {
								tokens: {
									access_token: "access-c",
									refresh_token: "refresh-c",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					email: "b@example.com",
					refreshToken: "refresh-b",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_c",
					email: "c@example.com",
					refreshToken: "refresh-c",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {
				codex: 0,
				[alternateFamily]: 2,
			},
		};

		const result = await applyCodexCliSyncToStorage(current, {
			forceRefresh: true,
		});

		expect(result.changed).toBe(true);
		expect(result.storage?.activeIndex).toBe(1);
		expect(result.storage?.activeIndexByFamily?.codex).toBe(1);
		expect(result.storage?.activeIndexByFamily?.[alternateFamily]).toBe(2);
	});

	it("forces a fresh Codex CLI state read on apply when forceRefresh is omitted", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		await previewCodexCliSync(current, { forceRefresh: true });

		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_c",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
						{
							accountId: "acc_c",
							email: "c@example.com",
							auth: {
								tokens: {
									access_token: "access-c",
									refresh_token: "refresh-c",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await applyCodexCliSyncToStorage(current);
			expect(loadSpy).toHaveBeenCalledWith(
				expect.objectContaining({ forceRefresh: true }),
			);
			expect(result.changed).toBe(true);
			expect(result.storage?.accounts.map((account) => account.accountId)).toEqual([
				"acc_a",
				"acc_b",
				"acc_c",
			]);
			expect(result.storage?.activeIndex).toBe(2);
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("returns isolated pending runs for concurrent apply attempts", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const [first, second] = await Promise.all([
			applyCodexCliSyncToStorage(current),
			applyCodexCliSyncToStorage(current),
		]);

		expect(first.changed).toBe(true);
		expect(second.changed).toBe(true);
		expect(first.pendingRun).not.toBeNull();
		expect(second.pendingRun).not.toBeNull();
		expect(first.pendingRun?.revision).not.toBe(second.pendingRun?.revision);
		expect(first.storage?.accounts.map((account) => account.accountId)).toEqual([
			"acc_a",
			"acc_b",
		]);
		expect(second.storage?.accounts.map((account) => account.accountId)).toEqual([
			"acc_a",
			"acc_b",
		]);
		expect(getLastCodexCliSyncRun()).toBeNull();
	});

	it("records a manual sync save failure over a pending changed run", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const result = await applyCodexCliSyncToStorage(current);
		expect(result.pendingRun).not.toBeNull();

		commitCodexCliSyncRunFailure(result.pendingRun, new Error("save busy"));

		const lastRun = getLastCodexCliSyncRun();
		expect(lastRun?.outcome).toBe("error");
		expect(lastRun?.message).toBe("save busy");
		expect(lastRun?.summary.addedAccountCount).toBe(1);
	});

	it("publishes the completion that finishes last even when it started earlier", () => {
		const firstPendingRun = {
			revision: 1,
			run: {
				outcome: "changed" as const,
				runAt: 0,
				sourcePath: accountsPath,
				targetPath: targetStoragePath,
				summary: {
					sourceAccountCount: 1,
					targetAccountCountBefore: 1,
					targetAccountCountAfter: 2,
					addedAccountCount: 1,
					updatedAccountCount: 0,
					unchangedAccountCount: 0,
					destinationOnlyPreservedCount: 1,
					selectionChanged: false,
				},
			},
		};
		const secondPendingRun = {
			revision: 2,
			run: {
				outcome: "changed" as const,
				runAt: 0,
				sourcePath: accountsPath,
				targetPath: targetStoragePath,
				summary: {
					sourceAccountCount: 1,
					targetAccountCountBefore: 1,
					targetAccountCountAfter: 1,
					addedAccountCount: 0,
					updatedAccountCount: 0,
					unchangedAccountCount: 1,
					destinationOnlyPreservedCount: 0,
					selectionChanged: false,
				},
			},
		};

		commitCodexCliSyncRunFailure(secondPendingRun, new Error("later run failed"));
		expect(getLastCodexCliSyncRun()?.outcome).toBe("error");

		commitPendingCodexCliSyncRun(firstPendingRun);

		expect(getLastCodexCliSyncRun()).toEqual(
			expect.objectContaining({
				outcome: "changed",
				sourcePath: accountsPath,
				targetPath: targetStoragePath,
				summary: expect.objectContaining({
					addedAccountCount: 1,
				}),
			}),
		);
	});

	it("ignores a duplicate sync-run publish for the same revision", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const result = await applyCodexCliSyncToStorage(current);
		expect(result.pendingRun).not.toBeNull();

		commitPendingCodexCliSyncRun(result.pendingRun);
		const committedRun = getLastCodexCliSyncRun();

		commitCodexCliSyncRunFailure(
			result.pendingRun,
			new Error("should not overwrite committed run"),
		);

		expect(getLastCodexCliSyncRun()).toEqual(committedRun);
		expect(getLastCodexCliSyncRun()?.outcome).toBe("changed");
	});

	it("serializes concurrent active-selection writes to keep accounts/auth aligned", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a",
									id_token: "id-a",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									id_token: "id-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);
		await writeFile(
			authPath,
			JSON.stringify(
				{
					auth_mode: "chatgpt",
					OPENAI_API_KEY: null,
					email: "a@example.com",
					tokens: {
						access_token: "access-a",
						id_token: "id-a",
						refresh_token: "refresh-a",
						account_id: "acc_a",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const [first, second] = await Promise.all([
			setCodexCliActiveSelection({ accountId: "acc_a" }),
			setCodexCliActiveSelection({ accountId: "acc_b" }),
		]);
		expect(first).toBe(true);
		expect(second).toBe(true);

		const writtenAccounts = JSON.parse(
			await readFile(accountsPath, "utf-8"),
		) as {
			activeAccountId?: string;
			activeEmail?: string;
			accounts?: Array<{ accountId?: string; active?: boolean }>;
		};
		const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
			email?: string;
			tokens?: { account_id?: string };
		};

		expect(writtenAccounts.activeAccountId).toBe("acc_b");
		expect(writtenAccounts.activeEmail).toBe("b@example.com");
		expect(writtenAccounts.accounts?.[0]?.active).toBe(false);
		expect(writtenAccounts.accounts?.[1]?.active).toBe(true);
		expect(writtenAuth.tokens?.account_id).toBe("acc_b");
		expect(writtenAuth.email).toBe("b@example.com");
	});

	it("clamps and defaults active selection indexes by model family", () => {
		const family = MODEL_FAMILIES[0];
		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [],
					activeIndex: 99,
					activeIndexByFamily: {},
				},
				family,
			),
		).toBe(0);

		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [
						{ refreshToken: "a", addedAt: 1, lastUsed: 1 },
						{ refreshToken: "b", addedAt: 1, lastUsed: 1 },
					],
					activeIndex: 1,
					activeIndexByFamily: { [family]: Number.NaN },
				},
				family,
			),
		).toBe(1);

		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [
						{ refreshToken: "a", addedAt: 1, lastUsed: 1 },
						{ refreshToken: "b", addedAt: 1, lastUsed: 1 },
					],
					activeIndex: 1,
					activeIndexByFamily: { [family]: -3 },
				},
				family,
			),
		).toBe(0);

		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [
						{ refreshToken: "a", addedAt: 1, lastUsed: 1 },
						{ refreshToken: "b", addedAt: 1, lastUsed: 1 },
					],
					activeIndex: 1.9,
					activeIndexByFamily: { [family]: 1.9 },
				},
				family,
			),
		).toBe(1);

		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [
						{ refreshToken: "a", addedAt: 1, lastUsed: 1 },
						{ refreshToken: "b", addedAt: 1, lastUsed: 1 },
						{ refreshToken: "c", addedAt: 1, lastUsed: 1 },
					],
					activeIndex: 1.9,
					activeIndexByFamily: { [family]: Number.NaN },
				},
				family,
			),
		).toBe(1);
	});

	it("does not report changes when missing family indexes already resolve to the active index", async () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		};

		const result = await syncAccountStorageFromCodexCli(current);
		expect(result.changed).toBe(false);
		expect(result.storage).toBe(current);
	});
});
