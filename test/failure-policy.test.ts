import { describe, expect, it } from "vitest";
import { evaluateFailurePolicy } from "../lib/request/failure-policy.js";

describe("failure policy", () => {
	it.each([
		[0, false],
		[2, false],
		[3, true],
	] as const)(
		"handles auth-refresh removal boundary for failures=%s",
		(consecutiveAuthFailures, removeAccount) => {
			const decision = evaluateFailurePolicy({
				kind: "auth-refresh",
				consecutiveAuthFailures,
				maxAuthFailuresBeforeRemoval: 3,
			});
			expect(decision.removeAccount).toBe(removeAccount);
			expect(decision.rotateAccount).toBe(true);
			expect(decision.handoffStrategy).toBe("hard");
		},
	);

	it("removes account when auth refresh failures exceed threshold", () => {
		const decision = evaluateFailurePolicy({
			kind: "auth-refresh",
			consecutiveAuthFailures: 3,
			maxAuthFailuresBeforeRemoval: 3,
		});

		expect(decision.removeAccount).toBe(true);
		expect(decision.cooldownReason).toBe("auth-failure");
	});

	it("applies configured network cooldown and rotates", () => {
		const decision = evaluateFailurePolicy(
			{ kind: "network" },
			{ networkCooldownMs: 9_000 },
		);

		expect(decision.rotateAccount).toBe(true);
		expect(decision.refundToken).toBe(true);
		expect(decision.cooldownMs).toBe(9_000);
		expect(decision.cooldownReason).toBe("network-error");
	});

	it("retries same account in balanced network mode", () => {
		const decision = evaluateFailurePolicy(
			{ kind: "network", failoverMode: "balanced" },
			{ networkCooldownMs: 9_000 },
		);

		expect(decision.retrySameAccount).toBe(true);
		expect(decision.retryDelayMs).toBe(250);
		expect(decision.rotateAccount).toBe(false);
		expect(decision.handoffStrategy).toBe("soft");
	});

	it("retries same account for conservative server failures without retry-after", () => {
		const decision = evaluateFailurePolicy(
			{ kind: "server", failoverMode: "conservative" },
			{ serverCooldownMs: 4_000 },
		);

		expect(decision.retrySameAccount).toBe(true);
		expect(decision.retryDelayMs).toBe(500);
		expect(decision.rotateAccount).toBe(false);
		expect(decision.handoffStrategy).toBe("hard");
	});

	it("marks rate limit without cooldown mutation", () => {
		const decision = evaluateFailurePolicy({ kind: "rate-limit" });

		expect(decision.markRateLimited).toBe(true);
		expect(decision.refundToken).toBe(false);
		expect(decision.cooldownMs).toBeUndefined();
	});

	it("rotates immediately in aggressive empty-response mode", () => {
		const decision = evaluateFailurePolicy({
			kind: "empty-response",
			failoverMode: "aggressive",
		});

		expect(decision.retrySameAccount).toBe(false);
		expect(decision.rotateAccount).toBe(true);
		expect(decision.handoffStrategy).toBe("soft");
	});

	it.each([
		["aggressive", false, undefined],
		["balanced", true, 250],
		["conservative", true, 900],
	] as const)(
		"applies network mode matrix for %s",
		(mode, retrySameAccount, retryDelayMs) => {
			const decision = evaluateFailurePolicy({
				kind: "network",
				failoverMode: mode,
			});

			expect(decision.retrySameAccount).toBe(retrySameAccount);
			expect(decision.retryDelayMs).toBe(retryDelayMs);
			expect(decision.rotateAccount).toBe(!retrySameAccount);
			expect(decision.handoffStrategy).toBe("soft");
		},
	);

	it.each([
		["aggressive", false, undefined, true],
		["balanced", false, undefined, true],
		["conservative", true, 500, false],
	] as const)(
		"applies server mode matrix for %s",
		(mode, retrySameAccount, retryDelayMs, rotateAccount) => {
			const decision = evaluateFailurePolicy({
				kind: "server",
				failoverMode: mode,
				serverRetryAfterMs: 0,
			});
			expect(decision.retrySameAccount).toBe(retrySameAccount);
			expect(decision.retryDelayMs).toBe(retryDelayMs);
			expect(decision.rotateAccount).toBe(rotateAccount);
			expect(decision.handoffStrategy).toBe("hard");
		},
	);

	it("retries same account for conservative server mode without retry-after", () => {
		const decision = evaluateFailurePolicy({
			kind: "server",
			failoverMode: "conservative",
			serverRetryAfterMs: 0,
		});

		expect(decision.retrySameAccount).toBe(true);
		expect(decision.retryDelayMs).toBe(500);
		expect(decision.rotateAccount).toBe(false);
	});

	it("rotates on server failures when retry-after is provided", () => {
		const decision = evaluateFailurePolicy({
			kind: "server",
			failoverMode: "conservative",
			serverRetryAfterMs: 3_000,
		});

		expect(decision.retrySameAccount).toBe(false);
		expect(decision.rotateAccount).toBe(true);
		expect(decision.cooldownMs).toBe(3_000);
	});

	it("uses override cooldowns for network and server kinds", () => {
		const network = evaluateFailurePolicy(
			{ kind: "network", failoverMode: "aggressive" },
			{ networkCooldownMs: 0 },
		);
		const server = evaluateFailurePolicy(
			{ kind: "server", failoverMode: "aggressive", serverRetryAfterMs: 0 },
			{ serverCooldownMs: 0 },
		);
		expect(network.cooldownMs).toBe(0);
		expect(network.cooldownReason).toBeUndefined();
		expect(server.cooldownMs).toBe(0);
		expect(server.cooldownReason).toBeUndefined();
	});

	it.each([
		["aggressive", false, undefined],
		["balanced", true, 200],
		["conservative", true, 600],
	] as const)(
		"applies empty-response mode matrix for %s",
		(mode, retrySameAccount, retryDelayMs) => {
			const decision = evaluateFailurePolicy({
				kind: "empty-response",
				failoverMode: mode,
			});

			expect(decision.retrySameAccount).toBe(retrySameAccount);
			expect(decision.retryDelayMs).toBe(retryDelayMs);
			expect(decision.rotateAccount).toBe(!retrySameAccount);
			expect(decision.handoffStrategy).toBe("soft");
		},
	);

	it("falls back to default hard-handoff policy for unknown failure kind", () => {
		const decision = evaluateFailurePolicy({ kind: "unknown" as never });
		expect(decision).toMatchObject({
			rotateAccount: true,
			refundToken: true,
			recordFailure: true,
			removeAccount: false,
			retrySameAccount: false,
			handoffStrategy: "hard",
		});
	});
});
