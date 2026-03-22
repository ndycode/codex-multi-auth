import { describe, expect, it, vi } from "vitest";
import { promptExperimentalSettingsEntry } from "../lib/codex-manager/experimental-settings-entry.js";

describe("experimental settings entry", () => {
	it("passes all dependencies through to the experimental settings prompt helper", async () => {
		const promptExperimentalSettingsMenu = vi.fn(async () => ({
			fetchTimeoutMs: 1000,
		}));

		const result = await promptExperimentalSettingsEntry({
			initialConfig: { fetchTimeoutMs: 2000 },
			promptExperimentalSettingsMenu,
			isInteractive: () => true,
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: vi.fn((config) => config),
			select: vi.fn(),
			getExperimentalSelectOptions: vi.fn(() => ({})),
			mapExperimentalMenuHotkey: vi.fn(),
			mapExperimentalStatusHotkey: vi.fn(),
			formatDashboardSettingState: vi.fn((enabled) => (enabled ? "on" : "off")),
			copy: {},
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

		expect(promptExperimentalSettingsMenu).toHaveBeenCalled();
		expect(result).toEqual({ fetchTimeoutMs: 1000 });
	});
});
