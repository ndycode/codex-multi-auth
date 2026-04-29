import { describe, expect, it, vi } from "vitest";
import { getAccountPolicyKey, type AccountPolicyStore } from "../lib/account-policy.js";
import { runAccountCommand } from "../lib/codex-manager/commands/account.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function makeStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "owner@example.com",
				accountId: "acct_1",
				refreshToken: "refresh",
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
}

function makeDeps(store: AccountPolicyStore) {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => makeStorage()),
		loadPolicyStore: vi.fn(async () => store),
		savePolicyStore: vi.fn(async () => undefined),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: () => 123,
	};
}

describe("account command", () => {
	it("tags and pauses account policies", async () => {
		const store: AccountPolicyStore = { version: 1, accounts: {} };
		const deps = makeDeps(store);

		expect(await runAccountCommand(["tag", "1", "Team A"], deps)).toBe(0);
		expect(await runAccountCommand(["pause", "1"], deps)).toBe(0);

		const key = getAccountPolicyKey(makeStorage().accounts[0]!, 0);
		expect(store.accounts[key]).toMatchObject({
			tags: ["team-a"],
			paused: true,
			updatedAt: 123,
		});
		expect(deps.savePolicyStore).toHaveBeenCalledTimes(2);
	});

	it("sets weight, drain state, and note", async () => {
		const store: AccountPolicyStore = { version: 1, accounts: {} };
		const deps = makeDeps(store);

		expect(await runAccountCommand(["weight", "1", "3.5"], deps)).toBe(0);
		expect(await runAccountCommand(["drain", "1"], deps)).toBe(0);
		expect(await runAccountCommand(["note", "1", "batch", "only"], deps)).toBe(0);

		const key = getAccountPolicyKey(makeStorage().accounts[0]!, 0);
		expect(store.accounts[key]).toMatchObject({
			weight: 3.5,
			drained: true,
			note: "batch only",
		});
	});

	it("lists policy state as json", async () => {
		const storage = makeStorage();
		const key = getAccountPolicyKey(storage.accounts[0]!, 0);
		const store: AccountPolicyStore = {
			version: 1,
			accounts: {
				[key]: {
					accountKey: key,
					tags: ["team-a"],
					weight: 2,
					paused: true,
					drained: false,
					note: null,
					updatedAt: 123,
				},
			},
		};
		const deps = makeDeps(store);

		expect(await runAccountCommand(["policy", "list", "--json"], deps)).toBe(0);
		const payload = JSON.parse(String(deps.logInfo.mock.calls[0]?.[0])) as {
			accounts: Array<{ accountKey: string; tags: string[]; paused: boolean }>;
		};
		expect(payload.accounts[0]).toMatchObject({
			accountKey: key,
			tags: ["team-a"],
			paused: true,
		});
		expect(JSON.stringify(payload)).not.toContain("acct_1");
		expect(JSON.stringify(payload)).not.toContain("owner@example.com");
	});

	it("rejects invalid account indexes", async () => {
		const deps = makeDeps({ version: 1, accounts: {} });
		expect(await runAccountCommand(["tag", "2", "team"], deps)).toBe(1);
		expect(String(deps.logError.mock.calls[0]?.[0])).toContain(
			"Account index is required",
		);
	});
});

