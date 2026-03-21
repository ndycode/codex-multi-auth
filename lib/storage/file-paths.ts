import { dirname, join } from "node:path";

export const ACCOUNTS_BACKUP_SUFFIX = ".bak";
export const ACCOUNTS_WAL_SUFFIX = ".wal";
const ACCOUNTS_BACKUP_HISTORY_DEPTH = 3;
export const RESET_MARKER_SUFFIX = ".reset-intent";

export function getAccountsBackupPath(path: string): string {
	return `${path}${ACCOUNTS_BACKUP_SUFFIX}`;
}

export function getAccountsBackupPathAtIndex(
	path: string,
	index: number,
): string {
	if (index <= 0) return getAccountsBackupPath(path);
	return `${path}${ACCOUNTS_BACKUP_SUFFIX}.${index}`;
}

export function getAccountsBackupRecoveryCandidates(path: string): string[] {
	const candidates: string[] = [];
	for (let i = 0; i < ACCOUNTS_BACKUP_HISTORY_DEPTH; i += 1) {
		candidates.push(getAccountsBackupPathAtIndex(path, i));
	}
	return candidates;
}

export function getAccountsWalPath(path: string): string {
	return `${path}${ACCOUNTS_WAL_SUFFIX}`;
}

export function getIntentionalResetMarkerPath(path: string): string {
	return `${path}${RESET_MARKER_SUFFIX}`;
}

export function getFlaggedAccountsPath(
	storagePath: string,
	fileName: string,
): string {
	return join(dirname(storagePath), fileName);
}

export function getLegacyFlaggedAccountsPath(
	storagePath: string,
	legacyFileName: string,
): string {
	return join(dirname(storagePath), legacyFileName);
}
