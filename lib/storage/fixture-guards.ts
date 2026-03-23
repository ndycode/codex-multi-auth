import type { AccountMetadataV3, AccountStorageV3 } from "../storage.js";

export function looksLikeSyntheticFixtureAccount(
	account: AccountMetadataV3,
): boolean {
	const email =
		typeof account.email === "string" ? account.email.trim().toLowerCase() : "";
	const refreshToken =
		typeof account.refreshToken === "string"
			? account.refreshToken.trim().toLowerCase()
			: "";
	const accountId =
		typeof account.accountId === "string"
			? account.accountId.trim().toLowerCase()
			: "";
	if (!/^account\d+@example\.com$/.test(email)) {
		return false;
	}
	const hasSyntheticRefreshToken =
		refreshToken.startsWith("fake_refresh") ||
		/^fake_refresh_token_\d+(_for_testing_only)?$/.test(refreshToken);
	if (!hasSyntheticRefreshToken) {
		return false;
	}
	if (accountId.length === 0) {
		return true;
	}
	return /^acc(_|-)?\d+$/.test(accountId);
}

export function looksLikeSyntheticFixtureStorage(
	storage: AccountStorageV3 | null,
): boolean {
	if (!storage || storage.accounts.length === 0) return false;
	return storage.accounts.every((account) =>
		looksLikeSyntheticFixtureAccount(account),
	);
}
