import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UsageSummary } from "../lib/usage/index.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function makeSummary(
	requests: number,
	totalTokens: number,
	costUsd: number,
	unpricedRequests = 0,
): UsageSummary {
	return {
		since: null,
		until: null,
		by: "model",
		totals: {
			key: "total",
			requests,
			successes: requests,
			failures: 0,
			blocked: 0,
			cancelled: 0,
			inputTokens: totalTokens,
			outputTokens: 0,
			cachedInputTokens: 0,
			reasoningTokens: 0,
			totalTokens,
			costUsd,
			unpricedRequests,
		},
		buckets: [],
	};
}

describe("budget guard", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-budget-guard-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("saves, loads, and evaluates limits", async () => {
		const {
			evaluateBudgetGuard,
			loadBudgetGuardStore,
			saveBudgetGuardStore,
			upsertBudgetLimit,
		} = await import("../lib/budget-guard.js");

		const store = await loadBudgetGuardStore();
		const limit = upsertBudgetLimit(store, {
			key: "Project A",
			window: "day",
			maxRequests: 2,
			maxTokens: 100,
			maxCostUsd: 1,
		}, 123);
		await saveBudgetGuardStore(store);

		const loaded = await loadBudgetGuardStore();
		expect(loaded.limits["project-a"]).toEqual(limit);
		expect(evaluateBudgetGuard(limit, makeSummary(1, 99, 0.5)).allowed).toBe(true);
		const blocked = evaluateBudgetGuard(limit, makeSummary(2, 101, 1.1));
		expect(blocked.allowed).toBe(false);
		expect(blocked.reasons.length).toBe(3);
	});

	it("refuses a cost budget it cannot evaluate", async () => {
		// Unpriced models used to contribute $0, so a cost cap simply never
		// tripped for them — `maxCostUsd` was unenforceable for every `pro` tier.
		// An unevaluable spend limit now fails closed instead of reading as free.
		const { evaluateBudgetGuard } = await import("../lib/budget-guard.js");
		const limit = {
			key: "probe",
			window: "day" as const,
			maxCostUsd: 100,
			updatedAt: 0,
		};

		const withUnpriced = evaluateBudgetGuard(
			limit,
			makeSummary(1, 2_000_000, 0, 1),
		);
		expect(withUnpriced.allowed).toBe(false);
		expect(withUnpriced.reasons.join(" ")).toContain(
			"cost limit cannot be evaluated",
		);
		expect(withUnpriced.usage.unpricedRequests).toBe(1);

		// Fully priced usage under the cap is unaffected.
		expect(
			evaluateBudgetGuard(limit, makeSummary(1, 2_000_000, 5, 0)).allowed,
		).toBe(true);
	});

	it("ignores unpriced usage when no cost budget is configured", async () => {
		const { evaluateBudgetGuard } = await import("../lib/budget-guard.js");
		const evaluation = evaluateBudgetGuard(
			{ key: "probe", window: "day", maxRequests: 10, updatedAt: 0 },
			makeSummary(1, 2_000_000, 0, 4),
		);
		expect(evaluation.allowed).toBe(true);
		expect(evaluation.reasons).toEqual([]);
	});

	it("still reports a breached cost limit ahead of the unevaluable case", async () => {
		const { evaluateBudgetGuard } = await import("../lib/budget-guard.js");
		const evaluation = evaluateBudgetGuard(
			{ key: "probe", window: "day", maxCostUsd: 1, updatedAt: 0 },
			makeSummary(2, 3_000_000, 5, 1),
		);
		expect(evaluation.allowed).toBe(false);
		expect(evaluation.reasons.join(" ")).toContain("cost limit reached");
	});

	it("computes utc budget window starts", async () => {
		const { getBudgetWindowStart } = await import("../lib/budget-guard.js");
		const now = Date.UTC(2026, 3, 29, 12, 34, 56);
		expect(new Date(getBudgetWindowStart("hour", now)).toISOString()).toBe(
			"2026-04-29T12:00:00.000Z",
		);
		expect(new Date(getBudgetWindowStart("day", now)).toISOString()).toBe(
			"2026-04-29T00:00:00.000Z",
		);
		expect(new Date(getBudgetWindowStart("month", now)).toISOString()).toBe(
			"2026-04-01T00:00:00.000Z",
		);
	});
});

