import { describe, expect, it, vi } from "vitest";
import {
	invalidateRuntimeAccountManagerCache,
	reloadRuntimeAccountManager,
} from "../lib/runtime/account-manager-cache.js";
import { applyUiRuntimeFromConfig } from "../lib/runtime/ui-runtime.js";

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

describe("runtime ui helpers", () => {
	it("applies runtime UI options from config getters", () => {
		const setUiRuntimeOptions = vi.fn().mockReturnValue({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "unicode",
		});

		expect(
			applyUiRuntimeFromConfig(
				{
					codexTuiV2: false,
					codexTuiColorProfile: "ansi16",
					codexTuiGlyphMode: "unicode",
				} as never,
				setUiRuntimeOptions,
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
});
