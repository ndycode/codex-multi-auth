import { expect, it } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import type { AccountStorageV3 } from "../lib/storage.js";

type Baselines = { rememberWorkspaceSelections(snapshot?: AccountStorageV3): void; persistedWorkspaceSelections: WeakMap<object, string | undefined> };

function row(recordId: string, selected: number) {
	// Same accountId + email: duplicate identities that only recordId tells apart.
	return { recordId, accountId: "shared", email: "same@example.com", refreshToken: `refresh-${recordId}`, addedAt: 1, lastUsed: 1,
		workspaces: [{ id: "ws-a", name: "A" }, { id: "ws-b", name: "B" }], currentWorkspaceIndex: selected };
}

it("takes each account's saved workspace baseline from its own recordId, not the first duplicate identity", () => {
	const storage: AccountStorageV3 = { version: 3, activeIndex: 0, activeIndexByFamily: {}, accounts: [row("first", 0), row("second", 1)] };
	const manager = new AccountManager(undefined, storage);
	const internals = manager as unknown as Baselines;
	internals.rememberWorkspaceSelections(storage);
	const [first, second] = manager.getAccountsSnapshot().map((account) => manager.getAccountByIndex(account.index)!);
	expect(internals.persistedWorkspaceSelections.get(first!)).toBe("ws-a");
	expect(internals.persistedWorkspaceSelections.get(second!)).toBe("ws-b");
});

