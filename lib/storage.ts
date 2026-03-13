import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ACCOUNT_LIMITS } from "./constants.js";
import { createLogger } from "./logger.js";
import {
	exportNamedBackupFile,
	getNamedBackupRoot,
	resolveNamedBackupPath,
} from "./named-backup-export.js";
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
const RESET_MARKER_SUFFIX = ".reset-intent";
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

type RestoreReason = "empty-storage" | "intentional-reset" | "missing-storage";

type AccountStorageWithMetadata = AccountStorageV3 & {
	restoreEligible?: boolean;
	restoreReason?: RestoreReason;
};

type BackupSnapshotKind =
	| "accounts-primary"
	| "accounts-wal"
	| "accounts-backup"
	| "accounts-backup-history"
	| "accounts-discovered-backup"
	| "flagged-primary"
	| "flagged-backup"
	| "flagged-backup-history"
	| "flagged-discovered-backup";

type BackupSnapshotMetadata = {
	kind: BackupSnapshotKind;
	path: string;
	index?: number;
	exists: boolean;
	valid: boolean;
	bytes?: number;
	mtimeMs?: number;
	version?: number;
	accountCount?: number;
	flaggedCount?: number;
	schemaErrors?: string[];
};

type BackupMetadataSection = {
	storagePath: string;
	latestValidPath?: string;
	snapshotCount: number;
	validSnapshotCount: number;
	snapshots: BackupSnapshotMetadata[];
};

export type BackupMetadata = {
	accounts: BackupMetadataSection;
	flaggedAccounts: BackupMetadataSection;
};

export type RestoreAssessment = {
	storagePath: string;
	restoreEligible: boolean;
	restoreReason?: RestoreReason;
	latestSnapshot?: BackupSnapshotMetadata;
	backupMetadata: BackupMetadata;
};

export interface NamedBackupMetadata {
	name: string;
	path: string;
	createdAt: number | null;
	updatedAt: number | null;
	sizeBytes: number | null;
	version: number | null;
	accountCount: number | null;
	schemaErrors: string[];
	valid: boolean;
	loadError?: string;
}

export interface BackupRestoreAssessment {
	backup: NamedBackupMetadata;
	currentAccountCount: number;
	mergedAccountCount: number | null;
	imported: number | null;
	skipped: number | null;
	wouldExceedLimit: boolean;
	valid: boolean;
	error?: string;
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
 * Generate platform-aware troubleshooting hint based on error code.
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
	storagePath: string;
}>();

function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
	const previousMutex = storageMutex;
	let releaseLock: () => void;
	storageMutex = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	return previousMutex.then(fn).finally(() => releaseLock());
}

async function unlinkWithRetry(path: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.unlink(path);
			return;
		} catch (error) {
			const unlinkError = error as NodeJS.ErrnoException;
			const code = unlinkError.code;
			if (code === "ENOENT") {
				return;
			}
			if ((code === "EPERM" || code === "EBUSY" || code === "EAGAIN") && attempt < 4) {
				await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
				continue;
			}
			throw unlinkError;
		}
	}
}

type AnyAccountStorage = AccountStorageV1 | AccountStorageV3;

type AccountLike = {
	accountId?: string;
	email?: string;
	refreshToken?: string;
	addedAt?: number;
	lastUsed?: number;
};

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

function looksLikeSyntheticFixtureStorage(
	storage: AccountStorageV3 | null,
): boolean {
	if (!storage || storage.accounts.length === 0) return false;
	return storage.accounts.every((account) =>
		looksLikeSyntheticFixtureAccount(account),
	);
}

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

function getAccountsBackupRecoveryCandidates(path: string): string[] {
	const candidates: string[] = [];
	for (let i = 0; i < ACCOUNTS_BACKUP_HISTORY_DEPTH; i += 1) {
		candidates.push(getAccountsBackupPathAtIndex(path, i));
	}
	return candidates;
}

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
			if (isCacheLikeBackupArtifactName(entry.name)) continue;
			if (entry.name.endsWith(RESET_MARKER_SUFFIX)) continue;
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

function getIntentionalResetMarkerPath(path: string): string {
	return `${path}${RESET_MARKER_SUFFIX}`;
}

function createEmptyStorageWithMetadata(
	restoreEligible: boolean,
	restoreReason: RestoreReason,
): AccountStorageWithMetadata {
	return {
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: {},
		restoreEligible,
		restoreReason,
	};
}

function withRestoreMetadata(
	storage: AccountStorageV3,
	restoreEligible: boolean,
	restoreReason: RestoreReason,
): AccountStorageWithMetadata {
	return {
		...storage,
		restoreEligible,
		restoreReason,
	};
}

function isCacheLikeBackupArtifactName(entryName: string): boolean {
	return entryName.toLowerCase().includes(".cache");
}

async function statSnapshot(path: string): Promise<{
	exists: boolean;
	bytes?: number;
	mtimeMs?: number;
}> {
	try {
		const stats = await fs.stat(path);
		return { exists: true, bytes: stats.size, mtimeMs: stats.mtimeMs };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to stat backup candidate", {
				path,
				error: String(error),
			});
		}
		return { exists: false };
	}
}

