#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = process.cwd();
const outputPath = resolve(projectRoot, ".tmp", "runtime-budget-report.json");
const budgetPath = resolve(projectRoot, "config", "performance-budgets.json");

function runBenchmark() {
	if (!existsSync(resolve(projectRoot, ".tmp"))) {
		mkdirSync(resolve(projectRoot, ".tmp"), { recursive: true });
	}
	execFileSync(
		process.execPath,
		["scripts/benchmark-runtime-path.mjs", "--iterations=10", `--output=${outputPath}`],
		{
			cwd: projectRoot,
			stdio: "pipe",
			encoding: "utf8",
		},
	);
}

function main() {
	runBenchmark();
	const budgets = JSON.parse(readFileSync(budgetPath, "utf8"));
	const report = JSON.parse(readFileSync(outputPath, "utf8"));
	const violations = [];

	for (const result of report.results ?? []) {
		const budget = budgets[result.name];
		if (typeof budget !== "number") continue;
		if (typeof result.avgMs !== "number") continue;
		if (result.avgMs > budget) {
			violations.push({
				name: result.name,
				avgMs: result.avgMs,
				budgetMs: budget,
			});
		}
	}

	const payload = {
		command: "performance-budget-check",
		generatedAt: new Date().toISOString(),
		reportPath: outputPath,
		violations,
		status: violations.length === 0 ? "pass" : "fail",
	};
	console.log(JSON.stringify(payload, null, 2));
	if (violations.length > 0) {
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error(
		`performance-budget-check failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}
