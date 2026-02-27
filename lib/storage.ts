import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ACCOUNT_LIMITS } from "./constants.js";
import { createLogger } from "./logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import { AnyAccountStorageSchema, getValidationErrors } from "./schemas.js";
import { getConfigDir, getProjectConfigDir, getProjectGlobalConfigDir, findProjectRoot, resolvePath } from "./storage/paths.js";
import {
  migrateV1ToV3,
  type CooldownReason,
  type RateLimitStateV3,
  type AccountMetadataV1,
  type AccountStorageV1,
  type AccountMetadataV3,
  type AccountStorageV3,
} from "./storage/migrations.js";

export type { CooldownReason, RateLimitStateV3, AccountMetadataV1, AccountStorageV1, AccountMetadataV3, AccountStorageV3 };

const log = createLogger("storage");
const ACCOUNTS_FILE_NAME = "openai-codex-accounts.json";
const FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-flagged-accounts.json";
const LEGACY_FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-blocked-accounts.json";
const ACCOUNTS_BACKUP_SUFFIX = ".bak";
const ACCOUNTS_WAL_SUFFIX = ".wal";

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

  constructor(message: string, code: string, path: string, hint: string, cause?: Error) {
    super(message, { cause });
    this.name = "StorageError";
    this.code = code;
    this.path = path;
    this.hint = hint;
  }
}

/**
 * Produce a concise, platform-aware troubleshooting hint for a filesystem write error.
 *
 * @param error - The original error object (may contain `code`) used to select an appropriate hint.
 * @param path - The filesystem path involved; may contain sensitive tokens so callers should pass a redacted path if necessary.
 * @returns A short, user-facing hint describing likely causes and next steps for the error at `path`.
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
 * Ensures the project's .gitignore contains an entry to ignore the `.codex/` directory when the repository root can be inferred.
 *
 * Attempts a best-effort, non-blocking update of the nearest repository `.gitignore` based on the provided storage path; failures are logged and not thrown. This function may be called concurrently and makes no guarantees about serialization of simultaneous invocations. On Windows, file-locking or permission errors may prevent the update; such conditions are treated as non-fatal. The function does not read or write sensitive account data or tokens—only the `.gitignore` file is modified.
 *
 * @param storagePath - Full path to the accounts storage file used to locate the project config directory and infer the repository root
 */
async function ensureGitignore(storagePath: string): Promise<void> {
  if (!currentStoragePath) return;

  const configDir = dirname(storagePath);
  const inferredProjectRoot = dirname(configDir);
  const candidateRoots = [currentProjectRoot, inferredProjectRoot].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  const projectRoot = candidateRoots.find((root) => existsSync(join(root, ".git")));
  if (!projectRoot) return;
  const gitignorePath = join(projectRoot, ".gitignore");

  try {
    let content = "";
    if (existsSync(gitignorePath)) {
      content = await fs.readFile(gitignorePath, "utf-8");
      const lines = content.split("\n").map((l) => l.trim());
      if (lines.includes(".codex") || lines.includes(".codex/") || lines.includes("/.codex") || lines.includes("/.codex/")) {
        return;
      }
    }

    const newContent = content.endsWith("\n") || content === "" ? content : content + "\n";
    await fs.writeFile(gitignorePath, newContent + ".codex/\n", "utf-8");
    log.debug("Added .codex to .gitignore", { path: gitignorePath });
  } catch (error) {
    log.warn("Failed to update .gitignore", { error: String(error) });
  }
}

let currentStoragePath: string | null = null;
let currentLegacyProjectStoragePath: string | null = null;
let currentProjectRoot: string | null = null;

