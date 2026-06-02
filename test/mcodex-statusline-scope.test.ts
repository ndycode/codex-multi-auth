import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Regression for the statusline per-project pool bug (PR #500 review): the
// forwarded status line read the GLOBAL accounts file via resolveAccountsPath,
// so a project with a per-project pool showed the wrong account (or none). The
// fix routes the accounts read through the same project-scoped resolution the
// runtime uses (dist storage/paths helpers), while quota/observability stay
// global. These tests drive the real wrapper + real dist build end-to-end.

const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testFileDir, "..");
const wrapperScript = join(repoRoot, "scripts", "codex.js");
const distPathsModule = join(repoRoot, "dist", "lib", "storage", "paths.js");

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		// Best-effort: on Windows a just-spawned child can briefly hold a handle,
		// surfacing EPERM/EBUSY. Cleanup failures must not fail the test.
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch {
				// retry / give up silently
			}
		}
	}
});

// Mirror getProjectStorageKey(normalizeProjectPath(root)) from dist so the test
// stages the pool exactly where the resolver will look. Importing the real dist
// helper keeps this honest rather than re-deriving the hash.
async function projectAccountsDir(codexHome: string, projectRoot: string): Promise<string> {
	const paths = (await import(pathToFileUrl(distPathsModule))) as {
		getProjectStorageKey: (p: string) => string;
		resolveProjectStorageIdentityRoot: (p: string) => string;
	};
	const identityRoot = paths.resolveProjectStorageIdentityRoot(projectRoot);
	const key = paths.getProjectStorageKey(identityRoot);
	return join(codexHome, ".codex", "multi-auth", "projects", key);
}

function pathToFileUrl(p: string): string {
	return new URL(`file://${p.replace(/\\/g, "/")}`).href;
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fakeCodexBin(root: string): string {
	const bin = join(root, "fake-codex.cjs");
	writeFileSync(bin, "process.exit(0);\n", "utf8");
	return bin;
}

function runWrapper(cwd: string, env: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, [wrapperScript, "--version-noop"], {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			CODEX_MULTI_AUTH_STATUSLINE: "1",
			CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE: "1",
			...env,
		},
	});
}

function hasDistBuild(): boolean {
	// paths.js is emitted by `npm run build`; skip if the tree isn't built.
	return existsSync(distPathsModule);
}

describe.runIf(hasDistBuild())("mcodex statusline per-project accounts (PR #500)", () => {
	it("reads the per-project pool, not the global one, inside a project", async () => {
		const codexHome = mkdtempSync(join(tmpdir(), "mcodex-status-home-"));
		createdDirs.push(codexHome);
		const projectRoot = mkdtempSync(join(tmpdir(), "mcodex-status-proj-"));
		createdDirs.push(projectRoot);
		// Mark as a git project so findProjectRoot resolves it.
		mkdirSync(join(projectRoot, ".git"), { recursive: true });

		const multiAuth = join(codexHome, ".codex", "multi-auth");
		// Global pool: should NOT be the one shown.
		writeJson(join(multiAuth, "openai-codex-accounts.json"), {
			version: 3,
			accounts: [{ email: "global@example.com", enabled: true }],
			activeIndex: 0,
		});
		// Per-project pool: the account Codex actually routes through.
		const projDir = await projectAccountsDir(codexHome, projectRoot);
		writeJson(join(projDir, "openai-codex-accounts.json"), {
			version: 3,
			accounts: [{ email: "project@example.com", enabled: true }],
			activeIndex: 0,
		});
		// Per-project plugin config opts into per-project accounts.
		writeJson(join(projectRoot, ".codex", "config.json"), {
			perProjectAccounts: true,
		});

		const result = runWrapper(projectRoot, {
			CODEX_HOME: join(codexHome, ".codex"),
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeCodexBin(codexHome),
			// Codex CLI sync forces the global pool (account-scope.ts); disable it so
			// the per-project pool is the one in effect, matching real per-project use.
			CODEX_MULTI_AUTH_SYNC_CODEX_CLI: "0",
		});

		// The status line is emitted on stderr before the forward.
		expect(result.stderr).toContain("project@example.com");
		expect(result.stderr).not.toContain("global@example.com");
	});

	it("falls back to the global pool outside any project", async () => {
		const codexHome = mkdtempSync(join(tmpdir(), "mcodex-status-home-"));
		createdDirs.push(codexHome);
		const nonProject = mkdtempSync(join(tmpdir(), "mcodex-status-plain-"));
		createdDirs.push(nonProject);

		const multiAuth = join(codexHome, ".codex", "multi-auth");
		writeJson(join(multiAuth, "openai-codex-accounts.json"), {
			version: 3,
			accounts: [{ email: "global@example.com", enabled: true }],
			activeIndex: 0,
		});

		const result = runWrapper(nonProject, {
			CODEX_HOME: join(codexHome, ".codex"),
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeCodexBin(codexHome),
		});

		expect(result.stderr).toContain("global@example.com");
	});

	it("uses the global pool when Codex CLI sync is enabled, even in a project", async () => {
		// account-scope.ts forces the global pool when cli-sync is on (setStoragePath
		// (null)); the status line must match that, not the per-project pool.
		const codexHome = mkdtempSync(join(tmpdir(), "mcodex-status-home-"));
		createdDirs.push(codexHome);
		const projectRoot = mkdtempSync(join(tmpdir(), "mcodex-status-proj-"));
		createdDirs.push(projectRoot);
		mkdirSync(join(projectRoot, ".git"), { recursive: true });

		const multiAuth = join(codexHome, ".codex", "multi-auth");
		writeJson(join(multiAuth, "openai-codex-accounts.json"), {
			version: 3,
			accounts: [{ email: "global@example.com", enabled: true }],
			activeIndex: 0,
		});
		const projDir = await projectAccountsDir(codexHome, projectRoot);
		writeJson(join(projDir, "openai-codex-accounts.json"), {
			version: 3,
			accounts: [{ email: "project@example.com", enabled: true }],
			activeIndex: 0,
		});
		writeJson(join(projectRoot, ".codex", "config.json"), {
			perProjectAccounts: true,
		});

		const result = runWrapper(projectRoot, {
			CODEX_HOME: join(codexHome, ".codex"),
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeCodexBin(codexHome),
			CODEX_MULTI_AUTH_SYNC_CODEX_CLI: "1",
		});

		expect(result.stderr).toContain("global@example.com");
		expect(result.stderr).not.toContain("project@example.com");
	});
});
