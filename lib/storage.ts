import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ACCOUNT_LIMITS } from "./constants.js";
import { createLogger } from "./logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import { AnyAccountStorageSchema, getValidationErrors } from "./schemas.js";
import {
	type AccountMetadataV1,
	type AccountMetadataV3,
	type AccountStorageV1,
	type AccountStorageV3,
	type CooldownReason,
	migrateV1ToV3,
	type RateLimitStateV3,
} from "./storage/migrations.js";
import {
	findProjectRoot,
	getConfigDir,
	getProjectConfigDir,
	getProjectGlobalConfigDir,
	resolvePath,
	resolveProjectStorageIdentityRoot,
} from "./storage/paths.js";

export type {
	CooldownReason,
	RateLimitStateV3,
	AccountMetadataV1,
	AccountStorageV1,
	AccountMetadataV3,
	AccountStorageV3,
};

const log = createLogger("storage");
const ACCOUNTS_FILE_NAME = "openai-codex-accounts.json";
const FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-flagged-accounts.json";
const LEGACY_FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-blocked-accounts.json";
const ACCOUNTS_BACKUP_SUFFIX = ".bak";
const ACCOUNTS_WAL_SUFFIX = ".wal";
const ACCOUNTS_BACKUP_HISTORY_DEPTH = 3;
const BACKUP_COPY_MAX_ATTEMPTS = 5;
const BACKUP_COPY_BASE_DELAY_MS = 10;

let storageBackupEnabled = true;
let lastAccountsSaveTimestamp = 0;

export interface FlaggedAccountMetadataV1 extends AccountMetadataV3 {
	flaggedAt: number;
	flaggedReason?: string;
	lastError?: string;
}

export interface FlaggedAccountStorageV1 {
	version: 1;
	accounts: FlaggedAccountMetadataV1[];
}

/**
 * Custom error class for storage operations with platform-aware hints.
 */
export class StorageError extends Error {
	readonly code: string;
	readonly path: string;
	readonly hint: string;

	constructor(
		message: string,
		code: string,
		path: string,
		hint: string,
		cause?: Error,
	) {
		super(message, { cause });
		this.name = "StorageError";
		this.code = code;
		this.path = path;
		this.hint = hint;
	}
}

/**
 * Produce a concise, platform-aware troubleshooting hint for filesystem write errors.
 *
 * The returned hint is suitable for displaying to users or including in logs; it references
 * the provided `path` and adapts messaging for Windows vs other platforms.
 *
 * @param error - The original error object (an errno-style Node.js error). The function reads the error `code` to determine the hint.
 * @param path - The filesystem path involved; this value is interpolated into the hint. If the path may contain sensitive tokens, callers should redact it before presenting to users.
 * @returns A human-friendly hint string suggesting likely causes and next steps for the failure.
 */
export function formatStorageErrorHint(error: unknown, path: string): string {
	const err = error as NodeJS.ErrnoException;
	const code = err?.code || "UNKNOWN";
	const isWindows = process.platform === "win32";

	switch (code) {
		case "EACCES":
		case "EPERM":
			return isWindows
				? `Permission denied writing to ${path}. Check antivirus exclusions for this folder. Ensure you have write permissions.`
				: `Permission denied writing to ${path}. Check folder permissions. Try: chmod 755 ~/.codex`;
		case "EBUSY":
			return `File is locked at ${path}. The file may be open in another program. Close any editors or processes accessing it.`;
		case "ENOSPC":
			return `Disk is full. Free up space and try again. Path: ${path}`;
		case "EEMPTY":
			return `File written but is empty. This may indicate a disk or filesystem issue. Path: ${path}`;
		default:
			return isWindows
				? `Failed to write to ${path}. Check folder permissions and ensure path contains no special characters.`
				: `Failed to write to ${path}. Check folder permissions and disk space.`;
	}
}

let storageMutex: Promise<void> = Promise.resolve();
const transactionSnapshotContext = new AsyncLocalStorage<{
	snapshot: AccountStorageV3 | null;
	active: boolean;
}>();

/**
 * Acquire the global storage mutex and run the provided async function exclusively.
 *
 * The provided `fn` is invoked once any previously queued storage operation completes,
 * and the mutex is released after `fn` settles (whether it resolves or rejects).
 *
 * @param fn - An async function containing storage-related work to run under the lock.
 *             Keep synchronous, CPU-bound work inside `fn` short to avoid blocking other operations.
 * @returns The value resolved by `fn`.
 *
 * Notes:
 * - This helper only serializes access; it does not perform filesystem I/O itself. Windows-specific
 *   filesystem retry/backoff behavior and token redaction are handled by the I/O helpers that run
 *   under this lock.
 */
function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
	const previousMutex = storageMutex;
	let releaseLock: () => void;
	storageMutex = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	return previousMutex.then(fn).finally(() => releaseLock());
}

type AnyAccountStorage = AccountStorageV1 | AccountStorageV3;

type AccountLike = {
	accountId?: string;
	email?: string;
	refreshToken: string;
	addedAt?: number;
	lastUsed?: number;
};

/**
 * Detects whether an account appears to be a synthetic test fixture.
 *
 * Examines the account's email, refreshToken, and optional accountId using
 * stable patterns: emails like `account<digits>@example.com`, refresh tokens
 * beginning with `fake_refresh` or matching `fake_refresh_token_<digits>(...)`,
 * and optional accountIds like `acc-<digits>` / `acc_<digits>` / `acc<digits>`.
 *
 * Concurrency: pure, synchronous, and safe to call from concurrent contexts.
 * Filesystem: no filesystem interaction; behavior is unaffected by platform FS semantics.
 * Token handling: this function only inspects token text for pattern matching and does
 * not redact or persist values — callers should avoid logging raw tokens and redact them when needed.
 *
 * @param account - Account metadata to inspect
 * @returns `true` if the account matches known synthetic fixture patterns, `false` otherwise.
 */
function looksLikeSyntheticFixtureAccount(account: AccountMetadataV3): boolean {
	const email =
		typeof account.email === "string" ? account.email.trim().toLowerCase() : "";
	const refreshToken =
		typeof account.refreshToken === "string"
			? account.refreshToken.trim().toLowerCase()
			: "";
	const accountId =
		typeof account.accountId === "string"
			? account.accountId.trim().toLowerCase()
			: "";
	if (!/^account\d+@example\.com$/.test(email)) {
		return false;
	}
	const hasSyntheticRefreshToken =
		refreshToken.startsWith("fake_refresh") ||
		/^fake_refresh_token_\d+(_for_testing_only)?$/.test(refreshToken);
	if (!hasSyntheticRefreshToken) {
		return false;
	}
	if (accountId.length === 0) {
		return true;
	}
	return /^acc(_|-)?\d+$/.test(accountId);
}

/**
 * Determines whether the given account storage appears to consist entirely of synthetic fixture accounts.
 *
 * @param storage - The normalized account storage to inspect; `null` or an empty accounts array is treated as not synthetic.
 * @returns `true` if `storage` is non-null, contains at least one account, and every account matches the synthetic fixture pattern; `false` otherwise.
 */
function looksLikeSyntheticFixtureStorage(
	storage: AccountStorageV3 | null,
): boolean {
	if (!storage || storage.accounts.length === 0) return false;
	return storage.accounts.every((account) =>
		looksLikeSyntheticFixtureAccount(account),
	);
}

/**
 * Adds ".codex/" to the repository .gitignore if a Git repo root can be discovered near the provided storage path.
 *
 * This is a best-effort, non-fatal operation: it infers the project root from the storage path (or uses the configured project root),
 * locates the repository by checking for a ".git" folder, and appends ".codex/" to the repository's ".gitignore" if not already present.
 *
 * Concurrency and platform notes:
 * - The operation is not synchronized with other processes and may race with concurrent writers; failures are logged and suppressed.
 * - On Windows the write may fail due to file locks (EPERM/EBUSY); such errors are caught and only a warning is logged.
 *
 * Security note:
 * - The function only writes the literal ".codex/" line and does not read or write any secrets or tokens.
 *
 * @param storagePath - Path to the storage file (or config file) used to infer the project root.
 * @returns void
 */
async function ensureGitignore(storagePath: string): Promise<void> {
	if (!currentStoragePath) return;

	const configDir = dirname(storagePath);
	const inferredProjectRoot = dirname(configDir);
	const candidateRoots = [currentProjectRoot, inferredProjectRoot].filter(
		(root): root is string => typeof root === "string" && root.length > 0,
	);
	const projectRoot = candidateRoots.find((root) =>
		existsSync(join(root, ".git")),
	);
	if (!projectRoot) return;
	const gitignorePath = join(projectRoot, ".gitignore");

	try {
		let content = "";
		if (existsSync(gitignorePath)) {
			content = await fs.readFile(gitignorePath, "utf-8");
			const lines = content.split("\n").map((l) => l.trim());
			if (
				lines.includes(".codex") ||
				lines.includes(".codex/") ||
				lines.includes("/.codex") ||
				lines.includes("/.codex/")
			) {
				return;
			}
		}

		const newContent =
			content.endsWith("\n") || content === "" ? content : content + "\n";
		await fs.writeFile(gitignorePath, newContent + ".codex/\n", "utf-8");
		log.debug("Added .codex to .gitignore", { path: gitignorePath });
	} catch (error) {
		log.warn("Failed to update .gitignore", { error: String(error) });
	}
}

let currentStoragePath: string | null = null;
let currentLegacyProjectStoragePath: string | null = null;
let currentLegacyWorktreeStoragePath: string | null = null;
let currentProjectRoot: string | null = null;

