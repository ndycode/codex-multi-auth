import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readLibFile(relativePath: string): string {
	return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function importSpecifiers(source: string): string[] {
	return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
}

describe("module boundaries", () => {
	// `lib/types.ts` is the base types layer. `lib/schemas.ts` imports
	// `lib/request/helpers/model-map.ts`, and `lib/types.ts` imports
	// `lib/schemas.ts` -- so if `lib/types.ts` reached back into `lib/request/**`
	// it would close an import cycle. `import-x/no-cycle` does not catch this on
	// its own, because model-map itself no longer imports the types layer.
	it("keeps lib/types.ts out of the lib/request/** layer", () => {
		const specifiers = importSpecifiers(readLibFile("lib/types.ts"));
		const offenders = specifiers.filter((specifier) =>
			specifier.includes("request/"),
		);
		expect(offenders).toEqual([]);
	});

	it("sources the reasoning-effort types from the leaf constants module", () => {
		const specifiers = importSpecifiers(readLibFile("lib/types.ts"));
		expect(specifiers).toContain("./constants.js");
	});

	it("keeps lib/constants.ts a leaf with no intra-repo imports", () => {
		const specifiers = importSpecifiers(readLibFile("lib/constants.ts"));
		const internal = specifiers.filter((specifier) => specifier.startsWith("."));
		expect(internal).toEqual([]);
	});
});
