import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { ACCOUNT_LIMITS } from "./constants.js";
import { StorageError } from "./errors.js";
import { createLogger } from "./logger.js";
import {
	exportNamedBackupFile,
	getNamedBackupRoot,
	resolveNamedBackupPath,
} from "./named-backup-export.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import { AnyAccountStorageSchema, getValidationErrors } from "./schemas.js";

import { formatStorageErrorHint } from "./storage/error-hints.js";

export { StorageError } from "./errors.js";
export { formatStorageErrorHint } from "./storage/error-hints.js";
export {
	getAccountIdentityKey,
	normalizeEmailKey,
} from "./storage/identity.js";

import { normalizeEmailKey } from "./storage/identity.js";
import {
	ACCOUNTS_BACKUP_SUFFIX,
	ACCOUNTS_WAL_SUFFIX,
	getFlaggedAccountsPath as buildFlaggedAccountsPath,
	getAccountsBackupPath,
	getAccountsBackupRecoveryCandidates,
	getAccountsWalPath,
	getIntentionalResetMarkerPath,
	RESET_MARKER_SUFFIX,
} from "./storage/file-paths.js";
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

export interface NamedBackupSummary {
	path: string;
	fileName: string;
	accountCount: number;
	mtimeMs: number;
}

async function collectNamedBackups(
	storagePath: string,
): Promise<NamedBackupSummary[]> {
	const backupRoot = getNamedBackupRoot(storagePath);
	let entries: Array<{ isFile(): boolean; name: string }>;
	try {
		entries = await fs.readdir(backupRoot, {
			withFileTypes: true,
			encoding: "utf8",
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		throw error;
	}

	const candidates: NamedBackupSummary[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.toLowerCase().endsWith(".json")) continue;
		const candidatePath = join(backupRoot, entry.name);
		try {
			const statsBefore = await fs.stat(candidatePath);
			const { normalized } = await loadAccountsFromPath(candidatePath);
			if (!normalized || normalized.accounts.length === 0) continue;
			const statsAfter = await fs.stat(candidatePath).catch(() => null);
			if (statsAfter && statsAfter.mtimeMs !== statsBefore.mtimeMs) {
				log.debug(
					"backup file changed between stat and load, mtime may be stale",
					{
						candidatePath,
						fileName: entry.name,
						beforeMtimeMs: statsBefore.mtimeMs,
						afterMtimeMs: statsAfter.mtimeMs,
					},
				);
			}
			candidates.push({
				path: candidatePath,
				fileName: entry.name,
				accountCount: normalized.accounts.length,
				mtimeMs: statsBefore.mtimeMs,
			});
		} catch (error) {
			log.debug(
				"Skipping named backup candidate after loadAccountsFromPath/fs.stat failure",
				{
					candidatePath,
					fileName: entry.name,
					error:
						error instanceof Error
							? {
									message: error.message,
									stack: error.stack,
								}
							: String(error),
				},
			);
		}
	}

	candidates.sort((left, right) => {
		const mtimeDelta = right.mtimeMs - left.mtimeMs;
		if (mtimeDelta !== 0) return mtimeDelta;
		return left.fileName.localeCompare(right.fileName);
	});
	return candidates;
}

let storageMutex: Promise<void> = Promise.resolve();
const transactionSnapshotContext = new AsyncLocalStorage<{
	snapshot: AccountStorageV3 | null;
	storagePath: string;
	active: boolean;
}>();

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
	refreshToken?: string;
	addedAt?: number;
	lastUsed?: number;
};

type AccountIdentityRef = {
	accountId?: string;
	emailKey?: string;
	refreshToken?: string;
};

function normalizeAccountIdKey(
	accountId: string | undefined,
): string | undefined {
	if (!accountId) return undefined;
	const trimmed = accountId.trim();
	return trimmed || undefined;
}

function normalizeRefreshTokenKey(
	refreshToken: string | undefined,
): string | undefined {
	if (!refreshToken) return undefined;
	const trimmed = refreshToken.trim();
	return trimmed || undefined;
}

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
	const state = getStoragePathState();
	if (!state.currentStoragePath) return;

	const configDir = dirname(storagePath);
	const inferredProjectRoot = dirname(configDir);
	const candidateRoots = [state.currentProjectRoot, inferredProjectRoot].filter(
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
	return collectNamedBackups(getStoragePath());
}