export function setStorageBackupEnabled(enabled: boolean): void {
	storageBackupEnabled = enabled;
}

function getAccountsBackupPath(path: string): string {
	return `${path}${ACCOUNTS_BACKUP_SUFFIX}`;
}

function getAccountsBackupPathAtIndex(path: string, index: number): string {
	if (index <= 0) {
		return getAccountsBackupPath(path);
	}
	return `${path}${ACCOUNTS_BACKUP_SUFFIX}.${index}`;
}

/**
 * Builds the list of rotating backup candidate paths for the accounts file.
 *
 * @param path - Base storage directory or file path used to resolve backup candidates.
 * @returns An array of backup file paths ordered from index 0 up to ACCOUNTS_BACKUP_HISTORY_DEPTH - 1.
 *
 * Concurrency: pure and safe to call from multiple threads/tasks concurrently.
 * Filesystem notes: Windows path/permission semantics may affect existence or accessibility of these candidates when used for IO.
 * Security: returned paths can contain sensitive identifiers or tokens; redact them before logging or external exposure.
 */
function getAccountsBackupRecoveryCandidates(path: string): string[] {
	const candidates: string[] = [];
	for (let i = 0; i < ACCOUNTS_BACKUP_HISTORY_DEPTH; i += 1) {
		candidates.push(getAccountsBackupPathAtIndex(path, i));
	}
	return candidates;
}

/**
 * Produces an ordered list of backup file paths to consider for recovery for the given accounts file.
 *
 * Scans the directory containing `path` for files that share the base-name prefix and returns the
 * concatenation of the known backup candidates (from getAccountsBackupRecoveryCandidates) followed by
 * any additionally discovered candidates (case-insensitively sorted). Discovered candidates exclude
 * temporary files (ending with `.tmp`), rotating-artifact names containing `.rotate.`, and files
 * ending with the accounts WAL suffix.
 *
 * @param path - The full path to the primary accounts file whose backups should be discovered.
 * @returns An array of candidate backup file paths: known candidates first, then discovered candidates
 *          sorted case-insensitively.
 *
 * Notes:
 * - Concurrency: discovery is best-effort and may miss or include files created/removed concurrently.
 * - Platform: filesystem transient errors (e.g., Windows EPERM/EBUSY) while reading the directory are
 *   treated as non-fatal; ENOENT for the directory is ignored. Non-ENOENT errors are logged and do
 *   not prevent returning the assembled candidate list.
 * - Sensitive data: file contents are never read; callers should redact sensitive tokens if they log
 *   or display file paths returned by this function.
 */
async function getAccountsBackupRecoveryCandidatesWithDiscovery(
	path: string,
): Promise<string[]> {
	const knownCandidates = getAccountsBackupRecoveryCandidates(path);
	const discoveredCandidates = new Set<string>();
	const candidatePrefix = `${basename(path)}.`;
	const knownCandidateSet = new Set(knownCandidates);
	const directoryPath = dirname(path);

	try {
		const entries = await fs.readdir(directoryPath, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(candidatePrefix)) continue;
			if (entry.name.endsWith(".tmp")) continue;
			if (entry.name.includes(".rotate.")) continue;
			if (entry.name.endsWith(ACCOUNTS_WAL_SUFFIX)) continue;
			const candidatePath = join(directoryPath, entry.name);
			if (knownCandidateSet.has(candidatePath)) continue;
			discoveredCandidates.add(candidatePath);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to discover account backup candidates", {
				path,
				error: String(error),
			});
		}
	}

	const discoveredOrdered = Array.from(discoveredCandidates).sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: "base" }),
	);
	return [...knownCandidates, ...discoveredOrdered];
}

function getAccountsWalPath(path: string): string {
	return `${path}${ACCOUNTS_WAL_SUFFIX}`;
}

/**
 * Copies a file to the destination path, retrying on transient filesystem errors.
 *
 * Retries use exponential backoff for EPERM and EBUSY (common on Windows). If `allowMissingSource`
 * is true, an ENOENT (source missing) error is treated as success and the function returns.
 *
 * @param sourcePath - Path to the source file
 * @param destinationPath - Path to the destination file
 * @param options.allowMissingSource - When true, do not throw if the source file does not exist
 *
 * Concurrency: callers should avoid concurrent writes to the same destination; serialize access if necessary.
 * Security: this function does not redact or sanitize paths — do not pass sensitive tokens in file paths.
 */
async function copyFileWithRetry(
	sourcePath: string,
	destinationPath: string,
	options?: { allowMissingSource?: boolean },
): Promise<void> {
	const allowMissingSource = options?.allowMissingSource ?? false;
	for (let attempt = 0; attempt < BACKUP_COPY_MAX_ATTEMPTS; attempt += 1) {
		try {
			await fs.copyFile(sourcePath, destinationPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (allowMissingSource && code === "ENOENT") {
				return;
			}
			const canRetry =
				(code === "EPERM" || code === "EBUSY") &&
				attempt + 1 < BACKUP_COPY_MAX_ATTEMPTS;
			if (canRetry) {
				await new Promise((resolve) =>
					setTimeout(resolve, BACKUP_COPY_BASE_DELAY_MS * 2 ** attempt),
				);
				continue;
			}
			throw error;
		}
	}
}

/**
 * Atomically renames a file, retrying on transient Windows/OS-level errors with exponential backoff and jitter.
 *
 * Retries when the underlying rename fails with `EPERM`, `EBUSY`, or `EAGAIN`, applying exponential backoff between attempts; rethrows the final error if all attempts fail.
 *
 * Concurrency: callers should serialize high-level backup operations where required; this function only retries transient filesystem errors and does not provide broader transactional guarantees.
 *
 * Windows filesystem note: intended to work around common transient Windows rename failures (`EPERM`/`EBUSY`) by retrying with backoff.
 *
 * Path contents: avoid embedding sensitive tokens in `sourcePath`/`destinationPath` when those values may be logged by callers.
 *
 * @param sourcePath - Path of the existing file to rename
 * @param destinationPath - Target path for the renamed file
 * @throws The underlying filesystem error if the rename ultimately fails after retries
 * @returns void
 */
async function renameFileWithRetry(
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	for (let attempt = 0; attempt < BACKUP_COPY_MAX_ATTEMPTS; attempt += 1) {
		try {
			await fs.rename(sourcePath, destinationPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const canRetry =
				(code === "EPERM" || code === "EBUSY" || code === "EAGAIN") &&
				attempt + 1 < BACKUP_COPY_MAX_ATTEMPTS;
			if (!canRetry) {
				throw error;
			}
			const jitterMs = Math.floor(Math.random() * BACKUP_COPY_BASE_DELAY_MS);
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					BACKUP_COPY_BASE_DELAY_MS * 2 ** attempt + jitterMs,
				),
			);
		}
	}
}

/**
 * Rotates on-disk account backups by shifting existing backup slots and writing a new snapshot of the given accounts file.
 *
 * Performs an atomic-style rotation using temporary staged files and renames; cleans up staged artifacts best-effort on failure.
 * Concurrency: callers should hold the storage lock to prevent concurrent writes to the same storage directory.
 * Windows: file copy/rename operations include retry-friendly behavior for EPERM/EBUSY conditions; temporary artifacts may remain if cleanup fails.
 * Security: backup files contain account data (including tokens); treat backup paths as sensitive and apply appropriate access controls and redaction when exporting or logging.
 *
 * @param path - Filesystem path to the current accounts file to snapshot into the rotating backup set.
 * @returns void
 */
async function createRotatingAccountsBackup(path: string): Promise<void> {
	const candidates = getAccountsBackupRecoveryCandidates(path);
	const rotationNonce = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const stagedWrites: Array<{ targetPath: string; stagedPath: string }> = [];
	const buildStagedPath = (targetPath: string, label: string): string =>
		`${targetPath}.rotate.${rotationNonce}.${label}.tmp`;

	try {
		for (let i = candidates.length - 1; i > 0; i -= 1) {
			const previousPath = candidates[i - 1];
			const currentPath = candidates[i];
			if (!previousPath || !currentPath || !existsSync(previousPath)) {
				continue;
			}
			const stagedPath = buildStagedPath(currentPath, `slot-${i}`);
			await copyFileWithRetry(previousPath, stagedPath, {
				allowMissingSource: true,
			});
			if (existsSync(stagedPath)) {
				stagedWrites.push({ targetPath: currentPath, stagedPath });
			}
		}

		const latestBackupPath = candidates[0];
		if (!latestBackupPath) {
			return;
		}
		const latestStagedPath = buildStagedPath(latestBackupPath, "latest");
		await copyFileWithRetry(path, latestStagedPath);
		if (existsSync(latestStagedPath)) {
			stagedWrites.push({
				targetPath: latestBackupPath,
				stagedPath: latestStagedPath,
			});
		}

		for (const stagedWrite of stagedWrites) {
			await renameFileWithRetry(stagedWrite.stagedPath, stagedWrite.targetPath);
		}
	} finally {
		for (const stagedWrite of stagedWrites) {
			if (!existsSync(stagedWrite.stagedPath)) {
				continue;
			}
			try {
				await fs.unlink(stagedWrite.stagedPath);
			} catch {
				// Best effort cleanup for staged rotation artifacts.
			}
		}
	}
}

