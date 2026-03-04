import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE_MAJOR = 18;
const WINDOWS_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const PACKAGE_READ_RETRY_ATTEMPTS = 4;
const PACKAGE_READ_BASE_DELAY_MS = 40;

function sleepSync(milliseconds) {
	if (milliseconds <= 0) {
		return;
	}

	try {
		const sleepBuffer = new SharedArrayBuffer(4);
		const sleepArray = new Int32Array(sleepBuffer);
		Atomics.wait(sleepArray, 0, 0, milliseconds);
	} catch {
		const end = Date.now() + milliseconds;
		while (Date.now() < end) {
			// Synchronous fallback only used for tiny retry delays.
		}
	}
}

function isWindowsLockError(error) {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	const { code } = error;
	return typeof code === "string" && WINDOWS_LOCK_CODES.has(code.toUpperCase());
}

function runCommand(command, args = [], spawnFn = spawnSync) {
	try {
		return spawnFn(command, args, {
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

export function splitPathEntries(pathValue, platform = process.platform) {
	if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
		return [];
	}

	const delimiter = platform === "win32" ? ";" : ":";
	return pathValue
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function commandExistsAtPath(commandPath, pathExists = existsSync) {
	try {
		return pathExists(commandPath);
	} catch {
		return false;
	}
}

export function findCommandInPath(commandName, options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const pathExists = options.pathExists ?? existsSync;
	const pathEntries = splitPathEntries(env.PATH ?? "", platform);
	const hasExtension = /\.[A-Za-z0-9]+$/.test(commandName);
	const windowsExtensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1")
		.split(";")
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => ext.length > 0);

	for (const entry of pathEntries) {
		if (platform !== "win32") {
			const candidate = join(entry, commandName);
			if (commandExistsAtPath(candidate, pathExists)) {
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
			if (commandExistsAtPath(candidate, pathExists)) {
				return candidate;
			}
		}
	}

	return null;
}

export function getNodeMajor(versionText) {
	const clean = versionText.trim().replace(/^v/, "");
	const major = Number.parseInt(clean.split(".")[0] ?? "", 10);
	return Number.isFinite(major) ? major : null;
}

function parsePackageScripts(packageJsonText) {
	const packageJson = JSON.parse(packageJsonText);
	if (typeof packageJson !== "object" || packageJson === null) {
		return null;
	}

	const scripts = packageJson.scripts;
	if (typeof scripts !== "object" || scripts === null) {
		return null;
	}

	return scripts;
}

export function readPackageScripts(repoRoot, options = {}) {
	const platform = options.platform ?? process.platform;
	const pathExists = options.pathExists ?? existsSync;
	const readFile = options.readFile ?? readFileSync;
	const maxAttempts =
		typeof options.maxAttempts === "number"
			? options.maxAttempts
			: platform === "win32"
				? PACKAGE_READ_RETRY_ATTEMPTS
				: 1;
	const baseDelayMs =
		typeof options.baseDelayMs === "number"
			? options.baseDelayMs
			: PACKAGE_READ_BASE_DELAY_MS;

	const packageJsonPath = join(repoRoot, "package.json");
	if (!pathExists(packageJsonPath)) {
		return null;
	}

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const packageJsonText = readFile(packageJsonPath, "utf8");
			return parsePackageScripts(packageJsonText);
		} catch (error) {
			const shouldRetry =
				platform === "win32" &&
				isWindowsLockError(error) &&
				attempt < maxAttempts;
			if (shouldRetry) {
				const delayMs = baseDelayMs * 2 ** (attempt - 1);
				sleepSync(delayMs);
				continue;
			}
			return null;
		}
	}

	return null;
}

export function runDevDoctor(options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const execPath = options.execPath ?? process.execPath;
	const nodeVersion = options.nodeVersion ?? process.version;
	const pathExists = options.pathExists ?? existsSync;
	const readFile = options.readFile ?? readFileSync;
	const spawnFn = options.spawnSync ?? spawnSync;
	const log = options.log ?? console.log;
	const warn = options.warn ?? console.warn;
	const error = options.error ?? console.error;
	const failures = [];
	const warnings = [];
	const details = [];

	const nodeMajor = getNodeMajor(nodeVersion);
	if (nodeMajor === null || nodeMajor < REQUIRED_NODE_MAJOR) {
		failures.push(
			`Node.js ${REQUIRED_NODE_MAJOR}+ is required. Found ${nodeVersion}.`,
		);
	} else {
		details.push(`Node.js ${nodeVersion} OK`);
	}

	const npmExecPathFromEnv = (env.npm_execpath ?? "").trim();
	const npmPath =
		npmExecPathFromEnv.length > 0
			? npmExecPathFromEnv
			: findCommandInPath("npm", { env, platform, pathExists });
	if (!npmPath) {
		failures.push("npm is required but was not found in PATH.");
	} else {
		const npmCheck =
			npmExecPathFromEnv.length > 0
				? runCommand(execPath, [npmExecPathFromEnv, "--version"], spawnFn)
				: runCommand(npmPath, ["--version"], spawnFn);
		const npmOutput = `${npmCheck.stdout ?? ""}`.trim();
		if (npmCheck.status === 0 && npmOutput.length > 0) {
			details.push(`npm ${npmOutput} OK`);
		} else {
			failures.push(`npm entrypoint detected at ${npmPath} but could not be executed.`);
		}
	}

	const gitPath = findCommandInPath("git", { env, platform, pathExists });
	if (!gitPath) {
		failures.push("git is required but was not found in PATH.");
	} else {
		const gitCheck = runCommand(gitPath, ["--version"], spawnFn);
		if (gitCheck.status === 0 && gitCheck.stdout.trim().length > 0) {
			details.push(`${gitCheck.stdout.trim()} OK`);
		} else {
			failures.push(`git entrypoint detected at ${gitPath} but could not be executed.`);
		}
	}

	if (!pathExists(join(cwd, ".git"))) {
		failures.push(`No .git entry found in ${cwd}. Run this command from repo root.`);
	} else {
		details.push("Git worktree root detected");
	}

	if (!pathExists(join(cwd, "package.json"))) {
		failures.push("package.json is missing in the current directory.");
	} else {
		details.push("package.json detected");
	}

	if (!pathExists(join(cwd, "package-lock.json"))) {
		failures.push("package-lock.json is missing. This repo expects npm lockfile-based installs.");
	} else {
		details.push("package-lock.json detected");
	}

	const scripts = readPackageScripts(cwd, { platform, pathExists, readFile });
	const requiredScripts = ["typecheck", "lint", "test", "build", "verify"];
	if (!scripts) {
		failures.push(
			"Unable to read package.json scripts. Re-run doctor:dev if Windows EBUSY/EPERM file locks are transient.",
		);
	} else {
		for (const scriptName of requiredScripts) {
			if (typeof scripts[scriptName] !== "string") {
				failures.push(`Missing required npm script: ${scriptName}`);
			}
		}
	}

	if (!pathExists(join(cwd, "node_modules"))) {
		warnings.push("node_modules is missing. Run npm ci before running local validation.");
	}

	for (const detail of details) {
		log(`OK: ${detail}`);
	}
	for (const warning of warnings) {
		warn(`WARN: ${warning}`);
	}
	for (const failure of failures) {
		error(`ERROR: ${failure}`);
	}

	if (failures.length > 0) {
		error("Dev doctor failed. Fix errors above and re-run.");
		return 1;
	}

	log("Dev doctor passed.");
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
