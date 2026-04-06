import { describe, expect, it } from "vitest";
import {
	buildStreamFailoverCandidateOrder,
	capStreamFailoverMax,
	computeOutboundRequestAttemptBudget,
} from "../lib/request/request-attempt-budget.js";

describe("request attempt budget", () => {
	it("caps stream failover to a single retry", () => {
		expect(capStreamFailoverMax(0)).toBe(0);
		expect(capStreamFailoverMax(1)).toBe(1);
		expect(capStreamFailoverMax(3)).toBe(1);
	});

	it("caps outbound request budgets for large account pools", () => {
		expect(
			computeOutboundRequestAttemptBudget({
				accountCount: 12,
				maxSameAccountRetries: 2,
				emptyResponseMaxRetries: 2,
				streamFailoverMax: 3,
			}),
		).toBe(6);
	});

	it("sanitizes non-finite retry inputs to deterministic defaults", () => {
		expect(
			computeOutboundRequestAttemptBudget({
				accountCount: Number.NaN,
				maxSameAccountRetries: Number.POSITIVE_INFINITY,
				emptyResponseMaxRetries: Number.NEGATIVE_INFINITY,
				streamFailoverMax: Number.NaN,
			}),
		).toBe(1);
	});

	it("keeps the primary stream account plus at most one alternate", () => {
		expect(
			buildStreamFailoverCandidateOrder(2, [2, 5, 2, 7, 9]),
		).toEqual([2, 5]);
	});
});
