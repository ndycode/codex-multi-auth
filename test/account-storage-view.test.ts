import { describe, expect, it } from "vitest";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import {
	cloneAccountStorage,
	createEmptyAccountStorage,
} from "../lib/accounts/storage-view.js";

describe("account storage view helpers", () => {
	it("creates default empty storage without prefilled family indexes", () => {
		expect(createEmptyAccountStorage()).toEqual({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
	});

	it("can create empty storage with per-family indexes initialized", () => {
		const storage = createEmptyAccountStorage({ initializeFamilyIndexes: true });
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBe(0);
		}
	});

	it("clones account storage to isolated mutable copies", () => {
		const original = {
			version: 3 as const,
			accounts: [
				{
					refreshToken: "r1",
					email: "a@example.com",
					enabled: true,
					rateLimitResetTimes: { codex: 123_000 },
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const clone = cloneAccountStorage(original);
		expect(clone).toEqual(original);

		clone.accounts[0]!.email = "b@example.com";
		clone.accounts[0]!.rateLimitResetTimes!.codex = 999_000;
		clone.activeIndexByFamily.codex = 1;

		expect(original.accounts[0]!.email).toBe("a@example.com");
		expect(original.accounts[0]!.rateLimitResetTimes?.codex).toBe(123_000);
		expect(original.activeIndexByFamily.codex).toBe(0);
	});

	it("preserves undefined family index map when cloning legacy-shaped storage", () => {
		const clone = cloneAccountStorage({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: undefined,
		});

		expect(clone.activeIndexByFamily).toBeUndefined();
	});
});
