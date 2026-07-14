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
import { resetWslDetectionCacheForTests } from "../lib/wsl.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({
		on: vi.fn(),
		stdin: { end: vi.fn(), on: vi.fn() },
	})),
}));

// readFileSync is stubbed to throw so that isWsl()'s /proc/version fallback
// resolves to false explicitly. Without it, these native-host assertions would
// depend on readFileSync being absent from the mock and the resulting TypeError
// being swallowed — which would silently break for anyone running the suite
// from inside WSL.
vi.mock("node:fs", () => {
	const readFileSync = vi.fn(() => {
		throw new Error("ENOENT");
	});
	return {
		default: {
			existsSync: vi.fn(),
			statSync: vi.fn(),
			readFileSync,
		},
		existsSync: vi.fn(),
		statSync: vi.fn(),
		readFileSync,
	};
});

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
	const originalDistro = process.env.WSL_DISTRO_NAME;
	const originalInterop = process.env.WSL_INTEROP;

	beforeEach(() => {
		vi.clearAllMocks();
		resetWslDetectionCacheForTests();
		// These assertions describe a native host. Running the suite from inside
		// WSL must not silently reroute them through the Windows interop paths.
		delete process.env.WSL_DISTRO_NAME;
		delete process.env.WSL_INTEROP;
		mockedExistsSync.mockReturnValue(false);
		mockedStatSync.mockReturnValue({
			isFile: () => true,
			mode: 0o755,
		} as unknown as ReturnType<typeof fs.statSync>);
	});

	afterEach(() => {
		resetWslDetectionCacheForTests();
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalDistro === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = originalDistro;
		if (originalInterop === undefined) delete process.env.WSL_INTEROP;
		else process.env.WSL_INTEROP = originalInterop;
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
			Object.defineProperty(process, "platform", { value: "darwin" });
			process.env.PATH = "/usr/bin";
			process.env.CODEX_AUTH_NO_BROWSER = "0";
			process.env.BROWSER = "none";

			expect(isBrowserLaunchSuppressed()).toBe(false);
			expect(openBrowserUrl("https://example.com")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"open",
				["https://example.com"],
				{ stdio: "ignore", shell: false },
			);
		});

		it("does not treat CODEX_AUTH_NO_BROWSER=false as suppression when BROWSER is disabled", () => {
			Object.defineProperty(process, "platform", { value: "darwin" });
			process.env.PATH = "/usr/bin";
			process.env.CODEX_AUTH_NO_BROWSER = "false";
			process.env.BROWSER = "none";

			expect(isBrowserLaunchSuppressed()).toBe(false);
			expect(openBrowserUrl("https://example.com")).toBe(true);
			expect(mockedSpawn).toHaveBeenCalledWith(
				"open",
				["https://example.com"],
				{ stdio: "ignore", shell: false },
			);
		});

		it("suppresses browser launch when BROWSER is set to none", () => {
			process.env.BROWSER = "none";

			expect(isBrowserLaunchSuppressed()).toBe(true);
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

describe("auth browser utilities under WSL", () => {
	const url = "https://auth.openai.com/oauth/authorize";
	const originalPlatform = process.platform;
	const originalPath = process.env.PATH;
	const originalDistro = process.env.WSL_DISTRO_NAME;
	const originalNoBrowser = process.env.CODEX_AUTH_NO_BROWSER;
	const originalBrowser = process.env.BROWSER;

	/** Make only the named executables resolvable on PATH. */
	function onlyOnPath(...names: string[]): void {
		mockedStatSync.mockImplementation(((candidate: unknown) => {
			const resolved = String(candidate);
			if (names.some((name) => resolved.endsWith(name))) {
				return { isFile: () => true, mode: 0o755 };
			}
			throw new Error("ENOENT");
		}) as unknown as typeof fs.statSync);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		resetWslDetectionCacheForTests();
		// WSL reports itself as linux; the distro env var is what gives it away.
		Object.defineProperty(process, "platform", { value: "linux" });
		process.env.PATH = "/usr/bin";
		process.env.WSL_DISTRO_NAME = "Debian";
		delete process.env.CODEX_AUTH_NO_BROWSER;
		delete process.env.BROWSER;
	});

	afterEach(() => {
		resetWslDetectionCacheForTests();
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalDistro === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = originalDistro;
		if (originalNoBrowser === undefined)
			delete process.env.CODEX_AUTH_NO_BROWSER;
		else process.env.CODEX_AUTH_NO_BROWSER = originalNoBrowser;
		if (originalBrowser === undefined) delete process.env.BROWSER;
		else process.env.BROWSER = originalBrowser;
	});

	it("opens the Windows browser through wslview when it is available", () => {
		onlyOnPath("wslview");

		expect(openBrowserUrl(url)).toBe(true);
		expect(mockedSpawn).toHaveBeenCalledWith("wslview", [url], {
			stdio: "ignore",
			shell: false,
		});
	});

	it("falls back to Windows PowerShell interop when wslview is missing", () => {
		onlyOnPath("powershell.exe");

		expect(openBrowserUrl(url)).toBe(true);
		expect(mockedSpawn).toHaveBeenCalledWith(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-Command", `Start-Process "${url}"`],
			{ stdio: "ignore" },
		);
	});

	it("falls back to the linux opener when no Windows bridge is present", () => {
		onlyOnPath(PLATFORM_OPENERS.linux);

		expect(openBrowserUrl(url)).toBe(true);
		expect(mockedSpawn).toHaveBeenCalledWith(PLATFORM_OPENERS.linux, [url], {
			stdio: "ignore",
			shell: false,
		});
	});

	it("reports failure when neither a Windows bridge nor xdg-open exists", () => {
		// The pre-fix behaviour on a stock WSL Debian: xdg-open is not installed,
		// so no browser ever opened and login appeared to hang.
		onlyOnPath("nothing-resolvable");

		expect(openBrowserUrl(url)).toBe(false);
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	it("still honours browser suppression inside WSL", () => {
		process.env.CODEX_AUTH_NO_BROWSER = "1";
		onlyOnPath("wslview");

		expect(openBrowserUrl(url)).toBe(false);
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	it("copies to the Windows clipboard through clip.exe", () => {
		onlyOnPath("clip.exe");

		expect(copyTextToClipboard(url)).toBe(true);
		expect(mockedSpawn).toHaveBeenCalledWith("clip.exe", [], {
			stdio: ["pipe", "ignore", "ignore"],
			shell: false,
		});
		expectLastSpawnStdinEndWith(url);
	});

	it("falls back to PowerShell Set-Clipboard when clip.exe is missing", () => {
		onlyOnPath("powershell.exe");

		expect(copyTextToClipboard(url)).toBe(true);
		expect(mockedSpawn).toHaveBeenCalledWith(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-Command", `Set-Clipboard -Value "${url}"`],
			{ stdio: "ignore" },
		);
	});

	it("escapes PowerShell metacharacters in the interop command", () => {
		onlyOnPath("powershell.exe");

		expect(openBrowserUrl('https://example.com/?a=$x&b=`y"z')).toBe(true);
		const command = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
		expect(command[3]).toBe(
			'Start-Process "https://example.com/?a=`$x&b=``y""z"',
		);
	});
});
