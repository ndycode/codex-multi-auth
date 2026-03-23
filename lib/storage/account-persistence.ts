import type { AccountStorageV3 } from "../storage.js";

export function cloneAccountStorageForPersistence(
	storage: AccountStorageV3 | null | undefined,
): AccountStorageV3 {
	return {
		version: 3,
		accounts: structuredClone(storage?.accounts ?? []),
		activeIndex:
			typeof storage?.activeIndex === "number" &&
			Number.isFinite(storage.activeIndex)
				? storage.activeIndex
				: 0,
		activeIndexByFamily: structuredClone(storage?.activeIndexByFamily ?? {}),
	};
}
