import { describe, expect, it, vi } from "vitest";
import { promptBackendCategorySettingsEntry } from "../lib/codex-manager/backend-category-entry.js";

describe("backend category entry", () => {
	it("passes category wiring through to the backend category prompt helper", async () => {
		const promptBackendCategorySettingsMenu = vi.fn(async () => ({
			draft: { fetchTimeoutMs: 1000 },
			focusKey: null,
		}));

		const result = await promptBackendCategorySettingsEntry({
			initial: { fetchTimeoutMs: 2000 },
			category: {
				key: "session-sync",
				label: "Session Sync",
				description: "desc",
			} as never,
			initialFocus: null,
			promptBackendCategorySettingsMenu,
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: vi.fn((config) => config),
			buildBackendSettingsPreview: vi.fn(() => ({
				label: "Preview",
				hint: "Hint",
			})),
			highlightPreviewToken: vi.fn((text) => text),
			resolveFocusedBackendNumberKey: vi.fn(() => "fetchTimeoutMs" as never),
			clampBackendNumber: vi.fn((_, value) => value),
			formatBackendNumberValue: vi.fn((_, value) => String(value)),
			formatDashboardSettingState: vi.fn((enabled) => (enabled ? "on" : "off")),
			applyBackendCategoryDefaults: vi.fn((config) => config),
			getBackendCategoryInitialFocus: vi.fn(() => null),
			backendDefaults: { fetchTimeoutMs: 1000 },
			toggleOptionByKey: new Map(),
			numberOptionByKey: new Map(),
			select: vi.fn(),
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

		expect(promptBackendCategorySettingsMenu).toHaveBeenCalled();
		expect(result).toEqual({
			draft: { fetchTimeoutMs: 1000 },
			focusKey: null,
		});
	});
});
