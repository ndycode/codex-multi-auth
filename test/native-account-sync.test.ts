import { describe, it, expect } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { syncNativeAccountCredentials } from "../lib/runtime/native-account-sync.js";
import { workspaceModelScopes } from "../lib/runtime/workspace-model-scopes.js";
const fixture = (): AccountStorageV3 => ({
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "a@example.test",
			accountId: "a",
			refreshToken: "old-refresh",
			accessToken: "old-access",
			expiresAt: 2000,
			addedAt: 1,
			lastUsed: 1,
			coolingDownUntil: 9999,
			cooldownReason: "auth-failure",
			rateLimitResetTimes: { codex: 99999 },
		},
	],
});
describe("native account credential reload", () => {
	it("adopts external workspace inventory and disablement without changing credentials", () => {
		const storage=fixture();
		storage.accounts[0]!.workspaces=[{id:"personal",enabled:true},{id:"business",enabled:true},{id:"removed",enabled:true}];
		storage.accounts[0]!.currentWorkspaceIndex=0;
		const manager=new AccountManager(undefined,storage), disk=structuredClone(storage);
		disk.accounts[0]!.workspaces=[{id:"business",enabled:false},{id:"personal",enabled:true},{id:"new",enabled:true}];
		disk.accounts[0]!.currentWorkspaceIndex=1;
		expect(syncNativeAccountCredentials(manager,disk)).toBe(true);
		const account=manager.getAccountByIndex(0)!;
		expect(account.workspaces).toEqual(disk.accounts[0]!.workspaces);
		expect(account.workspaces?.[account.currentWorkspaceIndex ?? 0]?.id).toBe("personal");
		expect(workspaceModelScopes(account).filter(s=>s.routable).map(s=>s.accountId)).not.toContain("business");
		expect(syncNativeAccountCredentials(manager,disk)).toBe(false);
	});
	it("keeps local health disablement when the external policy did not change", () => {
		const storage=fixture(); storage.accounts[0]!.workspaces=[{id:"personal",enabled:true}];
		const manager=new AccountManager(undefined,storage),disk=structuredClone(storage);
		manager.disableWorkspace(manager.getAccountByIndex(0)!,"personal");
		syncNativeAccountCredentials(manager,disk);
		expect(manager.getAccountByIndex(0)!.workspaces?.[0]?.enabled).toBe(false);
	});
	it("does not re-enable explicitly disabled workspaces when re-enabling an account", () => {
		const storage=fixture(); storage.accounts[0]!.enabled=false;
		storage.accounts[0]!.workspaces=[{id:"personal",enabled:true},{id:"business",enabled:false}];
		const manager=new AccountManager(undefined,storage);
		manager.setAccountEnabled(0,true);
		expect(manager.getAccountByIndex(0)!.workspaces?.[1]?.enabled).toBe(false);
	});
	it("adopts a CLI workspace preference even when tokens are unchanged", () => {
		const storage=fixture();
		storage.accounts[0]!.workspaces=[{id:"business",enabled:true},{id:"personal",enabled:true}];
		storage.accounts[0]!.currentWorkspaceIndex=0;
		const manager=new AccountManager(undefined,storage), disk=structuredClone(storage);
		disk.accounts[0]!.currentWorkspaceIndex=1;
		expect(syncNativeAccountCredentials(manager,disk)).toBe(true);
		expect(manager.getAccountByIndex(0)?.currentWorkspaceIndex).toBe(1);
		expect(syncNativeAccountCredentials(manager,disk)).toBe(false);
	});
	it("adopts fresh login credentials and clears only obsolete auth cooldown", () => {
		const storage = fixture(),
			manager = new AccountManager(undefined, storage);
		const disk = structuredClone(storage);
		Object.assign(disk.accounts[0]!, {
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresAt: 3000,
		});
		expect(syncNativeAccountCredentials(manager, disk)).toBe(true);
		const account = manager.getAccountByIndex(0)!;
		expect(account.access).toBe("new-access");
		expect(account.cooldownReason).toBeUndefined();
		expect(account.rateLimitResetTimes.codex).toBe(99999);
	});
	it("keeps cooldown for unchanged credentials but adopts an explicit shorter-lived replacement", () => {
		const storage = fixture(),
			manager = new AccountManager(undefined, storage);
		expect(syncNativeAccountCredentials(manager, storage)).toBe(false);
		expect(manager.getAccountByIndex(0)!.cooldownReason).toBe("auth-failure");
		const disk = structuredClone(storage);
		Object.assign(disk.accounts[0]!, { accessToken: "older", expiresAt: 1000 });
		expect(syncNativeAccountCredentials(manager, disk)).toBe(true);
		expect(manager.getAccountByIndex(0)!.access).toBe("older");
	});
	it("applies disablement without clearing quota cooldowns on token changes", () => {
		const storage = fixture();
		storage.accounts[0]!.cooldownReason = "network-error";
		const manager = new AccountManager(undefined, storage),
			disk = structuredClone(storage);
		Object.assign(disk.accounts[0]!, {
			enabled: false,
			accessToken: "new",
			expiresAt: 3000,
		});
		syncNativeAccountCredentials(manager, disk);
		expect(manager.getAccountByIndex(0)!.enabled).toBe(false);
		expect(manager.getAccountByIndex(0)!.cooldownReason).toBe("network-error");
	});
});

