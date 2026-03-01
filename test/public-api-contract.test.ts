import { describe, expect, it } from "vitest";

describe("public api contract", () => {
	it("keeps root plugin exports aligned", async () => {
		const root = await import("../index.js");
		expect(typeof root.OpenAIOAuthPlugin).toBe("function");
		expect(root.OpenAIAuthPlugin).toBe(root.OpenAIOAuthPlugin);
		expect(root.default).toBe(root.OpenAIOAuthPlugin);
	});

	it("keeps compatibility exports for module helpers", async () => {
		const rotation = await import("../lib/rotation.js");
		const parallelProbe = await import("../lib/parallel-probe.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const rateLimitBackoff = await import("../lib/request/rate-limit-backoff.js");
		const requestTransformer = await import("../lib/request/request-transformer.js");
		const required = [
			["selectHybridAccount", rotation],
			["exponentialBackoff", rotation],
			["getTopCandidates", parallelProbe],
			["createCodexHeaders", fetchHelpers],
			["getRateLimitBackoffWithReason", rateLimitBackoff],
			["transformRequestBody", requestTransformer],
		];
		for (const [name, mod] of required) {
			expect(name in mod, `missing export: ${name}`).toBe(true);
		}
	});
});