/**
 * Toggle creation of backup files (".bak") for account storage save operations.
 *
 * When enabled, save operations will attempt to create a best-effort backup of the existing
 * accounts file before writing the new content. The change takes effect for subsequent saves
 * and does not retroactively modify existing backups. Backups are subject to the same
 * token-redaction rules as main storage and may contain sensitive account fields if those
 * fields were present in the source file.
 *
 * Concurrency: this flag is global; callers should avoid toggling it while concurrent save
 * operations are in progress to prevent race conditions in backup behavior.
 *
 * Filesystem notes: on Windows, backup creation may be affected by EPERM/EBUSY semantics and
 * the save logic includes retries for transient locking errors, but enabling backups can
 * increase the chance of such contention on heavily locked directories.
 *
 * @param enabled - `true` to enable backups, `false` to disable them
 */
export function setStorageBackupEnabled(enabled: boolean): void {
	storageBackupEnabled = enabled;
}

/**
 * Compute the backup file path for a given accounts storage file path.
 *
 * This path is the canonical backup target (appends the configured backup suffix) and is used under the storage lock;
 * callers should expect the file to be created/removed atomically where supported. On Windows the file may be briefly
 * locked (EPERM/EBUSY) during filesystem operations. Do not include secrets or tokens in logged paths; paths returned
 * by this function may be persisted or reported and should be redacted by callers when necessary.
 *
 * @param path - The canonical accounts storage file path to derive a backup path from
 * @returns The backup file path for `path`
 */
function getAccountsBackupPath(path: string): string {
	return `${path}${ACCOUNTS_BACKUP_SUFFIX}`;
}

/**
 * Constructs the write-ahead log (WAL) file path for the given accounts storage file.
 *
 * @remarks
 * - Concurrency: callers must hold the storage lock when creating, writing, or removing the WAL to avoid races.
 * - Windows: WAL files may be subject to EPERM/EBUSY semantics; callers should handle platform-specific retry/backoff.
 * - Logging: the returned path may contain sensitive tokens; do not emit it to logs without appropriate redaction.
 *
 * @param path - The base accounts storage file path (without WAL suffix)
 * @returns The full path to the WAL journal file for the provided accounts path
 */
function getAccountsWalPath(path: string): string {
	return `${path}${ACCOUNTS_WAL_SUFFIX}`;
}

/**
 * Compute the SHA-256 hex digest of a string.
 *
 * This function is pure and deterministic across platforms (including Windows) and is safe for concurrent use.
 * Do not treat the output as a secret; redact or avoid hashing raw sensitive tokens unless intended.
 *
 * @param value - The input string to hash
 * @returns The lowercase hex-encoded SHA-256 digest of `value`
 */
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
 * May be updated concurrently by save operations; callers should treat the value as a best-effort snapshot.
 * The timestamp contains no sensitive token data.
 *
 * @returns The Unix epoch milliseconds timestamp of the last successful accounts save, or `0` if no successful save has occurred.
 */
export function getLastAccountsSaveTimestamp(): number {
	return lastAccountsSaveTimestamp;
}

/**
 * Set or clear the module's project-scoped accounts storage path based on a project path.
 *
 * When given a project path, determines the project root and sets:
 * - currentStoragePath to the project's global config accounts file
 * - currentLegacyProjectStoragePath to the project's legacy config accounts file
 * - currentProjectRoot to the discovered project root
 * If no project root is found or `projectPath` is `null`, clears those module-global values.
 *
 * Concurrency: this mutates module-global state and is not synchronized; callers should perform updates during initialization or serialize calls (for example, via the storage lock) to avoid races.
 *
 * Windows filesystem note: path discovery and assignment use the platform's path semantics; this function does not perform additional normalization for UNC or case-insensitive rules—provide a canonical path when needed.
 *
 * Logging and secrets: paths may contain sensitive tokens; this function does not log paths and callers are responsible for redacting any sensitive information before logging or telemetry.
 *
 * @param projectPath - filesystem path to a project directory, or `null` to clear project-specific storage paths
 */
