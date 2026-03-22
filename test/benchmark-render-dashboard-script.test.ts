import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(
	process.cwd(),
	"scripts",
	"benchmark-render-dashboard.mjs",
);
const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("benchmark render dashboard script", () => {
	it("renders HTML from a minimal summary file", () => {
		const root = mkdtempSync(path.join(tmpdir(), "bench-render-"));
		tempRoots.push(root);
		const inputPath = path.join(root, "summary.json");
		const outputPath = path.join(root, "dashboard.html");

		writeFileSync(
			inputPath,
			JSON.stringify(
				{
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
								patch: {
									accuracyPct: 90,
									wallMsP50: 1000,
									tokensTotalP50: 100,
								},
								replace: {
									accuracyPct: 85,
									wallMsP50: 1100,
									tokensTotalP50: 90,
								},
								hashline: {
									accuracyPct: 88,
									wallMsP50: 1050,
									tokensTotalP50: 95,
								},
								hashline_v2: {
									accuracyPct: 92,
									wallMsP50: 980,
									tokensTotalP50: 80,
								},
							},
						},
					],
					failures: [],
				},
				null,
				2,
			),
			"utf8",
		);

		const result = spawnSync(
			process.execPath,
			[scriptPath, `--input=${inputPath}`, `--output=${outputPath}`],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Dashboard written:");
		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("Code Edit Format Benchmark");
		expect(html).toContain("GPT-5 Codex");
	});
});
