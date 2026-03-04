#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE_MAJOR = 18;

function runCommand(command, args = []) {
	try {
		return spawnSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return {
			status: 1,
			stdout: "",
			stderr: "",
		};
	}
}

function splitPathEntries(pathValue) {
	if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
		return [];
	}
	const delimiter = process.platform === "win32" ? ";" : ":";
	return pathValue
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function commandExistsAtPath(commandPath) {
	try {
		return existsSync(commandPath);
	} catch {
		return false;
	}
}

function findCommandInPath(commandName) {
	const pathEntries = splitPathEntries(process.env.PATH ?? "");
	const hasExtension = /\.[A-Za-z0-9]+$/.test(commandName);
	const windowsExtensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1")
		.split(";")
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => ext.length > 0);

	for (const entry of pathEntries) {
		if (process.platform !== "win32") {
			const candidate = join(entry, commandName);
			if (commandExistsAtPath(candidate)) {
				return candidate;
			}
			continue;
		}

		const candidates = [];
		if (hasExtension) {
			candidates.push(join(entry, commandName));
		} else {
			candidates.push(join(entry, commandName));
			for (const extension of windowsExtensions) {
				candidates.push(join(entry, `${commandName}${extension.toLowerCase()}`));
			}
		}

		for (const candidate of candidates) {
			if (commandExistsAtPath(candidate)) {
				return candidate;
			}
		}
	}

	return null;
}

function getNodeMajor(versionText) {
	const clean = versionText.trim().replace(/^v/, "");
	const major = Number.parseInt(clean.split(".")[0] ?? "", 10);
	return Number.isFinite(major) ? major : null;
}

function readPackageScripts(repoRoot) {
	const packageJsonPath = join(repoRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		return null;
	}

	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (typeof packageJson !== "object" || packageJson === null) {
			return null;
		}
		const scripts = packageJson.scripts;
		if (typeof scripts !== "object" || scripts === null) {
			return null;
		}
		return scripts;
	} catch {
		return null;
	}
}

export function runDevDoctor(options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());
	const failures = [];
	const warnings = [];
	const details = [];

	const nodeVersion = process.version;
	const nodeMajor = getNodeMajor(nodeVersion);
	if (nodeMajor === null || nodeMajor < REQUIRED_NODE_MAJOR) {
		failures.push(
			`Node.js ${REQUIRED_NODE_MAJOR}+ is required. Found ${nodeVersion}.`,
		);
	} else {
		details.push(`Node.js ${nodeVersion} OK`);
	}

	const npmExecPathFromEnv = (process.env.npm_execpath ?? "").trim();
	const npmPath = npmExecPathFromEnv.length > 0 ? npmExecPathFromEnv : findCommandInPath("npm");
	if (!npmPath) {
		failures.push("npm is required but was not found in PATH.");
	} else {
		details.push(`npm entrypoint detected at ${npmPath}`);
	}

	const gitPath = findCommandInPath("git");
	if (!gitPath) {
		failures.push("git is required but was not found in PATH.");
	} else {
		const gitCheck = runCommand(gitPath, ["--version"]);
		if (gitCheck.status === 0 && gitCheck.stdout.trim().length > 0) {
			details.push(`${gitCheck.stdout.trim()} OK`);
		} else {
			details.push(`git entrypoint detected at ${gitPath}`);
		}
	}

	if (!existsSync(join(cwd, ".git"))) {
		failures.push(`No .git entry found in ${cwd}. Run this command from repo root.`);
	} else {
		details.push("Git worktree root detected");
	}

	if (!existsSync(join(cwd, "package.json"))) {
		failures.push("package.json is missing in the current directory.");
	} else {
		details.push("package.json detected");
	}

	if (!existsSync(join(cwd, "package-lock.json"))) {
		failures.push("package-lock.json is missing. This repo expects npm lockfile-based installs.");
	} else {
		details.push("package-lock.json detected");
	}

	const scripts = readPackageScripts(cwd);
	const requiredScripts = ["typecheck", "lint", "test", "build"];
	for (const scriptName of requiredScripts) {
		if (!scripts || typeof scripts[scriptName] !== "string") {
			failures.push(`Missing required npm script: ${scriptName}`);
		}
	}

	if (!existsSync(join(cwd, "node_modules"))) {
		warnings.push("node_modules is missing. Run npm ci before running local validation.");
	}

	for (const detail of details) {
		console.log(`OK: ${detail}`);
	}
	for (const warning of warnings) {
		console.warn(`WARN: ${warning}`);
	}
	for (const failure of failures) {
		console.error(`ERROR: ${failure}`);
	}

	if (failures.length > 0) {
		console.error("Dev doctor failed. Fix errors above and re-run.");
		return 1;
	}

	console.log("Dev doctor passed.");
	return 0;
}

const isDirectRun = (() => {
	try {
		return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isDirectRun) {
	process.exitCode = runDevDoctor();
}
