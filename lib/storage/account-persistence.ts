import type { AccountStorageV3 } from "./public-types.js";

export function cloneAccountStorageForPersistence(
	storage: AccountStorageV3 | null | undefined,
): AccountStorageV3 {
	const cloned: AccountStorageV3 = {
		version: 3,
		accounts: structuredClone(storage?.accounts ?? []),
		activeIndex:
			typeof storage?.activeIndex === "number" &&
			Number.isFinite(storage.activeIndex)
				? storage.activeIndex
				: 0,
		activeIndexByFamily: structuredClone(storage?.activeIndexByFamily ?? {}),
	};
	// Preserve the user's manual pin (issue #474) and affinity generation across
	// the combined account+flagged transaction (incl. doctor restore). Dropping
	// these erased a manual `switch <n>` pin on persistence.
	if (typeof storage?.pinnedAccountIndex === "number") {
		cloned.pinnedAccountIndex = storage.pinnedAccountIndex;
	}
	if (typeof storage?.affinityGeneration === "number") {
		cloned.affinityGeneration = storage.affinityGeneration;
	}
	return cloned;
}
