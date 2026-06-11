import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
	createUsageAccountRef,
	hashUsageIdentifier,
	normalizeUsageLedgerRow,
	usageRowToJsonLine,
} from "../lib/usage/redaction.js";
import { estimateUsageCostUsd } from "../lib/usage/pricing.js";

const NOW = 1_750_000_000_000;

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("usage ledger redaction and normalization", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("hashUsageIdentifier", () => {
		it("trims before hashing and prefixes the digest format", () => {
			expect(hashUsageIdentifier("  acct-123 ")).toBe(sha256("acct-123"));
			expect(hashUsageIdentifier("acct-123")).toBe(
				hashUsageIdentifier("\tacct-123  "),
			);
		});
	});

	describe("createUsageAccountRef", () => {
		it("hashes the account id and lowercased email, never storing raw values", () => {
			const ref = createUsageAccountRef({
				accountId: " acct-123 ",
				email: " Alice@Example.COM ",
				accountIndex: 2,
			});
			expect(ref).toStrictEqual({
				accountHash: sha256("acct-123"),
				emailHash: sha256("alice@example.com"),
				index: 2,
			});
		});

		it("returns null when no identifying facet survives normalization", () => {
			expect(
				createUsageAccountRef({ accountId: "  ", email: "", accountIndex: null }),
			).toBeNull();
			expect(createUsageAccountRef({})).toBeNull();
		});

		it("rejects negative and fractional indexes but keeps zero", () => {
			expect(createUsageAccountRef({ accountIndex: 0 })).toStrictEqual({
				accountHash: undefined,
				emailHash: undefined,
				index: 0,
			});
			expect(createUsageAccountRef({ accountIndex: -1 })).toBeNull();
			expect(createUsageAccountRef({ accountIndex: 1.5 })).toBeNull();
		});
	});

	describe("normalizeUsageLedgerRow", () => {
		it("coerces unknown enums to their documented fallbacks", () => {
			const row = normalizeUsageLedgerRow({
				source: "smoke-signal",
				operation: 42 as never,
				outcome: "exploded",
			});
			expect(row.source).toBe("unknown");
			expect(row.operation).toBe("unknown");
			// Outcome falls back to "failure", not "unknown": an unclassifiable
			// outcome must never be counted as a success.
			expect(row.outcome).toBe("failure");
		});

		it("keeps valid enums as-is", () => {
			const row = normalizeUsageLedgerRow({
				source: "runtime-proxy",
				operation: "responses",
				outcome: "blocked",
			});
			expect(row.source).toBe("runtime-proxy");
			expect(row.operation).toBe("responses");
			expect(row.outcome).toBe("blocked");
		});

		it("clamps token counts and recomputes the total when none is provided", () => {
			const row = normalizeUsageLedgerRow({
				outcome: "success",
				inputTokens: 100.9,
				outputTokens: -5,
				cachedInputTokens: Number.NaN,
				reasoningTokens: 7,
			});
			expect(row.tokens).toStrictEqual({
				inputTokens: 100,
				outputTokens: 0,
				cachedInputTokens: 0,
				reasoningTokens: 7,
				// input + output + reasoning; cached input is informational.
				totalTokens: 107,
			});
		});

		it("trusts a provided total but clamps it non-negative", () => {
			expect(
				normalizeUsageLedgerRow({ outcome: "success", totalTokens: 42.7 }).tokens
					.totalTokens,
			).toBe(42);
			expect(
				normalizeUsageLedgerRow({ outcome: "success", totalTokens: -10 }).tokens
					.totalTokens,
			).toBe(0);
		});

		it("accepts only real HTTP status codes", () => {
			const base = { outcome: "success" } as const;
			expect(normalizeUsageLedgerRow({ ...base, statusCode: 429 }).statusCode).toBe(429);
			expect(normalizeUsageLedgerRow({ ...base, statusCode: 99 }).statusCode).toBeNull();
			expect(normalizeUsageLedgerRow({ ...base, statusCode: 600 }).statusCode).toBeNull();
			expect(
				normalizeUsageLedgerRow({ ...base, statusCode: Number.NaN }).statusCode,
			).toBeNull();
		});

		it("falls back to the pricing estimate when no explicit cost is given", () => {
			const row = normalizeUsageLedgerRow({
				outcome: "success",
				model: "gpt-5.2",
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});
			// Literal pin of the gpt-5.2 price card ($1.25/M input + $10/M
			// output), not just delegation: a wrong table entry must fail here.
			expect(row.costUsd).toBe(11.25);
			expect(row.costUsd).toBe(estimateUsageCostUsd("gpt-5.2", row.tokens));
			expect(
				normalizeUsageLedgerRow({ outcome: "success", costUsd: -3 }).costUsd,
			).toBe(0);
			expect(
				normalizeUsageLedgerRow({ outcome: "success", costUsd: 1.25 }).costUsd,
			).toBe(1.25);
		});

		it("records a null cost for models without a price card", () => {
			// null (not 0) so the summary aggregator can distinguish "free" from
			// "unpriceable".
			expect(
				normalizeUsageLedgerRow({
					outcome: "success",
					model: "mystery-model",
					inputTokens: 1_000,
				}).costUsd,
			).toBeNull();
		});

		it("clamps and truncates durationMs, dropping non-finite values", () => {
			const base = { outcome: "success" } as const;
			expect(normalizeUsageLedgerRow({ ...base, durationMs: 1234.9 }).durationMs).toBe(1234);
			expect(normalizeUsageLedgerRow({ ...base, durationMs: -50 }).durationMs).toBe(0);
			expect(
				normalizeUsageLedgerRow({ ...base, durationMs: Number.NaN }).durationMs,
			).toBeNull();
			expect(normalizeUsageLedgerRow(base).durationMs).toBeNull();
		});

		it("fills id and createdAt defaults deterministically under fake time", () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const row = normalizeUsageLedgerRow({ outcome: "success" });
			expect(row.createdAt).toBe(NOW);
			expect(row.id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
			expect(
				normalizeUsageLedgerRow({ outcome: "success", id: " row-1 ", createdAt: 5 }),
			).toMatchObject({ id: "row-1", createdAt: 5 });
		});
	});

	describe("usageRowToJsonLine", () => {
		it("serializes one newline-terminated JSON line with no raw identifiers", () => {
			const line = usageRowToJsonLine(
				normalizeUsageLedgerRow({
					outcome: "success",
					accountId: "acct-123",
					email: "Alice@Example.com",
					model: "gpt-5.2",
				}),
			);
			expect(line.endsWith("\n")).toBe(true);
			expect(line.indexOf("\n")).toBe(line.length - 1);
			expect(JSON.parse(line)).toBeTruthy();
			// The redaction guarantee the ledger relies on: raw identifiers must
			// never reach the serialized row.
			expect(line).not.toContain("acct-123");
			expect(line.toLowerCase()).not.toContain("alice@example.com");
			expect(line).toContain(sha256("acct-123"));
			expect(line).toContain(sha256("alice@example.com"));
		});
	});
});
