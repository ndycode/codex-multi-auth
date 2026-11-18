import { existsSync, promises as fs, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ACCOUNT_LIMITS } from "./constants.js";
import { parseIntegerEnv } from "./env-parsing.js";
import { StorageError } from "./errors.js";
import { withFileOperationRetry, withRetry } from "./fs-retry.js";
import { createLogger } from "./logger.js";
import {
	exportNamedBackupFile,
	getNamedBackupRoot,
	resolveNamedBackupPath,
} from "./named-backup-export.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import { clearAccountStorageArtifacts } from "./storage/account-clear.js";
import { clearAccountsEntry } from "./storage/account-clear-entry.js";
import {
	collectDistinctIdentityValues,
	findNewestMatchingIndex as findNewestMatchingIndexByRef,
	selectNewestAccount,
} from "./storage/account-match-utils.js";
import { cloneAccountStorageForPersistence } from "./storage/account-persistence.js";
import {
	describeAccountSnapshot as describeAccountSnapshotWithDeps,
	statSnapshot as statSnapshotWithDeps,
} from "./storage/account-snapshot.js";
import {
	exportAccountsSnapshot,
	importAccountsSnapshot,
} from "./storage/account-port.js";
import { saveAccountsToDisk } from "./storage/account-save.js";
import { saveAccountsEntry } from "./storage/account-save-entry.js";
import { buildBackupMetadata } from "./storage/backup-metadata-builder.js";
import {
	type BackupMetadata,
	type BackupSnapshotKind,
	type BackupSnapshotMetadata,
	type RestoreAssessment,
	buildMetadataSection,
} from "./storage/backup-metadata.js";
import { isCacheLikeBackupArtifactName } from "./storage/cache-artifacts.js";
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
import { loadFlaggedAccountsFromFile } from "./storage/flagged-storage-file.js";
import { clearFlaggedAccountsEntry } from "./storage/flagged-entry.js";
import { loadFlaggedAccountsEntry } from "./storage/flagged-load-entry.js";
import { saveFlaggedAccountsEntry } from "./storage/flagged-save-entry.js";
import { normalizeFlaggedStorage } from "./storage/flagged-storage.js";
import {
	createStorageHealthSummary,
	type StorageHealthSummary,
} from "./storage/health.js";
import {
	clearFlaggedAccountsOnDisk,
	loadFlaggedAccountsState,
	saveFlaggedAccountsUnlockedToDisk,
} from "./storage/flagged-storage-io.js";
import { computeSha256 } from "./storage/hash.js";
import { ensureCodexGitignoreEntry } from "./storage/gitignore.js";
import {
	exportAccountsToFile,
	mergeImportedAccounts,
	readImportFile,
} from "./storage/import-export.js";
import { formatStorageErrorHint } from "./storage/error-hints.js";
import { tempFileNonce, tempPathFor } from "./temp-path.js";
export { StorageError } from "./errors.js";
export {
	formatStorageErrorHint,
	toStorageError,
} from "./storage/error-hints.js";
export {
	getAccountIdentityKey,
	normalizeEmailKey,
} from "./storage/identity.js";
import {
	type AccountIdentityRef,
	toAccountIdentityRef,
} from "./storage/identity.js";
import {
	getFlaggedAccountsPath as buildFlaggedAccountsPath,
	getLegacyFlaggedAccountsPath as buildLegacyFlaggedAccountsPath,
} from "./storage/file-paths.js";
import {
	type AccountStorageV1,
	migrateV1ToV3,
} from "./storage/migrations.js";
import type {
	AccountMetadataV3,
	AccountStorageV3,
	CooldownReason,
	FlaggedAccountMetadataV1,
	FlaggedAccountStorageV1,
	RateLimitStateV3,
} from "./storage/public-types.js";
import { exportNamedBackupEntry } from "./storage/named-backup-entry.js";
import {
	collectNamedBackups,
	type NamedBackupSummary,
} from "./storage/named-backups.js";
import { getNamedBackupsEntry } from "./storage/named-backups-entry.js";
import {
	getStoragePathState,
	setStoragePathDirectState,
	setStoragePathState,
} from "./storage/path-state.js";
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
import {
	AccountsJournalEntrySchema,
	AnyAccountStorageSchema,
	safeParseJson,
} from "./schemas.js";
import { clampIndex, isRecord } from "./storage/record-utils.js";
import { buildRestoreAssessment } from "./storage/restore-assessment.js";
import { restoreAccountsFromBackupEntry } from "./storage/restore-backup-entry.js";
import {
	createEmptyStorageWithRestoreMetadata as createEmptyStorageWithMetadata,
	withRestoreMetadata,
} from "./storage/restore-metadata.js";
import {
	loadAccountsFromPath,
	parseAndNormalizeStorage,
} from "./storage/storage-parser.js";
import {
	getTransactionSnapshotState,
	isStorageLockHeld,
	runInTransactionSnapshotContext,
	withAccountStorageTransaction as runWithAccountStorageTransaction,
	withStorageLock as withProcessStorageLock,
} from "./storage/transactions.js";
import { withFileTransactionLock } from "./storage/file-lock.js";
import { mergeAccountSnapshot } from "./storage/snapshot-merge.js";
import { applyPendingAuth, clearPendingAuth, prunePendingAuth, recordPendingAuth } from "./storage/pending-auth.js";
export { recordPendingAuth };
const loadedAccountSnapshots = new WeakMap<AccountStorageV3, AccountStorageV3>();

function withStorageLock<T>(action: () => Promise<T>): Promise<T> {
	const path = getStoragePath();
	return withProcessStorageLock(() => withFileTransactionLock(path, action));
}

