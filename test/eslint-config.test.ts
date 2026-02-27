import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

describe("eslint config", () => {
	it("keeps vendor directory ignored", async () => {
		const configPath = fileURLToPath(new URL("../eslint.config.js", import.meta.url));
		const eslint = new ESLint({ overrideConfigFile: configPath });
		expect(await eslint.isPathIgnored("vendor/fixture.ts")).toBe(true);
		expect(await eslint.isPathIgnored("lib/config.ts")).toBe(false);
	}, 15000);
});
