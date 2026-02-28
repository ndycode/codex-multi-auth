#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

/**
 * Retry-capable fs.rm for Windows EBUSY/EPERM/ENOTEMPTY errors.
 * Uses linear backoff (attempt * 50ms) with up to 5 retries.
 */
async function removeWithRetry(targetPath, options) {
	const retryableCodes = new Set(["ENOTEMPTY", "EPERM", "EBUSY"]);
	const maxAttempts = 6;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			const shouldRetry = code !== undefined && retryableCodes.has(code);
			if (!shouldRetry || attempt === maxAttempts) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 50));
		}
	}
}

const ROOT_TEMP_PATTERN = /^\.?tmp/i;
const GENERATED_DIRS = new Set([
	"coverage",
	"dist",
	"node_modules",
	".omx",
	".opencode",
	".sisyphus",
]);
const TRACKED_SCRATCH_FILES = new Set([
	"task_plan.md",
	"findings.md",
	"progress.md",
	"test-results.md",
]);
const TRAVERSAL_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"coverage",
	"vendor",
	".omx",
	".opencode",
	".sisyphus",
	".history",
]);
const REQUIRED_GITIGNORE_PATTERNS = [
	"tmp",
	".tmp",
	"coverage/",
	"dist/",
	"node_modules/",
	".omx/",
	".opencode/",
	".sisyphus/",
	"task_plan.md",
	"findings.md",
	"progress.md",
	"test-results.md",
];

function parseArgs(argv) {
	const args = {
		command: "",
		mode: "safe",
		root: process.cwd(),
		dryRun: false,
	};

	if (argv.length === 0) {
		throw new Error("Usage: repo-hygiene.js <clean|check> [--mode aggressive] [--root path] [--dry-run]");
	}
	args.command = argv[0] ?? "";

	for (let i = 1; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--mode") {
			const value = argv[i + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--mode requires a value");
			}
			args.mode = value;
			i += 1;
		} else if (arg === "--root") {
			const value = argv[i + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--root requires a value");
			}
			args.root = value;
			i += 1;
		} else if (arg === "--dry-run") {
			args.dryRun = true;
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			throw new Error(`Unexpected positional argument: ${arg}`);
		}
	}

	if (!args.root) {
		throw new Error("--root requires a value");
	}
	if (args.command === "clean" && args.mode !== "aggressive") {
		throw new Error('Only "--mode aggressive" is allowed for clean');
	}

	return args;
}

async function ensureRepoRoot(rootPath) {
	const resolved = path.resolve(rootPath);
	const gitDir = path.join(resolved, ".git");
	try {
		await fs.stat(gitDir);
		return resolved;
	} catch {
		throw new Error(`Root path is not a git working tree: ${resolved}`);
	}
}

function isDeletionCandidate(name, isDirectory) {
	if (TRACKED_SCRATCH_FILES.has(name)) {
		return true;
	}
	if (isDirectory && GENERATED_DIRS.has(name)) {
		return true;
	}
	return ROOT_TEMP_PATTERN.test(name);
}

function isProtectedName(name) {
	return [
		".git",
		"lib",
		"test",
		"docs",
		"scripts",
		"config",
		"assets",
		"vendor",
	].includes(name);
}

function isDeepTempCandidate(name, isDirectory) {
	if (isDirectory && (name === "tmp" || ROOT_TEMP_PATTERN.test(name))) {
		return true;
	}
	if (!isDirectory && (name.startsWith(".tmp") || name.endsWith(".tmp"))) {
		return true;
	}
	return false;
}

async function collectNestedTempCandidates(rootPath, dirPath, addCandidate) {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(dirPath, entry.name);
		if (entry.isDirectory() && TRAVERSAL_SKIP_DIRS.has(entry.name)) {
			continue;
		}
		if (isDeepTempCandidate(entry.name, entry.isDirectory())) {
			addCandidate(
				path.relative(rootPath, entryPath).replaceAll("\\", "/"),
				entryPath,
				entry.isDirectory(),
			);
			if (entry.isDirectory()) {
				continue;
			}
		}
		if (entry.isDirectory()) {
			await collectNestedTempCandidates(rootPath, entryPath, addCandidate);
		}
	}
}

