import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("eslint config", () => {
	it("keeps vendor directory ignored", () => {
		const content = readFileSync("eslint.config.js", "utf8");
		expect(content).toContain('"vendor/**"');
	});
});
