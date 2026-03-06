#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Every threshold in config/performance-budgets.json is interpreted in milliseconds.
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

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonFile(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid ${label} json at ${path}: ${message}`);
	}
}

function main() {
	runBenchmark();
	if (!existsSync(budgetPath)) {
		throw new Error(`budget file not found: ${budgetPath}`);
	}
	if (!existsSync(outputPath)) {
		throw new Error(`benchmark report not found: ${outputPath}`);
	}
	const budgetsRaw = parseJsonFile(budgetPath, "budget");
	if (!isRecord(budgetsRaw)) {
		throw new Error(`invalid budget json at ${budgetPath}: root must be an object`);
	}
	const reportRaw = parseJsonFile(outputPath, "benchmark report");
	const results = isRecord(reportRaw) && Array.isArray(reportRaw.results) ? reportRaw.results : [];
	const violations = [];
	const seen = new Set();

	for (const result of results) {
		if (!isRecord(result) || typeof result.name !== "string") {
			continue;
		}
		seen.add(result.name);
		const budget = budgetsRaw[result.name];
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
	for (const [name, budgetMs] of Object.entries(budgetsRaw)) {
		if (typeof budgetMs !== "number") continue;
		if (!seen.has(name)) {
			violations.push({
				name,
				avgMs: null,
				budgetMs,
				reason: "missing benchmark metric",
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
