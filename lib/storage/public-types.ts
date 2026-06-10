/**
 * Current-version account storage shapes shared with external consumers via
 * the lib/storage.ts facade. Historical migration-era shapes (v1) live in
 * ./migrations.ts and are intentionally not exported from the facade.
 */

import type { ModelFamily } from "../request/helpers/model-map.js";
import type { AccountIdSource } from "../types.js";

export interface Workspace {
	id: string;
	name?: string;
	enabled: boolean;
	disabledAt?: number;
	isDefault?: boolean;
}

export type CooldownReason = "auth-failure" | "network-error" | "server-error" | "rate-limit";

export interface RateLimitStateV3 {
	[key: string]: number | undefined;
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
	lastSwitchReason?:
		| "rate-limit"
		| "initial"
		| "rotation"
		| "best"
		| "restore"
		| "manual";
	rateLimitResetTimes?: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	workspaces?: Workspace[];
	currentWorkspaceIndex?: number;
}

export interface AccountStorageV3 {
	version: 3;
	accounts: AccountMetadataV3[];
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
	/**
	 * Optional manual pin set by `codex-multi-auth switch <n>` (0-based).
	 * When set and valid, the runtime rotation proxy MUST route exclusively to
	 * this account regardless of session affinity or hybrid scoring. Cleared by
	 * `best` and the dedicated `unpin` command. See issue #474.
	 */
	pinnedAccountIndex?: number;
	/**
	 * Monotonically increasing counter bumped by user-initiated storage events
	 * (`switch`, `unpin`, `best`) so the long-running runtime proxy can detect
	 * a manual change and invalidate sticky session affinity. The proxy reads
	 * this from disk via the same mtime-cached path as `pinnedAccountIndex` and
	 * never bumps it from its own debounced writes. Treat `undefined` as
	 * logically zero. See issue #474.
	 */
	affinityGeneration?: number;
}

export interface FlaggedAccountMetadataV1 extends AccountMetadataV3 {
	flaggedAt: number;
	flaggedReason?: string;
	lastError?: string;
}

export interface FlaggedAccountStorageV1 {
	version: 1;
	accounts: FlaggedAccountMetadataV1[];
}
