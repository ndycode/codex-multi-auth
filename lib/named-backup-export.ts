import { existsSync, promises as fs, lstatSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { resolvePath } from "./storage/paths.js";

const BACKUP_EXPORT_DIR_NAME = "backups";
const BACKUP_FILE_EXTENSION = ".json";
const BACKUP_SAFE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const BACKUP_WINDOWS_RESERVED_NAME_REGEX =
	/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const BACKUP_INVALID_SUFFIXES = [".tmp", ".wal"];
const BACKUP_PROHIBITED_SUBSTRINGS = [".rotate."];

export interface NamedBackupExportDependencies {
	getStoragePath: () => string;
	exportAccounts: (
		filePath: string,
		force?: boolean,
		beforeCommit?: (resolvedPath: string) => Promise<void> | void,
	) => Promise<void>;
}

/**
 * Compute a canonical, comparison-ready filesystem path for the given input.
 *
 * Resolves the input to an absolute path, resolves symlinks (realpath) if the path exists, and on Windows converts the resulting canonical path to lowercase for case-insensitive comparisons. The function does not mask or redact any sensitive tokens contained in the path. Note: the returned value may become stale if the filesystem changes after this call (race conditions are possible).
 *
 * @param pathValue - The input filesystem path to normalize.
 * @returns The canonicalized path suitable for equality or containment comparisons; on Windows the result is returned in lowercase.
 */
function normalizePathForComparison(pathValue: string): string {
	const resolvedPath = resolve(pathValue);
	const canonicalPath = existsSync(resolvedPath)
		? realpathSync(resolvedPath)
		: resolvedPath;
	return process.platform === "win32"
		? canonicalPath.toLowerCase()
		: canonicalPath;
}

/**
 * Ensures the resolved target path is located inside the resolved base directory.
 *
 * Validates that `baseDir` is not a symbolic link and that the canonical/resolved
 * forms of `baseDir` and `targetPath` keep `targetPath` rooted under `baseDir`.
 * On Windows, comparisons are performed in a case-insensitive manner via the
 * normalization helper. Errors do not include the original path values.
 *
 * Concurrency: callers must avoid concurrently mutating the filesystem (for example
 * creating/removing/moving symlinks or directories) between calling this function
 * and any subsequent operations that rely on its result. `exportNamedBackupFile`
 * performs a second containment check through the `beforeCommit` hook, but that
 * revalidation narrows rather than eliminates time-of-check/time-of-use windows.
 *
 * @param baseDir - The directory to treat as the backup root; must remain stable during validation.
 * @param targetPath - The candidate target file path that must reside within `baseDir`.
 * @throws Error with message "Named backup path escapes the backup root" if `baseDir` is a symlink,
 *         if the canonical and resolved base paths differ, or if `targetPath` is not contained
 *         within `baseDir`.
 */
function assertWithinDirectory(baseDir: string, targetPath: string): void {
	const resolvedBase = resolve(baseDir);
	let baseStat: ReturnType<typeof lstatSync> | null = null;
	try {
		baseStat = lstatSync(resolvedBase);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			throw error;
		}
	}
	if (baseStat) {
		if (baseStat.isSymbolicLink()) {
			throw new Error("Named backup path escapes the backup root");
		}
		const canonicalBase = realpathSync(resolvedBase);
		const comparableCanonicalBase =
			process.platform === "win32"
				? canonicalBase.toLowerCase()
				: canonicalBase;
		const comparableResolvedBase =
			process.platform === "win32" ? resolvedBase.toLowerCase() : resolvedBase;
		if (comparableCanonicalBase !== comparableResolvedBase) {
			throw new Error("Named backup path escapes the backup root");
		}
	}
	const normalizedBase = normalizePathForComparison(baseDir);
	const targetParent = dirname(targetPath);
	const normalizedTargetParent = normalizePathForComparison(targetParent);
	const normalizedTarget = join(normalizedTargetParent, basename(targetPath));
	const rel = relative(normalizedBase, normalizedTarget);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
		return;
	}
	throw new Error("Named backup path escapes the backup root");
}

/**
 * Validate and normalize a user-provided backup name into a safe `<name>.json` filename.
 *
 * Performs trimming, rejects path separators and traversal tokens, forbids rotation-style
 * substrings and temporary suffixes, and enforces that the base name contains only
 * letters, numbers, hyphens, and underscores. Checks that a resulting base name is non-empty
 * and returns the base name with a `.json` extension appended.
 *
 * Notes:
 * - Validation checks that are sensitive to case are performed using a lowercased form;
 *   this mirrors Windows case-insensitive filesystem behavior for prohibited patterns.
 * - The function is synchronous and safe for concurrent use (pure string validation/normalization).
 * - Token redaction: traversal tokens (`..`), path separators, rotation-style substrings,
 *   and temporary suffixes are rejected rather than sanitized.
 *
 * @param name - The user-provided filename or identifier (may include a `.json` extension)
 * @returns The validated filename with a `.json` extension appended
 * @throws Error if the name is empty, contains separators or traversal tokens, contains
 *         prohibited substrings, ends with an invalid temporary suffix, contains disallowed
 *         characters, or would result in an empty base name
 */
