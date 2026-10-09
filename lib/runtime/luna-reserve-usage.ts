import { AccountManager } from "../accounts.js";
import { LUNA_RESERVE_MODEL } from "../constants.js";
import {
	parseLunaReserveRateLimits,
	type LunaReserveSnapshot,
} from "../luna-reserve.js";
import type { AccountStorageV3 } from "../storage.js";
import { codexCliAccountIdFor } from "../auth/token-utils.js";
import { isRecord } from "../utils.js";
import { resetTargetForStoredAccount } from "./account-reset-credits.js";
import { nativeRateLimitsRpc } from "./native-rate-limits.js";
import { ensureFreshAccessToken } from "./rotation-token-refresh.js";

export type LunaReserveUsageByAccount = Record<number, LunaReserveSnapshot>;

/**
 * Read Luna Reserve usage through the same isolated native app-server bridge
 * used for reset credits. Failures are per-account: one stale/revoked account
 * never prevents other rows from reporting their Reserve percentage.
 */
export async function refreshLunaReserveUsage(
	storage: AccountStorageV3,
	now = Date.now,
): Promise<LunaReserveUsageByAccount> {
	const manager = new AccountManager(undefined, storage);
	const result: LunaReserveUsageByAccount = {};
	try {
		for (let index = 0; index < storage.accounts.length; index += 1) {
			const stored = storage.accounts[index];
			const target = stored ? resetTargetForStoredAccount(stored) : null;
			const account = manager.getAccountByIndex(index);
			if (!stored || !target || !account || account.enabled === false) continue;
			try {
				const fresh = await ensureFreshAccessToken({
					accountManager: manager,
					account,
					family: "gpt-5.2",
					model: LUNA_RESERVE_MODEL,
					now: now(),
					tokenRefreshSkewMs: 60_000,
					tokenInvalidationCooldownMs: 300_000,
				});
				if (!fresh.ok) continue;
				const auth = {
					accessToken: fresh.accessToken,
					accountId: target.accountId,
					expiresAt: fresh.account.expires ?? 0,
					codexCliMirror: account.codexCliMirror,
				};
				const sentAccountId = codexCliAccountIdFor(auth, fresh.accessToken) ?? target.accountId;
				const reply = await nativeRateLimitsRpc(auth, "account/rateLimits/read", {
					supportsLunaReserve: true,
					excludeResetCreditDetails: true,
				});
				if (
					isRecord(reply) &&
					typeof reply.accountId === "string" &&
					reply.accountId !== sentAccountId
				) {
					continue;
				}
				result[index] = parseLunaReserveRateLimits(reply, now());
			} catch {
				// Best-effort usage reporting; callers still emit normal quota.
			}
		}
		return result;
	} finally {
		await manager.flushPendingSave();
	}
}
