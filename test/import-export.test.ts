import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	exportAccountsToFile,
	mergeImportedAccounts,
	readImportFile,
} from "../lib/storage/import-export.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("import export helpers", () => {
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
		});

		expect(result.total).toBe(2);
		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
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
});
