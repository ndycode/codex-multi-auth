import type { FlaggedAccountMetadataV1 } from "../storage.js";
import type { TokenSuccess } from "../types.js";
import type { TokenSuccessWithAccount } from "./account-selection.js";

export type FlaggedVerificationState = {
	remaining: FlaggedAccountMetadataV1[];
	restored: TokenSuccessWithAccount<TokenSuccess>[];
};

export function createFlaggedVerificationState(): FlaggedVerificationState {
	return {
		remaining: [],
		restored: [],
	};
}
