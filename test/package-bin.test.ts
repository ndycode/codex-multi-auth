import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("package bin entries", () => {
	it("exposes expected CLI bins", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			bin?: Record<string, string>;
			files?: string[];
			bundleDependencies?: string[];
		};
		expect(pkg.bin).toBeDefined();
		expect(pkg.bin?.codex).toBe("scripts/codex.js");
		expect(pkg.bin?.["codex-multi-auth"]).toBe("scripts/codex-multi-auth.js");
		expect(pkg.bin?.["codex-multi-auth-opencode-install"]).toBeUndefined();
		expect(pkg.files).toEqual(expect.arrayContaining(["vendor/codex-ai-plugin/", "vendor/codex-ai-sdk/"]));
		expect(pkg.bundleDependencies).toEqual(expect.arrayContaining(["@codex-ai/plugin"]));
	});
});

