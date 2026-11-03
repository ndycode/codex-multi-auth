import { describe, expect, it } from "vitest";
import { workspaceQuotaKey } from "../lib/accounts/rate-limits.js";
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
	it("admits a healthy selected workspace despite a sibling's deadline", () => {
		const now=Date.now();
		const alternate={index:1,lastUsed:now,enabled:true,accountId:"a",workspaces:[{id:"a"},{id:"b"}],currentWorkspaceIndex:1,rateLimitResetTimes:{[workspaceQuotaKey("codex","a")]:now+60000}};
		const accounts=[{index:0,lastUsed:now,rateLimitResetTimes:{}},alternate];
		expect(buildAdaptiveStreamFailoverCandidateOrder(0,accounts,now)).toEqual([0,1]);
		alternate.currentWorkspaceIndex=0;
		expect(buildAdaptiveStreamFailoverCandidateOrder(0,accounts,now)).toEqual([0]);
	});
	it("arms and clears the pool exhaustion cooldown", () => {
		resetRequestResilienceStateForTests();
		const now = Date.parse("2026-04-06T00:00:00.000Z");
		armPoolExhaustionCooldown(5_000, now);
		expect(getPoolExhaustionCooldownRemaining(now + 1_000)).toBe(14_000);
		clearPoolExhaustionCooldown();
		expect(getPoolExhaustionCooldownRemaining(now + 1_000)).toBe(0);
	});

	it("keeps pool exhaustion cooldown monotonic when re-armed with a shorter wait", () => {
		resetRequestResilienceStateForTests();
		const now = Date.parse("2026-04-06T00:00:00.000Z");
		const first = armPoolExhaustionCooldown(30_000, now);
		const second = armPoolExhaustionCooldown(5_000, now + 1_000);

		expect(second).toBe(first);
		expect(getPoolExhaustionCooldownRemaining(now + 2_000)).toBe(28_000);
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

	it("keeps an armed server burst cooldown active across later failures", () => {
		resetRequestResilienceStateForTests();
		const now = Date.parse("2026-04-06T00:00:00.000Z");
		expect(recordServerBurstFailure(0, now)).toBe(0);
		expect(recordServerBurstFailure(1, now + 5_000)).toBe(0);
		const cooldownUntil = recordServerBurstFailure(2, now + 9_000);
		expect(cooldownUntil).toBeGreaterThan(now + 9_000);

		const laterFailure = recordServerBurstFailure(3, now + 12_000);
		expect(laterFailure).toBe(cooldownUntil);
		expect(getServerBurstCooldownRemaining(now + 12_500)).toBeGreaterThan(0);
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
