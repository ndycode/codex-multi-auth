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
import { clearAccountStorageArtifacts } from "./storage/account-clear.js";
import { clearAccountsEntry } from "./storage/account-clear-entry.js";
import { cloneAccountStorageForPersistence } from "./storage/account-persistence.js";
import {
	exportAccountsSnapshot,
	importAccountsSnapshot,
} from "./storage/account-port.js";
import { saveAccountsToDisk } from "./storage/account-save.js";
import { saveAccountsEntry } from "./storage/account-save-entry.js";
import { buildBackupMetadata } from "./storage/backup-metadata-builder.js";
import {
	ACCOUNTS_BACKUP_SUFFIX,
	ACCOUNTS_WAL_SUFFIX,
	getAccountsBackupPath,
	getAccountsBackupRecoveryCandidates,
	getAccountsWalPath,
	getIntentionalResetMarkerPath,
	RESET_MARKER_SUFFIX,
} from "./storage/backup-paths.js";
import { restoreAccountsFromBackupPath } from "./storage/backup-restore.js";
import { looksLikeSyntheticFixtureStorage } from "./storage/fixture-guards.js";
import { clearFlaggedAccountsEntry } from "./storage/flagged-entry.js";
import { loadFlaggedAccountsEntry } from "./storage/flagged-load-entry.js";
import { saveFlaggedAccountsEntry } from "./storage/flagged-save-entry.js";
import { normalizeFlaggedStorage } from "./storage/flagged-storage.js";
import {
	clearFlaggedAccountsOnDisk,
	loadFlaggedAccountsState,
	saveFlaggedAccountsUnlockedToDisk,
} from "./storage/flagged-storage-io.js";
import { ensureCodexGitignoreEntry } from "./storage/gitignore.js";
import {
	exportAccountsToFile,
	mergeImportedAccounts,
	readImportFile,
} from "./storage/import-export.js";
import { buildMetadataSection } from "./storage/metadata-section.js";
import {
	type AccountMetadataV1,
	type AccountMetadataV3,
	type AccountStorageV1,
	type AccountStorageV3,
	type CooldownReason,
	migrateV1ToV3,
	type RateLimitStateV3,
} from "./storage/migrations.js";
import { exportNamedBackupEntry } from "./storage/named-backup-entry.js";
import {
	collectNamedBackups,
	type NamedBackupSummary,
} from "./storage/named-backups.js";
import {
	findProjectRoot,
	getConfigDir,
	getProjectConfigDir,
	getProjectGlobalConfigDir,
	resolvePath,
	resolveProjectStorageIdentityRoot,
} from "./storage/paths.js";
import {
	loadNormalizedStorageFromPath,
	mergeStorageForMigration,
} from "./storage/project-migration.js";
import { buildRestoreAssessment } from "./storage/restore-assessment.js";
import { restoreAccountsFromBackupEntry } from "./storage/restore-backup-entry.js";
import {
	loadAccountsFromPath,
	parseAndNormalizeStorage,
} from "./storage/storage-parser.js";
import {
	getTransactionSnapshotState,
	withAccountAndFlaggedStorageTransaction as runWithAccountAndFlaggedStorageTransaction,
	withAccountStorageTransaction as runWithAccountStorageTransaction,
	withStorageLock,
} from "./storage/transactions.js";

export type {
	CooldownReason,
	RateLimitStateV3,
	AccountMetadataV1,
	AccountStorageV1,
	AccountMetadataV3,
	AccountStorageV3,
	NamedBackupSummary,
};

const log = createLogger("storage");
const ACCOUNTS_FILE_NAME = "openai-codex-accounts.json";
const FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-flagged-accounts.json";
const LEGACY_FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-blocked-accounts.json";
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

type AnyAccountStorage = AccountStorageV1 | AccountStorageV3;

type AccountLike = {
	accountId?: string;
	email?: string;
	refreshToken?: string;
	addedAt?: number;
	lastUsed?: number;
};

