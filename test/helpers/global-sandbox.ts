import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Global test sandbox (tests-ci-01).
 *
 * Several suites resolve storage/config paths from HOME / USERPROFILE /
 * CODEX_HOME / CODEX_MULTI_AUTH_DIR. A suite that forgets to redirect them (or
 * only deletes CODEX_HOME without pinning a home) can resolve to the developer's
 * real ~/.codex and read or clobber live account state. This setup file pins all
 * four to a per-worker temp directory BEFORE any test imports application code,
 * so the unsandboxed default is an empty throwaway dir rather than the real home.
 *
 * It is intentionally a *baseline only*: tests that set these env vars themselves
 * (e.g. paths/target-detection suites) still override it within their own
 * lifecycle and restore to this sandbox value afterward — never to the real home.
 */
const SANDBOX_ROOT = mkdtempSync(join(tmpdir(), "cma-test-home-"));

// Pin home + codex roots to the sandbox. os.homedir() itself is unaffected on
// some platforms, but every in-repo resolver consults these env vars first.
process.env.HOME = SANDBOX_ROOT;
process.env.USERPROFILE = SANDBOX_ROOT;
process.env.CODEX_HOME = join(SANDBOX_ROOT, ".codex");
process.env.CODEX_MULTI_AUTH_DIR = join(SANDBOX_ROOT, ".codex", "multi-auth");

// Pin the per-process PID account-selection offset OFF for tests. Its production
// default is `true` (verified in plugin-config.test.ts, and it spreads parallel
// agents across accounts — #628), but it biases selection by `process.pid`,
// which is inherently non-deterministic in a single test process. Pinning it off
// keeps account-selection assertions deterministic; the offset's own behaviour is
// covered by rotation.test.ts, which passes the flag to the selector directly.
process.env.CODEX_AUTH_PID_OFFSET_ENABLED = "0";

// Expose for assertions / debugging.
(globalThis as { __CMA_TEST_SANDBOX_ROOT__?: string }).__CMA_TEST_SANDBOX_ROOT__ =
	SANDBOX_ROOT;

// Suite-wide spy hygiene (see PR #590): a test that fails before its inline
// mockRestore() leaks its spy, and a later vi.spyOn on the same method returns
// the SAME leaked spy — so passthrough bindings captured from it recurse into
// the new test's own mock. Restoring after every test contains the cascade.
// No suite creates spies in beforeAll, so an after-each restore is safe.
import { afterEach, vi } from "vitest";

afterEach(() => {
	vi.restoreAllMocks();
});
