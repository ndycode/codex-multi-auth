import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));

describe("canonical-home image_gen provider compatibility", () => {
	it("emits the exact actor-authorization marker override", () => {
		const source = readFileSync(join(testDir, "..", "scripts", "codex.js"), "utf8");
		const match = source.match(
			/function createRuntimeRotationProxyCanonicalCodexHome\([\s\S]*?\r?\n}\r?\n\r?\nfunction appendNodeImportOption/,
		);
		expect(match?.[0]).toContain(
			'`${providerTable}.http_headers.x-openai-actor-authorization=${configTomlModule.tomlStringLiteral("codex-multi-auth-local")}`',
		);
	});
});
