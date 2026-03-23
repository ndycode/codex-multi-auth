import { describe, expect, it, vi } from "vitest";
import { ensureRuntimeRefreshGuardian } from "../lib/runtime/refresh-guardian.js";

describe("runtime refresh guardian", () => {
	function createDeps(overrides: {
		guardianEnabled?: boolean;
		currentGuardian?: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } | null;
		currentConfigKey?: string | null;
		currentCleanupRegistered?: boolean;
		intervalMs?: number;
		bufferMs?: number;
	} = {}) {
		let currentGuardian = overrides.currentGuardian ?? null;
		const registerCleanup = vi.fn();
		const createGuardian = vi.fn(({ intervalMs, bufferMs }) => ({
			start: vi.fn(),
			stop: vi.fn(),
			intervalMs,
			bufferMs,
		}));
		const deps = {
			pluginConfig: {},
			getProactiveRefreshGuardian: vi
				.fn()
				.mockReturnValue(overrides.guardianEnabled ?? true),
			currentGuardian,
			currentConfigKey: overrides.currentConfigKey ?? null,
			currentCleanupRegistered: overrides.currentCleanupRegistered ?? false,
			getCurrentGuardian: () => currentGuardian,
			getProactiveRefreshIntervalMs: vi
				.fn()
				.mockReturnValue(overrides.intervalMs ?? 60_000),
			getProactiveRefreshBufferMs: vi
				.fn()
				.mockReturnValue(overrides.bufferMs ?? 300_000),
			createGuardian,
			registerCleanup,
		};

		return {
			deps,
			createGuardian,
			registerCleanup,
			setCurrentGuardian(value: typeof currentGuardian) {
				currentGuardian = value;
			},
		};
	}

	it("stops and clears the current guardian when the feature is disabled", () => {
		const currentGuardian = { start: vi.fn(), stop: vi.fn() };
		const { deps } = createDeps({
			guardianEnabled: false,
			currentGuardian,
			currentConfigKey: "60000:300000",
			currentCleanupRegistered: true,
		});

		expect(ensureRuntimeRefreshGuardian(deps)).toEqual({
			guardian: null,
			configKey: null,
			cleanupRegistered: true,
		});
		expect(currentGuardian.stop).toHaveBeenCalledTimes(1);
	});

	it("returns the existing guardian when the config is unchanged", () => {
		const currentGuardian = { start: vi.fn(), stop: vi.fn() };
		const { deps, createGuardian, registerCleanup } = createDeps({
			currentGuardian,
			currentConfigKey: "60000:300000",
			currentCleanupRegistered: true,
		});

		expect(ensureRuntimeRefreshGuardian(deps)).toEqual({
			guardian: currentGuardian,
			configKey: "60000:300000",
			cleanupRegistered: true,
		});
		expect(createGuardian).not.toHaveBeenCalled();
		expect(registerCleanup).not.toHaveBeenCalled();
	});

	it("creates, starts, and registers cleanup on first creation", () => {
		const { deps, createGuardian, registerCleanup, setCurrentGuardian } = createDeps();

		const result = ensureRuntimeRefreshGuardian(deps);
		setCurrentGuardian(result.guardian);

		expect(createGuardian).toHaveBeenCalledWith({
			intervalMs: 60_000,
			bufferMs: 300_000,
		});
		expect(result.guardian?.start).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			configKey: "60000:300000",
			cleanupRegistered: true,
		});
		expect(registerCleanup).toHaveBeenCalledTimes(1);
	});

	it("replaces the guardian without registering duplicate cleanup handlers", () => {
		const previousGuardian = { start: vi.fn(), stop: vi.fn() };
		const { deps, registerCleanup, setCurrentGuardian } = createDeps({
			currentGuardian: previousGuardian,
			currentConfigKey: "60000:300000",
			currentCleanupRegistered: true,
			intervalMs: 120_000,
			bufferMs: 600_000,
		});

		const result = ensureRuntimeRefreshGuardian(deps);
		setCurrentGuardian(result.guardian);

		expect(previousGuardian.stop).toHaveBeenCalledTimes(1);
		expect(result.guardian).not.toBe(previousGuardian);
		expect(result.guardian?.start).toHaveBeenCalledTimes(1);
		expect(result.configKey).toBe("120000:600000");
		expect(registerCleanup).not.toHaveBeenCalled();
	});

	it("does not accumulate cleanup handlers across disable and re-enable cycles", () => {
		const { deps, registerCleanup, setCurrentGuardian } = createDeps();

		const first = ensureRuntimeRefreshGuardian(deps);
		setCurrentGuardian(first.guardian);
		expect(registerCleanup).toHaveBeenCalledTimes(1);

		const disabled = ensureRuntimeRefreshGuardian({
			...deps,
			currentGuardian: first.guardian,
			currentConfigKey: first.configKey,
			currentCleanupRegistered: first.cleanupRegistered,
			getProactiveRefreshGuardian: vi.fn().mockReturnValue(false),
		});
		setCurrentGuardian(disabled.guardian);

		const reenabled = ensureRuntimeRefreshGuardian({
			...deps,
			currentGuardian: disabled.guardian,
			currentConfigKey: disabled.configKey,
			currentCleanupRegistered: disabled.cleanupRegistered,
		});
		setCurrentGuardian(reenabled.guardian);

		expect(registerCleanup).toHaveBeenCalledTimes(1);
	});
});
