import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
	getWslDistroName,
	isWsl,
	resetWslDetectionCacheForTests,
} from "../lib/wsl.js";

vi.mock("node:fs", () => ({
	default: { readFileSync: vi.fn() },
	readFileSync: vi.fn(),
}));

const mockedReadFileSync = vi.mocked(fs.readFileSync);

describe("wsl detection", () => {
	const originalPlatform = process.platform;
	const originalDistro = process.env.WSL_DISTRO_NAME;
	const originalInterop = process.env.WSL_INTEROP;

	beforeEach(() => {
		vi.clearAllMocks();
		resetWslDetectionCacheForTests();
		delete process.env.WSL_DISTRO_NAME;
		delete process.env.WSL_INTEROP;
		mockedReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
	});

	afterEach(() => {
		resetWslDetectionCacheForTests();
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalDistro === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = originalDistro;
		if (originalInterop === undefined) delete process.env.WSL_INTEROP;
		else process.env.WSL_INTEROP = originalInterop;
	});

	it("is false on win32 even when WSL env vars leak in", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.WSL_DISTRO_NAME = "Debian";

		expect(isWsl()).toBe(false);
		expect(getWslDistroName()).toBeUndefined();
	});

	it("is false on darwin", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });

		expect(isWsl()).toBe(false);
	});

	it("detects WSL from WSL_DISTRO_NAME without touching /proc", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.env.WSL_DISTRO_NAME = "Debian";

		expect(isWsl()).toBe(true);
		expect(getWslDistroName()).toBe("Debian");
		expect(mockedReadFileSync).not.toHaveBeenCalled();
	});

	it("detects WSL from WSL_INTEROP", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.env.WSL_INTEROP = "/run/WSL/8_interop";

		expect(isWsl()).toBe(true);
		// No distro name is exported in this shell.
		expect(getWslDistroName()).toBeUndefined();
	});

	it("falls back to /proc/version when the environment is stripped", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		mockedReadFileSync.mockReturnValue(
			"Linux version 5.15.167.4-microsoft-standard-WSL2",
		);

		expect(isWsl()).toBe(true);
	});

	it("is false on a native linux host", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		mockedReadFileSync.mockReturnValue(
			"Linux version 6.8.0-45-generic (buildd@lcy02)",
		);

		expect(isWsl()).toBe(false);
	});

	it("is false when /proc/version is unreadable", () => {
		Object.defineProperty(process, "platform", { value: "linux" });

		expect(isWsl()).toBe(false);
	});

	it("memoizes the result", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		mockedReadFileSync.mockReturnValue("microsoft-standard-WSL2");

		expect(isWsl()).toBe(true);
		expect(isWsl()).toBe(true);
		expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
	});
});
