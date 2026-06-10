import { formatWaitTime } from "../../accounts.js";
import type { ForecastAccountResult } from "../../forecast.js";
import type { ModelFamily } from "../../prompts/codex.js";
import { formatRateLimitEntry as formatAccountRateLimitEntry } from "../../runtime/account-status.js";
import { styleQuotaSummary } from "./quota-formatters.js";
import {
	collapseWhitespace,
	type PromptTone,
	stylePromptText,
} from "./text-style.js";

// Exported for unit tests: tone precedence (danger before warning) is
// security/UX-relevant — a failure whose text contains "unavailable" must
// render red, not be downgraded to yellow. See test/codex-manager-detail-tone.test.ts.
export function styleAccountDetailText(
	detail: string,
	fallbackTone: PromptTone = "muted",
): string {
	const compact = collapseWhitespace(detail);
	if (!compact) return stylePromptText("", fallbackTone);

	const quotaMatch = compact.match(/^(.*?)\(([^()]*\d{1,3}%[^()]*)\)(.*)$/);
	if (quotaMatch) {
		const prefix = (quotaMatch[1] ?? "").trim();
		const quota = (quotaMatch[2] ?? "").trim();
		const suffix = (quotaMatch[3] ?? "").trim();

		// danger wins across the WHOLE detail: a failure keyword anywhere — even
		// trapped inside the (…%) quota segment, e.g.
		// "signed in and working (live check failed: … 0%)" — must keep the prefix
		// red, never let a "working"/"ok" prefix render green over a real failure.
		const detailHasFailure = /failed|error|rate-limited/i.test(compact);
		const prefixTone: PromptTone = detailHasFailure
			? "danger"
			: /\b(ok|working|succeeded|valid)\b/i.test(prefix)
				? "success"
				: fallbackTone;
		const suffixTone: PromptTone =
			// danger wins first: a real failure whose text happens to contain
			// "unavailable"/"not available" (e.g. a 5xx "service not available")
			// must render red, not be downgraded to a yellow warning.
			/failed|error/i.test(suffix)
				? "danger"
				: /re-login|stale|warning|retry|fallback|unavailable|not available/i.test(suffix)
					? "warning"
					: "muted";

		const chunks: string[] = [];
		if (prefix) chunks.push(stylePromptText(prefix, prefixTone));
		chunks.push(`(${styleQuotaSummary(quota)})`);
		if (suffix) chunks.push(stylePromptText(suffix, suffixTone));
		return chunks.join(" ");
	}

	if (/rate-limited/i.test(compact)) return stylePromptText(compact, "danger");
	if (/failed|error/i.test(compact)) return stylePromptText(compact, "danger");
	if (/re-login|stale|warning|fallback|unavailable|not available/i.test(compact))
		return stylePromptText(compact, "warning");
	if (/\b(ok|working|succeeded|valid)\b/i.test(compact))
		return stylePromptText(compact, "success");
	return stylePromptText(compact, fallbackTone);
}

export function riskTone(
	level: ForecastAccountResult["riskLevel"],
): "success" | "warning" | "danger" {
	if (level === "low") return "success";
	if (level === "medium") return "warning";
	return "danger";
}

export function availabilityTone(
	availability: ForecastAccountResult["availability"],
): "success" | "warning" | "danger" {
	if (availability === "ready") return "success";
	if (availability === "delayed") return "warning";
	return "danger";
}

export function formatRateLimitEntry(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily = "codex",
): string | null {
	return formatAccountRateLimitEntry(account, now, formatWaitTime, family);
}

export function formatBackupSavedAt(mtimeMs: number): string {
	return new Date(mtimeMs).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
