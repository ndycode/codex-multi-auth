import type { AccountStorageV3 } from "../../storage.js";

type LoadedStorage = AccountStorageV3 | null;

export interface UnpinCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<LoadedStorage>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	logError?: (message: string) => void;
	logInfo?: (message: string) => void;
}

export async function runUnpinCommand(
	deps: UnpinCommandDeps,
): Promise<number> {
	deps.setStoragePath(null);
	const logError = deps.logError ?? console.error;
	const logInfo = deps.logInfo ?? console.log;

	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		logError("No accounts configured.");
		return 1;
	}

	if (storage.pinnedAccountIndex === undefined) {
		logInfo("No pin to clear.");
		return 0;
	}

	const previousPin = storage.pinnedAccountIndex;
	delete storage.pinnedAccountIndex;
	await deps.saveAccounts(storage);

	logInfo(
		`Cleared manual pin (was account ${previousPin + 1}). Runtime routing will resume hybrid rotation.`,
	);
	return 0;
}
