import { describe, expect, it } from "vitest";
import {
	armPoolExhaustionCooldown,
	buildAdaptiveStreamFailoverCandidateOrder,
	clearPoolExhaustionCooldown,
	clearServerBurstCooldown,
	getPoolExhaustionCooldownRemaining,
	getServerBurstCooldownRemaining,
	recordServerBurstFailure,
	resetRequestResilienceStateForTests,
} from "../lib/request/request-resilience.js";

describe("request resilience helpers", () => {
	it("arms and clears the pool exhaustion cooldown", () => {
		resetRequestResilienceStateForTests();
		const now = Date.parse("2026-04-06T00:00:00.000Z");
		armPoolExhaustionCooldown(5_000, now);
		expect(getPoolExhaustionCooldownRemaining(now + 1_000)).toBe(14_000);
		clearPoolExhaustionCooldown();
		expect(getPoolExhaustionCooldownRemaining(now + 1_000)).toBe(0);
	});

	it("arms a short server burst cooldown after repeated multi-account 5xx failures", () => {
		resetRequestResilienceStateForTests();
		const now = Date.parse("2026-04-06T00:00:00.000Z");
		expect(recordServerBurstFailure(0, now)).toBe(0);
		expect(recordServerBurstFailure(1, now + 500)).toBe(0);
		const cooldownUntil = recordServerBurstFailure(2, now + 1_000);
		expect(cooldownUntil).toBeGreaterThan(now + 1_000);
		expect(getServerBurstCooldownRemaining(now + 2_000)).toBeGreaterThan(0);
		clearServerBurstCooldown();
		expect(getServerBurstCooldownRemaining(now + 2_000)).toBe(0);
	});

	it("prefers the freshest eligible alternate account for stream failover", () => {
		const now = Date.parse("2026-04-06T00:00:00.000Z");
		expect(
			buildAdaptiveStreamFailoverCandidateOrder(
				0,
				[
					{ index: 0, lastUsed: now - 5_000, enabled: true, rateLimitResetTimes: {} },
					{ index: 1, lastUsed: now - 20_000, enabled: true, rateLimitResetTimes: {} },
					{ index: 2, lastUsed: now - 1_000, enabled: true, rateLimitResetTimes: {} },
					{
						index: 3,
						lastUsed: now,
						enabled: true,
						coolingDownUntil: now + 10_000,
						rateLimitResetTimes: {},
					},
				],
				now,
			),
		).toEqual([0, 2]);
	});
});
