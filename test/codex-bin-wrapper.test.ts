import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const createdDirs: string[] = [];

function createWrapperFixture(): string {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-wrapper-fixture-"));
	createdDirs.push(fixtureRoot);
	const scriptDir = join(fixtureRoot, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(join(process.cwd(), "scripts", "codex.js"), join(scriptDir, "codex.js"));
	copyFileSync(join(process.cwd(), "scripts", "codex-routing.js"), join(scriptDir, "codex-routing.js"));
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

afterEach(() => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("codex bin wrapper", () => {
	it("prints actionable message for auth commands when dist output is missing", () => {
		const fixtureRoot = createWrapperFixture();
		const result = spawnSync(
			process.execPath,
			[join(fixtureRoot, "scripts", "codex.js"), "auth", "status"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CODEX_MULTI_AUTH_BYPASS: "",
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				},
			},
		);

		const combinedOutput = `${result.stdout}\n${result.stderr}`;
		expect(result.status).toBe(1);
		expect(combinedOutput).toContain("auth commands require built runtime files");
		expect(combinedOutput).toContain("Run: npm run build");
		expect(combinedOutput).not.toContain("Cannot find module");
	});

	it("forwards non-auth commands when dist output is missing", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = spawnSync(
			process.execPath,
			[join(fixtureRoot, "scripts", "codex.js"), "--version"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				},
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:--version");
	});

	it("honors bypass for auth commands and forwards to the real CLI", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = spawnSync(
			process.execPath,
			[join(fixtureRoot, "scripts", "codex.js"), "auth", "status"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CODEX_MULTI_AUTH_BYPASS: "1",
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				},
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:auth status");
	});
});
