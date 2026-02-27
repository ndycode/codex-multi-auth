import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync,
}));

describe("bench codex-host resolver", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses lowercase codex command on non-windows", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const mod = await import("../scripts/bench-format/codex-host.mjs");
		expect(mod.resolveCodexExecutable()).toEqual({ command: "codex", shell: false });
		platformSpy.mockRestore();
	});

	it("uses lowercase codex fallback when Windows where has no path candidates", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		spawnSync.mockReturnValue({ stdout: "", stderr: "INFO: no match\n", status: 1 });
		const mod = await import("../scripts/bench-format/codex-host.mjs");
		expect(mod.resolveCodexExecutable()).toEqual({ command: "codex", shell: false });
		platformSpy.mockRestore();
	});
});
