import { describe, expect, it } from "vitest";
import {
	buildAuthAccountDetailViewModel,
	buildAuthDashboardScreenState,
	buildAuthDashboardViewModel,
	resolveAuthAccountDetailSelection,
	resolveAuthDashboardCommand,
	resolveAuthDashboardSelection,
	settleAuthConfirmation,
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

	it("builds a renderer-agnostic screen state with default detail-pane data", () => {
		const now = Date.now();
		const state = buildAuthDashboardScreenState({
			storage: {
				version: 3,
				activeIndex: 1,
				activeIndexByFamily: { codex: 1 },
				accounts: [
					{
						email: "a@example.com",
						accountId: "acc_a",
						refreshToken: "refresh-a",
						accessToken: "access-a",
						expiresAt: now + 3_600_000,
						addedAt: now - 2_000,
						lastUsed: now - 2_000,
						enabled: true,
					},
					{
						email: "b@example.com",
						accountId: "acc_b",
						refreshToken: "refresh-b",
						accessToken: "access-b",
						expiresAt: now + 3_600_000,
						addedAt: now - 1_000,
						lastUsed: now - 1_000,
						enabled: true,
					},
				],
			},
			quotaCache: null,
			displaySettings: {
				showPerAccountRows: true,
				showQuotaDetails: true,
				showForecastReasons: true,
				showRecommendations: true,
				showLiveProbeNotes: true,
			},
		});

		expect(state.selectedAccountIndex).toBe(0);
		expect(state.detailPane?.account.email).toBe("b@example.com");
		expect(state.detailPane?.actions.map((action) => action.id)).toEqual([
			"back",
			"toggle",
			"set-current",
			"refresh",
			"delete",
		]);
		expect(state.modal).toBeNull();
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

	it("resolves auth dashboard selections, detail actions, and modal confirmations outside the renderer", () => {
		const account = {
			index: 0,
			sourceIndex: 3,
			quickSwitchNumber: 4,
			email: "sorted@example.com",
			status: "active" as const,
			enabled: true,
		};

		expect(resolveAuthDashboardSelection({ type: "set-current-account", account })).toEqual({
			type: "result",
			result: { mode: "manage", switchAccountIndex: 3 },
		});

		const detailResolution = resolveAuthDashboardSelection({ type: "select-account", account });
		if (detailResolution.type !== "detail") {
			throw new Error("expected detail resolution");
		}
		expect(detailResolution.detail.title).toContain("sorted@example.com");

		const modalResolution = resolveAuthAccountDetailSelection(account, "refresh");
		if (modalResolution.type !== "confirm") {
			throw new Error("expected confirm resolution");
		}
		expect(modalResolution.modal.id).toBe("refresh-account");
		expect(settleAuthConfirmation(modalResolution.modal, false)).toEqual({ type: "continue" });
		expect(settleAuthConfirmation(modalResolution.modal, true)).toEqual({
			type: "result",
			result: { mode: "manage", refreshAccountIndex: 3 },
		});

		expect(resolveAuthDashboardSelection({ type: "delete-all" })).toEqual({
			type: "confirm",
			modal: {
				id: "delete-all",
				message: "Delete all accounts?",
				confirmStyle: "typed-delete",
				result: { mode: "fresh", deleteAll: true },
				cancelMessage: "\nDelete all cancelled.\n",
			},
		});
	});

	it("builds detail-pane view models without renderer dependencies", () => {
		const detail = buildAuthAccountDetailViewModel({
			index: 1,
			quickSwitchNumber: 2,
			email: "detail@example.com",
			status: "disabled",
			enabled: false,
			addedAt: 1,
			lastUsed: 1,
		});

		expect(detail.title).toContain("detail@example.com");
		expect(detail.title).toContain("[disabled]");
		expect(detail.actions[1]).toEqual({ id: "toggle", label: "Enable Account", tone: "green" });
	});
});
