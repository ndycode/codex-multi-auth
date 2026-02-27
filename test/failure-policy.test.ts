import { describe, expect, it } from "vitest";
import { evaluateFailurePolicy } from "../lib/request/failure-policy.js";

describe("failure policy", () => {
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
});
