/**
 * Path resolution utilities for account storage.
 * Extracted from storage.ts to reduce module size.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { getStoragePathState } from "./path-state.js";

const PROJECT_MARKERS = [
	".git",
	"package.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	".codex",
];
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
	return (
		/^[A-Za-z]:[\\/]/.test(pathValue) ||
		/^\\\\[^\\]/.test(pathValue) ||
		/^\/\/[^/]/.test(pathValue)
	);
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
		return win32
			.normalize(normalizedDelimiters.replace(/\//g, "\\"))
			.toLowerCase();
	}

	const resolvedPath = resolve(normalizedDelimiters);
	const normalizedResolved = normalizePathDelimiters(resolvedPath);
	return process.platform === "win32"
		? normalizedResolved.toLowerCase()
		: normalizedResolved;
}

function normalizeCanonicalPathForIdentityCheck(pathValue: string): string {
	const normalized = normalizePathForIdentityCheck(pathValue);
	if (!normalized) {
		return normalized;
	}

	try {
		const canonical =
			typeof realpathSync.native === "function"
				? realpathSync.native(pathValue)
				: realpathSync(pathValue);
		return normalizePathForIdentityCheck(canonical);
	} catch {
		return normalized;
	}
}

function worktreeGitDirBelongsToProject(
	projectRoot: string,
	gitDirPath: string,
): boolean {
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
			normalizeCanonicalPathForIdentityCheck(resolvedBackRef) ===
			normalizeCanonicalPathForIdentityCheck(expectedBackRef)
		);
	} catch {
		return false;
	}
}

function isGitDirUnderCommonWorktrees(
	gitDirPath: string,
	commonGitDir: string,
): boolean {
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
	const sanitized = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
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
	let firstMarkerRoot: string | null = null;

	while (current) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}

		if (!firstMarkerRoot && isProjectDirectory(current)) {
			firstMarkerRoot = current;
		}

		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return firstMarkerRoot;
}

function normalizePathForComparison(filePath: string): string {
	const resolvedPath = resolve(filePath);
	return process.platform === "win32"
		? resolvedPath.toLowerCase()
		: resolvedPath;
}

function isWithinDirectory(baseDir: string, targetPath: string): boolean {
	const normalizedBase = normalizePathForComparison(baseDir);
	const normalizedTarget = normalizePathForComparison(targetPath);
	const rel = relative(normalizedBase, normalizedTarget);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Detects lookalike-prefix paths such as `~/../home-outside/file.json` where the
 * target string shares a character prefix with `baseDir` but is actually a sibling
 * (not a descendant). A trailing separator after the base prefix must be present
 * to be considered a proper descendant; anything else (e.g. `home-evil/...`) is a
 * lookalike sibling and must be rejected to prevent path-guard bypass.
 *
 * Filesystem roots (POSIX `/`, Windows `C:\`) are stripped of their trailing
 * separator before comparison so that legitimate descendants such as
 * `C:\Users\neil\.codex\...` are not misclassified as siblings. A root has no
 * siblings by construction, so after the strip we return false early when the
 * base is empty (POSIX root) or just a drive letter (Windows root).
 */
function isLookalikeSibling(baseDir: string, targetPath: string): boolean {
	const normalizedBase = normalizePathForComparison(baseDir);
	const normalizedTarget = normalizePathForComparison(targetPath);
	const baseWithoutTrailingSep = normalizedBase.replace(/[\\/]+$/, "");
	if (
		baseWithoutTrailingSep === "" ||
		/^[a-z]:$/.test(baseWithoutTrailingSep)
	) {
		return false;
	}
	if (normalizedTarget.length <= baseWithoutTrailingSep.length) return false;
	if (!normalizedTarget.startsWith(baseWithoutTrailingSep)) return false;
	const boundary = normalizedTarget.charAt(baseWithoutTrailingSep.length);
	return boundary !== sep && boundary !== "/" && boundary !== "\\";
}

/**
 * Canonicalize the deepest existing ancestor of `targetPath` via realpath so a
 * symlink inside an approved root that points outside it cannot pass the purely
 * lexical containment check (storage-02). We canonicalize the nearest existing
 * ancestor (the target itself may not exist yet for export/write paths) and join
 * the remaining non-existent segments back on. Returns the original path if
 * realpath is unavailable/fails, so behavior degrades to the lexical guard rather
 * than throwing spuriously.
 */
function canonicalizeExistingPrefix(targetPath: string): string {
	let current = targetPath;
	const trailing: string[] = [];
	// Walk up until we find a path component that exists on disk.
	//
	// The 4096 cap is a defensive upper bound on path depth, chosen to exceed any
	// real filesystem path: Linux PATH_MAX is ~4096 *bytes* total (so far fewer
	// components), and Windows is 260 (legacy MAX_PATH) up to 32767 with long-path
	// support — none of which approach 4096 nested directories. It exists purely so
	// a pathological input (e.g. a crafted string of separators) can never spin this
	// loop forever; the `parent === current` root check below is the normal exit.
	// Keep the bound: each iteration performs an existsSync syscall, which is slow on
	// Windows when antivirus filter drivers or network/UNC drives are in play, so we
	// must not let the walk run unbounded.
	for (let i = 0; i < 4096; i++) {
		if (existsSync(current)) break;
		const parent = dirname(current);
		if (parent === current) {
			// Reached the filesystem root without finding an existing ancestor.
			return targetPath;
		}
		trailing.unshift(basename(current));
		current = parent;
	}
	try {
		const realBase = realpathSync(current);
		return trailing.length > 0 ? join(realBase, ...trailing) : realBase;
	} catch {
		return targetPath;
	}
}