async function describeAccountSnapshot(
	path: string,
	kind: BackupSnapshotKind,
	index?: number,
): Promise<BackupSnapshotMetadata> {
	const stats = await statSnapshot(path);
	if (!stats.exists) {
		return { kind, path, index, exists: false, valid: false };
	}
	try {
		const { normalized, schemaErrors, storedVersion } =
			await loadAccountsFromPath(path);
		return {
			kind,
			path,
			index,
			exists: true,
			valid: !!normalized,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
			version: typeof storedVersion === "number" ? storedVersion : undefined,
			accountCount: normalized?.accounts.length,
			schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to inspect account snapshot", {
				path,
				error: String(error),
			});
		}
		return {
			kind,
			path,
			index,
			exists: true,
			valid: false,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
		};
	}
}

async function describeAccountsWalSnapshot(
	path: string,
): Promise<BackupSnapshotMetadata> {
	const stats = await statSnapshot(path);
	if (!stats.exists) {
		return { kind: "accounts-wal", path, exists: false, valid: false };
	}
	try {
		const raw = await fs.readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) {
			return {
				kind: "accounts-wal",
				path,
				exists: true,
				valid: false,
				bytes: stats.bytes,
				mtimeMs: stats.mtimeMs,
			};
		}
		const entry = parsed as Partial<AccountsJournalEntry>;
		if (
			entry.version !== 1 ||
			typeof entry.content !== "string" ||
			typeof entry.checksum !== "string" ||
			computeSha256(entry.content) !== entry.checksum
		) {
			return {
				kind: "accounts-wal",
				path,
				exists: true,
				valid: false,
				bytes: stats.bytes,
				mtimeMs: stats.mtimeMs,
			};
		}
		const { normalized, storedVersion, schemaErrors } =
			parseAndNormalizeStorage(JSON.parse(entry.content) as unknown);
		return {
			kind: "accounts-wal",
			path,
			exists: true,
			valid: !!normalized,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
			version: typeof storedVersion === "number" ? storedVersion : undefined,
			accountCount: normalized?.accounts.length,
			schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
		};
	} catch {
		return {
			kind: "accounts-wal",
			path,
			exists: true,
			valid: false,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
		};
	}
}

async function loadFlaggedAccountsFromPath(
	path: string,
): Promise<FlaggedAccountStorageV1> {
	const content = await fs.readFile(path, "utf-8");
	const data = JSON.parse(content) as unknown;
	return normalizeFlaggedStorage(data);
}

async function describeFlaggedSnapshot(
	path: string,
	kind: BackupSnapshotKind,
	index?: number,
): Promise<BackupSnapshotMetadata> {
	const stats = await statSnapshot(path);
	if (!stats.exists) {
		return { kind, path, index, exists: false, valid: false };
	}
	try {
		const storage = await loadFlaggedAccountsFromPath(path);
		return {
			kind,
			path,
			index,
			exists: true,
			valid: true,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
			version: storage.version,
			flaggedCount: storage.accounts.length,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to inspect flagged snapshot", {
				path,
				error: String(error),
			});
		}
		return {
			kind,
			path,
			index,
			exists: true,
			valid: false,
			bytes: stats.bytes,
			mtimeMs: stats.mtimeMs,
		};
	}
}

function latestValidSnapshot(
	snapshots: BackupSnapshotMetadata[],
): BackupSnapshotMetadata | undefined {
	return snapshots
		.filter((snapshot) => snapshot.valid)
		.sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0))[0];
}

function buildMetadataSection(
	storagePath: string,
	snapshots: BackupSnapshotMetadata[],
): BackupMetadataSection {
	const latestValid = latestValidSnapshot(snapshots);
	return {
		storagePath,
		latestValidPath: latestValid?.path,
		snapshotCount: snapshots.length,
		validSnapshotCount: snapshots.filter((snapshot) => snapshot.valid).length,
		snapshots,
	};
}

type AccountsJournalEntry = {
	version: 1;
	createdAt: number;
	path: string;
	checksum: string;
	content: string;
};

export function getLastAccountsSaveTimestamp(): number {
	return lastAccountsSaveTimestamp;
}

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

