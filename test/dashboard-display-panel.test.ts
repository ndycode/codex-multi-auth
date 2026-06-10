import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
} from "../lib/dashboard-settings.js";
import { UI_COPY } from "../lib/ui/ui-copy.js";
import {
	type DashboardDisplayPanelDeps,
	promptDashboardDisplayPanel,
} from "../lib/codex-manager/dashboard-display-panel.js";

// Shared mock group (test/helpers/cli-test-fixtures.ts). This suite imports
// the panel under test statically, so the mocked-module factories run while
// the imports above evaluate — the mocks must be created inside vi.hoisted
// (which also resolves the helper itself) rather than in module-level consts.
// getUiRuntimeOptions stays bespoke: only this suite mocks the UI runtime
// options provider, so it has no shared factory.
const { uiMocks, getUiRuntimeOptionsMock } = await vi.hoisted(async () => {
	const fixtures = await import("./helpers/cli-test-fixtures.js");
	return {
		uiMocks: fixtures.createUiPromptMocks(),
		getUiRuntimeOptionsMock: vi.fn(() => ({ theme: "test-theme" })),
	};
});

vi.mock("../lib/ui/select.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).uiSelectModuleMock(uiMocks),
);

vi.mock("../lib/ui/runtime.js", () => ({
	getUiRuntimeOptions: getUiRuntimeOptionsMock,
}));

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(
	process.stdin,
	"isTTY",
);
const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(
	process.stdout,
	"isTTY",
);

const DASHBOARD_DISPLAY_OPTIONS: DashboardDisplayPanelDeps["DASHBOARD_DISPLAY_OPTIONS"] =
	[
		{
			key: "menuShowStatusBadge",
			label: "Show Status Badges",
			description: "Show [ok], [active], and similar badges.",
		},
		{
			key: "menuShowCurrentBadge",
			label: "Show [current]",
			description: "Mark the account active in Codex.",
		},
		{
			key: "menuShowFetchStatus",
			label: "Show Fetch Status",
			description: "Show background limit refresh status in the menu subtitle.",
		},
	];

const ACCOUNT_LIST_PANEL_KEYS: DashboardDisplayPanelDeps["ACCOUNT_LIST_PANEL_KEYS"] = [
	"menuShowStatusBadge",
	"menuShowCurrentBadge",
	"menuShowFetchStatus",
	"menuSortMode",
	"menuSortEnabled",
	"menuLayoutMode",
	"menuShowDetailsForUnselectedRows",
];

function setInteractiveTTY(enabled: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", {
		value: enabled,
		configurable: true,
	});
	Object.defineProperty(process.stdout, "isTTY", {
		value: enabled,
		configurable: true,
	});
}

function restoreTTYDescriptors(): void {
	if (stdinIsTTYDescriptor) {
		Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
	} else {
		delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
	}

	if (stdoutIsTTYDescriptor) {
		Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
	} else {
		delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
	}
}

function createSettings(
	overrides: Partial<DashboardDisplaySettings> = {},
): DashboardDisplaySettings {
	return {
		...DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		...overrides,
	};
}

function buildDeps(): DashboardDisplayPanelDeps {
	return {
		cloneDashboardSettings: (settings) => ({ ...settings }),
		buildAccountListPreview: (_settings, _ui, focusKey) => ({
			label: `Preview: ${focusKey}`,
			hint: "Preview hint",
		}),
		formatDashboardSettingState: (enabled) => (enabled ? "[x]" : "[ ]"),
		formatMenuSortMode: (mode) =>
			mode === "ready-first" ? "Ready-First" : "Manual",
		resolveMenuLayoutMode: (settings) => {
			if (settings.menuLayoutMode === "expanded-rows") {
				return "expanded-rows";
			}
			if (settings.menuLayoutMode === "compact-details") {
				return "compact-details";
			}
			return settings.menuShowDetailsForUnselectedRows === true
				? "expanded-rows"
				: "compact-details";
		},
		formatMenuLayoutMode: (mode) =>
			mode === "expanded-rows"
				? "Expanded Rows"
				: "Compact + Details Pane",
		applyDashboardDefaultsForKeys: (draft, keys) => {
			const next = { ...draft };
			for (const key of keys) {
				next[key] = DEFAULT_DASHBOARD_DISPLAY_SETTINGS[key];
			}
			return next;
		},
		DASHBOARD_DISPLAY_OPTIONS,
		ACCOUNT_LIST_PANEL_KEYS,
		UI_COPY,
	};
}

describe("promptDashboardDisplayPanel", () => {
	beforeEach(() => {
		uiMocks.select.mockReset();
		getUiRuntimeOptionsMock.mockClear();
		setInteractiveTTY(true);
	});

	afterEach(() => {
		restoreTTYDescriptors();
	});

	it("returns null without TTY access", async () => {
		setInteractiveTTY(false);

		const result = await promptDashboardDisplayPanel(createSettings(), buildDeps());

		expect(result).toBeNull();
		expect(uiMocks.select).not.toHaveBeenCalled();
	});

	it("toggles a display flag and saves the draft", async () => {
		uiMocks.select
			.mockResolvedValueOnce({
				type: "toggle",
				key: "menuShowStatusBadge",
			})
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptDashboardDisplayPanel(createSettings(), buildDeps());

		expect(result?.menuShowStatusBadge).toBe(false);
		expect(uiMocks.select).toHaveBeenCalledTimes(2);
	});

	it("resets changed values back to dashboard defaults", async () => {
		uiMocks.select
			.mockResolvedValueOnce({
				type: "toggle",
				key: "menuShowStatusBadge",
			})
			.mockResolvedValueOnce({ type: "reset" })
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptDashboardDisplayPanel(createSettings(), buildDeps());

		expect(result?.menuShowStatusBadge).toBe(
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowStatusBadge,
		);
	});

	it("cycles the sort mode and re-enables smart sort when switching to ready-first", async () => {
		uiMocks.select
			.mockResolvedValueOnce({ type: "cycle-sort-mode" })
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptDashboardDisplayPanel(
			createSettings({
				menuSortMode: "manual",
				menuSortEnabled: false,
			}),
			buildDeps(),
		);

		expect(result?.menuSortMode).toBe("ready-first");
		expect(result?.menuSortEnabled).toBe(true);
	});

	it("cycles the layout mode and syncs the details-pane flag", async () => {
		uiMocks.select
			.mockResolvedValueOnce({ type: "cycle-layout-mode" })
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptDashboardDisplayPanel(
			createSettings({
				menuLayoutMode: "compact-details",
				menuShowDetailsForUnselectedRows: false,
			}),
			buildDeps(),
		);

		expect(result?.menuLayoutMode).toBe("expanded-rows");
		expect(result?.menuShowDetailsForUnselectedRows).toBe(true);
	});

	it("returns null when the panel is cancelled", async () => {
		uiMocks.select.mockResolvedValueOnce({ type: "cancel" });

		const result = await promptDashboardDisplayPanel(createSettings(), buildDeps());

		expect(result).toBeNull();
	});
});
