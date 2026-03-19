import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import {
	getBrowserOpener,
	isBrowserLaunchSuppressed,
	openBrowserUrl,
	copyTextToClipboard,
} from "../lib/auth/browser.js";
import { PLATFORM_OPENERS } from "../lib/constants.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({
		on: vi.fn(),
		stdin: { end: vi.fn() },
	})),
}));

vi.mock("node:fs", () => ({
	default: {
		existsSync: vi.fn(),
		statSync: vi.fn(),
	},
	existsSync: vi.fn(),
	statSync: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedStatSync = vi.mocked(fs.statSync);

function expectLastSpawnStdinEndWith(text: string): void {
	const spawnResult = mockedSpawn.mock.results.at(-1)?.value as
		| { stdin?: { end?: (value?: string) => void } }
		| undefined;
	expect(spawnResult?.stdin?.end).toBeTypeOf("function");
	const stdinEnd = spawnResult?.stdin?.end as ReturnType<typeof vi.fn>;
	expect(stdinEnd).toHaveBeenCalledWith(text);
}

describe("auth browser utilities", () => {
	const originalPlatform = process.platform;
	const originalPath = process.env.PATH;
	const originalPathExt = process.env.PATHEXT;
	const originalNoBrowser = process.env.CODEX_AUTH_NO_BROWSER;
	const originalBrowser = process.env.BROWSER;

	beforeEach(() => {
		vi.clearAllMocks();
		mockedExistsSync.mockReturnValue(false);
		mockedStatSync.mockReturnValue({
			isFile: () => true,
			mode: 0o755,
		} as unknown as ReturnType<typeof fs.statSync>);
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalPathExt === undefined) delete process.env.PATHEXT;
		else process.env.PATHEXT = originalPathExt;
		if (originalNoBrowser === undefined) delete process.env.CODEX_AUTH_NO_BROWSER;
		else process.env.CODEX_AUTH_NO_BROWSER = originalNoBrowser;
		if (originalBrowser === undefined) delete process.env.BROWSER;
		else process.env.BROWSER = originalBrowser;
	});

	it("returns platform opener command", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.darwin);
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.win32);
		Object.defineProperty(process, "platform", { value: "linux" });
		expect(getBrowserOpener()).toBe(PLATFORM_OPENERS.linux);
	});

	describe("openBrowserUrl", () => {
		it("returns false when browser launch is suppressed by environment", () => {
			process.env.CODEX_AUTH_NO_BROWSER = "1";

			expect(isBrowserLaunchSuppressed()).toBe(true);
			expect(openBrowserUrl("https://example.com")).toBe(false);
			expect(mockedSpawn).not.toHaveBeenCalled();
		});

		it("treats false-like CODEX_AUTH_NO_BROWSER values as opt-in browser launch", () => {
			Object.defineProperty(process, "platform", { value: "darwin" });
			process.env.PATH = "/usr/bin";
			process.env.CODEX_AUTH_NO_BROWSER = "false";
			mockedExistsSync.mockImplementation(
				(candidate) => typeof candidate === "string" && candidate.endsWith("open"),
			);
			mockedStatSync.mockReturnValue({
				isFile: () => true,
				mode: 0o755,
			} as unknown as ReturnType<typeof fs.statSync>);

			expect(isBrowserLaunchSuppressed()).toBe(false);
			expect(openBrowserUrl("https://example.com")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"open",
				["https://example.com"],
				{ stdio: "ignore", shell: false },
			);
		});

		it("lets explicit false-like CODEX_AUTH_NO_BROWSER override a disabling BROWSER value", () => {
			process.env.CODEX_AUTH_NO_BROWSER = "0";
			process.env.BROWSER = "none";

			expect(isBrowserLaunchSuppressed()).toBe(false);
			expect(openBrowserUrl("https://example.com")).toBe(false);
			expect(mockedSpawn).not.toHaveBeenCalled();
		});

		it("keeps suppression enabled when CODEX_AUTH_NO_BROWSER is truthy even if BROWSER is also disabled", () => {
			process.env.CODEX_AUTH_NO_BROWSER = "true";
			process.env.BROWSER = "none";

			expect(isBrowserLaunchSuppressed()).toBe(true);
			expect(openBrowserUrl("https://example.com")).toBe(false);
			expect(mockedSpawn).not.toHaveBeenCalled();
		});
		
		it("returns false on win32 when powershell.exe is unavailable", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.PATH = "C:\\missing";
			process.env.PATHEXT = ".EXE;.CMD";
			mockedExistsSync.mockReturnValue(false);

			expect(openBrowserUrl("https://example.com")).toBe(false);
			expect(mockedSpawn).not.toHaveBeenCalled();
		});

		it("uses powershell on win32 when available", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.PATH = "C:\\Windows\\System32";
			process.env.PATHEXT = ".EXE;.CMD";
			mockedExistsSync.mockImplementation(
				(candidate) =>
					typeof candidate === "string" &&
					candidate.toLowerCase().includes("powershell.exe"),
			);

			expect(openBrowserUrl("https://example.com/$var")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"powershell.exe",
				expect.arrayContaining([expect.stringContaining("Start-Process")]),
				{ stdio: "ignore" },
			);
			const args = mockedSpawn.mock.calls.at(-1)?.[1] as string[] | undefined;
			expect(args).toEqual(expect.arrayContaining(["-NoLogo", "-NoProfile", "-Command"]));
			expect(args?.join(" ")).toContain('Start-Process "https://example.com/`$var"');
		});

		it("returns false when opener binary is non-executable on linux", () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.PATH = "/usr/bin";
			mockedExistsSync.mockReturnValue(true);
			mockedStatSync.mockReturnValue({
				isFile: () => true,
				mode: 0o644,
			} as unknown as ReturnType<typeof fs.statSync>);

			expect(openBrowserUrl("https://example.com")).toBe(false);
		});

		it("returns false on darwin when open is unavailable", () => {
			Object.defineProperty(process, "platform", { value: "darwin" });
			process.env.PATH = "/usr/bin";
			mockedStatSync.mockImplementation(() => {
				throw new Error("missing");
			});

			expect(openBrowserUrl("https://example.com")).toBe(false);
			expect(mockedSpawn).not.toHaveBeenCalled();
		});

		it("uses open on darwin when available", () => {
			Object.defineProperty(process, "platform", { value: "darwin" });
			process.env.PATH = "/usr/bin";
			mockedExistsSync.mockImplementation(
				(candidate) => typeof candidate === "string" && candidate.endsWith("open"),
			);
			mockedStatSync.mockReturnValue({
				isFile: () => true,
				mode: 0o755,
			} as unknown as ReturnType<typeof fs.statSync>);

			expect(openBrowserUrl("https://example.com")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"open",
				["https://example.com"],
				{ stdio: "ignore", shell: false },
			);
		});
	});

	describe("copyTextToClipboard", () => {
		it("returns false for empty text", () => {
			expect(copyTextToClipboard("")).toBe(false);
		});

		it("returns false on win32 when powershell.exe is unavailable", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.PATH = "C:\\missing";
			process.env.PATHEXT = ".EXE;.CMD";
			mockedExistsSync.mockReturnValue(false);

			expect(copyTextToClipboard("hello")).toBe(false);
			expect(mockedSpawn).not.toHaveBeenCalled();
		});

		it("uses powershell Set-Clipboard on win32 when available", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.PATH = "C:\\Windows\\System32";
			process.env.PATHEXT = ".EXE;.CMD";
			mockedExistsSync.mockImplementation(
				(candidate) =>
					typeof candidate === "string" &&
					candidate.toLowerCase().includes("powershell.exe"),
			);

			expect(copyTextToClipboard("hello$world")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"powershell.exe",
				expect.arrayContaining([expect.stringContaining("Set-Clipboard")]),
				{ stdio: "ignore" },
			);
			const args = mockedSpawn.mock.calls.at(-1)?.[1] as string[] | undefined;
			expect(args).toEqual(expect.arrayContaining(["-NoLogo", "-NoProfile", "-Command"]));
			expect(args?.join(" ")).toContain('Set-Clipboard -Value "hello`$world"');
		});

		it("uses pbcopy on darwin", () => {
			Object.defineProperty(process, "platform", { value: "darwin" });
			process.env.PATH = "/usr/bin";
			mockedExistsSync.mockImplementation(
				(candidate) => typeof candidate === "string" && candidate.endsWith("pbcopy"),
			);
			mockedStatSync.mockReturnValue({
				isFile: () => true,
				mode: 0o755,
			} as unknown as ReturnType<typeof fs.statSync>);

			expect(copyTextToClipboard("hello")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"pbcopy",
				[],
				{ stdio: ["pipe", "ignore", "ignore"], shell: false },
			);
			expectLastSpawnStdinEndWith("hello");
		});

		it("uses wl-copy when available on linux", () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.PATH = "/usr/bin:/bin";
			mockedExistsSync.mockImplementation((candidate) => {
				if (typeof candidate !== "string") return false;
				return candidate.endsWith("wl-copy");
			});
			mockedStatSync.mockReturnValue({
				isFile: () => true,
				mode: 0o755,
			} as unknown as ReturnType<typeof fs.statSync>);

			expect(copyTextToClipboard("hello")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"wl-copy",
				[],
				{ stdio: ["pipe", "ignore", "ignore"], shell: false },
			);
			expectLastSpawnStdinEndWith("hello");
		});

		it("falls back across linux clipboard commands", () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.PATH = "/usr/bin:/bin";
			mockedStatSync.mockImplementation((candidate) => {
				if (typeof candidate !== "string") throw new Error("bad path");
				if (candidate.endsWith("wl-copy")) throw new Error("missing");
				if (candidate.endsWith("xclip")) {
					return {
						isFile: () => true,
						mode: 0o755,
					} as unknown as ReturnType<typeof fs.statSync>;
				}
				throw new Error("missing");
			});

			expect(copyTextToClipboard("hello")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"xclip",
				["-selection", "clipboard"],
				{ stdio: ["pipe", "ignore", "ignore"], shell: false },
			);
			expectLastSpawnStdinEndWith("hello");
		});

		it("falls back to xsel when only xsel is available on linux", () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.PATH = "/usr/bin:/bin";
			mockedStatSync.mockImplementation((candidate) => {
				if (typeof candidate !== "string") throw new Error("bad path");
				if (candidate.endsWith("xsel")) {
					return {
						isFile: () => true,
						mode: 0o755,
					} as unknown as ReturnType<typeof fs.statSync>;
				}
				throw new Error("missing");
			});

			expect(copyTextToClipboard("hello")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"xsel",
				["--clipboard", "--input"],
				{ stdio: ["pipe", "ignore", "ignore"], shell: false },
			);
			expectLastSpawnStdinEndWith("hello");
		});

		it("returns false on linux when PATH is unset or no command exists", () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			delete process.env.PATH;
			mockedExistsSync.mockReturnValue(false);

			expect(copyTextToClipboard("hello")).toBe(false);
		});
	});
});
