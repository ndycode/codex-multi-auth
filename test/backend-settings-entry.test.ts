import { describe, expect, it, vi } from "vitest";
import { configureBackendSettingsEntry } from "../lib/codex-manager/backend-settings-entry.js";

describe("backend settings entry", () => {
	it("delegates to backend settings controller with provided deps", async () => {
		const configureBackendSettingsController = vi.fn(async () => ({
			fetchTimeoutMs: 2000,
		}));
		const result = await configureBackendSettingsEntry(undefined, {
			configureBackendSettingsController,
			cloneBackendPluginConfig: vi.fn((config) => config),
			loadPluginConfig: vi.fn(() => ({ fetchTimeoutMs: 1000 })),
			promptBackendSettings: vi.fn(),
			backendSettingsEqual: vi.fn(() => false),
			persistBackendConfigSelection: vi.fn(),
			isInteractive: vi.fn(() => true),
			writeLine: vi.fn(),
		});

		expect(configureBackendSettingsController).toHaveBeenCalled();
		expect(result).toEqual({ fetchTimeoutMs: 2000 });
	});
});
