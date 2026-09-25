import type { AccountManager } from "../accounts.js";
import { sanitizeEmail } from "../auth/token-utils.js";
import type { AccountStorageV3 } from "../storage.js";

type Identity = { recordId?: string; accountId?: string; email?: string; refreshToken?: string };
/**
 * The manager stores sanitized (lower-cased) emails while storage keeps the raw
 * value, so match a stored record ID first and otherwise the canonical identity.
 * Two rows with neither an accountId nor an email share no identity at all
 * (undefined === undefined), so those match only by their refresh token.
 */
export function isSameNativeAccount(account: Identity, disk: Identity | undefined): boolean {
	if (!disk) return false;
	const left = account.recordId?.trim();
	const right = disk.recordId?.trim();
	if (left && right) return left === right;
	const accountId = account.accountId?.trim() || undefined;
	const email = sanitizeEmail(account.email);
	if (!accountId && !email) {
		const token = account.refreshToken?.trim();
		return !disk.accountId?.trim() && !sanitizeEmail(disk.email) && !!token && token === disk.refreshToken?.trim();
	}
	return accountId === (disk.accountId?.trim() || undefined) && email === sanitizeEmail(disk.email);
}

/** Adopt credentials from a re-login without resetting independent quota state. */
export function syncNativeAccountCredentials(
	manager: AccountManager,
	storage: AccountStorageV3,
): boolean {
	let changed = manager.syncWorkspaceSelections(storage);
	for (const snapshot of manager.getAccountsSnapshot()) {
		const account = manager.getAccountByIndex(snapshot.index);
		if (!account) continue;
		const disk = storage.accounts.find((a) => isSameNativeAccount(account, a));
		if (!disk) {
			account.enabled = false;
			changed = true;
			continue;
		}
		if ((account.enabled !== false) !== (disk.enabled !== false)) {
			account.enabled = disk.enabled;
			changed = true;
		}
		if (
			disk.authInvalidatedAt &&
			disk.authInvalidatedAt !== account.authInvalidatedAt
		) {
			account.authInvalidatedAt = disk.authInvalidatedAt;
			account.authInvalidationErrorCode = disk.authInvalidationErrorCode;
			changed = true;
		}
		if (
			disk.accessToken === account.access &&
			disk.refreshToken === account.refreshToken &&
			disk.expiresAt === account.expires
		)
			continue;
		account.access = disk.accessToken;
		account.refreshToken = disk.refreshToken;
		account.expires = disk.expiresAt;
		if (disk.accessToken && disk.refreshToken && !disk.authInvalidatedAt) {
			delete account.authInvalidatedAt;
			delete account.authInvalidationErrorCode;
			if (account.cooldownReason === "auth-failure")
				manager.clearAccountCooldown(account);
		}
		changed = true;
	}
	return changed;
}
