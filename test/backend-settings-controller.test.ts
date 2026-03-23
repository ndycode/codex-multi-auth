import { describe, expect, it, vi } from "vitest";
import { configureBackendSettingsController } from "../lib/codex-manager/backend-settings-controller.js";
import type { PluginConfig } from "../lib/types.js";

function createConfig(): PluginConfig {
	return {
		fetchTimeoutMs: 1000,
	};
}

describe("backend settings controller", () => {
	it("returns current config in non-interactive mode", async () => {
		const current = createConfig();
		const result = await configureBackendSettingsController(current, {
			cloneBackendPluginConfig: (config) => ({ ...config }),
			loadPluginConfig: () => createConfig(),
			promptBackendSettings: vi.fn(),
			backendSettingsEqual: (left, right) =>
				left.fetchTimeoutMs === right.fetchTimeoutMs,
			persistBackendConfigSelection: vi.fn(),
			isInteractive: () => false,
			writeLine: vi.fn(),
		});

		expect(result.fetchTimeoutMs).toBe(1000);
	});

	it("returns current config when prompt is cancelled or unchanged", async () => {
		const current = createConfig();
		const deps = {
			cloneBackendPluginConfig: (config: PluginConfig) => ({ ...config }),
			loadPluginConfig: () => createConfig(),
			backendSettingsEqual: (left: PluginConfig, right: PluginConfig) =>
				left.fetchTimeoutMs === right.fetchTimeoutMs,
			persistBackendConfigSelection: vi.fn(
				async (config: PluginConfig) => config,
			),
			isInteractive: () => true,
			writeLine: vi.fn(),
		};

		const cancelled = await configureBackendSettingsController(current, {
			...deps,
			promptBackendSettings: async () => null,
		});
		expect(cancelled.fetchTimeoutMs).toBe(1000);

		const unchanged = await configureBackendSettingsController(current, {
			...deps,
			promptBackendSettings: async () => ({ fetchTimeoutMs: 1000 }),
		});
		expect(unchanged.fetchTimeoutMs).toBe(1000);
	});

	it("persists changed backend config", async () => {
		const persistBackendConfigSelection = vi.fn(
			async (config: PluginConfig) => config,
		);
		const result = await configureBackendSettingsController(createConfig(), {
			cloneBackendPluginConfig: (config) => ({ ...config }),
			loadPluginConfig: () => createConfig(),
			promptBackendSettings: async () => ({ fetchTimeoutMs: 2000 }),
			backendSettingsEqual: (left, right) =>
				left.fetchTimeoutMs === right.fetchTimeoutMs,
			persistBackendConfigSelection,
			isInteractive: () => true,
			writeLine: vi.fn(),
		});

		expect(persistBackendConfigSelection).toHaveBeenCalledWith(
			{ fetchTimeoutMs: 2000 },
			"backend",
		);
		expect(result.fetchTimeoutMs).toBe(2000);
	});
});
