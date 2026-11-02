/**
 * Rate limiting utilities for account management.
 * Extracted from accounts.ts to reduce module size and improve cohesion.
 */

import { LUNA_RESERVE_MODEL, RATE_LIMIT_CACHE_TTL_MS } from "../constants.js";
import { nowMs } from "../utils.js";
import type { ModelFamily } from "../prompts/codex.js";
import { extractAccountId, nativeWorkspaceIdentity } from "../auth/token-utils.js";
import type { CodexCliMirror } from "../storage/public-types.js";

export type BaseQuotaKey = ModelFamily;
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

export type RateLimitReason = "quota" | "tokens" | "concurrent" | "unknown";

export function parseRateLimitReason(code: string | undefined): RateLimitReason {
	if (!code) return "unknown";
	const lc = code.toLowerCase();
	if (lc.includes("quota") || lc.includes("usage_limit")) return "quota";
	if (lc.includes("token") || lc.includes("tpm") || lc.includes("rpm")) return "tokens";
	if (lc.includes("concurrent") || lc.includes("parallel")) return "concurrent";
	return "unknown";
}

export function getQuotaKey(family: ModelFamily, model?: string | null): QuotaKey {
	if (model) {
		return `${family}:${model}`;
	}
	return family;
}

export function clampNonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return value < 0 ? 0 : Math.floor(value);
}

export interface RateLimitState {
	[key: string]: number | undefined;
}

export interface RateLimitedEntity {
	rateLimitResetTimes: RateLimitState;
	accountId?: string;
	access?: string;
	accessToken?: string;
	codexCliMirror?: CodexCliMirror;
	workspaces?: { id: string }[];
	currentWorkspaceIndex?: number;
}

/** Persist workspace attribution independently of a legacy row's record identity. */
export function workspaceQuotaKey(key: string, workspaceId: string): string {
	return JSON.stringify(["workspace", workspaceId, key]);
}

export function selectedQuotaWorkspace(entity: Omit<RateLimitedEntity, "rateLimitResetTimes">): string | undefined {
	const access = entity.access ?? entity.accessToken;
	const selected = entity.workspaces?.length ? entity.workspaces[entity.currentWorkspaceIndex ?? 0]?.id : entity.accountId ?? extractAccountId(access);
	return nativeWorkspaceIdentity({ ...entity, access }, selected);
}

/** The selected workspace's bounds plus legacy unscoped bounds for diagnostics. */
export function selectedQuotaLimits(entity: Partial<RateLimitedEntity>): RateLimitState {
	const result: RateLimitState = {};
	const workspace = selectedQuotaWorkspace(entity);
	for (const [key, until] of Object.entries(entity.rateLimitResetTimes ?? {})) {
		let quotaKey = key;
		if (key.startsWith('["workspace",')) {
			try {
				const parts: unknown = JSON.parse(key);
				if (!Array.isArray(parts) || parts.length !== 3 || parts[1] !== workspace || typeof parts[2] !== "string") continue;
				quotaKey = parts[2];
			} catch { continue; }
		}
		if (until !== undefined) result[quotaKey] = Math.max(result[quotaKey] ?? 0, until);
	}
	return result;
}

export function quotaResetTime(entity: RateLimitedEntity, key: string, workspaceId = selectedQuotaWorkspace(entity)): number {
	return Math.max(entity.rateLimitResetTimes[key] ?? 0,
		workspaceId ? entity.rateLimitResetTimes[workspaceQuotaKey(key, workspaceId)] ?? 0 : 0);
}

/**
 * Bound legacy persisted routing deadlines once, when loading the account.
 * These deadlines schedule revalidation; quota snapshots retain upstream resets.
 * Never call this on every selection: that would slide the deadline indefinitely.
 */
export function boundRateLimitCache(
	times: RateLimitState,
	now = nowMs(),
): RateLimitState {
	return Object.fromEntries(
		Object.entries(times).map(([key, until]) => [
			key,
			typeof until === "number"
				? Math.min(until, now + RATE_LIMIT_CACHE_TTL_MS)
				: until,
		]),
	);
}

export function clearExpiredRateLimits(entity: RateLimitedEntity): void {
	const now = nowMs();
	const keys = Object.keys(entity.rateLimitResetTimes);
	for (const key of keys) {
		const resetTime = entity.rateLimitResetTimes[key];
		if (resetTime !== undefined && now >= resetTime) {
			delete entity.rateLimitResetTimes[key];
		}
	}
}

/**
 * Remove every rate-limit reset entry from `entity`, regardless of whether the
 * window has expired. Unlike {@link clearExpiredRateLimits}, this drops
 * still-future entries too. Used by the stale-runtime recovery path to give a
 * reloaded account pool a clean slate so transient state persisted to disk
 * cannot keep the pool wedged (issue #606).
 */
export function clearAllRateLimits(entity: RateLimitedEntity): void {
	const keys = Object.keys(entity.rateLimitResetTimes);
	for (const key of keys) {
		delete entity.rateLimitResetTimes[key];
	}
}

export function isRateLimitedForQuotaKey(entity: RateLimitedEntity, key: QuotaKey): boolean {
	return nowMs() < quotaResetTime(entity, key);
}

export function isRateLimitedForFamily(
	entity: RateLimitedEntity,
	family: ModelFamily,
	model?: string | null,
): boolean {
	clearExpiredRateLimits(entity);

	if (model) {
		const modelKey = getQuotaKey(family, model);
		if (isRateLimitedForQuotaKey(entity, modelKey)) {
			return true;
		}
		// Luna Reserve is independently metered. Ordinary Luna/Codex family
		// exhaustion must not suppress a separately available reserve allowance.
		if (model === LUNA_RESERVE_MODEL) return false;
	}

	const baseKey = getQuotaKey(family);
	return isRateLimitedForQuotaKey(entity, baseKey);
}

export function formatWaitTime(ms: number): string {
	if (Number.isNaN(ms) || ms === Number.POSITIVE_INFINITY) return "unknown";
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
