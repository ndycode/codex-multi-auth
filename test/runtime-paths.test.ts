import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const existsSync = vi.fn();
const homedir = vi.fn(() => "/home/neil");

vi.mock("node:fs", () => ({ existsSync }));
vi.mock("node:os", () => ({ homedir }));

const ENV_KEYS = [
	"CODEX_HOME",
	"CODEX_MULTI_AUTH_DIR",
	"USERPROFILE",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("runtime-paths", () => {
	const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		homedir.mockReturnValue("/home/neil");
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (typeof value === "string") {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}
		vi.restoreAllMocks();
	});

	it("prefers fallback directory with account storage over primary signal-only directory", async () => {
		process.env.CODEX_HOME = "/home/neil/.codex";
		const primary = path.join("/home/neil/.codex", "multi-auth");
		const fallback = path.join("/home/neil/DevTools/config/codex", "multi-auth");

		existsSync.mockImplementation((candidate: unknown) => {
			if (typeof candidate !== "string") return false;
			if (candidate === path.join(primary, "settings.json")) return true;
			if (candidate === path.join(fallback, "openai-codex-accounts.json")) return true;
			return false;
		});

		const mod = await import("../lib/runtime-paths.js");
		expect(mod.getCodexMultiAuthDir()).toBe(fallback);
	});

	it("uses legacy root when it is the only directory containing account storage", async () => {
		process.env.CODEX_HOME = "/home/neil/.codex";
		const legacyRoot = path.join("/home/neil", ".codex");

		existsSync.mockImplementation((candidate: unknown) => {
			if (typeof candidate !== "string") return false;
			if (candidate === path.join(legacyRoot, "openai-codex-accounts.json")) return true;
			return false;
		});

		const mod = await import("../lib/runtime-paths.js");
		expect(mod.getCodexMultiAuthDir()).toBe(legacyRoot);
	});

	it("deduplicates Windows-style fallback paths case-insensitively", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			homedir.mockReturnValue("C:\\Users\\Neil");
			process.env.CODEX_HOME = "C:\\USERS\\NEIL\\.codex";

			existsSync.mockImplementation((candidate: unknown) => {
				if (typeof candidate !== "string") return false;
				if (candidate === "C:\\USERS\\NEIL\\.codex\\multi-auth\\settings.json") return true;
				return false;
			});

			const mod = await import("../lib/runtime-paths.js");
			expect(mod.getCodexMultiAuthDir()).toBe("C:\\USERS\\NEIL\\.codex\\multi-auth");
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("prefers USERPROFILE over os.homedir on Windows when CODEX_HOME is unset", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			homedir.mockReturnValue("C:\\Windows\\System32\\config\\systemprofile");
			process.env.USERPROFILE = "C:\\Users\\Alice";
			const mod = await import("../lib/runtime-paths.js");
			expect(mod.getCodexHomeDir()).toBe("C:\\Users\\Alice\\.codex");
			expect(mod.getLegacyCodexDir()).toBe("C:\\Users\\Alice\\.codex");
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("falls back to HOME when USERPROFILE is missing on Windows", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			homedir.mockReturnValue("C:\\Windows\\System32\\config\\systemprofile");
			process.env.HOME = "D:\\Users\\Bob";
			const mod = await import("../lib/runtime-paths.js");
			expect(mod.getCodexHomeDir()).toBe("D:\\Users\\Bob\\.codex");
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("falls back to HOMEDRIVE and HOMEPATH when USERPROFILE and HOME are missing on Windows", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			homedir.mockReturnValue("C:\\Windows\\System32\\config\\systemprofile");
			process.env.HOMEDRIVE = "E:";
			process.env.HOMEPATH = "\\Users\\Carol";
			const mod = await import("../lib/runtime-paths.js");
			expect(mod.getCodexHomeDir()).toBe("E:\\Users\\Carol\\.codex");
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("normalizes HOMEPATH without a leading slash on Windows", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			homedir.mockReturnValue("C:\\Windows\\System32\\config\\systemprofile");
			process.env.HOMEDRIVE = "E:";
			process.env.HOMEPATH = "Users\\Carol";
			const mod = await import("../lib/runtime-paths.js");
			expect(mod.getCodexHomeDir()).toBe("E:\\Users\\Carol\\.codex");
		} finally {
			platformSpy.mockRestore();
		}
	});
});
