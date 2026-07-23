import { describe, expect, it } from "vitest";
import {
	collapseWhitespace,
	extractErrorMessageFromPayload,
	formatReasonLabel,
	formatResultSummary,
	joinStyledSegments,
	normalizeFailureDetail,
	parseStructuredErrorMessage,
	stringifyLogArgs,
} from "../lib/codex-manager/formatters/text-style.js";
import {
	formatAccountQuotaSummary,
	formatCompactQuotaSnapshot,
	formatQuotaSnapshotForDashboard,
	quotaCacheEntryToSnapshot,
	styleQuotaSummary,
} from "../lib/codex-manager/formatters/quota-formatters.js";
import type { DashboardDisplaySettings } from "../lib/dashboard-settings.js";
import type { QuotaCacheEntry } from "../lib/quota-cache.js";
import { formatQuotaResetAt } from "../lib/quota-probe.js";
import type { CodexQuotaSnapshot } from "../lib/quota-probe.js";
import {
	formatModelInspection,
	inspectRequestedModel,
} from "../lib/codex-manager/formatters/model-formatters.js";

// Unit contracts for the helpers that became public in the formatters/
// extraction. The CLI suites cover them end-to-end; these pin the
// per-function behavior so phase-3 decomposition regressions localize.
// Note: vitest runs without a TTY, so stylePromptText is a passthrough and
// the styled outputs below assert plain text deterministically.

describe("text-style formatters", () => {
	it("collapseWhitespace flattens runs and trims", () => {
		expect(collapseWhitespace("  a\t\n b   c ")).toBe("a b c");
		expect(collapseWhitespace("\n\t ")).toBe("");
	});

	it("formatReasonLabel humanizes snake_case reasons and drops empties", () => {
		expect(formatReasonLabel("invalid_grant")).toBe("invalid grant");
		expect(formatReasonLabel("  rate__limited  ")).toBe("rate limited");
		expect(formatReasonLabel("")).toBeUndefined();
		expect(formatReasonLabel(undefined)).toBeUndefined();
		expect(formatReasonLabel("___")).toBeUndefined();
	});

	it("extractErrorMessageFromPayload reads direct, coded, and nested shapes", () => {
		expect(
			extractErrorMessageFromPayload({ message: "token  expired" }),
		).toBe("token expired");
		// code is appended only when the message does not already mention it
		expect(
			extractErrorMessageFromPayload({
				message: "token expired",
				code: "invalid_grant",
			}),
		).toBe("token expired [invalid_grant]");
		expect(
			extractErrorMessageFromPayload({
				message: "Invalid_Grant: token expired",
				code: "invalid_grant",
			}),
		).toBe("Invalid_Grant: token expired");
		expect(
			extractErrorMessageFromPayload({
				error: { error: { message: "deeply nested" } },
			}),
		).toBe("deeply nested");
		expect(extractErrorMessageFromPayload(null)).toBeUndefined();
		expect(extractErrorMessageFromPayload("string")).toBeUndefined();
		expect(extractErrorMessageFromPayload({ code: "only_code" })).toBeUndefined();
	});

	it("parseStructuredErrorMessage finds JSON embedded in prose", () => {
		expect(
			parseStructuredErrorMessage('{"error":{"message":"quota hit"}}'),
		).toBe("quota hit");
		expect(
			parseStructuredErrorMessage(
				'refresh failed: {"message":"server says no"} (status 400)',
			),
		).toBe("server says no");
		expect(parseStructuredErrorMessage("plain text failure")).toBeUndefined();
		expect(parseStructuredErrorMessage("   ")).toBeUndefined();
	});

	it("normalizeFailureDetail prefers message, falls back to reason, bounds length", () => {
		expect(normalizeFailureDetail("boom", "invalid_grant")).toBe("boom");
		expect(normalizeFailureDetail(undefined, "invalid_grant")).toBe(
			"invalid grant",
		);
		expect(normalizeFailureDetail(undefined, undefined)).toBe(
			"refresh failed",
		);
		expect(normalizeFailureDetail("  ", "")).toBe("refresh failed");
		// structured payloads are unwrapped before display
		expect(
			normalizeFailureDetail('{"error":{"message":"unwrapped"}}', undefined),
		).toBe("unwrapped");
		const long = "x".repeat(300);
		const bounded = normalizeFailureDetail(long, undefined);
		expect(bounded).toHaveLength(260);
		expect(bounded.endsWith("...")).toBe(true);
	});

	it("joinStyledSegments and formatResultSummary render plain in non-TTY", () => {
		expect(joinStyledSegments([])).toBe("");
		expect(joinStyledSegments(["a", "b"])).toBe("a | b");
		expect(
			formatResultSummary([
				{ text: "saved", tone: "success" },
				{ text: "synced", tone: "muted" },
			]),
		).toBe("Result: saved | synced");
	});

	it("stringifyLogArgs serializes mixed args and survives cycles", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(stringifyLogArgs(["msg", { a: 1 }, cyclic])).toBe(
			'msg {"a":1} [object Object]',
		);
	});
});