export function setStoragePathDirect(path: string | null): void {
	currentStoragePath = path;
	currentLegacyProjectStoragePath = null;
	currentLegacyWorktreeStoragePath = null;
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

export function buildNamedBackupPath(name: string): string {
	return resolveNamedBackupPath(name, getStoragePath());
}

export async function exportNamedBackup(
	name: string,
	options?: { force?: boolean },
): Promise<string> {
	return exportNamedBackupFile(
		name,
		{
			getStoragePath,
			exportAccounts,
		},
		options,
	);
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

function normalizeAccountIdKey(
	accountId: string | undefined,
): string | undefined {
	if (!accountId) return undefined;
	const trimmed = accountId.trim();
	return trimmed || undefined;
}

/**
 * Normalize email keys for case-insensitive account identity matching.
 */
export function normalizeEmailKey(
	email: string | undefined,
): string | undefined {
	if (!email) return undefined;
	const trimmed = email.trim();
	if (!trimmed) return undefined;
	return trimmed.toLowerCase();
}

function normalizeRefreshTokenKey(
	refreshToken: string | undefined,
): string | undefined {
	if (!refreshToken) return undefined;
	const trimmed = refreshToken.trim();
	return trimmed || undefined;
}

type AccountIdentityRef = {
	accountId?: string;
	emailKey?: string;
	refreshToken?: string;
};

type AccountMatchOptions = {
	allowUniqueAccountIdFallbackWithoutEmail?: boolean;
};

function toAccountIdentityRef(
	account:
		| Pick<AccountLike, "accountId" | "email" | "refreshToken">
		| null
		| undefined,
): AccountIdentityRef {
	return {
		accountId: normalizeAccountIdKey(account?.accountId),
		emailKey: normalizeEmailKey(account?.email),
		refreshToken: normalizeRefreshTokenKey(account?.refreshToken),
	};
}

function collectDistinctIdentityValues(
	values: Array<string | undefined>,
): Set<string> {
	const distinct = new Set<string>();
	for (const value of values) {
		if (value) distinct.add(value);
	}
	return distinct;
}

export function getAccountIdentityKey(
	account: Pick<AccountLike, "accountId" | "email" | "refreshToken">,
): string | undefined {
	const ref = toAccountIdentityRef(account);
	if (ref.accountId && ref.emailKey) {
		return `account:${ref.accountId}::email:${ref.emailKey}`;
	}
	if (ref.accountId) return `account:${ref.accountId}`;
	if (ref.emailKey) return `email:${ref.emailKey}`;
	if (ref.refreshToken) return `refresh:${ref.refreshToken}`;
	return undefined;
}

function findNewestMatchingIndex<T extends AccountLike>(
	accounts: readonly T[],
	predicate: (ref: AccountIdentityRef) => boolean,
): number | undefined {
	let matchIndex: number | undefined;
	let match: T | undefined;
	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account) continue;
		const ref = toAccountIdentityRef(account);
		if (!predicate(ref)) continue;
		if (matchIndex === undefined) {
			matchIndex = i;
			match = account;
			continue;
		}
		const newest = selectNewestAccount(match, account);
		if (newest === account) {
			matchIndex = i;
			match = account;
		}
	}
	return matchIndex;
}

function findCompositeAccountMatchIndex<T extends AccountLike>(
	accounts: readonly T[],
	candidateRef: AccountIdentityRef,
): number | undefined {
	if (!candidateRef.accountId || !candidateRef.emailKey) return undefined;
	return findNewestMatchingIndex(
		accounts,
		(ref) =>
			ref.accountId === candidateRef.accountId &&
			ref.emailKey === candidateRef.emailKey,
	);
}

function findSafeEmailMatchIndex<T extends AccountLike>(
	accounts: readonly T[],
	candidateRef: AccountIdentityRef,
): number | undefined {
	if (!candidateRef.emailKey) return undefined;

	const emailAccountIds: Array<string | undefined> = [candidateRef.accountId];
	let foundAny = false;
	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account) continue;
		const ref = toAccountIdentityRef(account);
		if (ref.emailKey !== candidateRef.emailKey) continue;
		foundAny = true;
		emailAccountIds.push(ref.accountId);
	}

	if (!foundAny) return undefined;
	if (collectDistinctIdentityValues(emailAccountIds).size > 1) {
		return undefined;
	}

	return findNewestMatchingIndex(
		accounts,
		(ref) => ref.emailKey === candidateRef.emailKey,
	);
}

function findCompatibleRefreshTokenMatchIndex<T extends AccountLike>(
	accounts: readonly T[],
	candidateRef: AccountIdentityRef,
): number | undefined {
	if (!candidateRef.refreshToken) return undefined;
	let matchingIndex: number | undefined;
	let matchingAccount: T | null = null;

	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account) continue;
		const ref = toAccountIdentityRef(account);
		if (ref.refreshToken !== candidateRef.refreshToken) continue;
		if (
			(candidateRef.accountId &&
				ref.accountId &&
				ref.accountId !== candidateRef.accountId) ||
			(candidateRef.emailKey &&
				ref.emailKey &&
				ref.emailKey !== candidateRef.emailKey)
		) {
			return undefined;
		}
		if (
			matchingIndex !== undefined &&
			!candidateRef.accountId &&
			!candidateRef.emailKey
		) {
			return undefined;
		}
		if (matchingIndex === undefined || matchingAccount === null) {
			matchingIndex = i;
			matchingAccount = account;
			continue;
		}
		const newest: T = selectNewestAccount(matchingAccount, account);
		if (newest === account) {
			matchingIndex = i;
			matchingAccount = account;
		}
	}

	return matchingIndex;
}

function findUniqueAccountIdMatchIndex<T extends AccountLike>(
	accounts: readonly T[],
	candidateRef: AccountIdentityRef,
	options: AccountMatchOptions,
): number | undefined {
	if (!candidateRef.accountId) return undefined;
	if (
		!candidateRef.emailKey &&
		!options.allowUniqueAccountIdFallbackWithoutEmail
	) {
		return undefined;
	}
	let matchingIndex: number | undefined;
	let matchingEmailKey: string | undefined;

	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account) continue;
		const ref = toAccountIdentityRef(account);
		if (ref.accountId !== candidateRef.accountId) continue;
		if (matchingIndex !== undefined) {
			return undefined;
		}
		matchingIndex = i;
		matchingEmailKey = ref.emailKey;
	}

	if (
		matchingIndex !== undefined &&
		matchingEmailKey &&
		candidateRef.emailKey &&
		matchingEmailKey !== candidateRef.emailKey
	) {
		return undefined;
	}

	return matchingIndex;
}

