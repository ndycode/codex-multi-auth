import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every (args, deps) pair the dispatcher hands to runUninstallCommand
// so we can assert that the CLI dispatch wires `clearAccounts` correctly.
type Captured = {
	args: string[];
	deps: { clearAccounts?: () => Promise<void> } | undefined;
};
const captured: Captured[] = [];

vi.mock("../lib/codex-manager/commands/uninstall.js", () => ({
	runUninstallCommand: async (
		args: string[],
		deps: { clearAccounts?: () => Promise<void> } | undefined,
	) => {
		captured.push({ args, deps });
		// If the dispatcher actually wired the dep, exercise it so we can
		// observe the call from outside.
		if (deps?.clearAccounts) {
			await deps.clearAccounts();
		}
		return 0;
	},
}));

const clearAccountsSpy = vi.fn(async () => undefined);

vi.mock("../lib/storage.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).storageModuleMock({
		clearAccounts: clearAccountsSpy,
	}),
);

beforeEach(() => {
	captured.length = 0;
	clearAccountsSpy.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runCodexMultiAuthCli uninstall dispatch", () => {
	it("forwards a working clearAccounts handler when --clear-accounts is set", async () => {
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const code = await runCodexMultiAuthCli(["uninstall", "--clear-accounts"]);

		expect(code).toBe(0);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.args).toEqual(["--clear-accounts"]);
		expect(typeof captured[0]?.deps?.clearAccounts).toBe("function");
		// The wired handler must call into the real storage.clearAccounts.
		expect(clearAccountsSpy).toHaveBeenCalledTimes(1);
	});

	it("also removes stored API keys and per-account runtime state on --clear-accounts", async () => {
		const { promises: fs } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await fs.mkdtemp(join(tmpdir(), "clear-sidecars-"));
		vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
		try {
			const files = ["api-routes.json", "reset-credits.json", "api-capability-probes.json", join("inference-activity", "a.json")];
			await fs.mkdir(join(dir, "inference-activity"));
			for (const file of files) await fs.writeFile(join(dir, file), '{"apiKey":"sk-fixture"}');
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			expect(await runCodexMultiAuthCli(["uninstall", "--clear-accounts"])).toBe(0);
			expect(clearAccountsSpy).toHaveBeenCalledTimes(1);
			expect(await fs.readdir(dir)).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("still removes API keys when clearing the account pool fails", async () => {
		const { promises: fs } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await fs.mkdtemp(join(tmpdir(), "clear-sidecars-fail-"));
		vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
		try {
			await fs.writeFile(join(dir, "api-routes.json"), '{"apiKey":"sk-fixture"}');
			clearAccountsSpy.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EBUSY" }));
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			await expect(runCodexMultiAuthCli(["uninstall", "--clear-accounts"])).rejects.toThrow("locked");
			expect(await fs.readdir(dir)).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("forwards a clearAccounts handler regardless of whether the flag is set", async () => {
		// The dispatcher always passes the dep; gating happens inside
		// runUninstallCommand. Pin that so we don't regress to a `flag-only`
		// wiring (which is what previously broke the feature).
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		await runCodexMultiAuthCli(["uninstall"]);

		expect(captured).toHaveLength(1);
		expect(typeof captured[0]?.deps?.clearAccounts).toBe("function");
	});
});