describe("quota formatters", () => {
	it("styleQuotaSummary keeps rate-limited and percent segments, clamps to 100", () => {
		expect(styleQuotaSummary("5h 80% | weekly 15%")).toBe(
			"5h 80% | weekly 15%",
		);
		expect(styleQuotaSummary("rate-limited until 18:00")).toBe(
			"rate-limited until 18:00",
		);
		// \d{1,3} admits values over 100; the formatter clamps them
		expect(styleQuotaSummary("5h 150%")).toBe("5h 100%");
		expect(styleQuotaSummary("   ")).toBe("   ");
		expect(styleQuotaSummary("no percent here")).toBe("no percent here");
	});

	it("quotaCacheEntryToSnapshot maps exactly the snapshot fields", () => {
		const entry = {
			status: "ok",
			planType: "plus",
			model: "gpt-5.3-codex",
			fetchedAt: 123,
			primary: { usedPercent: 20, windowMinutes: 300, resetAtMs: 1000 },
			secondary: { usedPercent: 5, windowMinutes: 10080, resetAtMs: 2000 },
		} as unknown as QuotaCacheEntry;
		expect(quotaCacheEntryToSnapshot(entry)).toEqual({
			status: "ok",
			planType: "plus",
			model: "gpt-5.3-codex",
			primary: { usedPercent: 20, windowMinutes: 300, resetAtMs: 1000 },
			secondary: { usedPercent: 5, windowMinutes: 10080, resetAtMs: 2000 },
		});
	});
});

