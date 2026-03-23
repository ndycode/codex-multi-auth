import { describe, expect, it, vi } from "vitest";
import type { UiRuntimeOptions } from "../lib/ui/runtime.js";
import { applyUiRuntimeFromConfig } from "../lib/runtime/ui-runtime.js";
import { getRuntimeStatusMarker } from "../lib/runtime/status-marker.js";
import { applyRuntimePreemptiveQuotaSettings } from "../lib/runtime/preemptive-quota.js";
import {
	invalidateRuntimeAccountManagerCache,
	reloadRuntimeAccountManager,
} from "../lib/runtime/account-manager-cache.js";
import { handleAccountSelectEvent } from "../lib/runtime/account-select-event.js";
import {
	normalizeRuntimeRequestInit,
	parseRuntimeRequestBody,
} from "../lib/runtime/request-init.js";

describe("runtime request init helpers", () => {
	it("returns the provided RequestInit unchanged", async () => {
		const requestInit = { method: "PATCH", body: "{\"ok\":true}" };

		await expect(
			normalizeRuntimeRequestInit(
				new Request("https://example.com"),
				requestInit,
			),
		).resolves.toBe(requestInit);
	});

	it("normalizes Request bodies and leaves string inputs untouched", async () => {
		const request = new Request("https://example.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{\"hello\":\"world\"}",
		});

		await expect(
			normalizeRuntimeRequestInit(request, undefined),
		).resolves.toMatchObject({
			method: "POST",
			body: "{\"hello\":\"world\"}",
		});
		await expect(
			normalizeRuntimeRequestInit("https://example.com", undefined),
		).resolves.toBeUndefined();
	});

	it("falls back when the Request body cannot be re-read", async () => {
		const request = new Request("https://example.com", {
			method: "POST",
			body: "{\"hello\":\"world\"}",
		});
		await request.text();

		await expect(
			normalizeRuntimeRequestInit(request, undefined),
		).resolves.toEqual({
			method: "POST",
			headers: expect.any(Headers),
		});
	});

	it("parses string, typed-array, buffer, view, and blob payloads", async () => {
		const logWarn = vi.fn();
		const json = "{\"value\":42}";
		const bytes = new TextEncoder().encode(json);
		const view = new DataView(bytes.buffer.slice(0));

		await expect(parseRuntimeRequestBody(json, { logWarn })).resolves.toEqual({
			value: 42,
		});
		await expect(parseRuntimeRequestBody(bytes, { logWarn })).resolves.toEqual({
			value: 42,
		});
		await expect(
			parseRuntimeRequestBody(bytes.buffer.slice(0), { logWarn }),
		).resolves.toEqual({
			value: 42,
		});
		await expect(parseRuntimeRequestBody(view, { logWarn })).resolves.toEqual({
			value: 42,
		});
		await expect(
			parseRuntimeRequestBody(new Blob([json]), { logWarn }),
		).resolves.toEqual({
			value: 42,
		});
		expect(logWarn).not.toHaveBeenCalled();
	});

	it("logs a warning and returns an empty object when parsing fails", async () => {
		const logWarn = vi.fn();

		await expect(
			parseRuntimeRequestBody("{\"broken\":", { logWarn }),
		).resolves.toEqual({});

		expect(logWarn).toHaveBeenCalledWith(
			"Failed to parse request body, using empty object",
		);
	});
});

describe("runtime account manager cache helpers", () => {
	it("invalidates the cached manager and promise", () => {
		const setCachedAccountManager = vi.fn();
		const setAccountManagerPromise = vi.fn();

		invalidateRuntimeAccountManagerCache({
			setCachedAccountManager,
			setAccountManagerPromise,
		});

		expect(setCachedAccountManager).toHaveBeenCalledWith(null);
		expect(setAccountManagerPromise).toHaveBeenCalledWith(null);
	});

	it("deduplicates reloads through the shared in-flight promise", async () => {
		let releaseLoad: ((value: { id: string }) => void) | undefined;
		let currentReloadInFlight: Promise<{ id: string }> | null = null;
		const loadFromDisk = vi.fn(
			() =>
				new Promise<{ id: string }>((resolve) => {
					releaseLoad = resolve;
				}),
		);
		const setReloadInFlight = vi.fn(
			(value: Promise<{ id: string }> | null) => {
				currentReloadInFlight = value;
			},
		);

		const first = reloadRuntimeAccountManager({
			currentReloadInFlight,
			loadFromDisk,
			setCachedAccountManager: vi.fn(),
			setAccountManagerPromise: vi.fn(),
			setReloadInFlight,
		});
		const second = reloadRuntimeAccountManager({
			currentReloadInFlight,
			loadFromDisk,
			setCachedAccountManager: vi.fn(),
			setAccountManagerPromise: vi.fn(),
			setReloadInFlight,
		});

		expect(loadFromDisk).toHaveBeenCalledTimes(1);
		releaseLoad?.({ id: "manager-1" });
		await expect(Promise.all([first, second])).resolves.toEqual([
			{ id: "manager-1" },
			{ id: "manager-1" },
		]);
		expect(setReloadInFlight).toHaveBeenLastCalledWith(null);
		expect(currentReloadInFlight).toBeNull();
	});
});