export function setStoragePath(projectPath: string | null): void {
  if (!projectPath) {
    currentStoragePath = null;
    currentLegacyProjectStoragePath = null;
    currentProjectRoot = null;
    return;
  }
  
  const projectRoot = findProjectRoot(projectPath);
  if (projectRoot) {
    currentProjectRoot = projectRoot;
    currentStoragePath = join(getProjectGlobalConfigDir(projectRoot), ACCOUNTS_FILE_NAME);
    currentLegacyProjectStoragePath = join(getProjectConfigDir(projectRoot), ACCOUNTS_FILE_NAME);
  } else {
    currentStoragePath = null;
    currentLegacyProjectStoragePath = null;
    currentProjectRoot = null;
  }
}

export function setStoragePathDirect(path: string | null): void {
  currentStoragePath = path;
  currentLegacyProjectStoragePath = null;
  currentProjectRoot = null;
}

/**
 * Returns the file path for the account storage JSON file.
 * @returns Absolute path to the accounts.json file
 */
export function getStoragePath(): string {
  if (currentStoragePath) {
    return currentStoragePath;
  }
  return join(getConfigDir(), ACCOUNTS_FILE_NAME);
}

export function getFlaggedAccountsPath(): string {
	return join(dirname(getStoragePath()), FLAGGED_ACCOUNTS_FILE_NAME);
}

function getLegacyFlaggedAccountsPath(): string {
	return join(dirname(getStoragePath()), LEGACY_FLAGGED_ACCOUNTS_FILE_NAME);
}

async function migrateLegacyProjectStorageIfNeeded(
  persist: (storage: AccountStorageV3) => Promise<void> = saveAccounts,
): Promise<AccountStorageV3 | null> {
  if (
    !currentStoragePath ||
    !currentLegacyProjectStoragePath ||
    currentLegacyProjectStoragePath === currentStoragePath ||
    !existsSync(currentLegacyProjectStoragePath)
  ) {
    return null;
  }

  try {
    const legacyContent = await fs.readFile(currentLegacyProjectStoragePath, "utf-8");
    const legacyData = JSON.parse(legacyContent) as unknown;
    const normalized = normalizeAccountStorage(legacyData);
    if (!normalized) return null;

    await persist(normalized);
    try {
      await fs.unlink(currentLegacyProjectStoragePath);
      log.info("Removed legacy project account storage file after migration", {
        path: currentLegacyProjectStoragePath,
      });
    } catch (unlinkError) {
      const code = (unlinkError as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn("Failed to remove legacy project account storage file after migration", {
          path: currentLegacyProjectStoragePath,
          error: String(unlinkError),
        });
      }
    }
    log.info("Migrated legacy project account storage", {
      from: currentLegacyProjectStoragePath,
      to: currentStoragePath,
      accounts: normalized.accounts.length,
    });
    return normalized;
  } catch (error) {
    log.warn("Failed to migrate legacy project account storage", {
      from: currentLegacyProjectStoragePath,
      to: currentStoragePath,
      error: String(error),
    });
    return null;
  }
}

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
 * Removes duplicate accounts, keeping the most recently used entry for each unique key.
 * Deduplication is based on accountId or refreshToken.
 * @param accounts - Array of accounts to deduplicate
 * @returns New array with duplicates removed
 */
export function deduplicateAccounts<T extends { accountId?: string; refreshToken: string; lastUsed?: number; addedAt?: number }>(
  accounts: T[],
): T[] {
  return deduplicateAccountsByKey(accounts);
}

/**
 * Removes duplicate accounts by email, keeping the most recently used entry.
 * Accounts without email are always preserved.
 * @param accounts - Array of accounts to deduplicate
 * @returns New array with email duplicates removed
 */