/**
 * Detects whether a candidate path represents a temporary rotating accounts backup
 * artifact for the given storage path.
 *
 * This performs a pure string-pattern check (no filesystem access). It matches
 * paths that start with the storage backup prefix, include a `.rotate.` segment
 * (optionally preceded by a numeric index like `.1.rotate.`) and end with `.tmp`.
 * Callers must handle concurrent filesystem races and Windows-specific locking/rename
 * semantics separately, and must redact any sensitive tokens from paths before logging.
 *
 * @param storagePath - The base storage path used to derive the backup prefix.
 * @param candidatePath - The file path to test.
 * @returns `true` if `candidatePath` matches the rotating backup temporary artifact pattern, `false` otherwise.
 */
function isRotatingBackupTempArtifact(
	storagePath: string,
	candidatePath: string,
): boolean {
	const backupPrefix = `${storagePath}${ACCOUNTS_BACKUP_SUFFIX}`;
	if (
		!candidatePath.startsWith(backupPrefix) ||
		!candidatePath.endsWith(".tmp")
	) {
		return false;
	}

	const suffix = candidatePath.slice(backupPrefix.length);
	const rotateSeparatorIndex = suffix.indexOf(".rotate.");
	if (rotateSeparatorIndex === -1) {
		return false;
	}

	const backupIndexSuffix = suffix.slice(0, rotateSeparatorIndex);
	if (backupIndexSuffix.length > 0 && !/^\.\d+$/.test(backupIndexSuffix)) {
		return false;
	}

	return true;
}

/**
 * Removes stale temporary rotating-backup artifacts located in the same directory as `path`.
 *
 * Performs a best-effort scan of the containing directory and unlinks any files that match
 * the rotating backup temp artifact pattern. Ignores missing files and directory-not-found
 * errors; logs other filesystem errors as warnings.
 *
 * Concurrency and platform notes:
 * - Safe to run concurrently with other processes performing cleanup; concurrent deletions are tolerated.
 * - On Windows, unlink may fail with transient filesystem errors (e.g., `EPERM`, `EBUSY`) which are
 *   reported as warnings rather than raised.
 *
 * Security note:
 * - This function does not sanitize or redact provided paths; callers must avoid including sensitive
 *   tokens in filenames or ensure they are redacted before passing paths here.
 *
 * @param path - Any path within the storage directory whose containing directory will be scanned for stale artifacts
 * @returns Resolves when the cleanup pass completes
 */
async function cleanupStaleRotatingBackupArtifacts(
	path: string,
): Promise<void> {
	const directoryPath = dirname(path);
	try {
		const directoryEntries = await fs.readdir(directoryPath, {
			withFileTypes: true,
		});
		const staleArtifacts = directoryEntries
			.filter((entry) => entry.isFile())
			.map((entry) => join(directoryPath, entry.name))
			.filter((entryPath) => isRotatingBackupTempArtifact(path, entryPath));

		for (const staleArtifactPath of staleArtifacts) {
			try {
				await fs.unlink(staleArtifactPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					log.warn("Failed to remove stale rotating backup artifact", {
						path: staleArtifactPath,
						error: String(error),
					});
				}
			}
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to scan for stale rotating backup artifacts", {
				path,
				error: String(error),
			});
		}
	}
}

function computeSha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

type AccountsJournalEntry = {
	version: 1;
	createdAt: number;
	path: string;
	checksum: string;
	content: string;
};

/**
 * Get the timestamp of the last successful accounts save.
 *
 * Concurrency: the value is updated while holding the storage lock; callers may read it without locking but it can be slightly stale relative to an in-progress save.
 * Windows note: this value is independent of platform-specific file-operation retries/backoffs used elsewhere.
 * Security: returns only a numeric timestamp (no sensitive tokens or secrets).
 *
 * @returns Unix epoch milliseconds of the last successful accounts save, or `0` if no successful save has occurred.
 */
export function getLastAccountsSaveTimestamp(): number {
	return lastAccountsSaveTimestamp;
}

/**
 * Configure the module's resolved account storage paths for a given project or clear them.
 *
 * Sets module-level storage path state (currentStoragePath, currentLegacyProjectStoragePath,
 * currentLegacyWorktreeStoragePath, currentProjectRoot) based on the nearest project root found for
 * `projectPath`; passing `null` clears those values.
 *
 * Concurrency: callers should ensure this is invoked under the storage lock or during initialization
 * to avoid races with concurrent save/load operations that read these globals.
 *
 * Notes: the function only computes and assigns path strings — it does not touch the filesystem.
 * Paths may affect subsequent migration/backup behaviour on Windows due to OS path semantics.
 * Do not pass paths containing sensitive tokens; any persisted/exported files should be redacted
 * by callers where required.
 *
 * @param projectPath - Project path to resolve storage for, or `null` to clear the current settings
 */
export function setStoragePath(projectPath: string | null): void {
	if (!projectPath) {
		currentStoragePath = null;
		currentLegacyProjectStoragePath = null;
		currentLegacyWorktreeStoragePath = null;
		currentProjectRoot = null;
		return;
	}

	const projectRoot = findProjectRoot(projectPath);
	if (projectRoot) {
		currentProjectRoot = projectRoot;
		const identityRoot = resolveProjectStorageIdentityRoot(projectRoot);
		currentStoragePath = join(
			getProjectGlobalConfigDir(identityRoot),
			ACCOUNTS_FILE_NAME,
		);
		currentLegacyProjectStoragePath = join(
			getProjectConfigDir(projectRoot),
			ACCOUNTS_FILE_NAME,
		);
		const previousWorktreeScopedPath = join(
			getProjectGlobalConfigDir(projectRoot),
			ACCOUNTS_FILE_NAME,
		);
		currentLegacyWorktreeStoragePath =
			previousWorktreeScopedPath !== currentStoragePath
				? previousWorktreeScopedPath
				: null;
	} else {
		currentStoragePath = null;
		currentLegacyProjectStoragePath = null;
		currentLegacyWorktreeStoragePath = null;
		currentProjectRoot = null;
	}
}

/**
 * Set the active storage file path directly and clear any legacy/derived path state.
 *
 * This replaces the current resolved storage path with `path` (or clears it when `null`)
 * and resets legacy project/worktree paths and the cached project root. Callers must hold
 * external synchronization if concurrent storage operations may be in progress.
 *
 * On Windows, callers should ensure the provided path is accessible with the required file
 * permissions; this function does not perform I/O or validate the path. Any sensitive tokens
 * that may appear in `path` should be redacted by the caller before logging.
 *
 * @param path - Absolute or null to unset the current storage path
 */
export function setStoragePathDirect(path: string | null): void {
	currentStoragePath = path;
	currentLegacyProjectStoragePath = null;
	currentLegacyWorktreeStoragePath = null;
	currentProjectRoot = null;
}

/**
 * Resolve the absolute filesystem path to the accounts JSON storage file.
 *
 * Returns the configured storage path when explicitly set; otherwise returns the
 * default accounts file location inside the user's config directory. Callers
 * should treat this path as the canonical location used by storage operations,
 * which assume external serialization via the storage lock. On Windows the
 * underlying file operations may exhibit platform-specific access semantics
 * (EPERM/EBUSY) and may require retry/backoff behavior by callers or the I/O
 * layer. Avoid emitting this path in logs or telemetry if it could reveal
 * sensitive tokens or identifiers.
 *
 * @returns The absolute path to the accounts.json file
 */
export function getStoragePath(): string {
	if (currentStoragePath) {
		return currentStoragePath;
	}
	return join(getConfigDir(), ACCOUNTS_FILE_NAME);
}

/**
 * Resolves the filesystem path for the flagged accounts file located alongside the main accounts storage.
 *
 * Callers performing reads or writes should perform those operations under the storage lock/transaction to ensure consistency; this helper does not provide atomicity or filesystem retries. Treat the resolved path as sensitive (do not log or emit contents that could include tokens or personal data). No platform-specific filesystem semantics (Windows EPERM/EBUSY) are applied by this helper.
 *
 * @returns The absolute path to the flagged accounts file in the current storage directory.
 */
export function getFlaggedAccountsPath(): string {
	return join(dirname(getStoragePath()), FLAGGED_ACCOUNTS_FILE_NAME);
}

/**
 * Get the legacy flagged accounts file path located next to the current storage file.
 *
 * The function is safe to call concurrently and does not perform IO or validate existence; callers should handle file access/permission errors. The returned path uses platform-native separators (Windows semantics apply when accessing the file) and does not embed or expose authentication tokens or secrets.
 *
 * @returns The filesystem path to the legacy flagged accounts file
 */
function getLegacyFlaggedAccountsPath(): string {
	return join(dirname(getStoragePath()), LEGACY_FLAGGED_ACCOUNTS_FILE_NAME);
}

/**
 * Detects legacy per-project account storage files, merges them into the current storage,
 * persists the merged result via `persist`, and removes migrated legacy files.
 *
 * @param persist - Function used to persist the merged AccountStorageV3 (defaults to `saveAccounts`). May be used to supply a transactional or test-friendly persister.
 * @returns The resulting normalized AccountStorageV3 if migration occurred or if a current storage snapshot exists but was not persisted here; otherwise `null`.
 *
 * Notes:
 * - Concurrency: call while holding the storage lock to avoid write races with other storage operations.
 * - Filesystem: callers should be aware Windows/AV locking can affect removal/rename semantics; failures to delete legacy files are logged and do not fail the overall migration.
 * - Logging and privacy: any account fields that contain tokens or secrets should be treated as sensitive; logs produced by this routine avoid exposing raw tokens.
 */
