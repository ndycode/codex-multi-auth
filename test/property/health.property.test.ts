import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { getAccountHealth, formatHealthReport } from "../../lib/health.js";
import {
	clearCircuitBreakers,
	getCircuitBreaker,
} from "../../lib/circuit-breaker.js";

const NOW = new Date("2026-01-01T00:00:00.000Z").getTime();

interface ArbAccount {
	index: number;
	email?: string;
	health: number;
	rateLimitedUntil?: number;
	cooldownUntil?: number;
	cooldownReason?: string;
}

// Timestamps straddle NOW so both sides of the "still limited?" comparisons
// are generated; undefined exercises the ?? 0 fallbacks.
const arbTimestamp = fc.option(
	fc.integer({ min: NOW - 5_000, max: NOW + 5_000 }),
	{ nil: undefined },
);

const arbAccounts: fc.Arbitrary<ArbAccount[]> = fc
	.array(
		fc.record({
			email: fc.option(fc.constantFrom("a@x.test", "b@x.test"), { nil: undefined }),
			health: fc.integer({ min: 0, max: 100 }),
			rateLimitedUntil: arbTimestamp,
			cooldownUntil: arbTimestamp,
			cooldownReason: fc.option(fc.constantFrom("auth-failure", "rate-limit"), {
				nil: undefined,
			}),
		}),
		{ minLength: 0, maxLength: 8 },
	)
	.map((accounts) => accounts.map((account, index) => ({ ...account, index })));

describe("plugin health property invariants", () => {
	beforeEach(() => {
		clearCircuitBreakers();
	});

	afterEach(() => {
		clearCircuitBreakers();
	});

	it("counts and status derive exactly from the per-account classification", () => {
		fc.assert(
			fc.property(arbAccounts, (accounts) => {
				clearCircuitBreakers();
				const result = getAccountHealth(accounts, NOW);

				expect(result.accountCount).toBe(accounts.length);
				expect(result.timestamp).toBe(NOW);
				expect(result.accounts).toHaveLength(accounts.length);

				let expectedHealthy = 0;
				let expectedRateLimited = 0;
				let expectedCooling = 0;
				for (const [position, account] of accounts.entries()) {
					const reported = result.accounts[position];
					expect(reported?.index).toBe(account.index);
					expect(reported?.email).toBe(account.email);
					expect(reported?.health).toBe(account.health);

					const rateLimited = (account.rateLimitedUntil ?? 0) > NOW;
					const cooling = (account.cooldownUntil ?? 0) > NOW;
					expect(reported?.isRateLimited).toBe(rateLimited);
					expect(reported?.isCoolingDown).toBe(cooling);
					// Fresh circuit registry: every account reads closed.
					expect(reported?.circuitState).toBe("closed");

					if (rateLimited) expectedRateLimited += 1;
					if (cooling) expectedCooling += 1;
					if (!rateLimited && !cooling && account.health >= 50) expectedHealthy += 1;
				}

				expect(result.healthyAccountCount).toBe(expectedHealthy);
				expect(result.rateLimitedCount).toBe(expectedRateLimited);
				expect(result.coolingDownCount).toBe(expectedCooling);

				// Status partition: an empty pool reads healthy (nothing is wrong),
				// a pool with zero healthy accounts is unhealthy, anything between
				// is degraded.
				const expectedStatus =
					accounts.length === 0
						? "healthy"
						: expectedHealthy === 0
							? "unhealthy"
							: expectedHealthy < accounts.length
								? "degraded"
								: "healthy";
				expect(result.status).toBe(expectedStatus);
			}),
		);
	});

	it("an open circuit disqualifies an otherwise perfect account from the healthy count", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 6 }),
				(count, trippedRaw) => {
					clearCircuitBreakers();
					const tripped = new Set(trippedRaw.filter((index) => index < count));
					// Identity-less accounts so getAccountHealth keys circuits by the
					// documented account:<index> fallback.
					const accounts = Array.from({ length: count }, (_, index) => ({
						index,
						health: 100,
					}));
					for (const index of tripped) {
						const breaker = getCircuitBreaker(`account:${index}`);
						breaker.recordFailure();
						breaker.recordFailure();
						breaker.recordFailure();
					}

					const result = getAccountHealth(accounts, NOW);
					for (const reported of result.accounts) {
						expect(reported.circuitState).toBe(
							tripped.has(reported.index) ? "open" : "closed",
						);
					}
					expect(result.healthyAccountCount).toBe(count - tripped.size);
					expect(result.status).toBe(
						tripped.size === 0
							? "healthy"
							: tripped.size === count
								? "unhealthy"
								: "degraded",
					);
				},
			),
		);
	});

	it("the formatted report names every account with its health and exact flags", () => {
		fc.assert(
			fc.property(arbAccounts, (accounts) => {
				clearCircuitBreakers();
				const health = getAccountHealth(accounts, NOW);
				const report = formatHealthReport(health);
				const lines = report.split("\n");

				expect(lines[0]).toBe(`Plugin Health: ${health.status.toUpperCase()}`);
				expect(report).toContain(
					`Accounts: ${health.healthyAccountCount}/${health.accountCount} healthy`,
				);
				expect(report.includes("Rate Limited:")).toBe(health.rateLimitedCount > 0);
				expect(report.includes("Cooling Down:")).toBe(health.coolingDownCount > 0);

				for (const account of health.accounts) {
					const label = account.email ?? `Account ${account.index + 1}`;
					const line = lines.find((candidate) =>
						candidate.startsWith(`  [${account.index + 1}] ${label}:`),
					);
					expect(line).toBeDefined();
					expect(line).toContain(`${account.health}%`);
					expect(line?.includes("rate-limited")).toBe(account.isRateLimited);
					expect(line?.includes("cooling-")).toBe(account.isCoolingDown);
					// Fresh registry: no circuit flags ever appear.
					expect(line?.includes("circuit-")).toBe(false);
				}
			}),
		);
	});
});