export type {
	StorageHealthSummary,
	CooldownReason,
	RateLimitStateV3,
	AccountMetadataV3,
	AccountStorageV3,
	FlaggedAccountMetadataV1,
	FlaggedAccountStorageV1,
	BackupMetadata,
	RestoreAssessment,
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
/**
 * Default minimum age of the newest rotating `.bak` snapshot before a save
 * pays for another full 3-slot rotation. Rotating backups are crash-recovery
 * insurance, not a changelog: inside the window the primary-write path skips
 * ~6 fs ops and ~2x payload bytes of staged copies per save. A credential
 * change (account count or refresh-token set) still forces a fresh slot — a
 * backup that predates an in-window rotation can only offer spent tokens — a
 * missing `.bak` always rotates, and
 * `CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS=0` restores the legacy
 * rotate-on-every-save behavior.
 */
const ACCOUNTS_BACKUP_MIN_INTERVAL_DEFAULT_MS = 30_000;

function backupRotationMinIntervalMs(): number {
	const parsed = parseIntegerEnv(
		process.env.CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS,
	);
	if (parsed === undefined) {
		return ACCOUNTS_BACKUP_MIN_INTERVAL_DEFAULT_MS;
	}
	return Math.max(0, parsed);
}

/**
 * Fingerprint of the primary accounts file as last seen by THIS process — a
 * stat taken before a primary read (paired with the sha256 of the content
 * actually parsed, when available), or the temp-file stat and content hash
 * carried over our own atomic rename (recorded for free in `onSaved`).
 * Compared against the live primary on baseline-less saves to spot a foreign
 * write; keyed by path so a `setStoragePath*` switch can never borrow another
 * file's history.
 */
type PrimaryFileFingerprint = {
	mtimeMs?: number;
	ctimeMs?: number;
	size?: number;
	ino?: number;
	/** sha256 of the exact bytes read or written, when known. */
	sha256?: string;
};
const lastKnownPrimaryState = new Map<string, PrimaryFileFingerprint>();
const baselinelessSaveWarnedPaths = new Set<string>();

function notePrimaryState(
	path: string,
	stats:
		| { mtimeMs?: number; ctimeMs?: number; size?: number; ino?: number }
		| undefined,
	sha256?: string,
): void {
	if (!stats && sha256 === undefined) return;
	const fingerprint: PrimaryFileFingerprint = { sha256 };
	if (stats) {
		if (Number.isFinite(stats.mtimeMs)) fingerprint.mtimeMs = stats.mtimeMs;
		if (Number.isFinite(stats.ctimeMs)) fingerprint.ctimeMs = stats.ctimeMs;
		if (Number.isFinite(stats.size)) fingerprint.size = stats.size;
		// ino can exceed 2^53 on some filesystems; a lossy value would compare
		// equal for two different files, so only record exact integers.
		if (Number.isSafeInteger(stats.ino)) fingerprint.ino = stats.ino;
	}
	if (
		fingerprint.mtimeMs === undefined &&
		fingerprint.ctimeMs === undefined &&
		fingerprint.size === undefined &&
		fingerprint.ino === undefined &&
		fingerprint.sha256 === undefined
	) {
		return;
	}
	lastKnownPrimaryState.set(path, fingerprint);
}

/**
 * Metadata-only identity check, used when no content hash was recorded. A
 * foreign write bumps ctime on POSIX even when the writer preserves mtime
 * (utimes), and a rename-replacement changes ino — together they catch the
 * equal-mtime collisions a mtime-only comparison missed.
 */
function primaryFingerprintMatches(
	last: PrimaryFileFingerprint,
	stats: { mtimeMs: number; ctimeMs: number; size: number; ino: number },
): boolean {
	return (
		last.mtimeMs !== undefined &&
		last.ctimeMs !== undefined &&
		last.size !== undefined &&
		last.ino !== undefined &&
		last.mtimeMs === stats.mtimeMs &&
		last.ctimeMs === stats.ctimeMs &&
		last.size === stats.size &&
		last.ino === stats.ino
	);
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
	try {
		await withRetry(() => fs.copyFile(sourcePath, destinationPath), {
			maxAttempts: BACKUP_COPY_MAX_ATTEMPTS,
			backoffMs: (attempt) => BACKUP_COPY_BASE_DELAY_MS * 2 ** (attempt - 1),
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (allowMissingSource && code === "ENOENT") {
			return;
		}
		throw error;
	}
}

function renameFileWithRetry(
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	return withRetry(() => fs.rename(sourcePath, destinationPath), {
		maxAttempts: BACKUP_COPY_MAX_ATTEMPTS,
		backoffMs: (attempt) => BACKUP_COPY_BASE_DELAY_MS * 2 ** (attempt - 1),
		jitterMs: BACKUP_COPY_BASE_DELAY_MS,
	});
}

async function createRotatingAccountsBackup(path: string): Promise<void> {
	const candidates = getAccountsBackupRecoveryCandidates(
		path,
		ACCOUNTS_BACKUP_HISTORY_DEPTH,
	);
	const rotationNonce = tempFileNonce();
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
 * Credential-relevant shape of an account list for the throttle trigger:
 * entry count plus the set of refresh tokens. A write that changes either is
 * the case where the pre-write state earns a fresh backup slot even inside
 * the window — a rotated refresh token spends its predecessor upstream, so a
 * backup that predates several in-window rotations can only offer spent
 * credentials to recovery. Pure metadata churn (lastUsed, health fields)
 * still skips.
 */
type AccountCredentialSignature = {
	count: number;
	refreshTokens: Set<string>;
};

function credentialSignatureOf(
	accounts: readonly unknown[],
): AccountCredentialSignature {
	const refreshTokens = new Set<string>();
	for (const account of accounts) {
		if (
			isRecord(account) &&
			typeof account.refreshToken === "string" &&
			account.refreshToken.length > 0
		) {
			refreshTokens.add(account.refreshToken);
		}
	}
	return { count: accounts.length, refreshTokens };
}

function sameCredentialSignature(
	a: AccountCredentialSignature,
	b: AccountCredentialSignature,
): boolean {
	if (a.count !== b.count || a.refreshTokens.size !== b.refreshTokens.size) {
		return false;
	}
	for (const token of a.refreshTokens) {
		if (!b.refreshTokens.has(token)) return false;
	}
	return true;
}

/**
 * Cheap credential-signature probe for the throttle trigger. Reads and parses
 * only the top-level `accounts` shape — far cheaper than the staged copies a
 * rotation costs, and it runs at most once per save inside the throttle
 * window. Returns null when the signature cannot be determined so the caller
 * rotates rather than skipping a snapshot it cannot rule out.
 */
async function readOnDiskCredentialSignature(
	path: string,
): Promise<AccountCredentialSignature | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path, "utf-8"));
		if (isRecord(parsed) && Array.isArray(parsed.accounts)) {
			return credentialSignatureOf(parsed.accounts);
		}
	} catch {
		// Missing or unparsable primary: fall through to the null sentinel.
	}
	return null;
}

/**
 * Refresh tokens still present in a recovery source: rotating and discovered
 * `.bak*` snapshots plus any WAL journal payload. Pending rotated credentials
 * whose spent token a restore could still resurface must survive pruning, so
 * recovering a throttle-stale backup self-heals to the newest credential via
 * `applyPendingAuth` instead of reviving a token that was spent upstream.
 * Best-effort: unreadable or unparseable sources contribute nothing.
 */
async function collectRestorableRefreshTokens(path: string): Promise<string[]> {
	const tokens: string[] = [];
	const collectContent = (raw: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) return;
		for (const account of parsed.accounts) {
			if (
				isRecord(account) &&
				typeof account.refreshToken === "string" &&
				account.refreshToken.length > 0
			) {
				tokens.push(account.refreshToken);
			}
		}
	};
	for (const candidate of await getAccountsBackupRecoveryCandidatesWithDiscovery(
		path,
	)) {
		try {
			collectContent(await fs.readFile(candidate, "utf-8"));
		} catch {
			// An unreadable candidate contributes nothing.
		}
	}
	try {
		const walEntry: unknown = JSON.parse(
			await fs.readFile(getAccountsWalPath(path), "utf-8"),
		);
		if (isRecord(walEntry) && typeof walEntry.content === "string") {
			collectContent(walEntry.content);
		}
	} catch {
		// No usable WAL payload.
	}
	return tokens;
}

/**
 * Gate around `createRotatingAccountsBackup` that throttles rotation churn.
 * Rotates when the newest `.bak` is missing (always preserve at least one
 * recovery snapshot), when it is older than `backupRotationMinIntervalMs()`,
 * or when the incoming write changes the stored credential signature
 * (account count or refresh-token set) — the case where the pre-write state
 * is worth a fresh slot even inside the window.
 * `expectedOnDiskAccounts` lets callers that already read the primary under
 * the lock (the three-way merge path) skip the signature probe.
 */
async function rotateAccountsBackupIfDue(
	path: string,
	nextAccounts: readonly AccountMetadataV3[],
	expectedOnDiskAccounts: readonly AccountMetadataV3[] | null | undefined,
): Promise<void> {
	const latestBackupPath = getAccountsBackupPath(path);
	let newestBackupAgeMs: number | null = null;
	try {
		newestBackupAgeMs = Date.now() - (await fs.stat(latestBackupPath)).mtimeMs;
	} catch {
		// Missing or unreadable newest backup: rotate so >=1 snapshot exists.
		newestBackupAgeMs = null;
	}
	const minIntervalMs = backupRotationMinIntervalMs();
	// Age is clamped at 0: a backup whose mtime lands fractionally ahead of
	// Date.now() (fs timestamp granularity vs. the clock) is "fresh", and the
	// clamp also keeps `minIntervalMs = 0` meaning "always rotate".
	if (newestBackupAgeMs !== null && Math.max(0, newestBackupAgeMs) < minIntervalMs) {
		const onDiskSignature = expectedOnDiskAccounts !== undefined
			? credentialSignatureOf(expectedOnDiskAccounts ?? [])
			: await readOnDiskCredentialSignature(path);
		if (
			onDiskSignature !== null &&
			sameCredentialSignature(
				onDiskSignature,
				credentialSignatureOf(nextAccounts),
			)
		) {
			log.debug("Skipping account backup rotation inside throttle window", {
				path,
				backupPath: latestBackupPath,
				newestBackupAgeMs,
				minIntervalMs,
			});
			return;
		}
	}
	await createRotatingAccountsBackup(path);
}

/**
 * Warn (once per storage path per process) when a save without a merge
 * baseline is about to overwrite a primary this process did not last read or
 * write — the cheap signature of "concurrent modification, no baseline"
 * (last-writer-wins). The WeakMap baseline in `saveAccounts` cannot attach to
 * raw `structuredClone` copies, so this is the residual guard for untracked
 * objects. First-ever saves (no primary), empty primaries, and files whose
 * content (or full stat tuple, when no hash was recorded) matches our last
 * read/write stay quiet; the write is never blocked.
 */
