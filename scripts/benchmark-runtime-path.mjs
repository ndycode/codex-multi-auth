#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { filterInput } from "../dist/lib/request/request-transformer.js";
import { cleanupToolDefinitions } from "../dist/lib/request/helpers/tool-utils.js";
import { AccountManager } from "../dist/lib/accounts.js";

function argValue(args, name) {
	const prefix = `${name}=`;
	const match = args.find((arg) => arg.startsWith(prefix));
	return match ? match.slice(prefix.length) : undefined;
}

function parsePositiveInt(value, fallback) {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function benchmarkCase(name, iterations, fn) {
	for (let i = 0; i < 5; i += 1) {
		fn();
	}
	const start = performance.now();
	for (let i = 0; i < iterations; i += 1) {
		fn();
	}
	const end = performance.now();
	return {
		name,
		iterations,
		avgMs: Number(((end - start) / iterations).toFixed(6)),
	};
}

function buildInputItems(size) {
	const items = [];
	for (let i = 0; i < size; i += 1) {
		items.push({
			type: "message",
			role: i % 2 === 0 ? "user" : "assistant",
			id: `msg_${i}`,
			content: [{ type: "input_text", text: `payload-${i}` }],
		});
		if (i % 40 === 0) {
			items.push({ type: "item_reference", id: `ref_${i}` });
		}
	}
	return items;
}

function buildTools(toolCount, propertyCount) {
	const tools = [];
	for (let i = 0; i < toolCount; i += 1) {
		const properties = {};
		const required = [];
		for (let j = 0; j < propertyCount; j += 1) {
			const key = `field_${j}`;
			properties[key] = { type: ["string", "null"], description: `property-${j}` };
			required.push(key);
		}
		required.push("ghost_field");
		tools.push({
			type: "function",
			function: {
				name: `tool_${i}`,
				parameters: {
					type: "object",
					properties,
					required,
					additionalProperties: false,
				},
			},
		});
	}
	return tools;
}

function buildManager(accountCount) {
	const now = Date.now();
	const accounts = [];
	for (let i = 0; i < accountCount; i += 1) {
		accounts.push({
			refreshToken: `rt_${i}`,
			accessToken: `at_${i}`,
			expiresAt: now + 3_600_000,
			accountId: `acct_${i}`,
			email: `user${i}@example.com`,
			enabled: true,
			addedAt: now,
			lastUsed: 0,
			rateLimitResetTimes: {},
		});
	}
	return new AccountManager(undefined, {
		version: 3,
		accounts,
		activeIndex: 0,
		activeIndexByFamily: {},
	});
}

function run() {
	const args = process.argv.slice(2);
	const iterations = parsePositiveInt(argValue(args, "--iterations"), 30);
	const outputPath = argValue(args, "--output");

	const inputSmall = buildInputItems(400);
	const inputLarge = buildInputItems(2000);
	const toolsMedium = buildTools(40, 12);
	const toolsLarge = buildTools(140, 25);

	const results = [
		benchmarkCase("filterInput_small", iterations, () => {
			const out = filterInput(inputSmall);
			if (!Array.isArray(out)) throw new Error("filterInput_small failed");
		}),
		benchmarkCase("filterInput_large", iterations, () => {
			const out = filterInput(inputLarge);
			if (!Array.isArray(out)) throw new Error("filterInput_large failed");
		}),
		benchmarkCase("cleanupToolDefinitions_medium", iterations, () => {
			const out = cleanupToolDefinitions(toolsMedium);
			if (!Array.isArray(out)) throw new Error("cleanupToolDefinitions_medium failed");
		}),
		benchmarkCase("cleanupToolDefinitions_large", iterations, () => {
			const out = cleanupToolDefinitions(toolsLarge);
			if (!Array.isArray(out)) throw new Error("cleanupToolDefinitions_large failed");
		}),
		benchmarkCase("accountHybridSelection_200", iterations, () => {
			const manager = buildManager(200);
			for (let i = 0; i < 200; i += 1) {
				manager.getCurrentOrNextForFamilyHybrid("codex", "gpt-5-codex", { pidOffsetEnabled: false });
			}
		}),
	];

	const payload = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		iterations,
		results,
	};

	if (outputPath) {
		const resolved = resolve(outputPath);
		return mkdir(dirname(resolved), { recursive: true }).then(() =>
			writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
		).then(() => {
			console.log(`Runtime benchmark written: ${resolved}`);
			console.log(JSON.stringify(payload, null, 2));
		});
	}

	console.log(JSON.stringify(payload, null, 2));
	return Promise.resolve();
}

run().catch((error) => {
	console.error(`Runtime benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
