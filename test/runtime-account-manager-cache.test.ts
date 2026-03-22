import { describe, expect, it, vi } from "vitest";
import {
	applyRuntimeUiOptions,
	resolveRuntimeUiOptions,
} from "../lib/runtime/ui-runtime.js";
import {
	invalidateRuntimeAccountManagerCache,
	reloadRuntimeAccountManager,
} from "../lib/runtime/account-manager-cache.js";

describe("runtime account manager cache", () => {
	it("invalidates both cached manager setters", () => {
		const setCachedAccountManager = vi.fn();
		const setAccountManagerPromise = vi.fn();

		invalidateRuntimeAccountManagerCache({
			setCachedAccountManager,
			setAccountManagerPromise,
		});

		expect(setCachedAccountManager).toHaveBeenCalledWith(null);
		expect(setAccountManagerPromise).toHaveBeenCalledWith(null);
	});

	it("deduplicates concurrent reloads against the shared in-flight promise", async () => {
		let releaseLoad: ((value: { id: string }) => void) | undefined;
		let currentReloadInFlight: Promise<{ id: string }> | null = null;
		const loadFromDisk = vi.fn(
			() =>
				new Promise<{ id: string }>((resolve) => {
					releaseLoad = resolve;
				}),
		);
		const setCachedAccountManager = vi.fn();
		const setAccountManagerPromise = vi.fn();
		const setReloadInFlight = vi.fn((value: Promise<{ id: string }> | null) => {
			currentReloadInFlight = value;
		});

		const first = reloadRuntimeAccountManager({
			currentReloadInFlight,
			loadFromDisk,
			setCachedAccountManager,
			setAccountManagerPromise,
			setReloadInFlight,
		});
		const second = reloadRuntimeAccountManager({
			currentReloadInFlight,
			loadFromDisk,
			setCachedAccountManager,
			setAccountManagerPromise,
			setReloadInFlight,
		});

		expect(loadFromDisk).toHaveBeenCalledTimes(1);

		releaseLoad?.({ id: "manager-1" });
		await expect(Promise.all([first, second])).resolves.toEqual([
			{ id: "manager-1" },
			{ id: "manager-1" },
		]);
		expect(setCachedAccountManager).toHaveBeenCalledWith({ id: "manager-1" });
		expect(setAccountManagerPromise).toHaveBeenCalledWith(
			expect.any(Promise),
		);
		expect(setReloadInFlight).toHaveBeenLastCalledWith(null);
		expect(currentReloadInFlight).toBeNull();
	});

	it("always clears the in-flight promise when a reload fails", async () => {
		let currentReloadInFlight: Promise<unknown> | null = null;
		const setReloadInFlight = vi.fn((value: Promise<unknown> | null) => {
			currentReloadInFlight = value;
		});

		await expect(
			reloadRuntimeAccountManager({
				currentReloadInFlight,
				loadFromDisk: vi.fn().mockRejectedValue(new Error("reload failed")),
				setCachedAccountManager: vi.fn(),
				setAccountManagerPromise: vi.fn(),
				setReloadInFlight,
			}),
		).rejects.toThrow("reload failed");

		expect(setReloadInFlight).toHaveBeenLastCalledWith(null);
		expect(currentReloadInFlight).toBeNull();
	});
});

describe("runtime ui resolver", () => {
	it("applies runtime UI options from config-derived getters", () => {
		const setUiRuntimeOptions = vi.fn().mockReturnValue({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "unicode",
		});

		expect(
			applyRuntimeUiOptions(
				{ name: "config" },
				{
					setUiRuntimeOptions,
					getCodexTuiV2: vi.fn().mockReturnValue(false),
					getCodexTuiColorProfile: vi.fn().mockReturnValue("ansi16"),
					getCodexTuiGlyphMode: vi.fn().mockReturnValue("unicode"),
				},
			),
		).toEqual({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "unicode",
		});
		expect(setUiRuntimeOptions).toHaveBeenCalledWith({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "unicode",
		});
	});

	it("loads plugin config and pipes it into the runtime UI resolver", () => {
		const pluginConfig = { theme: "green" };
		const applyUiRuntimeFromConfig = vi.fn().mockReturnValue({
			v2Enabled: true,
			colorProfile: "truecolor",
			glyphMode: "ascii",
		});

		expect(
			resolveRuntimeUiOptions({
				loadPluginConfig: vi.fn().mockReturnValue(pluginConfig),
				applyUiRuntimeFromConfig,
			}),
		).toEqual({
			v2Enabled: true,
			colorProfile: "truecolor",
			glyphMode: "ascii",
		});
		expect(applyUiRuntimeFromConfig).toHaveBeenCalledWith(pluginConfig);
	});
});
