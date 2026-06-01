import { getCodexMultiAuthDir, getCodexHomeDir } from "../lib/runtime-paths.js";

/**
 * Guard (tests-ci-01): proves the global test sandbox in
 * test/helpers/global-sandbox.ts is actually active, so storage/config
 * resolution lands in a throwaway temp dir and never the developer's real
 * ~/.codex. If this fails, the sandbox setupFile is not wired or was overridden.
 */
describe("global test sandbox", () => {
	const sandboxRoot = (
		globalThis as { __CMA_TEST_SANDBOX_ROOT__?: string }
	).__CMA_TEST_SANDBOX_ROOT__;

	it("exposes a sandbox root under the OS temp dir", () => {
		expect(sandboxRoot).toBeTruthy();
		expect(sandboxRoot).toMatch(/cma-test-home-/);
	});

	it("resolves codex home + multi-auth dir inside the sandbox, not real home", () => {
		const home = getCodexHomeDir();
		const multiAuth = getCodexMultiAuthDir();
		expect(sandboxRoot).toBeTruthy();
		if (sandboxRoot) {
			expect(home.startsWith(sandboxRoot)).toBe(true);
			expect(multiAuth.startsWith(sandboxRoot)).toBe(true);
		}
		// Never the literal real-home ~/.codex of the machine running the suite.
		expect(multiAuth).not.toBe("/root/.codex/multi-auth");
	});
});
