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
			createSync: vi.fn(),
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(stop).toHaveBeenCalled();
		expect(result).toEqual({
			liveAccountSync: null,
			liveAccountSyncPath: null,
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
			createSync: vi.fn(() => created),
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
		});

		expect(syncToPath).toHaveBeenCalledWith("/tmp/a");
		expect(result.liveAccountSync).toBe(created);
		expect(result.liveAccountSyncPath).toBe("/tmp/a");
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
			});
		} finally {
			vi.useRealTimers();
		}
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
