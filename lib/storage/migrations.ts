/**
 * Storage migration utilities for account data format upgrades.
 * Extracted from storage.ts to reduce module size.
 */

import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import type { AccountIdSource } from "../types.js";

export type CooldownReason = "auth-failure" | "network-error";

export interface RateLimitStateV3 {
	[key: string]: number | undefined;
}

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
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	rateLimitResetTime?: number;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
}

export interface AccountStorageV1 {
	version: 1;
	accounts: AccountMetadataV1[];
	activeIndex: number;
}

export interface AccountMetadataV3 {
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
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	rateLimitResetTimes?: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
}

export interface AccountStorageV3 {
	version: 3;
	accounts: AccountMetadataV3[];
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
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
