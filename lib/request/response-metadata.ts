const MAX_RETRY_HINT_MS = 5 * 60 * 1000;

function clampRetryHintMs(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	const normalized = Math.floor(value);
	if (normalized <= 0) return null;
	return Math.min(normalized, MAX_RETRY_HINT_MS);
}

export function parseRetryAfterHintMs(headers: Headers): number | null {
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
			return clampRetryHintMs(retryAtMs - Date.now());
		}
	}

	const resetAtHeader = headers.get("x-ratelimit-reset")?.trim();
	if (resetAtHeader && /^\d+$/.test(resetAtHeader)) {
		const resetRaw = Number.parseInt(resetAtHeader, 10);
		const resetAtMs = resetRaw < 10_000_000_000 ? resetRaw * 1000 : resetRaw;
		return clampRetryHintMs(resetAtMs - Date.now());
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
