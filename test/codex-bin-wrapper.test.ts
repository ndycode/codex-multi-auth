import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const createdDirs: string[] = [];
const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRootDir = join(testFileDir, "..");

function isRetriableFsError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const { code } = error as { code?: unknown };
	return code === "EBUSY" || code === "EPERM";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function removeDirectoryWithRetry(dir: string): Promise<void> {
	const backoffMs = [20, 60, 120];
	let lastError: unknown;
	for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			if (!isRetriableFsError(error) || attempt === backoffMs.length) {
				break;
			}
			await sleep(backoffMs[attempt]);
		}
	}
	throw lastError;
}

function createWrapperFixture(): string {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-wrapper-fixture-"));
	createdDirs.push(fixtureRoot);
	const scriptDir = join(fixtureRoot, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(join(repoRootDir, "scripts", "codex.js"), join(scriptDir, "codex.js"));
	copyFileSync(join(repoRootDir, "scripts", "codex-routing.js"), join(scriptDir, "codex-routing.js"));
	return fixtureRoot;
}

function createFakeCodexBin(rootDir: string): string {
	const fakeBin = join(rootDir, "fake-codex.js");
	writeFileSync(
		fakeBin,
		[
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(0);",
		].join("\n"),
		"utf8",
	);
	return fakeBin;
}

function runWrapper(
	fixtureRoot: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[join(fixtureRoot, "scripts", "codex.js"), ...args],
		{
			encoding: "utf8",
			env: {
				...process.env,
				...extraEnv,
			},
		},
	);
}

function combinedOutput(result: SpawnSyncReturns<string>): string {
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

afterEach(async () => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		await removeDirectoryWithRetry(dir);
	}
});

describe("codex bin wrapper", () => {
	it("prints actionable message for auth commands when dist output is missing", () => {
		const fixtureRoot = createWrapperFixture();
		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(1);
		expect(output).toContain("auth commands require built runtime files");
		expect(output).toContain("Run: npm run build");
		expect(output).not.toContain("Cannot find module");
	});

	it("forwards non-auth commands when dist output is missing", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["--version"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:--version");
	});

	it("honors bypass for auth commands and forwards to the real CLI", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:auth status");
	});

	it("surfaces non-module-not-found loader failures", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			'throw new Error("dist-load-marker-001");\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
		});
		const output = combinedOutput(result);

		expect(result.status).toBe(1);
		expect(output).toContain("codex-multi-auth runner failed:");
		expect(output).toContain("dist-load-marker-001");
	});

	it("prints actionable guidance when real codex bin cannot be found", () => {
		const fixtureRoot = createWrapperFixture();
		const missingOverride = join(fixtureRoot, "missing", "codex.js");
		const result = runWrapper(
			fixtureRoot,
			["--version"],
			{
				CODEX_MULTI_AUTH_BYPASS: "",
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: missingOverride,
			},
		);
		const output = combinedOutput(result);

		expect(result.status).toBe(1);
		expect(output).toContain(`CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: ${missingOverride}`);
		expect(output).toContain("Could not locate the official Codex CLI binary");
		expect(output).toContain("Install it globally: npm install -g @openai/codex");
	});
});
