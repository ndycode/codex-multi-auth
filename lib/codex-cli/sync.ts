import { promises as fs } from "node:fs";
import { createLogger } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	findMatchingAccountIndex,
	getLastAccountsSaveTimestamp,
	getStoragePath,
	normalizeEmailKey,
} from "../storage.js";
import {
	incrementCodexCliMetric,
	makeAccountFingerprint,
} from "./observability.js";
import {
	type CodexCliAccountSnapshot,
	type CodexCliState,
	isCodexCliSyncEnabled,
	loadCodexCliState,
} from "./state.js";
import { getLastCodexCliSelectionWriteTimestamp } from "./writer.js";

const log = createLogger("codex-cli-sync");

function createEmptyStorage(): AccountStorageV3 {
	return {
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: {},
	};
}

function cloneStorage(storage: AccountStorageV3): AccountStorageV3 {
	return {
		version: 3,
		accounts: storage.accounts.map((account) => ({ ...account })),
		activeIndex: storage.activeIndex,
		activeIndexByFamily: storage.activeIndexByFamily
			? { ...storage.activeIndexByFamily }
			: {},
	};
}

function formatRollbackPaths(targetPath: string): string[] {
	return [
		`${targetPath}.bak`,
		`${targetPath}.bak.1`,
		`${targetPath}.bak.2`,
		`${targetPath}.wal`,
	];
}

export interface CodexCliSyncSummary {
	sourceAccountCount: number;
	targetAccountCountBefore: number;
	targetAccountCountAfter: number;
	addedAccountCount: number;
	updatedAccountCount: number;
	unchangedAccountCount: number;
	destinationOnlyPreservedCount: number;
	selectionChanged: boolean;
}

export interface CodexCliSyncBackupContext {
	enabled: boolean;
	targetPath: string;
	rollbackPaths: string[];
}

export interface CodexCliSyncPreview {
	status: "ready" | "noop" | "disabled" | "unavailable" | "error";
	statusDetail: string;
	sourcePath: string | null;
	sourceState: CodexCliState | null;
	targetPath: string;
	summary: CodexCliSyncSummary;
	backup: CodexCliSyncBackupContext;
	lastSync: CodexCliSyncRun | null;
}

export interface CodexCliSyncRun {
	outcome: "changed" | "noop" | "disabled" | "unavailable" | "error";
	runAt: number;
	sourcePath: string | null;
	targetPath: string;
	summary: CodexCliSyncSummary;
	message?: string;
}

export interface PendingCodexCliSyncRun {
	revision: number;
	run: CodexCliSyncRun;
}

type UpsertAction = "skipped" | "added" | "updated" | "unchanged";

interface UpsertResult {
	action: UpsertAction;
	matchedIndex?: number;
}

interface ReconcileResult {
	next: AccountStorageV3;
	changed: boolean;
	summary: CodexCliSyncSummary;
}

let lastCodexCliSyncRun: CodexCliSyncRun | null = null;
let lastCodexCliSyncRunRevision = 0;
let nextCodexCliSyncRunRevision = 0;

function createEmptySyncSummary(): CodexCliSyncSummary {
	return {
		sourceAccountCount: 0,
		targetAccountCountBefore: 0,
		targetAccountCountAfter: 0,
		addedAccountCount: 0,
		updatedAccountCount: 0,
		unchangedAccountCount: 0,
		destinationOnlyPreservedCount: 0,
		selectionChanged: false,
	};
}

function cloneCodexCliSyncRun(run: CodexCliSyncRun): CodexCliSyncRun {
	return {
		...run,
		summary: { ...run.summary },
	};
}

function normalizeIndexCandidate(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return Number.isFinite(fallback) ? Math.trunc(fallback) : 0;
	}
	return Math.trunc(value);
}

function allocateCodexCliSyncRunRevision(): number {
	nextCodexCliSyncRunRevision += 1;
	return nextCodexCliSyncRunRevision;
}

function publishCodexCliSyncRun(
	run: CodexCliSyncRun,
	revision: number,
): boolean {
	if (revision < lastCodexCliSyncRunRevision) {
		return false;
	}
	lastCodexCliSyncRunRevision = revision;
	lastCodexCliSyncRun = cloneCodexCliSyncRun(run);
	return true;
}

function buildSyncRunError(
	run: CodexCliSyncRun,
	error: unknown,
): CodexCliSyncRun {
	return {
		...run,
		outcome: "error",
		message: error instanceof Error ? error.message : String(error),
	};
}

