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
import { isRecord } from "./record-utils.js";

interface AccountMetadataV1 {
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

/**
 * A version-1 row that may carry V3-era fields. Hybrid files are real: the
 * flagged-accounts store is `version: 1` with full V3 rows, and hand-edited or
 * partially-written files can carry fields the V1 schema never declared. The
 * V3 path keeps unknown fields verbatim, so the migration must not silently
 * drop them (e.g. a `rateLimitResetTimes` map discarded on upgrade would make
 * a rate-limited account look immediately available — see the M3 pin in
 * test/storage-parser.test.ts).
 */
type AccountMetadataV1Input = AccountMetadataV1 & {
	rateLimitResetTimes?: unknown;
};

export function migrateV1ToV3(v1: AccountStorageV1): AccountStorageV3 {
	const now = nowMs();
	const rawActiveIndexByFamily = isRecord(
		(v1 as { activeIndexByFamily?: unknown }).activeIndexByFamily,
	)
		? ((v1 as { activeIndexByFamily?: unknown })
				.activeIndexByFamily as Record<string, unknown>)
		: {};
	return {
		version: 3,
		accounts: v1.accounts
			.filter(
				(account): account is AccountMetadataV1Input =>
					account !== null && typeof account === "object",
			)
			.map((account) => {
				const {
					rateLimitResetTime,
					rateLimitResetTimes: existingResets,
					...passthrough
				} = account;
				// A pre-existing V3 map wins per key; the legacy scalar only fills
				// families the map does not already cover.
				const rateLimitResetTimes: RateLimitStateV3 = {};
				if (isRecord(existingResets)) {
					for (const [family, value] of Object.entries(existingResets)) {
						if (typeof value === "number") {
							rateLimitResetTimes[family] = value;
						}
					}
				}
				if (typeof rateLimitResetTime === "number" && rateLimitResetTime > now) {
					for (const family of MODEL_FAMILIES) {
						rateLimitResetTimes[family] ??= rateLimitResetTime;
					}
				}
				return {
					...passthrough,
					rateLimitResetTimes:
						Object.keys(rateLimitResetTimes).length > 0
							? rateLimitResetTimes
							: undefined,
				};
			}),
		activeIndex: v1.activeIndex,
		activeIndexByFamily: Object.fromEntries(
			MODEL_FAMILIES.map((family) => {
				const perFamily = rawActiveIndexByFamily[family];
				return [
					family,
					typeof perFamily === "number" ? perFamily : v1.activeIndex,
				];
			}),
		) as Partial<Record<ModelFamily, number>>,
	};
}
