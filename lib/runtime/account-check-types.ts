import type { FlaggedAccountMetadataV1 } from "../storage.js";

export type AccountCheckWorkingState = {
	storageChanged: boolean;
	flaggedChanged: boolean;
	ok: number;
	errors: number;
	disabled: number;
	removeFromActive: Set<string>;
	flaggedStorage: { version: 1; accounts: FlaggedAccountMetadataV1[] };
};

export function createAccountCheckWorkingState(flaggedStorage: {
	version: 1;
	accounts: FlaggedAccountMetadataV1[];
}): AccountCheckWorkingState {
	return {
		storageChanged: false,
		flaggedChanged: false,
		ok: 0,
		errors: 0,
		disabled: 0,
		removeFromActive: new Set<string>(),
		flaggedStorage,
	};
}