export function resolvePath(filePath: string): string {
	// Reject NUL bytes up front (defense in depth): a poison byte cannot traverse
	// out of an approved root, but it must never reach the fs layer — fail here
	// with a clear error rather than letting Node throw deep in a later read/write.
	if (filePath.includes(String.fromCharCode(0))) {
		throw new Error("Invalid path: contains a NUL byte");
	}
	let resolved: string;
	if (filePath.startsWith("~")) {
		resolved = join(homedir(), filePath.slice(1));
	} else {
		resolved = resolve(filePath);
	}

	const home = homedir();
	const projectRoot = getStoragePathState().currentProjectRoot ?? process.cwd();
	const tmp = tmpdir();

	// Reject lookalike-prefix siblings of any approved root, even if the path
	// happens to be within another approved root. A string like
	// `<parent-of-home>/<basename(home)>-outside/file.json` is a sibling of home
	// that must not be treated as within home; without this check, a permissive
	// project-root match could still grant access to a lookalike home path.
	if (
		isLookalikeSibling(home, resolved) ||
		isLookalikeSibling(projectRoot, resolved) ||
		isLookalikeSibling(tmp, resolved)
	) {
		throw new Error(
			`Access denied: path must be within home directory, project directory, or temp directory`,
		);
	}

	if (
		!isWithinDirectory(home, resolved) &&
		!isWithinDirectory(projectRoot, resolved) &&
		!isWithinDirectory(tmp, resolved)
	) {
		throw new Error(
			`Access denied: path must be within home directory, project directory, or temp directory`,
		);
	}

	// storage-02: re-verify containment against the realpath-canonicalized path so
	// a symlink within an approved root that resolves outside it is rejected. If
	// the lexical guard passed but the canonical path escapes every approved root,
	// the path is a symlink-escape and must be denied.
	//
	// Performance note (deliberate correctness-over-speed tradeoff): this block can
	// invoke canonicalizeExistingPrefix up to four times per resolvePath call — once
	// for the target, then for home, projectRoot, and tmp when the canonical target
	// differs from the raw one. Each call walks the directory tree with existsSync +
	// realpathSync, so on Windows (AV filter drivers, UNC/network drives) and for deep
	// paths this is many syscalls. We accept that cost: resolvePath is the security
	// boundary for all file access, and canonicalizing every approved root is what lets
	// us reject genuine symlink escapes without falsely denying legitimate files under a
	// root that is itself reached via a symlink (e.g. macOS /var -> /private/var). The
	// roots are few and shallow, so the extra walks stay bounded in practice.
	const canonical = canonicalizeExistingPrefix(resolved);
	if (canonical !== resolved) {
		// Compare the canonical target against CANONICAL roots, not the raw ones:
		// an approved root can itself live under a symlink (e.g. macOS tmpdir
		// /var/folders/... realpaths to /private/var/folders/...). Comparing a
		// canonicalized target against a non-canonical root would falsely reject a
		// legitimate file under that root. Canonicalizing both sides keeps the
		// symlink-escape rejection while avoiding that false denial.
		const canonicalHome = canonicalizeExistingPrefix(home);
		const canonicalProjectRoot = canonicalizeExistingPrefix(projectRoot);
		const canonicalTmp = canonicalizeExistingPrefix(tmp);
		const escapesRawRoots =
			isLookalikeSibling(home, canonical) ||
			isLookalikeSibling(projectRoot, canonical) ||
			isLookalikeSibling(tmp, canonical) ||
			(!isWithinDirectory(home, canonical) &&
				!isWithinDirectory(projectRoot, canonical) &&
				!isWithinDirectory(tmp, canonical));
		const escapesCanonicalRoots =
			isLookalikeSibling(canonicalHome, canonical) ||
			isLookalikeSibling(canonicalProjectRoot, canonical) ||
			isLookalikeSibling(canonicalTmp, canonical) ||
			(!isWithinDirectory(canonicalHome, canonical) &&
				!isWithinDirectory(canonicalProjectRoot, canonical) &&
				!isWithinDirectory(canonicalTmp, canonical));
		// Only deny when the canonical target is outside BOTH the raw and the
		// canonical root sets — i.e. it is a genuine escape, not just a root that
		// happens to be reached via a symlink.
		if (escapesRawRoots && escapesCanonicalRoots) {
			throw new Error(
				`Access denied: path resolves (via symlink) outside the home, project, or temp directory`,
			);
		}
	}

	return resolved;
}
