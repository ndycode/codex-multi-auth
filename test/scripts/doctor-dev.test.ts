import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readPackageScripts,
	runDevDoctor,
} from "../../scripts/doctor-dev.js";

function createDoctorFixture(scripts: Record<string, string> = {
	build: "echo build",
	lint: "echo lint",
	test: "echo test",
	typecheck: "echo typecheck",
	verify: "echo verify",
}) {
	const root = mkdtempSync(join(tmpdir(), "codex-doctor-dev-"));
	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(join(root, "node_modules"), { recursive: true });
	writeFileSync(join(root, ".git"), "");
	writeFileSync(join(root, "package-lock.json"), "{}\n");
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name: "fixture", version: "1.0.0", scripts }, null, 2)}\n`,
	);
	writeFileSync(join(binDir, "npm.cmd"), "");
	writeFileSync(join(binDir, "git.cmd"), "");
	return { root, binDir };
}

const spawnSyncVersionStub = (command: unknown) => {
	if (String(command).toLowerCase().includes("git")) {
		return { status: 0, stdout: "git version 2.40.0\n", stderr: "" };
	}
	return { status: 0, stdout: "10.9.0\n", stderr: "" };
};

describe("doctor-dev script", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes on win32 when commands are found via PATHEXT lookup", () => {
		const fixture = createDoctorFixture();
		tempDirs.push(fixture.root);

		const logs: string[] = [];
		const warnings: string[] = [];
		const errors: string[] = [];
		const code = runDevDoctor({
			cwd: fixture.root,
			platform: "win32",
			env: {
				PATH: fixture.binDir,
				PATHEXT: ".EXE;.CMD",
				npm_execpath: "",
			},
			nodeVersion: "v20.9.0",
			spawnSync: (command) => {
				if (String(command).toLowerCase().includes("git")) {
					return { status: 0, stdout: "git version 2.40.0\n", stderr: "" };
				}
				return { status: 0, stdout: "10.9.0\n", stderr: "" };
			},
			log: (message) => logs.push(String(message)),
			warn: (message) => warnings.push(String(message)),
			error: (message) => errors.push(String(message)),
		});

		expect(code).toBe(0);
		expect(errors).toEqual([]);
		expect(warnings).toEqual([]);
		expect(logs.some((line) => line.includes("npm 10.9.0 OK"))).toBe(true);
		expect(logs.some((line) => line.includes("Dev doctor passed."))).toBe(true);
	});

	it("fails when required package scripts are missing", () => {
		const fixture = createDoctorFixture({
			lint: "echo lint",
			test: "echo test",
			typecheck: "echo typecheck",
		});
		tempDirs.push(fixture.root);

		const errors: string[] = [];
		const code = runDevDoctor({
			cwd: fixture.root,
			platform: "linux",
			env: {
				PATH: fixture.binDir,
				npm_execpath: "/tmp/npm-cli.js",
			},
			spawnSync: spawnSyncVersionStub,
			error: (message) => errors.push(String(message)),
			warn: () => {},
			log: () => {},
		});

		expect(code).toBe(1);
		expect(errors.some((line) => line.includes("Missing required npm script: build"))).toBe(true);
	});

	it("fails fast on unsupported Node major version", () => {
		const fixture = createDoctorFixture();
		tempDirs.push(fixture.root);

		const errors: string[] = [];
		const code = runDevDoctor({
			cwd: fixture.root,
			platform: "linux",
			env: {
				PATH: fixture.binDir,
				npm_execpath: "/tmp/npm-cli.js",
			},
			nodeVersion: "v16.20.0",
			spawnSync: spawnSyncVersionStub,
			error: (message) => errors.push(String(message)),
			warn: () => {},
			log: () => {},
		});

		expect(code).toBe(1);
		expect(errors.some((line) => line.includes("Node.js 18+ is required"))).toBe(true);
	});

	it("retries transient Windows lock errors when reading package.json", () => {
		let attempts = 0;
		const scripts = readPackageScripts("C:/repo", {
			platform: "win32",
			pathExists: () => true,
			readFile: () => {
				attempts += 1;
				if (attempts === 1) {
					throw Object.assign(new Error("busy"), { code: "EBUSY" });
				}
				return '{"scripts":{"build":"ok"}}';
			},
			baseDelayMs: 0,
			maxAttempts: 2,
		});

		expect(scripts).toEqual({ build: "ok" });
		expect(attempts).toBe(2);
	});

	it("fails when npm/git version probes return non-zero status or invalid output", () => {
		const fixture = createDoctorFixture();
		tempDirs.push(fixture.root);

		const errors: string[] = [];
		const code = runDevDoctor({
			cwd: fixture.root,
			platform: "win32",
			env: {
				PATH: fixture.binDir,
				PATHEXT: ".CMD",
				npm_execpath: "",
			},
			spawnSync: (command) => {
				const lower = String(command).toLowerCase();
				if (lower.includes("git")) {
					return { status: 1, stdout: "garbage", stderr: "git failed" };
				}
				return { status: 1, stdout: "", stderr: "npm failed" };
			},
			error: (message) => errors.push(String(message)),
			warn: () => {},
			log: () => {},
		});

		expect(code).toBe(1);
		expect(
			errors.some((line) => line.includes("npm entrypoint detected") && line.includes("could not be executed")),
		).toBe(true);
		expect(
			errors.some((line) => line.includes("git entrypoint detected") && line.includes("could not be executed")),
		).toBe(true);
	});

	it("fails when verify script is missing from package.json", () => {
		const fixture = createDoctorFixture({
			build: "echo build",
			lint: "echo lint",
			test: "echo test",
			typecheck: "echo typecheck",
		});
		tempDirs.push(fixture.root);

		const errors: string[] = [];
		const code = runDevDoctor({
			cwd: fixture.root,
			platform: "linux",
			env: {
				PATH: fixture.binDir,
				npm_execpath: "/tmp/npm-cli.js",
			},
			spawnSync: spawnSyncVersionStub,
			error: (message) => errors.push(String(message)),
			warn: () => {},
			log: () => {},
		});

		expect(code).toBe(1);
		expect(errors.some((line) => line.includes("Missing required npm script: verify"))).toBe(true);
	});
});
