import { promises as fs } from "node:fs";
import { afterEach, vi } from "vitest";
import {
	loadAccountsFromPath,
	parseAndNormalizeStorage,
} from "../lib/storage/storage-parser.js";
import { normalizeAccountStorage } from "../lib/storage.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

describe("storage parser helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses and normalizes record storage payloads", () => {
		const result = parseAndNormalizeStorage(
			{ version: 3, activeIndex: 0, accounts: [] },
			normalizeAccountStorage,
			isRecord,
		);

		expect(result.normalized?.version).toBe(3);
		expect(result.storedVersion).toBe(3);
		expect(Array.isArray(result.schemaErrors)).toBe(true);
	});

	it("loads and parses storage files from disk", async () => {
		const filePath = `${process.cwd()}/tmp-storage-parser-test.json`;
		await fs.writeFile(
			filePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf8",
		);
		try {
			const result = await loadAccountsFromPath(filePath, {
				normalizeAccountStorage,
				isRecord,
			});
			expect(result.normalized?.version).toBe(3);
		} finally {
			await fs.rm(filePath, { force: true });
		}
	});

	it("propagates SyntaxError on malformed JSON (preserved contract)", async () => {
		const filePath = `${process.cwd()}/tmp-storage-parser-syntax-error.json`;
		await fs.writeFile(filePath, "{not valid json {[", "utf8");
		try {
			await expect(
				loadAccountsFromPath(filePath, {
					normalizeAccountStorage,
					isRecord,
				}),
			).rejects.toBeInstanceOf(SyntaxError);
		} finally {
			await fs.rm(filePath, { force: true });
		}
	});

	it("retries a transient EBUSY on the primary read, then parses (windows lock)", async () => {
		// storage-01: a momentary Windows lock surfaces as EBUSY on readFile. The
		// loader routes the read through withFileOperationRetry, so it must retry
		// rather than fall through to WAL/backup recovery — the parsed result is
		// returned once the lock clears.
		const ebusy = Object.assign(new Error("EBUSY: resource busy or locked"), {
			code: "EBUSY",
		});
		// lib/storage/storage-parser.ts calls readFile(path, "utf-8"), which resolves a
		// string. Resolve the string directly (no Buffer cast) so the mock matches runtime.
		const validJson = JSON.stringify({ version: 3, activeIndex: 0, accounts: [] });
		const readSpy = vi
			.spyOn(fs, "readFile")
			.mockRejectedValueOnce(ebusy)
			.mockResolvedValueOnce(validJson);

		const result = await loadAccountsFromPath("/virtual/accounts.json", {
			normalizeAccountStorage,
			isRecord,
		});
		expect(result.normalized?.version).toBe(3);
		expect(readSpy).toHaveBeenCalledTimes(2);
	});

	it("retries a transient EPERM on the primary read, then parses (windows lock)", async () => {
		// storage-07: permission-style failures (EPERM/EACCES) are now part of the
		// shared retryable set the loader consumes via withFileOperationRetry, so a
		// momentary Windows permission hold must retry rather than fall through to
		// WAL/backup recovery — mirroring the EBUSY case above to pin the widened
		// contract.
		const eperm = Object.assign(new Error("EPERM: operation not permitted"), {
			code: "EPERM",
		});
		// readFile(path, "utf-8") resolves a string at runtime; resolve the string
		// directly (no Buffer cast) so the mock matches runtime.
		const validJson = JSON.stringify({ version: 3, activeIndex: 0, accounts: [] });
		const readSpy = vi
			.spyOn(fs, "readFile")
			.mockRejectedValueOnce(eperm)
			.mockResolvedValueOnce(validJson);

		const result = await loadAccountsFromPath("/virtual/accounts.json", {
			normalizeAccountStorage,
			isRecord,
		});
		expect(result.normalized?.version).toBe(3);
		expect(readSpy).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry ENOENT (missing-file contract preserved)", async () => {
		const enoent = Object.assign(new Error("ENOENT: no such file"), {
			code: "ENOENT",
		});
		const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(enoent);

		await expect(
			loadAccountsFromPath("/virtual/missing.json", {
				normalizeAccountStorage,
				isRecord,
			}),
		).rejects.toThrow(/ENOENT/);
		// ENOENT is not a retryable code: a single attempt only.
		expect(readSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces schema warnings for JSON-valid but schema-invalid payloads", async () => {
		const filePath = `${process.cwd()}/tmp-storage-parser-schema-invalid.json`;
		// Version 2 is not part of AnyAccountStorageSchema; normalizer returns
		// null, but the raw payload still reaches parseAndNormalizeStorage so
		// schemaErrors is populated for observability.
		await fs.writeFile(
			filePath,
			JSON.stringify({ version: 2, accounts: [], activeIndex: 0 }),
			"utf8",
		);
		try {
			const result = await loadAccountsFromPath(filePath, {
				normalizeAccountStorage,
				isRecord,
			});
			expect(result.normalized).toBeNull();
			expect(result.storedVersion).toBe(2);
			expect(result.schemaErrors.length).toBeGreaterThan(0);
		} finally {
			await fs.rm(filePath, { force: true });
		}
	});
});
