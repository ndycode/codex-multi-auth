import {
	readAffinityGenerationFromDisk,
	type AccountStorageV3,
} from "../../storage.js";
import { saveAccountsWithRetry } from "../forecast-report-shared.js";

type LoadedStorage = AccountStorageV3 | null;

export interface UnpinCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<LoadedStorage>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	getStoragePath?: () => string;
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
	// Re-read the on-disk affinityGeneration just before saving so concurrent
	// CLI processes don't lose increments via lost-update on the load+mutate
	// pair. The save itself is serialized by withStorageLock, but the load
	// happens earlier and another process may have bumped the counter in the
	// meantime. Math.max keeps the counter monotonically increasing — extra
	// bumps are harmless (just an additional affinity invalidation), but a
	// missed bump can let the proxy cling to the wrong account.
	const diskGeneration = deps.getStoragePath
		? readAffinityGenerationFromDisk(deps.getStoragePath())
		: 0;
	const inMemoryGeneration = storage.affinityGeneration ?? 0;
	storage.affinityGeneration =
		Math.max(inMemoryGeneration, diskGeneration) + 1;
	await saveAccountsWithRetry(storage, deps.saveAccounts);

	logInfo(
		`Cleared manual pin (was account ${previousPin + 1}). Runtime routing will resume hybrid rotation.`,
	);
	return 0;
}
