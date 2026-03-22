import type { FlaggedAccountMetadataV1 } from "../storage.js";
import type { TokenSuccessWithAccount } from "./account-selection.js";

export type FlaggedVerificationState = {
	remaining: FlaggedAccountMetadataV1[];
	restored: TokenSuccessWithAccount[];
};

export function createFlaggedVerificationState(): FlaggedVerificationState {
	return {
		remaining: [],
		restored: [],
	};
}
