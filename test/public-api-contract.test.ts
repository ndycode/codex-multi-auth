import { describe, expect, it, vi } from "vitest";
import {
	HealthScoreTracker,
	TokenBucketTracker,
	exponentialBackoff,
	selectHybridAccount,
} from "../lib/rotation.js";
import { getTopCandidates } from "../lib/parallel-probe.js";
import { createCodexHeaders } from "../lib/request/fetch-helpers.js";
import {
	clearRateLimitBackoffState,
	getRateLimitBackoffWithReason,
} from "../lib/request/rate-limit-backoff.js";
import { transformRequestBody } from "../lib/request/request-transformer.js";
import type { RequestBody, RequestToolDefinition } from "../lib/types.js";

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
		const required: ReadonlyArray<
			readonly [string, Record<string, unknown>]
		> = [
			["selectHybridAccount", rotation],
			["exponentialBackoff", rotation],
			["getTopCandidates", parallelProbe],
			["createCodexHeaders", fetchHelpers],
			["getRateLimitBackoffWithReason", rateLimitBackoff],
			["transformRequestBody", requestTransformer],
		];
		for (const [name, mod] of required) {
			expect(name in mod, `missing export: ${name}`).toBe(true);
			expect(typeof mod[name], `${name} should be a function`).toBe("function");
		}
	});

	it("keeps positional and options-object overload behavior aligned", async () => {
		const healthTracker = new HealthScoreTracker();
		const tokenTracker = new TokenBucketTracker();
		const accounts = [{ index: 0, isAvailable: true, lastUsed: 1_709_280_000_000 }];

		const selectedPositional = selectHybridAccount(accounts, healthTracker, tokenTracker);
		const selectedNamed = selectHybridAccount({ accounts, healthTracker, tokenTracker });
		expect(selectedNamed?.index).toBe(selectedPositional?.index);

		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const backoffPositional = exponentialBackoff(3, 1000, 60000, 0);
			const backoffNamed = exponentialBackoff({ attempt: 3, baseMs: 1000, maxMs: 60000, jitterFactor: 0 });
			expect(backoffNamed).toBe(backoffPositional);
		} finally {
			randomSpy.mockRestore();
		}

		const snapshotNow = Date.now();
		const managerAccounts = [
			{
				index: 0,
				refreshToken: "token-0",
				lastUsed: snapshotNow,
				addedAt: snapshotNow,
				rateLimitResetTimes: {},
			},
		];
		const manager = {
			getAccountsSnapshot: () => managerAccounts,
		};
		const topPositional = getTopCandidates(
			manager as unknown as Parameters<typeof getTopCandidates>[0],
			"codex",
			null,
			1,
		);
		const topNamed = getTopCandidates({
			accountManager: manager as unknown as Parameters<typeof getTopCandidates>[0],
			modelFamily: "codex",
			model: null,
			maxCandidates: 1,
		});
		expect(topNamed).toEqual(topPositional);

		const headersPositional = createCodexHeaders(undefined, "acct", "token", {
			model: "gpt-5",
			promptCacheKey: "session-compat",
		});
		const headersNamed = createCodexHeaders({
			init: undefined,
			accountId: "acct",
			accessToken: "token",
			opts: { model: "gpt-5", promptCacheKey: "session-compat" },
		});
		expect(headersNamed.get("Authorization")).toBe(headersPositional.get("Authorization"));
		expect(headersNamed.get("conversation_id")).toBe(headersPositional.get("conversation_id"));
		expect(headersNamed.get("session_id")).toBe(headersPositional.get("session_id"));

		const ratePositional = getRateLimitBackoffWithReason(1, "compat", 1000, "tokens");
		clearRateLimitBackoffState();
		const rateNamed = getRateLimitBackoffWithReason({
			accountIndex: 1,
			quotaKey: "compat",
			serverRetryAfterMs: 1000,
			reason: "tokens",
		});
		expect(rateNamed).toEqual(ratePositional);

		const baseBody: RequestBody = {
			model: "gpt-5.4",
			input: [{ type: "message", role: "user", content: "hi" }],
			prompt_cache_retention: "24h",
			tools: [
				{ type: "tool_search", max_num_results: 2 },
				{
					type: "mcp",
					server_label: "docs",
					server_url: "https://mcp.example.com",
					defer_loading: true,
				},
			] satisfies RequestToolDefinition[],
			text: {
				format: {
					type: "json_schema",
					name: "compat_response",
					schema: {
						type: "object",
						properties: {
							answer: { type: "string" },
						},
						required: ["answer"],
					},
					strict: true,
				},
			},
		};
		const transformedPositional = await transformRequestBody(
			JSON.parse(JSON.stringify(baseBody)) as RequestBody,
			"codex",
		);
		const transformedNamed = await transformRequestBody({
			body: JSON.parse(JSON.stringify(baseBody)) as RequestBody,
			codexInstructions: "codex",
		});
		expect(transformedNamed).toEqual(transformedPositional);
		expect(transformedNamed.tools).toEqual(baseBody.tools);
	});
});
