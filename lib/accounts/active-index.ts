import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";

export interface ActiveIndexFamilyStorage {
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
}

export function createActiveIndexByFamily(
	index: number,
	families: readonly ModelFamily[] = MODEL_FAMILIES,
): Partial<Record<ModelFamily, number>> {
	const byFamily: Partial<Record<ModelFamily, number>> = {};
	for (const family of families) {
		byFamily[family] = index;
	}
	return byFamily;
}

export function setActiveIndexForAllFamilies(
	storage: ActiveIndexFamilyStorage,
	index: number,
	families: readonly ModelFamily[] = MODEL_FAMILIES,
): void {
	storage.activeIndex = index;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of families) {
		storage.activeIndexByFamily[family] = index;
	}
}
