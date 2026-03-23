const ACCOUNTS_BACKUP_SUFFIX = ".bak";
const ACCOUNTS_WAL_SUFFIX = ".wal";
const RESET_MARKER_SUFFIX = ".reset-intent";

export function getAccountsBackupPath(path: string): string {
	return `${path}${ACCOUNTS_BACKUP_SUFFIX}`;
}

export function getAccountsBackupPathAtIndex(
	path: string,
	index: number,
): string {
	if (index <= 0) {
		return getAccountsBackupPath(path);
	}
	return `${path}${ACCOUNTS_BACKUP_SUFFIX}.${index}`;
}

export function getAccountsBackupRecoveryCandidates(
	path: string,
	depth: number,
): string[] {
	const candidates: string[] = [];
	for (let i = 0; i < depth; i += 1) {
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

export { ACCOUNTS_BACKUP_SUFFIX, ACCOUNTS_WAL_SUFFIX, RESET_MARKER_SUFFIX };
