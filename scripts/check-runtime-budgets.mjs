#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { evaluateRuntimeBudgetGate } from "./check-runtime-budgets-helpers.mjs";

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
	const { budgetEntriesCount, failures, reportLines } = evaluateRuntimeBudgetGate(
		benchmarkPayload,
		budgetPayload,
	);
	for (const line of reportLines) {
		console.log(line);
	}
	if (budgetEntriesCount === 0) {
		throw new Error(`No budget cases defined in ${budgetPath}`);
	}

	if (failures.length > 0) {
		console.error("Runtime benchmark regression gate failed:");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		process.exit(1);
	}

	console.log(`Runtime benchmark regression gate passed (${budgetEntriesCount} cases).`);
}

function isDirectExecution() {
	const scriptArg = process.argv[1];
	if (!scriptArg) return false;
	return import.meta.url === pathToFileURL(resolve(scriptArg)).href;
}

if (isDirectExecution()) {
	run().catch((error) => {
		console.error(
			`Runtime benchmark regression gate failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		process.exit(1);
	});
}
