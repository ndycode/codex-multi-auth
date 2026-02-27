import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync,
}));

describe("test-model-matrix script helpers", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses CODEX_BIN override and detects .cmd shell mode", async () => {
		spawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 });
		vi.stubEnv("CODEX_BIN", "C:\\Tools\\Codex.cmd");

		const mod = await import("../scripts/test-model-matrix.js");
		expect(mod.resolveCodexExecutable()).toEqual({
			command: "C:\\Tools\\Codex.cmd",
			shell: true,
		});
	});

	it("falls back to default timeout when CODEX_MATRIX_TIMEOUT_MS is invalid", async () => {
		vi.stubEnv("CODEX_MATRIX_TIMEOUT_MS", "abc");
		const mod = await import("../scripts/test-model-matrix.js");
		expect(mod.resolveMatrixTimeoutMs()).toBe(120000);
	});

	it("filters non-path where output on Windows", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({
				stdout: "INFO: noise\r\nC:\\Users\\neil\\AppData\\Roaming\\npm\\Codex.exe\r\n",
				stderr: "INFO: Could not find files\r\n",
				status: 0,
			});

			const mod = await import("../scripts/test-model-matrix.js");
			expect(mod.resolveCodexExecutable()).toEqual({
				command: "C:\\Users\\neil\\AppData\\Roaming\\npm\\Codex.exe",
				shell: false,
			});
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("returns fallback command when where has no executable candidates", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({ stdout: "", stderr: "INFO: not found\n", status: 1 });

			const mod = await import("../scripts/test-model-matrix.js");
			expect(mod.resolveCodexExecutable()).toEqual({ command: "codex", shell: false });
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("serializes stopCodexServers calls and kills only tracked Windows PIDs", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

			const mod = await import("../scripts/test-model-matrix.js");
			mod.__resetTrackedCodexPidsForTests();
			mod.registerSpawnedCodex(1001);
			mod.registerSpawnedCodex(2002);
			spawnSync.mockClear();

			await Promise.all([mod.stopCodexServers(), mod.stopCodexServers()]);

			expect(spawnSync).toHaveBeenCalledTimes(2);
			expect(spawnSync).toHaveBeenNthCalledWith(
				1,
				"taskkill",
				["/F", "/T", "/PID", "1001"],
				expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
			);
			expect(spawnSync).toHaveBeenNthCalledWith(
				2,
				"taskkill",
				["/F", "/T", "/PID", "2002"],
				expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
			);
		} finally {
			platformSpy.mockRestore();
		}
	});
});
