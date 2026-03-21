import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("runInitConfigCommand", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs/promises");
		vi.doUnmock("node:url");
	});

	it("resolves templates from the package root when running from dist output", async () => {
		const readFileMock = vi.fn(
			async () => '{\n  "plugin": ["codex-multi-auth"]\n}\n',
		);
		vi.doMock("node:fs/promises", () => ({
			mkdir: vi.fn(),
			readFile: readFileMock,
			writeFile: vi.fn(),
		}));
		const distCommandPath = resolve(
			"/repo",
			"dist",
			"lib",
			"codex-manager",
			"commands",
			"init-config.js",
		);
		vi.doMock("node:url", () => ({
			fileURLToPath: () => distCommandPath,
		}));

		const { runInitConfigCommand } = await import(
			"../lib/codex-manager/commands/init-config.js"
		);
		const logInfo = vi.fn();
		const exitCode = await runInitConfigCommand(["modern"], {
			logInfo,
			logError: vi.fn(),
			cwd: () => resolve("/repo"),
		});

		expect(exitCode).toBe(0);
		expect(readFileMock).toHaveBeenCalledWith(
			resolve("/repo", "config", "codex-modern.json"),
			"utf8",
		);
		expect(logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"plugin": ["codex-multi-auth"]'),
		);
	});

	it("logs and returns 1 when template loading fails", async () => {
		const { runInitConfigCommand } = await import(
			"../lib/codex-manager/commands/init-config.js"
		);
		const logError = vi.fn();

		const exitCode = await runInitConfigCommand(["modern"], {
			logInfo: vi.fn(),
			logError,
			readTemplate: async () => {
				throw new Error("template missing");
			},
		});

		expect(exitCode).toBe(1);
		expect(logError).toHaveBeenCalledWith("template missing");
	});
});
