import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAccountHealth, formatHealthReport } from "../lib/health.js";
import { clearCircuitBreakers, getCircuitBreaker } from "../lib/circuit-breaker.js";

describe("Health check", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(100000));
		clearCircuitBreakers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns healthy status when all accounts are good", () => {
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 100 },
			{ index: 1, email: "b@test.com", accountId: "acc2", health: 80 },
		];
		const health = getAccountHealth(accounts);
		expect(health.status).toBe("healthy");
		expect(health.accountCount).toBe(2);
		expect(health.healthyAccountCount).toBe(2);
		expect(health.rateLimitedCount).toBe(0);
		expect(health.coolingDownCount).toBe(0);
	});

	it("returns degraded status when some accounts are rate limited", () => {
		const now = Date.now();
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 100 },
			{ index: 1, email: "b@test.com", accountId: "acc2", health: 80, rateLimitedUntil: now + 60000 },
		];
		const health = getAccountHealth(accounts);
		expect(health.status).toBe("degraded");
		expect(health.healthyAccountCount).toBe(1);
		expect(health.rateLimitedCount).toBe(1);
	});

	it("returns unhealthy status when all accounts are unavailable", () => {
		const now = Date.now();
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 100, rateLimitedUntil: now + 60000 },
			{ index: 1, email: "b@test.com", accountId: "acc2", health: 80, cooldownUntil: now + 30000 },
		];
		const health = getAccountHealth(accounts);
		expect(health.status).toBe("unhealthy");
		expect(health.healthyAccountCount).toBe(0);
	});

	it("returns healthy for empty accounts", () => {
		const health = getAccountHealth([]);
		expect(health.status).toBe("healthy");
		expect(health.accountCount).toBe(0);
	});

	it("marks low health accounts as not healthy", () => {
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 30 },
		];
		const health = getAccountHealth(accounts);
		expect(health.status).toBe("unhealthy");
		expect(health.healthyAccountCount).toBe(0);
	});

	it("includes circuit breaker state in account health", () => {
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 100 },
		];
		const circuit = getCircuitBreaker("account:acc1");
		circuit.recordFailure();
		circuit.recordFailure();
		circuit.recordFailure();

		const health = getAccountHealth(accounts);
		expect(health.accounts[0].circuitState).toBe("open");
	});

	it("formats health report correctly", () => {
		const now = Date.now();
		const accounts = [
			{ index: 0, email: "good@test.com", accountId: "acc1", health: 100 },
			{ index: 1, email: "limited@test.com", accountId: "acc2", health: 80, rateLimitedUntil: now + 60000 },
		];
		const health = getAccountHealth(accounts);
		const report = formatHealthReport(health);

		expect(report).toContain("DEGRADED");
		expect(report).toContain("1/2 healthy");
		expect(report).toContain("Rate Limited: 1");
		expect(report).toContain("good@test.com: 100%");
		expect(report).toContain("limited@test.com: 80%");
		expect(report).toContain("rate-limited");
	});

	it("includes cooldown reason in report", () => {
		const now = Date.now();
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 100, cooldownUntil: now + 30000, cooldownReason: "auth-failure" },
		];
		const health = getAccountHealth(accounts);
		const report = formatHealthReport(health);

		expect(report).toContain("cooling-auth-failure");
	});

	it("includes circuit state in report when not closed", () => {
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 100 },
		];
		const circuit = getCircuitBreaker("account:acc1");
		circuit.recordFailure();
		circuit.recordFailure();
		circuit.recordFailure();

		const health = getAccountHealth(accounts);
		const report = formatHealthReport(health);

		expect(report).toContain("circuit-open");
	});

	it("uses account index when accountId is undefined", () => {
		const accounts = [
			{ index: 0, email: "a@test.com", health: 100 },
		];
		const health = getAccountHealth(accounts);
		expect(health.accounts[0].accountId).toBeUndefined();
		expect(health.accounts[0].index).toBe(0);
	});

	it("falls back to 'Account N' when email is undefined", () => {
		const accounts = [
			{ index: 0, accountId: "acc1", health: 100 },
		];
		const health = getAccountHealth(accounts);
		const report = formatHealthReport(health);
		expect(report).toContain("Account 1: 100%");
	});

	it("uses 'cooling-down' when cooldownReason is undefined", () => {
		const now = Date.now();
		const accounts = [
			{ index: 0, email: "a@test.com", accountId: "acc1", health: 100, cooldownUntil: now + 30000 },
		];
		const health = getAccountHealth(accounts);
		const report = formatHealthReport(health);
		expect(report).toContain("cooling-down");
	});

	it("does not show account details when accounts array is empty (line 96 false branch)", () => {
		const health = getAccountHealth([]);
		const report = formatHealthReport(health);
		expect(report).not.toContain("Account Details:");
	});
});
