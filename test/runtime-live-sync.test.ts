import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRuntimeLiveAccountSync } from "../lib/runtime/live-sync.js";

describe("runtime live sync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	function createDeps(overrides: {
		liveAccountSyncEnabled?: boolean;
		currentSync?: {
			stop: ReturnType<typeof vi.fn>;
			syncToPath: ReturnType<typeof vi.fn>;
		} | null;
		currentPath?: string | null;
		currentCleanupRegistered?: boolean;
		targetPath?: string;
		pluginName?: string;
	} = {}) {
		let liveSync = overrides.currentSync ?? null;
		const registerCleanup = vi.fn();
		const createSync = vi.fn((_onChange, _options) => ({
			stop: vi.fn(),
			syncToPath: vi.fn().mockResolvedValue(undefined),
		}));
		const deps = {
			pluginConfig: {},
			authFallback: undefined,
			getLiveAccountSync: vi
				.fn()
				.mockReturnValue(overrides.liveAccountSyncEnabled ?? true),
			getStoragePath: vi
				.fn()
				.mockReturnValue(overrides.targetPath ?? "C:\\repo\\accounts.json"),
			currentSync: overrides.currentSync ?? null,
			currentPath: overrides.currentPath ?? null,
			currentCleanupRegistered: overrides.currentCleanupRegistered ?? false,
			getCurrentSync: () => liveSync,
			createSync,
			reloadAccountManagerFromDisk: vi.fn().mockResolvedValue(undefined),
			getLiveAccountSyncDebounceMs: vi.fn().mockReturnValue(25),
			getLiveAccountSyncPollMs: vi.fn().mockReturnValue(250),
			registerCleanup,
			logWarn: vi.fn(),
			pluginName: overrides.pluginName ?? "codex-multi-auth",
		};

		return {
			deps,
			createSync,
			registerCleanup,
			setLiveSync(value: typeof liveSync) {
				liveSync = value;
			},
		};
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops the active sync when live sync is disabled", async () => {
		const currentSync = {
			stop: vi.fn(),
			syncToPath: vi.fn(),
		};
		const { deps } = createDeps({
			liveAccountSyncEnabled: false,
			currentSync,
			currentPath: "C:\\repo\\accounts.json",
			currentCleanupRegistered: true,
		});

		await expect(ensureRuntimeLiveAccountSync(deps)).resolves.toEqual({
			sync: null,
			path: null,
			cleanupRegistered: true,
		});
		expect(currentSync.stop).toHaveBeenCalledTimes(1);
	});

	it("creates a sync, registers cleanup once, and skips redundant path switches", async () => {
		const { deps, createSync, registerCleanup, setLiveSync } = createDeps();

		const first = await ensureRuntimeLiveAccountSync(deps);
		setLiveSync(first.sync);

		expect(createSync).toHaveBeenCalledTimes(1);
		expect(registerCleanup).toHaveBeenCalledTimes(1);
		expect(first.path).toBe("C:\\repo\\accounts.json");
		expect(first.cleanupRegistered).toBe(true);
		expect(first.sync?.syncToPath).toHaveBeenCalledWith(
			"C:\\repo\\accounts.json",
		);

		const second = await ensureRuntimeLiveAccountSync({
			...deps,
			currentSync: first.sync,
			currentPath: first.path,
			currentCleanupRegistered: first.cleanupRegistered,
		});

		expect(second.sync).toBe(first.sync);
		expect(createSync).toHaveBeenCalledTimes(1);
		expect(registerCleanup).toHaveBeenCalledTimes(1);
		expect(first.sync?.syncToPath).toHaveBeenCalledTimes(1);
	});

	it("retries EPERM path switches with exponential backoff before succeeding", async () => {
		const currentSync = {
			stop: vi.fn(),
			syncToPath: vi
				.fn()
				.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }))
				.mockRejectedValueOnce(Object.assign(new Error("still-locked"), { code: "EBUSY" }))
				.mockResolvedValueOnce(undefined),
		};
		const { deps } = createDeps({
			currentSync,
			currentPath: "C:\\repo\\old.json",
			targetPath: "C:\\repo\\new.json",
			currentCleanupRegistered: true,
		});

		const pending = ensureRuntimeLiveAccountSync(deps);
		await vi.advanceTimersByTimeAsync(25);
		await vi.advanceTimersByTimeAsync(50);
		await expect(pending).resolves.toMatchObject({
			sync: currentSync,
			path: "C:\\repo\\new.json",
			cleanupRegistered: true,
		});
		expect(currentSync.syncToPath).toHaveBeenCalledTimes(3);
	});

	it("logs a warning and keeps the previous path after exhausting transient lock retries", async () => {
		const currentSync = {
			stop: vi.fn(),
			syncToPath: vi
				.fn()
				.mockRejectedValue(Object.assign(new Error("locked"), { code: "EBUSY" })),
		};
		const { deps } = createDeps({
			currentSync,
			currentPath: "C:\\repo\\old.json",
			targetPath: "C:\\repo\\new.json",
			currentCleanupRegistered: true,
			pluginName: "test-plugin",
		});

		const pending = ensureRuntimeLiveAccountSync(deps);
		await vi.advanceTimersByTimeAsync(25 + 50 + 100);
		await expect(pending).resolves.toMatchObject({
			sync: currentSync,
			path: "C:\\repo\\old.json",
			cleanupRegistered: true,
		});
		expect(currentSync.syncToPath).toHaveBeenCalledTimes(3);
		expect(deps.logWarn).toHaveBeenCalledWith(
			expect.stringContaining("[test-plugin]"),
		);
	});

	it("rethrows non-transient syncToPath errors immediately", async () => {
		const currentSync = {
			stop: vi.fn(),
			syncToPath: vi.fn().mockRejectedValue(new Error("boom")),
		};
		const { deps } = createDeps({
			currentSync,
			currentPath: "C:\\repo\\old.json",
			targetPath: "C:\\repo\\new.json",
			currentCleanupRegistered: true,
		});

		await expect(ensureRuntimeLiveAccountSync(deps)).rejects.toThrow("boom");
		expect(deps.logWarn).not.toHaveBeenCalled();
	});

	it("does not accumulate cleanup handlers when sync is toggled off and on again", async () => {
		const { deps, registerCleanup, setLiveSync } = createDeps();

		const first = await ensureRuntimeLiveAccountSync(deps);
		setLiveSync(first.sync);
		expect(registerCleanup).toHaveBeenCalledTimes(1);

		const disabled = await ensureRuntimeLiveAccountSync({
			...deps,
			currentSync: first.sync,
			currentPath: first.path,
			currentCleanupRegistered: first.cleanupRegistered,
			getLiveAccountSync: vi.fn().mockReturnValue(false),
		});
		setLiveSync(disabled.sync);

		const reenabled = await ensureRuntimeLiveAccountSync({
			...deps,
			currentSync: disabled.sync,
			currentPath: disabled.path,
			currentCleanupRegistered: disabled.cleanupRegistered,
		});
		setLiveSync(reenabled.sync);

		expect(registerCleanup).toHaveBeenCalledTimes(1);
	});
});