describe("runtime account select event helper", () => {
	const storage = {
		version: 3 as const,
		accounts: [
			{
				refreshToken: "refresh-1",
				addedAt: 1,
				lastUsed: 1,
				rateLimitResetTimes: {},
				enabled: true,
			},
		],
		activeIndex: 0,
		activeIndexByFamily: {},
	};

	it("returns false when the provider filter skips the event", async () => {
		const loadAccounts = vi.fn();

		await expect(
			handleAccountSelectEvent({
				event: {
					type: "account.select",
					properties: { index: 0, provider: "other-provider" },
				},
				providerId: "openai",
				loadAccounts,
				saveAccounts: vi.fn(),
				modelFamilies: [],
				getCachedAccountManager: () => null,
				reloadAccountManagerFromDisk: vi.fn(),
				setLastCodexCliActiveSyncIndex: vi.fn(),
				showToast: vi.fn(),
			}),
		).resolves.toBe(false);
		expect(loadAccounts).not.toHaveBeenCalled();
	});

	it("returns true when the event is missing an account index", async () => {
		const loadAccounts = vi.fn();

		await expect(
			handleAccountSelectEvent({
				event: {
					type: "account.select",
					properties: { provider: "openai" },
				},
				providerId: "openai",
				loadAccounts,
				saveAccounts: vi.fn(),
				modelFamilies: [],
				getCachedAccountManager: () => null,
				reloadAccountManagerFromDisk: vi.fn(),
				setLastCodexCliActiveSyncIndex: vi.fn(),
				showToast: vi.fn(),
			}),
		).resolves.toBe(true);
		expect(loadAccounts).not.toHaveBeenCalled();
	});

	it("returns true when the requested account index is unavailable", async () => {
		const saveAccounts = vi.fn();
		const showToast = vi.fn();

		await expect(
			handleAccountSelectEvent({
				event: {
					type: "account.select",
					properties: { index: 3, provider: "openai" },
				},
				providerId: "openai",
				loadAccounts: vi.fn().mockResolvedValue(structuredClone(storage)),
				saveAccounts,
				modelFamilies: ["gpt-5"],
				getCachedAccountManager: () => null,
				reloadAccountManagerFromDisk: vi.fn(),
				setLastCodexCliActiveSyncIndex: vi.fn(),
				showToast,
			}),
		).resolves.toBe(true);
		expect(saveAccounts).not.toHaveBeenCalled();
		expect(showToast).not.toHaveBeenCalled();
	});

	it("updates storage and reports handled events for matching providers", async () => {
		const saveAccounts = vi.fn();
		const setLastCodexCliActiveSyncIndex = vi.fn();
		const showToast = vi.fn();

		await expect(
			handleAccountSelectEvent({
				event: {
					type: "account.select",
					properties: { index: 0, provider: "openai" },
				},
				providerId: "openai",
				loadAccounts: vi.fn().mockResolvedValue(structuredClone(storage)),
				saveAccounts,
				modelFamilies: ["gpt-5"],
				getCachedAccountManager: () => null,
				reloadAccountManagerFromDisk: vi.fn(),
				setLastCodexCliActiveSyncIndex,
				showToast,
			}),
		).resolves.toBe(true);
		expect(saveAccounts).toHaveBeenCalledTimes(1);
		expect(setLastCodexCliActiveSyncIndex).toHaveBeenCalledWith(0);
		expect(showToast).toHaveBeenCalledWith("Switched to account 1", "info");
	});
});

describe("runtime helper wrappers", () => {
	it("configures preemptive quota settings from the plugin config", () => {
		const configure = vi.fn();

		applyRuntimePreemptiveQuotaSettings(
			{ settings: true },
			{
				configure,
				getPreemptiveQuotaEnabled: vi.fn().mockReturnValue(true),
				getPreemptiveQuotaRemainingPercent5h: vi.fn().mockReturnValue(25),
				getPreemptiveQuotaRemainingPercent7d: vi.fn().mockReturnValue(10),
				getPreemptiveQuotaMaxDeferralMs: vi.fn().mockReturnValue(90_000),
			},
		);

		expect(configure).toHaveBeenCalledWith({
			enabled: true,
			remainingPercentThresholdPrimary: 25,
			remainingPercentThresholdSecondary: 10,
			maxDeferralMs: 90_000,
		});
	});

	it("returns legacy and v2 status markers correctly", () => {
		const ui = {
			v2Enabled: true,
			theme: {
				glyphs: {
					check: "OK",
					cross: "NO",
				},
			},
		} as unknown as UiRuntimeOptions;

		expect(getRuntimeStatusMarker(ui, "ok")).toBe("OK");
		expect(getRuntimeStatusMarker(ui, "warning")).toBe("!");
		expect(getRuntimeStatusMarker(ui, "error")).toBe("NO");
		expect(getRuntimeStatusMarker({ ...ui, v2Enabled: false }, "ok")).toBe(
			"✓",
		);
	});

	it("applies runtime UI options from the plugin config", () => {
		const setUiRuntimeOptions = vi.fn().mockReturnValue({
			v2Enabled: true,
			colorProfile: "truecolor",
			glyphMode: "ascii",
		});
		const pluginConfig = { palette: "green" };

		expect(
			applyUiRuntimeFromConfig(
				pluginConfig as never,
				setUiRuntimeOptions,
			),
		).toEqual({
			v2Enabled: true,
			colorProfile: "truecolor",
			glyphMode: "ascii",
		});
		expect(setUiRuntimeOptions).toHaveBeenCalledWith({
			v2Enabled: true,
			colorProfile: "truecolor",
			glyphMode: "ascii",
		});
	});
});
