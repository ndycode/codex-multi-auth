import { StorageError } from "../errors.js";

function extractErrorCode(error: unknown): string {
	const err = error as NodeJS.ErrnoException;
	return err?.code || "UNKNOWN";
}

/**
 * Format a user-facing hint for storage persistence failures based on errno code.
 */
export function formatStorageErrorHint(error: unknown, path: string): string {
	const code = extractErrorCode(error);
	const isWindows = process.platform === "win32";

	switch (code) {
		case "EACCES":
		case "EPERM":
			return isWindows
				? `Permission denied writing to ${path}. Check antivirus exclusions for this folder. Ensure you have write permissions.`
				: `Permission denied writing to ${path}. Check folder permissions. Try: chmod 755 ~/.codex`;
		case "EBUSY":
			return `File is locked at ${path}. The file may be open in another program. Close any editors or processes accessing it.`;
		case "ENOENT":
			return `Path does not exist: ${path}. Create the parent folder and try again.`;
		case "ENOSPC":
			return `Disk is full. Free up space and try again. Path: ${path}`;
		default:
			return isWindows
				? `Failed to write to ${path}. Check folder permissions and ensure path contains no special characters.`
				: `Failed to write to ${path}. Check folder permissions and disk space.`;
	}
}

/**
 * Wrap an arbitrary storage failure in a StorageError with a derived hint.
 */
export function toStorageError(
	message: string,
	error: unknown,
	path: string,
): StorageError {
	return new StorageError(
		message,
		extractErrorCode(error),
		path,
		formatStorageErrorHint(error, path),
		error instanceof Error ? error : undefined,
	);
}
