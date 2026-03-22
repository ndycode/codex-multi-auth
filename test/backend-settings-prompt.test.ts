import { describe, expect, it, vi } from "vitest";
import type { BackendCategoryOption } from "../lib/codex-manager/backend-settings-schema.js";
import { promptBackendSettingsMenu } from "../lib/codex-manager/backend-settings-prompt.js";
import { getUiRuntimeOptions, resetUiRuntimeOptions } from "../lib/ui/runtime.js";

function createUiRuntimeOptions() {
	resetUiRuntimeOptions();
	return getUiRuntimeOptions();
}

const sessionSyncCategory = {
	key: "session-sync",
	label: "Session Sync",
	description: "desc",
	toggleKeys: [],
	numberKeys: [],
} satisfies BackendCategoryOption;

describe("backend settings prompt", () => {
	it("returns null when not interactive", async () => {
		const result = await promptBackendSettingsMenu({
			initial: { fetchTimeoutMs: 1000 },
			isInteractive: () => false,
			ui: createUiRuntimeOptions(),
			cloneBackendPluginConfig: (config) => ({ ...config }),
			backendCategoryOptions: [],
			getBackendCategoryInitialFocus: vi.fn(),
			buildBackendSettingsPreview: vi.fn(),
			highlightPreviewToken: vi.fn((text) => text),
			select: vi.fn(),
			getBackendCategory: vi.fn(),
			promptBackendCategorySettings: vi.fn(),
			backendDefaults: { fetchTimeoutMs: 1000 },
			copy: {
				previewHeading: "Preview",
				backendCategoriesHeading: "Categories",
				resetDefault: "Reset",
				saveAndBack: "Save",
				backNoSave: "Back",
				backendTitle: "Backend",
				backendSubtitle: "Subtitle",
				backendHelp: "Help",
			},
		});

		expect(result).toBeNull();
	});

	it("returns updated draft when save is chosen after reset", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce({ type: "reset" })
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptBackendSettingsMenu({
			initial: { fetchTimeoutMs: 5000 },
			isInteractive: () => true,
			ui: createUiRuntimeOptions(),
			cloneBackendPluginConfig: (config) => ({ ...config }),
			backendCategoryOptions: [sessionSyncCategory],
			getBackendCategoryInitialFocus: () => null,
			buildBackendSettingsPreview: () => ({ label: "Preview", hint: "Hint" }),
			highlightPreviewToken: vi.fn((text) => text),
			select,
			getBackendCategory: vi.fn(() => null),
			promptBackendCategorySettings: vi.fn(),
			backendDefaults: { fetchTimeoutMs: 1000 },
			copy: {
				previewHeading: "Preview",
				backendCategoriesHeading: "Categories",
				resetDefault: "Reset",
				saveAndBack: "Save",
				backNoSave: "Back",
				backendTitle: "Backend",
				backendSubtitle: "Subtitle",
				backendHelp: "Help",
			},
		});

		expect(result).toEqual({ fetchTimeoutMs: 1000 });
	});

	it("persists category drill-down draft updates and focus before save", async () => {
		const ui = createUiRuntimeOptions();
		const buildBackendSettingsPreview = vi
			.fn()
			.mockReturnValue({ label: "Preview", hint: "Hint" });
		const promptBackendCategorySettings = vi.fn().mockResolvedValue({
			draft: { fetchTimeoutMs: 2500 },
			focusKey: "fetchTimeoutMs",
		});
		const select = vi
			.fn()
			.mockResolvedValueOnce({ type: "open-category", key: "session-sync" })
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptBackendSettingsMenu({
			initial: { fetchTimeoutMs: 5000 },
			isInteractive: () => true,
			ui,
			cloneBackendPluginConfig: (config) => ({ ...config }),
			backendCategoryOptions: [sessionSyncCategory],
			getBackendCategoryInitialFocus: () => null,
			buildBackendSettingsPreview,
			highlightPreviewToken: vi.fn((text) => text),
			select,
			getBackendCategory: vi.fn((key) =>
				key === sessionSyncCategory.key ? sessionSyncCategory : null,
			),
			promptBackendCategorySettings,
			backendDefaults: { fetchTimeoutMs: 1000 },
			copy: {
				previewHeading: "Preview",
				backendCategoriesHeading: "Categories",
				resetDefault: "Reset",
				saveAndBack: "Save",
				backNoSave: "Back",
				backendTitle: "Backend",
				backendSubtitle: "Subtitle",
				backendHelp: "Help",
			},
		});

		expect(promptBackendCategorySettings).toHaveBeenCalledWith(
			{ fetchTimeoutMs: 5000 },
			sessionSyncCategory,
			null,
		);
		expect(buildBackendSettingsPreview).toHaveBeenNthCalledWith(
			2,
			{ fetchTimeoutMs: 2500 },
			ui,
			"fetchTimeoutMs",
			{ highlightPreviewToken: expect.any(Function) },
		);
		expect(result).toEqual({ fetchTimeoutMs: 2500 });
	});
});
