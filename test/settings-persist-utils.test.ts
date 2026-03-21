import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { formatPersistError, readFileWithRetry, resolvePluginConfigSavePathKey, warnPersistFailure } from "../lib/codex-manager/settings-persist-utils.js";

describe("settings persist utils", () => {
	afterEach(() => {
		delete process.env.CODEX_MULTI_AUTH_CONFIG_PATH;
		vi.restoreAllMocks();
	});

	it("prefers explicit config path over unified settings path", async () => {
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = " /tmp/custom.json ";
		const { resolvePluginConfigSavePathKey } = await import("../lib/codex-manager/settings-persist-utils.js");
		expect(resolvePluginConfigSavePathKey()).toBe("/tmp/custom.json");
	});

	it("formats persist errors consistently", () => {
		expect(formatPersistError(new Error("boom"))).toBe("boom");
		expect(formatPersistError("bad")).toBe("bad");
	});

	it("warns with scope-aware message", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		warnPersistFailure("settings", new Error("disk locked"));
		expect(warn).toHaveBeenCalledWith("Settings save failed (settings) after retries: disk locked");
	});

	it("returns data on the first successful read", async () => {
		const readSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce("ok" as never);
		await expect(
			readFileWithRetry("settings.json", { retryableCodes: new Set(["EBUSY"]), maxAttempts: 4, sleep: vi.fn(async () => {}) }),
		).resolves.toBe("ok");
		expect(readSpy).toHaveBeenCalledTimes(1);
	});

	it("throws ENOENT immediately without retrying", async () => {
		const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }) as never);
		const sleep = vi.fn(async () => {});
		await expect(
			readFileWithRetry("settings.json", { retryableCodes: new Set(["EBUSY"]), maxAttempts: 4, sleep }),
		).rejects.toThrow("missing");
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("throws non-retryable errors immediately", async () => {
		const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("bad fd"), { code: "EBADF" }) as never);
		const sleep = vi.fn(async () => {});
		await expect(
			readFileWithRetry("settings.json", { retryableCodes: new Set(["EBUSY"]), maxAttempts: 4, sleep }),
		).rejects.toThrow("bad fd");
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("retries retryable errors until max attempts then throws", async () => {
		vi.useFakeTimers();
		const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }) as never);
		const sleep = vi.fn(async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
		});
		await expect(
			readFileWithRetry("settings.json", { retryableCodes: new Set(["EBUSY"]), maxAttempts: 4, sleep }),
		).rejects.toThrow("busy");
		expect(readSpy).toHaveBeenCalledTimes(4);
		expect(sleep).toHaveBeenNthCalledWith(1, 25);
		expect(sleep).toHaveBeenNthCalledWith(2, 50);
		expect(sleep).toHaveBeenNthCalledWith(3, 100);
		vi.useRealTimers();
	});

	it("succeeds on a later retry after EBUSY", async () => {
		vi.useFakeTimers();
		const readSpy = vi.spyOn(fs, "readFile")
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }) as never)
			.mockResolvedValueOnce("recovered" as never);
		const sleep = vi.fn(async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
		});
		await expect(
			readFileWithRetry("settings.json", { retryableCodes: new Set(["EBUSY"]), maxAttempts: 4, sleep }),
		).resolves.toBe("recovered");
		expect(readSpy).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});