// Reset-timestamp rendering for `codex-multi-auth check` (issue #633).
// The reset clock is local-timezone by design, so expectations are derived
// from the same Intl calls the formatter uses instead of hardcoding a zone.
describe("compact quota reset timestamps", () => {
	// 2026-07-22T09:00 local; +2h stays on the same local day, +8d does not.
	const NOW = new Date(2026, 6, 22, 9, 0, 0).getTime();
	const SAME_DAY = NOW + 2 * 60 * 60 * 1000;
	const NEXT_WEEK = NOW + 8 * 24 * 60 * 60 * 1000;

	const localTime = (ms: number): string =>
		new Date(ms).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});

	const snapshot = (
		primaryReset: number | undefined,
		secondaryReset: number | undefined,
	): CodexQuotaSnapshot =>
		({
			status: "ok",
			planType: "plus",
			model: "gpt-5.3-codex",
			primary: {
				usedPercent: 0,
				windowMinutes: 300,
				resetAtMs: primaryReset,
			},
			secondary: {
				usedPercent: 7,
				windowMinutes: 10080,
				resetAtMs: secondaryReset,
			},
		}) as unknown as CodexQuotaSnapshot;

	it("formatQuotaResetAt uses local 24h time, adds the day when not today", () => {
		expect(formatQuotaResetAt(SAME_DAY, NOW)).toBe(localTime(SAME_DAY));
		expect(formatQuotaResetAt(NEXT_WEEK, NOW)).toBe(
			`${localTime(NEXT_WEEK)} on ${new Date(NEXT_WEEK).toLocaleDateString(
				undefined,
				{ month: "short", day: "2-digit" },
			)}`,
		);
	});

	it("formatQuotaResetAt rejects missing and malformed timestamps", () => {
		expect(formatQuotaResetAt(undefined, NOW)).toBeUndefined();
		expect(formatQuotaResetAt(0, NOW)).toBeUndefined();
		expect(formatQuotaResetAt(-1, NOW)).toBeUndefined();
		expect(formatQuotaResetAt(Number.NaN, NOW)).toBeUndefined();
		expect(formatQuotaResetAt(Number.POSITIVE_INFINITY, NOW)).toBeUndefined();
	});

	it("omits reset times unless the caller opts in", () => {
		expect(formatCompactQuotaSnapshot(snapshot(SAME_DAY, NEXT_WEEK), NOW)).toBe(
			"5h 100% | 7d 93%",
		);
	});

	it("appends a per-window reset time when showReset is set", () => {
		expect(
			formatCompactQuotaSnapshot(snapshot(SAME_DAY, NEXT_WEEK), NOW, {
				showReset: true,
			}),
		).toBe(
			`5h 100%, resets ${formatQuotaResetAt(SAME_DAY, NOW)} | 7d 93%, resets ${formatQuotaResetAt(NEXT_WEEK, NOW)}`,
		);
	});

	it("keeps the percentage when a reset timestamp is missing or malformed", () => {
		expect(
			formatCompactQuotaSnapshot(snapshot(undefined, Number.NaN), NOW, {
				showReset: true,
			}),
		).toBe("5h 100% | 7d 93%");
	});

	it("formatAccountQuotaSummary honors showReset the same way", () => {
		const entry = {
			status: "ok",
			planType: "plus",
			model: "gpt-5.3-codex",
			fetchedAt: NOW,
			primary: { usedPercent: 0, windowMinutes: 300, resetAtMs: SAME_DAY },
			secondary: { usedPercent: 7, windowMinutes: 10080, resetAtMs: undefined },
		} as unknown as QuotaCacheEntry;
		expect(formatAccountQuotaSummary(entry, NOW)).toBe("5h 100% | 7d 93%");
		expect(formatAccountQuotaSummary(entry, NOW, { showReset: true })).toBe(
			`5h 100%, resets ${formatQuotaResetAt(SAME_DAY, NOW)} | 7d 93%`,
		);
	});

	it("formatQuotaSnapshotForDashboard is the check line and shows resets", () => {
		const display = {
			showQuotaDetails: true,
		} as unknown as DashboardDisplaySettings;
		expect(
			formatQuotaSnapshotForDashboard(
				snapshot(SAME_DAY, NEXT_WEEK),
				display,
				NOW,
			),
		).toBe(
			`live session OK (5h 100%, resets ${formatQuotaResetAt(SAME_DAY, NOW)} | 7d 93%, resets ${formatQuotaResetAt(NEXT_WEEK, NOW)})`,
		);
	});

	it("formatQuotaSnapshotForDashboard stays bare when quota details are off", () => {
		const display = {
			showQuotaDetails: false,
		} as unknown as DashboardDisplaySettings;
		expect(
			formatQuotaSnapshotForDashboard(
				snapshot(SAME_DAY, NEXT_WEEK),
				display,
				NOW,
			),
		).toBe("live session OK");
	});

	it("styleQuotaSummary still tones segments that carry a reset suffix", () => {
		expect(styleQuotaSummary("5h 80%, resets 14:05 | 7d 15%")).toBe(
			"5h 80%, resets 14:05 | 7d 15%",
		);
		expect(styleQuotaSummary("7d 150%, resets 14:05 on Jul 29")).toBe(
			"7d 100%, resets 14:05 on Jul 29",
		);
		// A trailing "resets" with no value is not a reset suffix.
		expect(styleQuotaSummary("5h 80%, resets")).toBe("5h 80%, resets");
	});
});

describe("model formatters", () => {
	it("inspectRequestedModel reports remapping consistently", () => {
		const inspection = inspectRequestedModel("gpt-5.3-codex");
		expect(inspection.requested).toBe("gpt-5.3-codex");
		expect(inspection.remapped).toBe(
			inspection.requested !== inspection.normalized,
		);
		expect(typeof inspection.promptFamily).toBe("string");
		expect(typeof inspection.capabilities.toolSearch).toBe("boolean");
	});

	it("formatModelInspection shows the route and capability flags", () => {
		const plain = formatModelInspection({
			requested: "m",
			normalized: "m",
			remapped: false,
			promptFamily: inspectRequestedModel("gpt-5.3-codex").promptFamily,
			capabilities: { toolSearch: true, computerUse: false },
		});
		expect(plain).toContain("m | prompt family ");
		expect(plain).toContain("tool search yes");
		expect(plain).toContain("computer use no");

		const remapped = formatModelInspection({
			requested: "alias",
			normalized: "real",
			remapped: true,
			promptFamily: inspectRequestedModel("gpt-5.3-codex").promptFamily,
			capabilities: { toolSearch: false, computerUse: true },
		});
		expect(remapped).toContain("alias -> real");
	});
});
