import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { runWorkspaceCommand } from "../lib/codex-manager/commands/workspace.js";
import {
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	withAccountStorageTransaction,
	type AccountStorageV3,
} from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "workspace-policy-merge-"));
	setStoragePathDirect(join(directory, "accounts.json"));
	await saveAccounts({
		version: 3,
		activeIndex: 0,
		accounts: [{
			recordId: "workspace-policy-fixture",
			accountId: "workspace-selected",
			refreshToken: "workspace-policy-fixture-token",
			addedAt: 1,
			lastUsed: 1,
			workspaces: [
				{ id: "workspace-selected", enabled: true },
				{ id: "workspace-sibling", enabled: true },
			],
			currentWorkspaceIndex: 0,
		}],
	});
});

afterEach(async () => {
	setStoragePathDirect(null);
	await removeWithRetry(directory, { recursive: true, force: true });
});

async function setWorkspaceEnabled(storage: AccountStorageV3, enabled: boolean) {
	expect(await runWorkspaceCommand(["1", "1", enabled ? "enable" : "disable"], {
		setStoragePath: () => {},
		loadAccounts: async () => storage,
		saveAccounts,
		withAccountStorageTransaction,
		logError: vi.fn(),
		logInfo: vi.fn(),
	})).toBe(0);
}

it.each(["operator-first", "runtime-first"])(
	"preserves an operator exclusion across a concurrent runtime disable (%s)",
	async (order) => {
		const operator = (await loadAccounts())!;
		const runtime = (await loadAccounts())!;
		Object.assign(runtime.accounts[0]!.workspaces![0]!, { enabled: false, disabledAt: 10 });

		if (order === "operator-first") {
			await setWorkspaceEnabled(operator, false);
			await saveAccounts(runtime);
		} else {
			await saveAccounts(runtime);
			await setWorkspaceEnabled(operator, false);
		}

		const merged = (await loadAccounts())!;
		expect(merged.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: false });
		expect(merged.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);

		const toggled = new AccountManager(undefined, merged);
		toggled.setAccountEnabled(0, false);
		toggled.setAccountEnabled(0, true);
		await toggled.saveToDisk();
		const afterToggle = (await loadAccounts())!;
		expect(afterToggle.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: false });
		expect(afterToggle.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);

		await setWorkspaceEnabled(afterToggle, true);
		const enabled = (await loadAccounts())!;
		expect(enabled.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: true });
		expect(enabled.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);
	},
);

it.each([false, true])(
	"applies an explicit enable to fresh storage after an already-enabled snapshot (reordered: %s)",
	async (reordered) => {
		const operator = (await loadAccounts())!;
		const runtime = (await loadAccounts())!;
		const account = runtime.accounts[0]!;
		Object.assign(account.workspaces![0]!, { enabled: false, disabledAt: 10 });
		account.accountLabel = "Concurrent label edit";
		account.refreshToken = "concurrent-rotated-fixture-token";
		if (reordered) {
			account.workspaces!.reverse();
			account.currentWorkspaceIndex = 1;
		}
		const logInfo = vi.fn();
		const deps = {
			setStoragePath: () => {},
			loadAccounts: async () => {
				await saveAccounts(runtime);
				return operator;
			},
			saveAccounts,
			withAccountStorageTransaction,
			logError: vi.fn(),
			logInfo,
		};
		expect(await runWorkspaceCommand(["1", "1", "enable"], deps)).toBe(0);
		const saved = (await loadAccounts())!;
		const savedAccount = saved.accounts[0]!;
		expect(savedAccount.workspaces!.find(workspace => workspace.id === "workspace-selected"))
			.toEqual({ id: "workspace-selected", enabled: true });
		expect(savedAccount.workspaces!.find(workspace => workspace.id === "workspace-sibling"))
			.toEqual({ id: "workspace-sibling", enabled: true });
		expect(savedAccount.workspaces![savedAccount.currentWorkspaceIndex ?? 0]!.id)
			.toBe("workspace-selected");
		expect(savedAccount.accountLabel).toBe("Concurrent label edit");
		expect(savedAccount.refreshToken).toBe("concurrent-rotated-fixture-token");
		expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("enabled. Selected workspace unchanged."));
	},
);

