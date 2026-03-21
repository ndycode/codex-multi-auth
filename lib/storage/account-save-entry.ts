import type { AccountStorageV3 } from "../storage.js";

export async function saveAccountsEntry(params: {
	storage: AccountStorageV3;
	withStorageLock: <T>(fn: () => Promise<T>) => Promise<T>;
	saveUnlocked: (storage: AccountStorageV3) => Promise<void>;
}): Promise<void> {
	return params.withStorageLock(async () => {
		await params.saveUnlocked(params.storage);
	});
}
