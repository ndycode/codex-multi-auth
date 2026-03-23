import { describe, expect, it, vi } from "vitest";
import { runInitConfigCommand } from "../lib/codex-manager/commands/init-config.js";

describe("runInitConfigCommand", () => {
	it("returns exit code 1 when writing the template fails", async () => {
		const logError = vi.fn();
		const exitCode = await runInitConfigCommand(["--write", "codex.json"], {
			cwd: () => "C:/repo",
			logInfo: vi.fn(),
			logError,
			readTemplate: async () => "content",
			writeTemplate: async () => {
				throw new Error("disk full");
			},
		});
		expect(exitCode).toBe(1);
		expect(logError).toHaveBeenCalledWith("disk full");
	});
});
