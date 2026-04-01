import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());

function readWorkflow(name: string): string {
	return readFileSync(join(projectRoot, ".github", "workflows", name), "utf-8");
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
});