async function migrateLegacyProjectStorageIfNeeded(
	persist: (storage: AccountStorageV3) => Promise<void> = saveAccounts,
): Promise<AccountStorageV3 | null> {
	if (!currentStoragePath) {
		return null;
	}

	const candidatePaths = [
		currentLegacyWorktreeStoragePath,
		currentLegacyProjectStoragePath,
	]
		.filter(
			(path): path is string =>
				typeof path === "string" &&
				path.length > 0 &&
				path !== currentStoragePath,
		)
		.filter((path, index, all) => all.indexOf(path) === index);

	if (candidatePaths.length === 0) {
		return null;
	}

	const existingCandidatePaths = candidatePaths.filter((legacyPath) =>
		existsSync(legacyPath),
	);
	if (existingCandidatePaths.length === 0) {
		return null;
	}

	let targetStorage = await loadNormalizedStorageFromPath(
		currentStoragePath,
		"current account storage",
	);
	let migrated = false;

	for (const legacyPath of existingCandidatePaths) {
		const legacyStorage = await loadNormalizedStorageFromPath(
			legacyPath,
			"legacy account storage",
		);
		if (!legacyStorage) {
			continue;
		}

		const mergedStorage = mergeStorageForMigration(
			targetStorage,
			legacyStorage,
		);
		const fallbackStorage = targetStorage ?? legacyStorage;

		try {
			await persist(mergedStorage);
			targetStorage = mergedStorage;
			migrated = true;
		} catch (error) {
			targetStorage = fallbackStorage;
			log.warn("Failed to persist migrated account storage", {
				from: legacyPath,
				to: currentStoragePath,
				error: String(error),
			});
			continue;
		}

		try {
			await fs.unlink(legacyPath);
			log.info("Removed legacy account storage file after migration", {
				path: legacyPath,
			});
		} catch (unlinkError) {
			const code = (unlinkError as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				log.warn(
					"Failed to remove legacy account storage file after migration",
					{
						path: legacyPath,
						error: String(unlinkError),
					},
				);
			}
		}

		log.info("Migrated legacy project account storage", {
			from: legacyPath,
			to: currentStoragePath,
			accounts: mergedStorage.accounts.length,
		});
	}

	if (migrated) {
		return targetStorage;
	}
	if (targetStorage && !existsSync(currentStoragePath)) {
		return targetStorage;
	}
	return null;
}

/**
 * Load and normalize account storage from the given file path, returning the normalized V3 storage or `null` on missing/failed load.
 *
 * Logs up to five schema validation warnings (if any). If the file does not exist (`ENOENT`) the function returns `null` quietly; other IO/schema errors are logged and result in `null`.
 *
 * Concurrency: callers should hold the storage lock/transaction if performing concurrent storage operations.
 *
 * Windows filesystem note: filesystem errors other than `ENOENT` are logged here; callers that need resilient writes/renames on Windows should use the higher-level save helpers which implement retry/backoff.
 *
 * Logging and sensitive data: this function logs file paths and a sample of schema errors; avoid passing sensitive tokens or secrets in the `label` or path because logs may capture them.
 *
 * @param path - Filesystem path to the accounts file to load.
 * @param label - Human-readable label used in log messages to identify the source being loaded.
 * @returns The normalized `AccountStorageV3` if successfully loaded and normalized, or `null` if the file is missing or loading failed.
 */
async function loadNormalizedStorageFromPath(
	path: string,
	label: string,
): Promise<AccountStorageV3 | null> {
	try {
		const { normalized, schemaErrors } = await loadAccountsFromPath(path);
		if (schemaErrors.length > 0) {
			log.warn(`${label} schema validation warnings`, {
				path,
				errors: schemaErrors.slice(0, 5),
			});
		}
		return normalized;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn(`Failed to load ${label}`, {
				path,
				error: String(error),
			});
		}
		return null;
	}
}

/**
 * Merge an incoming AccountStorageV3 into the current storage and return a normalized, deduplicated result suitable for migration.
 *
 * @param current - The existing normalized storage or `null` if none exists; the current `activeIndex` and `activeIndexByFamily` are preserved when present.
 * @param incoming - The new storage to merge into `current`.
 * @returns The merged, normalized AccountStorageV3. If `current` is `null`, returns `incoming`. If normalization fails, returns `current`.
 *
 * Concurrency: callers must invoke this while holding the storage lock or within an active storage transaction.
 * Filesystem: this function performs no I/O and is unaffected by Windows filesystem semantics.
 * Security: account tokens/credentials are preserved by the merge; callers should redact sensitive fields before logging or external exposure.
 */
function mergeStorageForMigration(
	current: AccountStorageV3 | null,
	incoming: AccountStorageV3,
): AccountStorageV3 {
	if (!current) {
		return incoming;
	}

	const merged = normalizeAccountStorage({
		version: 3,
		activeIndex: current.activeIndex,
		activeIndexByFamily: current.activeIndexByFamily,
		accounts: [...current.accounts, ...incoming.accounts],
	});
	if (!merged) {
		return current;
	}
	return merged;
}

/**
 * Choose the more recent account entry between two account-like objects.
 *
 * @param current - The existing account entry, or `undefined` if none is present
 * @param candidate - The candidate account entry to compare against `current`
 * @returns The account with the more recent `lastUsed` timestamp; if those are equal, the one with the more recent `addedAt` timestamp. If `current` is `undefined`, returns `candidate`.
 */
function selectNewestAccount<T extends AccountLike>(
	current: T | undefined,
	candidate: T,
): T {
	if (!current) return candidate;
	const currentLastUsed = current.lastUsed || 0;
	const candidateLastUsed = candidate.lastUsed || 0;
	if (candidateLastUsed > currentLastUsed) return candidate;
	if (candidateLastUsed < currentLastUsed) return current;
	const currentAddedAt = current.addedAt || 0;
	const candidateAddedAt = candidate.addedAt || 0;
	return candidateAddedAt >= currentAddedAt ? candidate : current;
}

/**
 * Remove duplicate accounts that share the same `accountId` or `refreshToken`, keeping the newest entry for each key.
 *
 * @param accounts - Array of account-like objects to deduplicate. Entries lacking both `accountId` and `refreshToken` are ignored.
 * @returns An array containing one (the newest) entry per unique `accountId`/`refreshToken`, in the original iteration order of the selected entries.
 */
function deduplicateAccountsByKey<T extends AccountLike>(accounts: T[]): T[] {
	const keyToIndex = new Map<string, number>();
	const indicesToKeep = new Set<number>();

	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account) continue;
		const key = account.accountId || account.refreshToken;
		if (!key) continue;

		const existingIndex = keyToIndex.get(key);
		if (existingIndex === undefined) {
			keyToIndex.set(key, i);
			continue;
		}

		const existing = accounts[existingIndex];
		const newest = selectNewestAccount(existing, account);
		keyToIndex.set(key, newest === account ? i : existingIndex);
	}

	for (const idx of keyToIndex.values()) {
		indicesToKeep.add(idx);
	}

	const result: T[] = [];
	for (let i = 0; i < accounts.length; i += 1) {
		if (indicesToKeep.has(i)) {
			const account = accounts[i];
			if (account) result.push(account);
		}
	}
	return result;
}

/**
 * Deduplicates account entries by key (accountId if present, otherwise refreshToken), keeping the most recently used entry for each key.
 *
 * This is a pure, in-memory operation with no filesystem side effects or concurrency requirements; it does not perform any token redaction or platform-specific behavior.
 *
 * @param accounts - Array of account-like objects; each should include a `refreshToken` and may include `accountId`, `lastUsed`, and `addedAt` to determine recency
 * @returns An array containing one representative (most recently used) entry per unique account key
 */
export function deduplicateAccounts<
	T extends {
		accountId?: string;
		refreshToken: string;
		lastUsed?: number;
		addedAt?: number;
	},
>(accounts: T[]): T[] {
	return deduplicateAccountsByKey(accounts);
}

/**
 * Normalize an email for stable comparison by trimming whitespace and converting to lowercase.
 *
 * @param email - The raw email value, or `undefined`.
 * @returns The trimmed, lowercased email, or `undefined` if the input is missing or empty after trimming.
 */
export function normalizeEmailKey(
	email: string | undefined,
): string | undefined {
	if (!email) return undefined;
	const trimmed = email.trim();
	if (!trimmed) return undefined;
	return trimmed.toLowerCase();
}

/**
 * Remove duplicate accounts that share the same email, keeping the most recently used entry for each email.
 *
 * Deduplication compares emails case-insensitively and with surrounding whitespace removed. For accounts with the same normalized email, the entry with the greater `lastUsed` is kept; if `lastUsed` values are equal, the entry with the greater `addedAt` is kept. Accounts without an email are always preserved. The original ordering of the retained accounts is preserved.
 *
 * Concurrency: pure function with no side effects; safe to call concurrently.
 * Platform notes: this does not perform any filesystem operations and has no Windows-specific behavior.
 * Redaction: this function does not modify or redact account tokens or other fields.
 *
 * @param accounts - Array of account-like objects to deduplicate. Objects may omit `email`, `lastUsed`, or `addedAt`.
 * @returns A new array containing one entry per normalized email (the newest) plus all accounts that had no email.
 */
export function deduplicateAccountsByEmail<
	T extends { email?: string; lastUsed?: number; addedAt?: number },
