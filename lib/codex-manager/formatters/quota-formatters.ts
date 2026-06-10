import type { DashboardDisplaySettings } from "../../dashboard-settings.js";
import type { QuotaCacheEntry } from "../../quota-cache.js";
import {
	type CodexQuotaSnapshot,
	fetchCodexQuotaSnapshot,
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
		const match = segment.match(/^([0-9a-zA-Z]+)\s+(\d{1,3})%$/);
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
		return `${stylePromptText(windowLabel, "muted")} ${stylePromptText(`${leftPercent}%`, tone)}`;
	});

	return joinStyledSegments(rendered);
}

export function formatQuotaSnapshotForDashboard(
	snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
	settings: DashboardDisplaySettings,
): string {
	if (!settings.showQuotaDetails) return "live session OK";
	return `live session OK (${formatCompactQuotaSnapshot(snapshot)})`;
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

export function formatCompactQuotaWindowLabel(
	windowMinutes: number | undefined,
): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

export function formatCompactQuotaPart(
	windowMinutes: number | undefined,
	usedPercent: number | undefined,
): string | null {
	const label = formatCompactQuotaWindowLabel(windowMinutes);
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return null;
	}
	const left = quotaLeftPercentFromUsed(usedPercent);
	return `${label} ${left}%`;
}

export function formatCompactQuotaSnapshot(
	snapshot: CodexQuotaSnapshot,
	now = Date.now(),
): string {
	const parts = [
		formatCompactQuotaPart(
			snapshot.primary.windowMinutes,
			snapshot.primary.usedPercent,
		),
		formatCompactQuotaPart(
			snapshot.secondary.windowMinutes,
			snapshot.secondary.usedPercent,
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
): string {
	const parts = [
		formatCompactQuotaPart(
			entry.primary.windowMinutes,
			entry.primary.usedPercent,
		),
		formatCompactQuotaPart(
			entry.secondary.windowMinutes,
			entry.secondary.usedPercent,
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
