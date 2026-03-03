import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";

export interface ActiveIndexFamilyStorage {
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
}

interface NormalizeActiveIndexOptions {
	clearFamilyMapWhenEmpty?: boolean;
	families?: readonly ModelFamily[];
}

function clampIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.max(0, Math.min(index, count - 1));
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

export function normalizeActiveIndexByFamily(
	storage: ActiveIndexFamilyStorage,
	accountCount: number,
	options: NormalizeActiveIndexOptions = {},
): boolean {
	const families = options.families ?? MODEL_FAMILIES;
	const clearFamilyMapWhenEmpty = options.clearFamilyMapWhenEmpty === true;
	let changed = false;

	const nextActiveIndex = clampIndex(storage.activeIndex, accountCount);
	if (storage.activeIndex !== nextActiveIndex) {
		storage.activeIndex = nextActiveIndex;
		changed = true;
	}

	if (accountCount === 0 && clearFamilyMapWhenEmpty) {
		const hadKeys = !!storage.activeIndexByFamily && Object.keys(storage.activeIndexByFamily).length > 0;
		if (storage.activeIndexByFamily === undefined || hadKeys) {
			storage.activeIndexByFamily = {};
			changed = true;
		}
		return changed;
	}

	if (!storage.activeIndexByFamily) {
		storage.activeIndexByFamily = {};
		changed = true;
	}

	for (const family of families) {
		const raw = storage.activeIndexByFamily[family];
		const fallback = storage.activeIndex;
		const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
		const nextValue = accountCount === 0 ? 0 : clampIndex(candidate, accountCount);
		if (storage.activeIndexByFamily[family] !== nextValue) {
			storage.activeIndexByFamily[family] = nextValue;
			changed = true;
		}
	}

	return changed;
}