export function findMatchingAccountIndex<
	T extends Pick<AccountLike, "accountId" | "email" | "refreshToken">,
>(
	accounts: readonly T[],
	candidate: Pick<AccountLike, "accountId" | "email" | "refreshToken">,
	options: AccountMatchOptions = {},
): number | undefined {
	const candidateRef = toAccountIdentityRef(candidate);

	const byComposite = findCompositeAccountMatchIndex(accounts, candidateRef);
	if (byComposite !== undefined) return byComposite;

	const byEmail = findSafeEmailMatchIndex(accounts, candidateRef);
	if (byEmail !== undefined) return byEmail;

	if (candidateRef.refreshToken) {
		const byRefresh = findCompatibleRefreshTokenMatchIndex(
			accounts,
			candidateRef,
		);
		if (byRefresh !== undefined) return byRefresh;
	}

	return findUniqueAccountIdMatchIndex(accounts, candidateRef, options);
}

export function resolveAccountSelectionIndex<
	T extends Pick<AccountLike, "accountId" | "email" | "refreshToken">,
>(
	accounts: readonly T[],
	candidate: Pick<AccountLike, "accountId" | "email" | "refreshToken">,
	fallbackIndex = 0,
): number {
	if (accounts.length === 0) return 0;
	const matchedIndex = findMatchingAccountIndex(accounts, candidate, {
		allowUniqueAccountIdFallbackWithoutEmail: true,
	});
	if (matchedIndex !== undefined) return matchedIndex;
	return clampIndex(fallbackIndex, accounts.length);
}

function deduplicateAccountsByIdentity<T extends AccountLike>(
	accounts: T[],
): T[] {
	const deduplicated: T[] = [];
	for (const account of accounts) {
		if (!account) continue;
		const existingIndex = findMatchingAccountIndex(deduplicated, account);
		if (existingIndex === undefined) {
			deduplicated.push(account);
			continue;
		}
		deduplicated[existingIndex] = selectNewestAccount(
			deduplicated[existingIndex],
			account,
		);
	}
	return deduplicated;
}

/**
 * Removes duplicate accounts, keeping the most recently used entry for each
 * safely matched identity.
 */
export function deduplicateAccounts<
	T extends {
		accountId?: string;
		email?: string;
		refreshToken?: string;
		lastUsed?: number;
		addedAt?: number;
	},
>(accounts: T[]): T[] {
	return deduplicateAccountsByIdentity(accounts);
}

export function deduplicateAccountsByEmail<
	T extends {
		accountId?: string;
		email?: string;
		refreshToken?: string;
		lastUsed?: number;
		addedAt?: number;
	},
