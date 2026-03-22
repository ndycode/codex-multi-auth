import { describe, expect, it } from "vitest";
import {
	formatDashboardSettingState,
	formatMenuLayoutMode,
	formatMenuQuotaTtl,
	formatMenuSortMode,
} from "../lib/codex-manager/dashboard-formatters.js";

describe("dashboard-formatters", () => {
	it("formats dashboard toggle states", () => {
		expect(formatDashboardSettingState(true)).toBe("[x]");
		expect(formatDashboardSettingState(false)).toBe("[ ]");
	});

	it("formats sort mode labels", () => {
		expect(formatMenuSortMode("ready-first")).toBe("Ready-First");
		expect(formatMenuSortMode("manual")).toBe("Manual");
	});

	it("formats layout mode labels", () => {
		expect(formatMenuLayoutMode("expanded-rows")).toBe("Expanded Rows");
		expect(formatMenuLayoutMode("compact-details")).toBe(
			"Compact + Details Pane",
		);
	});

	it("formats quota ttl values across minute, second, and millisecond branches", () => {
		expect(formatMenuQuotaTtl(120_000)).toBe("2m");
		expect(formatMenuQuotaTtl(5_000)).toBe("5s");
		expect(formatMenuQuotaTtl(500)).toBe("500ms");
		expect(formatMenuQuotaTtl(1_500)).toBe("1500ms");
	});
});
