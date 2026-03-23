import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	loadAccountsFromPath,
	parseAndNormalizeStorage,
} from "../lib/storage/storage-parser.js";
import { normalizeAccountStorage } from "../lib/storage.js";

describe("storage parser helpers", () => {
	it("parses and normalizes record storage payloads", () => {
		const result = parseAndNormalizeStorage(
			{ version: 3, activeIndex: 0, accounts: [] },
			normalizeAccountStorage,
			(value): value is Record<string, unknown> =>
				!!value && typeof value === "object" && !Array.isArray(value),
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
				isRecord: (value): value is Record<string, unknown> =>
					!!value && typeof value === "object" && !Array.isArray(value),
			});
			expect(result.normalized?.version).toBe(3);
		} finally {
			await fs.rm(filePath, { force: true });
		}
	});
});
