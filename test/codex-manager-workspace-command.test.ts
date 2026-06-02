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
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		saveAccounts: vi.fn(async () => {}),
		logError: vi.fn(),
		logInfo: vi.fn(),
		...overrides,
	};
}

describe("runWorkspaceCommand", () => {
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