>(accounts: T[]): T[] {
	const emailToNewestIndex = new Map<string, number>();
	const indicesToKeep = new Set<number>();

	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account) continue;

		const email = normalizeEmailKey(account.email);
		if (!email) {
			indicesToKeep.add(i);
			continue;
		}

		const existingIndex = emailToNewestIndex.get(email);
		if (existingIndex === undefined) {
			emailToNewestIndex.set(email, i);
			continue;
		}

		const existing = accounts[existingIndex];
		// istanbul ignore next -- defensive code: existingIndex always refers to valid account
		if (!existing) {
			emailToNewestIndex.set(email, i);
			continue;
		}

		const existingLastUsed = existing.lastUsed || 0;
		const candidateLastUsed = account.lastUsed || 0;
		const existingAddedAt = existing.addedAt || 0;
		const candidateAddedAt = account.addedAt || 0;

		const isNewer =
			candidateLastUsed > existingLastUsed ||
			(candidateLastUsed === existingLastUsed &&
				candidateAddedAt > existingAddedAt);

		if (isNewer) {
			emailToNewestIndex.set(email, i);
		}
	}

	for (const idx of emailToNewestIndex.values()) {
		indicesToKeep.add(idx);
	}

	const result: T[] = [];
	for (let i = 0; i < accounts.length; i += 1) {
		if (indicesToKeep.has(i)) {
			const account = accounts[i];
			if (account) result.push(account);
		}
	}
	return result;
}

/**
 * Determines whether a value is a plain object (non-null and not an array).
 *
 * @param value - The value to test.
 * @returns `true` if `value` is an object, not `null`, and not an array; `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clamp an index to a valid position within a collection of the given length.
 *
 * @param index - The desired index which may be negative or exceed bounds
 * @param length - The number of items in the collection
 * @returns The adjusted index: `0` when `length` is less than or equal to `0`, otherwise a value between `0` and `length - 1` inclusive
 */
function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

/**
 * Derives a stable key for an account using `accountId` when available, falling back to `refreshToken`.
 *
 * @param account - Account metadata containing `accountId` and `refreshToken`; the returned value may be a refresh token and should be treated as sensitive (redact in logs).
 * @returns The `accountId` if present, otherwise the `refreshToken`.
 */
function toAccountKey(
	account: Pick<AccountMetadataV3, "accountId" | "refreshToken">,
): string {
	return account.accountId || account.refreshToken;
}

/**
 * Derives the active account key (preferring `accountId`, falling back to `refreshToken`) for the entry at `activeIndex`.
 *
 * This is a pure lookup: it returns `accountId` if present and non-empty, otherwise a non-empty `refreshToken`, or `undefined` if neither is available or the entry is not an object. The returned refresh token may be sensitive and must be redacted before logging or persisting. There are no concurrency side effects; callers should serialize concurrent mutations at a higher level. (No platform/filesystem semantics apply.)
 *
 * @param accounts - Array containing account-like objects; entries may be arbitrary values.
 * @param activeIndex - Index of the active entry to inspect; out-of-range indices yield `undefined`.
 * @returns The selected key string (`accountId` or `refreshToken`) or `undefined` when none is available.
 */
function extractActiveKey(
	accounts: unknown[],
	activeIndex: number,
): string | undefined {
	const candidate = accounts[activeIndex];
	if (!isRecord(candidate)) return undefined;

	const accountId =
		typeof candidate.accountId === "string" && candidate.accountId.trim()
			? candidate.accountId
			: undefined;
	const refreshToken =
		typeof candidate.refreshToken === "string" && candidate.refreshToken.trim()
			? candidate.refreshToken
			: undefined;

	return accountId || refreshToken;
}

/**
 * Normalize and validate raw account storage, migrating v1 to v3, deduplicating accounts, and computing active indices.
 *
 * Normalizes incoming storage shapes to AccountStorageV3: migrates v1 payloads, filters out invalid accounts, deduplicates by key and email (preserving most-recently-used order), clamps and remaps the global active index and per-model-family active indices. This function performs no I/O and is safe to call concurrently. It preserves account refresh tokens and does not perform any redaction; callers must treat returned storage as sensitive. Because it operates purely on in-memory data, it is not affected by platform filesystem semantics (Windows or otherwise).
 *
 * @param data - Raw parsed storage payload (unknown shape)
 * @returns Normalized AccountStorageV3, or `null` when the input is invalid or cannot be normalized
 */
export function normalizeAccountStorage(
	data: unknown,
): AccountStorageV3 | null {
	if (!isRecord(data)) {
		log.warn("Invalid storage format, ignoring");
		return null;
	}

	if (data.version !== 1 && data.version !== 3) {
		log.warn("Unknown storage version, ignoring", {
			version: (data as { version?: unknown }).version,
		});
		return null;
	}

	const rawAccounts = data.accounts;
	if (!Array.isArray(rawAccounts)) {
		log.warn("Invalid storage format, ignoring");
		return null;
	}

	const activeIndexValue =
		typeof data.activeIndex === "number" && Number.isFinite(data.activeIndex)
			? data.activeIndex
			: 0;

	const rawActiveIndex = clampIndex(activeIndexValue, rawAccounts.length);
	const activeKey = extractActiveKey(rawAccounts, rawActiveIndex);

	const fromVersion = data.version as AnyAccountStorage["version"];
	const baseStorage: AccountStorageV3 =
		fromVersion === 1
			? migrateV1ToV3(data as unknown as AccountStorageV1)
			: (data as unknown as AccountStorageV3);

	const validAccounts = rawAccounts.filter(
		(account): account is AccountMetadataV3 =>
			isRecord(account) &&
			typeof account.refreshToken === "string" &&
			!!account.refreshToken.trim(),
	);

	const deduplicatedAccounts = deduplicateAccountsByEmail(
		deduplicateAccountsByKey(validAccounts),
	);

	const activeIndex = (() => {
		if (deduplicatedAccounts.length === 0) return 0;

		if (activeKey) {
			const mappedIndex = deduplicatedAccounts.findIndex(
				(account) => toAccountKey(account) === activeKey,
			);
			if (mappedIndex >= 0) return mappedIndex;
		}

		return clampIndex(rawActiveIndex, deduplicatedAccounts.length);
	})();

	const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
	const rawFamilyIndices = isRecord(baseStorage.activeIndexByFamily)
		? (baseStorage.activeIndexByFamily as Record<string, unknown>)
		: {};

	for (const family of MODEL_FAMILIES) {
		const rawIndexValue = rawFamilyIndices[family];
		const rawIndex =
			typeof rawIndexValue === "number" && Number.isFinite(rawIndexValue)
				? rawIndexValue
				: rawActiveIndex;

		const clampedRawIndex = clampIndex(rawIndex, rawAccounts.length);
		const familyKey = extractActiveKey(rawAccounts, clampedRawIndex);

		let mappedIndex = clampIndex(rawIndex, deduplicatedAccounts.length);
		if (familyKey && deduplicatedAccounts.length > 0) {
			const idx = deduplicatedAccounts.findIndex(
				(account) => toAccountKey(account) === familyKey,
			);
			if (idx >= 0) {
				mappedIndex = idx;
			}
		}

		activeIndexByFamily[family] = mappedIndex;
	}

	return {
		version: 3,
		accounts: deduplicatedAccounts,
		activeIndex,
		activeIndexByFamily,
	};
}

/**
 * Load and normalize stored OAuth account data from the configured storage location, performing legacy v1→v3 migration when necessary.
 *
 * Note: this operation participates in the module's serialized storage workflow—concurrent callers are serialized to avoid races.
 * On Windows, underlying file operations may apply platform-friendly retries for transient file-lock errors (e.g. EPERM/EBUSY).
 * Returned data contains secrets (refresh tokens); callers should apply the project's token redaction policies when logging or persisting excerpts.
 *
 * @returns The normalized AccountStorageV3 if storage exists and is valid, or `null` when no storage is present or the data cannot be recovered.
 */
export async function loadAccounts(): Promise<AccountStorageV3 | null> {
	return loadAccountsInternal(saveAccounts);
}

/**
 * Validates raw storage data against the expected account storage schema and returns a normalized V3 representation plus metadata.
 *
 * @param data - Raw input (typically parsed JSON or an object) to validate and normalize; the input is not mutated.
 * @returns An object with:
 *   - `normalized`: the normalized AccountStorageV3 or `null` if normalization/validation failed,
 *   - `storedVersion`: the raw `version` value found in the input (or `undefined` if none),
 *   - `schemaErrors`: an array of schema validation error messages.
 *
 * Concurrency: none (pure, synchronous). No filesystem or Windows-specific behavior applies. This function does not redact tokens or secrets; callers must handle any sensitive-data redaction before logging or exposing returned values.
 */
function parseAndNormalizeStorage(data: unknown): {
	normalized: AccountStorageV3 | null;
	storedVersion: unknown;
	schemaErrors: string[];
} {
	const schemaErrors = getValidationErrors(AnyAccountStorageSchema, data);
	const normalized = normalizeAccountStorage(data);
	const storedVersion = isRecord(data)
		? (data as { version?: unknown }).version
		: undefined;
	return { normalized, storedVersion, schemaErrors };
}

/**
 * Load, parse, and normalize account storage from a filesystem path.
 *
 * @param path - Filesystem path to the accounts JSON file
 * @returns An object with:
 *   - `normalized`: the normalized AccountStorageV3 or `null` if storage is invalid or empty
 *   - `storedVersion`: the raw stored schema version extracted from the file
 *   - `schemaErrors`: validation and normalization warnings/errors encountered during parsing
 * @remarks
 * - Callers should serialize concurrent access to storage (this function does not perform cross-process locking).
 * - On Windows, file access may fail with transient errors (e.g. `EPERM`, `EBUSY`); callers may retry if appropriate.
 * - The file content may contain sensitive tokens; do not log raw file contents without redaction.
 * @throws If the file cannot be read (e.g. `ENOENT`, permission errors) or if the file contains invalid JSON.
 */
