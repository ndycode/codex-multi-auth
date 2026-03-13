import { clearCodexCliStateCache } from "./codex-cli/state.js";
import { MODEL_FAMILIES } from "./prompts/codex.js";
import { clearQuotaCache } from "./quota-cache.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	clearAccounts,
	clearFlaggedAccounts,
	type FlaggedAccountStorageV1,
	loadFlaggedAccounts,
	saveAccounts,
	saveFlaggedAccounts,
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
	flaggedStorage?: FlaggedAccountStorageV1;
}): Promise<DeleteAccountResult | null> {
	const target = options.storage.accounts.at(options.index);
	if (!target) return null;
	const flagged = options.flaggedStorage ?? (await loadFlaggedAccounts());
	const nextStorage: AccountStorageV3 = {
		...options.storage,
		accounts: options.storage.accounts.map((account) => ({ ...account })),
		activeIndexByFamily: { ...(options.storage.activeIndexByFamily ?? {}) },
	};
	const previousStorage: AccountStorageV3 = {
		...options.storage,
		accounts: options.storage.accounts.map((account) => ({ ...account })),
		activeIndexByFamily: { ...(options.storage.activeIndexByFamily ?? {}) },
	};

	nextStorage.accounts.splice(options.index, 1);
	clampActiveIndices(nextStorage);
	await saveAccounts(nextStorage);

	const remainingFlagged = flagged.accounts.filter(
		(account) => account.refreshToken !== target.refreshToken,
	);
	const removedFlaggedCount = flagged.accounts.length - remainingFlagged.length;
	let updatedFlagged = flagged;
	if (removedFlaggedCount > 0) {
		updatedFlagged = { ...flagged, accounts: remainingFlagged };
		try {
			await saveFlaggedAccounts(updatedFlagged);
		} catch (error) {
			await saveAccounts(previousStorage);
			throw error;
		}
	}

	return {
		storage: nextStorage,
		flagged: updatedFlagged,
		removedAccount: target,
		removedFlaggedCount,
	};
}

/**
 * Delete saved accounts without touching flagged/problem accounts, settings, or Codex CLI sync state.
 * Removes the accounts WAL and backups via the underlying storage helper.
 */
export async function deleteSavedAccounts(): Promise<DestructiveActionResult> {
	return {
		accountsCleared: await clearAccounts(),
		flaggedCleared: true,
		quotaCacheCleared: true,
	};
}

/**
 * Reset local multi-auth state: clears saved accounts, flagged/problem accounts, and quota cache.
 * Keeps unified settings and on-disk Codex CLI sync state; only the in-memory Codex CLI cache is cleared.
 */
export async function resetLocalState(): Promise<DestructiveActionResult> {
	const accountsCleared = await clearAccounts();
	const flaggedCleared = await clearFlaggedAccounts();
	const quotaCacheCleared = await clearQuotaCache();
	clearCodexCliStateCache();
	return {
		accountsCleared,
		flaggedCleared,
		quotaCacheCleared,
	};
}
