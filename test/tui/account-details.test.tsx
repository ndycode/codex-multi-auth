import { describe, expect, test } from "bun:test";
import { buildAuthDashboardViewModel } from "../../lib/codex-manager/auth-ui-controller.js";
import { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } from "../../lib/dashboard-settings.js";
import { mountOpenTuiShellHarness } from "./harness.js";

function createDetailDashboard() {
	const now = Date.now();
	return buildAuthDashboardViewModel({
		storage: {
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
			accounts: [
				{
					email: "alpha@ex.com",
					accountId: "acc_alpha",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 3_600_000,
					addedAt: now - 30_000,
					lastUsed: now - 86_400_000,
					enabled: true,
				},
				{
					email: "beta@ex.com",
					accountId: "acc_beta",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 20_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "gamma@ex.com",
					accountId: "acc_gamma",
					refreshToken: "refresh-gamma",
					accessToken: "access-gamma",
					expiresAt: now + 3_600_000,
					addedAt: now - 10_000,
					lastUsed: now - 172_800_000,
					enabled: true,
				},
			],
		},
		quotaCache: {
			byAccountId: {},
			byEmail: {
				"alpha@ex.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 80, windowMinutes: 300, resetAtMs: now + 3_300_000 },
					secondary: { usedPercent: 70, windowMinutes: 10080, resetAtMs: now + 86_400_000 },
				},
				"beta@ex.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 0, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 0, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
				"gamma@ex.com": {
					updatedAt: now,
					status: 429,
					model: "gpt-5-codex",
					primary: { usedPercent: 50, windowMinutes: 300, resetAtMs: now + 4_500_000 },
					secondary: { usedPercent: 20, windowMinutes: 10080, resetAtMs: now + 172_800_000 },
				},
			},
		},
		displaySettings: {
			...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		},
		flaggedCount: 1,
		statusMessage: "Loading live limits...",
	});
}

function findLine(frame: string, snippet: string): string {
	return frame.split("\n").find((line) => line.includes(snippet)) ?? "";
}

describe("OpenTUI account detail pane", () => {
	test("shows richer focused detail beside compact account rows", async () => {
		const harness = await mountOpenTuiShellHarness({
			shell: {
				dashboard: createDetailDashboard(),
			},
			renderer: {
				height: 28,
				width: 132,
			},
		});

		try {
			let frame = harness.captureCharFrame();
			expect(frame).toContain("Focused account");
			expect(frame).toContain("1. beta@ex.com");
			expect(frame).toContain("S Set current");
			expect(frame).toContain("R Re-login OAuth");
			expect(frame).toContain("D Delete (typed)");

			harness.mockInput.pressArrow("down");
			await harness.renderOnce();

			frame = harness.captureCharFrame();
			const compactRow = findLine(frame, "gamma@ex.com [ok]");
			expect(compactRow).toContain("5h50 7d80 limit");
			expect(compactRow).not.toContain("resets");
			expect(frame).toContain("gamma@ex.com [ok]");
			expect(frame).toContain("5h left 50% @");
			expect(frame).toContain("7d left 80% @");
			expect(frame).toContain("Alert: rate-limited");
		} finally {
			await harness.destroy();
		}
	});
});
