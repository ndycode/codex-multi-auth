import { describe, expect, it } from "vitest";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import {
	createActiveIndexByFamily,
	setActiveIndexForAllFamilies,
	normalizeActiveIndexByFamily,
	removeAccountAndReconcileActiveIndexes,
} from "../lib/accounts/active-index.js";

describe("active-index helpers", () => {
	it("creates a per-family active index map", () => {
		expect(createActiveIndexByFamily(2)).toEqual({
			"gpt-5-codex": 2,
			"codex-max": 2,
			codex: 2,
			"gpt-5.2": 2,
			"gpt-5.1": 2,
		});
	});

	it("sets active index across all model families", () => {
		const storage: {
			activeIndex: number;
			activeIndexByFamily?: Partial<Record<(typeof MODEL_FAMILIES)[number], number>>;
		} = {
			activeIndex: 0,
		};

		setActiveIndexForAllFamilies(storage, 3);

		expect(storage.activeIndex).toBe(3);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBe(3);
		}
	});

	it("normalizes non-finite and fractional set-active values before writing", () => {
		const storage: {
			activeIndex: number;
			activeIndexByFamily?: Partial<Record<(typeof MODEL_FAMILIES)[number], number>>;
		} = {
			activeIndex: 0,
		};

		setActiveIndexForAllFamilies(storage, 1.8);
		expect(storage.activeIndex).toBe(1);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBe(1);
		}

		setActiveIndexForAllFamilies(storage, Number.NaN);
		expect(storage.activeIndex).toBe(0);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBe(0);
		}
	});

	it("preserves unrelated keys when reusing existing family map objects", () => {
		const storage: {
			activeIndex: number;
			activeIndexByFamily?: Record<string, number>;
		} = {
			activeIndex: 1,
			activeIndexByFamily: {
				legacy: 99,
				codex: 1,
			},
		};

		setActiveIndexForAllFamilies(storage, 0);

		expect(storage.activeIndexByFamily?.legacy).toBe(99);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBe(0);
		}
	});

	it("normalizes active and per-family indexes within account bounds", () => {
		const storage: {
			activeIndex: number;
			activeIndexByFamily?: Partial<Record<(typeof MODEL_FAMILIES)[number], number>>;
		} = {
			activeIndex: 99,
			activeIndexByFamily: {
				codex: Number.POSITIVE_INFINITY,
				"gpt-5.1": -3.2,
			},
		};

		const changed = normalizeActiveIndexByFamily(storage, 2);

		expect(changed).toBe(true);
		expect(storage.activeIndex).toBe(1);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBeGreaterThanOrEqual(0);
			expect(storage.activeIndexByFamily?.[family]).toBeLessThanOrEqual(1);
			expect(Number.isInteger(storage.activeIndexByFamily?.[family] ?? Number.NaN)).toBe(true);
		}
		expect(storage.activeIndexByFamily?.codex).toBe(1);
		expect(storage.activeIndexByFamily?.["gpt-5.1"]).toBe(0);
	});

	it("clears family map when empty accounts are requested to clear", () => {
		const storage: {
			activeIndex: number;
			activeIndexByFamily?: Record<string, number>;
		} = {
			activeIndex: 5,
			activeIndexByFamily: {
				codex: 2,
				legacy: 9,
			},
		};

		const changed = normalizeActiveIndexByFamily(storage, 0, {
			clearFamilyMapWhenEmpty: true,
		});

		expect(changed).toBe(true);
		expect(storage.activeIndex).toBe(0);
		expect(storage.activeIndexByFamily).toEqual({});
	});

	it("fills model-family indexes with zero for empty account sets by default", () => {
		const storage: {
			activeIndex: number;
			activeIndexByFamily?: Partial<Record<(typeof MODEL_FAMILIES)[number], number>>;
		} = {
			activeIndex: 3,
			activeIndexByFamily: {},
		};

		const changed = normalizeActiveIndexByFamily(storage, 0);

		expect(changed).toBe(true);
		expect(storage.activeIndex).toBe(0);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBe(0);
		}
	});

	it("removes accounts and reconciles active indexes for remaining entries", () => {
		const storage: {
			accounts: unknown[];
			activeIndex: number;
			activeIndexByFamily?: Partial<Record<(typeof MODEL_FAMILIES)[number], number>>;
		} = {
			accounts: [{ id: 1 }, { id: 2 }, { id: 3 }],
			activeIndex: 2,
			activeIndexByFamily: {
				codex: 2,
				"gpt-5.1": 2,
			},
		};

		const changed = removeAccountAndReconcileActiveIndexes(storage, 0);

		expect(changed).toBe(true);
		expect(storage.accounts).toHaveLength(2);
		expect(storage.activeIndex).toBe(1);
		expect(storage.activeIndexByFamily?.codex).toBe(1);
		expect(storage.activeIndexByFamily?.["gpt-5.1"]).toBe(1);
	});

	it("returns false and keeps storage unchanged for out-of-range removals", () => {
		const storage: {
			accounts: unknown[];
			activeIndex: number;
			activeIndexByFamily?: Record<string, number>;
		} = {
			accounts: [{ id: 1 }],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		expect(removeAccountAndReconcileActiveIndexes(storage, 2)).toBe(false);
		expect(storage.accounts).toHaveLength(1);
		expect(storage.activeIndex).toBe(0);
		expect(storage.activeIndexByFamily).toEqual({ codex: 0 });
	});

	it("returns false and keeps storage unchanged for non-integer removals", () => {
		const storage: {
			accounts: unknown[];
			activeIndex: number;
			activeIndexByFamily?: Record<string, number>;
		} = {
			accounts: [{ id: 1 }, { id: 2 }],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		};

		expect(removeAccountAndReconcileActiveIndexes(storage, 0.5)).toBe(false);
		expect(storage.accounts).toEqual([{ id: 1 }, { id: 2 }]);
		expect(storage.activeIndex).toBe(1);
		expect(storage.activeIndexByFamily).toEqual({ codex: 1 });
	});
});
