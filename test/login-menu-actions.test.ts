import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { promptLoginMode } from "../lib/cli.js";
import { UI_COPY } from "../lib/ui/ui-copy.js";
import type {
	AccountMetadataV3,
	AccountStorageV3,
	NamedBackupSummary,
} from "../lib/storage.js";

const {
	withAccountStorageTransactionMock,
	runSwitchCommandMock,
	runOAuthFlowMock,
	resolveAccountSelectionMock,
	persistAccountPoolMock,
	syncSelectionToCodexMock,
	persistAndSyncSelectedAccountMock,
	selectMock,
} = vi.hoisted(() => ({
	withAccountStorageTransactionMock: vi.fn(),
	runSwitchCommandMock: vi.fn(),
	runOAuthFlowMock: vi.fn(),
	resolveAccountSelectionMock: vi.fn(),
	persistAccountPoolMock: vi.fn(),
	syncSelectionToCodexMock: vi.fn(),
	persistAndSyncSelectedAccountMock: vi.fn(),
	selectMock: vi.fn(),
}));

// Keep the real findMatchingAccountIndex (the identity matching under test)
// and only fake the transaction wrapper so each test controls the storage
// the handler reloads and captures what it persists.
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

vi.mock("../lib/codex-manager/commands/switch.js", () => ({
	runSwitchCommand: runSwitchCommandMock,
}));

vi.mock("../lib/codex-manager/login-oauth.js", () => ({
	runOAuthFlow: runOAuthFlowMock,
	resolveAccountSelection: resolveAccountSelectionMock,
	persistAccountPool: persistAccountPoolMock,
	syncSelectionToCodex: syncSelectionToCodexMock,
}));

vi.mock("../lib/codex-manager/persist-selected-account.js", () => ({
	persistAndSyncSelectedAccount: persistAndSyncSelectedAccountMock,
}));

// The sign-in mode prompt lives in the module under test, so its cancel and
// manual branches are reached by flipping TTY on and stubbing the UI select.
vi.mock("../lib/ui/select.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/ui/select.js")>();
	return { ...actual, select: selectMock };
});

const {
	handleManageAction,
	promptBackupRestoreMode,
	promptManualBackupSelection,
	promptOAuthSignInMode,
} = await import("../lib/codex-manager/login-menu-actions.js");

type MenuResult = Awaited<ReturnType<typeof promptLoginMode>>;
type TransactionPersist = (storage: AccountStorageV3) => Promise<void>;
type TransactionHandler = (
	current: AccountStorageV3 | null,
	persist: TransactionPersist,
) => Promise<void>;

const NOW = 1_700_000_000_000;

function account(id: string): AccountMetadataV3 {
	return {
		email: `${id}@example.com`,
		accountId: `acc_${id}`,
		refreshToken: `refresh-${id}`,
		accessToken: `access-${id}`,
		expiresAt: NOW + 3_600_000,
		addedAt: NOW - 60_000,
		lastUsed: NOW - 60_000,
	};
}

function storageWith(
	accounts: AccountMetadataV3[],
	activeIndex = 0,
	activeIndexByFamily: Record<string, number> = {},
): AccountStorageV3 {
	return { version: 3, activeIndex, activeIndexByFamily, accounts };
}

function backup(fileName: string): NamedBackupSummary {
	return { path: `/backups/${fileName}`, fileName, accountCount: 2, mtimeMs: NOW };
}

// Storage the fake transaction hands to the handler as the freshly loaded
// state, and the storages the handler persisted, in order.
let loadedStorage: AccountStorageV3 | null = null;
let persisted: AccountStorageV3[] = [];

const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	loadedStorage = null;
	persisted = [];
	withAccountStorageTransactionMock.mockImplementation(
		async (handler: TransactionHandler) =>
			handler(loadedStorage, async (storage) => {
				persisted.push(structuredClone(storage));
			}),
	);
	// Force the non-interactive prompt fallbacks regardless of the runner.
	process.stdin.isTTY = false;
	process.stdout.isTTY = false;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	process.stdin.isTTY = originalStdinIsTTY;
	process.stdout.isTTY = originalStdoutIsTTY;
	logSpy.mockRestore();
	errorSpy.mockRestore();
});

describe("non-TTY prompt fallbacks", () => {
	it("defaults sign-in to the browser flow", async () => {
		expect(await promptOAuthSignInMode(backup("codex-backup-1.json"))).toBe(
			"browser",
		);
	});

	it("restores the latest backup without prompting", async () => {
		expect(await promptBackupRestoreMode(backup("codex-backup-1.json"))).toBe(
			"latest",
		);
	});

	it("picks the first manual backup, or null when none exist", async () => {
		const first = backup("codex-backup-1.json");
		expect(
			await promptManualBackupSelection([first, backup("codex-backup-2.json")]),
		).toBe(first);
		expect(await promptManualBackupSelection([])).toBeNull();
	});
});