function createSyncRun(
	run: Omit<CodexCliSyncRun, "runAt">,
): CodexCliSyncRun {
	return {
		...run,
		runAt: Date.now(),
	};
}

export function getLastCodexCliSyncRun(): CodexCliSyncRun | null {
	return lastCodexCliSyncRun ? cloneCodexCliSyncRun(lastCodexCliSyncRun) : null;
}

export function commitPendingCodexCliSyncRun(
	pendingRun: PendingCodexCliSyncRun | null | undefined,
): void {
	if (!pendingRun) return;
	publishCodexCliSyncRun(
		{
			...pendingRun.run,
			runAt: Date.now(),
		},
		pendingRun.revision,
	);
}

export function commitCodexCliSyncRunFailure(
	pendingRun: PendingCodexCliSyncRun | null | undefined,
	error: unknown,
): void {
	if (!pendingRun) return;
	publishCodexCliSyncRun(
		buildSyncRunError(
			{
				...pendingRun.run,
				runAt: Date.now(),
			},
			error,
		),
		pendingRun.revision,
	);
}

export function __resetLastCodexCliSyncRunForTests(): void {
	lastCodexCliSyncRun = null;
	lastCodexCliSyncRunRevision = 0;
	nextCodexCliSyncRunRevision = 0;
}

function hasConflictingIdentity(
	accounts: AccountMetadataV3[],
	snapshot: CodexCliAccountSnapshot,
): boolean {
	const normalizedEmail = normalizeEmailKey(snapshot.email);
	for (const account of accounts) {
		if (!account) continue;
		if (snapshot.accountId && account.accountId === snapshot.accountId) {
			return true;
		}
		if (snapshot.refreshToken && account.refreshToken === snapshot.refreshToken) {
			return true;
		}
		if (normalizedEmail && normalizeEmailKey(account.email) === normalizedEmail) {
			return true;
		}
	}
	return false;
}

function toStorageAccount(
	snapshot: CodexCliAccountSnapshot,
): AccountMetadataV3 | null {
	if (!snapshot.refreshToken) return null;
	const now = Date.now();
	return {
		accountId: snapshot.accountId,
		accountIdSource: snapshot.accountId ? "token" : undefined,
		email: snapshot.email,
		refreshToken: snapshot.refreshToken,
		accessToken: snapshot.accessToken,
		expiresAt: snapshot.expiresAt,
		enabled: true,
		addedAt: now,
		lastUsed: 0,
	};
}

function upsertFromSnapshot(
	accounts: AccountMetadataV3[],
	snapshot: CodexCliAccountSnapshot,
): UpsertResult {
	const nextAccount = toStorageAccount(snapshot);
	if (!nextAccount) return { action: "skipped" };

	const targetIndex = findMatchingAccountIndex(accounts, snapshot, {
		allowUniqueAccountIdFallbackWithoutEmail: true,
	});

	if (targetIndex === undefined) {
		if (hasConflictingIdentity(accounts, snapshot)) {
			return { action: "skipped" };
		}
		accounts.push(nextAccount);
		return { action: "added" };
	}

	const current = accounts[targetIndex];
	if (!current) return { action: "skipped" };

	const merged: AccountMetadataV3 = {
		...current,
		accountId: snapshot.accountId ?? current.accountId,
		accountIdSource: snapshot.accountId
			? (current.accountIdSource ?? "token")
			: current.accountIdSource,
		email: snapshot.email ?? current.email,
		refreshToken: snapshot.refreshToken ?? current.refreshToken,
		accessToken: snapshot.accessToken ?? current.accessToken,
		expiresAt: snapshot.expiresAt ?? current.expiresAt,
	};

	const changed = JSON.stringify(current) !== JSON.stringify(merged);
	if (changed) {
		accounts[targetIndex] = merged;
	}
	return {
		action: changed ? "updated" : "unchanged",
		matchedIndex: targetIndex,
	};
}

function resolveActiveIndex(
	accounts: AccountMetadataV3[],
	activeAccountId: string | undefined,
	activeEmail: string | undefined,
): number | undefined {
	if (accounts.length === 0) return undefined;
	if (!activeAccountId && !normalizeEmailKey(activeEmail)) return undefined;
	return findMatchingAccountIndex(
		accounts,
		{
			accountId: activeAccountId,
			email: activeEmail,
			refreshToken: undefined,
		},
		{
			allowUniqueAccountIdFallbackWithoutEmail: true,
		},
	);
}

