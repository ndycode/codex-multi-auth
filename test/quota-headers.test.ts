import { describe, expect, it, vi } from "vitest";

import {
	formatCodexQuotaLine,
	parseCodexQuotaSnapshot,
	parseResetAtMs,
} from "../lib/runtime/quota-headers.js";

describe("runtime quota headers", () => {
	it("returns null when no quota headers are present", () => {
		expect(parseCodexQuotaSnapshot(new Headers(), 200)).toBeNull();
	});

	it("parses reset-after, plan type, and active limit from quota headers", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-22T09:00:00.000Z"));

		const snapshot = parseCodexQuotaSnapshot(
			new Headers({
				"x-codex-primary-used-percent": "32",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-after-seconds": "120",
				"x-codex-secondary-used-percent": "64",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-at": "2026-03-22T12:00:00.000Z",
				"x-codex-plan-type": " plus ",
				"x-codex-active-limit": "4",
			}),
			429,
		);

		expect(snapshot).toMatchObject({
			status: 429,
			planType: "plus",
			activeLimit: 4,
			primary: {
				usedPercent: 32,
				windowMinutes: 300,
				resetAtMs: new Date("2026-03-22T09:02:00.000Z").getTime(),
			},
			secondary: {
				usedPercent: 64,
				windowMinutes: 10080,
				resetAtMs: new Date("2026-03-22T12:00:00.000Z").getTime(),
			},
		});
		vi.useRealTimers();
	});

	it("parses reset-at values expressed as epoch seconds and milliseconds", () => {
		const epochSeconds = String(1_763_527_200);
		const epochMilliseconds = String(1_763_527_200_000);

		expect(
			parseResetAtMs(
				new Headers({ "x-codex-primary-reset-at": epochSeconds }),
				"x-codex-primary",
			),
		).toBe(1_763_527_200_000);
		expect(
			parseResetAtMs(
				new Headers({ "x-codex-primary-reset-at": epochMilliseconds }),
				"x-codex-primary",
			),
		).toBe(1_763_527_200_000);
		expect(
			parseResetAtMs(
				new Headers({ "x-codex-primary-reset-at": "not-a-date" }),
				"x-codex-primary",
			),
		).toBeUndefined();
	});

	it("formats quota lines with labels, reset times, plan, active limit, and rate limit markers", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-22T09:00:00.000Z"));

		const line = formatCodexQuotaLine({
			status: 429,
			planType: "pro",
			activeLimit: 4,
			primary: {
				windowMinutes: 1440,
				usedPercent: 60,
				resetAtMs: new Date("2026-03-22T10:00:00.000Z").getTime(),
			},
			secondary: {
				windowMinutes: 60,
				usedPercent: 10,
				resetAtMs: new Date("2026-03-23T11:00:00.000Z").getTime(),
			},
		});

		expect(line).toContain("1d");
		expect(line).toContain("1h");
		expect(line).toContain("resets");
		expect(line).toContain("plan:pro");
		expect(line).toContain("active:4");
		expect(line).toContain("rate-limited");
		vi.useRealTimers();
	});
});
