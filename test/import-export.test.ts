import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	exportAccountsToFile,
	mergeImportedAccounts,
	readImportFile,
} from "../lib/storage/import-export.js";
import { findMatchingAccountIndex } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("import export helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("merges imported accounts with dedupe guardrails", () => {
		const result = mergeImportedAccounts({
			existing: {
				version: 3,
				accounts: [{ refreshToken: "a" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			imported: {
				version: 3,
				accounts: [{ refreshToken: "b" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			maxAccounts: 10,
			deduplicateAccounts: (accounts) => accounts,
			findMatchingAccountIndex,
		});

		expect(result.total).toBe(2);
		expect(result.imported).toBe(1);
	});

	it("counts imports against deduplicated existing storage", () => {
		const result = mergeImportedAccounts({
			existing: {
				version: 3,
				accounts: [{ refreshToken: "a" }, { refreshToken: "a" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			imported: {
				version: 3,
				accounts: [{ refreshToken: "b" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			maxAccounts: 10,
			deduplicateAccounts: (accounts) =>
				Array.from(
					new Map(accounts.map((account) => [account.refreshToken, account])).values(),
				),
			findMatchingAccountIndex,
		});

		expect(result.total).toBe(2);
		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
	});

	it("preserves the manual pin and affinity generation across import (#474)", () => {
		const result = mergeImportedAccounts({
			existing: {
				version: 3,
				accounts: [{ refreshToken: "a" }, { refreshToken: "b" }],
				activeIndex: 0,
				activeIndexByFamily: {},
				pinnedAccountIndex: 1,
				affinityGeneration: 7,
			},
			imported: {
				version: 3,
				accounts: [{ refreshToken: "c" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			maxAccounts: 10,
			deduplicateAccounts: (accounts) => accounts,
			findMatchingAccountIndex,
		});

		expect(result.newStorage.pinnedAccountIndex).toBe(1);
		expect(result.newStorage.affinityGeneration).toBe(7);
	});

	it("remaps the pin by identity when dedupe shifts account positions", () => {
		// Existing [a, a, b] pinned on `b` (index 2). Dedupe collapses the duplicate
		// `a`, so raw index 2 now points at the IMPORTED account `c` — in range, but
		// the wrong account. The pin must follow the identity it was set on.
		const result = mergeImportedAccounts({
			existing: {
				version: 3,
				accounts: [
					{ refreshToken: "a" },
					{ refreshToken: "a" },
					{ refreshToken: "b" },
				],
				activeIndex: 0,
				activeIndexByFamily: {},
				pinnedAccountIndex: 2,
				affinityGeneration: 7,
			},
			imported: {
				version: 3,
				accounts: [{ refreshToken: "c" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			maxAccounts: 10,
			deduplicateAccounts: (accounts) =>
				Array.from(
					new Map(accounts.map((account) => [account.refreshToken, account])).values(),
				),
			findMatchingAccountIndex,
		});

		expect(result.newStorage.accounts.map((a) => a.refreshToken)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(result.newStorage.pinnedAccountIndex).toBe(1);
		expect(
			result.newStorage.accounts[result.newStorage.pinnedAccountIndex ?? -1]
				?.refreshToken,
		).toBe("b");
		expect(result.newStorage.affinityGeneration).toBe(7);
	});

	it("drops the pin when the pinned account no longer resolves after merge", () => {
		const result = mergeImportedAccounts({
			existing: {
				version: 3,
				accounts: [{ refreshToken: "a" }, { refreshToken: "b" }],
				activeIndex: 0,
				activeIndexByFamily: {},
				pinnedAccountIndex: 1,
				affinityGeneration: 3,
			},
			imported: {
				version: 3,
				accounts: [{ refreshToken: "c" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			maxAccounts: 10,
			// Drops the pinned account entirely, so no identity match remains.
			deduplicateAccounts: (accounts) =>
				accounts.filter((account) => account.refreshToken !== "b"),
			findMatchingAccountIndex,
		});

		expect(result.newStorage.pinnedAccountIndex).toBeUndefined();
		expect(result.newStorage.affinityGeneration).toBe(3);
	});

	it("leaves pin and affinity generation unset when existing storage lacks them", () => {
		const result = mergeImportedAccounts({
			existing: {
				version: 3,
				accounts: [{ refreshToken: "a" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			imported: {
				version: 3,
				accounts: [{ refreshToken: "b" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			maxAccounts: 10,
			deduplicateAccounts: (accounts) => accounts,
			findMatchingAccountIndex,
		});

		expect(result.newStorage.pinnedAccountIndex).toBeUndefined();
		expect(result.newStorage.affinityGeneration).toBeUndefined();
	});

	it("throws for invalid import payloads and empty exports", async () => {
		await expect(
			readImportFile({
				resolvedPath: `${process.cwd()}/missing-import.json`,
				normalizeAccountStorage: () => null,
			}),
		).rejects.toThrow("Import file not found");

		await expect(
			exportAccountsToFile({
				resolvedPath: `${process.cwd()}/out.json`,
				force: true,
				storage: null,
				logInfo: vi.fn(),
			}),
		).rejects.toThrow("No accounts to export");
	});

	it("writes exports through a staged temp file and removes temp artifacts", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "codex-import-export-"));
		const resolvedPath = join(root, "accounts.json");
		const logInfo = vi.fn();

		try {
			await exportAccountsToFile({
				resolvedPath,
				force: true,
				storage: {
					version: 3,
					accounts: [{ refreshToken: "token-a" }],
					activeIndex: 0,
					activeIndexByFamily: {},
				},
				logInfo,
			});

			const written = JSON.parse(await fs.readFile(resolvedPath, "utf-8")) as {
				accounts: Array<{ refreshToken: string }>;
			};
			const tempArtifacts = (await fs.readdir(root)).filter((entry) =>
				entry.endsWith(".tmp"),
			);

			expect(written.accounts).toEqual([{ refreshToken: "token-a" }]);
			expect(tempArtifacts).toEqual([]);
			expect(logInfo).toHaveBeenCalledWith("Exported accounts", {
				path: resolvedPath,
				count: 1,
			});
		} finally {
			await removeWithRetry(root, { recursive: true, force: true });
		}
	});

	it.each([
		// storage-07: prove renameExportFileWithRetry honours the widened shared
		// retryable set (ENOTEMPTY/EACCES) via shouldRetryFileOperation, not just
		// the legacy EPERM/EBUSY/EAGAIN subset.
		"ENOTEMPTY",
		"EACCES",
	] as const)(
		"retries transient %s errors when committing the export",
		async (code) => {
			// Stub the staging writes so the test does not touch real disk and so
			// fake timers can drain the rename backoff deterministically.
			const mkdirSpy = vi.spyOn(fs, "mkdir");
			mkdirSpy.mockResolvedValue(undefined as never);
			const writeFileSpy = vi.spyOn(fs, "writeFile");
			writeFileSpy.mockResolvedValue(undefined);

			vi.useFakeTimers();
			const renameSpy = vi.spyOn(fs, "rename");
			let attempts = 0;
			renameSpy.mockImplementation(async () => {
				if (attempts < 1) {
					attempts += 1;
					const error = new Error(code) as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				}
				return undefined;
			});
			const logInfo = vi.fn();

			const exportPromise = exportAccountsToFile({
				resolvedPath: join(tmpdir(), "codex-import-export-retry.json"),
				force: true,
				storage: {
					version: 3,
					accounts: [{ refreshToken: "token-a" }],
					activeIndex: 0,
					activeIndexByFamily: {},
				},
				logInfo,
			});

			await vi.runAllTimersAsync();
			await expect(exportPromise).resolves.toBeUndefined();
			// Failed attempt + successful retry => rename called more than once.
			expect(renameSpy).toHaveBeenCalledTimes(2);
			expect(logInfo).toHaveBeenCalledWith("Exported accounts", {
				path: join(tmpdir(), "codex-import-export-retry.json"),
				count: 1,
			});
		},
	);
});
