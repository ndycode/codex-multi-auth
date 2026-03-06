import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";

export interface ActiveIndexFamilyStorage {
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
}

export interface AccountListActiveIndexStorage extends ActiveIndexFamilyStorage {
	accounts: unknown[];
}

interface NormalizeActiveIndexOptions {
	clearFamilyMapWhenEmpty?: boolean;
	families?: readonly ModelFamily[];
}

function clampIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	if (!Number.isFinite(index)) return 0;
	return Math.max(0, Math.min(Math.floor(index), count - 1));
}

function reconcileIndexAfterRemoval(index: number, targetIndex: number, nextCount: number): number {
	if (nextCount <= 0) return 0;
	if (!Number.isFinite(index)) return 0;
	const normalized = Math.floor(index);
	if (normalized > targetIndex) {
		return clampIndex(normalized - 1, nextCount);
	}
	if (normalized === targetIndex) {
		return Math.min(targetIndex, nextCount - 1);
	}
	return clampIndex(normalized, nextCount);
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

export function removeAccountAndReconcileActiveIndexes(
	storage: AccountListActiveIndexStorage,
	targetIndex: number,
	families: readonly ModelFamily[] = MODEL_FAMILIES,
): boolean {
	if (targetIndex < 0 || targetIndex >= storage.accounts.length) {
		return false;
	}

	storage.accounts.splice(targetIndex, 1);

	if (storage.accounts.length === 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		return true;
	}

	storage.activeIndex = reconcileIndexAfterRemoval(
		storage.activeIndex,
		targetIndex,
		storage.accounts.length,
	);

	if (storage.activeIndexByFamily) {
		for (const family of families) {
			const idx = storage.activeIndexByFamily[family];
			if (typeof idx !== "number") continue;
			storage.activeIndexByFamily[family] = reconcileIndexAfterRemoval(
				idx,
				targetIndex,
				storage.accounts.length,
			);
		}
	}

	return true;
}
