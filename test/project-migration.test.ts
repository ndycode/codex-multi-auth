import { describe, expect, it, vi } from "vitest";
import {
	loadNormalizedStorageFromPath,
	mergeStorageForMigration,
} from "../lib/storage/project-migration.js";
import type { AccountStorageV3 } from "../lib/storage.js";

describe("project migration helpers", () => {
	it("loads normalized storage and reports schema warnings", async () => {
		const logWarn = vi.fn();
		const normalized: AccountStorageV3 = {
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		};

		const result = await loadNormalizedStorageFromPath(
			"/tmp/a.json",
			"legacy",
			{
				loadAccountsFromPath: async () => ({
					normalized,
					schemaErrors: ["bad field"],
				}),
				logWarn,
			},
		);

		expect(result).toBe(normalized);
		expect(logWarn).toHaveBeenCalledWith(
			"legacy schema validation warnings",
			expect.objectContaining({ path: "/tmp/a.json" }),
		);
	});

	it("returns null for missing storage without logging", async () => {
		const logWarn = vi.fn();
		const result = await loadNormalizedStorageFromPath(
			"/tmp/missing.json",
			"legacy",
			{
				loadAccountsFromPath: async () => {
					const error = new Error("missing") as NodeJS.ErrnoException;
					error.code = "ENOENT";
					throw error;
				},
				logWarn,
			},
		);

		expect(result).toBeNull();
		expect(logWarn).not.toHaveBeenCalled();
	});

	it("merges storages through normalizeAccountStorage and preserves current on invalid merge", () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [{ refreshToken: "a" }] as AccountStorageV3["accounts"],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [{ refreshToken: "b" }] as AccountStorageV3["accounts"],
			activeIndex: 0,
			activeIndexByFamily: {},
		};

		const normalize = vi.fn((value: unknown) => value as AccountStorageV3);
		const merged = mergeStorageForMigration(current, incoming, normalize);
		expect(merged.accounts).toHaveLength(2);

		const fallback = mergeStorageForMigration(current, incoming, () => null);
		expect(fallback).toBe(current);
	});
});
