import { describe, expect, it } from "vitest";
import {
	applyBackendCategoryDefaults,
	getBackendCategory,
	getBackendCategoryInitialFocus,
	resolveFocusedBackendNumberKey,
} from "../lib/codex-manager/backend-category-helpers.js";
import {
	BACKEND_CATEGORY_OPTIONS,
	BACKEND_DEFAULTS,
	BACKEND_NUMBER_OPTION_BY_KEY,
	BACKEND_NUMBER_OPTIONS,
} from "../lib/codex-manager/backend-settings-schema.js";

describe("backend category helpers", () => {
	it("resolves focused number key from available options", () => {
		expect(
			resolveFocusedBackendNumberKey("fetchTimeoutMs", BACKEND_NUMBER_OPTIONS),
		).toBe("fetchTimeoutMs");
		expect(resolveFocusedBackendNumberKey(null, BACKEND_NUMBER_OPTIONS)).toBe(
			BACKEND_NUMBER_OPTIONS[0]?.key ?? "fetchTimeoutMs",
		);
	});

	it("finds categories and computes their initial focus", () => {
		const category = getBackendCategory(
			"performance-timeouts",
			BACKEND_CATEGORY_OPTIONS,
		);
		expect(category?.key).toBe("performance-timeouts");
		expect(
			category ? getBackendCategoryInitialFocus(category) : null,
		).toBeTruthy();
		expect(
			getBackendCategory("refresh-recovery", BACKEND_CATEGORY_OPTIONS)?.key,
		).toBe("refresh-recovery");
	});

	it("applies category defaults for toggles and numeric settings", () => {
		const category = getBackendCategory(
			"performance-timeouts",
			BACKEND_CATEGORY_OPTIONS,
		);
		if (!category) throw new Error("missing performance-timeouts category");

		const draft = {
			...BACKEND_DEFAULTS,
			fetchTimeoutMs: 999,
			streamStallTimeoutMs: 999,
			networkErrorCooldownMs: 999,
		};
		const next = applyBackendCategoryDefaults(draft, category, {
			backendDefaults: BACKEND_DEFAULTS,
			numberOptionByKey: BACKEND_NUMBER_OPTION_BY_KEY,
		});

		for (const key of category.numberKeys) {
			expect(next[key]).toBe(BACKEND_DEFAULTS[key]);
		}
		for (const key of category.toggleKeys) {
			expect(next[key]).toBe(BACKEND_DEFAULTS[key]);
		}
	});
});
