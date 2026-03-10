import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthDashboardViewModel } from "../lib/codex-manager/auth-ui-controller.js";
import {
	createAuthInkShellFocusState,
	reduceAuthInkShellFocus,
	startInkAuthShell,
} from "../lib/ui-ink/index.js";

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
	stream.setRawMode = vi.fn();
	stream.ref = vi.fn();
	stream.unref = vi.fn();
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

function stripAnsi(value: string): string {
	return value.replace(new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g"), "");
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ink auth shell", () => {
	it("renders the auth shell frame, sections, and current panel rows", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const chunks: string[] = [];
		output.on("data", (chunk) => {
			chunks.push(chunk.toString());
		});

		const dashboard = createDashboardViewModel();
		const app = startInkAuthShell({
			dashboard,
			env: {},
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		expect(app).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 50));
		app?.unmount();
		app?.cleanup();
		await new Promise((resolve) => setTimeout(resolve, 20));

		const rendered = stripAnsi(chunks.join(""));
		expect(rendered).toContain("Accounts Dashboard");
		expect(rendered).toContain("Loading live limits...");
		expect(rendered).toContain("Quick Actions");
		expect(rendered).toContain("Advanced Checks");
		expect(rendered).toContain("Saved Accounts");
		expect(rendered).toContain("Danger Zone");
		expect(rendered).toContain("Add New Account");
	});

	it("moves focus across sections and rebinds entry focus for saved accounts", () => {
		const dashboard = createDashboardViewModel();
		const initial = createAuthInkShellFocusState(dashboard);
		expect(initial).toEqual({ sectionIndex: 0, entryIndex: 0 });

		const advanced = reduceAuthInkShellFocus(dashboard, initial, {
			type: "move-section",
			direction: 1,
		});
		expect(advanced).toEqual({ sectionIndex: 1, entryIndex: 0 });

		const savedAccounts = reduceAuthInkShellFocus(dashboard, advanced, {
			type: "move-section",
			direction: 1,
		});
		expect(savedAccounts).toEqual({ sectionIndex: 2, entryIndex: 0 });

		const nextAccount = reduceAuthInkShellFocus(dashboard, savedAccounts, {
			type: "move-entry",
			direction: 1,
		});
		expect(nextAccount).toEqual({ sectionIndex: 2, entryIndex: 1 });

		const reset = reduceAuthInkShellFocus(dashboard, nextAccount, { type: "reset" });
		expect(reset).toEqual({ sectionIndex: 0, entryIndex: 0 });
	});
});
