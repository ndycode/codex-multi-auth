import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../lib/utils.js";

const createdDirs: string[] = [];
const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRootDir = join(testFileDir, "..");
const passthroughEnvKeys = ["HOME", "PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE"] as const;

function isRetriableFsError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const { code } = error as { code?: unknown };
	return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
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
	const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-multi-auth-wrapper-fixture-"));
	createdDirs.push(fixtureRoot);
	const scriptDir = join(fixtureRoot, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	writeFileSync(
		join(fixtureRoot, "package.json"),
		JSON.stringify({ type: "module", version: "9.8.7" }, null, "\t"),
		"utf8",
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex-multi-auth.js"),
		join(scriptDir, "codex-multi-auth.js"),
	);
	return fixtureRoot;
}

function createChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of passthroughEnvKeys) {
		const value = process.env[key];
		if (typeof value === "string" && value.length > 0) {
			env[key] = value;
		}
	}
	return env;
}

function runWrapper(fixtureRoot: string, args: string[] = []) {
	return spawnSync(
		process.execPath,
		[join(fixtureRoot, "scripts", "codex-multi-auth.js"), ...args],
		{
			encoding: "utf8",
			env: createChildEnv(),
		},
	);
}

afterEach(async () => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		await removeDirectoryWithRetry(dir);
	}
});

describe("codex-multi-auth bin wrapper", () => {
	it("prints package version for --version without loading the runtime", () => {
		const fixtureRoot = createWrapperFixture();
		const result = runWrapper(fixtureRoot, ["--version"]);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("9.8.7\n");
		expect(result.stderr).toBe("");
	});

	it("prints package version for -v without loading the runtime", () => {
		const fixtureRoot = createWrapperFixture();
		const result = runWrapper(fixtureRoot, ["-v"]);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("9.8.7\n");
		expect(result.stderr).toBe("");
	});

	it("prints a clear error when the wrapper version cannot be resolved", () => {
		const fixtureRoot = createWrapperFixture();
		writeFileSync(
			join(fixtureRoot, "package.json"),
			JSON.stringify({ type: "module" }, null, "\t"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["--version"]);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("codex-multi-auth version is unavailable.");
	});

	it.each([
		["--version", "extra"],
		["-v", "extra"],
	])("passes multi-argument version flags through to the runtime: %s", (flag, extraArg) => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli(args) {",
				`\tif (!Array.isArray(args) || args[0] !== ${JSON.stringify(flag)} || args[1] !== ${JSON.stringify(extraArg)}) throw new Error("bad args");`,
				"\treturn 6;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, [flag, extraArg]);

		expect(result.status).toBe(6);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it("propagates integer exit codes", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli(args) {",
				'\tif (!Array.isArray(args) || args[0] !== "auth") throw new Error("bad args");',
				"\treturn 5;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"]);
		expect(result.status).toBe(5);
	});

	it("normalizes non-integer exit codes to 1", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli() {",
				'\treturn "ok";',
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"]);
		expect(result.status).toBe(1);
	});
});
