import { describe, expect, it, vi } from "vitest";
import { promptSettingsHubMenu } from "../lib/codex-manager/settings-hub-prompt.js";

describe("settings hub prompt helper", () => {
	it("returns null when not interactive", async () => {
		const result = await promptSettingsHubMenu("account-list", {
			isInteractive: () => false,
			getUiRuntimeOptions: vi.fn(),
			buildItems: vi.fn(),
			findInitialCursor: vi.fn(),
			select: vi.fn(),
			copy: { title: "t", subtitle: "s", help: "h" },
		});

		expect(result).toBeNull();
	});

	it("builds prompt options and delegates to select", async () => {
		const select = vi.fn(async () => ({ type: "backend" as const }));
		const result = await promptSettingsHubMenu("backend", {
			isInteractive: () => true,
			getUiRuntimeOptions: () => ({ theme: { accent: "x" } }) as never,
			buildItems: () => [
				{ label: "Backend", value: { type: "backend" as const } },
			],
			findInitialCursor: () => 0,
			select,
			copy: { title: "t", subtitle: "s", help: "h" },
		});

		expect(select).toHaveBeenCalled();
		expect(result).toEqual({ type: "backend" });
	});
});