function writeFamilyIndexes(storage: AccountStorageV3, index: number): void {
	storage.activeIndex = index;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		storage.activeIndexByFamily[family] = index;
	}
}

async function getPersistedLocalSelectionTimestamp(): Promise<number | null> {
	try {
		const stats = await fs.stat(getStoragePath());
		return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : 0;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return 0;
		}
		return null;
	}
}

/**
 * Normalize and clamp the global and per-family active account indexes to valid ranges.
 *
 * Mutates `storage` in-place: ensures `activeIndexByFamily` exists, clamps `activeIndex` to
 * 0..(accounts.length - 1) (or 0 when there are no accounts), and resolves each family entry
 * to a valid index within the same bounds.
 *
 * Concurrency: callers must synchronize externally when multiple threads/processes may write
 * the same storage object. Filesystem notes: no platform-specific IO is performed here; when
 * persisted to disk on Windows consumers should still ensure atomic writes. Token handling:
 * this function does not read or modify authentication tokens and makes no attempt to redact
 * sensitive fields.
 *
 * @param storage - The account storage object whose indexes will be normalized and clamped
 */
function normalizeStoredFamilyIndexes(storage: AccountStorageV3): void {
	const count = storage.accounts.length;
	const normalizedActiveIndex = normalizeIndexCandidate(storage.activeIndex, 0);
	const clamped =
		count === 0 ? 0 : Math.max(0, Math.min(normalizedActiveIndex, count - 1));
	if (storage.activeIndex !== clamped) {
		storage.activeIndex = clamped;
	}
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const hasFamilyIndex = Object.prototype.hasOwnProperty.call(
			storage.activeIndexByFamily,
			family,
		);
		const raw = storage.activeIndexByFamily[family];
		const resolved =
			typeof raw === "number"
				? normalizeIndexCandidate(raw, storage.activeIndex)
				: storage.activeIndex;
		const familyIndex =
			count === 0 ? 0 : Math.max(0, Math.min(resolved, count - 1));
		if (!hasFamilyIndex && familyIndex === storage.activeIndex) {
			continue;
		}
		storage.activeIndexByFamily[family] = familyIndex;
	}
}

/**
 * Return the `accountId` and `email` from the first snapshot marked active.
 *
 * @param snapshots - Array of Codex CLI account snapshots to search
 * @returns The `accountId` and `email` from the first snapshot whose `isActive` is true; properties are omitted if no active snapshot is found
 *
 * Concurrency: pure and side-effect free; safe to call concurrently.
 * Filesystem: behavior is independent of OS/filesystem semantics (including Windows).
 * Security: only `accountId` and `email` are returned; other sensitive snapshot fields (for example tokens) are not exposed or returned by this function.
 */
function readActiveFromSnapshots(snapshots: CodexCliAccountSnapshot[]): {
	accountId?: string;
	email?: string;
} {
	const active = snapshots.find((snapshot) => snapshot.isActive);
	return {
		accountId: active?.accountId,
		email: active?.email,
	};
}

/**
 * Determines whether the Codex CLI's active-account selection should override the local selection.
 *
 * Considers the state's numeric `syncVersion` or `sourceUpdatedAtMs` and compares the derived Codex timestamp
 * against local timestamps from recent account saves and last Codex selection writes. Concurrent writes or
 * clock skew can affect this decision; filesystem timestamp granularity on Windows may reduce timestamp precision.
 * This function only examines timestamps and identifiers in `state` and does not read or expose token values.
 *
 * @param state - Persisted Codex CLI state (may be undefined); the function reads `syncVersion` and `sourceUpdatedAtMs` when present
 * @returns `true` if the Codex CLI selection should be applied (i.e., Codex state is newer or timestamps are unknown), `false` otherwise
 */
function shouldApplyCodexCliSelection(
	state: Awaited<ReturnType<typeof loadCodexCliState>>,
	persistedLocalTimestamp: number | null = 0,
): boolean {
	if (!state) return false;
	const hasSyncVersion =
		typeof state.syncVersion === "number" && Number.isFinite(state.syncVersion);
	const codexVersion = hasSyncVersion
		? (state.syncVersion as number)
		: typeof state.sourceUpdatedAtMs === "number" &&
				Number.isFinite(state.sourceUpdatedAtMs)
			? state.sourceUpdatedAtMs
			: 0;
	const inProcessLocalVersion = Math.max(
		getLastAccountsSaveTimestamp(),
		getLastCodexCliSelectionWriteTimestamp(),
	);
	const localVersion = Math.max(
		inProcessLocalVersion,
		persistedLocalTimestamp ?? 0,
	);
	if (codexVersion <= 0) return true;
	if (localVersion <= 0) {
		return persistedLocalTimestamp !== null;
	}
	// Keep local selection when plugin wrote more recently than Codex state.
	const toleranceMs = hasSyncVersion ? 0 : 1_000;
	return codexVersion >= localVersion - toleranceMs;
}

