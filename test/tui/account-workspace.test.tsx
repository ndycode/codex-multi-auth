import { describe, expect, test } from "bun:test";
import { buildAuthDashboardViewModel } from "../../lib/codex-manager/auth-ui-controller.js";
import { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } from "../../lib/dashboard-settings.js";
import { formatOpenTuiAccountRow } from "../../runtime/opentui/account-workspace.js";
import { mountOpenTuiShellHarness } from "./harness.js";

function createWorkspaceDashboard() {
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
					primary: { usedPercent: 80, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 70, windowMinutes: 10080, resetAtMs: now + 2_000 },
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
					primary: { usedPercent: 50, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 20, windowMinutes: 10080, resetAtMs: now + 2_000 },
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

describe("OpenTUI account workspace", () => {
	test("renders compact single-line account rows with current, status, limits, and last-used data", async () => {
		const harness = await mountOpenTuiShellHarness({
			shell: {
				dashboard: createWorkspaceDashboard(),
			},
			renderer: {
				height: 28,
				width: 132,
			},
		});

		try {
			const frame = harness.captureCharFrame();
			expect(frame).toContain("1. * beta@ex.com [act] today 5h100 7d100");
			expect(frame).toContain("2. gamma@ex.com [ok] 2d 5h50 7d80 limit");
			expect(frame).toContain("3. alpha@ex.com [ok] yesterday 5h20 7d30");
			expect(frame).not.toContain("details shown on all rows");
		} finally {
			await harness.destroy();
		}
	});

	test("filters visible rows with inline search and quick-switches using visible-row numbers only", async () => {
		const harness = await mountOpenTuiShellHarness({
			shell: {
				dashboard: createWorkspaceDashboard(),
			},
			renderer: {
				height: 28,
				width: 132,
			},
		});

		try {
			harness.mockInput.pressKey("/");
			await harness.renderOnce();
			await harness.mockInput.typeText("gamma");
			await harness.renderOnce();

			const searchFrame = harness.captureCharFrame();
			expect(searchFrame).toContain("Search: gamma");
			expect(searchFrame).toContain("gamma@ex.com");
			expect(searchFrame).not.toContain("beta@ex.com");

			harness.mockInput.pressEnter();
			await harness.renderOnce();
			harness.mockInput.pressKey("2");
			await harness.renderOnce();

			expect(harness.workspaceActions.at(-1)).toEqual({
				type: "quick-switch",
				sourceIndex: 2,
			});
			expect(harness.selectionChanges.at(-1)?.accountLabel).toContain("gamma@ex.com");
		} finally {
			await harness.destroy();
		}
	});

	test("collapses verbose quota and warning text into a compact row summary", () => {
		const row = formatOpenTuiAccountRow({
			index: 0,
			quickSwitchNumber: 1,
			email: "verbose@ex.com",
			status: "ok",
			quotaRateLimited: true,
			quotaSummary: "5h 40% left (resets 14:05), 7d 75% left (resets 16:40 on Mar 11), rate-limited",
			enabled: true,
			showLastUsed: false,
		});

		expect(row).toContain("1. verbose@ex.com [ok] 5h40 7d75 limit");
		expect(row).not.toContain("resets");
		expect(row).not.toContain("left (");
	});
});