async function ensureGitignore(storagePath: string): Promise<void> {
	const state = getStoragePathState();
	if (!state.currentStoragePath) return;
	await ensureCodexGitignoreEntry({
		storagePath,
		currentProjectRoot: state.currentProjectRoot,
		logDebug: (message, details) => {
			log.debug(message, details);
		},
		logWarn: (message, details) => {
			log.warn(message, details);
		},
	});
}

type StoragePathState = {
	currentStoragePath: string | null;
	currentLegacyProjectStoragePath: string | null;
	currentLegacyWorktreeStoragePath: string | null;
	currentProjectRoot: string | null;
};

let currentStorageState: StoragePathState = {
	currentStoragePath: null,
	currentLegacyProjectStoragePath: null,
	currentLegacyWorktreeStoragePath: null,
	currentProjectRoot: null,
};

const storagePathStateContext = new AsyncLocalStorage<StoragePathState>();

function getStoragePathState(): StoragePathState {
	return storagePathStateContext.getStore() ?? currentStorageState;
}

function setStoragePathState(state: StoragePathState): void {
	currentStorageState = state;
	storagePathStateContext.enterWith(state);
}

export function setStorageBackupEnabled(enabled: boolean): void {
	storageBackupEnabled = enabled;
}

async function getAccountsBackupRecoveryCandidatesWithDiscovery(
	path: string,
): Promise<string[]> {
	const knownCandidates = getAccountsBackupRecoveryCandidates(
		path,
		ACCOUNTS_BACKUP_HISTORY_DEPTH,
	);
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
	const candidates = getAccountsBackupRecoveryCandidates(
		path,
		ACCOUNTS_BACKUP_HISTORY_DEPTH,
	);
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
			await loadAccountsFromPath(path, {
				normalizeAccountStorage,
				isRecord,
			});
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
			parseAndNormalizeStorage(
				JSON.parse(entry.content) as unknown,
				normalizeAccountStorage,
				isRecord,
			);
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
	return normalizeFlaggedStorage(data, {
		isRecord,
		now: () => Date.now(),
	});
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
		setStoragePathState({
			currentStoragePath: null,
			currentLegacyProjectStoragePath: null,
			currentLegacyWorktreeStoragePath: null,
			currentProjectRoot: null,
		});
		return;
	}

	const projectRoot = findProjectRoot(projectPath);
	if (projectRoot) {
		const identityRoot = resolveProjectStorageIdentityRoot(projectRoot);
		const currentStoragePath = join(
			getProjectGlobalConfigDir(identityRoot),
			ACCOUNTS_FILE_NAME,
		);
		const currentLegacyProjectStoragePath = join(
			getProjectConfigDir(projectRoot),
			ACCOUNTS_FILE_NAME,
		);
		const previousWorktreeScopedPath = join(
			getProjectGlobalConfigDir(projectRoot),
			ACCOUNTS_FILE_NAME,
		);
		const currentLegacyWorktreeStoragePath =
			previousWorktreeScopedPath !== currentStoragePath
				? previousWorktreeScopedPath
				: null;
		setStoragePathState({
			currentStoragePath,
			currentLegacyProjectStoragePath,
			currentLegacyWorktreeStoragePath,
			currentProjectRoot: projectRoot,
		});
	} else {
		setStoragePathState({
			currentStoragePath: null,
			currentLegacyProjectStoragePath: null,
			currentLegacyWorktreeStoragePath: null,
			currentProjectRoot: null,
		});
	}
}

export function setStoragePathDirect(path: string | null): void {
	setStoragePathState({
		currentStoragePath: path,
		currentLegacyProjectStoragePath: null,
		currentLegacyWorktreeStoragePath: null,
		currentProjectRoot: null,
	});
}

/**
 * Returns the file path for the account storage JSON file.
 * @returns Absolute path to the accounts.json file
 */
export function getStoragePath(): string {
	const state = getStoragePathState();
	if (state.currentStoragePath) {
		return state.currentStoragePath;
	}
	return join(getConfigDir(), ACCOUNTS_FILE_NAME);
}

