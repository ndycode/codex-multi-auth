import { describe, expect, it } from "vitest";
import { cloneAccountStorageForPersistence } from "../lib/storage/account-persistence.js";

describe("account persistence helper", () => {
	it("clones storage and normalizes missing numeric fields", () => {
		const original = {
			version: 3 as const,
			accounts: [{ refreshToken: "a" }],
			activeIndex: 2,
			activeIndexByFamily: { codex: 1 },
		};

		const cloned = cloneAccountStorageForPersistence(original);
		expect(cloned).toEqual(original);
		expect(cloned.accounts).not.toBe(original.accounts);
		expect(cloned.activeIndexByFamily).not.toBe(original.activeIndexByFamily);
	});

	it("returns empty normalized storage for null input", () => {
		expect(cloneAccountStorageForPersistence(null)).toEqual({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
	});

	it("preserves pinnedAccountIndex and affinityGeneration when defined", () => {
		// Regression: the clone previously dropped these fields, erasing a user's
		// manual `switch <n>` pin when persisted through the combined transaction.
		const original = {
			version: 3 as const,
			accounts: [{ refreshToken: "a" }],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
			pinnedAccountIndex: 1,
			affinityGeneration: 7,
		};

		const cloned = cloneAccountStorageForPersistence(original);
		expect(cloned.pinnedAccountIndex).toBe(1);
		expect(cloned.affinityGeneration).toBe(7);
		expect(cloned).toEqual(original);
	});

	it("omits pin/generation fields when absent rather than emitting undefined", () => {
		const cloned = cloneAccountStorageForPersistence({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		expect("pinnedAccountIndex" in cloned).toBe(false);
		expect("affinityGeneration" in cloned).toBe(false);
	});
});
