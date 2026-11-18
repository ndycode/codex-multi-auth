import { describe, expect, it, vi } from "vitest";
import { promptExperimentalSettingsMenu } from "../lib/codex-manager/experimental-settings-prompt.js";

describe("experimental settings prompt", () => {
	it("returns null when not interactive", async () => {
		const result = await promptExperimentalSettingsMenu({
			initialConfig: { proactiveRefreshGuardian: false },
			isInteractive: () => false,
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: (config) => ({ ...config }),
			select: vi.fn(),
			getExperimentalSelectOptions: vi.fn(() => ({})),
			mapExperimentalMenuHotkey: vi.fn(),
			mapExperimentalStatusHotkey: vi.fn(),
			formatDashboardSettingState: (enabled) => (enabled ? "on" : "off"),
			copy: {
				experimentalSync: "Sync",
				experimentalBackup: "Backup",
				experimentalRefreshGuard: "Guard",
				experimentalRefreshInterval: "Interval",
				experimentalDecreaseInterval: "Dec",
				experimentalIncreaseInterval: "Inc",
				saveAndBack: "Save",
				backNoSave: "Back",
				experimentalHelpMenu: "help",
				experimentalBackupPrompt: "name",
				back: "Back",
				experimentalHelpStatus: "status",
				experimentalApplySync: "Apply",
				experimentalHelpPreview: "preview",
			},
			input: process.stdin,
			output: process.stdout,
			runNamedBackupExport: vi.fn(),
			loadAccounts: vi.fn(),
			loadExperimentalSyncTarget: vi.fn(),
			planOcChatgptSync: vi.fn(),
			applyOcChatgptSync: vi.fn(),
			getTargetKind: vi.fn(),
			getTargetDestination: vi.fn(),
			getTargetDetection: vi.fn(),
			getTargetErrorMessage: vi.fn(),
			getPlanKind: vi.fn(),
			getPlanBlockedReason: vi.fn(),
			getPlanPreview: vi.fn(),
			getAppliedLabel: vi.fn(),
		});

		expect(result).toBeNull();
	});

	it("returns draft on save and toggles guardian", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce({ type: "toggle-refresh-guardian" })
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptExperimentalSettingsMenu({
			initialConfig: {
				proactiveRefreshGuardian: false,
				proactiveRefreshIntervalMs: 60000,
			},
			isInteractive: () => true,
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: (config) => ({ ...config }),
			select,
			getExperimentalSelectOptions: vi.fn(() => ({})),
			mapExperimentalMenuHotkey: vi.fn(),
			mapExperimentalStatusHotkey: vi.fn(),
			formatDashboardSettingState: (enabled) => (enabled ? "on" : "off"),
			copy: {
				experimentalSync: "Sync",
				experimentalBackup: "Backup",
				experimentalRefreshGuard: "Guard",
				experimentalRefreshInterval: "Interval",
				experimentalDecreaseInterval: "Dec",
				experimentalIncreaseInterval: "Inc",
				saveAndBack: "Save",
				backNoSave: "Back",
				experimentalHelpMenu: "help",
				experimentalBackupPrompt: "name",
				back: "Back",
				experimentalHelpStatus: "status",
				experimentalApplySync: "Apply",
				experimentalHelpPreview: "preview",
			},
			input: process.stdin,
			output: process.stdout,
			runNamedBackupExport: vi.fn(),
			loadAccounts: vi.fn(),
			loadExperimentalSyncTarget: vi.fn(),
			planOcChatgptSync: vi.fn(),
			applyOcChatgptSync: vi.fn(),
			getTargetKind: vi.fn(),
			getTargetDestination: vi.fn(),
			getTargetDetection: vi.fn(),
			getTargetErrorMessage: vi.fn(),
			getPlanKind: vi.fn(),
			getPlanBlockedReason: vi.fn(),
			getPlanPreview: vi.fn(),
			getAppliedLabel: vi.fn(),
		});

		expect(result).toEqual({
			proactiveRefreshGuardian: true,
			proactiveRefreshIntervalMs: 60000,
		});
	});

	it("returns draft on save and toggles the context budget guard", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce({ type: "toggle-context-budget-guard" })
			.mockResolvedValueOnce({ type: "save" });

		const result = await promptExperimentalSettingsMenu({
			initialConfig: {
				proactiveRefreshGuardian: false,
				proactiveRefreshIntervalMs: 60000,
				contextBudgetGuardEnabled: false,
			},
			isInteractive: () => true,
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: (config) => ({ ...config }),
			select,
			getExperimentalSelectOptions: vi.fn(() => ({})),
			mapExperimentalMenuHotkey: vi.fn(),
			mapExperimentalStatusHotkey: vi.fn(),
			formatDashboardSettingState: (enabled) => (enabled ? "on" : "off"),
			copy: {
				experimentalSync: "Sync",
				experimentalBackup: "Backup",
				experimentalRefreshGuard: "Guard",
				experimentalRefreshInterval: "Interval",
				experimentalDecreaseInterval: "Dec",
				experimentalIncreaseInterval: "Inc",
				experimentalContextBudgetGuard: "Budget Guard",
				saveAndBack: "Save",
				backNoSave: "Back",
				experimentalHelpMenu: "help",
				experimentalBackupPrompt: "name",
				back: "Back",
				experimentalHelpStatus: "status",
				experimentalApplySync: "Apply",
				experimentalHelpPreview: "preview",
			},
			input: process.stdin,
			output: process.stdout,
			runNamedBackupExport: vi.fn(),
			loadAccounts: vi.fn(),
			loadExperimentalSyncTarget: vi.fn(),
			planOcChatgptSync: vi.fn(),
			applyOcChatgptSync: vi.fn(),
			getTargetKind: vi.fn(),
			getTargetDestination: vi.fn(),
			getTargetDetection: vi.fn(),
			getTargetErrorMessage: vi.fn(),
			getPlanKind: vi.fn(),
			getPlanBlockedReason: vi.fn(),
			getPlanPreview: vi.fn(),
			getAppliedLabel: vi.fn(),
		});

		expect(result).toEqual({
			proactiveRefreshGuardian: false,
			proactiveRefreshIntervalMs: 60000,
			contextBudgetGuardEnabled: true,
		});
	});

	it("renders the refresh-interval label at sub-minute granularity", async () => {
		const baseCopy = {
			experimentalSync: "Sync",
			experimentalBackup: "Backup",
			experimentalRefreshGuard: "Guard",
			experimentalRefreshInterval: "Interval",
			experimentalDecreaseInterval: "Dec",
			experimentalIncreaseInterval: "Inc",
			saveAndBack: "Save",
			backNoSave: "Back",
			experimentalHelpMenu: "help",
			experimentalBackupPrompt: "name",
			back: "Back",
			experimentalHelpStatus: "status",
			experimentalApplySync: "Apply",
			experimentalHelpPreview: "preview",
		};

		const renderIntervalLabel = async (intervalMs: number): Promise<string> => {
			let capturedItems: Array<{ label: string }> = [];
			const select = vi.fn(async (items: Array<{ label: string }>) => {
				capturedItems = items;
				return { type: "back" };
			});

			await promptExperimentalSettingsMenu({
				initialConfig: {
					proactiveRefreshGuardian: false,
					proactiveRefreshIntervalMs: intervalMs,
				},
				isInteractive: () => true,
				ui: { theme: {} } as never,
				cloneBackendPluginConfig: (config) => ({ ...config }),
				select: select as never,
				getExperimentalSelectOptions: vi.fn(() => ({})),
				mapExperimentalMenuHotkey: vi.fn(),
				mapExperimentalStatusHotkey: vi.fn(),
				formatDashboardSettingState: (enabled) => (enabled ? "on" : "off"),
				copy: baseCopy,
				input: process.stdin,
				output: process.stdout,
				runNamedBackupExport: vi.fn(),
				loadAccounts: vi.fn(),
				loadExperimentalSyncTarget: vi.fn(),
				planOcChatgptSync: vi.fn(),
				applyOcChatgptSync: vi.fn(),
				getTargetKind: vi.fn(),
				getTargetDestination: vi.fn(),
				getTargetDetection: vi.fn(),
				getTargetErrorMessage: vi.fn(),
				getPlanKind: vi.fn(),
				getPlanBlockedReason: vi.fn(),
				getPlanPreview: vi.fn(),
				getAppliedLabel: vi.fn(),
			});

			const intervalItem = capturedItems.find((item) =>
				item.label.startsWith(`${baseCopy.experimentalRefreshInterval}:`),
			);
			if (!intervalItem) {
				throw new Error("interval label not found in rendered menu");
			}
			return intervalItem.label;
		};

		// 25_000 ms used to render as "0 min"; 65_000 ms as "1 min" — both hid the
		// real sub-minute step value. The label must now reflect the actual value.
		const subMinuteLabel = await renderIntervalLabel(25_000);
		expect(subMinuteLabel).toBe("Interval: 25s");
		expect(subMinuteLabel).not.toContain("min");
		expect(subMinuteLabel).not.toContain("0 min");

		const overMinuteLabel = await renderIntervalLabel(65_000);
		expect(overMinuteLabel).toBe("Interval: 1m 5s");
		expect(overMinuteLabel).not.toBe("Interval: 1 min");
	});
});
