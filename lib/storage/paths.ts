/**
 * Path resolution utilities for account storage.
 * Extracted from storage.ts to reduce module size.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getCodexMultiAuthDir } from "../runtime-paths.js";

const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".codex"];
const PROJECTS_DIR = "projects";
const PROJECT_KEY_HASH_LENGTH = 12;

/**
 * Get the base directory used for multi-project authentication storage for Codex.
 *
 * This directory is the root for per-project storage (e.g., ~/.codex/multi-auth). Calls are safe to make concurrently; the function only returns a path and does not perform I/O. On Windows the returned path may be case-insensitive. The directory is used to store sensitive tokens and credentials — treat its contents as confidential and avoid logging raw paths or token values (redact when necessary).
 *
 * @returns The absolute path to the Codex multi-auth configuration directory
 */
export function getConfigDir(): string {
	return getCodexMultiAuthDir();
}

/**
 * Get the filesystem path for a project's local .codex configuration directory.
 *
 * @param projectPath - The project root directory path
 * @returns The path to the `.codex` directory inside `projectPath` (uses OS-specific path separators)
 *
 * Concurrency: this is a pure string operation (no I/O); callers must handle concurrent filesystem access separately.
 * Windows: returned path will use Windows path separators and casing behavior depends on caller normalization.
 * Security: files stored under this directory may contain sensitive tokens and should be treated as sensitive/redacted when displayed.
 */
export function getProjectConfigDir(projectPath: string): string {
	return join(projectPath, ".codex");
}

/**
 * Normalize a project filesystem path for consistent comparison and storage.
 *
 * Resolves the given path to an absolute path, replaces backslashes with forward
 * slashes, and on Windows converts the result to lowercase to support
 * case-insensitive comparisons.
 *
 * Concurrency: pure and reentrant; safe to call concurrently.
 *
 * Token redaction: this function does not redact or remove sensitive path
 * segments — callers must redact secrets before logging or persisting.
 *
 * @param projectPath - The filesystem path to normalize (absolute or relative).
 * @returns The normalized absolute path with forward slashes; lowercased on Windows.
 */
function normalizeProjectPath(projectPath: string): string {
	const resolvedPath = resolve(projectPath);
	const normalizedSeparators = resolvedPath.replace(/\\/g, "/");
	return process.platform === "win32"
		? normalizedSeparators.toLowerCase()
		: normalizedSeparators;
}

function sanitizeProjectName(projectPath: string): string {
	const name = basename(projectPath);
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "project";
}

/**
 * Builds a deterministic, filesystem-safe storage key for a project path.
 *
 * @param projectPath - Path to the project; it will be normalized (absolute, unified separators, and lowercased on Windows) before key generation.
 * @returns A composite key of the form `<sanitized-name>-<hash>` where `sanitized-name` is the project name with disallowed characters replaced and truncated to 40 characters, and `hash` is the first 12 hex characters of the SHA-256 of the normalized path.
 *
 * Concurrency: key generation is deterministic and safe to compute concurrently from multiple processes.
 * Windows behavior: normalization lowercases the path to ensure case-insensitive matching on Windows.
 * Token/redaction: the key does not embed the raw path or secrets; it includes a sanitized name plus a truncated hash suitable for storage or logging.
 */
export function getProjectStorageKey(projectPath: string): string {
	const normalizedPath = normalizeProjectPath(projectPath);
	const hash = createHash("sha256")
		.update(normalizedPath)
		.digest("hex")
		.slice(0, PROJECT_KEY_HASH_LENGTH);
	const projectName = sanitizeProjectName(normalizedPath).slice(0, 40);
	return `${projectName}-${hash}`;
}

/**
 * Compute the per-project global config directory path under the Codex multi-auth storage.
 *
 * The result is a path inside the multi-auth projects directory that is safe to store
 * per-project credentials without writing into the project repository.
 *
 * @param projectPath - The project filesystem path (absolute or relative). The path is normalized;
 *                       on Windows normalization uses case-insensitive comparison (lowercased).
 * @returns The absolute directory path for this project's global config (e.g. ~/.codex/multi-auth/projects/<sanitized-name>-<hash>).
 *
 * Concurrency: pure and deterministic — safe to call concurrently from multiple processes/threads.
 * Privacy: the directory name is filesystem-safe and includes a sanitized project name plus a truncated hash
 *          to avoid exposing the full project path in filenames.
 */
export function getProjectGlobalConfigDir(projectPath: string): string {
	return join(getConfigDir(), PROJECTS_DIR, getProjectStorageKey(projectPath));
}

export function isProjectDirectory(dir: string): boolean {
	return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

export function findProjectRoot(startDir: string): string | null {
	let current = startDir;
	const root = dirname(current) === current ? current : null;
	
	while (current) {
		if (isProjectDirectory(current)) {
			return current;
		}
		
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	
	return root && isProjectDirectory(root) ? root : null;
}

function normalizePathForComparison(filePath: string): string {
	const resolvedPath = resolve(filePath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function isWithinDirectory(baseDir: string, targetPath: string): boolean {
	const normalizedBase = normalizePathForComparison(baseDir);
	const normalizedTarget = normalizePathForComparison(targetPath);
	const rel = relative(normalizedBase, normalizedTarget);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolvePath(filePath: string): string {
	let resolved: string;
	if (filePath.startsWith("~")) {
		resolved = join(homedir(), filePath.slice(1));
	} else {
		resolved = resolve(filePath);
	}

	const home = homedir();
	const cwd = process.cwd();
	const tmp = tmpdir();
	if (
		!isWithinDirectory(home, resolved) &&
		!isWithinDirectory(cwd, resolved) &&
		!isWithinDirectory(tmp, resolved)
	) {
		throw new Error(`Access denied: path must be within home directory, project directory, or temp directory`);
	}

	return resolved;
}
