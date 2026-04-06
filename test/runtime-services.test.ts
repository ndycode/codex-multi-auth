import { describe, expect, it, vi } from "vitest";
import {
	ensureLiveAccountSyncState,
	ensureRefreshGuardianState,
	ensureSessionAffinityState,
} from "../lib/runtime/runtime-services.js";

describe("runtime services helpers", () => {
	it("disables and clears live sync when feature is off", async () => {
		const stop = vi.fn();
		const result = await ensureLiveAccountSyncState({
			enabled: false,
			targetPath: "/tmp/a",
			currentSync: { stop, syncToPath: vi.fn() },
			currentPath: "/tmp/old",
			currentConfigKey: "old",
			createSync: vi.fn(),
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(stop).toHaveBeenCalled();
		expect(result).toEqual({
			liveAccountSync: null,
			liveAccountSyncPath: null,
			liveAccountSyncConfigKey: null,
		});
	});

	it("clears stale live sync path and config key even when no watcher exists", async () => {
		const result = await ensureLiveAccountSyncState({
			enabled: false,
			targetPath: "/tmp/a",
			currentSync: null,
			currentPath: "/tmp/stale",
			currentConfigKey: "stale",
			createSync: vi.fn(),
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(result).toEqual({
			liveAccountSync: null,
			liveAccountSyncPath: null,
			liveAccountSyncConfigKey: null,
		});
	});

	it("creates and switches live sync path when enabled", async () => {
		const syncToPath = vi.fn(async () => undefined);
		const created = { stop: vi.fn(), syncToPath };
		const result = await ensureLiveAccountSyncState({
			enabled: true,
			targetPath: "/tmp/a",
			currentSync: null,
			currentPath: null,
			configKey: "25:250",
			createSync: vi.fn(() => created),
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(syncToPath).toHaveBeenCalledWith("/tmp/a");
		expect(result.liveAccountSync).toBe(created);
		expect(result.liveAccountSyncPath).toBe("/tmp/a");
		expect(result.liveAccountSyncConfigKey).toBe("25:250");
	});

	it("warns and keeps the previous path when busy retries are exhausted", async () => {
		vi.useFakeTimers();
		const error = new Error("busy") as NodeJS.ErrnoException;
		error.code = "EBUSY";
		const syncToPath = vi.fn(async () => {
			throw error;
		});
		const currentSync = { stop: vi.fn(), syncToPath };
		const logWarn = vi.fn();

		try {
			const resultPromise = ensureLiveAccountSyncState({
				enabled: true,
				targetPath: "/tmp/new",
				currentSync,
				currentPath: "/tmp/old",
				currentConfigKey: "old",
				createSync: vi.fn(),
				registerCleanup: vi.fn(),
				logWarn,
				pluginName: "plugin",
			});

			await vi.runAllTimersAsync();
			const result = await resultPromise;

			expect(syncToPath).toHaveBeenCalledTimes(3);
			expect(logWarn).toHaveBeenCalledWith(
				"[plugin] Live account sync path switch failed due to transient filesystem locks; keeping previous watcher.",
			);
			expect(result).toEqual({
				liveAccountSync: currentSync,
				liveAccountSyncPath: "/tmp/old",
				liveAccountSyncConfigKey: "old",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("recreates live sync when config key changes", async () => {
		const oldSync = { stop: vi.fn(), syncToPath: vi.fn() };
		const newSync = { stop: vi.fn(), syncToPath: vi.fn().mockResolvedValue(undefined) };
		const createSync = vi.fn(() => newSync);

		const result = await ensureLiveAccountSyncState({
			enabled: true,
			targetPath: "/tmp/a",
			currentSync: oldSync,
			currentPath: "/tmp/a",
			currentConfigKey: "25:250",
			configKey: "50:500",
			createSync,
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(oldSync.stop).toHaveBeenCalledTimes(1);
		expect(createSync).toHaveBeenCalledTimes(1);
		expect(newSync.syncToPath).toHaveBeenCalledWith("/tmp/a");
		expect(result.liveAccountSync).toBe(newSync);
		expect(result.liveAccountSyncConfigKey).toBe("50:500");
	});

	it("recreates live sync when the current config key is unknown", async () => {
		const oldSync = { stop: vi.fn(), syncToPath: vi.fn() };
		const newSync = { stop: vi.fn(), syncToPath: vi.fn().mockResolvedValue(undefined) };
		const createSync = vi.fn(() => newSync);

		const result = await ensureLiveAccountSyncState({
			enabled: true,
			targetPath: "/tmp/a",
			currentSync: oldSync,
			currentPath: "/tmp/a",
			currentConfigKey: null,
			configKey: "50:500",
			createSync,
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(oldSync.stop).toHaveBeenCalledTimes(1);
		expect(createSync).toHaveBeenCalledTimes(1);
		expect(result.liveAccountSync).toBe(newSync);
		expect(result.liveAccountSyncConfigKey).toBe("50:500");
	});

	it("keeps the existing watcher when configKey is undefined", async () => {
		const currentSync = { stop: vi.fn(), syncToPath: vi.fn().mockResolvedValue(undefined) };
		const result = await ensureLiveAccountSyncState({
			enabled: true,
			targetPath: "/tmp/a",
			currentSync,
			currentPath: "/tmp/a",
			currentConfigKey: "25:250",
			configKey: undefined,
			createSync: vi.fn(),
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(currentSync.stop).not.toHaveBeenCalled();
		expect(result.liveAccountSync).toBe(currentSync);
		expect(result.liveAccountSyncConfigKey).toBe("25:250");
	});

	it("recreates refresh guardian when config changes and clears when disabled", () => {
		const oldGuardian = { stop: vi.fn(), start: vi.fn() };
		const createGuardian = vi.fn(() => ({ stop: vi.fn(), start: vi.fn() }));

		const enabled = ensureRefreshGuardianState({
			enabled: true,
			intervalMs: 1000,
			bufferMs: 100,
			currentGuardian: oldGuardian,
			currentConfigKey: "old",
			createGuardian,
			registerCleanup: vi.fn(),
		});
		expect(oldGuardian.stop).toHaveBeenCalled();
		expect(createGuardian).toHaveBeenCalled();
		expect(enabled.refreshGuardianConfigKey).toBe("1000:100");

		const disabled = ensureRefreshGuardianState({
			enabled: false,
			intervalMs: 1000,
			bufferMs: 100,
			currentGuardian: enabled.refreshGuardian,
			currentConfigKey: enabled.refreshGuardianConfigKey,
			createGuardian,
			registerCleanup: vi.fn(),
		});
		expect(disabled.refreshGuardian).toBeNull();
	});

	it("creates or clears session affinity store based on config", () => {
		const createStore = vi.fn((options) => options);
		const enabled = ensureSessionAffinityState({
			enabled: true,
			ttlMs: 1000,
			maxEntries: 10,
			currentStore: null,
			currentConfigKey: null,
			createStore,
		});
		expect(enabled.sessionAffinityStore).toEqual({
			ttlMs: 1000,
			maxEntries: 10,
		});

		const disabled = ensureSessionAffinityState({
			enabled: false,
			ttlMs: 1000,
			maxEntries: 10,
			currentStore: enabled.sessionAffinityStore,
			currentConfigKey: enabled.sessionAffinityConfigKey,
			createStore,
		});
		expect(disabled).toEqual({
			sessionAffinityStore: null,
			sessionAffinityConfigKey: null,
		});
	});
});
