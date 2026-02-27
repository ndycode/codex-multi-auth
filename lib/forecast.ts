import { formatAccountLabel, formatWaitTime } from "./accounts.js";
import type { CodexQuotaSnapshot } from "./quota-probe.js";
import type { AccountMetadataV3 } from "./storage.js";
import type { TokenFailure } from "./types.js";

export type ForecastAvailability = "ready" | "delayed" | "unavailable";
export type ForecastRiskLevel = "low" | "medium" | "high";

export interface ForecastAccountInput {
	index: number;
	account: AccountMetadataV3;
	isCurrent: boolean;
	now: number;
	refreshFailure?: TokenFailure;
	liveQuota?: CodexQuotaSnapshot;
}

export interface ForecastAccountResult {
	index: number;
	label: string;
	isCurrent: boolean;
	availability: ForecastAvailability;
	riskScore: number;
	riskLevel: ForecastRiskLevel;
	waitMs: number;
	reasons: string[];
	hardFailure: boolean;
	disabled: boolean;
}

export interface ForecastRecommendation {
	recommendedIndex: number | null;
	reason: string;
}

export interface ForecastSummary {
	total: number;
	ready: number;
	delayed: number;
	unavailable: number;
	highRisk: number;
}

/**
 * Normalizes a numeric risk score into the 0–100 range.
 *
 * @param score - The input risk score to normalize
 * @returns An integer between 0 and 100; returns 100 if `score` is not a finite number
 */
