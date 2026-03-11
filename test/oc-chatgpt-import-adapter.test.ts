import { describe, expect, it } from "vitest";
import {
	buildOcChatgptImportPayload,
	previewOcChatgptImportMerge,
} from "../lib/oc-chatgpt-import-adapter.js";
import type { AccountStorageV3 } from "../lib/storage.js";

describe("oc-chatgpt import adapter", () => {
	it("builds a target payload that filters invalid accounts and preserves identity-rich duplicates", () => {
		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-1",
					email: "same@example.com",
					refreshToken: "token-new",
					addedAt: 5,
					lastUsed: 5,
				},
				{
					accountId: "acc-1",
					email: "same@example.com",
					refreshToken: "token-old",
					addedAt: 3,
					lastUsed: 3,
				},
				{
					accountId: "acc-2",
					email: "same@example.com",
					refreshToken: "token-two",
					addedAt: 4,
					lastUsed: 4,
				},
				{
					email: "legacy@example.com",
					refreshToken: "token-legacy-new",
					addedAt: 2,
					lastUsed: 9,
				},
				{
					email: "legacy@example.com",
					refreshToken: "token-legacy-old",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					email: "no-token@example.com",
					refreshToken: "   ",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		const payload = buildOcChatgptImportPayload(source);
		expect(payload.accounts).toHaveLength(3);
		const acc1 = payload.accounts.find(
			(account) => account.accountId === "acc-1",
		);
		expect(acc1?.refreshToken).toBe("token-new");
		const acc2 = payload.accounts.find(
			(account) => account.accountId === "acc-2",
		);
		expect(acc2).toBeDefined();
		const legacy = payload.accounts.find(
			(account) => account.email === "legacy@example.com",
		);
		expect(legacy?.refreshToken).toBe("token-legacy-new");
	});

	it("previews merge with accountId precedence, email fallback for id-less entries, and preserves destination selection", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
			accounts: [
				{
					accountId: "acc-1",
					email: "same@example.com",
					refreshToken: "token-old",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc-2",
					email: "same@example.com",
					refreshToken: "token-two",
					accountLabel: "Destination only",
					addedAt: 2,
					lastUsed: 2,
				},
				{
					email: "legacy-only@example.com",
					refreshToken: "legacy-old",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-1",
					email: "same@example.com",
					refreshToken: "token-new",
					addedAt: 3,
					lastUsed: 5,
				},
				{
					accountId: "acc-3",
					email: "same@example.com",
					refreshToken: "token-three",
					addedAt: 4,
					lastUsed: 4,
				},
				{
					email: "legacy-only@example.com",
					refreshToken: "legacy-new",
					addedAt: 2,
					lastUsed: 6,
				},
			],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });
		expect(preview.activeSelectionBehavior).toBe("preserve-destination");
		expect(preview.payload.accounts).toEqual([
			{
				accountId: "acc-1",
				email: "same@example.com",
				refreshTokenLast4: "-new",
			},
			{
				accountId: "acc-3",
				email: "same@example.com",
				refreshTokenLast4: "hree",
			},
			{
				accountId: undefined,
				email: "legacy-only@example.com",
				refreshTokenLast4: "-new",
			},
		]);
		expect(preview.toAdd).toHaveLength(1);
		expect(preview.toUpdate).toHaveLength(2);
		expect(preview.toSkip).toHaveLength(0);
		expect(preview.unchangedDestinationOnly).toHaveLength(1);
		expect(preview.merged.accounts).toHaveLength(4);
		expect(preview.merged.activeIndex).toBe(destination.activeIndex);
		expect(preview.merged.activeIndexByFamily?.codex).toBe(1);

		const updatedAcc1 = preview.merged.accounts.find(
			(account) => account.accountId === "acc-1",
		);
		expect(updatedAcc1?.refreshToken).toBe("token-new");

		const addedAcc3 = preview.merged.accounts.find(
			(account) => account.accountId === "acc-3",
		);
		expect(addedAcc3).toBeDefined();

		const updatedLegacy = preview.merged.accounts.find(
			(account) => account.email === "legacy-only@example.com",
		);
		expect(updatedLegacy?.refreshToken).toBe("legacy-new");

		const preservedDestinationOnly = preview.merged.accounts.find(
			(account) => account.accountId === "acc-2",
		);
		expect(preservedDestinationOnly).toEqual(destination.accounts[1]);

		expect(preview.toUpdate).toEqual([
			{
				previous: {
					accountId: "acc-1",
					email: "same@example.com",
					refreshTokenLast4: "-old",
				},
				next: {
					accountId: "acc-1",
					email: "same@example.com",
					refreshTokenLast4: "-new",
				},
				matchedBy: "accountId",
			},
			{
				previous: {
					accountId: undefined,
					email: "legacy-only@example.com",
					refreshTokenLast4: "-old",
				},
				next: {
					accountId: undefined,
					email: "legacy-only@example.com",
					refreshTokenLast4: "-new",
				},
				matchedBy: "email",
			},
		]);
		expect(preview.toAdd).toEqual([
			{
				accountId: "acc-3",
				email: "same@example.com",
				refreshTokenLast4: "hree",
			},
		]);
		expect(preview.unchangedDestinationOnly).toEqual([
			{
				accountId: "acc-2",
				email: "same@example.com",
				refreshTokenLast4: "-two",
			},
		]);
	});

	it("does not collapse identity-rich destination accounts when source only provides email", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-identity",
					email: "dup@example.com",
					refreshToken: "token-dest",
					addedAt: 1,
					lastUsed: 10,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "dup@example.com",
					refreshToken: "token-source",
					addedAt: 2,
					lastUsed: 3,
				},
			],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });
		expect(preview.toUpdate).toHaveLength(0);
		expect(preview.toAdd).toHaveLength(1);
		expect(preview.toAdd[0]?.refreshTokenLast4).toBe("urce");
		expect(preview.merged.accounts).toHaveLength(2);
		const preserved = preview.merged.accounts.find(
			(account) => account.accountId === "acc-identity",
		);
		expect(preserved?.refreshToken).toBe("token-dest");
	});

	it("keeps newer destination metadata when a refresh-token fallback match is older than destination", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "shared-refresh-token",
					accountLabel: "Destination winner",
					addedAt: 10,
					lastUsed: 20,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "shared-refresh-token",
					accountLabel: "Older source",
					addedAt: 5,
					lastUsed: 15,
				},
			],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });

		expect(preview.toAdd).toHaveLength(0);
		expect(preview.toUpdate).toHaveLength(0);
		expect(preview.toSkip).toEqual([
			{
				source: {
					accountId: undefined,
					email: undefined,
					refreshTokenLast4: "oken",
				},
				reason: "unchanged-or-older-than-destination",
			},
		]);
		expect(preview.unchangedDestinationOnly).toHaveLength(0);
		expect(preview.merged.accounts).toEqual(destination.accounts);
		expect(preview.merged.activeIndex).toBe(0);
	});

	it("does not use refresh-token fallback for destination accounts with richer identity metadata", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-existing",
					email: "existing@example.com",
					refreshToken: "shared-refresh-token",
					accountLabel: "Destination account",
					addedAt: 1,
					lastUsed: 2,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "shared-refresh-token",
					accountLabel: "Source update",
					addedAt: 3,
					lastUsed: 4,
				},
			],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });

		expect(preview.toUpdate).toHaveLength(0);
		expect(preview.toAdd).toHaveLength(1);
		expect(preview.toAdd[0]?.refreshTokenLast4).toBe("oken");
		expect(preview.merged.accounts).toHaveLength(2);
		expect(preview.unchangedDestinationOnly).toContainEqual({
			accountId: "acc-existing",
			email: "existing@example.com",
			refreshTokenLast4: "oken",
		});
	});

	it("preserves destination metadata when matched records tie on timestamps", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-tie",
					email: "tie@example.com",
					refreshToken: "dest-token",
					accountLabel: "Destination label",
					addedAt: 10,
					lastUsed: 20,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-tie",
					email: "tie@example.com",
					refreshToken: "source-token",
					accountLabel: "Source label",
					addedAt: 10,
					lastUsed: 20,
				},
			],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });

		expect(preview.toAdd).toHaveLength(0);
		expect(preview.toUpdate).toHaveLength(0);
		expect(preview.merged.accounts[0]?.refreshToken).toBe("dest-token");
		expect(preview.merged.accounts[0]?.accountLabel).toBe("Destination label");
	});

	it("records exact matchedBy counts and skip reasons for additive merge", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-1",
					email: "match@example.com",
					refreshToken: "token-old",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					email: "dest-only@example.com",
					refreshToken: "dest-only",
					addedAt: 2,
					lastUsed: 2,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "acc-1",
					email: "match@example.com",
					refreshToken: "token-new",
					addedAt: 3,
					lastUsed: 5,
				},
				{
					email: "new@example.com",
					refreshToken: "token-add",
					addedAt: 4,
					lastUsed: 4,
				},
				{
					email: "bad@example.com",
					refreshToken: "   ",
					addedAt: 5,
					lastUsed: 5,
				},
			],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });
		expect(preview.toUpdate).toHaveLength(1);
		expect(preview.toUpdate[0]?.matchedBy).toBe("accountId");
		expect(preview.toAdd).toHaveLength(1);
		expect(preview.toSkip).toHaveLength(1);
		expect(preview.toSkip[0]?.reason).toBe("invalid-refresh-token");
		expect(preview.unchangedDestinationOnly).toHaveLength(1);
		expect(preview.activeSelectionBehavior).toBe("preserve-destination");
	});

	it("surfaces invalid destination accounts in toSkip", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "broken@example.com",
					refreshToken: "   ",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });
		expect(preview.toSkip).toContainEqual({
			source: {
				accountId: undefined,
				email: "broken@example.com",
				refreshTokenLast4: "",
			},
			reason: "destination-invalid-refresh-token",
		});
		expect(preview.merged.accounts).toHaveLength(0);
		expect(preview.unchangedDestinationOnly).toHaveLength(0);
	});

	it("matches id-less accounts by case-folded email but not plus-address variants", () => {
		const destination: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "user@example.com",
					refreshToken: "dest-token",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "USER@EXAMPLE.COM",
					refreshToken: "token-case-fold",
					addedAt: 2,
					lastUsed: 3,
				},
				{
					email: "user+tag@example.com",
					refreshToken: "token-plus",
					addedAt: 4,
					lastUsed: 5,
				},
			],
		};

		const preview = previewOcChatgptImportMerge({ source, destination });
		const caseFolded = preview.toUpdate.find(
			(entry) => entry.next.refreshTokenLast4 === "fold",
		);
		expect(caseFolded?.matchedBy).toBe("email");
		expect(preview.toAdd).toContainEqual({
			accountId: undefined,
			email: "user+tag@example.com",
			refreshTokenLast4: "plus",
		});
	});

	it("remaps activeIndexByFamily when normalized source accounts collapse duplicates", () => {
		const source: AccountStorageV3 = {
			version: 3,
			activeIndex: 2,
			activeIndexByFamily: { codex: 2, "gpt-5.1": 1 },
			accounts: [
				{
					accountId: "acc-dup",
					email: "first@example.com",
					refreshToken: "token-old",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc-dup",
					email: "first@example.com",
					refreshToken: "token-new",
					addedAt: 2,
					lastUsed: 2,
				},
				{
					email: "second@example.com",
					refreshToken: "token-second",
					addedAt: 3,
					lastUsed: 3,
				},
			],
		};

		const payload = buildOcChatgptImportPayload(source);
		const preview = previewOcChatgptImportMerge({
			source,
			destination: { version: 3, activeIndex: 0, accounts: [] },
		});

		expect(payload.accounts).toHaveLength(2);
		expect(payload.activeIndex).toBe(1);
		expect(payload.activeIndexByFamily).toEqual({ codex: 1, "gpt-5.1": 0 });
		expect(preview.payload.activeIndexByFamily).toEqual({
			codex: 1,
			"gpt-5.1": 0,
		});
	});

	it("normalizes whitespace-only account labels to undefined", () => {
		const payload = buildOcChatgptImportPayload({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "token-label",
					accountLabel: "   ",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});

		expect(payload.accounts[0]?.accountLabel).toBeUndefined();
	});
});
