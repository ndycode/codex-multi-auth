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
 * Extract the accountId and email from the first snapshot marked active.
 *
 * @param snapshots - Array of Codex CLI account snapshots to search
 * @returns An object with `accountId` and `email` from the first snapshot where `isActive` is true; properties are `undefined` if no active snapshot is found
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
 * Decide whether Codex CLI's active-account selection should overwrite local selection.
 *
 * Prefers the source (Codex CLI) selection when its timestamp/version appears at least as recent
 * as the local selection write time (with a 1s tolerance); otherwise preserves the local selection.
 *
 * Concurrency assumptions: compares monotonic millisecond timestamps and assumes host clocks are
 * reasonably synchronized; ties favor Codex CLI. On Windows filesystems where timestamp resolution
 * may be coarse, the 1s tolerance reduces false negatives. Token-redaction: this decision only
 * uses numeric timestamps/versions and never inspects or logs tokens or other sensitive strings.
 *
 * @param state - Loaded Codex CLI state (may be null/undefined when not present)
 * @returns `true` if the Codex CLI selection should be applied (overwrite local), `false` otherwise.
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
 * Reconciles local account storage with Codex CLI state and returns the resulting storage and whether it changed.
 *
 * Loads Codex CLI state, upserts snapshots into a clone (or new) storage, and conditionally applies the Codex CLI active-account selection based on state vs local timestamps.
 *
 * Concurrency: callers should serialize invocations to avoid lost updates; the function does not perform inter-process file locking.
 *
 * Windows filesystem note: this function operates on in-memory storage objects only; any caller that persists the returned storage must handle Windows path and locking semantics.
 *
 * Token redaction: account snapshots containing tokens are consulted for matching and merging, but this function does not log raw tokens; callers must ensure persisted storage redacts or encrypts sensitive tokens.
 *
 * @param current - The current local AccountStorageV3, or `null` to start from an empty storage.
 * @returns An object with `storage` set to the reconciled AccountStorageV3 (or `null` if input was `null` and no accounts were produced) and `changed` set to `true` if the returned storage differs from `current`.
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
