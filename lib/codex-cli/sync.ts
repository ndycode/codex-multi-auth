import {
	getLastAccountsSaveTimestamp,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../storage.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import { createLogger } from "../logger.js";
import { loadCodexCliState, type CodexCliAccountSnapshot } from "./state.js";
import {
	incrementCodexCliMetric,
	makeAccountFingerprint,
} from "./observability.js";
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

function buildIndexByAccountId(accounts: AccountMetadataV3[]): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account?.accountId) continue;
		map.set(account.accountId, i);
	}
	return map;
}

function buildIndexByRefresh(accounts: AccountMetadataV3[]): Map<string, number> {
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

function toStorageAccount(snapshot: CodexCliAccountSnapshot): AccountMetadataV3 | null {
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
): boolean {
	const nextAccount = toStorageAccount(snapshot);
	if (!nextAccount) return false;

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
		return true;
	}

	const current = accounts[targetIndex];
	if (!current) return false;

	const merged: AccountMetadataV3 = {
		...current,
		accountId: snapshot.accountId ?? current.accountId,
		accountIdSource:
			snapshot.accountId
				? current.accountIdSource ?? "token"
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
	return changed;
}

function resolveActiveIndex(
	accounts: AccountMetadataV3[],
	activeAccountId: string | undefined,
	activeEmail: string | undefined,
): number {
	if (accounts.length === 0) return 0;

	if (activeAccountId) {
		const byId = accounts.findIndex((account) => account.accountId === activeAccountId);
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

function writeFamilyIndexes(
	storage: AccountStorageV3,
	index: number,
): void {
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
	const clamped = count === 0 ? 0 : Math.max(0, Math.min(storage.activeIndex, count - 1));
	if (storage.activeIndex !== clamped) {
		storage.activeIndex = clamped;
	}
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const raw = storage.activeIndexByFamily[family];
		const resolved =
			typeof raw === "number" && Number.isFinite(raw) ? raw : storage.activeIndex;
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
function readActiveFromSnapshots(
	snapshots: CodexCliAccountSnapshot[],
): { accountId?: string; email?: string } {
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
function shouldApplyCodexCliSelection(state: Awaited<ReturnType<typeof loadCodexCliState>>): boolean {
	if (!state) return false;
	const codexVersion =
		typeof state.syncVersion === "number" && Number.isFinite(state.syncVersion)
			? state.syncVersion
			: typeof state.sourceUpdatedAtMs === "number" && Number.isFinite(state.sourceUpdatedAtMs)
				? state.sourceUpdatedAtMs
				: 0;
	const localVersion = Math.max(
		getLastAccountsSaveTimestamp(),
		getLastCodexCliSelectionWriteTimestamp(),
	);
	if (codexVersion <= 0 || localVersion <= 0) return true;
	// Keep local selection when plugin wrote more recently than Codex state.
	return codexVersion >= localVersion - 1_000;
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
): Promise<{ storage: AccountStorageV3 | null; changed: boolean }> {
	incrementCodexCliMetric("reconcileAttempts");
	try {
		const state = await loadCodexCliState();
		if (!state) {
			incrementCodexCliMetric("reconcileNoops");
			return { storage: current, changed: false };
		}

		const next = current ? cloneStorage(current) : createEmptyStorage();
		let changed = false;

		for (const snapshot of state.accounts) {
			const updated = upsertFromSnapshot(next.accounts, snapshot);
			if (updated) changed = true;
		}

		if (next.accounts.length === 0) {
			incrementCodexCliMetric(changed ? "reconcileChanges" : "reconcileNoops");
			log.debug("Codex CLI reconcile completed", {
				operation: "reconcile-storage",
				outcome: changed ? "changed" : "noop",
				accountCount: next.accounts.length,
			});
			return {
				storage: current ?? next,
				changed,
			};
		}

		const activeFromSnapshots = readActiveFromSnapshots(state.accounts);
		const applyActiveFromCodex = shouldApplyCodexCliSelection(state);
		if (applyActiveFromCodex) {
			const desiredIndex = resolveActiveIndex(
				next.accounts,
				state.activeAccountId ?? activeFromSnapshots.accountId,
				state.activeEmail ?? activeFromSnapshots.email,
			);

			const previousActive = next.activeIndex;
			const previousFamilies = JSON.stringify(next.activeIndexByFamily ?? {});
			writeFamilyIndexes(next, desiredIndex);
			normalizeStoredFamilyIndexes(next);
			if (previousActive !== next.activeIndex) {
				changed = true;
			}
			if (previousFamilies !== JSON.stringify(next.activeIndexByFamily ?? {})) {
				changed = true;
			}
		} else {
			normalizeStoredFamilyIndexes(next);
			log.debug("Skipped Codex CLI active selection overwrite due to newer local state", {
				operation: "reconcile-storage",
				outcome: "local-newer",
			});
		}

		incrementCodexCliMetric(changed ? "reconcileChanges" : "reconcileNoops");
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
			storage: next,
			changed,
		};
	} catch (error) {
		incrementCodexCliMetric("reconcileFailures");
		log.warn("Codex CLI reconcile failed", {
			operation: "reconcile-storage",
			outcome: "error",
			error: String(error),
		});
		return { storage: current, changed: false };
	}
}

export function getActiveSelectionForFamily(
	storage: AccountStorageV3,
	family: ModelFamily,
): number {
	const count = storage.accounts.length;
	if (count === 0) return 0;
	const raw = storage.activeIndexByFamily?.[family];
	const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : storage.activeIndex;
	return Math.max(0, Math.min(candidate, count - 1));
}
