import { describe, expect, it, vi } from "vitest";
import { promptBackendCategorySettingsMenu } from "../lib/codex-manager/backend-category-prompt.js";

describe("backend category prompt helper", () => {
	it("returns initial draft on immediate back", async () => {
		const initial = { fetchTimeoutMs: 1000 };
		const result = await promptBackendCategorySettingsMenu({
			initial,
			category: {
				key: "performance-timeouts",
				label: "Performance",
				description: "desc",
				toggleKeys: [],
				numberKeys: ["fetchTimeoutMs"],
			},
			initialFocus: "fetchTimeoutMs",
			ui: { theme: { accent: "x" } } as never,
			cloneBackendPluginConfig: (config) => ({ ...config }),
			buildBackendSettingsPreview: () => ({ label: "Preview", hint: "Hint" }),
			highlightPreviewToken: (text) => text,
			resolveFocusedBackendNumberKey: () => "fetchTimeoutMs",
			clampBackendNumber: (_option, value) => value,
			formatBackendNumberValue: (_option, value) => String(value),
			formatDashboardSettingState: (enabled) => (enabled ? "on" : "off"),
			applyBackendCategoryDefaults: (config) => config,
			getBackendCategoryInitialFocus: () => "fetchTimeoutMs",
			backendDefaults: { fetchTimeoutMs: 1000 },
			toggleOptionByKey: new Map(),
			numberOptionByKey: new Map([
				[
					"fetchTimeoutMs",
					{
						key: "fetchTimeoutMs",
						label: "Fetch timeout",
						description: "desc",
						min: 100,
						step: 100,
					},
				],
			]),
			select: async () => ({ type: "back" }),
			copy: {
				previewHeading: "Preview",
				backendToggleHeading: "Toggles",
				backendNumberHeading: "Numbers",
				backendDecrease: "Decrease",
				backendIncrease: "Increase",
				backendResetCategory: "Reset",
				backendBackToCategories: "Back",
				backendCategoryTitle: "Category",
				backendCategoryHelp: "Help",
			},
		});

		expect(result).toEqual({ draft: initial, focusKey: "fetchTimeoutMs" });
	});
});
