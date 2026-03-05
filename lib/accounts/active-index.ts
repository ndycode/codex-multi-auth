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

function toFiniteInteger(index: number): number {
	return Number.isFinite(index) ? Math.trunc(index) : 0;
}

function clampIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	const normalized = toFiniteInteger(index);
	return Math.max(0, Math.min(normalized, count - 1));
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
	const normalized = Math.max(0, toFiniteInteger(index));
	storage.activeIndex = normalized;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of families) {
		storage.activeIndexByFamily[family] = normalized;
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
	if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= storage.accounts.length) {
		return false;
	}

	const previousCount = storage.accounts.length;
	const previousActive = clampIndex(storage.activeIndex, previousCount);
	storage.accounts.splice(targetIndex, 1);

	if (storage.accounts.length === 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		return true;
	}

	if (previousActive > targetIndex) {
		storage.activeIndex = previousActive - 1;
	} else if (previousActive === targetIndex) {
		storage.activeIndex = Math.min(targetIndex, storage.accounts.length - 1);
	} else {
		storage.activeIndex = previousActive;
	}

	if (storage.activeIndexByFamily) {
		for (const family of families) {
			const idx = storage.activeIndexByFamily[family];
			const base = typeof idx === "number"
				? clampIndex(idx, previousCount)
				: previousActive;
			const next = base > targetIndex
				? base - 1
				: base === targetIndex
					? Math.min(targetIndex, storage.accounts.length - 1)
					: base;
			if (storage.activeIndexByFamily[family] !== next) {
				storage.activeIndexByFamily[family] = next;
			}
		}
	}

	return true;
}
