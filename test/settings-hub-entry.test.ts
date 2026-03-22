import { describe, expect, it, vi } from "vitest";
import { promptSettingsHubEntry } from "../lib/codex-manager/settings-hub-entry.js";

describe("settings hub entry", () => {
	it("passes focus and dependencies through to the settings hub prompt helper", async () => {
		const promptSettingsHubMenu = vi.fn(async () => ({
			type: "back" as const,
		}));
		const buildItems = vi.fn(() => []);
		const findInitialCursor = vi.fn(() => 0);
		const select = vi.fn();

		const result = await promptSettingsHubEntry({
			initialFocus: "account-list",
			promptSettingsHubMenu,
			isInteractive: () => true,
			getUiRuntimeOptions: vi.fn(() => ({ theme: {} }) as never),
			buildItems,
			findInitialCursor,
			select,
			copy: { title: "Settings", subtitle: "Subtitle", help: "Help" },
		});

		expect(promptSettingsHubMenu).toHaveBeenCalledWith(
			"account-list",
			expect.objectContaining({
				isInteractive: expect.any(Function),
				getUiRuntimeOptions: expect.any(Function),
				buildItems,
				findInitialCursor,
				select,
				copy: { title: "Settings", subtitle: "Subtitle", help: "Help" },
			}),
		);
		expect(result).toEqual({ type: "back" });
	});
});