function reconcileCodexCliState(
	current: AccountStorageV3 | null,
	state: NonNullable<Awaited<ReturnType<typeof loadCodexCliState>>>,
	options: { persistedLocalTimestamp?: number | null } = {},
): ReconcileResult {
	const next = current ? cloneStorage(current) : createEmptyStorage();
	const targetAccountCountBefore = next.accounts.length;
	const matchedExistingIndexes = new Set<number>();
	const summary = createEmptySyncSummary();
	summary.sourceAccountCount = state.accounts.length;
	summary.targetAccountCountBefore = targetAccountCountBefore;

	let changed = false;
	for (const snapshot of state.accounts) {
		const result = upsertFromSnapshot(next.accounts, snapshot);
		if (result.action === "skipped") continue;
		if (
			typeof result.matchedIndex === "number" &&
			result.matchedIndex >= 0 &&
			result.matchedIndex < targetAccountCountBefore
		) {
			matchedExistingIndexes.add(result.matchedIndex);
		}
		if (result.action === "added") {
			summary.addedAccountCount += 1;
			changed = true;
			continue;
		}
		if (result.action === "updated") {
			summary.updatedAccountCount += 1;
			changed = true;
			continue;
		}
		summary.unchangedAccountCount += 1;
	}

	summary.destinationOnlyPreservedCount = Math.max(
		0,
		targetAccountCountBefore - matchedExistingIndexes.size,
	);

	if (next.accounts.length > 0) {
		const activeFromSnapshots = readActiveFromSnapshots(state.accounts);
		const previousActive = next.activeIndex;
		const previousFamilies = JSON.stringify(next.activeIndexByFamily ?? {});
		const applyActiveFromCodex = shouldApplyCodexCliSelection(
			state,
			options.persistedLocalTimestamp,
		);
		if (applyActiveFromCodex) {
			const desiredIndex = resolveActiveIndex(
				next.accounts,
				state.activeAccountId ?? activeFromSnapshots.accountId,
				state.activeEmail ?? activeFromSnapshots.email,
			);
			if (typeof desiredIndex === "number") {
				writeFamilyIndexes(next, desiredIndex);
			} else if (
				state.activeAccountId ||
				state.activeEmail ||
				activeFromSnapshots.accountId ||
				activeFromSnapshots.email
			) {
				log.debug(
					"Skipped Codex CLI active selection overwrite due to ambiguous source selection",
					{
						operation: "reconcile-storage",
						outcome: "selection-ambiguous",
					},
				);
			}
		} else {
			log.debug(
				"Skipped Codex CLI active selection overwrite due to newer local state",
				{
					operation: "reconcile-storage",
					outcome: "local-newer",
				},
			);
		}
		normalizeStoredFamilyIndexes(next);
		const currentFamilies = JSON.stringify(next.activeIndexByFamily ?? {});
		if (
			previousActive !== next.activeIndex ||
			previousFamilies !== currentFamilies
		) {
			summary.selectionChanged = true;
			changed = true;
		}
	}

	summary.targetAccountCountAfter = next.accounts.length;
	return { next, changed, summary };
}

