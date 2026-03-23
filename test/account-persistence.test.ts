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
});