async function loadAccountsFromPath(path: string): Promise<{
	normalized: AccountStorageV3 | null;
	storedVersion: unknown;
	schemaErrors: string[];
}> {
	const content = await fs.readFile(path, "utf-8");
	const data = JSON.parse(content) as unknown;
	return parseAndNormalizeStorage(data);
}

/**
 * Attempts to recover and return a normalized account storage snapshot from the write-ahead log (WAL) for the given storage file path.
 *
 * This is a best-effort, read-only recovery routine: it derives the WAL path from `path`, validates journal version and checksum, parses the contained JSON, and returns a normalized AccountStorageV3 when the entry is valid. It handles missing or invalid WALs gracefully and does not acquire the global storage lock; callers should coordinate concurrency and persist any recovered snapshot explicitly.
 *
 * Notes:
 * - Missing WAL or validation failures return `null` rather than throwing.
 * - The function logs warnings for checksum/schema failures but never logs raw account tokens or snapshot content (paths only) to avoid leaking sensitive tokens.
 * - No special retry logic for Windows filesystem sharing errors is performed here; such errors are logged at warning level by callers and treated as recovery failures.
 *
 * @param path - The primary accounts file path (used to derive the WAL/JOURNAL path)
 * @returns The recovered and normalized AccountStorageV3 if a valid WAL entry is found and passes checksum and schema validation, `null` otherwise.
 */
async function loadAccountsFromJournal(
	path: string,
): Promise<AccountStorageV3 | null> {
	const walPath = getAccountsWalPath(path);
	try {
		const raw = await fs.readFile(walPath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return null;
		const entry = parsed as Partial<AccountsJournalEntry>;
		if (entry.version !== 1) return null;
		if (typeof entry.content !== "string" || typeof entry.checksum !== "string")
			return null;
		const computed = computeSha256(entry.content);
		if (computed !== entry.checksum) {
			log.warn("Account journal checksum mismatch", { path: walPath });
			return null;
		}
		const data = JSON.parse(entry.content) as unknown;
		const { normalized } = parseAndNormalizeStorage(data);
		if (!normalized) return null;
		log.warn("Recovered account storage from WAL journal", { path, walPath });
		return normalized;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to load account WAL journal", {
				path: walPath,
				error: String(error),
			});
		}
		return null;
	}
}

/**
 * Load and normalize account storage, performing legacy migration, WAL recovery,
 * and backup-based recovery or promotion of non-synthetic backups when needed.
 *
 * Concurrency: callers must invoke this under the storage lock; the function
 * performs filesystem cleanup (rotating backup artifacts) and is not safe for
 * concurrent load/save operations outside that lock.
 *
 * Filesystem notes: the loader will attempt WAL- and backup-based recovery for
 * partial or corrupted writes; on Windows transient filesystem errors may cause
 * additional retry/backup-promote paths to be used.
 *
 * Logging and privacy: diagnostic logs emitted by this routine avoid exposing
 * sensitive tokens/credentials (refresh tokens and similar values are redacted).
 *
 * @param persistMigration - Optional callback invoked with a normalized
 *   AccountStorageV3 when a migration, WAL recovery, or backup-promotion
 *   completes; use this to persist the promoted/migrated state. The callback
 *   may be async.
 * @returns The normalized AccountStorageV3 if loading, migration, or recovery
 *   succeeded; `null` if no valid storage could be loaded or recovered.
 */
async function loadAccountsInternal(
	persistMigration: ((storage: AccountStorageV3) => Promise<void>) | null,
): Promise<AccountStorageV3 | null> {
	const path = getStoragePath();
	await cleanupStaleRotatingBackupArtifacts(path);
	const migratedLegacyStorage = persistMigration
		? await migrateLegacyProjectStorageIfNeeded(persistMigration)
		: null;

	try {
		const { normalized, storedVersion, schemaErrors } =
			await loadAccountsFromPath(path);
		if (schemaErrors.length > 0) {
			log.warn("Account storage schema validation warnings", {
				errors: schemaErrors.slice(0, 5),
			});
		}
		if (normalized && storedVersion !== normalized.version) {
			log.info("Migrating account storage to v3", {
				from: storedVersion,
				to: normalized.version,
			});
			if (persistMigration) {
				try {
					await persistMigration(normalized);
				} catch (saveError) {
					log.warn("Failed to persist migrated storage", {
						error: String(saveError),
					});
				}
			}
		}

		const primaryLooksSynthetic = looksLikeSyntheticFixtureStorage(normalized);
		if (storageBackupEnabled && normalized && primaryLooksSynthetic) {
			const backupCandidates =
				await getAccountsBackupRecoveryCandidatesWithDiscovery(path);
			for (const backupPath of backupCandidates) {
				if (backupPath === path) continue;
				try {
					const backup = await loadAccountsFromPath(backupPath);
					if (!backup.normalized) continue;
					if (looksLikeSyntheticFixtureStorage(backup.normalized)) continue;
					if (backup.normalized.accounts.length <= 0) continue;
					log.warn(
						"Detected synthetic primary account storage; promoting backup",
						{
							path,
							backupPath,
							primaryAccounts: normalized.accounts.length,
							backupAccounts: backup.normalized.accounts.length,
						},
					);
					if (persistMigration) {
						try {
							await persistMigration(backup.normalized);
						} catch (persistError) {
							log.warn("Failed to persist promoted backup storage", {
								path,
								error: String(persistError),
							});
						}
					}
					return backup.normalized;
				} catch (backupError) {
					const backupCode = (backupError as NodeJS.ErrnoException).code;
					if (backupCode !== "ENOENT") {
						log.warn(
							"Failed to load candidate backup for synthetic-primary promotion",
							{
								path: backupPath,
								error: String(backupError),
							},
						);
					}
				}
			}
		}

		return normalized;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" && migratedLegacyStorage) {
			return migratedLegacyStorage;
		}

		const recoveredFromWal = await loadAccountsFromJournal(path);
		if (recoveredFromWal) {
			if (persistMigration) {
				try {
					await persistMigration(recoveredFromWal);
				} catch (persistError) {
					log.warn("Failed to persist WAL-recovered storage", {
						path,
						error: String(persistError),
					});
				}
			}
			return recoveredFromWal;
		}

		if (storageBackupEnabled) {
			const backupCandidates =
				await getAccountsBackupRecoveryCandidatesWithDiscovery(path);
			for (const backupPath of backupCandidates) {
				try {
					const backup = await loadAccountsFromPath(backupPath);
					if (backup.schemaErrors.length > 0) {
						log.warn("Backup account storage schema validation warnings", {
							path: backupPath,
							errors: backup.schemaErrors.slice(0, 5),
						});
					}
					if (backup.normalized) {
						log.warn("Recovered account storage from backup file", {
							path,
							backupPath,
						});
						if (persistMigration) {
							try {
								await persistMigration(backup.normalized);
							} catch (persistError) {
								log.warn("Failed to persist recovered backup storage", {
									path,
									error: String(persistError),
								});
							}
						}
						return backup.normalized;
					}
				} catch (backupError) {
					const backupCode = (backupError as NodeJS.ErrnoException).code;
					if (backupCode !== "ENOENT") {
						log.warn("Failed to load backup account storage", {
							path: backupPath,
							error: String(backupError),
						});
					}
				}
			}
		}

		if (code !== "ENOENT") {
			log.error("Failed to load account storage", { error: String(error) });
		}
		return null;
	}
}

/**
 * Atomically persists normalized AccountStorageV3 to the configured storage path.
 *
 * Performs an atomic replace of the accounts file and records a write-ahead journal entry to enable recovery
 * if a subsequent rename fails. Caller must serialize access (acquire the storage lock / transaction context)
 * before invoking this unlocked save variant. This function does not perform token redaction; callers are
 * responsible for ensuring sensitive fields are handled appropriately before calling.
 *
 * Concurrency: callers must ensure only one saver runs at a time (saveAccounts wraps this with a lock).
 * Windows behavior: the final atomic rename is retried with exponential backoff to mitigate EPERM/EBUSY.
 *
 * @param storage - A normalized AccountStorageV3 object to persist (must already conform to v3 schema)
 * @returns void
 * @throws StorageError - on I/O or validation failures; error includes a platform-aware hint and the failing path
 */
