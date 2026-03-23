import { describe, expect, it, vi } from "vitest";
import { promptExperimentalSettingsEntry } from "../lib/codex-manager/experimental-settings-entry.js";

describe("experimental settings entry", () => {
	it("passes all dependencies through to the experimental settings prompt helper", async () => {
		const promptExperimentalSettingsMenu = vi.fn(async () => ({
			fetchTimeoutMs: 1000,
		}));
		const menuDeps = {
			isInteractive: () => true,
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: vi.fn((config) => config),
			select: vi.fn(),
			getExperimentalSelectOptions: vi.fn(() => ({})),
			mapExperimentalMenuHotkey: vi.fn(),
			mapExperimentalStatusHotkey: vi.fn(),
			formatDashboardSettingState: vi.fn((enabled) => (enabled ? "on" : "off")),
			copy: {
				experimentalSync: "Sync",
				experimentalBackup: "Backup",
				experimentalRefreshGuard: "Refresh guard",
				experimentalRefreshInterval: "Refresh interval",
				experimentalDecreaseInterval: "Decrease interval",
				experimentalIncreaseInterval: "Increase interval",
				saveAndBack: "Save",
				backNoSave: "Back",
				experimentalHelpMenu: "Help menu",
				experimentalBackupPrompt: "Backup prompt",
				back: "Back",
				experimentalHelpStatus: "Help status",
				experimentalApplySync: "Apply sync",
				experimentalHelpPreview: "Help preview",
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
		};
		const initialConfig = { fetchTimeoutMs: 2000 };

		const result = await promptExperimentalSettingsEntry({
			initialConfig,
			promptExperimentalSettingsMenu,
			...menuDeps,
		});

		expect(promptExperimentalSettingsMenu).toHaveBeenCalledWith({
			initialConfig,
			...menuDeps,
		});
		expect(result).toEqual({ fetchTimeoutMs: 1000 });
	});
});