export function normalizeNamedBackupFileName(name: string): string {
	const trimmed = (name ?? "").trim();
	if (trimmed.length === 0) {
		throw new Error("Named backup requires a non-empty filename");
	}
	if (/[\\/]/.test(trimmed)) {
		throw new Error("Backup filename must not contain path separators");
	}
	if (trimmed.includes("..")) {
		throw new Error("Backup filename must not contain traversal tokens");
	}

	const lower = trimmed.toLowerCase();
	if (BACKUP_PROHIBITED_SUBSTRINGS.some((value) => lower.includes(value))) {
		throw new Error("Backup filename may not contain rotation-style sequences");
	}

	const hasJsonExtension = lower.endsWith(BACKUP_FILE_EXTENSION);
	const baseName = hasJsonExtension
		? trimmed.slice(0, trimmed.length - BACKUP_FILE_EXTENSION.length)
		: trimmed;
	if (baseName.length === 0) {
		throw new Error("Backup filename cannot be just an extension");
	}
	const baseLower = baseName.toLowerCase();
	if (BACKUP_INVALID_SUFFIXES.some((value) => baseLower.endsWith(value))) {
		throw new Error("Backup filename may not end with temporary suffixes");
	}
	if (BACKUP_WINDOWS_RESERVED_NAME_REGEX.test(baseName)) {
		throw new Error(
			"Backup filename may not use a reserved Windows device name",
		);
	}
	if (!BACKUP_SAFE_NAME_REGEX.test(baseName)) {
		throw new Error(
			"Backup filename may only contain letters, numbers, hyphens, and underscores; dots (.) are not allowed",
		);
	}

	return `${baseName}${BACKUP_FILE_EXTENSION}`;
}

/**
 * Compute the absolute path for the "backups" directory placed alongside the given storage path.
 *
 * This performs only path resolution and string manipulation; it does not access the filesystem and is insensitive to concurrent filesystem changes. It does not redact or sanitize tokens or sensitive substrings in `storagePath`. Note: other functions in this module handle Windows case-insensitive comparisons when validating paths.
 *
 * @param storagePath - Storage file or directory path (may be relative or absolute)
 * @returns The resolved path to the backups directory adjacent to `storagePath` (i.e. dirname(storagePath)/backups)
 */
export function getNamedBackupRoot(storagePath: string): string {
	const resolvedStoragePath = resolvePath(storagePath);
	return resolvePath(
		join(dirname(resolvedStoragePath), BACKUP_EXPORT_DIR_NAME),
	);
}

/**
 * Resolve and validate a safe backup file path for a named backup inside the storage path's backups directory.
 *
 * @param name - User-provided backup name; will be normalized and validated (disallows path separators, `..`, prohibited substrings, and invalid suffixes such as `.tmp`/`.wal`) and the canonical filename (`*.json`) will be produced.
 * @param storagePath - Base storage path used to locate the backups directory; path comparisons treat Windows paths case-insensitively.
 * @returns The absolute, validated path to the backup file within the backups directory.
 *
 * Concurrency: this function only computes and validates the path and does not create files or directories; callers must handle concurrent filesystem operations (e.g., directory creation or file writes).
 */
export function resolveNamedBackupPath(
	name: string,
	storagePath: string,
): string {
	const fileName = normalizeNamedBackupFileName(name);
	const backupRoot = getNamedBackupRoot(storagePath);
	const candidate = resolvePath(join(backupRoot, fileName));
	assertWithinDirectory(backupRoot, candidate);
	return candidate;
}

/**
 * Create a named backup file inside the storage path's backups directory and return its resolved path.
 *
 * The provided `name` is validated and normalized (suffix, allowed characters, and prohibited substrings) and the
 * backup root directory is created if missing. The export operation will be asked to write to the resolved path; a
 * safety check ensures the final resolved path stays within the backups root.
 * The delegated `beforeCommit` hook re-validates containment immediately before
 * the storage layer commits the final rename, but callers should still serialize
 * backup-root mutations rather than relying on path checks alone.
 *
 * Concurrency: callers should avoid concurrent exports that target the same `name` as behavior is unspecified.
 * Windows behavior: file-name/path comparisons are case-insensitive and names are normalized to lowercase.
 * Token rules: input `name` is checked to prevent path traversal, separators, rotation-style substrings, and certain
 * invalid suffixes (e.g., `.tmp`, `.wal`); the final returned path always includes the `.json` extension.
 *
 * @param name - The desired backup file name (validated and normalized).
 * @param dependencies - Object providing storage path resolution and the exportAccounts implementation.
 * @param options.force - When true, request overwriting an existing backup.
 * @returns The absolute path to the created backup file (including `.json`).
 */
export async function exportNamedBackupFile(
	name: string,
	dependencies: NamedBackupExportDependencies,
	options?: { force?: boolean },
): Promise<string> {
	const storagePath = dependencies.getStoragePath();
	const destination = resolveNamedBackupPath(name, storagePath);
	const backupRoot = getNamedBackupRoot(storagePath);
	await fs.mkdir(backupRoot, { recursive: true });
	await dependencies.exportAccounts(
		destination,
		options?.force === true,
		(resolvedPath) => {
			assertWithinDirectory(backupRoot, resolvedPath);
		},
	);
	return destination;
}
