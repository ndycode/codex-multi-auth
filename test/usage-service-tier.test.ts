import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { extractResponsesUsage } from "../lib/usage/usage-extraction.js";
import { estimateUsageCostUsd } from "../lib/usage/pricing.js";
import { normalizeUsageLedgerRow } from "../lib/usage/redaction.js";
import { createStreamUsageDeferral } from "../lib/usage/stream-usage-deferral.js";
import { createRuntimeUsageRecorder } from "../lib/policy/runtime-policy.js";
import type { UsageTokenCounts } from "../lib/usage/types.js";

/**
 * OpenAI's Fast tier costs more than standard: $20/$100 against $10/$50 for
 * GPT-6 Astra. Every rate in MODEL_PRICING is a standard-tier rate, so before
 * this a Fast session was priced at half what it cost, and a `maxCostUsd` cap
 * could overrun without ever tripping.
 *
 * The fix is deliberately not a blanket 2x multiplier. Astra's is the only
 * published one, so any other tier is reported as unknown cost and the budget
 * guard fails closed, exactly as it does for an unpriced model.
 */
const TOKENS = {
	inputTokens: 1_000_000,
	cachedInputTokens: 0,
	outputTokens: 1_000_000,
	reasoningTokens: 0,
	totalTokens: 2_000_000,
};

describe("service tier extraction", () => {
	it("reads the tier off a bare response object", () => {
		const usage = extractResponsesUsage({
			service_tier: "priority",
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		});
		expect(usage?.serviceTier).toBe("priority");
	});

	it("reads it off a stream event that wraps the response", () => {
		const usage = extractResponsesUsage({
			type: "response.completed",
			response: {
				service_tier: "priority",
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});
		expect(usage?.serviceTier).toBe("priority");
	});

	it("treats `default` as standard, since that is what the wire calls it", () => {
		const usage = extractResponsesUsage({
			service_tier: "default",
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		});
		expect(usage?.serviceTier).toBe("standard");
	});

	it("keeps an unrecognised tier as `unknown` rather than dropping it", () => {
		// Dropping it would silently price the row at standard rates, which is
		// the under-count this whole change exists to stop.
		const usage = extractResponsesUsage({
			service_tier: "some-new-tier",
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		});
		expect(usage?.serviceTier).toBe("unknown");
	});

	it("leaves the field absent when the response reports no tier", () => {
		const usage = extractResponsesUsage({
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		});
		expect(usage?.serviceTier).toBeUndefined();
	});
});

describe("service tier pricing", () => {
	it("prices Astra's Fast tier at the published 2x rate", () => {
		expect(estimateUsageCostUsd("gpt-6-astra", TOKENS)).toBe(60);
		expect(
			estimateUsageCostUsd("gpt-6-astra", { ...TOKENS, serviceTier: "priority" }),
		).toBe(120);
	});

	it("treats standard and an absent tier identically", () => {
		const absent = estimateUsageCostUsd("gpt-6-astra", TOKENS);
		const standard = estimateUsageCostUsd("gpt-6-astra", {
			...TOKENS,
			serviceTier: "standard",
		});
		expect(standard).toBe(absent);
	});

	it("reports unknown cost for a tier it has no published rate for", () => {
		// Not a guess, and not the standard rate. `evaluateBudgetGuard` refuses a
		// cost budget on null, so this fails closed.
		for (const tier of ["flex", "batch", "scale", "unknown"] as const) {
			expect(
				estimateUsageCostUsd("gpt-6-astra", { ...TOKENS, serviceTier: tier }),
				`gpt-6-astra @ ${tier}`,
			).toBeNull();
		}
		// Sol has no published Fast multiplier, so even `priority` is unknown here.
		expect(
			estimateUsageCostUsd("gpt-5.6-sol", { ...TOKENS, serviceTier: "priority" }),
		).toBeNull();
	});

	it("still prices every model normally at standard tier", () => {
		// Regression guard: the tier resolution must not disturb the common path.
		expect(estimateUsageCostUsd("gpt-5.6-sol", TOKENS)).toBeGreaterThan(0);
		expect(estimateUsageCostUsd("gpt-5.5", TOKENS)).toBeGreaterThan(0);
		expect(estimateUsageCostUsd("gpt-5-codex", TOKENS)).toBeGreaterThan(0);
	});
});

describe("the tier reaches the ledger", () => {
	it("is carried onto the row and priced from there", () => {
		const row = normalizeUsageLedgerRow({
			outcome: "success",
			model: "gpt-6-astra",
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			serviceTier: "priority",
		});
		expect(row.tokens.serviceTier).toBe("priority");
		expect(row.costUsd).toBe(120);
	});

	it("prices the same row at standard when no tier is reported", () => {
		const row = normalizeUsageLedgerRow({
			outcome: "success",
			model: "gpt-6-astra",
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
		});
		expect(row.tokens.serviceTier).toBeUndefined();
		expect(row.costUsd).toBe(60);
	});

	it("survives the stream deferral, which is how a streamed row is written", () => {
		// The deferral spreads the counts over the pending row. If `serviceTier`
		// did not ride on UsageTokenCounts it would be dropped exactly here, and
		// every streamed Fast response would be priced as standard.
		const recorded: Record<string, unknown>[] = [];
		const deferral = createStreamUsageDeferral<Record<string, unknown>>({
			record: (row) => recorded.push(row),
			fallbackMs: 1_000,
			schedule: () => ({ cancel: () => {} }),
		});

		deferral.defer({ outcome: "success", model: "gpt-6-astra" });
		deferral.onUsage({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cachedInputTokens: 0,
			reasoningTokens: 0,
			totalTokens: 2_000_000,
			serviceTier: "priority",
		} satisfies UsageTokenCounts);

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.serviceTier).toBe("priority");
		expect(normalizeUsageLedgerRow(recorded[0] as never).costUsd).toBe(120);
	});
});

