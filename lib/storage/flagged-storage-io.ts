import { existsSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { FlaggedAccountStorageV1Schema, safeParseJson } from "../schemas.js";
import type { FlaggedAccountStorageV1 } from "./public-types.js";
import { readFileWithRetry } from "./flagged-storage-file.js";
import { FILE_RETRY_CODES } from "../fs-retry.js";

// storage-07: align with the single shared retryable-code set (adds ENOTEMPTY/
// EACCES) instead of a local subset.
const RETRYABLE_UNLINK_CODES = FILE_RETRY_CODES;

function isValidFlaggedStorageCandidate(
	data: unknown,
	storage: FlaggedAccountStorageV1,
): boolean {
	if (
		!data ||
		typeof data !== "object" ||
		!Object.hasOwn(data, "version") ||
		!Object.hasOwn(data, "accounts")
	) {
		return false;
	}
	const candidate = data as { version?: unknown; accounts?: unknown };
	if (candidate.version !== 1 || !Array.isArray(candidate.accounts)) {
		return false;
	}
	return candidate.accounts.length === 0 || storage.accounts.length > 0;
}

/**
 * Parse flagged account storage content with Zod as the authoritative
 * validator while preserving legacy JSON-level recovery semantics.
 *
 * - On Zod-valid JSON: returns the validated payload directly (Zod wins).
 * - On JSON-valid but schema-invalid: returns the raw JSON so the caller can
 *   still invoke `normalizeFlaggedStorage` + `isValidFlaggedStorageCandidate`
 *   (preserves legacy partial-recovery behavior).
 * - On `SyntaxError`: the error propagates to outer `try/catch` blocks which
 *   log + fall back to backups (same as pre-migration behavior).
 */
function parseFlaggedStorageContent(content: string, context: string): unknown {
	const validated = safeParseJson(
		content,
		FlaggedAccountStorageV1Schema,
		context,
	);
	if (validated !== null) {
		return validated;
	}
	return JSON.parse(content) as unknown;
}

/**
 * Return the ordered backup paths consulted for flagged-account recovery.
 */
function getFlaggedBackupPaths(path: string): string[] {
	return [`${path}.bak`, `${path}.bak.1`, `${path}.bak.2`];
}

async function unlinkWithRetry(candidatePath: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.unlink(candidatePath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return;
			}
			if (!code || !RETRYABLE_UNLINK_CODES.has(code) || attempt >= 4) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
		}
	}
}

export async function loadFlaggedAccountsState(params: {
	path: string;
	legacyPath: string;
	resetMarkerPath: string;
	normalizeFlaggedStorage: (data: unknown) => FlaggedAccountStorageV1;
	persistRecoveredBackup: (
		storage: FlaggedAccountStorageV1,
		resetMarkerPath: string,
	) => Promise<boolean>;
	saveFlaggedAccounts: (storage: FlaggedAccountStorageV1) => Promise<void>;
	logError: (message: string, details: Record<string, unknown>) => void;
	logInfo: (message: string, details: Record<string, unknown>) => void;
}): Promise<FlaggedAccountStorageV1> {
	const empty: FlaggedAccountStorageV1 = { version: 1, accounts: [] };
	if (existsSync(params.resetMarkerPath)) {
		return empty;
	}
	const loadFlaggedBackup =
		async (): Promise<FlaggedAccountStorageV1 | null> => {
			for (const backupPath of getFlaggedBackupPaths(params.path)) {
				if (!existsSync(backupPath)) {
					continue;
				}
				try {
					const backupContent = await readFileWithRetry(backupPath, {
						readFile: fs.readFile,
					});
					const backupData = parseFlaggedStorageContent(
						backupContent,
						"loadFlaggedAccountsState.backup",
					);
					const recovered = params.normalizeFlaggedStorage(backupData);
					if (!isValidFlaggedStorageCandidate(backupData, recovered)) {
						params.logError("Skipping invalid flagged account backup payload", {
							from: backupPath,
							to: params.path,
						});
						continue;
					}
					if (existsSync(params.resetMarkerPath)) {
						return empty;
					}
					if (recovered.accounts.length > 0) {
						try {
							const persisted = await params.persistRecoveredBackup(
								recovered,
								params.resetMarkerPath,
							);
							if (!persisted) {
								return empty;
							}
						} catch (persistError) {
							params.logError(
								"Failed to persist recovered flagged account storage",
								{
									from: backupPath,
									to: params.path,
									error: String(persistError),
								},
							);
							return recovered;
						}
					}
					params.logInfo("Recovered flagged account storage from backup", {
						from: backupPath,
						to: params.path,
						accounts: recovered.accounts.length,
					});
					return recovered;
				} catch (backupError) {
					params.logError(
						"Failed to recover flagged account storage from backup",
						{
							from: backupPath,
							to: params.path,
							error: String(backupError),
						},
					);
				}
			}
			return null;
		};

	try {
		const content = await readFileWithRetry(params.path, {
			readFile: fs.readFile,
		});
		const data = parseFlaggedStorageContent(
			content,
			"loadFlaggedAccountsState.primary",
		);
		const loaded = params.normalizeFlaggedStorage(data);
		if (!isValidFlaggedStorageCandidate(data, loaded)) {
			throw new Error("Invalid flagged account storage payload");
		}
		if (existsSync(params.resetMarkerPath)) {
			return empty;
		}
		return loaded;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			params.logError("Failed to load flagged account storage", {
				path: params.path,
				error: String(error),
			});
			return (await loadFlaggedBackup()) ?? empty;
		}
	}

	const recoveredBackup = await loadFlaggedBackup();
	if (recoveredBackup) {
		return recoveredBackup;
	}

	if (!existsSync(params.legacyPath)) {
		return empty;
	}

	try {
		const legacyContent = await readFileWithRetry(params.legacyPath, {
			readFile: fs.readFile,
		});
		const legacyData = parseFlaggedStorageContent(
			legacyContent,
			"loadFlaggedAccountsState.legacy",
		);
		const migrated = params.normalizeFlaggedStorage(legacyData);
		if (migrated.accounts.length > 0) {
			await params.saveFlaggedAccounts(migrated);
		}
		try {
			await fs.unlink(params.legacyPath);
		} catch {
			// Best effort cleanup.
		}
		params.logInfo("Migrated legacy flagged account storage", {
			from: params.legacyPath,
			to: params.path,
			accounts: migrated.accounts.length,
		});
		return migrated;
	} catch (error) {
		params.logError("Failed to migrate legacy flagged account storage", {
			from: params.legacyPath,
			to: params.path,
			error: String(error),
		});
		return empty;
	}
}

