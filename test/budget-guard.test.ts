import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UsageSummary } from "../lib/usage/index.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function makeSummary(requests: number, totalTokens: number, costUsd: number): UsageSummary {
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