describe("handleManageAction switch", () => {
	it("delegates to runSwitchCommand with a 1-based index and storage deps", async () => {
		const storage = storageWith([account("a"), account("b")]);
		const menuResult: MenuResult = { mode: "manage", switchAccountIndex: 1 };

		await handleManageAction(storage, menuResult);

		expect(runSwitchCommandMock).toHaveBeenCalledTimes(1);
		expect(runSwitchCommandMock).toHaveBeenCalledWith(
			["2"],
			expect.objectContaining({
				setStoragePath: expect.any(Function),
				loadAccounts: expect.any(Function),
				persistAndSyncSelectedAccount: persistAndSyncSelectedAccountMock,
			}),
		);
		expect(withAccountStorageTransactionMock).not.toHaveBeenCalled();
	});
});

describe("handleManageAction delete", () => {
	it("deletes inside the transaction and rebalances every selection index", async () => {
		const storage = storageWith(
			[account("a"), account("b"), account("c")],
			2,
			{ "gpt-5-codex": 0, codex: 2 },
		);
		loadedStorage = structuredClone(storage);

		await handleManageAction(storage, {
			mode: "manage",
			deleteAccountIndex: 0,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(1);
		const saved = persisted[0];
		expect(saved.accounts.map((entry) => entry.accountId)).toEqual([
			"acc_b",
			"acc_c",
		]);
		// Indexes after the removed row shift left; indexes pointing at the
		// removed row clamp in place.
		expect(saved.activeIndex).toBe(1);
		expect(saved.activeIndexByFamily["gpt-5-codex"]).toBe(0);
		expect(saved.activeIndexByFamily.codex).toBe(1);
		// Families without an explicit entry inherit the adjusted activeIndex.
		expect(saved.activeIndexByFamily["gpt-5.1"]).toBe(1);

		// The in-memory menu storage is synced to what was persisted.
		expect(storage.accounts.map((entry) => entry.accountId)).toEqual([
			"acc_b",
			"acc_c",
		]);
		expect(storage.activeIndex).toBe(1);
		expect(logSpy).toHaveBeenCalledWith("Deleted account 1.");
	});

	it("re-resolves the account by identity when on-disk storage was reordered", async () => {
		// The menu showed [a, b] and the user deleted row 1 (account a), but a
		// concurrent writer reordered storage to [x, a]: account a must be
		// deleted at its new position, not whatever now sits at index 0.
		const storage = storageWith([account("a"), account("b")]);
		loadedStorage = storageWith([account("x"), account("a")]);

		await handleManageAction(storage, {
			mode: "manage",
			deleteAccountIndex: 0,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(1);
		expect(persisted[0].accounts.map((entry) => entry.accountId)).toEqual([
			"acc_x",
		]);
	});

	it("becomes a no-op when the account vanished from storage", async () => {
		const storage = storageWith([account("a"), account("b")]);
		loadedStorage = storageWith([account("x")]);

		await handleManageAction(storage, {
			mode: "manage",
			deleteAccountIndex: 0,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(0);
		// The menu storage is left untouched and nothing is reported deleted.
		expect(storage.accounts.map((entry) => entry.accountId)).toEqual([
			"acc_a",
			"acc_b",
		]);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("resets all selection indexes when the last account is deleted", async () => {
		const storage = storageWith([account("a")], 0, { codex: 0 });
		loadedStorage = structuredClone(storage);

		await handleManageAction(storage, {
			mode: "manage",
			deleteAccountIndex: 0,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(1);
		const saved = persisted[0];
		expect(saved.accounts).toEqual([]);
		expect(saved.activeIndex).toBe(0);
		expect(saved.activeIndexByFamily["gpt-5-codex"]).toBe(0);
		expect(saved.activeIndexByFamily.codex).toBe(0);
	});
});

describe("handleManageAction toggle", () => {
	it("disables an enabled account and reports the new state", async () => {
		const storage = storageWith([account("a"), account("b")]);
		loadedStorage = structuredClone(storage);

		await handleManageAction(storage, {
			mode: "manage",
			toggleAccountIndex: 1,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(1);
		expect(persisted[0].accounts[1].enabled).toBe(false);
		expect(storage.accounts[1].enabled).toBe(false);
		expect(logSpy).toHaveBeenCalledWith("Disabled account 2.");
	});

	it("re-enables a disabled account", async () => {
		const disabled = { ...account("a"), enabled: false };
		const storage = storageWith([disabled]);
		loadedStorage = structuredClone(storage);

		await handleManageAction(storage, {
			mode: "manage",
			toggleAccountIndex: 0,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(1);
		expect(persisted[0].accounts[0].enabled).toBe(true);
		expect(logSpy).toHaveBeenCalledWith("Enabled account 1.");
	});

	it("re-resolves the account by identity when on-disk storage was reordered", async () => {
		// The menu showed [a, b] and the user toggled row 1 (account a), but a
		// concurrent writer reordered storage to [x, a]: account a must be
		// toggled at its new position, not whatever now sits at index 0.
		const storage = storageWith([account("a"), account("b")]);
		loadedStorage = storageWith([account("x"), account("a")]);

		await handleManageAction(storage, {
			mode: "manage",
			toggleAccountIndex: 0,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(1);
		expect(persisted[0].accounts[1]).toMatchObject({
			accountId: "acc_a",
			enabled: false,
		});
		expect(persisted[0].accounts[0].enabled).toBeUndefined();
		expect(logSpy).toHaveBeenCalledWith("Disabled account 1.");
	});

	it("becomes a no-op when the account vanished from storage", async () => {
		const storage = storageWith([account("a")]);
		loadedStorage = storageWith([]);

		await handleManageAction(storage, {
			mode: "manage",
			toggleAccountIndex: 0,
		} satisfies MenuResult);

		expect(persisted).toHaveLength(0);
		// The in-memory menu storage is left untouched too.
		expect(storage.accounts.map((entry) => entry.accountId)).toEqual(["acc_a"]);
		expect(storage.accounts[0].enabled).toBeUndefined();
		expect(logSpy).not.toHaveBeenCalled();
	});
});

describe("handleManageAction refresh", () => {
	it("runs the OAuth flow and persists the resolved selection on success", async () => {
		const storage = storageWith([account("a")]);
		const tokenResult = { type: "success" as const };
		const resolved = { type: "success" as const, accountIdOverride: "acc_a" };
		runOAuthFlowMock.mockResolvedValue(tokenResult);
		resolveAccountSelectionMock.mockReturnValue(resolved);
		persistAccountPoolMock.mockResolvedValue(undefined);
		syncSelectionToCodexMock.mockResolvedValue(undefined);

		await handleManageAction(storage, {
			mode: "manage",
			refreshAccountIndex: 0,
		} satisfies MenuResult);

		// Non-TTY sign-in mode resolves to "browser" without prompting.
		expect(runOAuthFlowMock).toHaveBeenCalledWith(true, "browser");
		expect(resolveAccountSelectionMock).toHaveBeenCalledWith(tokenResult);
		expect(persistAccountPoolMock).toHaveBeenCalledWith([resolved], false);
		expect(syncSelectionToCodexMock).toHaveBeenCalledWith(resolved);
		expect(logSpy).toHaveBeenCalledWith("Refreshed account 1.");
	});

	it("reports a failed OAuth flow without persisting anything", async () => {
		const storage = storageWith([account("a")]);
		runOAuthFlowMock.mockResolvedValue({
			type: "failed",
			message: "browser exploded",
		});

		await handleManageAction(storage, {
			mode: "manage",
			refreshAccountIndex: 0,
		} satisfies MenuResult);

		expect(errorSpy).toHaveBeenCalledWith("Refresh failed: browser exploded");
		expect(persistAccountPoolMock).not.toHaveBeenCalled();
		expect(syncSelectionToCodexMock).not.toHaveBeenCalled();
	});

	it("ignores a refresh request for an index that no longer exists", async () => {
		const storage = storageWith([account("a")]);

		await handleManageAction(storage, {
			mode: "manage",
			refreshAccountIndex: 5,
		} satisfies MenuResult);

		expect(runOAuthFlowMock).not.toHaveBeenCalled();
	});

	it("returns to the menu when the sign-in mode prompt is cancelled", async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		selectMock.mockResolvedValue("cancel");
		const storage = storageWith([account("a")]);

		await handleManageAction(storage, {
			mode: "manage",
			refreshAccountIndex: 0,
		} satisfies MenuResult);

		expect(runOAuthFlowMock).not.toHaveBeenCalled();
		expect(String(logSpy.mock.calls[0]?.[0])).toContain(
			UI_COPY.oauth.cancelledBackToMenu,
		);
	});

	it("runs the OAuth flow in manual mode when the prompt selects it", async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		selectMock.mockResolvedValue("manual");
		const storage = storageWith([account("a")]);
		const resolved = { type: "success" as const, accountIdOverride: "acc_a" };
		runOAuthFlowMock.mockResolvedValue({ type: "success" });
		resolveAccountSelectionMock.mockReturnValue(resolved);
		persistAccountPoolMock.mockResolvedValue(undefined);
		syncSelectionToCodexMock.mockResolvedValue(undefined);

		await handleManageAction(storage, {
			mode: "manage",
			refreshAccountIndex: 0,
		} satisfies MenuResult);

		expect(runOAuthFlowMock).toHaveBeenCalledWith(true, "manual");
		expect(syncSelectionToCodexMock).toHaveBeenCalledWith(resolved);
	});

	it("bails out silently on a non-transport prompt selection", async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		selectMock.mockResolvedValue("restore-backup");
		const storage = storageWith([account("a")]);

		await handleManageAction(storage, {
			mode: "manage",
			refreshAccountIndex: 0,
		} satisfies MenuResult);

		expect(runOAuthFlowMock).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});
});