async function warnOnBaselinelessSave(path: string): Promise<void> {
	if (baselinelessSaveWarnedPaths.has(path)) return;
	// No primary on disk (or an unreadable one): nothing exists to silently
	// lose, so the first-ever save stays quiet.
	const stats = await fs.stat(path).catch(() => undefined);
	if (!stats?.isFile() || stats.size === 0) return;
	const last = lastKnownPrimaryState.get(path);
	if (last !== undefined) {
		if (last.sha256 !== undefined) {
			// Content-exact check: identical bytes mean nothing was lost to a
			// foreign write regardless of timestamp granularity or an mtime-
			// preserving writer, and different bytes mean one landed even when
			// every stat field coincidentally matches.
			const currentSha256 = await fs
				.readFile(path, "utf-8")
				.then((raw) => computeSha256(raw))
				.catch(() => undefined);
			if (currentSha256 !== undefined) {
				if (currentSha256 === last.sha256) return;
			} else if (primaryFingerprintMatches(last, stats)) {
				// Content unreadable mid-check: fall back to the metadata tuple.
				return;
			}
		} else if (primaryFingerprintMatches(last, stats)) {
			return;
		}
	}
	baselinelessSaveWarnedPaths.add(path);
	const message =
		"Saving account storage without a merge baseline over a primary file this process did not last read or write; a concurrent writer's changes may be overwritten (last-writer-wins). Load via loadAccounts() or clone via cloneTrackedAccountStorage() so the three-way merge can run.";
	log.warn("Baseline-less account save over externally modified primary", {
		path,
	});
	process.emitWarning(message, {
		code: "CODEX_MULTI_AUTH_BASELINELESS_SAVE",
	});
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

async function statSnapshot(path: string): Promise<{
	exists: boolean;
	bytes?: number;
	mtimeMs?: number;
}> {
	return statSnapshotWithDeps(path, {
		stat: fs.stat,
		logWarn: (message, meta) => log.warn(message, meta),
	});
}

async function describeAccountSnapshot(
	path: string,
	kind: BackupSnapshotKind,
	index?: number,
): Promise<BackupSnapshotMetadata> {
	return describeAccountSnapshotWithDeps(path, kind, {
		index,
		statSnapshot,
		loadAccountsFromPath: (targetPath) =>
			loadAccountsFromPath(targetPath, {
				normalizeAccountStorage,
				isRecord,
			}),
		logWarn: (message, meta) => log.warn(message, meta),
	});
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
		const entry = safeParseJson(
			raw,
			AccountsJournalEntrySchema,
			"storage.describeAccountsWalSnapshot",
		);
		if (!entry || computeSha256(entry.content) !== entry.checksum) {
			return {
				kind: "accounts-wal",
				path,
				exists: true,
				valid: false,
				bytes: stats.bytes,
				mtimeMs: stats.mtimeMs,
			};
		}
		const innerPayload = safeParseJson(
			entry.content,
			AnyAccountStorageSchema,
			"storage.describeAccountsWalSnapshot.content",
		);
		// Schema-invalid inner payloads still flow through the TS normalizer
		// so schemaErrors stay populated for observability; fail-closed on
		// JSON syntax errors only.
		let innerData: unknown;
		if (innerPayload !== null) {
			innerData = innerPayload;
		} else {
			try {
				innerData = JSON.parse(entry.content) as unknown;
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
		const { normalized, storedVersion, schemaErrors } =
			parseAndNormalizeStorage(innerData, normalizeAccountStorage, isRecord);
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
	return loadFlaggedAccountsFromFile(path, {
		readFile: fs.readFile,
		normalizeFlaggedStorage: (data) =>
			normalizeFlaggedStorage(data, {
				isRecord,
				now: () => Date.now(),
			}),
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
	setStoragePathDirectState({
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
	return getNamedBackupsEntry({
		getStoragePath,
		collectNamedBackups,
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
		saveAccounts: async (storage) => {
			// An explicit restore is a deliberate overwrite of the current
			// primary, like the crash-recovery persists: record the file being
			// replaced so the baseline-less-save guard neither misreports it as
			// a foreign write nor spends the once-per-path warning on it.
			notePrimaryState(
				getStoragePath(),
				await fs.stat(getStoragePath()).catch(() => undefined),
			);
			await saveAccounts(storage);
		},
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
	return buildFlaggedAccountsPath(getStoragePath(), FLAGGED_ACCOUNTS_FILE_NAME);
}

function getLegacyFlaggedAccountsPath(): string {
	return buildLegacyFlaggedAccountsPath(
		getStoragePath(),
		LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
	);
}

async function migrateLegacyProjectStorageIfNeeded(options?: {
	persist?: (storage: AccountStorageV3) => Promise<void>;
	commit?: boolean;
}): Promise<AccountStorageV3 | null> {
	const persist = options?.persist ?? saveAccounts;
	const commit = options?.commit ?? true;
	const state = getStoragePathState();
	if (!state.currentStoragePath) {
		return null;
	}
	const currentStoragePath = state.currentStoragePath;

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

	const loadCurrentStorageForMigration =
		async (): Promise<AccountStorageV3 | null> => {
			// Stat before the read so a migration persist of the merged content
			// counts as a state this process knows (baseline-less-save guard).
			// Recorded even when the parse fails: a migration persist that
			// replaces an unreadable current file is a deliberate overwrite, not
			// a foreign modification to warn about.
			let stats: Awaited<ReturnType<typeof fs.stat>> | undefined;
			try {
				stats = await fs.stat(currentStoragePath);
			} catch {
				stats = undefined;
			}
			const storage = await loadNormalizedStorageFromPath(
				currentStoragePath,
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
			notePrimaryState(currentStoragePath, stats);
			return storage;
		};
	const readLiveCurrentStorageIfExportMode = async (): Promise<{
		exists: boolean;
		storage: AccountStorageV3 | null;
	}> => {
		if (commit || !existsSync(currentStoragePath)) {
			return { exists: false, storage: null };
		}
		try {
			const { normalized, schemaErrors } = await loadAccountsFromPath(
				currentStoragePath,
				{
					normalizeAccountStorage,
					isRecord,
				},
			);
			if (schemaErrors.length > 0) {
				log.warn("current account storage schema validation warnings", {
					path: currentStoragePath,
					errors: schemaErrors.slice(0, 5),
				});
			}
			return {
				exists: true,
				storage: normalized,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { exists: false, storage: null };
			}
			throw error;
		}
	};

	let targetStorage = await loadCurrentStorageForMigration();
	let migrated = false;

	for (const legacyPath of existingCandidatePaths) {
		const liveCurrentStorageBeforeMerge =
			await readLiveCurrentStorageIfExportMode();
		if (liveCurrentStorageBeforeMerge.exists) {
			return liveCurrentStorageBeforeMerge.storage;
		}

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

		const liveCurrentStorageAfterLegacyRead =
			await readLiveCurrentStorageIfExportMode();
		if (liveCurrentStorageAfterLegacyRead.exists) {
			return liveCurrentStorageAfterLegacyRead.storage;
		}

		const mergedStorage = mergeStorageForMigration(
			targetStorage,
			legacyStorage,
			normalizeAccountStorage,
			findMatchingAccountIndex,
		);
		const fallbackStorage = targetStorage ?? legacyStorage;

		if (commit) {
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
			continue;
		}

		targetStorage = mergedStorage;
		migrated = true;
	}

	if (migrated) {
		return targetStorage;
	}
	if (targetStorage && !existsSync(currentStoragePath)) {
		return targetStorage;
	}
	return null;
}

type AccountMatchOptions = {
	allowUniqueAccountIdFallbackWithoutEmail?: boolean;
};

function findNewestMatchingIndex<T extends AccountLike>(
	accounts: readonly T[],
	predicate: (ref: AccountIdentityRef) => boolean,
): number | undefined {
	return findNewestMatchingIndexByRef(
		accounts,
		(account) => toAccountIdentityRef(account),
		predicate,
		selectNewestAccount,
	);
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

/**
 * Re-resolve a manual pin after the account list changes (deletion / auto-removal).
 * `pinnedAccountIndex` is a POSITION, so once accounts are removed or reordered the
 * raw index silently points at a DIFFERENT account — or out of range, which wedges
 * the pool. Capture the pinned account BEFORE the change and pass it here to follow
 * it by identity: returns its new index, or `undefined` when it is no longer present
 * (the pin is cleared, never left dangling at a stale slot). See #474 — a manual pin
 * must keep pointing at the account the user chose, or be dropped.
 */
export function reconcilePinnedAccountIndex(
	pinnedAccount:
		| Pick<AccountLike, "accountId" | "email" | "refreshToken">
		| undefined,
	nextAccounts: readonly Pick<
		AccountLike,
		"accountId" | "email" | "refreshToken"
	>[],
): number | undefined {
	if (!pinnedAccount) return undefined;
	return findMatchingAccountIndex(nextAccounts, pinnedAccount);
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

type DedupIndexEntry = {
	index: number;
	lastUsed: number;
	addedAt: number;
};

/**
 * Total "newest" order over surviving entries, identical to folding
 * selectNewestAccount left-to-right over the survivor array: higher
 * `lastUsed` wins, then higher `addedAt`, then — the fold's behavior on a
 * full tie — the later array position. Reducing the fold to one comparison
 * over (lastUsed, addedAt, index) is what lets each identity lookup be
 * answered from an incrementally maintained index instead of a linear scan.
 */
function compareDedupIndexEntries(
	a: DedupIndexEntry,
	b: DedupIndexEntry,
): number {
	if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
	if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
	return a.index - b.index;
}

/**
 * Incremental "newest surviving owner" index for one identity facet value
 * (a composite accountId+email pair, an email key, or a refresh token).
 * Survivor slots join when appended, refresh their freshness when a
 * newest-wins merge replaces the account stored in the slot, and leave when
 * a replacement drops the facet. A max-heap with lazy deletion answers the
 * argmax query in amortized O(log n): stale heap entries are popped on
 * first sight, so every join/update/leave is paid for exactly once.
 */
class DedupNewestIndex {
	private readonly liveEntries = new Map<number, DedupIndexEntry>();
	private readonly heap: DedupIndexEntry[] = [];

	get size(): number {
		return this.liveEntries.size;
	}

	set(index: number, account: Pick<AccountLike, "addedAt" | "lastUsed">): void {
		const entry: DedupIndexEntry = {
			index,
			lastUsed: account.lastUsed || 0,
			addedAt: account.addedAt || 0,
		};
		this.liveEntries.set(index, entry);
		const heap = this.heap;
		let slot = heap.length;
		heap.push(entry);
		while (slot > 0) {
			const parent = (slot - 1) >> 1;
			const parentEntry = heap[parent];
			if (
				parentEntry === undefined ||
				compareDedupIndexEntries(parentEntry, entry) >= 0
			) {
				break;
			}
			heap[slot] = parentEntry;
			slot = parent;
		}
		heap[slot] = entry;
	}

	delete(index: number): void {
		this.liveEntries.delete(index);
	}

	newestIndex(): number | undefined {
		const heap = this.heap;
		while (heap.length > 0) {
			const top = heap[0];
			if (top !== undefined && this.liveEntries.get(top.index) === top) {
				return top.index;
			}
			this.dropHeapTop();
		}
		return undefined;
	}

	private dropHeapTop(): void {
		const heap = this.heap;
		const last = heap.pop();
		if (last === undefined || heap.length === 0) return;
		heap[0] = last;
		let slot = 0;
		for (;;) {
			const left = slot * 2 + 1;
			const right = left + 1;
			let best = slot;
			let bestEntry = heap[best] ?? last;
			const leftEntry = left < heap.length ? heap[left] : undefined;
			if (
				leftEntry !== undefined &&
				compareDedupIndexEntries(leftEntry, bestEntry) > 0
			) {
				best = left;
				bestEntry = leftEntry;
			}
			const rightEntry = right < heap.length ? heap[right] : undefined;
			if (
				rightEntry !== undefined &&
				compareDedupIndexEntries(rightEntry, bestEntry) > 0
			) {
				best = right;
			}
			if (best === slot) break;
			const slotEntry = heap[slot];
			const bestValue = heap[best];
			if (bestValue !== undefined) heap[slot] = bestValue;
			if (slotEntry !== undefined) heap[best] = slotEntry;
			slot = best;
		}
	}
}

type DedupEmailIndex = {
	newest: DedupNewestIndex;
	// Multiset of the owners' non-empty accountIds, for the ambiguous
	// email-only refusal (more than one distinct id including the
	// candidate's own => no safe match).
	accountIds: Map<string, number>;
};

type DedupRefreshIndex = {
	newest: DedupNewestIndex;
	// Owner accountId/emailKey multisets, for the compatibility vetoes a
	// refresh-token match applies before picking a survivor.
	accountIds: Map<string, number>;
	emailKeys: Map<string, number>;
};

function bumpIdentityCount(
	counts: Map<string, number>,
	key: string | undefined,
	delta: number,
): void {
	if (!key) return;
	const next = (counts.get(key) ?? 0) + delta;
	if (next <= 0) {
		counts.delete(key);
	} else {
		counts.set(key, next);
	}
}

function dedupCompositeKey(ref: AccountIdentityRef): string | undefined {
	if (!ref.accountId || !ref.emailKey) return undefined;
	// JSON encoding keeps the pair unambiguous even for adversarial strings.
	return JSON.stringify([ref.accountId, ref.emailKey]);
}

/**
 * One dedup pass in O(n log n): every candidate is matched against the
 * surviving array through four incrementally maintained indexes (composite
 * accountId+email, email, refresh token, accountId) that apply the same
 * tier precedence and vetoes as the linear findMatchingAccountIndex scans
 * they replace. A newest-wins replacement re-keys every index the loser
 * owned, so the indexes always describe the current survivor array.
 */
function deduplicateAccountsByIdentityPass<T extends AccountLike>(
	accounts: readonly T[],
): T[] {
	const deduplicated: T[] = [];
	const refs: AccountIdentityRef[] = [];
	const compositeIndexes = new Map<string, DedupNewestIndex>();
	const emailIndexes = new Map<string, DedupEmailIndex>();
	const refreshIndexes = new Map<string, DedupRefreshIndex>();
	const accountIdOwners = new Map<string, Set<number>>();

	const addToIndexes = (
		index: number,
		account: T,
		ref: AccountIdentityRef,
	): void => {
		const compositeKey = dedupCompositeKey(ref);
		if (compositeKey !== undefined) {
			let newest = compositeIndexes.get(compositeKey);
			if (!newest) {
				newest = new DedupNewestIndex();
				compositeIndexes.set(compositeKey, newest);
			}
			newest.set(index, account);
		}
		if (ref.emailKey !== undefined) {
			let bucket = emailIndexes.get(ref.emailKey);
			if (!bucket) {
				bucket = { newest: new DedupNewestIndex(), accountIds: new Map() };
				emailIndexes.set(ref.emailKey, bucket);
			}
			bucket.newest.set(index, account);
			bumpIdentityCount(bucket.accountIds, ref.accountId, 1);
		}
		if (ref.refreshToken !== undefined) {
			let bucket = refreshIndexes.get(ref.refreshToken);
			if (!bucket) {
				bucket = {
					newest: new DedupNewestIndex(),
					accountIds: new Map(),
					emailKeys: new Map(),
				};
				refreshIndexes.set(ref.refreshToken, bucket);
			}
			bucket.newest.set(index, account);
			bumpIdentityCount(bucket.accountIds, ref.accountId, 1);
			bumpIdentityCount(bucket.emailKeys, ref.emailKey, 1);
		}
		if (ref.accountId !== undefined) {
			let owners = accountIdOwners.get(ref.accountId);
			if (!owners) {
				owners = new Set();
				accountIdOwners.set(ref.accountId, owners);
			}
			owners.add(index);
		}
	};

	const removeFromIndexes = (index: number, ref: AccountIdentityRef): void => {
		const compositeKey = dedupCompositeKey(ref);
		if (compositeKey !== undefined) {
			compositeIndexes.get(compositeKey)?.delete(index);
		}
		if (ref.emailKey !== undefined) {
			const bucket = emailIndexes.get(ref.emailKey);
			if (bucket) {
				bucket.newest.delete(index);
				bumpIdentityCount(bucket.accountIds, ref.accountId, -1);
			}
		}
		if (ref.refreshToken !== undefined) {
			const bucket = refreshIndexes.get(ref.refreshToken);
			if (bucket) {
				bucket.newest.delete(index);
				bumpIdentityCount(bucket.accountIds, ref.accountId, -1);
				bumpIdentityCount(bucket.emailKeys, ref.emailKey, -1);
			}
		}
		if (ref.accountId !== undefined) {
			accountIdOwners.get(ref.accountId)?.delete(index);
		}
	};

	for (const account of accounts) {
		if (!account) continue;
		const candidateRef = toAccountIdentityRef(account);
		let existingIndex: number | undefined;

		// Tier 1: composite accountId + email match.
		if (candidateRef.accountId && candidateRef.emailKey) {
			const compositeKey = dedupCompositeKey(candidateRef);
			if (compositeKey !== undefined) {
				existingIndex = compositeIndexes.get(compositeKey)?.newestIndex();
			}
		}

		// Tier 2: safe email match. Refuse when the email's owners plus the
		// candidate carry more than one distinct accountId.
		if (existingIndex === undefined && candidateRef.emailKey) {
			const bucket = emailIndexes.get(candidateRef.emailKey);
			if (bucket && bucket.newest.size > 0) {
				const distinctAccountIds =
					bucket.accountIds.size +
					(candidateRef.accountId &&
					!bucket.accountIds.has(candidateRef.accountId)
						? 1
						: 0);
				if (distinctAccountIds <= 1) {
					existingIndex = bucket.newest.newestIndex();
				}
			}
		}

		// Tier 3: compatible refresh-token match. Refuse on an owner whose
		// accountId or emailKey conflicts with the candidate's, and on an
		// ambiguous refresh-only candidate with more than one owner.
		if (existingIndex === undefined && candidateRef.refreshToken) {
			const bucket = refreshIndexes.get(candidateRef.refreshToken);
			if (bucket && bucket.newest.size > 0) {
				const accountIdConflict =
					candidateRef.accountId !== undefined &&
					(bucket.accountIds.size > 1 ||
						(bucket.accountIds.size === 1 &&
							!bucket.accountIds.has(candidateRef.accountId)));
				const emailKeyConflict =
					candidateRef.emailKey !== undefined &&
					(bucket.emailKeys.size > 1 ||
						(bucket.emailKeys.size === 1 &&
							!bucket.emailKeys.has(candidateRef.emailKey)));
				const ambiguous =
					candidateRef.accountId === undefined &&
					candidateRef.emailKey === undefined &&
					bucket.newest.size > 1;
				if (!accountIdConflict && !emailKeyConflict && !ambiguous) {
					existingIndex = bucket.newest.newestIndex();
				}
			}
		}

		// Tier 4: unique-accountId fallback. The dedup pass runs
		// findMatchingAccountIndex with default options, so the fallback is
		// only reachable for candidates that also carry an email key; a sole
		// owner still loses on a conflicting email key.
		if (
			existingIndex === undefined &&
			candidateRef.accountId &&
			candidateRef.emailKey
		) {
			const owners = accountIdOwners.get(candidateRef.accountId);
			if (owners && owners.size === 1) {
				const only = owners.values().next();
				if (!only.done) {
					const ownerEmailKey = refs[only.value]?.emailKey;
					if (
						ownerEmailKey === undefined ||
						ownerEmailKey === candidateRef.emailKey
					) {
						existingIndex = only.value;
					}
				}
			}
		}

		if (existingIndex === undefined) {
			const index = deduplicated.length;
			deduplicated.push(account);
			refs.push(candidateRef);
			addToIndexes(index, account, candidateRef);
			continue;
		}

		const current = deduplicated[existingIndex];
		if (selectNewestAccount(current, account) === current) continue;
		deduplicated[existingIndex] = account;
		const previousRef = refs[existingIndex];
		refs[existingIndex] = candidateRef;
		if (previousRef) removeFromIndexes(existingIndex, previousRef);
		addToIndexes(existingIndex, account, candidateRef);
	}
	return deduplicated;
}

function deduplicateAccountsByIdentity<T extends AccountLike>(
	accounts: T[],
): T[] {
	// A single pass is not a fixpoint: a newest-wins merge can replace a kept
	// entry with an account that itself duplicates an earlier survivor through
	// a different matching tier (e.g. an email-tier merge installs an account
	// whose accountId + refresh token already match a record that carried no
	// email). Re-run until stable; every merge strictly shrinks the array, so
	// this terminates after at most accounts.length passes.
	let current = deduplicateAccountsByIdentityPass(accounts);
	for (;;) {
		const next = deduplicateAccountsByIdentityPass(current);
		if (next.length === current.length) return next;
		current = next;
	}
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

	// Build from baseStorage.accounts (the migrated V3 shape), NOT the raw V1
	// objects. Otherwise a V1->V3 upgrade discards migrateV1ToV3's per-account
	// transforms — most importantly the scalar `rateLimitResetTime` -> map
	// `rateLimitResetTimes` conversion — so a rate-limited V1 account would be
	// treated as immediately available on upgrade and burst 429s (stress audit M3).
	const validAccounts = baseStorage.accounts
		.filter(
			(account): account is AccountMetadataV3 =>
				isRecord(account) &&
				typeof account.refreshToken === "string" &&
				!!account.refreshToken.trim(),
		)
		.map((account) => {
			const invalidationTimestamp = account.authInvalidatedAt;
			if (
				typeof invalidationTimestamp === "number" &&
				Number.isFinite(invalidationTimestamp) &&
				invalidationTimestamp > 0
			) {
				return account;
			}
			const normalized = { ...account };
			delete normalized.authInvalidatedAt;
			delete normalized.authInvalidationErrorCode;
			return normalized;
		});

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

	const pinnedAccountIndex = (() => {
		const raw = (data as { pinnedAccountIndex?: unknown }).pinnedAccountIndex;
		if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
		const truncated = Math.trunc(raw);
		if (
			truncated < 0 ||
			truncated >= deduplicatedAccounts.length ||
			deduplicatedAccounts.length === 0
		) {
			log.warn("Dropping invalid pinnedAccountIndex from storage", {
				value: raw,
				accountCount: deduplicatedAccounts.length,
			});
			return undefined;
		}
		return truncated;
	})();

	const affinityGeneration = (() => {
		const raw = (data as { affinityGeneration?: unknown }).affinityGeneration;
		if (raw === undefined) return undefined;
		if (
			typeof raw !== "number" ||
			!Number.isFinite(raw) ||
			// See readAffinityGenerationFromDisk: an unsafe integer wedges the bump.
			!Number.isSafeInteger(raw) ||
			raw < 0
		) {
			log.warn("Dropping invalid affinityGeneration from storage", {
				value: raw,
			});
			return undefined;
		}
		return raw;
	})();

	const normalized: AccountStorageV3 = {
		version: 3,
		accounts: deduplicatedAccounts,
		activeIndex,
		activeIndexByFamily,
	};
	if (pinnedAccountIndex !== undefined) {
		normalized.pinnedAccountIndex = pinnedAccountIndex;
	}
	if (affinityGeneration !== undefined) {
		normalized.affinityGeneration = affinityGeneration;
	}
	return normalized;
}

/**
 * Synchronously reads only the top-level `affinityGeneration` field from the
 * accounts storage file. Used by `unpin`/`switch`/`best` to avoid losing
 * concurrent generation increments via lost-update on the load+mutate pair —
 * callers re-read this value just before saving and apply
 * `Math.max(inMemory, disk) + 1` so the counter is monotonically increasing.
 *
 * Returns 0 on any failure (missing file, malformed JSON, transient I/O
 * error). The save itself is still serialized by `withStorageLock`; this
 * helper only narrows the lost-update window. See issue #474.
 */
export function readAffinityGenerationFromDisk(path: string): number {
	if (!existsSync(path)) return 0;
	try {
		const bytes = readFileSync(path);
		const parsed = JSON.parse(bytes.toString("utf8")) as {
			affinityGeneration?: unknown;
		};
		const generation = parsed.affinityGeneration;
		if (
			typeof generation === "number" &&
			Number.isFinite(generation) &&
			// Safe, not merely integral: past 2^53 `Math.max(gen, disk) + 1 === gen`,
			// so `bumpStorageAffinityGeneration` silently stops advancing and no
			// running proxy ever observes another `switch`. Rejecting the value
			// lets the next bump write 1 and repair the file.
			Number.isSafeInteger(generation) &&
			generation >= 0
		) {
			return generation;
		}
		return 0;
	} catch {
		return 0;
	}
}

/**
 * Advance the session-affinity generation so a running runtime proxy drops its
 * sticky session→account bindings on the next request.
 *
 * Session affinity remembers an account by ITS INDEX, so any mutation that
 * reshuffles the pool (removing an account, restoring a backup) silently
 * re-points every live session at a different account until the generation
 * changes. `switch`/`best`/`unpin` already bump it; the reshuffling paths are
 * the ones that need it most, because they move every index at once.
 *
 * Re-reads the on-disk generation first so concurrent CLI processes do not lose
 * increments via lost-update on the load+mutate pair. `Math.max` keeps the
 * counter monotonic: an extra bump only costs one additional affinity
 * invalidation, while a missed bump lets the proxy cling to the wrong account.
 * See issue #474.
 */
export function bumpStorageAffinityGeneration(
	storage: { affinityGeneration?: number },
	storagePath?: string | null,
): number {
	let diskGeneration = 0;
	try {
		const path = storagePath ?? getStoragePath();
		if (path) diskGeneration = readAffinityGenerationFromDisk(path);
	} catch {
		// No resolvable storage path (never configured). The in-memory counter
		// is still bumped below; only the lost-update guard is unavailable.
	}
	// Guard the in-memory side too, not just the disk read. Past 2^53
	// `Math.max(gen, disk) + 1 === gen`, so an unsafe value here would write the
	// same generation forever and no running proxy would observe another
	// `switch`. Treating it as 0 makes the next write repair the counter.
	const rawInMemory = storage.affinityGeneration ?? 0;
	const inMemoryGeneration =
		Number.isSafeInteger(rawInMemory) && rawInMemory >= 0 ? rawInMemory : 0;
	const next = Math.max(inMemoryGeneration, diskGeneration) + 1;
	storage.affinityGeneration = next;
	return next;
}

/**
 * Synchronously reads both the top-level `pinnedAccountIndex` and
 * `affinityGeneration` fields from the accounts storage file. Used by
 * `AccountManager.buildStorageSnapshot` to refresh from disk just before
 * persisting routine state (rate-limit hits, cooldowns, etc.) so a CLI
 * `switch`/`unpin` that landed between proxy startup and the save is not
 * clobbered. Returns `pinnedAccountIndex: undefined` and
 * `affinityGeneration: 0` on any failure by default. See issue #474.
 *
 * `strict` callers additionally need to know when the metadata could not be
 * OBSERVED AT ALL, because persisting a stale in-memory pin over a newer disk
 * pin is exactly the #474 regression. Strict mode therefore throws for the two
 * cases where a newer selection may be hiding behind the failure:
 *   - the file exists but cannot be read (EBUSY/EPERM/EACCES: on Windows an AV
 *     scanner or indexer can hold accounts.json open), and
 *   - the bytes are not valid JSON (a torn read of a concurrent atomic write).
 *
 * A MISSING file and a successfully parsed file with INVALID field values are
 * deliberately not failures, in either mode. Neither can be concealing a newer
 * pin (there is no file, or we can see the whole file and the field is
 * unusable), and both are self-repaired by the very write that follows. Making
 * them throw would wedge persistence permanently, since recreating or repairing
 * storage goes through the same save path, and it would take every rate-limit
 * window, cooldown and rotated refresh token in memory down with it.
 */
export function readPinAndGenFromDisk(
	path: string,
	options?: { strict?: boolean },
): {
	pinnedAccountIndex: number | undefined;
	affinityGeneration: number;
} {
	const unselected = {
		pinnedAccountIndex: undefined,
		affinityGeneration: 0,
	} as const;
	if (!existsSync(path)) {
		return { ...unselected };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		// The file was deleted or renamed between existsSync and the read; same
		// reasoning as the missing-file branch above.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...unselected };
		}
		if (options?.strict) {
			throw new Error("Unable to read account selection metadata", {
				cause: error,
			});
		}
		return { ...unselected };
	}
	if (!isRecord(parsed)) {
		return { ...unselected };
	}
	const rawPin = parsed.pinnedAccountIndex;
	const pinnedAccountIndex =
		typeof rawPin === "number" &&
		Number.isFinite(rawPin) &&
		Number.isInteger(rawPin) &&
		rawPin >= 0
			? rawPin
			: undefined;
	const rawGen = parsed.affinityGeneration;
	const affinityGeneration =
		typeof rawGen === "number" &&
		Number.isFinite(rawGen) &&
		// See readAffinityGenerationFromDisk: an unsafe integer wedges the bump.
		Number.isSafeInteger(rawGen) &&
		rawGen >= 0
			? rawGen
			: 0;
	return { pinnedAccountIndex, affinityGeneration };
}

/**
 * Loads OAuth accounts from disk storage.
 * Automatically migrates v1 storage to v3 format if needed.
 * @returns AccountStorageV3 if file exists and is valid, null otherwise
 */
export async function loadAccounts(): Promise<AccountStorageV3 | null> {
	const storage = await applyPendingAuth(getStoragePath(), await loadAccountsInternal(saveAccounts));
	if (storage) loadedAccountSnapshots.set(storage, structuredClone(storage));
	return storage;
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

export async function inspectStorageHealth(): Promise<StorageHealthSummary> {
	const path = getStoragePath();
	const walPath = getAccountsWalPath(path);
	const resetMarkerPath = getIntentionalResetMarkerPath(path);
	if (existsSync(resetMarkerPath)) {
		return createStorageHealthSummary({
			state: "intentional-reset",
			path,
			walPath,
			resetMarkerPath,
			details: "intentional reset marker present",
		});
	}
	if (!existsSync(path)) {
		const walRecovered = await loadAccountsFromJournal(path, { silent: true });
		if (walRecovered && walRecovered.accounts.length > 0) {
			return createStorageHealthSummary({
				state: "recoverable",
				path,
				walPath,
				resetMarkerPath,
				details: "primary storage missing but WAL recovery is available",
				recoverySource: "wal",
			});
		}
		return createStorageHealthSummary({
			state: "empty",
			path,
			walPath,
			resetMarkerPath,
			details: "storage file is missing",
		});
	}
	try {
		const { normalized, schemaErrors } = await loadAccountsFromPath(path, {
			normalizeAccountStorage,
			isRecord,
		});
		if (normalized && normalized.accounts.length > 0) {
			return createStorageHealthSummary({
				state: "healthy",
				path,
				walPath,
				resetMarkerPath,
				schemaErrors,
			});
		}
		if (normalized) {
			return createStorageHealthSummary({
				state: "empty",
				path,
				walPath,
				resetMarkerPath,
				schemaErrors,
				details: "storage parsed but contains no accounts",
			});
		}
		const walRecovered = await loadAccountsFromJournal(path, { silent: true });
		if (walRecovered && walRecovered.accounts.length > 0) {
			return createStorageHealthSummary({
				state: "recoverable",
				path,
				walPath,
				resetMarkerPath,
				schemaErrors,
				details: "primary storage is invalid but WAL recovery is available",
				recoverySource: "wal",
			});
		}
		return createStorageHealthSummary({
			state: "corrupt",
			path,
			walPath,
			resetMarkerPath,
			schemaErrors,
			details: "storage could not be normalized",
		});
	} catch (error) {
		const walRecovered = await loadAccountsFromJournal(path, { silent: true });
		if (walRecovered && walRecovered.accounts.length > 0) {
			return createStorageHealthSummary({
				state: "recoverable",
				path,
				walPath,
				resetMarkerPath,
				details: error instanceof Error ? error.message : String(error),
				recoverySource: "wal",
			});
		}
		return createStorageHealthSummary({
			state: "corrupt",
			path,
			walPath,
			resetMarkerPath,
			details: error instanceof Error ? error.message : String(error),
		});
	}
}

async function loadAccountsFromJournal(
	path: string,
	options: { silent?: boolean } = {},
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
		const entry = safeParseJson(
			raw,
			AccountsJournalEntrySchema,
			"storage.loadAccountsFromJournal",
		);
		if (!entry) return null;
		const computed = computeSha256(entry.content);
		if (computed !== entry.checksum) {
			if (!options.silent) {
				log.warn("Account journal checksum mismatch", { path: walPath });
			}
			return null;
		}
		const validatedInner = safeParseJson(
			entry.content,
			AnyAccountStorageSchema,
			"storage.loadAccountsFromJournal.content",
		);
		let data: unknown;
		if (validatedInner !== null) {
			data = validatedInner;
		} else {
			try {
				data = JSON.parse(entry.content) as unknown;
			} catch {
				return null;
			}
		}
		const { normalized } = parseAndNormalizeStorage(
			data,
			normalizeAccountStorage,
			isRecord,
		);
		if (!normalized) return null;
		if (!options.silent) {
			log.warn("Recovered account storage from WAL journal", { path, walPath });
		}
		return normalized;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && !options.silent) {
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
		? await migrateLegacyProjectStorageIfNeeded({ persist: persistMigration })
		: null;

	// Stat BEFORE the primary read: this fingerprint is the state this process
	// can claim to know. A writer racing the read makes the record stale, which
	// is the safe direction for the baseline-less-save guard — never claim
	// knowledge of content we may not have parsed.
	let primaryStatsBeforeRead: Awaited<ReturnType<typeof fs.stat>> | undefined;
	try {
		primaryStatsBeforeRead = await fs.stat(path);
	} catch {
		primaryStatsBeforeRead = undefined;
	}
	try {
		const { normalized, storedVersion, schemaErrors, contentSha256 } =
			await loadAccountsFromPath(path, {
				normalizeAccountStorage,
				isRecord,
			});
		if (normalized) {
			notePrimaryState(path, primaryStatsBeforeRead, contentSha256);
		}
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
		// The primary could not be parsed (or read). Whatever file we stat'd is
		// the state the WAL/backup recovery persists below deliberately replace,
		// so record it as known — otherwise those intentional recovery saves
		// would emit the baseline-less-overwrite warning and spend the
		// once-per-path guard meant for genuine foreign writes.
		notePrimaryState(path, primaryStatsBeforeRead);
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

async function loadAccountsForExport(): Promise<AccountStorageV3 | null> {
	// Export reuses this helper from both paths in `exportAccounts()`. Keep the
	// read side effect free so export never clears a reset marker or races with
	// concurrent writers while normalizing legacy storage for the snapshot.
	const path = getStoragePath();
	const resetMarkerPath = getIntentionalResetMarkerPath(path);

	if (existsSync(resetMarkerPath)) {
		return createEmptyStorageWithMetadata(false, "intentional-reset");
	}

	try {
		const { normalized, schemaErrors } = await loadAccountsFromPath(path, {
			normalizeAccountStorage,
			isRecord,
		});
		if (schemaErrors.length > 0) {
			log.warn("Account storage schema validation warnings", {
				errors: schemaErrors.slice(0, 5),
			});
		}
		if (existsSync(resetMarkerPath)) {
			return createEmptyStorageWithMetadata(false, "intentional-reset");
		}
		return normalized;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (existsSync(resetMarkerPath)) {
			return createEmptyStorageWithMetadata(false, "intentional-reset");
		}
		if (code === "ENOENT") {
			const migratedLegacyStorage = await migrateLegacyProjectStorageIfNeeded({
				commit: false,
			});
			if (existsSync(resetMarkerPath)) {
				return createEmptyStorageWithMetadata(false, "intentional-reset");
			}
			return migratedLegacyStorage;
		}
		throw error;
	}
}

async function saveAccountsUnlocked(
	storage: AccountStorageV3,
	options?: { expectedOnDiskAccounts?: readonly AccountMetadataV3[] | null },
): Promise<void> {
	await saveAccountsUnlockedToDisk(storage, options);
	// A persisted (or superseded) pending rotated credential is no longer needed —
	// unless a restorable backup/WAL snapshot still carries the token it replaces,
	// in which case the entry stays so a stale-backup recovery self-heals.
	const path = getStoragePath();
	await prunePendingAuth(path, storage, () =>
		collectRestorableRefreshTokens(path),
	).catch((error) => {
		log.warn("Failed to prune pending rotated credentials", { code: typeof (error as NodeJS.ErrnoException).code === "string" && /^[A-Z_]{1,40}$/.test((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code : "INVALID_PENDING_AUTH" });
	});
}

async function saveAccountsUnlockedToDisk(
	storage: AccountStorageV3,
	options?: { expectedOnDiskAccounts?: readonly AccountMetadataV3[] | null },
): Promise<void> {
	const path = getStoragePath();
	const resetMarkerPath = getIntentionalResetMarkerPath(path);
	const walPath = getAccountsWalPath(path);
	return saveAccountsToDisk(storage, {
		path,
		resetMarkerPath,
		walPath,
		storageBackupEnabled: storageBackupEnabled && existsSync(path),
		ensureDirectory: async () => {
			const dir = dirname(path);
			// Account storage holds OAuth token material, so keep its directory
			// owner-only on POSIX (mode is a no-op on win32 / ACL-based).
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			// mkdir's mode only applies to a freshly-created dir; a pre-existing dir
			// from an earlier build keeps its old (possibly world-listable) perms, so
			// re-assert 0o700 on POSIX. Best-effort: a chmod failure must not break
			// the save (the atomic write still uses mode 0o600 for the file itself).
			if (process.platform !== "win32") {
				try {
					await fs.chmod(dir, 0o700);
				} catch {
					// Best-effort hardening only.
				}
			}
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
		createRotatingAccountsBackup: (targetPath) =>
			rotateAccountsBackupIfDue(
				targetPath,
				storage.accounts,
				options?.expectedOnDiskAccounts,
			),
		computeSha256,
		writeJournal: async (content: string, journalPath: string) => {
			const journalEntry: AccountsJournalEntry = {
				version: 1,
				createdAt: Date.now(),
				path: journalPath,
				checksum: computeSha256(content),
				content,
			};
			// Secret-bearing WAL write: retry transient Windows locks via the shared
			// taxonomy so a momentary AV/indexer/concurrent-reader lock can't fail an
			// otherwise-valid save (EBUSY/EPERM/EAGAIN/ENOTEMPTY/EACCES).
			await withFileOperationRetry(() =>
				fs.writeFile(walPath, JSON.stringify(journalEntry), {
					encoding: "utf-8",
					mode: 0o600,
				}),
			);
		},
		writeTemp: (tempPath: string, content: string) =>
			withFileOperationRetry(() =>
				fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 }),
			),
		statTemp: (tempPath: string) => fs.stat(tempPath),
		renameTempToPath: (tempPath: string) =>
			// Windows can hold the destination briefly (AV/indexer); retry only the
			// lock codes rename actually surfaces there, on the original
			// 10ms-doubling schedule. (The hand-rolled loop this replaces also
			// slept once more after the final failure; withRetry rethrows
			// immediately instead.)
			withRetry(() => fs.rename(tempPath, path), {
				maxAttempts: 5,
				backoffMs: (attempt) => 10 * 2 ** (attempt - 1),
				retryableCodes: ["EPERM", "EBUSY"],
			}),
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
			// The temp file holds the full account store (refresh tokens, 0o600).
			// Retry cleanup so a transient lock can't strand a secret-bearing *.tmp
			// next to the destination; swallow a persistent failure (best effort).
			try {
				await withFileOperationRetry(() => fs.unlink(tempPath));
			} catch {
				// Ignore cleanup failure.
			}
		},
		onSaved: (stats, contentSha256) => {
			lastAccountsSaveTimestamp = Date.now();
			notePrimaryState(path, stats, contentSha256);
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
		createTempPath: () => tempPathFor(path),
	});
}

function cloneFlaggedStorageForPersistence(
	storage: FlaggedAccountStorageV1 | null | undefined,
): FlaggedAccountStorageV1 {
	return {
		version: 1,
		accounts: structuredClone(storage?.accounts ?? []),
	};
}
/** Code for a merge base that cannot be read; distinct from an ESTALE edit conflict. */
export const ACCOUNT_STORAGE_UNREADABLE = "EACCOUNTSUNREADABLE";

async function loadPrimaryAccountsForMerge(): Promise<AccountStorageV3 | null> {
	const path = getStoragePath();
	if (existsSync(getIntentionalResetMarkerPath(path))) {
		return createEmptyStorageWithMetadata(false, "intentional-reset");
	}
	try {
		const { normalized } = await loadAccountsFromPath(path, {
			normalizeAccountStorage,
			isRecord,
		});
		if (!normalized) throw new Error("Invalid primary account storage");
		// The merge base must carry pending rotated credentials too, or a merge
		// would keep the spent token that is still on disk.
		return applyPendingAuth(path, normalized);
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		// The journal is written before the primary and removed after it, so a
		// journal beside a missing primary is the newest state, not a stale
		// backup. Without one, the deletion is authoritative.
		if (code === "ENOENT") return applyPendingAuth(path, await loadAccountsFromJournal(path, { silent: true }));
		// A locked or torn primary may hold newer state than any backup, so it is
		// never replaced by a recovered copy here.
		throw Object.assign(
			new Error(
				`Account storage could not be read${typeof code === "string" ? ` (${code})` : ""}; nothing was saved.`,
			),
			{ code: ACCOUNT_STORAGE_UNREADABLE, cause },
		);
	}
}

export async function withAccountStorageTransaction<T>(
	handler: (
		current: AccountStorageV3 | null,
		persist: (storage: AccountStorageV3) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return runWithAccountStorageTransaction(handler, {
		getStoragePath,
		loadCurrent: loadPrimaryAccountsForMerge,
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
		currentFlagged: FlaggedAccountStorageV1,
	) => Promise<T>,
): Promise<T> {
	return withStorageLock(async () => {
		const storagePath = getStoragePath();
		const state = {
			snapshot: await loadPrimaryAccountsForMerge(),
			storagePath,
			active: true,
		};
		const current = state.snapshot;
		const currentFlagged = await loadFlaggedAccounts();
		const persist = async (
			accountStorage: AccountStorageV3,
			flaggedStorage: FlaggedAccountStorageV1,
		): Promise<void> => {
			const previousAccounts = cloneAccountStorageForPersistence(
				state.snapshot,
			);
			const baseline = loadedAccountSnapshots.get(accountStorage);
			const nextAccounts = cloneAccountStorageForPersistence(baseline ? mergeAccountSnapshot(baseline, state.snapshot, accountStorage) : accountStorage);
			const nextFlagged = cloneFlaggedStorageForPersistence(flaggedStorage);
			await saveAccountsUnlocked(nextAccounts, {
				expectedOnDiskAccounts: state.snapshot?.accounts,
			});
			try {
				await saveFlaggedAccountsUnlocked(nextFlagged);
				state.snapshot = nextAccounts;
			} catch (error) {
				try {
					await saveAccountsUnlocked(previousAccounts, {
						expectedOnDiskAccounts: state.snapshot?.accounts,
					});
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
		return runInTransactionSnapshotContext(state, () =>
			handler(current, persist, currentFlagged),
		);
	});
}

export async function withFlaggedStorageTransaction<T>(
	handler: (
		current: FlaggedAccountStorageV1,
		persist: (storage: FlaggedAccountStorageV1) => Promise<void>,
	) => Promise<T>,
): Promise<T> {
	return withStorageLock(async () => {
		const current = await loadFlaggedAccounts();
		let snapshot = cloneFlaggedStorageForPersistence(current);
		const persist = async (storage: FlaggedAccountStorageV1): Promise<void> => {
			const previousStorage = cloneFlaggedStorageForPersistence(snapshot);
			const nextStorage = cloneFlaggedStorageForPersistence(storage);
			try {
				await saveFlaggedAccountsUnlocked(nextStorage);
				snapshot = nextStorage;
			} catch (error) {
				try {
					await saveFlaggedAccountsUnlocked(previousStorage);
					snapshot = previousStorage;
				} catch (rollbackError) {
					const combinedError = new AggregateError(
						[error, rollbackError],
						"Flagged save failed and flagged storage rollback also failed",
					);
					log.error(
						"Failed to rollback flagged storage after flagged save failure",
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
		return handler(structuredClone(snapshot), persist);
	});
}

/**
 * Persists account storage to disk using atomic write (temp file + rename).
 * Creates the Codex multi-auth storage directory if it doesn't exist.
 * Verifies file was written correctly and provides detailed error messages.
 * @param storage - Account storage data to save
 * @throws StorageError with platform-aware hints on failure
 */
/**
 * Clone a loaded working snapshot without losing its optimistic-concurrency baseline.
 *
 * Baseline contract: `saveAccounts` only runs the three-way merge
 * (`mergeAccountSnapshot` against a fresh `loadPrimaryAccountsForMerge` read)
 * when the saved object is registered in `loadedAccountSnapshots` — and that
 * WeakMap is keyed by OBJECT IDENTITY, so registration does not survive
 * `structuredClone`, `JSON.parse(JSON.stringify(...))`, spread copies, or
 * manual reconstruction. A baseline-less save writes the object as-is
 * (last-writer-wins): concurrent changes are neither merged nor flagged with
 * ESTALE, and when the primary on disk differs from the state this process
 * last read or wrote the save additionally emits a one-time baseline-less
 * overwrite warning. Use this helper — or mutate the loaded object in place —
 * to keep the merge armed.
 */
export function cloneTrackedAccountStorage(storage: AccountStorageV3): AccountStorageV3 {
 const clone = structuredClone(storage);
 const baseline = loadedAccountSnapshots.get(storage);
 if (baseline) loadedAccountSnapshots.set(clone, structuredClone(baseline));
 return clone;
}

export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
	return saveAccountsEntry({
		storage,
		withStorageLock,
		saveUnlocked: async proposed => {
			const baseline = loadedAccountSnapshots.get(proposed);
			const current = baseline ? await loadPrimaryAccountsForMerge() : null;
			if (!baseline) {
				// Without a baseline the three-way merge cannot run — this write is
				// last-writer-wins. Warn (once) if the primary changed underneath us.
				await warnOnBaselinelessSave(getStoragePath());
			}
			const snapshot = baseline ? mergeAccountSnapshot(baseline, current, proposed) : proposed;
			await saveAccountsUnlocked(snapshot, {
				expectedOnDiskAccounts: current?.accounts,
			});
			if (baseline) {
				for (const key of Object.keys(proposed)) Reflect.deleteProperty(proposed, key);
				Object.assign(proposed, structuredClone(snapshot));
				loadedAccountSnapshots.set(proposed, structuredClone(snapshot));
			}
		},
	});
}

/**
 * Deletes the account storage file from disk.
 * Silently ignores if file doesn't exist.
 */
export async function clearAccounts(): Promise<void> {
	const path = getStoragePath();
	await clearAccountsEntry({
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
	// Pending rotated credentials belong to the cleared pool.
	await clearPendingAuth(path);
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
		persistRecoveredBackup: async (storage, resetMarkerPath) => {
			// When loadFlaggedAccounts runs inside an already-held storage lock
			// (e.g. withAccountAndFlaggedStorageTransaction or
			// withFlaggedStorageTransaction loading current flagged state), the
			// global mutex has no reentrancy. Re-acquiring it here would deadlock,
			// so persist via the unlocked save while still respecting the reset
			// marker. Otherwise acquire the lock as usual.
			const recover = async (): Promise<boolean> => {
				if (existsSync(resetMarkerPath)) {
					return false;
				}
				await saveFlaggedAccountsUnlocked(storage);
				return true;
			};
			return isStorageLockHeld() ? recover() : withStorageLock(recover);
		},
		saveFlaggedAccounts: async (storage) => {
			// Mirror persistRecoveredBackup above: loadFlaggedAccountsState's legacy
			// migration persists via this callback, and loadFlaggedAccounts can run
			// inside an already-held storage lock
			// (withAccountAndFlaggedStorageTransaction / withFlaggedStorageTransaction).
			// The global mutex is non-reentrant, so re-acquiring it via the locking
			// saveFlaggedAccounts would deadlock — use the unlocked save when the lock
			// is already held, otherwise acquire it as usual.
			if (isStorageLockHeld()) {
				await saveFlaggedAccountsUnlocked(storage);
				return;
			}
			await saveFlaggedAccounts(storage);
		},
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
		readCurrentStorageUnlocked: () => loadAccountsForExport(),
		readCurrentStorage: () => withStorageLock(() => loadAccountsForExport()),
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
		findMatchingAccountIndex,
		logInfo: (message, details) => {
			log.info(message, details);
		},
	});
}
