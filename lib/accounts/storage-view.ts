import type { AccountMetadataV3, AccountStorageV3 } from "../storage.js";
import { createActiveIndexByFamily } from "./active-index.js";

interface CreateEmptyAccountStorageOptions {
	initializeFamilyIndexes?: boolean;
}

export function createEmptyAccountStorage(
	options: CreateEmptyAccountStorageOptions = {},
): AccountStorageV3 {
	const initializeFamilyIndexes = options.initializeFamilyIndexes === true;
	return {
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: initializeFamilyIndexes ? createActiveIndexByFamily(0) : {},
	};
}

export function cloneAccountStorage(storage: AccountStorageV3): AccountStorageV3 {
	const cloneAccount = (account: AccountMetadataV3): AccountMetadataV3 => ({
		...account,
		rateLimitResetTimes: account.rateLimitResetTimes
			? { ...account.rateLimitResetTimes }
			: undefined,
	});

	return {
		version: 3,
		accounts: storage.accounts.map(cloneAccount),
		activeIndex: storage.activeIndex,
		activeIndexByFamily: storage.activeIndexByFamily
			? { ...storage.activeIndexByFamily }
			: {},
	};
}
