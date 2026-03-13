import { createLogger } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	getLastAccountsSaveTimestamp,
	getStoragePath,
} from "../storage.js";
import {
	incrementCodexCliMetric,
	makeAccountFingerprint,
} from "./observability.js";
import {
	type CodexCliAccountSnapshot,
	isCodexCliSyncEnabled,
	loadCodexCliState,
} from "./state.js";
import { getLastCodexCliSelectionWriteTimestamp } from "./writer.js";

const log = createLogger("codex-cli-sync");

function normalizeEmail(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

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

function buildIndexByAccountId(
	accounts: AccountMetadataV3[],
): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account?.accountId) continue;
		map.set(account.accountId, i);
	}
	return map;
}

function buildIndexByRefresh(
	accounts: AccountMetadataV3[],
): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account?.refreshToken) continue;
		map.set(account.refreshToken, i);
	}
	return map;
}

function buildIndexByEmail(accounts: AccountMetadataV3[]): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < accounts.length; i += 1) {
		const email = normalizeEmail(accounts[i]?.email);
		if (!email) continue;
		map.set(email, i);
	}
	return map;
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

	const byAccountId = buildIndexByAccountId(accounts);
	const byRefresh = buildIndexByRefresh(accounts);
	const byEmail = buildIndexByEmail(accounts);
	const normalizedEmail = normalizeEmail(snapshot.email);

	let targetIndex: number | undefined;
	if (snapshot.accountId && byAccountId.has(snapshot.accountId)) {
		targetIndex = byAccountId.get(snapshot.accountId);
	} else if (snapshot.refreshToken && byRefresh.has(snapshot.refreshToken)) {
		targetIndex = byRefresh.get(snapshot.refreshToken);
	} else if (normalizedEmail && byEmail.has(normalizedEmail)) {
		targetIndex = byEmail.get(normalizedEmail);
	}

	if (targetIndex === undefined) {
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
): number {
	if (accounts.length === 0) return 0;

	if (activeAccountId) {
		const byId = accounts.findIndex(
			(account) => account.accountId === activeAccountId,
		);
		if (byId >= 0) return byId;
	}

	const normalizedEmail = normalizeEmail(activeEmail);
	if (normalizedEmail) {
		const byEmail = accounts.findIndex(
			(account) => normalizeEmail(account.email) === normalizedEmail,
		);
		if (byEmail >= 0) return byEmail;
	}

	return 0;
}

function writeFamilyIndexes(storage: AccountStorageV3, index: number): void {
	storage.activeIndex = index;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		storage.activeIndexByFamily[family] = index;
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
	const clamped =
		count === 0 ? 0 : Math.max(0, Math.min(storage.activeIndex, count - 1));
	if (storage.activeIndex !== clamped) {
		storage.activeIndex = clamped;
	}
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const raw = storage.activeIndexByFamily[family];
		const resolved =
			typeof raw === "number" && Number.isFinite(raw)
				? raw
				: storage.activeIndex;
		storage.activeIndexByFamily[family] =
			count === 0 ? 0 : Math.max(0, Math.min(resolved, count - 1));
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
	const localVersion = Math.max(
		getLastAccountsSaveTimestamp(),
		getLastCodexCliSelectionWriteTimestamp(),
	);
	if (codexVersion <= 0 || localVersion <= 0) return true;
	// Keep local selection when plugin wrote more recently than Codex state.
	const toleranceMs = hasSyncVersion ? 0 : 1_000;
	return codexVersion >= localVersion - toleranceMs;
}

function reconcileCodexCliState(
	current: AccountStorageV3 | null,
	state: NonNullable<Awaited<ReturnType<typeof loadCodexCliState>>>,
): ReconcileResult {
	const next = current ? cloneStorage(current) : createEmptyStorage();
	const targetAccountCountBefore = next.accounts.length;
	const matchedExistingIndexes = new Set<number>();
	const summary = createEmptySyncSummary();
	summary.targetAccountCountBefore = targetAccountCountBefore;

	let changed = false;
	for (const snapshot of state.accounts) {
		const result = upsertFromSnapshot(next.accounts, snapshot);
		if (result.action === "skipped") continue;
		summary.sourceAccountCount += 1;
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
		const applyActiveFromCodex = shouldApplyCodexCliSelection(state);
		if (applyActiveFromCodex) {
			const desiredIndex = resolveActiveIndex(
				next.accounts,
				state.activeAccountId ?? activeFromSnapshots.accountId,
				state.activeEmail ?? activeFromSnapshots.email,
			);
			writeFamilyIndexes(next, desiredIndex);
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
				targetPath,
				summary: emptySummary,
				backup,
				lastSync,
			};
		}

		const reconciled = reconcileCodexCliState(current, state);
		const status = reconciled.changed ? "ready" : "noop";
		const statusDetail = reconciled.changed
			? `Preview ready: ${reconciled.summary.addedAccountCount} add, ${reconciled.summary.updatedAccountCount} update, ${reconciled.summary.destinationOnlyPreservedCount} destination-only preserved.`
			: "Target already matches the current one-way sync result.";
		return {
			status,
			statusDetail,
			sourcePath: state.path,
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
export async function syncAccountStorageFromCodexCli(
	current: AccountStorageV3 | null,
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

		const state = await loadCodexCliState();
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

		const reconciled = reconcileCodexCliState(current, state);
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

export function getActiveSelectionForFamily(
	storage: AccountStorageV3,
	family: ModelFamily,
): number {
	const count = storage.accounts.length;
	if (count === 0) return 0;
	const raw = storage.activeIndexByFamily?.[family];
	const candidate =
		typeof raw === "number" && Number.isFinite(raw) ? raw : storage.activeIndex;
	return Math.max(0, Math.min(candidate, count - 1));
}
