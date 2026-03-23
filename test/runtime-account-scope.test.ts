import { describe, expect, it, vi } from "vitest";
import { applyAccountStorageScope } from "../lib/runtime/account-scope.js";

describe("runtime account scope", () => {
	function createDeps(overrides: {
		perProjectAccounts?: boolean;
		storageBackupEnabled?: boolean;
		codexCliSyncEnabled?: boolean;
		cwd?: string;
	} = {}) {
		const order: string[] = [];
		return {
			order,
			deps: {
				getPerProjectAccounts: vi
					.fn()
					.mockReturnValue(overrides.perProjectAccounts ?? false),
				getStorageBackupEnabled: vi
					.fn()
					.mockReturnValue(overrides.storageBackupEnabled ?? true),
				isCodexCliSyncEnabled: vi
					.fn()
					.mockReturnValue(overrides.codexCliSyncEnabled ?? false),
				setStorageBackupEnabled: vi.fn((enabled: boolean) => {
					order.push(`backup:${enabled}`);
				}),
				setStoragePath: vi.fn((path: string | null) => {
					order.push(`path:${path ?? "null"}`);
				}),
				getCwd: vi
					.fn()
					.mockReturnValue(overrides.cwd ?? "C:\\repo\\linked-worktree"),
				warnPerProjectSyncConflict: vi.fn(() => {
					order.push("warn");
				}),
			},
		};
	}

	it("warns and forces global storage when CLI sync is enabled for per-project accounts", () => {
		const { deps, order } = createDeps({
			perProjectAccounts: true,
			storageBackupEnabled: false,
			codexCliSyncEnabled: true,
		});

		applyAccountStorageScope({}, deps);

		expect(deps.setStorageBackupEnabled).toHaveBeenCalledWith(false);
		expect(deps.warnPerProjectSyncConflict).toHaveBeenCalledTimes(1);
		expect(deps.setStoragePath).toHaveBeenCalledWith(null);
		expect(order).toEqual(["backup:false", "warn", "path:null"]);
	});

	it("uses global storage without warning when CLI sync is enabled for shared accounts", () => {
		const { deps, order } = createDeps({
			perProjectAccounts: false,
			storageBackupEnabled: true,
			codexCliSyncEnabled: true,
		});

		applyAccountStorageScope({}, deps);

		expect(deps.warnPerProjectSyncConflict).not.toHaveBeenCalled();
		expect(deps.setStoragePath).toHaveBeenCalledWith(null);
		expect(order).toEqual(["backup:true", "path:null"]);
	});

	it("targets a Windows-style cwd when per-project storage is enabled without CLI sync", () => {
		const { deps, order } = createDeps({
			perProjectAccounts: true,
			codexCliSyncEnabled: false,
			cwd: "C:\\repo\\wt\\feature",
		});

		applyAccountStorageScope({}, deps);

		expect(deps.setStoragePath).toHaveBeenCalledWith("C:\\repo\\wt\\feature");
		expect(order).toEqual(["backup:true", "path:C:\\repo\\wt\\feature"]);
	});

	it("falls back to the shared storage path when per-project storage is disabled", () => {
		const { deps, order } = createDeps({
			perProjectAccounts: false,
			codexCliSyncEnabled: false,
		});

		applyAccountStorageScope({}, deps);

		expect(deps.warnPerProjectSyncConflict).not.toHaveBeenCalled();
		expect(deps.setStoragePath).toHaveBeenCalledWith(null);
		expect(order).toEqual(["backup:true", "path:null"]);
	});

	it("keeps backup updates ahead of path writes across repeated calls", () => {
		const { deps, order } = createDeps({
			perProjectAccounts: true,
			codexCliSyncEnabled: false,
			cwd: "C:\\repo\\wt\\repeated",
		});

		applyAccountStorageScope({}, deps);
		applyAccountStorageScope({}, deps);

		expect(order).toEqual([
			"backup:true",
			"path:C:\\repo\\wt\\repeated",
			"backup:true",
			"path:C:\\repo\\wt\\repeated",
		]);
	});
});
