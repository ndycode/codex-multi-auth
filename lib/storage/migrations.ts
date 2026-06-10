/**
 * Storage migration utilities for account data format upgrades.
 * Extracted from storage.ts to reduce module size.
 *
 * Historical migration-era shapes (v1) live here and are intentionally not
 * exported from the lib/storage.ts facade; current-version shapes live in
 * ./public-types.ts.
 */

import { MODEL_FAMILIES, type ModelFamily } from "../request/helpers/model-map.js";
import type { AccountIdSource } from "../types.js";
import type {
	AccountStorageV3,
	CooldownReason,
	RateLimitStateV3,
} from "./public-types.js";

export interface AccountMetadataV1 {
	accountId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	email?: string;
	refreshToken: string;
	/** Optional cached access token (Codex CLI parity). */
	accessToken?: string;
	/** Optional access token expiry timestamp (ms since epoch). */
	expiresAt?: number;
	enabled?: boolean;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?:
		| "rate-limit"
		| "initial"
		| "rotation"
		| "best"
		| "restore"
		| "manual";
	rateLimitResetTime?: number;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
}

export interface AccountStorageV1 {
	version: 1;
	accounts: AccountMetadataV1[];
	activeIndex: number;
}

function nowMs(): number {
	return Date.now();
}

export function migrateV1ToV3(v1: AccountStorageV1): AccountStorageV3 {
	const now = nowMs();
	return {
		version: 3,
		accounts: v1.accounts.map((account) => {
			const rateLimitResetTimes: RateLimitStateV3 = {};
			if (typeof account.rateLimitResetTime === "number" && account.rateLimitResetTime > now) {
				for (const family of MODEL_FAMILIES) {
					rateLimitResetTimes[family] = account.rateLimitResetTime;
				}
			}
			return {
				accountId: account.accountId,
				accountIdSource: account.accountIdSource,
				accountLabel: account.accountLabel,
				email: account.email,
				refreshToken: account.refreshToken,
				accessToken: account.accessToken,
				expiresAt: account.expiresAt,
				enabled: account.enabled,
				addedAt: account.addedAt,
				lastUsed: account.lastUsed,
				lastSwitchReason: account.lastSwitchReason,
				rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
				coolingDownUntil: account.coolingDownUntil,
				cooldownReason: account.cooldownReason,
			};
		}),
		activeIndex: v1.activeIndex,
		activeIndexByFamily: Object.fromEntries(
			MODEL_FAMILIES.map((family) => [family, v1.activeIndex]),
		) as Partial<Record<ModelFamily, number>>,
	};
}
