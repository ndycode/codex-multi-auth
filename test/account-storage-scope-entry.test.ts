import { describe, expect, it, vi } from "vitest";
import { applyAccountStorageScopeEntry } from "../lib/runtime/account-storage-scope-entry.js";

describe("account storage scope entry", () => {
	it("delegates to the config-based storage scope helper with all injected deps", () => {
		const applyAccountStorageScopeFromConfig = vi.fn();
		applyAccountStorageScopeEntry({
			pluginConfig: {} as never,
			getPerProjectAccounts: vi.fn(() => true),
			getStorageBackupEnabled: vi.fn(() => true),
			setStorageBackupEnabled: vi.fn(),
			isCodexCliSyncEnabled: vi.fn(() => false),
			getWarningShown: vi.fn(() => false),
			setWarningShown: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
			setStoragePath: vi.fn(),
			cwd: vi.fn(() => "/tmp/project"),
			applyAccountStorageScopeFromConfig,
		});

		expect(applyAccountStorageScopeFromConfig).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				getPerProjectAccounts: expect.any(Function),
				getStorageBackupEnabled: expect.any(Function),
				setStorageBackupEnabled: expect.any(Function),
				isCodexCliSyncEnabled: expect.any(Function),
				getWarningShown: expect.any(Function),
				setWarningShown: expect.any(Function),
				logWarn: expect.any(Function),
				pluginName: "plugin",
				setStoragePath: expect.any(Function),
				cwd: expect.any(Function),
			}),
		);
	});
});
