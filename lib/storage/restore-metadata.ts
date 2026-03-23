import type { AccountStorageV3 } from "../storage.js";

type RestoreReason = "empty-storage" | "intentional-reset" | "missing-storage";

type AccountStorageWithMetadata = AccountStorageV3 & {
	restoreEligible?: boolean;
	restoreReason?: RestoreReason;
};

export function createEmptyStorageWithRestoreMetadata(
	restoreEligible: boolean,
	restoreReason: RestoreReason,
): AccountStorageWithMetadata {
	return {
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: {},
		restoreEligible,
		restoreReason,
	};
}

export function withRestoreMetadata(
	storage: AccountStorageV3,
	restoreEligible: boolean,
	restoreReason: RestoreReason,
): AccountStorageWithMetadata {
	return {
		...storage,
		restoreEligible,
		restoreReason,
	};
}
