import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const existsSync = vi.fn();
const homedir = vi.fn(() => "/home/neil");

vi.mock("node:fs", () => ({ existsSync }));
vi.mock("node:os", () => ({ homedir }));

describe("runtime-paths", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		delete process.env.CODEX_HOME;
		delete process.env.CODEX_MULTI_AUTH_DIR;
		homedir.mockReturnValue("/home/neil");
	});

	afterEach(() => {
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
		homedir.mockReturnValue("C:\\Users\\Neil");
		process.env.CODEX_HOME = "C:\\USERS\\NEIL\\.codex";

		existsSync.mockImplementation((candidate: unknown) => {
			if (typeof candidate !== "string") return false;
			if (candidate === "C:\\USERS\\NEIL\\.codex\\multi-auth\\settings.json") return true;
			return false;
		});

		const mod = await import("../lib/runtime-paths.js");
		expect(mod.getCodexMultiAuthDir()).toBe("C:\\USERS\\NEIL\\.codex\\multi-auth");
		platformSpy.mockRestore();
	});
});
