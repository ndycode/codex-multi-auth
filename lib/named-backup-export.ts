import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolvePath } from "./storage/paths.js";

const BACKUP_EXPORT_DIR_NAME = "backups";
const BACKUP_FILE_EXTENSION = ".json";
const BACKUP_SAFE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const BACKUP_INVALID_SUFFIXES = [".tmp", ".wal"];
const BACKUP_PROHIBITED_SUBSTRINGS = [".rotate."];

export interface NamedBackupExportDependencies {
	getStoragePath: () => string;
	exportAccounts: (filePath: string, force?: boolean) => Promise<void>;
}

function normalizePathForComparison(pathValue: string): string {
	const resolvedPath = resolve(pathValue);
	return process.platform === "win32"
		? resolvedPath.toLowerCase()
		: resolvedPath;
}

function assertWithinDirectory(baseDir: string, targetPath: string): void {
	const normalizedBase = normalizePathForComparison(baseDir);
	const normalizedTarget = normalizePathForComparison(targetPath);
	const rel = relative(normalizedBase, normalizedTarget);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
		return;
	}
	throw new Error("Named backup path escapes the backup root");
}

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
	if (!BACKUP_SAFE_NAME_REGEX.test(baseName)) {
		throw new Error(
			"Backup filename may only contain letters, numbers, hyphens, and underscores",
		);
	}

	return `${baseName}${BACKUP_FILE_EXTENSION}`;
}

export function getNamedBackupRoot(storagePath: string): string {
	const resolvedStoragePath = resolvePath(storagePath);
	return resolvePath(
		join(dirname(resolvedStoragePath), BACKUP_EXPORT_DIR_NAME),
	);
}

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

export async function exportNamedBackupFile(
	name: string,
	dependencies: NamedBackupExportDependencies,
	options?: { force?: boolean },
): Promise<string> {
	const destination = resolveNamedBackupPath(
		name,
		dependencies.getStoragePath(),
	);
	await dependencies.exportAccounts(destination, options?.force === true);
	return destination;
}
