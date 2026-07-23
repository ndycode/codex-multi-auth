import type { DashboardDisplaySettings } from "../../dashboard-settings.js";
import type { QuotaCacheEntry } from "../../quota-cache.js";
import {
	type CodexQuotaSnapshot,
	fetchCodexQuotaSnapshot,
	formatQuotaResetAt,
	formatQuotaSnapshotLine,
} from "../../quota-probe.js";
import {
	isQuotaCacheEntryExhausted,
	quotaLeftPercentFromUsed,
} from "../../quota-readiness.js";
import { quotaToneFromLeftPercent } from "../../ui/format.js";
import {
	collapseWhitespace,
	joinStyledSegments,
	stylePromptText,
} from "./text-style.js";

export function styleQuotaSummary(summary: string): string {
	const normalized = collapseWhitespace(summary);
	if (!normalized) return stylePromptText(summary, "muted");
	const segments = normalized
		.split("|")
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return stylePromptText(normalized, "muted");

	const rendered = segments.map((segment) => {
		if (/rate-limited/i.test(segment)) {
			return stylePromptText(segment, "danger");
		}
		const match = segment.match(
			/^([0-9a-zA-Z]+)\s+(\d{1,3})%(,\s*resets\s+\S.*)?$/,
		);
		if (!match) {
			return stylePromptText(segment, "muted");
		}
		const windowLabel = match[1] ?? "";
		const leftPercent = Math.max(
			0,
			Math.min(100, Number.parseInt(match[2] ?? "", 10)),
		);
		if (!Number.isFinite(leftPercent)) {
			return stylePromptText(segment, "muted");
		}
		const tone = quotaToneFromLeftPercent(leftPercent);
		const resetSuffix = match[3]
			? stylePromptText(match[3], "muted")
			: "";
		return `${stylePromptText(windowLabel, "muted")} ${stylePromptText(`${leftPercent}%`, tone)}${resetSuffix}`;
	});

	return joinStyledSegments(rendered);
}

/**
 * Render the per-account health line printed by `codex-multi-auth check`.
 *
 * `check` is the only caller, and unlike the dashboard rows and account menu it
 * prints one account per line with no width pressure, so it opts into the
 * absolute reset clock for each quota window.
 */
export function formatQuotaSnapshotForDashboard(
	snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
	settings: DashboardDisplaySettings,
	now = Date.now(),
): string {
	if (!settings.showQuotaDetails) return "live session OK";
	return `live session OK (${formatCompactQuotaSnapshot(snapshot, now, { showReset: true })})`;
}

export function quotaCacheEntryToSnapshot(
	entry: QuotaCacheEntry,
): CodexQuotaSnapshot {
	return {
		status: entry.status,
		planType: entry.planType,
		model: entry.model,
		primary: {
			usedPercent: entry.primary.usedPercent,
			windowMinutes: entry.primary.windowMinutes,
			resetAtMs: entry.primary.resetAtMs,
		},
		secondary: {
			usedPercent: entry.secondary.usedPercent,
			windowMinutes: entry.secondary.windowMinutes,
			resetAtMs: entry.secondary.resetAtMs,
		},
	};
}

function formatCompactQuotaWindowLabel(
	windowMinutes: number | undefined,
): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

/**
 * Options shared by the compact quota formatters.
 *
 * `showReset` is opt-in so that space-constrained surfaces (dashboard rows, the
 * account menu, forecast lines) keep their existing single-line width, while
 * `codex-multi-auth check` can append the absolute reset time.
 */
export interface CompactQuotaFormatOptions {
	showReset?: boolean;
}

function formatCompactQuotaPart(
	windowMinutes: number | undefined,
	usedPercent: number | undefined,
	resetAtMs: number | undefined,
	options: CompactQuotaFormatOptions,
	now: number,
): string | null {
	const label = formatCompactQuotaWindowLabel(windowMinutes);
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return null;
	}
	const left = quotaLeftPercentFromUsed(usedPercent);
	const part = `${label} ${left}%`;
	if (!options.showReset) return part;
	// A missing or malformed reset timestamp must never drop the percentage.
	const reset = formatQuotaResetAt(resetAtMs, now);
	return reset ? `${part}, resets ${reset}` : part;
}

export function formatCompactQuotaSnapshot(
	snapshot: CodexQuotaSnapshot,
	now = Date.now(),
	options: CompactQuotaFormatOptions = {},
): string {
	const parts = [
		formatCompactQuotaPart(
			snapshot.primary.windowMinutes,
			snapshot.primary.usedPercent,
			snapshot.primary.resetAtMs,
			options,
			now,
		),
		formatCompactQuotaPart(
			snapshot.secondary.windowMinutes,
			snapshot.secondary.usedPercent,
			snapshot.secondary.resetAtMs,
			options,
			now,
		),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (snapshot.status === 429) {
		parts.push("rate-limited");
	}
	if (isQuotaCacheEntryExhausted(snapshot, now)) {
		parts.push("quota-exhausted");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(snapshot);
}

export function formatAccountQuotaSummary(
	entry: QuotaCacheEntry,
	now = Date.now(),
	options: CompactQuotaFormatOptions = {},
): string {
	const parts = [
		formatCompactQuotaPart(
			entry.primary.windowMinutes,
			entry.primary.usedPercent,
			entry.primary.resetAtMs,
			options,
			now,
		),
		formatCompactQuotaPart(
			entry.secondary.windowMinutes,
			entry.secondary.usedPercent,
			entry.secondary.resetAtMs,
			options,
			now,
		),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (entry.status === 429) {
		parts.push("rate-limited");
	}
	if (isQuotaCacheEntryExhausted(entry, now)) {
		parts.push("quota-exhausted");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(quotaCacheEntryToSnapshot(entry));
}