async function collectCandidates(rootPath) {
	const rootEntries = await fs.readdir(rootPath, { withFileTypes: true });
	const candidates = [];
	const candidatePaths = new Set();
	const addCandidate = (name, candidatePath, isDirectory) => {
		if (candidatePaths.has(candidatePath)) {
			return;
		}
		candidatePaths.add(candidatePath);
		candidates.push({ name, path: candidatePath, isDirectory });
	};
	for (const entry of rootEntries) {
		if (isProtectedName(entry.name)) {
			continue;
		}
		if (!isDeletionCandidate(entry.name, entry.isDirectory())) {
			continue;
		}
		addCandidate(entry.name, path.join(rootPath, entry.name), entry.isDirectory());
	}

	await collectNestedTempCandidates(rootPath, rootPath, addCandidate);
	return candidates;
}

async function clean(rootPath, dryRun) {
	const candidates = await collectCandidates(rootPath);
	if (candidates.length === 0) {
		console.log("repo-hygiene: no cleanup candidates found");
		return;
	}

	for (const candidate of candidates) {
		const relative = path.relative(rootPath, candidate.path);
		if (!relative || relative.includes("..")) {
			throw new Error(`Refusing to delete non-root candidate: ${candidate.path}`);
		}

		if (dryRun) {
			console.log(`[dry-run] delete ${candidate.name}`);
			continue;
		}
		await removeWithRetry(candidate.path, { recursive: true, force: true });
		console.log(`deleted ${candidate.name}`);
	}
}

function getTrackedPaths(rootPath) {
	try {
		const output = execFileSync("git", ["ls-files"], {
			cwd: rootPath,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.split(/\r?\n/).filter(Boolean);
	} catch (error) {
		throw new Error(
			`git ls-files failed in getTrackedPaths: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function check(rootPath) {
	let hasError = false;

	const tracked = getTrackedPaths(rootPath);
	const trackedViolations = new Set();
	for (const trackedPath of tracked) {
		const normalized = trackedPath.replaceAll("\\", "/");
		const basename = normalized.split("/").pop() ?? normalized;
		if (TRACKED_SCRATCH_FILES.has(basename)) {
			trackedViolations.add(normalized);
		}
	}

	if (trackedViolations.size > 0) {
		hasError = true;
		console.error("repo-hygiene check failed: tracked scratch files present:");
		for (const item of [...trackedViolations].sort()) {
			console.error(`  - ${item}`);
		}
	}

	const gitignorePath = path.join(rootPath, ".gitignore");
	let gitignore = "";
	try {
		gitignore = await fs.readFile(gitignorePath, "utf-8");
	} catch (error) {
		console.warn(
			`repo-hygiene warning: unable to read .gitignore at ${gitignorePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const gitignoreLines = new Set(
		gitignore
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#")),
	);
	const missingPatterns = REQUIRED_GITIGNORE_PATTERNS.filter((pattern) => !gitignoreLines.has(pattern));
	if (missingPatterns.length > 0) {
		hasError = true;
		console.error("repo-hygiene check failed: missing required .gitignore patterns:");
		for (const pattern of missingPatterns) {
			console.error(`  - ${pattern}`);
		}
	}

	if (hasError) {
		process.exitCode = 1;
		return;
	}
	console.log("repo-hygiene check passed");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const rootPath = await ensureRepoRoot(args.root);

	if (args.command === "clean") {
		await clean(rootPath, args.dryRun);
		return;
	}
	if (args.command === "check") {
		await check(rootPath);
		return;
	}

	throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
	console.error(`repo-hygiene error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
