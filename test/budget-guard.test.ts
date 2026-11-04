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

	it("re-applies update mutations over the freshest store", async () => {
		const {
			loadBudgetGuardStore,
			updateBudgetGuardStore,
			upsertBudgetLimit,
		} = await import("../lib/budget-guard.js");
		// Two sequential mutations through the update path behave like two
		// processes serialized by the lockfile: each applies on the latest
		// committed store, so the second cannot lose the first's key.
		await updateBudgetGuardStore((store) => ({
			result: upsertBudgetLimit(store, { key: "a", window: "day", maxRequests: 5 }, 1),
			dirty: true,
		}));
		await updateBudgetGuardStore((store) => ({
			result: upsertBudgetLimit(store, { key: "b", window: "week", maxTokens: 9 }, 2),
			dirty: true,
		}));
		const loaded = await loadBudgetGuardStore();
		expect(loaded.limits.a).toMatchObject({ maxRequests: 5 });
		expect(loaded.limits.b).toMatchObject({ maxTokens: 9 });
	});

	it("skips the write when a budget mutation reports no change", async () => {
		const { getBudgetGuardPath, updateBudgetGuardStore } = await import(
			"../lib/budget-guard.js"
		);
		const result = await updateBudgetGuardStore(() => ({
			result: null,
			dirty: false,
		}));
		expect(result).toBeNull();
		await expect(fs.stat(getBudgetGuardPath())).rejects.toMatchObject({
			code: "ENOENT",
		});
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

	it("does not tell the user to price a model when the unknown cost may be a Decisions call", async () => {
		const { evaluateBudgetGuard } = await import("../lib/budget-guard.js");
		const reason = evaluateBudgetGuard(
			{ key: "probe", window: "day", maxCostUsd: 100, updatedAt: 0 },
			makeSummary(1, 12, 0, 1),
		).reasons.join(" ");
		expect(reason).toContain("Decisions");
		expect(reason).not.toMatch(/price the model/i);
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

	it("survives a backward clock jump between writes (hybrid updatedAt floor)", async () => {
		const {
			loadBudgetGuardStore,
			saveBudgetGuardStore,
			upsertBudgetLimit,
		} = await import("../lib/budget-guard.js");

		// First write lands at wall time T2.
		const first = await loadBudgetGuardStore();
		upsertBudgetLimit(
			first,
			{ key: "proj", window: "day", maxRequests: 1, maxTokens: 1, maxCostUsd: 1 },
			5_000,
		);
		await saveBudgetGuardStore(first);

		// Clock regresses to T1 < T2; the reloaded store carries the T2 stamp,
		// so the upsert clamps forward instead of losing the merge.
		const reloaded = await loadBudgetGuardStore();
		const mutated = upsertBudgetLimit(
			reloaded,
			{ key: "proj", window: "day", maxRequests: 9, maxTokens: 1, maxCostUsd: 1 },
			100,
		);
		expect(mutated.updatedAt).toBe(5_001);
		await saveBudgetGuardStore(reloaded);

		const final = await loadBudgetGuardStore();
		expect(final.limits.proj?.maxRequests).toBe(9);
		expect(final.limits.proj?.updatedAt).toBe(5_001);
	});

	it("does not lose a deliberate edit that races a concurrent write under clock skew", async () => {
		const {
			loadBudgetGuardStore,
			saveBudgetGuardStore,
			upsertBudgetLimit,
		} = await import("../lib/budget-guard.js");

		// Seed the key at wall time T2.
		const seed = await loadBudgetGuardStore();
		upsertBudgetLimit(
			seed,
			{ key: "proj", window: "day", maxRequests: 1 },
			5_000,
		);
		await saveBudgetGuardStore(seed);

		// This writer loads its snapshot BEFORE the concurrent write lands.
		const working = await loadBudgetGuardStore();
		const baseline = structuredClone(working);

		// A concurrent writer lands a newer entry first.
		const raced = await loadBudgetGuardStore();
		upsertBudgetLimit(
			raced,
			{ key: "proj", window: "day", maxRequests: 5 },
			7_000,
		);
		await saveBudgetGuardStore(raced);

		// The clock regressed to T1 << T2: the snapshot floor stamps 5_001,
		// below the raced on-disk 7_000 — without a merge-time floor over the
		// fresh disk entry this deliberate edit is silently dropped.
		const mutated = upsertBudgetLimit(
			working,
			{ key: "proj", window: "day", maxRequests: 42 },
			100,
		);
		expect(mutated.updatedAt).toBe(5_001);
		await saveBudgetGuardStore(working, baseline);

		const final = await loadBudgetGuardStore();
		expect(final.limits.proj?.maxRequests).toBe(42);
		expect(final.limits.proj?.updatedAt).toBe(7_001);
	});

	it("leaves a raced newer limit alone when the caller only carried it", async () => {
		const {
			loadBudgetGuardStore,
			saveBudgetGuardStore,
			upsertBudgetLimit,
		} = await import("../lib/budget-guard.js");

		const seed = await loadBudgetGuardStore();
		upsertBudgetLimit(
			seed,
			{ key: "edited", window: "day", maxRequests: 1 },
			5_000,
		);
		upsertBudgetLimit(
			seed,
			{ key: "carried", window: "day", maxRequests: 1 },
			5_000,
		);
		await saveBudgetGuardStore(seed);

		const working = await loadBudgetGuardStore();
		const baseline = structuredClone(working);

		// A concurrent writer moves ONLY the carried key to a newer entry.
		const raced = await loadBudgetGuardStore();
		upsertBudgetLimit(
			raced,
			{ key: "carried", window: "day", maxRequests: 9 },
			9_000,
		);
		await saveBudgetGuardStore(raced);

		// The caller edits only the other key; the carried snapshot copy must
		// not be re-stamped over the raced write.
		upsertBudgetLimit(
			working,
			{ key: "edited", window: "day", maxRequests: 3 },
			100,
		);
		await saveBudgetGuardStore(working, baseline);

		const final = await loadBudgetGuardStore();
		expect(final.limits.edited?.maxRequests).toBe(3);
		expect(final.limits.carried?.maxRequests).toBe(9);
		expect(final.limits.carried?.updatedAt).toBe(9_000);
	});
});