>(accounts: T[]): T[] {
	return deduplicateAccountsByIdentity(accounts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

function extractActiveAccountRef(
	accounts: unknown[],
	activeIndex: number,
): AccountIdentityRef {
	const candidate = accounts[activeIndex];
	if (!isRecord(candidate)) return {};

	return toAccountIdentityRef({
		accountId:
			typeof candidate.accountId === "string" ? candidate.accountId : undefined,
		email: typeof candidate.email === "string" ? candidate.email : undefined,
		refreshToken:
			typeof candidate.refreshToken === "string"
				? candidate.refreshToken
				: undefined,
	});
}

/**
 * Normalizes and validates account storage data, migrating from v1 to v3 if needed.
 * Handles deduplication, index clamping, and per-family active index mapping.
 * @param data - Raw storage data (unknown format)
 * @returns Normalized AccountStorageV3 or null if invalid
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
	const activeRef = extractActiveAccountRef(rawAccounts, rawActiveIndex);

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

	const deduplicatedAccounts = deduplicateAccounts(validAccounts);

	const activeIndex = (() => {
		if (deduplicatedAccounts.length === 0) return 0;
		return resolveAccountSelectionIndex(
			deduplicatedAccounts,
			{
				accountId: activeRef.accountId,
				email: activeRef.emailKey,
				refreshToken: activeRef.refreshToken,
			},
			rawActiveIndex,
		);
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
		const familyRef = extractActiveAccountRef(rawAccounts, clampedRawIndex);
		activeIndexByFamily[family] = resolveAccountSelectionIndex(
			deduplicatedAccounts,
			{
				accountId: familyRef.accountId,
				email: familyRef.emailKey,
				refreshToken: familyRef.refreshToken,
			},
			rawIndex,
		);
	}

	return {
		version: 3,
		accounts: deduplicatedAccounts,
		activeIndex,
		activeIndexByFamily,
	};
}

/**
 * Loads OAuth accounts from disk storage.
 * Automatically migrates v1 storage to v3 format if needed.
 * @returns AccountStorageV3 if file exists and is valid, null otherwise
 */
export async function loadAccounts(): Promise<AccountStorageV3 | null> {
	return loadAccountsInternal(saveAccounts);
}

export async function getBackupMetadata(): Promise<BackupMetadata> {
	const storagePath = getStoragePath();
	const walPath = getAccountsWalPath(storagePath);
	const accountCandidates =
		await getAccountsBackupRecoveryCandidatesWithDiscovery(storagePath);
	const accountSnapshots: BackupSnapshotMetadata[] = [
		await describeAccountSnapshot(storagePath, "accounts-primary"),
		await describeAccountsWalSnapshot(walPath),
	];
	for (const [index, candidate] of accountCandidates.entries()) {
		const kind: BackupSnapshotKind =
			candidate === `${storagePath}.bak`
				? "accounts-backup"
				: candidate.startsWith(`${storagePath}.bak.`)
					? "accounts-backup-history"
					: "accounts-discovered-backup";
		accountSnapshots.push(
			await describeAccountSnapshot(candidate, kind, index),
		);
	}

	const flaggedPath = getFlaggedAccountsPath();
	const flaggedCandidates =
		await getAccountsBackupRecoveryCandidatesWithDiscovery(flaggedPath);
	const flaggedSnapshots: BackupSnapshotMetadata[] = [
		await describeFlaggedSnapshot(flaggedPath, "flagged-primary"),
	];
	for (const [index, candidate] of flaggedCandidates.entries()) {
		const kind: BackupSnapshotKind =
			candidate === `${flaggedPath}.bak`
				? "flagged-backup"
				: candidate.startsWith(`${flaggedPath}.bak.`)
					? "flagged-backup-history"
					: "flagged-discovered-backup";
		flaggedSnapshots.push(
			await describeFlaggedSnapshot(candidate, kind, index),
		);
	}

	return {
		accounts: buildMetadataSection(storagePath, accountSnapshots),
		flaggedAccounts: buildMetadataSection(flaggedPath, flaggedSnapshots),
	};
}

export async function getRestoreAssessment(): Promise<RestoreAssessment> {
	const storagePath = getStoragePath();
	const resetMarkerPath = getIntentionalResetMarkerPath(storagePath);
	const backupMetadata = await getBackupMetadata();
	if (existsSync(resetMarkerPath)) {
		return {
			storagePath,
			restoreEligible: false,
			restoreReason: "intentional-reset",
			backupMetadata,
		};
	}
	const primarySnapshot = backupMetadata.accounts.snapshots.find(
		(snapshot) => snapshot.kind === "accounts-primary",
	);
	if (!primarySnapshot?.exists) {
		return {
			storagePath,
			restoreEligible: true,
			restoreReason: "missing-storage",
			latestSnapshot: backupMetadata.accounts.latestValidPath
				? backupMetadata.accounts.snapshots.find(
						(snapshot) =>
							snapshot.path === backupMetadata.accounts.latestValidPath,
					)
				: undefined,
			backupMetadata,
		};
	}
	if (primarySnapshot.valid && primarySnapshot.accountCount === 0) {
		return {
			storagePath,
			restoreEligible: true,
			restoreReason: "empty-storage",
			latestSnapshot: primarySnapshot,
			backupMetadata,
		};
	}
	return {
		storagePath,
		restoreEligible: false,
		latestSnapshot: backupMetadata.accounts.latestValidPath
			? backupMetadata.accounts.snapshots.find(
					(snapshot) =>
						snapshot.path === backupMetadata.accounts.latestValidPath,
				)
			: undefined,
		backupMetadata,
	};
}

export async function listNamedBackups(): Promise<NamedBackupMetadata[]> {
	const backupRoot = getNamedBackupRoot(getStoragePath());
	try {
		const entries = await fs.readdir(backupRoot, { withFileTypes: true });
		const backups: NamedBackupMetadata[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || entry.isSymbolicLink()) continue;
			if (!entry.name.toLowerCase().endsWith(".json")) continue;

			const path = resolvePath(join(backupRoot, entry.name));
			const candidate = await loadBackupCandidate(path);
			backups.push(
				await buildNamedBackupMetadata(
					entry.name.slice(0, -".json".length),
					path,
					{ candidate },
				),
			);
		}
		return backups.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to list named backups", {
				path: backupRoot,
				error: String(error),
			});
		}
		return [];
	}
}

export function getNamedBackupsDirectoryPath(): string {
	return getNamedBackupRoot(getStoragePath());
}

export async function createNamedBackup(
	name: string,
	options: { force?: boolean } = {},
): Promise<NamedBackupMetadata> {
	const backupPath = await exportNamedBackup(name, options);
	const candidate = await loadBackupCandidate(backupPath);
	return buildNamedBackupMetadata(
		basename(backupPath).slice(0, -".json".length),
		backupPath,
		{ candidate },
	);
}

