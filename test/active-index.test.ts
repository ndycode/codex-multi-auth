import { describe, expect, it } from "vitest";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import {
	createActiveIndexByFamily,
	setActiveIndexForAllFamilies,
	normalizeActiveIndexByFamily,
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
				codex: Number.NaN,
				"gpt-5.1": -3,
			},
		};

		const changed = normalizeActiveIndexByFamily(storage, 2);

		expect(changed).toBe(true);
		expect(storage.activeIndex).toBe(1);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily?.[family]).toBeGreaterThanOrEqual(0);
			expect(storage.activeIndexByFamily?.[family]).toBeLessThanOrEqual(1);
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
});