export function buildNamedBackupPath(name: string): string {
	return resolveNamedBackupPath(name, getStoragePath());
}

export async function getNamedBackups(): Promise<NamedBackupSummary[]> {
	return collectNamedBackups(getStoragePath(), {
		loadAccountsFromPath: (path) =>
			loadAccountsFromPath(path, {
				normalizeAccountStorage,
				isRecord,
			}),
		logDebug: (message, details) => {
			log.debug(message, details);
		},
	});
}

export async function restoreAccountsFromBackup(
	path: string,
	options?: { persist?: boolean },
): Promise<AccountStorageV3> {
	return restoreAccountsFromBackupEntry({
		path,
		options,
		restoreAccountsFromBackupPath,
		getNamedBackupRoot,
		getStoragePath,
		realpath: fs.realpath,
		loadAccountsFromPath: (path) =>
			loadAccountsFromPath(path, {
				normalizeAccountStorage,
				isRecord,
			}),
		saveAccounts,
	});
}

export async function exportNamedBackup(
	name: string,
	options?: { force?: boolean },
): Promise<string> {
	return exportNamedBackupEntry({
		name,
		options,
		exportNamedBackupFile,
		getStoragePath,
		exportAccounts,
	});
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
	const state = getStoragePathState();
	if (!state.currentStoragePath) {
		return null;
	}

	const candidatePaths = [
		state.currentLegacyWorktreeStoragePath,
		state.currentLegacyProjectStoragePath,
	]
		.filter(
			(path): path is string =>
				typeof path === "string" &&
				path.length > 0 &&
				path !== state.currentStoragePath,
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
		state.currentStoragePath,
		"current account storage",
		{
			loadAccountsFromPath: (path) =>
				loadAccountsFromPath(path, {
					normalizeAccountStorage,
					isRecord,
				}),
			logWarn: (message, details) => {
				log.warn(message, details);
			},
		},
	);
	let migrated = false;

	for (const legacyPath of existingCandidatePaths) {
		const legacyStorage = await loadNormalizedStorageFromPath(
			legacyPath,
			"legacy account storage",
			{
				loadAccountsFromPath: (path) =>
					loadAccountsFromPath(path, {
						normalizeAccountStorage,
						isRecord,
					}),
				logWarn: (message, details) => {
					log.warn(message, details);
				},
			},
		);
		if (!legacyStorage) {
			continue;
		}

		const mergedStorage = mergeStorageForMigration(
			targetStorage,
			legacyStorage,
			normalizeAccountStorage,
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
				to: state.currentStoragePath,
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
			to: state.currentStoragePath,
			accounts: mergedStorage.accounts.length,
		});
	}

	if (migrated) {
		return targetStorage;
	}
	if (targetStorage && !existsSync(state.currentStoragePath)) {
		return targetStorage;
	}
	return null;
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
		const newest: T = selectNewestAccount(
			matchingAccount ?? undefined,
			account,
		);
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
	const flaggedPath = getFlaggedAccountsPath();
	return buildBackupMetadata({
		storagePath,
		flaggedPath,
		walPath: getAccountsWalPath(storagePath),
		getAccountsBackupRecoveryCandidatesWithDiscovery,
		describeAccountSnapshot,
		describeAccountsWalSnapshot,
		describeFlaggedSnapshot,
		buildMetadataSection,
	});
}