export async function saveFlaggedAccountsUnlockedToDisk(
	storage: FlaggedAccountStorageV1,
	params: {
		path: string;
		markerPath: string;
		normalizeFlaggedStorage: (data: unknown) => FlaggedAccountStorageV1;
		copyFileWithRetry: (
			source: string,
			destination: string,
			options?: { allowMissingSource?: boolean },
		) => Promise<void>;
		renameFileWithRetry: (source: string, destination: string) => Promise<void>;
		logWarn: (message: string, details: Record<string, unknown>) => void;
		logError: (message: string, details: Record<string, unknown>) => void;
	},
): Promise<void> {
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${params.path}.${uniqueSuffix}.tmp`;

	try {
		await fs.mkdir(dirname(params.path), { recursive: true });
		if (existsSync(params.path)) {
			try {
				await params.copyFileWithRetry(params.path, `${params.path}.bak`, {
					allowMissingSource: true,
				});
			} catch (backupError) {
				params.logWarn("Failed to create flagged backup snapshot", {
					path: params.path,
					error: String(backupError),
				});
			}
		}
		const content = JSON.stringify(
			params.normalizeFlaggedStorage(storage),
			null,
			2,
		);
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await params.renameFileWithRetry(tempPath, params.path);
		try {
			await fs.unlink(params.markerPath);
		} catch {
			// Best effort cleanup.
		}
	} catch (error) {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Ignore cleanup failures.
		}
		params.logError("Failed to save flagged account storage", {
			path: params.path,
			error: String(error),
		});
		throw error;
	}
}

export async function clearFlaggedAccountsOnDisk(params: {
	path: string;
	markerPath: string;
	backupPaths: string[];
	logError: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	let keepResetMarker = false;
	try {
		await fs.writeFile(params.markerPath, "reset", {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch (error) {
		params.logError("Failed to write flagged reset marker", {
			path: params.path,
			markerPath: params.markerPath,
			error: String(error),
		});
		throw error;
	}
	for (const candidate of [params.path, ...params.backupPaths]) {
		try {
			await unlinkWithRetry(candidate);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				params.logError("Failed to clear flagged account storage", {
					path: candidate,
					error: String(error),
				});
				if (candidate === params.path) {
					throw error;
				}
				keepResetMarker = true;
			}
		}
	}
	if (!keepResetMarker) {
		try {
			await unlinkWithRetry(params.markerPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				params.logError("Failed to clear flagged account storage", {
					path: params.markerPath,
					error: String(error),
				});
				throw error;
			}
		}
	}
}