function clampRisk(score: number): number {
	if (!Number.isFinite(score)) return 100;
	return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Map a numeric risk score to a qualitative risk level.
 *
 * Uses thresholds: `high` for scores >= 75, `medium` for scores >= 40, otherwise `low`.
 * No concurrency, filesystem, or token-redaction side effects.
 *
 * @param score - Risk score (typically 0–100)
 * @returns `'high'` if `score` >= 75, `'medium'` if `score` >= 40, `'low'` otherwise
 */
function getRiskLevel(score: number): ForecastRiskLevel {
	if (score >= 75) return "high";
	if (score >= 40) return "medium";
	return "low";
}

/**
 * Returns the earliest future rate-limit reset timestamp for the given account and family scope.
 *
 * This function examines the account's rateLimitResetTimes and selects the smallest timestamp
 * greater than `now` whose key matches `family` or starts with `family:`. It does not perform I/O
 * and does not expose token values.
 *
 * Concurrency: callers should provide a stable snapshot of `account` if concurrent mutation is possible.
 * Filesystem: no filesystem interactions; behavior is unaffected by Windows path semantics.
 * Token redaction: only numeric reset timestamps are read or returned; no secrets are exposed.
 *
 * @param account - Account metadata containing `rateLimitResetTimes`
 * @param now - Current time in milliseconds since epoch used to filter past resets
 * @param family - Family scope to match (default: "codex")
 * @returns The earliest future reset timestamp (ms since epoch) for the family, or `null` if none found
 */
function getRateLimitResetTimeForFamily(
	account: AccountMetadataV3,
	now: number,
	family = "codex",
): number | null {
	const times = account.rateLimitResetTimes;
	if (!times) return null;

	let minReset: number | null = null;
	const prefix = `${family}:`;
	for (const [key, value] of Object.entries(times)) {
		if (typeof value !== "number") continue;
		if (value <= now) continue;
		if (key !== family && !key.startsWith(prefix)) continue;
		if (minReset === null || value < minReset) {
			minReset = value;
		}
	}
	return minReset;
}

/**
 * Compute the remaining wait time until live quota resets based on a quota snapshot.
 *
 * Examines `primary.resetAtMs` and `secondary.resetAtMs` in the provided `snapshot` and returns the
 * largest positive remaining milliseconds until those reset timestamps relative to `now`.
 *
 * This function is pure and has no side effects; it does not access the filesystem, perform I/O,
 * or expose token contents.
 *
 * @param snapshot - A Codex quota snapshot with `primary.resetAtMs` and `secondary.resetAtMs` (epoch ms or non-number)
 * @param now - Current time in milliseconds since epoch used to compute remaining durations
 * @returns The maximum remaining milliseconds until a future reset, or `0` if there are no future resets
 */
function getLiveQuotaWaitMs(snapshot: CodexQuotaSnapshot, now: number): number {
	const waits: number[] = [];
	for (const resetAt of [snapshot.primary.resetAtMs, snapshot.secondary.resetAtMs]) {
		if (typeof resetAt !== "number") continue;
		if (!Number.isFinite(resetAt)) continue;
		const remaining = resetAt - now;
		if (remaining > 0) waits.push(remaining);
	}
	return waits.length > 0 ? Math.max(...waits) : 0;
}

/**
 * Format quota usage as a human-readable percentage string for a given label.
 *
 * @param label - The quota label to include in the message
 * @param usedPercent - The percent of quota used; if not a finite number the function returns `null`
 * @returns A string like "`<label> quota X% used`" where `X` is rounded and clamped to 0–100, or `null` if `usedPercent` is invalid
 */
function describeQuotaUsage(label: string, usedPercent: number | undefined): string | null {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
	const bounded = Math.max(0, Math.min(100, Math.round(usedPercent)));
	return `${label} quota ${bounded}% used`;
}

/**
 * Determines whether a token refresh failure should be treated as a hard failure.
 *
 * @param failure - Token failure details; the function inspects `reason`, `statusCode`, and `message` to decide severity.
 * @returns `true` if the failure represents a hard refresh failure (e.g., missing refresh, 401 status, or specific 400 messages indicating invalid or revoked grants), `false` otherwise.
 */
export function isHardRefreshFailure(failure: TokenFailure): boolean {
	if (failure.reason === "missing_refresh") return true;
	if (failure.statusCode === 401) return true;
	if (failure.statusCode !== 400) return false;
	const message = (failure.message ?? "").toLowerCase();
	return (
		message.includes("invalid_grant") ||
		message.includes("invalid refresh") ||
		message.includes("token has been revoked")
	);
}

/**
 * Append a formatted wait-time message to the provided reasons list when a positive wait exists.
 *
 * @param reasons - Mutable array of reason strings to append to.
 * @param prefix - Text prefix for the wait message (e.g., "Rate limit resets in"). This function does not redact sensitive content; callers must ensure `prefix` contains no sensitive tokens.
 * @param waitMs - Wait duration in milliseconds; messages are appended only when this value is greater than zero.
 *
 * Concurrency: callers are responsible for synchronizing access to `reasons` if it's shared across threads or async tasks.
 * Filesystem: no filesystem interaction; behavior is consistent on Windows.
 */
function appendWaitReason(reasons: string[], prefix: string, waitMs: number): void {
	if (waitMs <= 0) return;
	reasons.push(`${prefix} ${formatWaitTime(waitMs)}`);
}

/**
 * Evaluate a single account's readiness and risk for use in forecasting.
 *
 * @param input - Forecast input for one account; `now` is the current epoch ms used for timing calculations, `refreshFailure` (if present) is used to determine hard vs soft auth failures, and `liveQuota` (if present) is used to compute quota-based waits and risk adjustments.
 * @returns A ForecastAccountResult containing the account index and label, availability ("ready" | "delayed" | "unavailable"), normalized `riskScore` (0–100) and derived `riskLevel`, estimated `waitMs` until usable, accumulated human-readable `reasons`, and flags `hardFailure` and `disabled`.
 */
export function evaluateForecastAccount(input: ForecastAccountInput): ForecastAccountResult {
	const { account, index, isCurrent, now } = input;
	const reasons: string[] = [];
	let availability: ForecastAvailability = "ready";
	let riskScore = isCurrent ? -5 : 0;
	let waitMs = 0;
	let hardFailure = false;
	const disabled = account.enabled === false;

	if (disabled) {
		availability = "unavailable";
		riskScore += 95;
		reasons.push("account is disabled");
	}

	if (input.refreshFailure) {
		const hard = isHardRefreshFailure(input.refreshFailure);
		hardFailure = hard;
		const detail = input.refreshFailure.message ?? input.refreshFailure.reason ?? "refresh failed";
		if (hard) {
			availability = "unavailable";
			riskScore += 90;
			reasons.push(`hard auth failure: ${detail}`);
		} else {
			riskScore += 25;
			reasons.push(`refresh warning: ${detail}`);
		}
	}

	if (typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now) {
		const remaining = account.coolingDownUntil - now;
		waitMs = Math.max(waitMs, remaining);
		if (availability === "ready") availability = "delayed";
		riskScore += 45;
		appendWaitReason(reasons, "cooldown remaining", remaining);
	}

	const rateLimitResetAt = getRateLimitResetTimeForFamily(account, now, "codex");
	if (typeof rateLimitResetAt === "number") {
		const remaining = Math.max(0, rateLimitResetAt - now);
		waitMs = Math.max(waitMs, remaining);
		if (availability === "ready") availability = "delayed";
		riskScore += 35;
		appendWaitReason(reasons, "rate limit resets in", remaining);
	}

	const quota = input.liveQuota;
	if (quota) {
		if (quota.status === 429) {
			availability = availability === "unavailable" ? "unavailable" : "delayed";
			riskScore += 35;
			reasons.push("live probe returned 429");
		}
		const liveWait = getLiveQuotaWaitMs(quota, now);
		waitMs = Math.max(waitMs, liveWait);
		if (liveWait > 0 && availability === "ready") {
			availability = "delayed";
		}

		const primaryUsage = describeQuotaUsage("primary", quota.primary.usedPercent);
		if (primaryUsage) reasons.push(primaryUsage);
		const secondaryUsage = describeQuotaUsage("secondary", quota.secondary.usedPercent);
		if (secondaryUsage) reasons.push(secondaryUsage);

		const primaryUsed = quota.primary.usedPercent ?? 0;
		const secondaryUsed = quota.secondary.usedPercent ?? 0;
		if (primaryUsed >= 98 || secondaryUsed >= 98) {
			riskScore += 55;
		} else if (primaryUsed >= 90 || secondaryUsed >= 90) {
			riskScore += 35;
		} else if (primaryUsed >= 80 || secondaryUsed >= 80) {
			riskScore += 20;
		} else if (primaryUsed >= 70 || secondaryUsed >= 70) {
			riskScore += 10;
		}
	}

	const lastUsedAge = now - (account.lastUsed || 0);
	if (!Number.isFinite(lastUsedAge) || lastUsedAge < 0) {
		riskScore += 5;
	} else if (lastUsedAge > 7 * 24 * 60 * 60 * 1000) {
		riskScore += 10;
	}

	const finalRisk = clampRisk(riskScore);
	return {
		index,
		label: formatAccountLabel(account, index),
		isCurrent,
		availability,
		riskScore: finalRisk,
		riskLevel: getRiskLevel(finalRisk),
		waitMs: Math.max(0, Math.floor(waitMs)),
		reasons,
		hardFailure,
		disabled,
	};
}

/**
 * Evaluate multiple forecast account inputs and produce their corresponding results.
 *
 * @param inputs - Array of account inputs to evaluate; results preserve input ordering and indices.
 * @returns An array of ForecastAccountResult objects, one per input, in the same order as `inputs`.
 *
 * Concurrency: This function is synchronous and side-effect free; it is safe to call concurrently.
 * Filesystem: Performs no filesystem access and behaves identically on Windows and other platforms.
 * Token redaction: Does not log or mutate token values; any token-related data in inputs is not exposed or altered.
 */
export function evaluateForecastAccounts(inputs: ForecastAccountInput[]): ForecastAccountResult[] {
	return inputs.map((input) => evaluateForecastAccount(input));
}

/**
 * Orders two ForecastAccountResult objects for sorting by readiness, wait time, risk, current preference, then index.
 *
 * @param a - First forecast result to compare
 * @param b - Second forecast result to compare
 * @returns A negative number if `a` should come before `b`, a positive number if `a` should come after `b`, or `0` if they are equivalent in ordering
 */
function compareForecastResults(a: ForecastAccountResult, b: ForecastAccountResult): number {
	if (a.availability !== b.availability) {
		const rank: Record<ForecastAvailability, number> = {
			ready: 0,
			delayed: 1,
			unavailable: 2,
		};
		return rank[a.availability] - rank[b.availability];
	}

	if (a.availability === "delayed" && b.availability === "delayed" && a.waitMs !== b.waitMs) {
		return a.waitMs - b.waitMs;
	}

	if (a.riskScore !== b.riskScore) {
		return a.riskScore - b.riskScore;
	}

	if (a.isCurrent !== b.isCurrent) {
		return a.isCurrent ? -1 : 1;
	}

	return a.index - b.index;
}

/**
 * Selects the best account to recommend from a set of evaluated account results.
 *
 * This function returns a ForecastRecommendation with the chosen account index (or `null`) and a concise human-readable reason. Callers must supply up-to-date evaluation results; the function makes no concurrency guarantees. It does not access the filesystem (Windows path semantics do not affect its behavior). Reason strings never include raw tokens or secrets and are safe for logging.
 *
 * @param results - Array of evaluated account results to choose from
 * @returns The chosen ForecastRecommendation containing `recommendedIndex` (an account index or `null`) and a `reason` string
 */
export function recommendForecastAccount(results: ForecastAccountResult[]): ForecastRecommendation {
	const candidates = results.filter((result) => !result.disabled && !result.hardFailure);
	if (candidates.length === 0) {
		return {
			recommendedIndex: null,
			reason: "No healthy accounts are available. Run `codex auth login` to add a fresh account.",
		};
	}

	const sorted = [...candidates].sort(compareForecastResults);
	const best = sorted[0];
	if (!best) {
		return {
			recommendedIndex: null,
			reason: "No recommendation available.",
		};
	}

	if (best.availability === "ready") {
		return {
			recommendedIndex: best.index,
			reason: `Lowest risk ready account (${best.riskLevel}, score ${best.riskScore}).`,
		};
	}

	return {
		recommendedIndex: best.index,
		reason: `No account is immediately ready; pick shortest wait (${formatWaitTime(best.waitMs)}).`,
	};
}

/**
 * Summarizes an array of forecast results into aggregate counts.
 *
 * @param results - The list of ForecastAccountResult objects to summarize
 * @returns An object containing:
 *  - `total`: total number of results
 *  - `ready`: count with availability `"ready"`
 *  - `delayed`: count with availability `"delayed"`
 *  - `unavailable`: count with availability `"unavailable"`
 *  - `highRisk`: count with `riskLevel` `"high"`
 */
export function summarizeForecast(results: ForecastAccountResult[]): ForecastSummary {
	return {
		total: results.length,
		ready: results.filter((result) => result.availability === "ready").length,
		delayed: results.filter((result) => result.availability === "delayed").length,
		unavailable: results.filter((result) => result.availability === "unavailable").length,
		highRisk: results.filter((result) => result.riskLevel === "high").length,
	};
}

