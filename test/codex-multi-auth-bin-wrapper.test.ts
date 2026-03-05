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

function isRetriableFsError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const { code } = error as { code?: unknown };
	return code === "EBUSY" || code === "EPERM" || code === "EACCES";
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
	copyFileSync(
		join(repoRootDir, "scripts", "codex-multi-auth.js"),
		join(scriptDir, "codex-multi-auth.js"),
	);
	return fixtureRoot;
}

function runWrapper(fixtureRoot: string, args: string[] = []) {
	return spawnSync(
		process.execPath,
		[join(fixtureRoot, "scripts", "codex-multi-auth.js"), ...args],
		{
			encoding: "utf8",
			env: {
				...process.env,
			},
		},
	);
}

afterEach(async () => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		await removeDirectoryWithRetry(dir);
	}
});

describe("codex-multi-auth bin wrapper", () => {
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

	it("propagates numeric-string exit codes", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli() {",
				'\treturn "7";',
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"]);
		expect(result.status).toBe(7);
	});

	it("normalizes null exit codes to failure", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli() {",
				"\treturn null;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"]);
		expect(result.status).toBe(1);
	});

	it("normalizes empty-string exit codes to failure", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli() {",
				'\treturn "";',
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"]);
		expect(result.status).toBe(1);
	});
});
