import type { FailoverMode } from "../request/failure-policy.js";

export const MAX_RETRY_HINT_MS = 5 * 60 * 1000;

export type RuntimeMetrics = {
	startedAt: number;
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	rateLimitedResponses: number;
	serverErrors: number;
	networkErrors: number;
	userAborts: number;
	authRefreshFailures: number;
	emptyResponseRetries: number;
	accountRotations: number;
	sameAccountRetries: number;
	streamFailoverAttempts: number;
	streamFailoverRecoveries: number;
	streamFailoverCrossAccountRecoveries: number;
	cumulativeLatencyMs: number;
	lastRequestAt: number | null;
	lastError: string | null;
};

export function createRuntimeMetrics(now = Date.now()): RuntimeMetrics {
	return {
		startedAt: now,
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		rateLimitedResponses: 0,
		serverErrors: 0,
		networkErrors: 0,
		userAborts: 0,
		authRefreshFailures: 0,
		emptyResponseRetries: 0,
		accountRotations: 0,
		sameAccountRetries: 0,
		streamFailoverAttempts: 0,
		streamFailoverRecoveries: 0,
		streamFailoverCrossAccountRecoveries: 0,
		cumulativeLatencyMs: 0,
		lastRequestAt: null,
		lastError: null,
	};
}

export function parseFailoverMode(value: string | undefined): FailoverMode {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "aggressive") return "aggressive";
	if (normalized === "conservative") return "conservative";
	return "balanced";
}

export function parseEnvInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function clampRetryHintMs(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	const normalized = Math.floor(value);
	if (normalized <= 0) return null;
	return Math.min(normalized, MAX_RETRY_HINT_MS);
}

export function parseRetryAfterHintMs(
	headers: Headers,
	now = Date.now(),
): number | null {
	const retryAfterMsHeader = headers.get("retry-after-ms")?.trim();
	if (retryAfterMsHeader && /^\d+$/.test(retryAfterMsHeader)) {
		return clampRetryHintMs(Number.parseInt(retryAfterMsHeader, 10));
	}

	const retryAfterHeader = headers.get("retry-after")?.trim();
	if (retryAfterHeader && /^\d+$/.test(retryAfterHeader)) {
		return clampRetryHintMs(Number.parseInt(retryAfterHeader, 10) * 1000);
	}
	if (retryAfterHeader) {
		const retryAtMs = Date.parse(retryAfterHeader);
		if (Number.isFinite(retryAtMs)) {
			return clampRetryHintMs(retryAtMs - now);
		}
	}

	const resetAtHeader = headers.get("x-ratelimit-reset")?.trim();
	if (resetAtHeader && /^\d+$/.test(resetAtHeader)) {
		const resetRaw = Number.parseInt(resetAtHeader, 10);
		const resetAtMs = resetRaw < 10_000_000_000 ? resetRaw * 1000 : resetRaw;
		return clampRetryHintMs(resetAtMs - now);
	}

	return null;
}

export function sanitizeResponseHeadersForLog(
	headers: Headers,
): Record<string, string> {
	const allowed = new Set([
		"content-type",
		"x-request-id",
		"x-openai-request-id",
		"x-codex-plan-type",
		"x-codex-active-limit",
		"x-codex-primary-used-percent",
		"x-codex-primary-window-minutes",
		"x-codex-primary-reset-at",
		"x-codex-primary-reset-after-seconds",
		"x-codex-secondary-used-percent",
		"x-codex-secondary-window-minutes",
		"x-codex-secondary-reset-at",
		"x-codex-secondary-reset-after-seconds",
		"retry-after",
		"x-ratelimit-reset",
		"x-ratelimit-reset-requests",
	]);
	const sanitized: Record<string, string> = {};
	for (const [rawName, rawValue] of headers.entries()) {
		const name = rawName.toLowerCase();
		if (!allowed.has(name)) continue;
		sanitized[name] = rawValue;
	}
	return sanitized;
}
