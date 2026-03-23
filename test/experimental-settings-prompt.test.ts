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
});
