import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());

function readWorkflow(name: string): string {
	return readFileSync(join(projectRoot, ".github", "workflows", name), "utf-8");
}

function extractJobBlock(workflow: string, jobName: string): string {
	const start = workflow.indexOf(`  ${jobName}:`);
	if (start === -1) {
		throw new Error(`Missing workflow job: ${jobName}`);
	}
	const nextMatch = workflow
		.slice(start + 1)
		.match(/\n  [a-z0-9][a-z0-9-]*:\n/);
	const end = nextMatch ? start + 1 + nextMatch.index + 1 : workflow.length;
	return workflow.slice(start, end);
}

describe("CI workflow parity", () => {
	it("keeps push CI aligned with the PR release harness checks", () => {
		const ci = readWorkflow("ci.yml");
		const prCi = readWorkflow("pr-ci.yml");
		const requiredCommands = [
			"npm run typecheck:scripts",
			"npm run pack:check",
			"npm run vendor:verify",
		];

		for (const command of requiredCommands) {
			expect(prCi).toContain(command);
			expect(ci).toContain(command);
		}
	});

	it("keeps push CI using the same stale-run cancellation as PR CI", () => {
		const ci = readWorkflow("ci.yml");
		const prCi = readWorkflow("pr-ci.yml");

		expect(prCi).toContain("concurrency:");
		expect(prCi).toContain("cancel-in-progress: true");
		expect(ci).toContain("concurrency:");
		expect(ci).toContain("cancel-in-progress: true");
	});

	it("keeps Windows script typecheck coverage in push and PR CI", () => {
		const ci = readWorkflow("ci.yml");
		const prCi = readWorkflow("pr-ci.yml");
		const ciWindowsJob = extractJobBlock(ci, "scripts-windows");
		const prWindowsJob = extractJobBlock(prCi, "scripts-windows");

		expect(ciWindowsJob).toContain("runs-on: windows-latest");
		expect(ciWindowsJob).toContain("npm run typecheck:scripts");
		expect(prWindowsJob).toContain("runs-on: windows-latest");
		expect(prWindowsJob).toContain("npm run typecheck:scripts");
	});
});
