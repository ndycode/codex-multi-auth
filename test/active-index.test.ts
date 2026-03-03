import { describe, expect, it } from "vitest";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import {
	createActiveIndexByFamily,
	setActiveIndexForAllFamilies,
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
});