export async function assessNamedBackupRestore(
	name: string,
	options: { currentStorage?: AccountStorageV3 | null } = {},
): Promise<BackupRestoreAssessment> {
	const backupPath = await resolveNamedBackupRestorePath(name);
	const candidate = await loadBackupCandidate(backupPath);
	const backup = await buildNamedBackupMetadata(
		basename(backupPath).slice(0, -".json".length),
		backupPath,
		{ candidate },
	);
	const currentStorage = options.currentStorage ?? (await loadAccounts());
	const currentAccounts = currentStorage?.accounts ?? [];

	if (!candidate.normalized || !backup.accountCount || backup.accountCount <= 0) {
		return {
			backup,
			currentAccountCount: currentAccounts.length,
			mergedAccountCount: null,
			imported: null,
			skipped: null,
			wouldExceedLimit: false,
			valid: false,
			error: backup.loadError ?? "Backup is empty or invalid",
		};
	}

	const mergedAccounts = deduplicateAccounts([
		...currentAccounts,
		...candidate.normalized.accounts,
	]);
	const wouldExceedLimit = mergedAccounts.length > ACCOUNT_LIMITS.MAX_ACCOUNTS;
	const imported = wouldExceedLimit
		? null
		: mergedAccounts.length - currentAccounts.length;
	const skipped = wouldExceedLimit
		? null
		: Math.max(0, candidate.normalized.accounts.length - (imported ?? 0));

	return {
		backup,
		currentAccountCount: currentAccounts.length,
		mergedAccountCount: mergedAccounts.length,
		imported,
		skipped,
		wouldExceedLimit,
		valid: !wouldExceedLimit,
		error: wouldExceedLimit
			? `Restore would exceed maximum of ${ACCOUNT_LIMITS.MAX_ACCOUNTS} accounts`
			: undefined,
	};
}

export async function restoreNamedBackup(
	name: string,
): Promise<{ imported: number; total: number; skipped: number }> {
	const backupPath = await resolveNamedBackupRestorePath(name);
	return importAccounts(backupPath);
}

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

async function loadAccountsFromPath(path: string): Promise<{
	normalized: AccountStorageV3 | null;
	storedVersion: unknown;
	schemaErrors: string[];
}> {
	const content = await fs.readFile(path, "utf-8");
	const data = JSON.parse(content) as unknown;
	return parseAndNormalizeStorage(data);
}

async function loadBackupCandidate(path: string): Promise<{
	normalized: AccountStorageV3 | null;
	storedVersion: unknown;
	schemaErrors: string[];
	error?: string;
}> {
	try {
		return await loadAccountsFromPath(path);
	} catch (error) {
		return {
			normalized: null,
			storedVersion: undefined,
			schemaErrors: [],
			error: String(error),
		};
	}
}

function equalsNamedBackupEntry(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

async function findExistingNamedBackupPath(
	name: string,
): Promise<string | undefined> {
	const requested = (name ?? "").trim();
	if (!requested) {
		return undefined;
	}

	const backupRoot = getNamedBackupRoot(getStoragePath());
	const requestedWithExtension = requested.toLowerCase().endsWith(".json")
		? requested
		: `${requested}.json`;

	try {
		const entries = await fs.readdir(backupRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || entry.isSymbolicLink()) continue;
			if (!entry.name.toLowerCase().endsWith(".json")) continue;
			if (
				!equalsNamedBackupEntry(entry.name, requested) &&
				!equalsNamedBackupEntry(entry.name, requestedWithExtension)
			) {
				continue;
			}
			return resolvePath(join(backupRoot, entry.name));
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to read named backup directory", {
				path: backupRoot,
				error: String(error),
			});
		}
	}

	return undefined;
}

async function resolveNamedBackupRestorePath(name: string): Promise<string> {
	const existingPath = await findExistingNamedBackupPath(name);
	if (existingPath) {
		return existingPath;
	}
	return buildNamedBackupPath(name);
}