export async function restoreAccountsFromBackup(
	path: string,
	options?: { persist?: boolean },
): Promise<AccountStorageV3> {
	const backupRoot = getNamedBackupRoot(getStoragePath());
	let resolvedBackupRoot: string;
	try {
		resolvedBackupRoot = await fs.realpath(backupRoot);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`Backup root does not exist: ${backupRoot}`);
		}
		throw error;
	}
	let resolvedBackupPath: string;
	try {
		resolvedBackupPath = await fs.realpath(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`Backup file no longer exists: ${path}`);
		}
		throw error;
	}
	const relativePath = relative(resolvedBackupRoot, resolvedBackupPath);
	const isInsideBackupRoot =
		relativePath.length > 0 &&
		!relativePath.startsWith("..") &&
		!isAbsolute(relativePath);
	if (!isInsideBackupRoot) {
		throw new Error(
			`Backup path must stay inside ${resolvedBackupRoot}: ${path}`,
		);
	}

	const { normalized } = await (async () => {
		try {
			return await loadAccountsFromPath(resolvedBackupPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				throw new Error(`Backup file no longer exists: ${path}`);
			}
			throw error;
		}
	})();
	if (!normalized || normalized.accounts.length === 0) {
		throw new Error(
			`Backup does not contain any accounts: ${resolvedBackupPath}`,
		);
	}
	if (options?.persist !== false) {
		await saveAccounts(normalized);
	}
	return normalized;
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
	return buildFlaggedAccountsPath(getStoragePath(), FLAGGED_ACCOUNTS_FILE_NAME);
}

function getLegacyFlaggedAccountsPath(): string {
	return buildFlaggedAccountsPath(
		getStoragePath(),
		LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
	);
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

function collectDistinctIdentityValues(
	values: Array<string | undefined>,
): Set<string> {
	const distinct = new Set<string>();
	for (const value of values) {
		if (value) distinct.add(value);
	}
	return distinct;
}

type AccountMatchOptions = {
	allowUniqueAccountIdFallbackWithoutEmail?: boolean;
};

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

		// Retry rename with exponential backoff for Windows EPERM/EBUSY
		let lastError: NodeJS.ErrnoException | null = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await fs.rename(tempPath, path);
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
			storagePath,
			active: true,
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
			storagePath,
			active: true,
		};
		const current = state.snapshot;
		const persist = async (
			accountStorage: AccountStorageV3,
			flaggedStorage: FlaggedAccountStorageV1,
		): Promise<void> => {
			const previousAccounts = cloneAccountStorageForPersistence(
				state.snapshot,
			);
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
export async function clearAccounts(): Promise<void> {
	return withStorageLock(async () => {
		const path = getStoragePath();
		const resetMarkerPath = getIntentionalResetMarkerPath(path);
		const walPath = getAccountsWalPath(path);
		const backupPaths =
			await getAccountsBackupRecoveryCandidatesWithDiscovery(path);
		await fs.writeFile(
			resetMarkerPath,
			JSON.stringify({ version: 1, createdAt: Date.now() }),
			{ encoding: "utf-8", mode: 0o600 },
		);
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
			value === "rate-limit" ||
			value === "initial" ||
			value === "rotation" ||
			value === "best" ||
			value === "restore";
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

export async function clearFlaggedAccounts(): Promise<void> {
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
		for (const candidate of [path, ...backupPaths, markerPath]) {
			try {
				await fs.unlink(candidate);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					log.error("Failed to clear flagged account storage", {
						path: candidate,
						error: String(error),
					});
					if (candidate === path) {
						throw error;
					}
				}
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
export async function exportAccounts(
	filePath: string,
	force = true,
	beforeCommit?: (resolvedPath: string) => Promise<void> | void,
): Promise<void> {
	const resolvedPath = resolvePath(filePath);
	const currentStoragePath = getStoragePath();

	if (!force && existsSync(resolvedPath)) {
		throw new Error(`File already exists: ${resolvedPath}`);
	}

	const transactionState = transactionSnapshotContext.getStore();
	const storage =
		transactionState?.active &&
		transactionState.storagePath === currentStoragePath
			? transactionState.snapshot
			: transactionState?.active
				? await loadAccountsInternal(saveAccountsUnlocked)
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