it("keeps the latest selection and enables only the requested record", async () => {
	const initial = (await loadAccounts())!;
	initial.accounts.push({
		recordId: "other-workspace-fixture",
		accountId: "other-account",
		refreshToken: "other-workspace-fixture-token",
		addedAt: 2,
		lastUsed: 2,
		workspaces: [{ id: "other-workspace", enabled: false }],
	});
	await saveAccounts(initial);
	const operator = (await loadAccounts())!;
	const concurrent = (await loadAccounts())!;
	const targetAccount = concurrent.accounts[0]!;
	Object.assign(targetAccount.workspaces![0]!, { enabled: false, disabledAt: 10 });
	targetAccount.currentWorkspaceIndex = 1;
	const deps = {
		setStoragePath: () => {},
		loadAccounts: async () => {
			await saveAccounts(concurrent);
			return operator;
		},
		saveAccounts,
		withAccountStorageTransaction,
		logError: vi.fn(),
		logInfo: vi.fn(),
	};
	expect(await runWorkspaceCommand(["1", "1", "enable"], deps)).toBe(0);
	const saved = (await loadAccounts())!;
	expect(saved.accounts[1]!.workspaces![0]!.enabled).toBe(false);
	expect(saved.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: true });
	expect(saved.accounts[0]!.currentWorkspaceIndex).toBe(1);
});

it.each(["account", "workspace", "replacement"])(
	"does not report a successful enable when the selected %s was removed concurrently",
	async (removed) => {
		const operator = (await loadAccounts())!;
		const concurrent = (await loadAccounts())!;
		if (removed === "replacement") {
			concurrent.accounts[0] = {
				recordId: "replacement-fixture",
				accountId: "replacement-account",
				refreshToken: "replacement-fixture-token",
				addedAt: 2,
				lastUsed: 2,
				workspaces: [{ id: "replacement-workspace", enabled: false }],
			};
		} else if (removed === "account") concurrent.accounts = [];
		else {
			concurrent.accounts[0]!.workspaces!.splice(0, 1);
			concurrent.accounts[0]!.currentWorkspaceIndex = 0;
		}
		const logInfo = vi.fn();
		const logError = vi.fn();
		const deps = {
			setStoragePath: () => {},
			loadAccounts: async () => {
				await saveAccounts(concurrent);
				return operator;
			},
			saveAccounts,
			withAccountStorageTransaction,
			logError,
			logInfo,
		};
		expect(await runWorkspaceCommand(["1", "1", "enable"], deps)).toBe(1);
		expect(logInfo).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalledWith(expect.stringContaining("changed concurrently"));
		const saved = (await loadAccounts())!;
		expect(saved.accounts.flatMap(account => account.workspaces ?? [])
			.some(workspace => workspace.id === "workspace-selected")).toBe(false);
	},
);

it.each(["operator-first", "runtime-first"])(
	"preserves an explicit re-enable across a concurrent runtime health update (%s)",
	async (order) => {
		const initial = (await loadAccounts())!;
		Object.assign(initial.accounts[0]!.workspaces![0]!, { enabled: false, disabledAt: 10 });
		await saveAccounts(initial);
		const operator = (await loadAccounts())!;
		const runtime = (await loadAccounts())!;
		runtime.accounts[0]!.workspaces![0]!.disabledAt = 20;
		if (order === "operator-first") {
			await setWorkspaceEnabled(operator, true);
			await saveAccounts(runtime);
		} else {
			await saveAccounts(runtime);
			await setWorkspaceEnabled(operator, true);
		}
		const merged = (await loadAccounts())!;
		expect(merged.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: true });
		expect(merged.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);
	},
);
