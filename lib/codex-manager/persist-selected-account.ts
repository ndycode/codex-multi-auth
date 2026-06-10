import {
	extractAccountEmail,
	extractAccountId,
	sanitizeEmail,
} from "../accounts.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import { queuedRefresh } from "../refresh-queue.js";
import type { PersistedSwitchReason } from "../schemas.js";
import {
	type AccountStorageV3,
	getStoragePath,
	readAffinityGenerationFromDisk,
	saveAccounts,
} from "../storage.js";
import {
	applyTokenAccountIdentity,
	hasUsableAccessToken,
} from "./account-credentials.js";
import { normalizeFailureDetail } from "./formatters/index.js";
import { saveAccountsWithRetry } from "./forecast-report-shared.js";

/**
 * Persist an explicit account selection and sync it to the Codex CLI state.
 *
 * Shared by the `switch` and `best` commands (injected via their deps objects)
 * and by the login dashboard's backup-restore flow. Moved verbatim out of
 * lib/codex-manager.ts (audit roadmap §4.1.1 phase 3).
 */
export async function persistAndSyncSelectedAccount({
	storage,
	targetIndex,
	parsed,
	switchReason,
	initialSyncIdToken,
	preserveActiveIndexByFamily = false,
	setPin = false,
	clearPin = false,
	bumpAffinityGeneration = false,
}: {
	storage: AccountStorageV3;
	targetIndex: number;
	parsed: number;
	switchReason: PersistedSwitchReason;
	initialSyncIdToken?: string;
	preserveActiveIndexByFamily?: boolean;
	setPin?: boolean;
	clearPin?: boolean;
	bumpAffinityGeneration?: boolean;
}): Promise<{ synced: boolean; wasDisabled: boolean }> {
	const account = storage.accounts[targetIndex];
	if (!account) {
		throw new Error(`Account ${parsed} not found.`);
	}

	const shouldPreserveActiveIndexByFamily =
		preserveActiveIndexByFamily &&
		!!storage.activeIndexByFamily &&
		targetIndex === storage.activeIndex;
	storage.activeIndex = targetIndex;
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	if (shouldPreserveActiveIndexByFamily) {
		const maxIndex = Math.max(0, storage.accounts.length - 1);
		for (const family of MODEL_FAMILIES) {
			const raw = storage.activeIndexByFamily[family];
			const candidate =
				typeof raw === "number" && Number.isFinite(raw) ? raw : targetIndex;
			storage.activeIndexByFamily[family] = Math.max(
				0,
				Math.min(candidate, maxIndex),
			);
		}
	} else {
		storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
		for (const family of MODEL_FAMILIES) {
			storage.activeIndexByFamily[family] = targetIndex;
		}
	}
	const wasDisabled = account.enabled === false;
	if (wasDisabled) {
		account.enabled = true;
	}
	const switchNow = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken = initialSyncIdToken;

	if (!hasUsableAccessToken(account, switchNow)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type === "success") {
			const tokenAccountId = extractAccountId(refreshResult.access);
			const nextEmail = sanitizeEmail(
				extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
			if (account.refreshToken !== refreshResult.refresh) {
				account.refreshToken = refreshResult.refresh;
			}
			if (account.accessToken !== refreshResult.access) {
				account.accessToken = refreshResult.access;
			}
			if (account.expiresAt !== refreshResult.expires) {
				account.expiresAt = refreshResult.expires;
			}
			if (nextEmail && nextEmail !== account.email) {
				account.email = nextEmail;
			}
			applyTokenAccountIdentity(account, tokenAccountId);
			syncAccessToken = refreshResult.access;
			syncRefreshToken = refreshResult.refresh;
			syncExpiresAt = refreshResult.expires;
			syncIdToken = refreshResult.idToken;
		} else {
			console.warn(
				`Switch validation refresh failed for account ${parsed}: ${normalizeFailureDetail(refreshResult.message, refreshResult.reason)}.`,
			);
		}
	}

	account.lastUsed = switchNow;
	account.lastSwitchReason = switchReason;
	if (setPin) {
		storage.pinnedAccountIndex = targetIndex;
	} else if (clearPin) {
		delete storage.pinnedAccountIndex;
	}
	if (bumpAffinityGeneration) {
		// Re-read the on-disk generation right before saving so concurrent CLI
		// processes don't lose increments via lost-update on the load+mutate
		// pair. Math.max keeps the counter monotonically increasing — extra
		// bumps are harmless (just an additional affinity invalidation), but a
		// missed bump can let the proxy cling to the wrong account. The save
		// itself is serialized by withStorageLock; this only narrows the
		// lost-update window. See issue #474.
		const diskGeneration = readAffinityGenerationFromDisk(getStoragePath());
		const inMemoryGeneration = storage.affinityGeneration ?? 0;
		storage.affinityGeneration =
			Math.max(inMemoryGeneration, diskGeneration) + 1;
	}
	await saveAccountsWithRetry(storage, saveAccounts);

	const synced = await setCodexCliActiveSelection({
		accountId: account.accountId,
		email: account.email,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
	return { synced, wasDisabled };
}
