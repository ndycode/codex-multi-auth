import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { fc } from "./setup.js";
import {
	evaluateBudgetGuard,
	getBudgetGuardPath,
	getBudgetWindowStart,
	loadBudgetGuardStore,
	normalizeBudgetKey,
	saveBudgetGuardStore,
	upsertBudgetLimit,
	type BudgetGuardStore,
	type BudgetLimit,
	type BudgetWindow,
} from "../../lib/budget-guard.js";
import type { UsageSummary, UsageSummaryBucket } from "../../lib/usage/types.js";
import { removeWithRetry } from "../helpers/remove-with-retry.js";

const WINDOWS: BudgetWindow[] = ["hour", "day", "week", "month"];

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// evaluateBudgetGuard reads only these four fields off totals.
const arbTotals = fc.record(
	{
		requests: fc.nat({ max: 100000 }),
		totalTokens: fc.nat({ max: 10000000 }),
		costUsd: fc.oneof(
			fc.double({ min: 0, max: 1000, noNaN: true }),
			fc.nat({ max: 1000 }),
		),
		unpricedRequests: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
	},
	{ requiredKeys: ["requests", "totalTokens", "costUsd"] },
);

const arbSummary: fc.Arbitrary<UsageSummary> = arbTotals.map((t) => ({
	since: null,
	until: null,
	by: "model" as const,
	totals: t as unknown as UsageSummaryBucket,
	buckets: [],
}));

// Limits are generated pre-normalization on purpose: literal zero, negative,
// NaN and Infinity all exercise evaluateBudgetGuard's `>=` semantics even
// though the store layer would already have dropped them.
const arbLimitValue = fc.option(
	fc.oneof(
		fc.double({ min: 0.0001, max: 10000, noNaN: true }),
		fc.constant(0),
		fc.constant(-5),
		fc.constant(Number.NaN),
		fc.constant(Number.POSITIVE_INFINITY),
		fc.nat({ max: 1000000 }),
	),
	{ nil: undefined },
);

// Keys that normalize to literal Object.prototype member names must be
// generated every run: "constructor" and "__proto__" survive normalizeKey
// untouched (all chars are in [a-z0-9._:-], and lowercase keeps "constructor"
// exact), and a plain-object map mishandles both — an absent "constructor"
// read resolves the inherited Object function, and a "__proto__" write calls
// the inherited setter instead of storing an entry. A random string spells
// one of these ~never, so they ride alongside as constants.
const arbLimitKey = fc.oneof(
	fc.constantFrom(
		"constructor",
		"__proto__",
		"prototype",
		"tostring",
		"valueof",
		"hasownproperty",
		"Constructor",
		"__PROTO__",
	),
	fc.string({ minLength: 1, maxLength: 40 }),
);

const arbLimit: fc.Arbitrary<BudgetLimit> = fc.record({
	key: arbLimitKey,
	window: fc.constantFrom(...WINDOWS),
	maxRequests: arbLimitValue,
	maxTokens: arbLimitValue,
	maxCostUsd: arbLimitValue,
	updatedAt: fc.nat(),
});

// A positive-delta summary guaranteed ≥ a base one componentwise.
const arbSummaryPair = fc
	.tuple(arbSummary, arbTotals)
	.map(([base, delta]): [UsageSummary, UsageSummary] => {
		const up: UsageSummary = structuredClone(base);
		up.totals.requests += delta.requests;
		up.totals.totalTokens += delta.totalTokens;
		up.totals.costUsd += delta.costUsd;
		up.totals.unpricedRequests =
			(up.totals.unpricedRequests ?? 0) + (delta.unpricedRequests ?? 0);
		return [base, up];
	});

// ---------------------------------------------------------------------------
// Oracle mirroring evaluateBudgetGuard's clause-for-clause reason construction
// ---------------------------------------------------------------------------

type ReasonKind = "request" | "token" | "cost" | "unpriced";

