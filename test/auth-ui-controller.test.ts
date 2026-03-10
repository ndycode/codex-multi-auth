import { describe, expect, it } from "vitest";
import {
	buildAuthDashboardViewModel,
	resolveAuthDashboardCommand,
} from "../lib/codex-manager/auth-ui-controller.js";

describe("auth ui controller seam", () => {
	it("builds renderer-agnostic dashboard sections and sorted account models", () => {
		const now = Date.now();
		const viewModel = buildAuthDashboardViewModel({
			storage: {
				version: 3,
				activeIndex: 2,
				activeIndexByFamily: { codex: 2 },
				accounts: [
					{
						email: "a@example.com",
						accountId: "acc_a",
						refreshToken: "refresh-a",
						accessToken: "access-a",
						expiresAt: now + 3_600_000,
						addedAt: now - 3_000,
						lastUsed: now - 3_000,
						enabled: true,
					},
					{
						email: "b@example.com",
						accountId: "acc_b",
						refreshToken: "refresh-b",
						accessToken: "access-b",
						expiresAt: now + 3_600_000,
						addedAt: now - 2_000,
						lastUsed: now - 2_000,
						enabled: true,
					},
					{
						email: "c@example.com",
						accountId: "acc_c",
						refreshToken: "refresh-c",
						accessToken: "access-c",
						expiresAt: now + 3_600_000,
						addedAt: now - 1_000,
						lastUsed: now - 1_000,
						enabled: true,
					},
				],
			},
			quotaCache: {
				byAccountId: {},
				byEmail: {
					"a@example.com": {
						updatedAt: now,
						status: 200,
						model: "gpt-5-codex",
						primary: { usedPercent: 80, windowMinutes: 300, resetAtMs: now + 1_000 },
						secondary: { usedPercent: 80, windowMinutes: 10080, resetAtMs: now + 2_000 },
					},
					"b@example.com": {
						updatedAt: now,
						status: 200,
						model: "gpt-5-codex",
						primary: { usedPercent: 0, windowMinutes: 300, resetAtMs: now + 1_000 },
						secondary: { usedPercent: 0, windowMinutes: 10080, resetAtMs: now + 2_000 },
					},
					"c@example.com": {
						updatedAt: now,
						status: 200,
						model: "gpt-5-codex",
						primary: { usedPercent: 60, windowMinutes: 300, resetAtMs: now + 1_000 },
						secondary: { usedPercent: 60, windowMinutes: 10080, resetAtMs: now + 2_000 },
					},
				},
			},
			displaySettings: {
				showPerAccountRows: true,
				showQuotaDetails: true,
				showForecastReasons: true,
				showRecommendations: true,
				showLiveProbeNotes: true,
				menuAutoFetchLimits: true,
				menuSortEnabled: true,
				menuSortMode: "ready-first",
				menuSortPinCurrent: true,
				menuSortQuickSwitchVisibleRow: true,
			},
			flaggedCount: 2,
			statusMessage: "Loading live limits...",
		});

		expect(viewModel.sections.map((section) => section.id)).toEqual([
			"quick-actions",
			"advanced-checks",
			"saved-accounts",
			"danger-zone",
		]);
		expect(viewModel.sections[0]?.actions.map((action) => action.id)).toEqual([
			"add",
			"check",
			"forecast",
			"fix",
			"settings",
		]);
		expect(viewModel.sections[1]?.actions.map((action) => action.id)).toEqual([
			"deep-check",
			"verify-flagged",
		]);
		expect(viewModel.menuOptions.flaggedCount).toBe(2);
		expect(viewModel.menuOptions.statusMessage).toBe("Loading live limits...");
		expect(viewModel.accounts.map((account) => account.email)).toEqual([
			"b@example.com",
			"c@example.com",
			"a@example.com",
		]);
		expect(viewModel.accounts.map((account) => account.index)).toEqual([0, 1, 2]);
		expect(viewModel.accounts.map((account) => account.sourceIndex)).toEqual([1, 2, 0]);
		expect(viewModel.accounts.map((account) => account.quickSwitchNumber)).toEqual([1, 2, 3]);
		expect(viewModel.accounts[1]?.isCurrentAccount).toBe(true);
	});

	it("maps login menu outcomes into renderer-agnostic commands", () => {
		expect(resolveAuthDashboardCommand({ mode: "settings" })).toEqual({
			type: "open-settings",
		});
		expect(resolveAuthDashboardCommand({ mode: "check" })).toEqual({
			type: "run-health-check",
			panel: { title: "Quick Check", stage: "Checking local session + live status" },
			forceRefresh: false,
			liveProbe: true,
		});
		expect(resolveAuthDashboardCommand({ mode: "manage", refreshAccountIndex: 1 })).toEqual({
			type: "manage-account",
			menuResult: { mode: "manage", refreshAccountIndex: 1 },
			requiresInlineFlow: true,
			panel: undefined,
		});
		expect(resolveAuthDashboardCommand({ mode: "manage", switchAccountIndex: 2 })).toEqual({
			type: "manage-account",
			menuResult: { mode: "manage", switchAccountIndex: 2 },
			requiresInlineFlow: false,
			panel: { title: "Applying Change", stage: "Updating selected account" },
		});
	});
});