export async function getRestoreAssessment(): Promise<RestoreAssessment> {
	const storagePath = getStoragePath();
	const resetMarkerPath = getIntentionalResetMarkerPath(storagePath);
	const backupMetadata = await getBackupMetadata();
	return buildRestoreAssessment({
		storagePath,
		backupMetadata,
		hasResetMarker: existsSync(resetMarkerPath),
	});
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
		const { normalized } = parseAndNormalizeStorage(
			data,
			normalizeAccountStorage,
			isRecord,
		);
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
			await loadAccountsFromPath(path, {
				normalizeAccountStorage,
				isRecord,
			});
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
					const backup = await loadAccountsFromPath(backupPath, {
						normalizeAccountStorage,
						isRecord,
					});
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
					const backup = await loadAccountsFromPath(backupPath, {
						normalizeAccountStorage,
						isRecord,
					});
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

async function saveAccountsUnlocked(storage: AccountStorageV3): Promise<void> {
	const path = getStoragePath();
	const resetMarkerPath = getIntentionalResetMarkerPath(path);
	const walPath = getAccountsWalPath(path);
	return saveAccountsToDisk(storage, {
		path,
		resetMarkerPath,
		walPath,
		storageBackupEnabled: storageBackupEnabled && existsSync(path),
		ensureDirectory: async () => {
			await fs.mkdir(dirname(path), { recursive: true });
		},
		ensureGitignore: () => ensureGitignore(path),
		looksLikeSyntheticFixtureStorage,
		loadExistingStorage: () =>
			loadNormalizedStorageFromPath(path, "existing account storage", {
				loadAccountsFromPath: (candidatePath) =>
					loadAccountsFromPath(candidatePath, {
						normalizeAccountStorage,
						isRecord,
					}),
				logWarn: (message, details) => {
					log.warn(message, details);
				},
			}),
		createSyntheticFixtureError: () =>
			new StorageError(
				"Refusing to overwrite non-synthetic account storage with synthetic fixture payload",
				"EINVALID",
				path,
				"Detected synthetic fixture-like account payload. Use explicit account import/login commands instead.",
			),
		createRotatingAccountsBackup,
		computeSha256,
		writeJournal: async (content: string, journalPath: string) => {
			const journalEntry: AccountsJournalEntry = {
				version: 1,
				createdAt: Date.now(),
				path: journalPath,
				checksum: computeSha256(content),
				content,
			};
			await fs.writeFile(walPath, JSON.stringify(journalEntry), {
				encoding: "utf-8",
				mode: 0o600,
			});
		},
		writeTemp: (tempPath: string, content: string) =>
			fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 }),
		statTemp: (tempPath: string) => fs.stat(tempPath),
		renameTempToPath: async (tempPath: string) => {
			let lastError: NodeJS.ErrnoException | null = null;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					await fs.rename(tempPath, path);
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
		},
		cleanupResetMarker: async () => {
			try {
				await fs.unlink(resetMarkerPath);
			} catch {
				// Best effort cleanup.
			}
		},
		cleanupWal: async () => {
			try {
				await fs.unlink(walPath);
			} catch {
				// Best effort cleanup.
			}
		},
		cleanupTemp: async (tempPath: string) => {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Ignore cleanup failure.
			}
		},
		onSaved: () => {
			lastAccountsSaveTimestamp = Date.now();
		},
		logWarn: (message: string, details: Record<string, unknown>) => {
			log.warn(message, details);
		},
		logError: (message: string, details: Record<string, unknown>) => {
			log.error(message, details);
		},
		createStorageError: (error: unknown) => {
			const err = error as NodeJS.ErrnoException;
			const code = err?.code || "UNKNOWN";
			const hint = formatStorageErrorHint(error, path);
			return new StorageError(
				`Failed to save accounts: ${err?.message || "Unknown error"}`,
				code,
				path,
				hint,
				err instanceof Error ? err : undefined,
			);
		},
		backupPath: getAccountsBackupPath(path),
		createTempPath: () =>
			`${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
	});
}

export async function withAccountStorageTransaction<T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (storage: AccountStorageV3) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return runWithAccountStorageTransaction(handler, {
		getStoragePath,
		loadCurrent: () => loadAccountsInternal(saveAccountsUnlocked),
		saveAccounts: saveAccountsUnlocked,
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
	return runWithAccountAndFlaggedStorageTransaction(handler, {
		getStoragePath,
		loadCurrent: () => loadAccountsInternal(saveAccountsUnlocked),
		saveAccounts: saveAccountsUnlocked,
		saveFlaggedAccounts: saveFlaggedAccountsUnlocked,
		cloneAccountStorageForPersistence,
		logRollbackError: (error, rollbackError) => {
			log.error(
				"Failed to rollback account storage after flagged save failure",
				{
					error: String(error),
					rollbackError: String(rollbackError),
				},
			);
		},
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
	return saveAccountsEntry({
		storage,
		withStorageLock,
		saveUnlocked: saveAccountsUnlocked,
	});
}

/**
 * Deletes the account storage file from disk.
 * Silently ignores if file doesn't exist.
 */
export async function clearAccounts(): Promise<void> {
	const path = getStoragePath();
	return clearAccountsEntry({
		path,
		withStorageLock,
		resetMarkerPath: getIntentionalResetMarkerPath(path),
		walPath: getAccountsWalPath(path),
		getBackupPaths: () =>
			getAccountsBackupRecoveryCandidatesWithDiscovery(path),
		clearAccountStorageArtifacts,
		logError: (message: string, details: Record<string, unknown>) => {
			log.error(message, details);
		},
	});
}

export async function loadFlaggedAccounts(): Promise<FlaggedAccountStorageV1> {
	return loadFlaggedAccountsEntry({
		getFlaggedAccountsPath,
		getLegacyFlaggedAccountsPath,
		getIntentionalResetMarkerPath,
		normalizeFlaggedStorage: (data) =>
			normalizeFlaggedStorage(data, {
				isRecord,
				now: () => Date.now(),
			}),
		saveFlaggedAccounts,
		loadFlaggedAccountsState,
		logError: (message, details) => {
			log.error(message, details);
		},
		logInfo: (message, details) => {
			log.info(message, details);
		},
	});
}

async function saveFlaggedAccountsUnlocked(
	storage: FlaggedAccountStorageV1,
): Promise<void> {
	const path = getFlaggedAccountsPath();
	return saveFlaggedAccountsUnlockedToDisk(storage, {
		path,
		markerPath: getIntentionalResetMarkerPath(path),
		normalizeFlaggedStorage: (data) =>
			normalizeFlaggedStorage(data, {
				isRecord,
				now: () => Date.now(),
			}),
		copyFileWithRetry,
		renameFileWithRetry,
		logWarn: (message, details) => {
			log.warn(message, details);
		},
		logError: (message, details) => {
			log.error(message, details);
		},
	});
}

export async function saveFlaggedAccounts(
	storage: FlaggedAccountStorageV1,
): Promise<void> {
	return saveFlaggedAccountsEntry({
		storage,
		withStorageLock,
		saveUnlocked: saveFlaggedAccountsUnlocked,
	});
}

export async function clearFlaggedAccounts(): Promise<void> {
	const path = getFlaggedAccountsPath();
	return clearFlaggedAccountsEntry({
		path,
		withStorageLock,
		markerPath: getIntentionalResetMarkerPath(path),
		getBackupPaths: () =>
			getAccountsBackupRecoveryCandidatesWithDiscovery(path),
		clearFlaggedAccountsOnDisk,
		logError: (message, details) => {
			log.error(message, details);
		},
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
	const currentStoragePath = getStoragePath();
	await exportAccountsSnapshot({
		resolvedPath,
		force,
		currentStoragePath,
		transactionState: getTransactionSnapshotState(),
		loadAccountsInternal: () => loadAccountsInternal(saveAccountsUnlocked),
		readCurrentStorage: () =>
			withAccountStorageTransaction((current) => Promise.resolve(current)),
		exportAccountsToFile,
		beforeCommit,
		logInfo: (message, details) => {
			log.info(message, details);
		},
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
	return importAccountsSnapshot({
		resolvedPath,
		readImportFile,
		normalizeAccountStorage,
		withAccountStorageTransaction,
		mergeImportedAccounts,
		maxAccounts: ACCOUNT_LIMITS.MAX_ACCOUNTS,
		deduplicateAccounts,
		logInfo: (message, details) => {
			log.info(message, details);
		},
	});
}