function expectedReasonKinds(
	limit: BudgetLimit,
	summary: UsageSummary,
): Set<ReasonKind> {
	const totals = summary.totals;
	const kinds = new Set<ReasonKind>();
	if (
		typeof limit.maxRequests === "number" &&
		totals.requests >= limit.maxRequests
	) {
		kinds.add("request");
	}
	if (
		typeof limit.maxTokens === "number" &&
		totals.totalTokens >= limit.maxTokens
	) {
		kinds.add("token");
	}
	if (typeof limit.maxCostUsd === "number") {
		if (totals.costUsd >= limit.maxCostUsd) {
			kinds.add("cost");
		} else if ((totals.unpricedRequests ?? 0) > 0) {
			kinds.add("unpriced");
		}
	}
	return kinds;
}

const REASON_PATTERNS: Record<ReasonKind, RegExp> = {
	request: /request limit reached/,
	token: /token limit reached/,
	cost: /cost limit reached \(/,
	unpriced: /cost limit cannot be evaluated/,
};

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("evaluateBudgetGuard properties", () => {
	it("reasons partition allowed vs blocked: allowed ⟺ no violated clause", async () => {
		await fc.assert(
			fc.asyncProperty(arbLimit, arbSummary, async (limit, summary) => {
				const evaluation = evaluateBudgetGuard(limit, summary);
				const expected = expectedReasonKinds(limit, summary);

				// allowed must be the exact complement of "any clause fired".
				expect(evaluation.allowed).toBe(expected.size === 0);
				expect(evaluation.allowed).toBe(evaluation.reasons.length === 0);

				// One reason per violated clause — never duplicated, never silent.
				expect(evaluation.reasons.length).toBe(expected.size);
				for (const kind of expected) {
					expect(
						evaluation.reasons.some((r) => REASON_PATTERNS[kind].test(r)),
					).toBe(true);
				}

				// The evaluation echoes raw usage and limits verbatim.
				expect(evaluation.usage.requests).toBe(summary.totals.requests);
				expect(evaluation.usage.totalTokens).toBe(
					summary.totals.totalTokens,
				);
				expect(evaluation.usage.costUsd).toBe(summary.totals.costUsd);
				expect(evaluation.limits.maxRequests).toBe(
					limit.maxRequests ?? null,
				);
			}),
		);
	});

	it("monotone: increasing usage can never flip blocked → allowed", async () => {
		await fc.assert(
			fc.asyncProperty(arbLimit, arbSummaryPair, async (limit, [low, high]) => {
				const lowEval = evaluateBudgetGuard(limit, low);
				const highEval = evaluateBudgetGuard(limit, high);

				// If the higher-usage evaluation allows, the lower one must too —
				// every clause is monotone non-decreasing in usage.
				if (highEval.allowed) {
					expect(lowEval.allowed).toBe(true);
				}
				// Reasons never shrink as usage grows.
				expect(highEval.reasons.length).toBeGreaterThanOrEqual(
					lowEval.reasons.length,
				);
			}),
		);
	});

	it("fail-closed: unpriced usage blocks cost limits only when cost is under the cap", async () => {
		await fc.assert(
			fc.asyncProperty(
				arbSummary,
				fc.double({ min: 0.01, max: 10000, noNaN: true }),
				fc.integer({ min: 1, max: 50 }),
				async (summary, maxCostUsd, unpriced) => {
					fc.pre(summary.totals.costUsd < maxCostUsd);
					const limit: BudgetLimit = {
						key: "k",
						window: "day",
						maxCostUsd,
						updatedAt: 0,
					};
					const withUnpriced = structuredClone(summary);
					withUnpriced.totals.unpricedRequests = unpriced;
					const blocked = evaluateBudgetGuard(limit, withUnpriced);
					expect(blocked.allowed).toBe(false);
					expect(
						blocked.reasons.some((r) =>
							/cannot be evaluated/.test(r),
						),
					).toBe(true);

					// Same window, fully priced → the cost limit must evaluate clean.
					const priced = structuredClone(summary);
					priced.totals.unpricedRequests = 0;
					expect(evaluateBudgetGuard(limit, priced).allowed).toBe(true);
				},
			),
		);
	});

	it("literal zero/negative limits block via `>=` — only the store layer makes them absent", async () => {
		await fc.assert(
			fc.asyncProperty(
				arbSummary,
				fc.constantFrom(0, -1, -0.5),
				async (summary, zeroOrNegative) => {
					// requests is a count, so requests >= 0 (and >= -1) always holds:
					// a literal non-positive maxRequests blocks EVERYTHING. This is the
					// documented gap between evaluateBudgetGuard (pure `>=`) and
					// normalizeLimit (which strips non-positive values) — the property
					// pins the `>=` contract so a future "off-by-one" regression to
					// `>` cannot silently turn 0 into "allow all".
					const limit: BudgetLimit = {
						key: "k",
						window: "day",
						maxRequests: zeroOrNegative,
						updatedAt: 0,
					};
					const evaluation = evaluateBudgetGuard(limit, summary);
					expect(evaluation.allowed).toBe(false);
					expect(
						evaluation.reasons.some((r) =>
							/request limit reached/.test(r),
						),
					).toBe(true);
				},
			),
		);
	});

	it("upsertBudgetLimit strips non-positive/non-finite limits (normalization is where 'zero means absent' lives)", async () => {
		await fc.assert(
			fc.asyncProperty(
				arbLimit,
				fc.string({ minLength: 1, maxLength: 40 }),
				async (rawLimit, rawKey) => {
					const normalizedKey = normalizeBudgetKey(rawKey);
					fc.pre(normalizedKey !== null);
					const store: BudgetGuardStore = { version: 1, limits: {} };
					const stored = upsertBudgetLimit(store, {
						...rawLimit,
						key: rawKey,
					});
					const positive = (v: unknown): v is number =>
						typeof v === "number" && Number.isFinite(v) && v > 0;
					expect(stored.maxRequests === undefined).toBe(
						!positive(rawLimit.maxRequests),
					);
					expect(stored.maxTokens === undefined).toBe(
						!positive(rawLimit.maxTokens),
					);
					expect(stored.maxCostUsd === undefined).toBe(
						!positive(rawLimit.maxCostUsd),
					);
					if (positive(rawLimit.maxRequests)) {
						expect(stored.maxRequests).toBe(rawLimit.maxRequests);
					}
					expect(store.limits[normalizedKey as string]).toEqual(stored);

					// With every dimension absent the guard can never fire.
					const bare: BudgetLimit = {
						key: "k",
						window: "day",
						updatedAt: 0,
					};
					const summary: UsageSummary = {
						since: null,
						until: null,
						by: "model",
						totals: {
							key: "t",
							requests: Number.MAX_SAFE_INTEGER,
							successes: 0,
							failures: 0,
							blocked: 0,
							cancelled: 0,
							inputTokens: 0,
							outputTokens: 0,
							cachedInputTokens: 0,
							reasoningTokens: 0,
							totalTokens: Number.MAX_SAFE_INTEGER,
							costUsd: Number.MAX_VALUE,
							unpricedRequests: Number.MAX_SAFE_INTEGER,
						},
						buckets: [],
					};
					expect(evaluateBudgetGuard(bare, summary).allowed).toBe(true);
				},
			),
		);
	});
});

describe("budget store properties", () => {
	const arbStore = fc
		.array(
			fc.record({
				key: arbLimitKey,
				limit: arbLimit,
			}),
			{ maxLength: 12 },
		)
		.map((entries): BudgetGuardStore => {
			const store: BudgetGuardStore = { version: 1, limits: {} };
			for (const { key, limit } of entries) {
				if (normalizeBudgetKey(key) === null) continue;
				try {
					upsertBudgetLimit(store, { ...limit, key });
				} catch {
					// invalid windows throw — skip those entries
				}
			}
			return store;
		});

	const clearStoreFile = async () => {
		const path = getBudgetGuardPath();
		if (existsSync(path)) await removeWithRetry(path);
	};

	afterEach(clearStoreFile);

	it("save → load round-trips the normalized store (load is a fixpoint)", async () => {
		await fc.assert(
			fc.asyncProperty(arbStore, async (store) => {
				// save merges over the on-disk store — isolate each generated case
				// or leftovers from a previous case legitimately appear in the load.
				await clearStoreFile();
				await saveBudgetGuardStore(store);
				const loaded = await loadBudgetGuardStore();

				// Saved content is already normalized, so load must reproduce it
				// exactly (fixpoint: normalize(load) === load).
				expect(loaded).toEqual({ version: 1, limits: store.limits });

				// Second pass through save→load changes nothing further.
				await saveBudgetGuardStore(loaded);
				expect(await loadBudgetGuardStore()).toEqual(loaded);
			}),
		);
	});

	it("save merges over the on-disk store (union by key, newest updatedAt wins)", async () => {
		await fc.assert(
			fc.asyncProperty(arbStore, arbStore, async (first, second) => {
				await clearStoreFile();
				await saveBudgetGuardStore(first);
				await saveBudgetGuardStore(second);
				const loaded = await loadBudgetGuardStore();

				// Upsert-only contract: keys absent from the incoming store are
				// preserved, shared keys keep the newest updatedAt. Absence must be
				// tested with an own-property check: on a plain-object map a raw
				// `limits["constructor"]` read resolves the inherited member and
				// looks "present" — the very bug this oracle exists to catch.
				const ownEntry = (
					map: Record<string, BudgetLimit>,
					key: string,
				): BudgetLimit | undefined =>
					Object.hasOwn(map, key) ? map[key] : undefined;
				const expectedKeys = new Set([
					...Object.keys(first.limits),
					...Object.keys(second.limits),
				]);
				expect(Object.keys(loaded.limits).sort()).toEqual(
					[...expectedKeys].sort(),
				);
				for (const key of expectedKeys) {
					const candidates = [
						ownEntry(first.limits, key),
						ownEntry(second.limits, key),
					].filter(
						(limit): limit is BudgetLimit => limit !== undefined,
					);
					const newest = Math.max(
						...candidates.map((limit) => limit.updatedAt),
					);
					expect(loaded.limits[key]?.updatedAt).toBe(newest);
				}
			}),
		);
	});

	it("normalizeBudgetKey is idempotent and emits canonical keys", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.string({ maxLength: 200 }),
				async (raw) => {
					const once = normalizeBudgetKey(raw);
					if (once === null) return;
					expect(once.length).toBeLessThanOrEqual(100);
					expect(once).toMatch(/^[a-z0-9._:-]+$/);
					expect(normalizeBudgetKey(once)).toBe(once);
				},
			),
		);
	});
});

describe("getBudgetWindowStart properties", () => {
	it("start ≤ now, idempotent, and inside the window width", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...WINDOWS),
				fc.integer({ min: 0, max: 4_102_444_800_000 }), // through year 2100
				async (window, now) => {
					const start = getBudgetWindowStart(window, now);
					expect(start).toBeLessThanOrEqual(now);
					expect(getBudgetWindowStart(window, start)).toBe(start);

					const width =
						window === "hour"
							? 3_600_000
							: window === "day"
								? 86_400_000
								: window === "week"
									? 7 * 86_400_000
									: 32 * 86_400_000;
					expect(now - start).toBeLessThan(width);
					expect(now - start).toBeGreaterThanOrEqual(0);
				},
			),
		);
	});

	it("window ordering: hour-start ≥ day-start ≥ week-start for the same instant", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 4_102_444_800_000 }),
				async (now) => {
					expect(getBudgetWindowStart("hour", now)).toBeGreaterThanOrEqual(
						getBudgetWindowStart("day", now),
					);
					expect(getBudgetWindowStart("day", now)).toBeGreaterThanOrEqual(
						getBudgetWindowStart("week", now),
					);
				},
			),
		);
	});
});
