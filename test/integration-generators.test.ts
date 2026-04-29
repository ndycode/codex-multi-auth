import { describe, expect, it } from "vitest";
import {
	generateIntegrationSnippet,
	generateIntegrationSnippets,
} from "../lib/integration-generators.js";

describe("integration generators", () => {
	it("generates deterministic snippets using CODEX_MULTI_AUTH_LOCAL_KEY", () => {
		const snippets = generateIntegrationSnippets(undefined, {
			baseUrl: "http://127.0.0.1:1456/v1/",
			model: "gpt-5.3-codex",
		});
		const combined = snippets.map((snippet) => snippet.body).join("\n");
		expect(snippets.map((snippet) => snippet.kind)).toEqual([
			"opencode",
			"openclaw",
			"python",
			"curl",
			"env",
		]);
		expect(combined).toContain("CODEX_MULTI_AUTH_LOCAL_KEY");
		expect(combined).toContain("http://127.0.0.1:1456/v1");
	});

	it("uses responses.create in the python snippet", () => {
		const snippet = generateIntegrationSnippet("python");
		expect(snippet.body).toContain("client.responses.create");
		expect(snippet.body).not.toContain("chat.completions");
	});
});