describe("the tier survives the paths a real request takes", () => {
	it("reaches the ledger through the runtime recorder, not just the deferral", () => {
		// The recorder rebuilds the ledger input FIELD BY FIELD, so a field that
		// merely arrives on its input is dropped unless it is named there. The
		// deferral test above passes either way, which is exactly why this one
		// exists: without it a Fast response through the runtime proxy priced at
		// the standard rate.
		const appended: Record<string, unknown>[] = [];
		const recorder = createRuntimeUsageRecorder({
			source: "runtime-proxy",
			operation: "responses",
			model: "gpt-6-astra",
			projectKey: null,
			requestId: null,
			append: async (row) => {
				appended.push(row as Record<string, unknown>);
			},
		} as never);

		return recorder
			.record({
				outcome: "success",
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				serviceTier: "priority",
			})
			.then(() => {
				expect(appended).toHaveLength(1);
				expect(appended[0]?.serviceTier).toBe("priority");
				expect(normalizeUsageLedgerRow(appended[0] as never).costUsd).toBe(120);
			});
	});

});

describe("the tier survives a real ledger round-trip", () => {
	// Through the public append/read API against a temp dir, not the internal
	// parser: the parser rebuilds only the numeric token fields, so a persisted
	// tier was lost on read-back and a stored Fast row reported as standard.
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = join(tmpdir(), `cma-tier-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(tempDir, { recursive: true });
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("reads a persisted tier back off disk", async () => {
		const { appendUsageLedgerRow, readUsageLedgerRows } = await import(
			"../lib/usage/index.js"
		);
		// The append INPUT shape, with the tier at top level. `appendUsageLedgerRow`
		// normalises internally, and `normalizeTokens` reads `input.serviceTier`.
		await appendUsageLedgerRow({
			outcome: "success",
			model: "gpt-6-astra",
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			serviceTier: "priority",
		});
		const rows = await readUsageLedgerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.tokens.serviceTier).toBe("priority");
		expect(rows[0]?.costUsd).toBe(120);
	});

	it("drops an unrecognised tier that was edited into the file", async () => {
		// The ledger is JSONL on disk and can be hand-edited, so a value read
		// back from it is untrusted.
		const { appendUsageLedgerRow, readUsageLedgerRows, getUsageLedgerPaths } =
			await import("../lib/usage/index.js");
		await appendUsageLedgerRow({
			outcome: "success",
			model: "gpt-6-astra",
			inputTokens: 10,
			outputTokens: 10,
			serviceTier: "priority",
		});
		const { current } = getUsageLedgerPaths();
		const raw = await fs.readFile(current, "utf8");
		await fs.writeFile(current, raw.replace('"serviceTier":"priority"', '"serviceTier":"free-lunch"'));
		const rows = await readUsageLedgerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.tokens.serviceTier).toBeUndefined();
	});
});

describe("tier spellings and cached rates", () => {
	it("treats `fast` as the priority tier", () => {
		// The upstream catalog names the tier `priority` and displays it as
		// "Fast", and lists `fast` in additional_speed_tiers, so a response can
		// report either. Left unmapped it became `unknown` and priced as
		// unpriced, failing a cost budget closed on a tier we have a rate for.
		const usage = extractResponsesUsage({
			service_tier: "fast",
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		});
		expect(usage?.serviceTier).toBe("priority");
		expect(
			estimateUsageCostUsd("gpt-6-astra", { ...TOKENS, serviceTier: "fast" as never }),
		).toBeNull();
	});

	it("bills cached input at the 90% discount every other row uses", () => {
		// Shipped absent at first, which made Astra the only model billing cached
		// tokens at the full input rate: a 10x over-statement that trips a
		// maxCostUsd cap far too early.
		const cachedOnly = {
			inputTokens: 1_000_000,
			cachedInputTokens: 1_000_000,
			outputTokens: 0,
			reasoningTokens: 0,
			totalTokens: 1_000_000,
		};
		expect(estimateUsageCostUsd("gpt-6-astra", cachedOnly)).toBe(1);
		expect(
			estimateUsageCostUsd("gpt-6-astra", { ...cachedOnly, serviceTier: "priority" }),
		).toBe(2);
	});
});