export async function previewCodexCliSync(
	current: AccountStorageV3 | null,
	options: { forceRefresh?: boolean; storageBackupEnabled?: boolean } = {},
): Promise<CodexCliSyncPreview> {
	const targetPath = getStoragePath();
	const syncEnabled = isCodexCliSyncEnabled();
	const backup = {
		enabled: options.storageBackupEnabled ?? true,
		targetPath,
		rollbackPaths: formatRollbackPaths(targetPath),
	};
	const lastSync = getLastCodexCliSyncRun();
	const emptySummary = createEmptySyncSummary();
	emptySummary.targetAccountCountBefore = current?.accounts.length ?? 0;
	emptySummary.targetAccountCountAfter = current?.accounts.length ?? 0;
	try {
		if (!syncEnabled) {
			return {
				status: "disabled",
				statusDetail: "Codex CLI sync is disabled by environment override.",
				sourcePath: null,
				sourceState: null,
				targetPath,
				summary: emptySummary,
				backup,
				lastSync,
			};
		}
		const state = await loadCodexCliState({
			forceRefresh: options.forceRefresh,
		});
		if (!state) {
			return {
				status: "unavailable",
				statusDetail: "No Codex CLI sync source was found.",
				sourcePath: null,
				sourceState: null,
				targetPath,
				summary: emptySummary,
				backup,
				lastSync,
			};
		}

		const reconciled = reconcileCodexCliState(current, state, {
			persistedLocalTimestamp: await getPersistedLocalSelectionTimestamp(),
		});
		const status = reconciled.changed ? "ready" : "noop";
		const skippedAccountCount = Math.max(
			0,
			reconciled.summary.sourceAccountCount -
				reconciled.summary.addedAccountCount -
				reconciled.summary.updatedAccountCount -
				reconciled.summary.unchangedAccountCount,
		);
		const statusDetail = reconciled.changed
			? `Preview ready: ${reconciled.summary.addedAccountCount} add, ${reconciled.summary.updatedAccountCount} update, ${reconciled.summary.destinationOnlyPreservedCount} destination-only preserved${
					skippedAccountCount > 0 ? `, ${skippedAccountCount} skipped` : ""
				}.`
			: skippedAccountCount > 0
				? `Target already matches the current one-way sync result. ${skippedAccountCount} source account skipped due to conflicting or incomplete identity.`
				: "Target already matches the current one-way sync result.";
		return {
			status,
			statusDetail,
			sourcePath: state.path,
			sourceState: state,
			targetPath,
			summary: reconciled.summary,
			backup,
			lastSync,
		};
	} catch (error) {
		return {
			status: "error",
			statusDetail: error instanceof Error ? error.message : String(error),
			sourcePath: null,
			sourceState: null,
			targetPath,
			summary: emptySummary,
			backup,
			lastSync,
		};
	}
}

/**
 * Reconciles the provided local account storage with the Codex CLI state and returns the resulting storage and whether it changed.
 *
 * This operation:
 * - Merges accounts from the Codex CLI state into a clone of `current` (or into a new empty storage when `current` is null).
 * - May update the active account selection and per-family active indexes when the Codex CLI selection is considered applicable.
 * - Preserves secrets and sensitive fields; any tokens written to storage are subject to the project's token-redaction rules and are not exposed in logs or metrics.
 *
 * Concurrency assumptions:
 * - Caller is responsible for serializing concurrent writes to persistent storage; this function only returns an in-memory storage object and does not perform atomic file-level coordination.
 *
 * Windows filesystem notes:
 * - When the caller persists the returned storage to disk on Windows, standard Windows file-locking and path-length semantics apply; this function does not perform Windows-specific path normalization.
 *
 * @param current - The current local AccountStorageV3, or `null` to indicate none exists.
 * @returns An object containing:
 *   - `storage`: the reconciled AccountStorageV3 to persist (may be the original `current` when no changes were applied).
 *   - `changed`: `true` if the reconciled storage differs from `current`, `false` otherwise.
 */
