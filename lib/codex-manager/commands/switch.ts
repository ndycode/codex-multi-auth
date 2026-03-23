import { formatAccountLabel } from "../../accounts.js";
import type { AccountStorageV3 } from "../../storage.js";

type LoadedStorage = AccountStorageV3 | null;

type PersistAndSyncSelectedAccount = (params: {
	storage: AccountStorageV3;
	targetIndex: number;
	parsed: number;
	switchReason: "rotation" | "best" | "restore";
}) => Promise<{ synced: boolean; wasDisabled: boolean }>;

export interface SwitchCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<LoadedStorage>;
	persistAndSyncSelectedAccount: PersistAndSyncSelectedAccount;
	logError?: (message: string) => void;
	logWarn?: (message: string) => void;
	logInfo?: (message: string) => void;
}

export async function runSwitchCommand(
	args: string[],
	deps: SwitchCommandDeps,
): Promise<number> {
	deps.setStoragePath(null);
	const indexArg = args[0];
	if (!indexArg) {
		(deps.logError ?? console.error)(
			"Missing index. Usage: codex auth switch <index>",
		);
		return 1;
	}

	const parsed = Number.parseInt(indexArg, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		(deps.logError ?? console.error)(`Invalid index: ${indexArg}`);
		return 1;
	}

	const targetIndex = parsed - 1;
	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		(deps.logError ?? console.error)("No accounts configured.");
		return 1;
	}

	if (targetIndex < 0 || targetIndex >= storage.accounts.length) {
		(deps.logError ?? console.error)(
			`Index out of range. Valid range: 1-${storage.accounts.length}`,
		);
		return 1;
	}

	const account = storage.accounts[targetIndex];
	if (!account) {
		(deps.logError ?? console.error)(`Account ${parsed} not found.`);
		return 1;
	}

	const { synced, wasDisabled } = await deps.persistAndSyncSelectedAccount({
		storage,
		targetIndex,
		parsed,
		switchReason: "rotation",
	});

	if (!synced) {
		(deps.logWarn ?? console.warn)(
			`Switched account ${parsed} locally, but Codex auth sync did not complete. Multi-auth routing will still use this account.`,
		);
	}

	(deps.logInfo ?? console.log)(
		`Switched to account ${parsed}: ${formatAccountLabel(account, targetIndex)}${wasDisabled ? " (re-enabled)" : ""}`,
	);
	return 0;
}