async function loadAccountsFromJournal(
	path: string,
): Promise<AccountStorageV3 | null> {
	const walPath = getAccountsWalPath(path);
	const resetMarkerPath = getIntentionalResetMarkerPath(path);
	if (existsSync(resetMarkerPath)) {
		return null;
	}
	try {
		const raw = await fs.readFile(walPath, "utf-8");
		if (existsSync(resetMarkerPath)) {
			return null;
		}
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

async function loadAccountsInternal(
	persistMigration: ((storage: AccountStorageV3) => Promise<void>) | null,
): Promise<AccountStorageV3 | null> {
	const path = getStoragePath();
	const resetMarkerPath = getIntentionalResetMarkerPath(path);
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

		if (existsSync(resetMarkerPath)) {
			return createEmptyStorageWithMetadata(false, "intentional-reset");
		}

		if (normalized && normalized.accounts.length === 0) {
			return withRestoreMetadata(normalized, true, "empty-storage");
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
		if (existsSync(resetMarkerPath)) {
			return createEmptyStorageWithMetadata(false, "intentional-reset");
		}
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
		if (existsSync(resetMarkerPath)) {
			return createEmptyStorageWithMetadata(false, "intentional-reset");
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
		if (code === "ENOENT") {
			return createEmptyStorageWithMetadata(true, "missing-storage");
		}
		return null;
	}
}

async function buildNamedBackupMetadata(
	name: string,
	path: string,
	opts: { candidate?: Awaited<ReturnType<typeof loadBackupCandidate>> } = {},
): Promise<NamedBackupMetadata> {
	const candidate = opts.candidate ?? (await loadBackupCandidate(path));
	let stats: {
		size?: number;
		mtimeMs?: number;
		birthtimeMs?: number;
		ctimeMs?: number;
	} | null = null;
	try {
		stats = await fs.stat(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Failed to stat named backup", { path, error: String(error) });
		}
	}

	const version =
		candidate.normalized?.version ??
		(typeof candidate.storedVersion === "number"
			? candidate.storedVersion
			: null);
	const accountCount = candidate.normalized?.accounts.length ?? null;
	const createdAt = stats?.birthtimeMs ?? stats?.ctimeMs ?? null;
	const updatedAt = stats?.mtimeMs ?? null;

	return {
		name,
		path,
		createdAt,
		updatedAt,
		sizeBytes: typeof stats?.size === "number" ? stats.size : null,
		version,
		accountCount,
		schemaErrors: candidate.schemaErrors,
		valid: !!candidate.normalized,
		loadError: candidate.error,
	};
}

async function saveAccountsUnlocked(storage: AccountStorageV3): Promise<void> {
	const path = getStoragePath();
	const resetMarkerPath = getIntentionalResetMarkerPath(path);
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

		await renameFileWithRetry(tempPath, path);
		try {
			await fs.unlink(resetMarkerPath);
		} catch {
			// Best effort cleanup.
		}
		lastAccountsSaveTimestamp = Date.now();
		try {
			await fs.unlink(walPath);
		} catch {
			// Best effort cleanup.
		}
		return;
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

function cloneAccountStorageForPersistence(
	storage: AccountStorageV3 | null | undefined,
): AccountStorageV3 {
	return {
		version: 3,
		accounts: structuredClone(storage?.accounts ?? []),
		activeIndex:
			typeof storage?.activeIndex === "number" &&
			Number.isFinite(storage.activeIndex)
				? storage.activeIndex
				: 0,
		activeIndexByFamily: structuredClone(storage?.activeIndexByFamily ?? {}),
	};
}

export async function withAccountStorageTransaction<T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (storage: AccountStorageV3) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return withStorageLock(async () => {
		const storagePath = getStoragePath();
		const state = {
			snapshot: await loadAccountsInternal(saveAccountsUnlocked),
			active: true,
			storagePath,
		};
		const current = state.snapshot;
		const persist = async (storage: AccountStorageV3): Promise<void> => {
			await saveAccountsUnlocked(storage);
			state.snapshot = storage;
		};
		return transactionSnapshotContext.run(state, () =>
			handler(current, persist),
		);
	});
}

export async function withAccountAndFlaggedStorageTransaction<T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (
			accountStorage: AccountStorageV3,
			flaggedStorage: FlaggedAccountStorageV1,
		) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return withStorageLock(async () => {
		const storagePath = getStoragePath();
		const state = {
			snapshot: await loadAccountsInternal(saveAccountsUnlocked),
			active: true,
			storagePath,
		};
		const current = state.snapshot;
		const persist = async (
			accountStorage: AccountStorageV3,
			flaggedStorage: FlaggedAccountStorageV1,
		): Promise<void> => {
			const previousAccounts = cloneAccountStorageForPersistence(state.snapshot);
			const nextAccounts = cloneAccountStorageForPersistence(accountStorage);
			await saveAccountsUnlocked(nextAccounts);
			try {
				await saveFlaggedAccountsUnlocked(flaggedStorage);
				state.snapshot = nextAccounts;
			} catch (error) {
				try {
					await saveAccountsUnlocked(previousAccounts);
					state.snapshot = previousAccounts;
				} catch (rollbackError) {
					const combinedError = new AggregateError(
						[error, rollbackError],
						"Flagged save failed and account storage rollback also failed",
					);
					log.error(
						"Failed to rollback account storage after flagged save failure",
						{
							error: String(error),
							rollbackError: String(rollbackError),
						},
					);
					throw combinedError;
				}
				throw error;
			}
		};
		return transactionSnapshotContext.run(state, () =>
			handler(current, persist),
		);
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
export async function clearAccounts(): Promise<boolean> {
	return withStorageLock(async () => {
		const path = getStoragePath();
		const resetMarkerPath = getIntentionalResetMarkerPath(path);
		const walPath = getAccountsWalPath(path);
		const backupPaths =
			await getAccountsBackupRecoveryCandidatesWithDiscovery(path);
		const legacyPaths = Array.from(
			new Set(
				[currentLegacyProjectStoragePath, currentLegacyWorktreeStoragePath].filter(
					(candidate): candidate is string =>
						typeof candidate === "string" && candidate.length > 0,
				),
			),
		);
		await fs.writeFile(
			resetMarkerPath,
			JSON.stringify({ version: 1, createdAt: Date.now() }),
			{ encoding: "utf-8", mode: 0o600 },
		);
		let hadError = false;
		const clearPath = async (targetPath: string): Promise<void> => {
			try {
				await unlinkWithRetry(targetPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					hadError = true;
					log.error("Failed to clear account storage artifact", {
						path: targetPath,
						error: String(error),
					});
				}
			}
		};

		try {
			const artifacts = Array.from(new Set([path, walPath, ...backupPaths, ...legacyPaths]));
			await Promise.all(artifacts.map(clearPath));
		} catch {
			// Individual path cleanup is already best-effort with per-artifact logging.
		}

		return !hadError;
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

export async function loadFlaggedAccounts(): Promise<FlaggedAccountStorageV1> {
	const path = getFlaggedAccountsPath();
	const resetMarkerPath = getIntentionalResetMarkerPath(path);
	const empty: FlaggedAccountStorageV1 = { version: 1, accounts: [] };

	try {
		const content = await fs.readFile(path, "utf-8");
		const data = JSON.parse(content) as unknown;
		const loaded = normalizeFlaggedStorage(data);
		if (existsSync(resetMarkerPath)) {
			return empty;
		}
		return loaded;
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

async function saveFlaggedAccountsUnlocked(
	storage: FlaggedAccountStorageV1,
): Promise<void> {
	const path = getFlaggedAccountsPath();
	const markerPath = getIntentionalResetMarkerPath(path);
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${path}.${uniqueSuffix}.tmp`;

	try {
		await fs.mkdir(dirname(path), { recursive: true });
		if (existsSync(path)) {
			try {
				await copyFileWithRetry(path, `${path}.bak`, {
					allowMissingSource: true,
				});
			} catch (backupError) {
				log.warn("Failed to create flagged backup snapshot", {
					path,
					error: String(backupError),
				});
			}
		}
		const content = JSON.stringify(normalizeFlaggedStorage(storage), null, 2);
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await renameFileWithRetry(tempPath, path);
		try {
			await fs.unlink(markerPath);
		} catch {
			// Best effort cleanup.
		}
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
}

export async function saveFlaggedAccounts(
	storage: FlaggedAccountStorageV1,
): Promise<void> {
	return withStorageLock(async () => {
		await saveFlaggedAccountsUnlocked(storage);
	});
}

export async function clearFlaggedAccounts(): Promise<boolean> {
	return withStorageLock(async () => {
		const path = getFlaggedAccountsPath();
		const markerPath = getIntentionalResetMarkerPath(path);
		try {
			await fs.writeFile(markerPath, "reset", {
				encoding: "utf-8",
				mode: 0o600,
			});
		} catch (error) {
			log.error("Failed to write flagged reset marker", {
				path,
				markerPath,
				error: String(error),
			});
			throw error;
		}
		const backupPaths =
			await getAccountsBackupRecoveryCandidatesWithDiscovery(path);
		let hadError = false;
		for (const candidate of [path, ...backupPaths]) {
			try {
				await unlinkWithRetry(candidate);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					hadError = true;
					log.error("Failed to clear flagged account storage", {
						path: candidate,
						error: String(error),
					});
				}
			}
		}
		if (!hadError) {
			try {
				await unlinkWithRetry(markerPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					log.error("Failed to clear flagged reset marker", {
						path,
						markerPath,
						error: String(error),
					});
					hadError = true;
				}
			}
		}
		return !hadError;
	});
}

/**
 * Exports current accounts to a JSON file for backup/migration.
 * @param filePath - Destination file path
 * @param force - If true, overwrite existing file (default: true)
 * @throws Error if file exists and force is false, or if no accounts to export
 */
export async function exportAccounts(
	filePath: string,
	force = true,
	beforeCommit?: (resolvedPath: string) => Promise<void> | void,
): Promise<void> {
	const resolvedPath = resolvePath(filePath);

	if (!force && existsSync(resolvedPath)) {
		throw new Error(`File already exists: ${resolvedPath}`);
	}

	const transactionState = transactionSnapshotContext.getStore();
	const currentStoragePath = getStoragePath();
	const storage =
		transactionState?.active &&
		transactionState.storagePath === currentStoragePath
		? transactionState.snapshot
		: await withAccountStorageTransaction((current) =>
				Promise.resolve(current),
			);
	if (!storage || storage.accounts.length === 0) {
		throw new Error("No accounts to export");
	}

	await fs.mkdir(dirname(resolvedPath), { recursive: true });
	await beforeCommit?.(resolvedPath);
	if (!force && existsSync(resolvedPath)) {
		throw new Error(`File already exists: ${resolvedPath}`);
	}

	const content = JSON.stringify(
		{
			version: storage.version,
			accounts: storage.accounts,
			activeIndex: storage.activeIndex,
			activeIndexByFamily: storage.activeIndexByFamily,
		},
		null,
		2,
	);
	await fs.writeFile(resolvedPath, content, { encoding: "utf-8", mode: 0o600 });
	log.info("Exported accounts", {
		path: resolvedPath,
		count: storage.accounts.length,
	});
}

/**
 * Imports accounts from a JSON file, merging with existing accounts.
 * Deduplicates by safe account identity, preserving most recently used entries.
 * @param filePath - Source file path
 * @throws Error if file is invalid or would exceed MAX_ACCOUNTS
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
			const deduped = deduplicateAccounts(merged);
			if (deduped.length > ACCOUNT_LIMITS.MAX_ACCOUNTS) {
				throw new Error(
					`Import would exceed maximum of ${ACCOUNT_LIMITS.MAX_ACCOUNTS} accounts (would have ${deduped.length})`,
				);
			}
		}

		const deduplicatedAccounts = deduplicateAccounts(merged);

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