export async function applyCodexCliSyncToStorage(
	current: AccountStorageV3 | null,
	options: { forceRefresh?: boolean } = {},
): Promise<{
	storage: AccountStorageV3 | null;
	changed: boolean;
	pendingRun: PendingCodexCliSyncRun | null;
}> {
	incrementCodexCliMetric("reconcileAttempts");
	const targetPath = getStoragePath();
	const revision = allocateCodexCliSyncRunRevision();
	try {
		if (!isCodexCliSyncEnabled()) {
			incrementCodexCliMetric("reconcileNoops");
			publishCodexCliSyncRun(
				createSyncRun({
					outcome: "disabled",
					sourcePath: null,
					targetPath,
					summary: {
						...createEmptySyncSummary(),
						targetAccountCountBefore: current?.accounts.length ?? 0,
						targetAccountCountAfter: current?.accounts.length ?? 0,
					},
					message: "Codex CLI sync disabled by environment override.",
				}),
				revision,
			);
			return { storage: current, changed: false, pendingRun: null };
		}

		const state = await loadCodexCliState({
			forceRefresh: options.forceRefresh,
		});
		if (!state) {
			incrementCodexCliMetric("reconcileNoops");
			publishCodexCliSyncRun(
				createSyncRun({
					outcome: "unavailable",
					sourcePath: null,
					targetPath,
					summary: {
						...createEmptySyncSummary(),
						targetAccountCountBefore: current?.accounts.length ?? 0,
						targetAccountCountAfter: current?.accounts.length ?? 0,
					},
					message: "No Codex CLI sync source was available.",
				}),
				revision,
			);
			return { storage: current, changed: false, pendingRun: null };
		}

		const reconciled = reconcileCodexCliState(current, state, {
			persistedLocalTimestamp: await getPersistedLocalSelectionTimestamp(),
		});
		const next = reconciled.next;
		const changed = reconciled.changed;
		const storage =
			next.accounts.length === 0 ? (current ?? next) : next;
		const syncRun = createSyncRun({
			outcome: changed ? "changed" : "noop",
			sourcePath: state.path,
			targetPath,
			summary: reconciled.summary,
		});

		if (!changed) {
			incrementCodexCliMetric("reconcileNoops");
			publishCodexCliSyncRun(syncRun, revision);
		} else {
			incrementCodexCliMetric("reconcileChanges");
		}

		const activeFromSnapshots = readActiveFromSnapshots(state.accounts);
		log.debug("Codex CLI reconcile completed", {
			operation: "reconcile-storage",
			outcome: changed ? "changed" : "noop",
			accountCount: next.accounts.length,
			activeAccountRef: makeAccountFingerprint({
				accountId: state.activeAccountId ?? activeFromSnapshots.accountId,
				email: state.activeEmail ?? activeFromSnapshots.email,
			}),
		});
		return {
			storage,
			changed,
			pendingRun: changed ? { revision, run: syncRun } : null,
		};
	} catch (error) {
		incrementCodexCliMetric("reconcileFailures");
		publishCodexCliSyncRun(
			createSyncRun({
				outcome: "error",
				sourcePath: null,
				targetPath,
				summary: {
					...createEmptySyncSummary(),
					targetAccountCountBefore: current?.accounts.length ?? 0,
					targetAccountCountAfter: current?.accounts.length ?? 0,
				},
				message: error instanceof Error ? error.message : String(error),
			}),
			revision,
		);
		log.warn("Codex CLI reconcile failed", {
			operation: "reconcile-storage",
			outcome: "error",
			error: String(error),
		});
		return { storage: current, changed: false, pendingRun: null };
	}
}

export function syncAccountStorageFromCodexCli(
	current: AccountStorageV3 | null,
): Promise<{
	storage: AccountStorageV3 | null;
	changed: boolean;
	pendingRun: PendingCodexCliSyncRun | null;
}> {
	incrementCodexCliMetric("reconcileAttempts");

	if (!current) {
		incrementCodexCliMetric("reconcileNoops");
		log.debug("Skipped Codex CLI reconcile because canonical storage is missing", {
			operation: "reconcile-storage",
			outcome: "canonical-missing",
		});
		return Promise.resolve({ storage: null, changed: false, pendingRun: null });
	}

	const next = cloneStorage(current);
	const previousActive = next.activeIndex;
	const previousFamilies = JSON.stringify(next.activeIndexByFamily ?? {});
	normalizeStoredFamilyIndexes(next);

	const changed =
		previousActive !== next.activeIndex ||
		previousFamilies !== JSON.stringify(next.activeIndexByFamily ?? {});

	incrementCodexCliMetric(changed ? "reconcileChanges" : "reconcileNoops");
	log.debug(
		"Skipped Codex CLI authority import; canonical storage remains authoritative",
		{
			operation: "reconcile-storage",
			outcome: changed ? "normalized-local-indexes" : "canonical-authoritative",
			accountCount: next.accounts.length,
		},
	);

	return Promise.resolve({
		storage: changed ? next : current,
		changed,
		pendingRun: null,
	});
}

export function getActiveSelectionForFamily(
	storage: AccountStorageV3,
	family: ModelFamily,
): number {
	const count = storage.accounts.length;
	if (count === 0) return 0;
	const raw = storage.activeIndexByFamily?.[family];
	const normalizedActiveIndex = normalizeIndexCandidate(storage.activeIndex, 0);
	const candidate =
		typeof raw === "number"
			? normalizeIndexCandidate(raw, normalizedActiveIndex)
			: normalizedActiveIndex;
	return Math.max(0, Math.min(candidate, count - 1));
}
