import { describe, expect, it } from "vitest";
import {
	buildMarkdownReport,
	renderDashboardHtml,
} from "../scripts/bench-format/render.mjs";

const summary = {
	meta: {
		generatedAt: "2026-03-22T00:00:00.000Z",
		preset: "codex-core",
		models: ["gpt-5-codex"],
		tasks: ["task-1"],
		modes: ["patch", "replace", "hashline", "hashline_v2"],
		runCount: 1,
		warmupCount: 0,
	},
	rows: [
		{
			modelId: "gpt-5-codex",
			displayName: "GPT-5 Codex",
			modes: {
				patch: { accuracyPct: 90, wallMsP50: 1000, tokensTotalP50: 100 },
				replace: { accuracyPct: 85, wallMsP50: 1100, tokensTotalP50: 90 },
				hashline: { accuracyPct: 88, wallMsP50: 1050, tokensTotalP50: 95 },
				hashline_v2: { accuracyPct: 92, wallMsP50: 980, tokensTotalP50: 80 },
			},
		},
	],
	failures: [],
};

describe("bench format renderer", () => {
	it("builds markdown report with leaderboard content", () => {
		const markdown = buildMarkdownReport(summary as never);
		expect(markdown).toContain("# Code Edit Format Benchmark");
		expect(markdown).toContain("## Leaderboard (Accuracy First)");
		expect(markdown).toContain("GPT-5 Codex");
	});

	it("renders dashboard html with embedded model data", () => {
		const html = renderDashboardHtml(summary as never);
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("Code Edit Format Benchmark");
		expect(html).toContain("GPT-5 Codex");
		expect(html).toContain("deltaVsReplaceHashline");
	});
});
