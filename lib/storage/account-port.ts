import type { AccountStorageV3, FlaggedAccountStorageV1 } from "../storage.js";

export async function exportAccountsSnapshot(params: {
	resolvedPath: string;
	force: boolean;
	currentStoragePath: string;
	transactionState:
		| {
				active: boolean;
				storagePath: string;
				snapshot: AccountStorageV3 | null;
		  }
		| undefined;
	loadAccountsInternal: () => Promise<AccountStorageV3 | null>;
	readCurrentStorage: () => Promise<AccountStorageV3 | null>;
	exportAccountsToFile: (args: {
		resolvedPath: string;
		force: boolean;
		storage: AccountStorageV3 | null;
		beforeCommit?: (resolvedPath: string) => Promise<void> | void;
		logInfo: (message: string, details: Record<string, unknown>) => void;
	}) => Promise<void>;
	beforeCommit?: (resolvedPath: string) => Promise<void> | void;
	logInfo: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	const storage =
		params.transactionState?.active &&
		params.transactionState.storagePath === params.currentStoragePath
			? params.transactionState.snapshot
			: params.transactionState?.active
				? await params.loadAccountsInternal()
				: await params.readCurrentStorage();

	await params.exportAccountsToFile({
		resolvedPath: params.resolvedPath,
		force: params.force,
		storage,
		beforeCommit: params.beforeCommit,
		logInfo: params.logInfo,
	});
}

export async function importAccountsSnapshot(params: {
	resolvedPath: string;
	readImportFile: (args: {
		resolvedPath: string;
		normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null;
	}) => Promise<AccountStorageV3>;
	normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null;
	withAccountStorageTransaction: <T>(
		handler: (
			current: AccountStorageV3 | null,
			persist: (storage: AccountStorageV3) => Promise<void>,
		) => Promise<T>,
	) => Promise<T>;
	mergeImportedAccounts: (args: {
		existing: AccountStorageV3 | null;
		imported: AccountStorageV3;
		maxAccounts: number;
		deduplicateAccounts: (
			accounts: AccountStorageV3["accounts"],
		) => AccountStorageV3["accounts"];
	}) => {
		newStorage: AccountStorageV3;
		imported: number;
		total: number;
		skipped: number;
	};
	maxAccounts: number;
	deduplicateAccounts: (
		accounts: AccountStorageV3["accounts"],
	) => AccountStorageV3["accounts"];
	logInfo: (message: string, details: Record<string, unknown>) => void;
}): Promise<{ imported: number; total: number; skipped: number }> {
	const normalized = await params.readImportFile({
		resolvedPath: params.resolvedPath,
		normalizeAccountStorage: params.normalizeAccountStorage,
	});

	const result = await params.withAccountStorageTransaction(
		async (existing, persist) => {
			const merged = params.mergeImportedAccounts({
				existing,
				imported: normalized,
				maxAccounts: params.maxAccounts,
				deduplicateAccounts: params.deduplicateAccounts,
			});
			await persist(merged.newStorage);
			return {
				imported: merged.imported,
				total: merged.total,
				skipped: merged.skipped,
			};
		},
	);

	params.logInfo("Imported accounts", {
		path: params.resolvedPath,
		imported: result.imported,
		skipped: result.skipped,
		total: result.total,
	});
	return result;
}

export async function saveFlaggedAccountsEntry(params: {
	storage: FlaggedAccountStorageV1;
	withStorageLock: <T>(fn: () => Promise<T>) => Promise<T>;
	saveUnlocked: (storage: FlaggedAccountStorageV1) => Promise<void>;
}): Promise<void> {
	return params.withStorageLock(async () => {
		await params.saveUnlocked(params.storage);
	});
}

export async function clearFlaggedAccountsEntry(params: {
	path: string;
	withStorageLock: <T>(fn: () => Promise<T>) => Promise<T>;
	markerPath: string;
	getBackupPaths: () => Promise<string[]>;
	clearFlaggedAccountsOnDisk: (args: {
		path: string;
		markerPath: string;
		backupPaths: string[];
		logError: (message: string, details: Record<string, unknown>) => void;
	}) => Promise<void>;
	logError: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	return params.withStorageLock(async () => {
		await params.clearFlaggedAccountsOnDisk({
			path: params.path,
			markerPath: params.markerPath,
			backupPaths: await params.getBackupPaths(),
			logError: params.logError,
		});
	});
}
