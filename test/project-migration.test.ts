import { describe, expect, it, vi } from "vitest";
import {
	loadNormalizedStorageFromPath,
	mergeStorageForMigration,
} from "../lib/storage/project-migration.js";
import {
	findMatchingAccountIndex,
	type AccountStorageV3,
} from "../lib/storage.js";

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
		const merged = mergeStorageForMigration(
			current,
			incoming,
			normalize,
			findMatchingAccountIndex,
		);
		expect(merged.accounts).toHaveLength(2);

		const fallback = mergeStorageForMigration(
			current,
			incoming,
			() => null,
			findMatchingAccountIndex,
		);
		expect(fallback).toBe(current);
	});

	it("carries the manual pin and affinity generation through migration (#474)", () => {
		// `current` holds a duplicate `a`, pinned on `b` at index 2. The normalize
		// mock mirrors the real normalizeAccountStorage: it DEDUPLICATES the merged
		// accounts and then only RANGE-validates the pin. An identity mock could not
		// catch this — after dedupe, raw index 2 is in range but points at `c`.
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{ refreshToken: "a" },
				{ refreshToken: "a" },
				{ refreshToken: "b" },
			] as AccountStorageV3["accounts"],
			activeIndex: 0,
			activeIndexByFamily: {},
			pinnedAccountIndex: 2,
			affinityGeneration: 5,
		};
		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [{ refreshToken: "c" }] as AccountStorageV3["accounts"],
			activeIndex: 0,
			activeIndexByFamily: {},
		};

		const normalize = vi.fn((value: unknown) => {
			const storage = value as AccountStorageV3;
			const accounts = Array.from(
				new Map(
					storage.accounts.map((account) => [account.refreshToken, account]),
				).values(),
			) as AccountStorageV3["accounts"];
			const pinnedAccountIndex =
				typeof storage.pinnedAccountIndex === "number" &&
				storage.pinnedAccountIndex >= 0 &&
				storage.pinnedAccountIndex < accounts.length
					? storage.pinnedAccountIndex
					: undefined;
			return { ...storage, accounts, pinnedAccountIndex };
		});
		const merged = mergeStorageForMigration(
			current,
			incoming,
			normalize,
			findMatchingAccountIndex,
		);

		// The pin/gen must still be forwarded into normalizeAccountStorage, which is
		// where clamping/validation against the merged account list happens.
		expect(normalize).toHaveBeenCalledWith(
			expect.objectContaining({ pinnedAccountIndex: 2, affinityGeneration: 5 }),
		);
		expect(merged.accounts.map((account) => account.refreshToken)).toEqual([
			"a",
			"b",
			"c",
		]);
		// Dedupe moved `b` from index 2 to 1; carrying the raw index would have
		// silently re-pinned onto `c`.
		expect(merged.pinnedAccountIndex).toBe(1);
		expect(merged.accounts[merged.pinnedAccountIndex ?? -1]?.refreshToken).toBe(
			"b",
		);
		expect(merged.affinityGeneration).toBe(5);
	});

	it("clears the pin when the pinned account is gone after normalization", () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{ refreshToken: "a" },
				{ refreshToken: "b" },
			] as AccountStorageV3["accounts"],
			activeIndex: 0,
			activeIndexByFamily: {},
			pinnedAccountIndex: 1,
			affinityGeneration: 5,
		};
		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [{ refreshToken: "c" }] as AccountStorageV3["accounts"],
			activeIndex: 0,
			activeIndexByFamily: {},
		};

		// Normalization drops the pinned account (e.g. it failed validation).
		const normalize = vi.fn((value: unknown) => {
			const storage = value as AccountStorageV3;
			return {
				...storage,
				accounts: storage.accounts.filter(
					(account) => account.refreshToken !== "b",
				),
			};
		});
		const merged = mergeStorageForMigration(
			current,
			incoming,
			normalize,
			findMatchingAccountIndex,
		);

		expect(merged.pinnedAccountIndex).toBeUndefined();
		expect(merged.affinityGeneration).toBe(5);
	});
});
