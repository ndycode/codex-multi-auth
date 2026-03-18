import { clearCodexCliStateCache } from "./codex-cli/state.js";
import { MODEL_FAMILIES } from "./prompts/codex.js";
import { clearQuotaCache } from "./quota-cache.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	clearFlaggedAccounts,
	findMatchingAccountIndex,
	type FlaggedAccountStorageV1,
	getStoragePath,
	loadFlaggedAccounts,
	snapshotAccountStorage,
	snapshotAndClearAccounts,
	withAccountAndFlaggedStorageTransaction,
} from "./storage.js";

export const DESTRUCTIVE_ACTION_COPY = {
	deleteSavedAccounts: {
		label: "Delete Saved Accounts",
		typedConfirm:
			"Type DELETE to delete saved accounts only (saved accounts: delete; flagged/problem accounts, settings, and Codex CLI sync state: keep): ",
		confirm:
			"Delete saved accounts? (Saved accounts: delete. Flagged/problem accounts: keep. Settings: keep. Codex CLI sync state: keep.)",
		stage: "Deleting saved accounts only",
		completed:
			"Deleted saved accounts. Saved accounts deleted; flagged/problem accounts, settings, and Codex CLI sync state kept.",
	},
	resetLocalState: {
		label: "Reset Local State",
		typedConfirm:
			"Type RESET to reset local state (saved accounts + flagged/problem accounts: delete; settings + Codex CLI sync state: keep; quota cache: clear): ",
		confirm:
			"Reset local state? (Saved accounts: delete. Flagged/problem accounts: delete. Settings: keep. Codex CLI sync state: keep. Quota cache: clear.)",
		stage: "Clearing saved accounts, flagged/problem accounts, and quota cache",
		completed:
			"Reset local state. Saved accounts, flagged/problem accounts, and quota cache cleared; settings and Codex CLI sync state kept.",
	},
} as const;

export function clampActiveIndices(storage: AccountStorageV3): void {
	const count = storage.accounts.length;
	const baseIndex =
		typeof storage.activeIndex === "number" &&
		Number.isFinite(storage.activeIndex)
			? storage.activeIndex
			: 0;

	if (count === 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		return;
	}

	storage.activeIndex = Math.max(0, Math.min(baseIndex, count - 1));
	const activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const rawIndex = activeIndexByFamily[family];
		const fallback = storage.activeIndex;
		const clamped = Math.max(
			0,
			Math.min(
				typeof rawIndex === "number" && Number.isFinite(rawIndex)
					? rawIndex
					: fallback,
				count - 1,
			),
		);
		activeIndexByFamily[family] = clamped;
	}
	storage.activeIndexByFamily = activeIndexByFamily;
}

function rebaseActiveIndicesAfterDelete(
	storage: AccountStorageV3,
	removedIndex: number,
): void {
	if (storage.activeIndex > removedIndex) {
		storage.activeIndex -= 1;
	}
	const activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const rawIndex = activeIndexByFamily[family];
		if (typeof rawIndex === "number" && Number.isFinite(rawIndex) && rawIndex > removedIndex) {
			activeIndexByFamily[family] = rawIndex - 1;
		}
	}
	storage.activeIndexByFamily = activeIndexByFamily;
}

export interface DeleteAccountResult {
	storage: AccountStorageV3;
	flagged: FlaggedAccountStorageV1;
	removedAccount: AccountMetadataV3;
	removedFlaggedCount: number;
}

export interface DestructiveActionResult {
	accountsCleared: boolean;
	flaggedCleared: boolean;
	quotaCacheCleared: boolean;
}

export async function deleteAccountAtIndex(options: {
	storage: AccountStorageV3;
	index: number;
}): Promise<DeleteAccountResult | null> {
	const requestedTarget = options.storage.accounts.at(options.index);
	if (!requestedTarget) return null;

	return withAccountAndFlaggedStorageTransaction(async (current, persist) => {
		if (!current) {
			return null;
		}
		const sourceStorage = current;
		const targetIndex = findMatchingAccountIndex(
			sourceStorage.accounts,
			requestedTarget,
		);
		if (targetIndex === undefined || targetIndex < 0) {
			return null;
		}
		const target = sourceStorage.accounts[targetIndex];
		if (!target) {
			return null;
		}

		const flagged = await loadFlaggedAccounts();
		await snapshotAccountStorage({
			reason: "delete-account",
			failurePolicy: "error",
			storage: sourceStorage,
			storagePath: getStoragePath(),
		});

		const nextStorage: AccountStorageV3 = {
			...sourceStorage,
			accounts: sourceStorage.accounts.map((account) => ({ ...account })),
			activeIndexByFamily: { ...(sourceStorage.activeIndexByFamily ?? {}) },
		};

		nextStorage.accounts.splice(targetIndex, 1);
		rebaseActiveIndicesAfterDelete(nextStorage, targetIndex);
		clampActiveIndices(nextStorage);

		const remainingFlagged = flagged.accounts.filter(
			(account) => account.refreshToken !== target.refreshToken,
		);
		const removedFlaggedCount =
			flagged.accounts.length - remainingFlagged.length;
		const updatedFlagged =
			removedFlaggedCount > 0
				? { ...flagged, accounts: remainingFlagged }
				: flagged;

		await persist(nextStorage, updatedFlagged);

		return {
			storage: nextStorage,
			flagged: updatedFlagged,
			removedAccount: target,
			removedFlaggedCount,
		};
	});
}

/**
 * Delete saved accounts without touching flagged/problem accounts, settings, or Codex CLI sync state.
 * Removes the accounts WAL and backups via the underlying storage helper.
 */
export async function deleteSavedAccounts(): Promise<DestructiveActionResult> {
	return {
		accountsCleared: await snapshotAndClearAccounts("delete-saved-accounts"),
		flaggedCleared: false,
		quotaCacheCleared: false,
	};
}

/**
 * Reset local multi-auth state: clears saved accounts, flagged/problem accounts, and quota cache.
 * Keeps unified settings and on-disk Codex CLI sync state; only the in-memory Codex CLI cache is cleared.
 */
export async function resetLocalState(): Promise<DestructiveActionResult> {
	const accountsCleared = await snapshotAndClearAccounts("reset-local-state");
	const flaggedCleared = await clearFlaggedAccounts();
	const quotaCacheCleared = await clearQuotaCache();
	clearCodexCliStateCache();
	return {
		accountsCleared,
		flaggedCleared,
		quotaCacheCleared,
	};
}
