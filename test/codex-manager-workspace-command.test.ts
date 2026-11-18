import { describe, expect, it, vi } from "vitest";
import {
	runWorkspaceCommand,
	type WorkspaceCommandDeps,
} from "../lib/codex-manager/commands/workspace.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "user@gmail.com",
				refreshToken: "refresh-token-1",
				addedAt: 1,
				lastUsed: 1,
				accountId: "org-AAAA",
				workspaces: [
					{ id: "org-AAAA", name: "Personal Plus", enabled: true },
					{ id: "org-BBBB", name: "GkTech Business", enabled: true },
				],
				currentWorkspaceIndex: 0,
			},
			{
				email: "solo@example.com",
				refreshToken: "refresh-token-2",
				addedAt: 2,
				lastUsed: 2,
			},
		],
	};
}

function createDeps(
	overrides: Partial<WorkspaceCommandDeps> = {},
): WorkspaceCommandDeps {
	const deps: WorkspaceCommandDeps = {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		saveAccounts: vi.fn(async () => {}),
		withAccountStorageTransaction: async handler => handler(await deps.loadAccounts(), deps.saveAccounts),
		logError: vi.fn(),
		logInfo: vi.fn(),
		...overrides,
	};
	return deps;
}

describe("runWorkspaceCommand", () => {
 it("follows the account identity when the fresh transaction changes account ordering", async () => {
  const selected=createStorage();const fresh=createStorage();fresh.accounts.reverse();
  fresh.accounts[1]!.workspaces![0]!.enabled=false;
  const deps=createDeps({loadAccounts:async()=>selected,
   withAccountStorageTransaction:async handler=>handler(fresh,async()=>{})});
  expect(await runWorkspaceCommand(["1","1","enable"],deps)).toBe(0);
  expect(fresh.accounts[0]!.email).toBe("solo@example.com");
  expect(fresh.accounts[0]!.workspaces).toBeUndefined();
  expect(fresh.accounts[1]!.workspaces![0]!.enabled).toBe(true);
 });
 it("rejects ambiguous account identities instead of updating either row", async () => {
  const selected=createStorage();const fresh=createStorage();
  fresh.accounts.push(structuredClone(fresh.accounts[0]!));
  const persist=vi.fn(async()=>{});
  const deps=createDeps({loadAccounts:async()=>selected,
   withAccountStorageTransaction:async handler=>handler(fresh,persist)});
  expect(await runWorkspaceCommand(["1","1","disable"],deps)).toBe(1);
  expect(persist).not.toHaveBeenCalled();
  expect(fresh.accounts[0]!.workspaces![0]!.enabled).toBe(true);
  expect(fresh.accounts[2]!.workspaces![0]!.enabled).toBe(true);
 });
 it("disables the selected workspace without switching to a sibling", async () => {
  const storage=createStorage(); const deps=createDeps({loadAccounts:async()=>storage});
  expect(await runWorkspaceCommand(["1","1","disable"],deps)).toBe(0);
  expect(storage.accounts[0]?.workspaces?.[0]?.enabled).toBe(false);
  expect(storage.accounts[0]?.currentWorkspaceIndex).toBe(0);
  expect(deps.saveAccounts).toHaveBeenCalled();
 });
 it("enables a workspace without changing selection", async () => {
  const storage=createStorage(); storage.accounts[0]!.workspaces![1]!.enabled=false;
  const deps=createDeps({loadAccounts:async()=>storage});
  expect(await runWorkspaceCommand(["1","2","enable"],deps)).toBe(0);
  expect(storage.accounts[0]?.workspaces?.[1]?.enabled).toBe(true);
  expect(storage.accounts[0]?.currentWorkspaceIndex).toBe(0);
 });
 it("rejects an unknown workspace action without saving", async () => {
  const deps=createDeps();
  expect(await runWorkspaceCommand(["1","2","typo"],deps)).toBe(1);
  expect(deps.saveAccounts).not.toHaveBeenCalled();
 });

	it("errors when no accounts are configured", async () => {
		const deps = createDeps({ loadAccounts: vi.fn(async () => null) });
		const result = await runWorkspaceCommand(["1"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("No accounts configured.");
	});

	it("errors when the account index is missing", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand([], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Missing account index. Usage: codex-multi-auth workspace <account> [workspace]",
		);
	});

	it("errors when the account index is out of range", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["5"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Account index out of range. Valid range: 1-2",
		);
	});

	it("errors when the account index is non-numeric", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["abc"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Invalid account index (must be a positive integer): abc");
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("rejects a fractional account index instead of truncating it", async () => {
		// "1.9" must NOT be silently parsed as account 1 (parseInt truncation).
		const deps = createDeps();
		const result = await runWorkspaceCommand(["1.9"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Invalid account index (must be a positive integer): 1.9");
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("rejects an account index with trailing garbage instead of truncating it", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["2abc", "1"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Invalid account index (must be a positive integer): 2abc");
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("rejects a fractional workspace index instead of truncating it", async () => {
		// "2.9" must NOT be silently parsed as workspace 2.
		const deps = createDeps();
		const result = await runWorkspaceCommand(["1", "2.9"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Invalid workspace index (must be a positive integer). Valid range: 1-2",
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("lists workspaces with the active one marked when no workspace arg", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["1"], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"  * 1. [Personal Plus] id:g-AAAA (active)",
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"  - 2. [GkTech Business] id:g-BBBB",
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("reports when an account has no tracked workspaces", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["2"], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("has no tracked workspaces"),
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("switches the active workspace and persists it", async () => {
		let saved: AccountStorageV3 | undefined;
		const deps = createDeps({
			saveAccounts: vi.fn(async (storage: AccountStorageV3) => {
				saved = storage;
			}),
		});
		const result = await runWorkspaceCommand(["1", "2"], deps);
		expect(result).toBe(0);
		expect(saved?.accounts[0]?.currentWorkspaceIndex).toBe(1);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"Account 1 now using workspace 2: [GkTech Business] (id:g-BBBB).",
		);
	});

	it("rejects an out-of-range workspace index", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["1", "9"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Invalid workspace index. Valid range: 1-2",
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric workspace index", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["1", "xyz"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Invalid workspace index (must be a positive integer). Valid range: 1-2",
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("refuses to select a disabled workspace", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () => {
				const storage = createStorage();
				const workspace = storage.accounts[0]?.workspaces?.[1];
				if (workspace) workspace.enabled = false;
				return storage;
			}),
		});
		const result = await runWorkspaceCommand(["1", "2"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Workspace 2 ([GkTech Business]) is disabled and cannot be selected.",
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});

	it("is a no-op when the workspace is already active", async () => {
		const deps = createDeps();
		const result = await runWorkspaceCommand(["1", "1"], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"Account 1 is already using workspace 1: [Personal Plus].",
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
	});
});

it('persists a disabled selection and preserves it through account re-enablement',async()=>{
 const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {removeWithRetry}=await import('./helpers/remove-with-retry.js');
 const storageApi=await import('../lib/storage.js');const {AccountManager}=await import('../lib/accounts.js');
 const dir=await mkdtemp(join(tmpdir(),'workspace-disable-'));
 storageApi.setStoragePathDirect(join(dir,'accounts.json'));
 try{
  await storageApi.saveAccounts(createStorage());
  const deps=createDeps({setStoragePath:()=>{},loadAccounts:storageApi.loadAccounts,saveAccounts:storageApi.saveAccounts,withAccountStorageTransaction:storageApi.withAccountStorageTransaction});
  expect(await runWorkspaceCommand(['1','1','disable'],deps)).toBe(0);
  const saved=(await storageApi.loadAccounts())!;
  expect(saved.accounts[0]?.currentWorkspaceIndex??0).toBe(0);
  expect(saved.accounts[0]?.workspaces?.[0]?.enabled).toBe(false);
  const manager=new AccountManager(undefined,saved);manager.setAccountEnabled(0,false);manager.setAccountEnabled(0,true);
  expect(manager.getAccountByIndex(0)?.workspaces?.[0]?.enabled).toBe(false);
  expect(manager.getAccountByIndex(0)?.currentWorkspaceIndex??0).toBe(0);
 }finally{storageApi.setStoragePathDirect(null);await removeWithRetry(dir,{recursive:true,force:true});}
});
it('does not re-enable an operator-disabled workspace when its account is toggled',async()=>{
 const storage=createStorage();const deps=createDeps({loadAccounts:async()=>storage});
 expect(await runWorkspaceCommand(['1','1','disable'],deps)).toBe(0);
 const {AccountManager}=await import('../lib/accounts.js');const manager=new AccountManager(undefined,storage);
 manager.setAccountEnabled(0,false);manager.setAccountEnabled(0,true);
 expect(manager.getAccountByIndex(0)?.workspaces?.[0]?.enabled).toBe(false);
});
