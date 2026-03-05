#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

function argValue(args, name) {
	const prefix = `${name}=`;
	const match = args.find((arg) => arg.startsWith(prefix));
	return match ? match.slice(prefix.length) : undefined;
}

async function readJson(path) {
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw);
}

async function run() {
	const args = process.argv.slice(2);
	const inputPath = resolve(argValue(args, "--input") ?? ".tmp/perf/runtime-ci.json");
	const budgetPath = resolve(
		argValue(args, "--budget") ?? "scripts/runtime-bench-budgets.json",
	);

	const benchmarkPayload = await readJson(inputPath);
	const budgetPayload = await readJson(budgetPath);
	const benchmarkResults = new Map(
		Array.isArray(benchmarkPayload.results)
			? benchmarkPayload.results
					.filter((entry) => entry && typeof entry.name === "string")
					.map((entry) => [entry.name, entry])
			: [],
	);
	const budgetEntries = Object.entries(budgetPayload.cases ?? {});
	if (budgetEntries.length === 0) {
		throw new Error(`No budget cases defined in ${budgetPath}`);
	}

	const failures = [];
	for (const [caseName, caseBudget] of budgetEntries) {
		const result = benchmarkResults.get(caseName);
		if (!result) {
			failures.push(`missing benchmark case: ${caseName}`);
			continue;
		}

		const maxAvgMs =
			typeof caseBudget?.maxAvgMs === "number" && Number.isFinite(caseBudget.maxAvgMs)
				? caseBudget.maxAvgMs
				: null;
		if (maxAvgMs === null) {
			failures.push(`invalid budget maxAvgMs for case: ${caseName}`);
			continue;
		}

		const avgMs = typeof result.avgMs === "number" ? result.avgMs : NaN;
		if (!Number.isFinite(avgMs)) {
			failures.push(`invalid avgMs for case: ${caseName}`);
			continue;
		}

		const ratio = avgMs / maxAvgMs;
		const ratioLabel = `${(ratio * 100).toFixed(1)}%`;
		console.log(
			`${caseName}: avg=${avgMs.toFixed(6)}ms budget=${maxAvgMs.toFixed(6)}ms (${ratioLabel})`,
		);
		if (avgMs > maxAvgMs) {
			failures.push(
				`${caseName}: avg ${avgMs.toFixed(6)}ms exceeds budget ${maxAvgMs.toFixed(6)}ms`,
			);
		}
	}

	if (failures.length > 0) {
		console.error("Runtime benchmark regression gate failed:");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		process.exit(1);
	}

	console.log(`Runtime benchmark regression gate passed (${budgetEntries.length} cases).`);
}

run().catch((error) => {
	console.error(
		`Runtime benchmark regression gate failed: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
	process.exit(1);
});
