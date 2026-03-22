import { AsyncLocalStorage } from "node:async_hooks";
import type { AccountStorageV3, FlaggedAccountStorageV1 } from "../storage.js";

export type TransactionSnapshotState = {
	snapshot: AccountStorageV3 | null;
	storagePath: string;
	active: boolean;
};

let storageMutex: Promise<void> = Promise.resolve();
const transactionSnapshotContext =
	new AsyncLocalStorage<TransactionSnapshotState>();

export function getTransactionSnapshotState():
	| TransactionSnapshotState
	| undefined {
	return transactionSnapshotContext.getStore();
}

export function runInTransactionSnapshotContext<T>(
	state: TransactionSnapshotState,
	fn: () => Promise<T>,
): Promise<T> {
	return transactionSnapshotContext.run(state, fn);
}

export function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
	const previousMutex = storageMutex;
	let releaseLock: () => void;
	storageMutex = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	return previousMutex.then(fn).finally(() => releaseLock());
}

export async function withAccountStorageTransaction<T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (storage: AccountStorageV3) => Promise<void>,
	) => Promise<T>,
	deps: {
		getStoragePath: () => string;
		loadCurrent: () => Promise<AccountStorageV3 | null>;
		saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	},
): Promise<T> {
	return withStorageLock(async () => {
		const state: TransactionSnapshotState = {
			snapshot: await deps.loadCurrent(),
			storagePath: deps.getStoragePath(),
			active: true,
		};
		const current = state.snapshot;
		const persist = async (storage: AccountStorageV3): Promise<void> => {
			await deps.saveAccounts(storage);
			state.snapshot = storage;
		};
		return transactionSnapshotContext.run(state, () =>
			handler(current, persist),
		);
	});
}

export async function withAccountAndFlaggedStorageTransaction<T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (
			accountStorage: AccountStorageV3,
			flaggedStorage: FlaggedAccountStorageV1,
		) => Promise<void>,
	) => Promise<T>,
	deps: {
		getStoragePath: () => string;
		loadCurrent: () => Promise<AccountStorageV3 | null>;
		saveAccounts: (storage: AccountStorageV3) => Promise<void>;
		saveFlaggedAccounts: (storage: FlaggedAccountStorageV1) => Promise<void>;
		cloneAccountStorageForPersistence: (
			storage: AccountStorageV3 | null | undefined,
		) => AccountStorageV3;
		logRollbackError: (error: unknown, rollbackError: unknown) => void;
	},
): Promise<T> {
	return withStorageLock(async () => {
		const state: TransactionSnapshotState = {
			snapshot: await deps.loadCurrent(),
			storagePath: deps.getStoragePath(),
			active: true,
		};
		const current = state.snapshot;
		const persist = async (
			accountStorage: AccountStorageV3,
			flaggedStorage: FlaggedAccountStorageV1,
		): Promise<void> => {
			const previousAccounts = deps.cloneAccountStorageForPersistence(
				state.snapshot,
			);
			const nextAccounts =
				deps.cloneAccountStorageForPersistence(accountStorage);
			await deps.saveAccounts(nextAccounts);
			try {
				await deps.saveFlaggedAccounts(flaggedStorage);
				state.snapshot = nextAccounts;
			} catch (error) {
				try {
					await deps.saveAccounts(previousAccounts);
					state.snapshot = previousAccounts;
				} catch (rollbackError) {
					deps.logRollbackError(error, rollbackError);
					throw new AggregateError(
						[error, rollbackError],
						"Flagged save failed and account storage rollback also failed",
					);
				}
				throw error;
			}
		};
		return transactionSnapshotContext.run(state, () =>
			handler(current, persist),
		);
	});
}
