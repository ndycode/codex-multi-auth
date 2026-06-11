import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clampNonNegativeInt,
	clearExpiredRateLimits,
	formatWaitTime,
	getQuotaKey,
	isRateLimitedForFamily,
	isRateLimitedForQuotaKey,
	parseRateLimitReason,
	type RateLimitedEntity,
} from "../lib/accounts/rate-limits.js";

const NOW = 1_750_000_000_000;

function entityWith(resetTimes: Record<string, number | undefined>): RateLimitedEntity {
	return { rateLimitResetTimes: { ...resetTimes } };
}

describe("account rate-limit helpers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("parseRateLimitReason", () => {
		it.each([
			[undefined, "unknown"],
			["", "unknown"],
			["insufficient_quota", "quota"],
			["usage_limit_reached", "quota"],
			["QUOTA_EXCEEDED", "quota"],
			["tokens_exhausted", "tokens"],
			["tpm_limit_exceeded", "tokens"],
			["rpm_limit_exceeded", "tokens"],
			["concurrent_request_limit", "concurrent"],
			["parallel_requests", "concurrent"],
			// No quota/token/concurrent keyword: generic 429 codes stay unknown.
			["rate_limit_exceeded", "unknown"],
			["slow_down", "unknown"],
		] as const)("maps %j to %j", (code, expected) => {
			expect(parseRateLimitReason(code)).toBe(expected);
		});
	});

	describe("getQuotaKey", () => {
		it("returns the bare family when no model is given", () => {
			expect(getQuotaKey("gpt-5.2")).toBe("gpt-5.2");
			expect(getQuotaKey("gpt-5.2", null)).toBe("gpt-5.2");
			expect(getQuotaKey("gpt-5.2", undefined)).toBe("gpt-5.2");
		});

		it("scopes the key to the model when one is given", () => {
			expect(getQuotaKey("gpt-5.2", "gpt-5.2-codex")).toBe(
				"gpt-5.2:gpt-5.2-codex",
			);
		});
	});

	describe("clampNonNegativeInt", () => {
		it.each([
			["non-number string", "12", 7, 7],
			["undefined", undefined, 7, 7],
			["NaN", Number.NaN, 7, 7],
			["Infinity", Number.POSITIVE_INFINITY, 7, 7],
			// Non-finite short-circuits to the fallback before the negative
			// clamp, so -Infinity yields the fallback rather than 0.
			["-Infinity", Number.NEGATIVE_INFINITY, 7, 7],
			["negative", -3, 7, 0],
			["fractional", 3.9, 7, 3],
			["zero", 0, 7, 0],
			["plain integer", 42, 7, 42],
		])("%s -> clamped", (_label, value, fallback, expected) => {
			expect(clampNonNegativeInt(value, fallback)).toBe(expected);
		});
	});

	describe("clearExpiredRateLimits", () => {
		it("removes entries at or past their reset time and keeps future ones", () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const entity = entityWith({
				expired: NOW - 1,
				boundary: NOW,
				future: NOW + 60_000,
				dangling: undefined,
			});
			clearExpiredRateLimits(entity);
			expect(entity.rateLimitResetTimes).toStrictEqual({
				future: NOW + 60_000,
				dangling: undefined,
			});
		});
	});

	describe("isRateLimitedForQuotaKey", () => {
		it("is limited only while the reset time lies in the future", () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const entity = entityWith({
				"gpt-5.2": NOW + 1,
				"gpt-5.3": NOW,
			});
			expect(isRateLimitedForQuotaKey(entity, "gpt-5.2")).toBe(true);
			expect(isRateLimitedForQuotaKey(entity, "gpt-5.3")).toBe(false);
			expect(isRateLimitedForQuotaKey(entity, "gpt-5.1")).toBe(false);
		});
	});

	describe("isRateLimitedForFamily", () => {
		it("treats a null model the same as no model (family key only)", () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const entity = entityWith({ "gpt-5.2": NOW + 60_000 });
			expect(isRateLimitedForFamily(entity, "gpt-5.2", null)).toBe(true);
			const modelScopedOnly = entityWith({
				"gpt-5.2:gpt-5.2-codex": NOW + 60_000,
			});
			expect(isRateLimitedForFamily(modelScopedOnly, "gpt-5.2", null)).toBe(
				false,
			);
		});

		it("honors a model-scoped limit even when the family is clear", () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const entity = entityWith({ "gpt-5.2:gpt-5.2-codex": NOW + 60_000 });
			expect(isRateLimitedForFamily(entity, "gpt-5.2", "gpt-5.2-codex")).toBe(
				true,
			);
			expect(isRateLimitedForFamily(entity, "gpt-5.2")).toBe(false);
			expect(isRateLimitedForFamily(entity, "gpt-5.2", "other-model")).toBe(
				false,
			);
		});

		it("applies a family-wide limit to every model in the family", () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const entity = entityWith({ "gpt-5.2": NOW + 60_000 });
			expect(isRateLimitedForFamily(entity, "gpt-5.2")).toBe(true);
			expect(isRateLimitedForFamily(entity, "gpt-5.2", "gpt-5.2-codex")).toBe(
				true,
			);
		});

		it("prunes expired entries as a side effect before answering", () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const entity = entityWith({
				"gpt-5.2": NOW - 1,
				"gpt-5.3": NOW + 60_000,
			});
			expect(isRateLimitedForFamily(entity, "gpt-5.2")).toBe(false);
			expect(entity.rateLimitResetTimes).toStrictEqual({
				"gpt-5.3": NOW + 60_000,
			});
		});
	});

	describe("formatWaitTime", () => {
		it.each([
			[0, "0s"],
			[-5_000, "0s"],
			[999, "0s"],
			[1_000, "1s"],
			[59_999, "59s"],
			[60_000, "1m 0s"],
			[90_500, "1m 30s"],
			// No hours unit: long waits stay in minutes.
			[3_725_000, "62m 5s"],
		])("formats %dms as %j", (ms, expected) => {
			expect(formatWaitTime(ms)).toBe(expected);
		});
	});
});