export function deduplicateAccountsByEmail<T extends { email?: string; lastUsed?: number; addedAt?: number }>(
  accounts: T[],
): T[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    if (!account) continue;

    const email = account.email?.trim();
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
      (candidateLastUsed === existingLastUsed && candidateAddedAt > existingAddedAt);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function toAccountKey(account: Pick<AccountMetadataV3, "accountId" | "refreshToken">): string {
  return account.accountId || account.refreshToken;
}

function extractActiveKey(accounts: unknown[], activeIndex: number): string | undefined {
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
 * Normalizes and validates account storage data, migrating from v1 to v3 if needed.
 * Handles deduplication, index clamping, and per-family active index mapping.
 * @param data - Raw storage data (unknown format)
 * @returns Normalized AccountStorageV3 or null if invalid
 */
export function normalizeAccountStorage(data: unknown): AccountStorageV3 | null {
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
      isRecord(account) && typeof account.refreshToken === "string" && !!account.refreshToken.trim(),
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
 * Load OAuth account storage from disk and return normalized v3 storage or `null` if no usable storage exists.
 *
 * This will migrate legacy v1 storage to v3 when present, and may recover from a write-ahead log or backup if the main file is corrupted. The function performs its own storage locking to serialize access; callers do not need an external lock. On Windows, filesystem races (EPERM/EBUSY) may affect recovery behavior. Returned account objects can contain sensitive tokens and secrets — callers must redact or avoid logging those fields.
 *
 * @returns The normalized AccountStorageV3 if persisted storage exists and was successfully loaded or recovered, `null` otherwise.
 */
export async function loadAccounts(): Promise<AccountStorageV3 | null> {
  return loadAccountsInternal(saveAccounts);
}

/**
 * Validates raw storage input against the account storage schema and returns a normalized v3 representation plus metadata about the original data.
 *
 * @param data - Raw parsed JSON or unknown storage content to validate and normalize
 * @returns An object with:
 *   - `normalized`: the normalized `AccountStorageV3` if input could be coerced/validated, or `null` when normalization failed
 *   - `storedVersion`: the `version` value found in the original input (may be `undefined` or any value present)
 *   - `schemaErrors`: an array of human-readable validation error messages produced by schema validation
 */
function parseAndNormalizeStorage(data: unknown): {
	normalized: AccountStorageV3 | null;
	storedVersion: unknown;
	schemaErrors: string[];
} {
	const schemaErrors = getValidationErrors(AnyAccountStorageSchema, data);
	const normalized = normalizeAccountStorage(data);
	const storedVersion = isRecord(data) ? (data as { version?: unknown }).version : undefined;
	return { normalized, storedVersion, schemaErrors };
}

/**
 * Load, parse, and normalize account storage JSON from the given filesystem path.
 *
 * This reads the file at `path`, parses it as JSON, and returns the result of schema validation
 * and normalization. The returned `normalized` value will be a v3 storage object when parsing
 * and validation succeed, or `null` when no valid storage could be produced.
 *
 * Concurrency: this function performs a raw read and does not acquire the global storage lock;
 * callers should use the provided storage lock helpers when performing multi-step read/modify/write
 * operations to avoid races.
 *
 * Windows/filesystem notes: underlying read errors (including `EPERM`, `EBUSY`, etc.) are
 * propagated as I/O exceptions; callers may retry or surface platform-specific guidance to users.
 *
 * Security: the file content and returned normalized storage may contain sensitive tokens
 * (e.g., `refreshToken`). Do not log or expose file contents or returned objects without
 * redacting sensitive fields first.
 *
 * @param path - Filesystem path to the accounts JSON file to load
 * @returns An object containing:
 *  - `normalized`: the normalized AccountStorageV3 or `null` if normalization failed
 *  - `storedVersion`: the raw version value as found in storage (may be any type)
 *  - `schemaErrors`: a list of schema/validation error messages encountered during parsing
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
 * Attempt to recover and return normalized account storage from a write-ahead log (WAL)
 * associated with the provided primary storage path.
 *
 * This validates the WAL entry checksum and parses its content into a v3 account storage
 * object; on validation failure or any IO error the function returns `null`.
 *
 * Concurrency: this routine does not acquire the global storage lock and is intended for
 * recovery during load/startup; callers must coordinate concurrent writers.
 *
 * Windows/filesystem note: WAL access may fail with transient EPERM/EBUSY conditions; those
 * errors are handled by returning `null` so callers can attempt other recovery paths.
 *
 * Security: recovered content may include sensitive tokens; callers must treat the result
 * as sensitive and redact or avoid logging tokens.
 *
 * @param path - The primary accounts file path used to resolve the WAL location
 * @returns The normalized `AccountStorageV3` recovered from the WAL, or `null` if recovery failed or no valid WAL exists
 */
async function loadAccountsFromJournal(path: string): Promise<AccountStorageV3 | null> {
	const walPath = getAccountsWalPath(path);
	try {
		const raw = await fs.readFile(walPath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return null;
		const entry = parsed as Partial<AccountsJournalEntry>;
		if (entry.version !== 1) return null;
		if (typeof entry.content !== "string" || typeof entry.checksum !== "string") return null;
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
			log.warn("Failed to load account WAL journal", { path: walPath, error: String(error) });
		}
		return null;
	}
}

/**
 * Loads account storage from disk, performing version migration, WAL recovery, and optional backup recovery.
 *
 * @param persistMigration - Optional callback invoked to persist a migrated or recovered `AccountStorageV3`. If provided, it will be called when a migration, WAL recovery, or backup recovery produces a valid v3 storage to allow committing the recovered state.
 * @returns The normalized `AccountStorageV3` when successfully loaded or recovered, or `null` if no usable storage was found.
 *
 * Concurrency: callers should assume this runs as part of the storage operation flow and may invoke `persistMigration` synchronously with the load/recovery process.
 *
 * Platform notes: on Windows the function may attempt recovery paths when exclusive file locks or EPERM/EBUSY-style errors prevent a normal read.
 *
 * Logging: errors and recovery attempts are logged; sensitive tokens are redacted in logs by upstream logging utilities.
 */
async function loadAccountsInternal(
  persistMigration: ((storage: AccountStorageV3) => Promise<void>) | null,
): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath();
    const { normalized, storedVersion, schemaErrors } = await loadAccountsFromPath(path);
    if (schemaErrors.length > 0) {
      log.warn("Account storage schema validation warnings", { errors: schemaErrors.slice(0, 5) });
    }
    if (normalized && storedVersion !== normalized.version) {
      log.info("Migrating account storage to v3", { from: storedVersion, to: normalized.version });
      if (persistMigration) {
        try {
          await persistMigration(normalized);
        } catch (saveError) {
          log.warn("Failed to persist migrated storage", { error: String(saveError) });
        }
      }
    }

    return normalized;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
	const path = getStoragePath();
    if (code === "ENOENT") {
      const migrated = persistMigration
        ? await migrateLegacyProjectStorageIfNeeded(persistMigration)
        : null;
      if (migrated) return migrated;
      return null;
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
		const backupPath = getAccountsBackupPath(path);
		try {
			const backup = await loadAccountsFromPath(backupPath);
			if (backup.schemaErrors.length > 0) {
				log.warn("Backup account storage schema validation warnings", {
					path: backupPath,
					errors: backup.schemaErrors.slice(0, 5),
				});
			}
			if (backup.normalized) {
				log.warn("Recovered account storage from backup file", { path, backupPath });
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

    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

/**
 * Atomically persists the provided account storage to disk using a write‑ahead log,
 * temporary file rename, and optional backup; cleans up the WAL on success.
 *
 * @param storage - The normalized AccountStorageV3 object to persist. This function writes the storage content verbatim; callers must redact any sensitive tokens before calling if redaction is required.
 *
 * Concurrency: callers must invoke this under the storage lock (it is not itself locking) to avoid concurrent writers.
 *
 * Platform notes: on Windows this will retry the final atomic rename several times to work around transient EPERM/EBUSY errors.
 *
 * @throws StorageError - When the save cannot be completed (includes a platform-aware hint and original error code).
 */
async function saveAccountsUnlocked(storage: AccountStorageV3): Promise<void> {
  const path = getStoragePath();
  const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = `${path}.${uniqueSuffix}.tmp`;
  const walPath = getAccountsWalPath(path);

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await ensureGitignore(path);

	if (storageBackupEnabled && existsSync(path)) {
		const backupPath = getAccountsBackupPath(path);
		try {
			await fs.copyFile(path, backupPath);
		} catch (backupError) {
			log.warn("Failed to create account storage backup", {
				path,
				backupPath,
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
      const emptyError = Object.assign(new Error("File written but size is 0"), { code: "EEMPTY" });
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
          await new Promise(r => setTimeout(r, 10 * Math.pow(2, attempt)));
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
      err instanceof Error ? err : undefined
    );
  }
}

export async function withAccountStorageTransaction<T>(
  handler: (
    current: AccountStorageV3 | null,
    persist: (storage: AccountStorageV3) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  return withStorageLock(async () => {
    const current = await loadAccountsInternal(saveAccountsUnlocked);
    return handler(current, saveAccountsUnlocked);
  });
}

/**
 * Persists account storage to disk using atomic write (temp file + rename).
 * Creates the Codex multi-auth storage directory if it doesn't exist.
 * Verifies file was written correctly and provides detailed error messages.
 * @param storage - Account storage data to save
 * @throws StorageError with platform-aware hints on failure
 */
export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
  return withStorageLock(async () => {
    await saveAccountsUnlocked(storage);
  });
}

/**
 * Deletes the account storage file from disk.
 * Silently ignores if file doesn't exist.
 */
export async function clearAccounts(): Promise<void> {
  return withStorageLock(async () => {
    try {
      const path = getStoragePath();
      await fs.unlink(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.error("Failed to clear account storage", { error: String(error) });
      }
    }
  });
}

function normalizeFlaggedStorage(data: unknown): FlaggedAccountStorageV1 {
	if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.accounts)) {
		return { version: 1, accounts: [] };
	}

	const byRefreshToken = new Map<string, FlaggedAccountMetadataV1>();
	for (const rawAccount of data.accounts) {
		if (!isRecord(rawAccount)) continue;
		const refreshToken =
			typeof rawAccount.refreshToken === "string" ? rawAccount.refreshToken.trim() : "";
		if (!refreshToken) continue;

		const flaggedAt = typeof rawAccount.flaggedAt === "number" ? rawAccount.flaggedAt : Date.now();
		const isAccountIdSource = (
			value: unknown,
		): value is AccountMetadataV3["accountIdSource"] =>
			value === "token" || value === "id_token" || value === "org" || value === "manual";
		const isSwitchReason = (
			value: unknown,
		): value is AccountMetadataV3["lastSwitchReason"] =>
			value === "rate-limit" || value === "initial" || value === "rotation";
		const isCooldownReason = (
			value: unknown,
		): value is AccountMetadataV3["cooldownReason"] =>
			value === "auth-failure" || value === "network-error";

		let rateLimitResetTimes: AccountMetadataV3["rateLimitResetTimes"] | undefined;
		if (isRecord(rawAccount.rateLimitResetTimes)) {
			const normalizedRateLimits: Record<string, number | undefined> = {};
			for (const [key, value] of Object.entries(rawAccount.rateLimitResetTimes)) {
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
			addedAt: typeof rawAccount.addedAt === "number" ? rawAccount.addedAt : flaggedAt,
			lastUsed: typeof rawAccount.lastUsed === "number" ? rawAccount.lastUsed : flaggedAt,
			accountId: typeof rawAccount.accountId === "string" ? rawAccount.accountId : undefined,
			accountIdSource,
			accountLabel: typeof rawAccount.accountLabel === "string" ? rawAccount.accountLabel : undefined,
			email: typeof rawAccount.email === "string" ? rawAccount.email : undefined,
			enabled: typeof rawAccount.enabled === "boolean" ? rawAccount.enabled : undefined,
			lastSwitchReason,
			rateLimitResetTimes,
			coolingDownUntil:
				typeof rawAccount.coolingDownUntil === "number" ? rawAccount.coolingDownUntil : undefined,
			cooldownReason,
			flaggedAt,
			flaggedReason: typeof rawAccount.flaggedReason === "string" ? rawAccount.flaggedReason : undefined,
			lastError: typeof rawAccount.lastError === "string" ? rawAccount.lastError : undefined,
		};
		byRefreshToken.set(refreshToken, normalized);
	}

	return {
		version: 1,
		accounts: Array.from(byRefreshToken.values()),
	};
}

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
			log.error("Failed to load flagged account storage", { path, error: String(error) });
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

export async function saveFlaggedAccounts(storage: FlaggedAccountStorageV1): Promise<void> {
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
			log.error("Failed to save flagged account storage", { path, error: String(error) });
			throw error;
		}
	});
}

export async function clearFlaggedAccounts(): Promise<void> {
	return withStorageLock(async () => {
		try {
			await fs.unlink(getFlaggedAccountsPath());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				log.error("Failed to clear flagged account storage", { error: String(error) });
			}
		}
	});
}

/**
 * Exports current accounts to a JSON file for backup/migration.
 * @param filePath - Destination file path
 * @param force - If true, overwrite existing file (default: true)
 * @throws Error if file exists and force is false, or if no accounts to export
 */
export async function exportAccounts(filePath: string, force = true): Promise<void> {
  const resolvedPath = resolvePath(filePath);
  
  if (!force && existsSync(resolvedPath)) {
    throw new Error(`File already exists: ${resolvedPath}`);
  }
  
  const storage = await withAccountStorageTransaction((current) => Promise.resolve(current));
  if (!storage || storage.accounts.length === 0) {
    throw new Error("No accounts to export");
  }
  
  await fs.mkdir(dirname(resolvedPath), { recursive: true });
  
  const content = JSON.stringify(storage, null, 2);
  await fs.writeFile(resolvedPath, content, { encoding: "utf-8", mode: 0o600 });
  log.info("Exported accounts", { path: resolvedPath, count: storage.accounts.length });
}

/**
 * Imports accounts from a JSON file, merging with existing accounts.
 * Deduplicates by accountId/email, preserving most recently used entries.
 * @param filePath - Source file path
 * @throws Error if file is invalid or would exceed MAX_ACCOUNTS
 */
export async function importAccounts(filePath: string): Promise<{ imported: number; total: number; skipped: number }> {
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
  
  const { imported: importedCount, total, skipped: skippedCount } =
    await withAccountStorageTransaction(async (existing, persist) => {
      const existingAccounts = existing?.accounts ?? [];
      const existingActiveIndex = existing?.activeIndex ?? 0;

      const merged = [...existingAccounts, ...normalized.accounts];

      if (merged.length > ACCOUNT_LIMITS.MAX_ACCOUNTS) {
        const deduped = deduplicateAccountsByEmail(deduplicateAccounts(merged));
        if (deduped.length > ACCOUNT_LIMITS.MAX_ACCOUNTS) {
          throw new Error(
            `Import would exceed maximum of ${ACCOUNT_LIMITS.MAX_ACCOUNTS} accounts (would have ${deduped.length})`
          );
        }
      }

      const deduplicatedAccounts = deduplicateAccountsByEmail(deduplicateAccounts(merged));

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

  log.info("Imported accounts", { path: resolvedPath, imported: importedCount, skipped: skippedCount, total });

  return { imported: importedCount, total, skipped: skippedCount };
}