it("removes a deleted access token even when a refresh token remains", () => {
	const disk = fixture(), manager = new AccountManager(undefined, disk);
	delete disk.accounts[0]!.accessToken;
	expect(syncNativeAccountCredentials(manager, disk)).toBe(true);
	expect(manager.getAccountByIndex(0)!.access).toBeUndefined();
});

it("adopts shortened expiry without requiring a token string change", () => {
	const disk = fixture(), manager = new AccountManager(undefined, disk);
	disk.accounts[0]!.expiresAt = 1;
	expect(syncNativeAccountCredentials(manager, disk)).toBe(true);
	expect(manager.getAccountByIndex(0)!.expires).toBe(1);
});

it("adopts explicit invalidation even when credentials have not changed", () => {
	const storage = fixture(),
		manager = new AccountManager(undefined, storage),
		disk = structuredClone(storage);
	disk.accounts[0]!.authInvalidatedAt = 1500;
	disk.accounts[0]!.authInvalidationErrorCode = "token_revoked";
	expect(syncNativeAccountCredentials(manager, disk)).toBe(true);
	expect(manager.getAccountByIndex(0)!.authInvalidatedAt).toBe(1500);
});

it("matches preferences by account identity and workspace ID despite reordered lists",()=>{
 const storage=fixture();
 Object.assign(storage.accounts[0]!,{workspaces:[{id:"business",enabled:true},{id:"personal",enabled:false}],currentWorkspaceIndex:0});
 storage.accounts.push({...structuredClone(storage.accounts[0]!),email:"b@example.test"});
 const manager=new AccountManager(undefined,storage), disk=structuredClone(storage);
 disk.accounts[0]!.workspaces!.reverse();
 disk.accounts[0]!.currentWorkspaceIndex=0; // Personal moved to index 0 on disk.
 disk.accounts.reverse();
 expect(syncNativeAccountCredentials(manager,disk)).toBe(true);
 expect(manager.getAccountByIndex(0)?.currentWorkspaceIndex).toBe(0);
 expect(manager.getAccountByIndex(0)?.workspaces?.[0]?.id).toBe("personal");
 expect(manager.getAccountByIndex(0)?.workspaces?.[0]?.enabled).toBe(false);
 expect(manager.getAccountByIndex(1)?.currentWorkspaceIndex).toBe(0);
});

describe("native account identity", () => {
	it("matches a stored email that differs only in case and leaves the account alone", () => {
		const storage = fixture();
		storage.accounts[0]!.email = "A@Example.test";
		const manager = new AccountManager(undefined, storage);
		expect(syncNativeAccountCredentials(manager, structuredClone(storage))).toBe(false);
		expect(manager.getAccountByIndex(0)?.enabled).not.toBe(false);
	});
});

describe("identity-less native accounts", () => {
	it("does not bind two accounts without accountId or email to the same disk row", () => {
		const row = (n: number) => ({ refreshToken: `refresh-${n}`, accessToken: `access-${n}`, expiresAt: 2000, addedAt: n, lastUsed: n });
		const storage: AccountStorageV3 = { version: 3, activeIndex: 0, accounts: [row(1), row(2)] };
		const manager = new AccountManager(undefined, structuredClone(storage));
		const disk = structuredClone(storage);
		disk.accounts.reverse();
		disk.accounts[0]!.accessToken = "rotated-2";
		disk.accounts[1]!.accessToken = "rotated-1";
		syncNativeAccountCredentials(manager, disk);
		const byRefresh = new Map(manager.getAccountsSnapshot().map((a) => [a.refreshToken, a]));
		expect(byRefresh.get("refresh-1")?.access).toBe("rotated-1");
		expect(byRefresh.get("refresh-2")?.access).toBe("rotated-2");
		expect(manager.getAccountsSnapshot().every((a) => a.enabled !== false)).toBe(true);
	});
});
