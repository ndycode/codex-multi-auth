import { describe, expect, it, vi } from "vitest";
import { applyAccountStorageScopeFromConfig } from "../lib/runtime/storage-scope.js";

describe("storage scope helper", () => {
	it("forces global storage under codex cli sync and warns once", () => {
		const setWarningShown = vi.fn();
		const setStoragePath = vi.fn();
		const logWarn = vi.fn();

		applyAccountStorageScopeFromConfig({} as never, {
			getPerProjectAccounts: () => true,
			getStorageBackupEnabled: () => true,
			setStorageBackupEnabled: vi.fn(),
			isCodexCliSyncEnabled: () => true,
			getWarningShown: () => false,
			setWarningShown,
			logWarn,
			pluginName: "plugin",
			setStoragePath,
			cwd: () => "/tmp/project",
		});

		expect(setWarningShown).toHaveBeenCalledWith(true);
		expect(setStoragePath).toHaveBeenCalledWith(null);
		expect(logWarn).toHaveBeenCalled();
	});

	it("uses per-project path when sync is disabled", () => {
		const setStoragePath = vi.fn();

		applyAccountStorageScopeFromConfig({} as never, {
			getPerProjectAccounts: () => true,
			getStorageBackupEnabled: () => false,
			setStorageBackupEnabled: vi.fn(),
			isCodexCliSyncEnabled: () => false,
			getWarningShown: () => false,
			setWarningShown: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
			setStoragePath,
			cwd: () => "/tmp/project",
		});

		expect(setStoragePath).toHaveBeenCalledWith("/tmp/project");
	});
});
