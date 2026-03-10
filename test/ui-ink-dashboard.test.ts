import { describe, expect, it } from "vitest";
import { buildAuthDashboardViewModel } from "../lib/codex-manager/auth-ui-controller.js";
import {
	filterAuthInkDashboardAccounts,
	promptInkAuthDashboard,
	resolveAuthInkQuickSwitch,
} from "../lib/ui-ink/index.js";
import { PassThrough } from "node:stream";

function createMockInput(): NodeJS.ReadStream {
	const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
		setRawMode: (value: boolean) => void;
		ref: () => void;
		unref: () => void;
	};
	Object.defineProperty(stream, "isTTY", {
		value: true,
		configurable: true,
	});
	stream.setRawMode = () => undefined;
	stream.ref = () => undefined;
	stream.unref = () => undefined;
	return stream;
}

function createMockOutput(): NodeJS.WriteStream {
	const stream = new PassThrough() as PassThrough & NodeJS.WriteStream;
	Object.defineProperty(stream, "isTTY", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(stream, "columns", {
		value: 120,
		configurable: true,
	});
	Object.defineProperty(stream, "rows", {
		value: 40,
		configurable: true,
	});
	return stream;
}

function createDashboardViewModel() {
	const now = Date.now();
	return buildAuthDashboardViewModel({
		storage: {
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "acc_alpha",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 3_600_000,
					addedAt: now - 4_000,
					lastUsed: now - 4_000,
					enabled: true,
				},
				{
					email: "beta@example.com",
					accountId: "acc_beta",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
			],
		},
		quotaCache: {
			byAccountId: {},
			byEmail: {
				"alpha@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 30, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 60, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
				"beta@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 20, windowMinutes: 10080, resetAtMs: now + 2_000 },
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
		flaggedCount: 1,
		statusMessage: "Loading live limits...",
	});
}

describe("ink auth dashboard", () => {
	it("filters saved accounts using the inline search query", () => {
		const dashboard = createDashboardViewModel();
		expect(filterAuthInkDashboardAccounts(dashboard, "beta").map((account) => account.email)).toEqual([
			"beta@example.com",
		]);
		expect(filterAuthInkDashboardAccounts(dashboard, "1").map((account) => account.quickSwitchNumber)).toEqual([1]);
	});

	it("resolves quick-switch hotkeys from visible account rows and ignores duplicates", () => {
		const dashboard = createDashboardViewModel();
		expect(resolveAuthInkQuickSwitch(dashboard, "", "2")).toEqual({
			mode: "manage",
			switchAccountIndex: 0,
		});

		const duplicateDashboard = {
			...dashboard,
			accounts: dashboard.accounts.map((account) => ({ ...account, quickSwitchNumber: 2 })),
		};
		expect(resolveAuthInkQuickSwitch(duplicateDashboard, "", "2")).toBeNull();
	});

	it("returns a quick-switch result from live Ink input", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const dashboard = createDashboardViewModel();

		const resultPromise = promptInkAuthDashboard({
			dashboard,
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		await new Promise((resolve) => setTimeout(resolve, 30));
		input.push("2");

		await expect(resultPromise).resolves.toEqual({
			mode: "manage",
			switchAccountIndex: 0,
		});
	});
});
