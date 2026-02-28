/**
 * Path resolution utilities for account storage.
 * Extracted from storage.ts to reduce module size.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getCodexMultiAuthDir } from "../runtime-paths.js";

const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".codex"];
const PROJECTS_DIR = "projects";
const PROJECT_KEY_HASH_LENGTH = 12;

function parseGitDirPointer(pointerContent: string): string | null {
	const firstLine = pointerContent.split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return null;
	const match = /^gitdir:\s*(.+)$/i.exec(firstLine);
	if (!match?.[1]) return null;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

function normalizePathDelimiters(pathValue: string): string {
	return pathValue.replace(/\\/g, "/");
}

function isWindowsRootedPath(pathValue: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(pathValue) || /^\\\\[^\\]/.test(pathValue) || /^\/\/[^/]/.test(pathValue);
}

function resolveGitPath(basePath: string, pointerValue: string): string {
	const trimmedPointer = pointerValue.trim();
	if (!trimmedPointer) {
		return basePath;
	}

	if (isWindowsRootedPath(basePath) || isWindowsRootedPath(trimmedPointer)) {
		const windowsBase = win32.normalize(basePath.replace(/\//g, "\\"));
		const windowsPointer = win32.normalize(trimmedPointer.replace(/\//g, "\\"));
		const windowsResolved = win32.isAbsolute(windowsPointer)
			? windowsPointer
			: win32.resolve(windowsBase, windowsPointer);
		return process.platform === "win32"
			? windowsResolved
			: normalizePathDelimiters(windowsResolved);
	}

	const normalizedPointer = normalizePathDelimiters(trimmedPointer);
	return isAbsolute(normalizedPointer)
		? normalizedPointer
		: resolve(basePath, normalizedPointer);
}

function readGitCommonDir(gitDirPath: string): string {
	const commonDirFile = join(gitDirPath, "commondir");
	if (!existsSync(commonDirFile)) {
		return gitDirPath;
	}

	try {
		const raw = readFileSync(commonDirFile, "utf-8").trim();
		if (!raw) return gitDirPath;
		return resolveGitPath(gitDirPath, raw);
	} catch {
		return gitDirPath;
	}
}

function isWorktreeGitDirPath(gitDirPath: string): boolean {
	const normalized = normalizePathDelimiters(gitDirPath).toLowerCase();
	return normalized.includes("/.git/worktrees/");
}

function normalizePathForIdentityCheck(pathValue: string): string {
	const normalizedDelimiters = normalizePathDelimiters(pathValue.trim());
	if (!normalizedDelimiters) {
		return normalizedDelimiters;
	}

	if (isWindowsRootedPath(normalizedDelimiters)) {
		return win32.normalize(normalizedDelimiters.replace(/\//g, "\\")).toLowerCase();
	}

	const resolvedPath = resolve(normalizedDelimiters);
	const normalizedResolved = normalizePathDelimiters(resolvedPath);
	return process.platform === "win32" ? normalizedResolved.toLowerCase() : normalizedResolved;
}

function worktreeGitDirBelongsToProject(projectRoot: string, gitDirPath: string): boolean {
	const gitdirBackRefPath = join(gitDirPath, "gitdir");
	if (!existsSync(gitdirBackRefPath)) {
		return false;
	}

	try {
		const gitdirBackRefRaw = readFileSync(gitdirBackRefPath, "utf-8").trim();
		if (!gitdirBackRefRaw) {
			return false;
		}

		const resolvedBackRef = resolveGitPath(gitDirPath, gitdirBackRefRaw);
		const expectedBackRef = join(projectRoot, ".git");
		return (
			normalizePathForIdentityCheck(resolvedBackRef) ===
			normalizePathForIdentityCheck(expectedBackRef)
		);
	} catch {
		return false;
	}
}

function isGitDirUnderCommonWorktrees(gitDirPath: string, commonGitDir: string): boolean {
	const normalizedGitDir = normalizePathDelimiters(
		normalizePathForIdentityCheck(gitDirPath),
	).replace(/\/+$/, "");
	const normalizedCommonGitDir = normalizePathDelimiters(
		normalizePathForIdentityCheck(commonGitDir),
	).replace(/\/+$/, "");

	if (!normalizedGitDir || !normalizedCommonGitDir) {
		return false;
	}

	const worktreesRoot = `${normalizedCommonGitDir}/worktrees/`;
	return normalizedGitDir.startsWith(worktreesRoot);
}

/**
 * Gets the path to the global Codex multi-auth configuration directory.
 *
 * The returned path is platform-specific (may use Windows separators and casing). The directory is intended for concurrent use by multiple processes; callers should treat its contents as sensitive (redact tokens/credentials when logging).
 *
 * @returns The absolute filesystem path to the Codex multi-auth configuration directory.
 */
export function getConfigDir(): string {
	return getCodexMultiAuthDir();
}

/**
 * Get the per-project .codex directory path inside the given project path.
 *
 * This function is pure and safe for concurrent use. The returned path uses the platform's native separators; on Windows, casing and separators follow OS semantics and callers should normalize if needed. The returned value may contain sensitive segments derived from `projectPath`; callers should redact secrets before logging.
 *
 * @param projectPath - Project directory path (absolute or relative)
 * @returns The path to the project's ".codex" configuration directory
 */
