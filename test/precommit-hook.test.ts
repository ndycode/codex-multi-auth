import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());

describe("pre-commit hook contract", () => {
	it("stays fail-fast when it runs multiple commands", () => {
		const hook = readFileSync(join(projectRoot, ".husky/pre-commit"), "utf-8");
		const commandLines = hook
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));
		// Plain sh runs sequential lines unconditionally and exits with the last
		// command's status, so a multi-line hook must opt into set -e or a lint
		// failure followed by a clean typecheck would not block the commit.
		if (commandLines.length > 1) {
			expect(hook, "multi-line hook must set -e to stay fail-fast").toContain(
				"set -e",
			);
		}
		// Commands on a single line must be chained with && (";" ignores the
		// first command's failure) for the same reason.
		for (const line of commandLines) {
			expect(
				line,
				`hook line must not chain commands with ';': ${line}`,
			).not.toContain(";");
		}
	});

	it("does not use the deprecated husky v9 bootstrap (removed in husky v10)", () => {
		const hook = readFileSync(join(projectRoot, ".husky/pre-commit"), "utf-8");
		expect(hook).not.toContain("husky.sh");
	});
});
