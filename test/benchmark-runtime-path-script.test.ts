import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const tempRoots: string[] = [];
const scriptPath = "scripts/benchmark-runtime-path.mjs";

afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			await removeWithRetry(root, { recursive: true, force: true });
		}
	}
});

function createRuntimeBenchmarkFixture(): {
	root: string;
	scriptCopy: string;
} {
	const root = mkdtempSync(join(tmpdir(), "runtime-bench-fixture-"));
	tempRoots.push(root);

	const scriptsDir = join(root, "scripts");
	const distRequestDir = join(root, "dist", "lib", "request");
	const distRequestHelpersDir = join(distRequestDir, "helpers");
	const distLibDir = join(root, "dist", "lib");

	mkdirSync(scriptsDir, { recursive: true });
	mkdirSync(distRequestHelpersDir, { recursive: true });
	mkdirSync(distLibDir, { recursive: true });

	const scriptCopy = join(scriptsDir, "benchmark-runtime-path.mjs");
	copyFileSync(join(process.cwd(), scriptPath), scriptCopy);

	writeFileSync(
		join(distRequestDir, "request-transformer.js"),
		"export function filterInput(input) { return Array.isArray(input) ? input : []; }\n",
		"utf8",
	);
	writeFileSync(
		join(distRequestHelpersDir, "tool-utils.js"),
		"export function cleanupToolDefinitions(tools) { return Array.isArray(tools) ? tools : []; }\n",
		"utf8",
	);
	writeFileSync(
		join(distLibDir, "accounts.js"),
		[
			"export class AccountManager {",
			"  constructor(_, storage) { this.storage = storage; }",
			"  getCurrentOrNextForFamilyHybrid() { return this.storage.accounts[0] ?? null; }",
			"}",
		].join("\n"),
		"utf8",
	);

	return { root, scriptCopy };
}

describe("benchmark runtime path script", () => {
	it("writes a benchmark payload with expected result names", () => {
		const { root, scriptCopy } = createRuntimeBenchmarkFixture();
		const outputPath = join(root, "runtime-benchmark.json");

		const result = spawnSync(
			process.execPath,
			[scriptCopy, "--iterations=1", `--output=${outputPath}`],
			{ cwd: root, encoding: "utf8", timeout: 15_000 },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Runtime benchmark written:");

		const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
			iterations: number;
			results: Array<{ name: string }>;
		};
		expect(payload.iterations).toBe(1);
		expect(payload.results.map((entry) => entry.name)).toEqual([
			"filterInput_small",
			"filterInput_large",
			"cleanupToolDefinitions_medium",
			"cleanupToolDefinitions_large",
			"accountHybridSelection_200",
		]);
	});
});