export function getProjectConfigDir(projectPath: string): string {
	return join(projectPath, ".codex");
}

/**
 * Normalize a project filesystem path for consistent comparison and storage.
 *
 * Produces an absolute path with forward slashes; on Windows the path is also converted to lowercase
 * to make comparisons case-insensitive. This function is pure and safe for concurrent use.
 *
 * Note: this function does not redact or remove sensitive tokens from the path — callers must
 * perform any required redaction before logging or exposing paths.
 *
 * @param projectPath - The input path to normalize
 * @returns The absolute, forward-slash-normalized path; on Windows the result is lowercased
 */
function normalizeProjectPath(projectPath: string): string {
	const resolvedPath = resolve(projectPath);
	const normalizedSeparators = resolvedPath.replace(/\\/g, "/");
	return process.platform === "win32"
		? normalizedSeparators.toLowerCase()
		: normalizedSeparators;
}

/**
 * Produce a filesystem-safe project name derived from a project path.
 *
 * The returned name contains only letters, digits, dots, underscores, and hyphens,
 * has no leading or trailing hyphens, and is never empty (falls back to `"project"`).
 * This function is pure and safe to call concurrently. It does not perform any
 * secret/token redaction and does not depend on platform-specific case normalization;
 * additional normalization for Windows filenames should be applied by the caller if needed.
 *
 * @param projectPath - Path to the project (used only to derive the basename)
 * @returns A sanitized project name suitable for use in filenames and identifiers
 */
function sanitizeProjectName(projectPath: string): string {
	const name = basename(projectPath);
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "project";
}

/**
 * Create a deterministic, filesystem-safe storage key for a project path.
 *
 * The key is "<sanitized-name>-<truncated-hex>" where the sanitized name is derived from the project's basename (disallowed characters replaced, trimmed, and truncated to 40 characters) and the hex segment is the first 12 characters of a SHA-256 hash of the normalized path. On Windows the path is normalized to lowercase before hashing to ensure case-insensitive equivalence. The function is pure and safe for concurrent use; it produces the same output for equivalent paths and does not perform I/O. The key does not include the raw project path, so tokens or secrets embedded in the original path are not directly exposed.
 *
 * @param projectPath - Project path in any form; it will be normalized (expanded, resolved, and platform-normalized) before key generation
 * @returns A filesystem-safe storage key string composed of a sanitized project name (up to 40 chars), a dash, and a 12-character hex hash
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
 * Compute the global per-project storage directory path under the Codex multi-auth projects directory.
 *
 * The returned path is grounded in the global Codex multi-auth config directory and is namespaced
 * by a filesystem-friendly project storage key derived from `projectPath` (sanitized and hashed to
 * avoid embedding sensitive tokens or raw paths).
 *
 * Concurrency: the resulting directory may be accessed by multiple processes; callers are responsible
 * for any required concurrency-safe operations when creating or mutating files within it.
 *
 * Windows: storage key derivation normalizes path separators and casing to produce stable keys on
 * Windows hosts.
 *
 * @param projectPath - The project filesystem path used to derive the per-project storage key.
 * @returns The absolute path to the project's storage directory under the global Codex multi-auth projects directory.
 */
export function getProjectGlobalConfigDir(projectPath: string): string {
	return join(getConfigDir(), PROJECTS_DIR, getProjectStorageKey(projectPath));
}

/**
 * Resolve a stable project identity root for account storage keying.
 *
 * For standard repositories, this returns `projectRoot` unchanged.
 * For linked Git worktrees, this resolves to the shared repository root so
 * multiple worktrees use the same per-project account key.
 *
 * @param projectRoot - Detected project root path (typically from findProjectRoot)
 * @returns Identity root used for per-project storage key generation
 */
export function resolveProjectStorageIdentityRoot(projectRoot: string): string {
	const gitEntryPath = join(projectRoot, ".git");
	if (!existsSync(gitEntryPath)) {
		return projectRoot;
	}

	try {
		const gitEntryStat = statSync(gitEntryPath);
		if (gitEntryStat.isDirectory()) {
			return projectRoot;
		}
		if (!gitEntryStat.isFile()) {
			return projectRoot;
		}

		const gitPointer = readFileSync(gitEntryPath, "utf-8");
		const gitDirValue = parseGitDirPointer(gitPointer);
		if (!gitDirValue) {
			return projectRoot;
		}

		const gitDirPath = resolveGitPath(projectRoot, gitDirValue);
		if (!isWorktreeGitDirPath(gitDirPath)) {
			return projectRoot;
		}
		if (!worktreeGitDirBelongsToProject(projectRoot, gitDirPath)) {
			return projectRoot;
		}

		const commonGitDir = readGitCommonDir(gitDirPath);
		if (!isGitDirUnderCommonWorktrees(gitDirPath, commonGitDir)) {
			return projectRoot;
		}
		const candidateRepoRoot = dirname(commonGitDir);
		if (!existsSync(join(candidateRepoRoot, ".git"))) {
			return projectRoot;
		}

		return candidateRepoRoot;
	} catch {
		return projectRoot;
	}
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
