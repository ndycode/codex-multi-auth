import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve(process.cwd(), "scripts", "compliance-evidence-bundle.js");

async function removeWithRetry(targetPath: string): Promise<void> {
	const retryableCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !retryableCodes.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

function createFakeNpmBin(root: string): string {
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const fakeNpmPath = path.join(binDir, "fake-npm.js");
	const npmShellPath = path.join(binDir, "npm");
	const npmCmdPath = path.join(binDir, "npm.cmd");
	const fakeNpmSource = `
const fs = require("node:fs");
const markerPath = process.env.FAKE_NPM_MARKER_PATH;
if (markerPath) {
  fs.writeFileSync(markerPath, process.env.FAKE_NPM_WRAPPER ?? "unknown", "utf8");
}
const args = process.argv.slice(2);
if (args[0] === "sbom") {
  process.stdout.write(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", metadata: "x".repeat(1_500_000) }));
  process.exit(0);
}
const chunk = "verbose-output-" + "x".repeat(300) + "\\n";
let output = "";
for (let index = 0; index < 5000; index += 1) {
  output += chunk;
}
process.stdout.write(output);
process.exit(0);
`.trimStart();
	const nodeExecPosix = process.execPath.replace(/\\/g, "/").replace(/"/g, '\\"');
	const nodeExecWindows = process.execPath.replace(/"/g, '""');
	const npmShellSource = `#!/usr/bin/env sh\nFAKE_NPM_WRAPPER=sh \"${nodeExecPosix}\" \"${fakeNpmPath.replace(/\\/g, "/")}\" \"$@\"\n`;
	const npmCmdSource = `@echo off\r\nset FAKE_NPM_WRAPPER=cmd\r\n\"${nodeExecWindows}\" \"%~dp0\\fake-npm.js\" %*\r\n`;
	writeFileSync(fakeNpmPath, fakeNpmSource, "utf8");
	writeFileSync(npmShellPath, npmShellSource, "utf8");
	writeFileSync(npmCmdPath, npmCmdSource, "utf8");
	if (process.platform !== "win32") {
		chmodSync(npmShellPath, 0o755);
		chmodSync(fakeNpmPath, 0o755);
	}
	return binDir;
}

describe("compliance-evidence-bundle script", () => {
	const fixtures: string[] = [];

	afterEach(async () => {
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await removeWithRetry(fixture);
		}
	});

	it("handles verbose npm output without maxBuffer overflow", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "compliance-bundle-"));
		fixtures.push(root);
		const outDir = path.join(root, "evidence");
		const binDir = createFakeNpmBin(root);

		const result = spawnSync(
			process.execPath,
			[scriptPath, "--profile=quick", `--out-dir=${outDir}`],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
				},
			},
		);

		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout) as {
			status?: string;
		};
		expect(payload.status).toBe("pass");

		const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8")) as {
			status?: string;
			results?: Array<{ id?: string }>;
		};
		expect(manifest.status).toBe("pass");
		expect(Array.isArray(manifest.results)).toBe(true);
		expect(manifest.results?.length).toBeGreaterThan(0);

		const firstLogStat = await fs.stat(path.join(outDir, "01-typecheck.log"));
		expect(firstLogStat.size).toBeGreaterThan(1_000_000);
	});

	it.skipIf(process.platform !== "win32")("uses npm.cmd wrapper on Windows for verbose runs", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "compliance-bundle-win32-"));
		fixtures.push(root);
		const outDir = path.join(root, "evidence");
		const binDir = createFakeNpmBin(root);
		const markerPath = path.join(root, "wrapper-marker.txt");

		const result = spawnSync(
			process.execPath,
			[scriptPath, "--profile=quick", `--out-dir=${outDir}`],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
					FAKE_NPM_MARKER_PATH: markerPath,
				},
			},
		);

		expect(result.status).toBe(0);
		const marker = await fs.readFile(markerPath, "utf8");
		expect(marker.trim()).toBe("cmd");
	});
});
