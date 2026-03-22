import { describe, expect, it, vi } from "vitest";
import { promptBackendSettingsMenu } from "../lib/codex-manager/backend-settings-prompt.js";

describe("backend settings prompt", () => {
	it("returns null when not interactive", async () => {
		const result = await promptBackendSettingsMenu({
			initial: { fetchTimeoutMs: 1000 },
			isInteractive: () => false,
			ui: { theme: {} } as never,
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
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: (config) => ({ ...config }),
			backendCategoryOptions: [
				{ key: "session-sync", label: "Session Sync", description: "desc" },
			] as never,
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
});