async function saveAccountsUnlocked(storage: AccountStorageV3): Promise<void> {
	const path = getStoragePath();
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${path}.${uniqueSuffix}.tmp`;
	const walPath = getAccountsWalPath(path);

	try {
		await fs.mkdir(dirname(path), { recursive: true });
		await ensureGitignore(path);

		if (looksLikeSyntheticFixtureStorage(storage)) {
			try {
				const existing = await loadNormalizedStorageFromPath(
					path,
					"existing account storage",
				);
				if (
					existing &&
					existing.accounts.length > 0 &&
					!looksLikeSyntheticFixtureStorage(existing)
				) {
					throw new StorageError(
						"Refusing to overwrite non-synthetic account storage with synthetic fixture payload",
						"EINVALID",
						path,
						"Detected synthetic fixture-like account payload. Use explicit account import/login commands instead.",
					);
				}
			} catch (error) {
				if (error instanceof StorageError) {
					throw error;
				}
				// Ignore existing-file probe failures and continue with normal save flow.
			}
		}

		if (storageBackupEnabled && existsSync(path)) {
			try {
				await createRotatingAccountsBackup(path);
			} catch (backupError) {
				log.warn("Failed to create account storage backup", {
					path,
					backupPath: getAccountsBackupPath(path),
					error: String(backupError),
				});
			}
		}

		const content = JSON.stringify(storage, null, 2);
		const journalEntry: AccountsJournalEntry = {
			version: 1,
			createdAt: Date.now(),
			path,
			checksum: computeSha256(content),
			content,
		};
		await fs.writeFile(walPath, JSON.stringify(journalEntry), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });

		const stats = await fs.stat(tempPath);
		if (stats.size === 0) {
			const emptyError = Object.assign(
				new Error("File written but size is 0"),
				{ code: "EEMPTY" },
			);
			throw emptyError;
		}

		// Retry rename with exponential backoff for Windows EPERM/EBUSY
		let lastError: NodeJS.ErrnoException | null = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await fs.rename(tempPath, path);
				lastAccountsSaveTimestamp = Date.now();
				try {
					await fs.unlink(walPath);
				} catch {
					// Best effort cleanup.
				}
				return;
			} catch (renameError) {
				const code = (renameError as NodeJS.ErrnoException).code;
				if (code === "EPERM" || code === "EBUSY") {
					lastError = renameError as NodeJS.ErrnoException;
					await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
					continue;
				}
				throw renameError;
			}
		}
		if (lastError) throw lastError;
	} catch (error) {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Ignore cleanup failure.
		}

		const err = error as NodeJS.ErrnoException;
		const code = err?.code || "UNKNOWN";
		const hint = formatStorageErrorHint(error, path);

		log.error("Failed to save accounts", {
			path,
			code,
			message: err?.message,
			hint,
		});

		throw new StorageError(
			`Failed to save accounts: ${err?.message || "Unknown error"}`,
			code,
			path,
			hint,
			err instanceof Error ? err : undefined,
		);
	}
}

/**
 * Execute a handler with exclusive access to account storage, providing the current snapshot
 * and a callback to persist an updated snapshot.
 *
 * The handler is invoked while holding the module's storage lock and within a transaction
 * snapshot context. The `current` argument is the most recently loaded normalized storage
 * (or `null` if none exists). The `persist` callback atomically writes a new storage
 * snapshot and updates the in-memory transaction snapshot; it follows the module's normal
 * persistence rules (including Windows-friendly retry/backoff and atomic rename behavior)
 * and applies any configured token redaction/serialization policies.
 *
 * Concurrency assumptions: the handler runs with serialized access to storage; callers may
 * call `persist` multiple times within the handler to commit intermediate snapshots. The
 * transaction context is marked inactive after the handler completes (or throws).
 *
 * @param handler - Function receiving the current storage snapshot and a `persist` function.
 * @returns The value returned by the provided handler.
 */
export async function withAccountStorageTransaction<T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (storage: AccountStorageV3) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return withStorageLock(async () => {
		const current = await loadAccountsInternal(saveAccountsUnlocked);
		const context = { snapshot: current, active: true };
		const persist = async (storage: AccountStorageV3): Promise<void> => {
			await saveAccountsUnlocked(storage);
			context.snapshot = storage;
		};
		return transactionSnapshotContext.run(context, async () => {
			try {
				return await handler(current, persist);
			} finally {
				context.active = false;
			}
		});
	});
}

/**
 * Save account storage atomically to the configured storage path.
 *
 * This operation runs under the global storage lock to serialize concurrent saves,
 * creates the storage directory if missing, and writes via a temp file + atomic rename.
 * On Windows, rename and copy operations may be retried to work around EPERM/EBUSY/EAGAIN conditions.
 * Error messages and hints redact sensitive tokens (e.g., refresh tokens) before being exposed.
 *
 * @param storage - The AccountStorageV3 payload to persist
 * @throws StorageError when filesystem operations fail; the error includes a platform-aware hint and a redacted path/context where applicable
 */
export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
	return withStorageLock(async () => {
		await saveAccountsUnlocked(storage);
	});
}

/**
 * Remove the main accounts file, its write-ahead log, and any rotating backup artifacts from disk.
 *
 * This is a best-effort, per-artifact cleanup: missing files are ignored and other failures are logged but do not cause a thrown error. The operation runs while holding the global storage lock to serialize against other storage operations. On Windows, unlink failures caused by file locking may be logged rather than retried; transient platform-specific errors are not escalated here. Logged paths and metadata follow the project's logging and token-redaction policy to avoid exposing sensitive tokens.
 *
 * @returns Nothing.
 */
export async function clearAccounts(): Promise<void> {
	return withStorageLock(async () => {
		const path = getStoragePath();
		const walPath = getAccountsWalPath(path);
		const backupPaths = getAccountsBackupRecoveryCandidates(path);
		const clearPath = async (targetPath: string): Promise<void> => {
			try {
				await fs.unlink(targetPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					log.error("Failed to clear account storage artifact", {
						path: targetPath,
						error: String(error),
					});
				}
			}
		};

		try {
			await Promise.all([
				clearPath(path),
				clearPath(walPath),
				...backupPaths.map(clearPath),
			]);
		} catch {
			// Individual path cleanup is already best-effort with per-artifact logging.
		}
	});
}

/**
 * Normalize arbitrary input into a FlaggedAccountStorageV1 structure.
 *
 * Produces a version 1 flagged-account payload with entries validated, normalized, and deduplicated by refresh token.
 * Concurrency: pure and side-effect free (no filesystem or async operations).
 * Platform note: behavior does not depend on platform-specific filesystem semantics (safe on Windows).
 * Token handling: refresh tokens are used as deduplication keys and retained unchanged (no redaction).
 *
 * @param data - The raw input to normalize (may be any shape, including legacy formats)
 * @returns A FlaggedAccountStorageV1 object with a normalized `accounts` array; returns an empty `accounts` array when input is invalid or contains no valid entries.
 */
function normalizeFlaggedStorage(data: unknown): FlaggedAccountStorageV1 {
	if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.accounts)) {
		return { version: 1, accounts: [] };
	}

	const byRefreshToken = new Map<string, FlaggedAccountMetadataV1>();
	for (const rawAccount of data.accounts) {
		if (!isRecord(rawAccount)) continue;
		const refreshToken =
			typeof rawAccount.refreshToken === "string"
				? rawAccount.refreshToken.trim()
				: "";
		if (!refreshToken) continue;

		const flaggedAt =
			typeof rawAccount.flaggedAt === "number"
				? rawAccount.flaggedAt
				: Date.now();
		const isAccountIdSource = (
			value: unknown,
		): value is AccountMetadataV3["accountIdSource"] =>
			value === "token" ||
			value === "id_token" ||
			value === "org" ||
			value === "manual";
		const isSwitchReason = (
			value: unknown,
		): value is AccountMetadataV3["lastSwitchReason"] =>
			value === "rate-limit" || value === "initial" || value === "rotation";
		const isCooldownReason = (
			value: unknown,
		): value is AccountMetadataV3["cooldownReason"] =>
			value === "auth-failure" ||
			value === "network-error" ||
			value === "rate-limit";

		let rateLimitResetTimes:
			| AccountMetadataV3["rateLimitResetTimes"]
			| undefined;
		if (isRecord(rawAccount.rateLimitResetTimes)) {
			const normalizedRateLimits: Record<string, number | undefined> = {};
			for (const [key, value] of Object.entries(
				rawAccount.rateLimitResetTimes,
			)) {
				if (typeof value === "number") {
					normalizedRateLimits[key] = value;
				}
			}
			if (Object.keys(normalizedRateLimits).length > 0) {
				rateLimitResetTimes = normalizedRateLimits;
			}
		}

		const accountIdSource = isAccountIdSource(rawAccount.accountIdSource)
			? rawAccount.accountIdSource
			: undefined;
		const lastSwitchReason = isSwitchReason(rawAccount.lastSwitchReason)
			? rawAccount.lastSwitchReason
			: undefined;
		const cooldownReason = isCooldownReason(rawAccount.cooldownReason)
			? rawAccount.cooldownReason
			: undefined;

		const normalized: FlaggedAccountMetadataV1 = {
			refreshToken,
			addedAt:
				typeof rawAccount.addedAt === "number" ? rawAccount.addedAt : flaggedAt,
			lastUsed:
				typeof rawAccount.lastUsed === "number"
					? rawAccount.lastUsed
					: flaggedAt,
			accountId:
				typeof rawAccount.accountId === "string"
					? rawAccount.accountId
					: undefined,
			accountIdSource,
			accountLabel:
				typeof rawAccount.accountLabel === "string"
					? rawAccount.accountLabel
					: undefined,
			email:
				typeof rawAccount.email === "string" ? rawAccount.email : undefined,
			enabled:
				typeof rawAccount.enabled === "boolean"
					? rawAccount.enabled
					: undefined,
			lastSwitchReason,
			rateLimitResetTimes,
			coolingDownUntil:
				typeof rawAccount.coolingDownUntil === "number"
					? rawAccount.coolingDownUntil
					: undefined,
			cooldownReason,
			flaggedAt,
			flaggedReason:
				typeof rawAccount.flaggedReason === "string"
					? rawAccount.flaggedReason
					: undefined,
			lastError:
				typeof rawAccount.lastError === "string"
					? rawAccount.lastError
					: undefined,
		};
		byRefreshToken.set(refreshToken, normalized);
	}

	return {
		version: 1,
		accounts: Array.from(byRefreshToken.values()),
	};
}

/**
 * Loads flagged account storage, migrating a legacy file if present and returning a normalized v1 structure.
 *
 * Attempts to read the current flagged accounts file and normalize its contents. If the file does not exist,
 * checks for a legacy flagged accounts file, migrates and saves it to the current path (best-effort cleanup of the legacy file),
 * and returns the migrated storage. On non-ENOENT read errors or migration failures this function logs the error and
 * returns an empty storage object ({ version: 1, accounts: [] }).
 *
 * Concurrency: callers should assume no external synchronization; the function performs file reads/writes without acquiring
 * the module's broader storage lock. Windows-specific filesystem behaviors (e.g., transient EPERM/EBUSY) are handled elsewhere;
 * this routine treats read/write failures as non-fatal and falls back to an empty result when appropriate.
 *
 * Security: logs may include error messages and paths; do not pass unredacted secrets or tokens in files expected to be logged.
 *
 * @returns The normalized FlaggedAccountStorageV1 loaded or migrated from disk, or an empty v1 storage when no data is available or on error.
 */
export async function loadFlaggedAccounts(): Promise<FlaggedAccountStorageV1> {
	const path = getFlaggedAccountsPath();
	const empty: FlaggedAccountStorageV1 = { version: 1, accounts: [] };

	try {
		const content = await fs.readFile(path, "utf-8");
		const data = JSON.parse(content) as unknown;
		return normalizeFlaggedStorage(data);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.error("Failed to load flagged account storage", {
				path,
				error: String(error),
			});
			return empty;
		}
	}

	const legacyPath = getLegacyFlaggedAccountsPath();
	if (!existsSync(legacyPath)) {
		return empty;
	}

	try {
		const legacyContent = await fs.readFile(legacyPath, "utf-8");
		const legacyData = JSON.parse(legacyContent) as unknown;
		const migrated = normalizeFlaggedStorage(legacyData);
		if (migrated.accounts.length > 0) {
			await saveFlaggedAccounts(migrated);
		}
		try {
			await fs.unlink(legacyPath);
		} catch {
			// Best effort cleanup.
		}
		log.info("Migrated legacy flagged account storage", {
			from: legacyPath,
			to: path,
			accounts: migrated.accounts.length,
		});
		return migrated;
	} catch (error) {
		log.error("Failed to migrate legacy flagged account storage", {
			from: legacyPath,
			to: path,
			error: String(error),
		});
		return empty;
	}
}

/**
 * Persist flagged account storage atomically to the configured flagged-accounts file.
 *
 * The function normalizes the provided storage, writes it to a temporary file inside the storage
 * directory with restrictive file mode, then atomically renames the temp file into place. It runs
 * under the module's storage lock to serialize concurrent storage operations and attempts best-effort
 * cleanup of the temporary file on failure.
 *
 * Note: on Windows platforms atomic rename operations can fail with transient EPERM/EBUSY; the
 * caller should expect the operation to be retried or surface an error. The function writes the
 * storage content exactly as produced by normalization — any sensitive values (e.g. refresh tokens)
 * are persisted as provided and should be redacted by the caller if necessary.
 *
 * @param storage - Flagged account storage to persist; will be normalized before writing.
 * @returns Void.
 */
export async function saveFlaggedAccounts(
	storage: FlaggedAccountStorageV1,
): Promise<void> {
	return withStorageLock(async () => {
		const path = getFlaggedAccountsPath();
		const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
		const tempPath = `${path}.${uniqueSuffix}.tmp`;

		try {
			await fs.mkdir(dirname(path), { recursive: true });
			const content = JSON.stringify(normalizeFlaggedStorage(storage), null, 2);
			await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
			await fs.rename(tempPath, path);
		} catch (error) {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Ignore cleanup failures.
			}
			log.error("Failed to save flagged account storage", {
				path,
				error: String(error),
			});
			throw error;
		}
	});
}

/**
 * Removes the flagged accounts file for the current storage.
 *
 * Runs under the global storage lock to serialize filesystem modifications. If the file is missing the call is a no-op; other filesystem errors are logged. Note that Windows may surface transient EPERM/EBUSY errors during unlinking and this function does not retry them. Logged error details may be redacted by the global logger to avoid exposing sensitive tokens.
 *
 * @returns Nothing.
 */
export async function clearFlaggedAccounts(): Promise<void> {
	return withStorageLock(async () => {
		try {
			await fs.unlink(getFlaggedAccountsPath());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				log.error("Failed to clear flagged account storage", {
					error: String(error),
				});
			}
		}
	});
}

/**
 * Export current account storage to a JSON file for backup or migration.
 *
 * When invoked inside an active storage transaction, the transaction snapshot is used and no storage lock is acquired;
 * otherwise a storage lock is taken to produce a consistent snapshot. The export writes a restricted-permission
 * temporary file next to the destination and performs an atomic rename with retry-friendly behavior for Windows
 * filesystem semantics (to mitigate EPERM/EBUSY). The exported JSON contains raw account data (including tokens/refresh tokens)
 * and is not redacted by this function.
 *
 * @param filePath - Destination file path for the exported JSON
 * @param force - If `true`, overwrite an existing file at `filePath`; if `false`, the export fails when the file exists
 * @param beforeCommit - Optional callback invoked with the resolved destination path before the final atomic rename; throwing
 *                       from this callback aborts the export and the temporary file is removed
 * @throws Error if no accounts are available to export
 * @throws Error if the destination file already exists when `force` is `false`
 */
export async function exportAccounts(
	filePath: string,
	force = true,
	beforeCommit?: (resolvedPath: string) => Promise<void> | void,
): Promise<void> {
	const resolvedPath = resolvePath(filePath);

	const writeExport = async (
		storage: AccountStorageV3 | null,
	): Promise<void> => {
		if (!force && existsSync(resolvedPath)) {
			throw new Error(`File already exists: ${resolvedPath}`);
		}
		if (!storage || storage.accounts.length === 0) {
			throw new Error("No accounts to export");
		}

		await fs.mkdir(dirname(resolvedPath), { recursive: true });

		const content = JSON.stringify(storage, null, 2);
		const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
		const tempPath = `${resolvedPath}.${uniqueSuffix}.tmp`;
		try {
			await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
			await beforeCommit?.(resolvedPath);
			if (!force && existsSync(resolvedPath)) {
				throw new Error(`File already exists: ${resolvedPath}`);
			}
			await renameFileWithRetry(tempPath, resolvedPath);
		} catch (error) {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Ignore cleanup failures for export temp files.
			}
			throw error;
		}

		log.info("Exported accounts", {
			path: resolvedPath,
			count: storage.accounts.length,
		});
	};

	const transactionContext = transactionSnapshotContext.getStore();
	if (transactionContext?.active) {
		await writeExport(transactionContext.snapshot);
		return;
	}

	await withStorageLock(async () => {
		const storage = await loadAccountsInternal(saveAccountsUnlocked);
		await writeExport(storage);
	});
}

/**
 * Imports accounts from a JSON file and merges them into existing storage, preserving
 * most-recently-used ordering and removing duplicate entries by accountId/refreshToken and email.
 *
 * This operation runs inside the storage transaction model and is serialized with other
 * storage operations to avoid concurrent modification. On Windows, import may fail if the
 * file is locked by another process. The import reads and preserves sensitive fields
 * (e.g., `refreshToken`); callers must ensure the source file has appropriate redaction/handling.
 *
 * @param filePath - Path to the JSON file to import
 * @returns An object with `imported` (number of accounts added), `total` (resulting total accounts),
 * and `skipped` (accounts present in the import but not added because they already existed)
 * @throws Error if the file does not exist, contains invalid JSON, is not a valid account storage
 * format, or if the merged result would exceed the maximum allowed accounts
 */
export async function importAccounts(
	filePath: string,
): Promise<{ imported: number; total: number; skipped: number }> {
	const resolvedPath = resolvePath(filePath);

	// Check file exists with friendly error
	if (!existsSync(resolvedPath)) {
		throw new Error(`Import file not found: ${resolvedPath}`);
	}

	const content = await fs.readFile(resolvedPath, "utf-8");

	let imported: unknown;
	try {
		imported = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in import file: ${resolvedPath}`);
	}

	const normalized = normalizeAccountStorage(imported);
	if (!normalized) {
		throw new Error("Invalid account storage format");
	}

	const {
		imported: importedCount,
		total,
		skipped: skippedCount,
	} = await withAccountStorageTransaction(async (existing, persist) => {
		const existingAccounts = existing?.accounts ?? [];
		const existingActiveIndex = existing?.activeIndex ?? 0;

		const merged = [...existingAccounts, ...normalized.accounts];

		if (merged.length > ACCOUNT_LIMITS.MAX_ACCOUNTS) {
			const deduped = deduplicateAccountsByEmail(deduplicateAccounts(merged));
			if (deduped.length > ACCOUNT_LIMITS.MAX_ACCOUNTS) {
				throw new Error(
					`Import would exceed maximum of ${ACCOUNT_LIMITS.MAX_ACCOUNTS} accounts (would have ${deduped.length})`,
				);
			}
		}

		const deduplicatedAccounts = deduplicateAccountsByEmail(
			deduplicateAccounts(merged),
		);

		const newStorage: AccountStorageV3 = {
			version: 3,
			accounts: deduplicatedAccounts,
			activeIndex: existingActiveIndex,
			activeIndexByFamily: existing?.activeIndexByFamily,
		};

		await persist(newStorage);

		const imported = deduplicatedAccounts.length - existingAccounts.length;
		const skipped = normalized.accounts.length - imported;
		return { imported, total: deduplicatedAccounts.length, skipped };
	});

	log.info("Imported accounts", {
		path: resolvedPath,
		imported: importedCount,
		skipped: skippedCount,
		total,
	});

	return { imported: importedCount, total, skipped: skippedCount };
}
