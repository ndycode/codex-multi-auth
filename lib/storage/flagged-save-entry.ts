import type { FlaggedAccountStorageV1 } from "../storage.js";

export async function saveFlaggedAccountsEntry(params: {
	storage: FlaggedAccountStorageV1;
	withStorageLock: <T>(fn: () => Promise<T>) => Promise<T>;
	saveUnlocked: (storage: FlaggedAccountStorageV1) => Promise<void>;
}): Promise<void> {
	return params.withStorageLock(async () => {
		await params.saveUnlocked(params.storage);
	});
}
