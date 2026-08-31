import { describe, expect, it } from "vitest";
import { ContextBudgetGuard } from "../lib/context-budget-guard.js";

const MODEL = "gpt-5.5";

describe("context budget guard", () => {
	it("is disabled by default", () => {
		const guard = new ContextBudgetGuard();
		guard.update("session-1", { model: MODEL, totalTokens: 1_000_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("returns ok for a session with no recorded usage yet", () => {
		const guard = new ContextBudgetGuard({ enabled: true });
		expect(guard.getAdvisory("never-seen")).toEqual({ level: "ok" });
	});

	it("returns ok for an unestimated model even when enabled", () => {
		const guard = new ContextBudgetGuard({ enabled: true });
		guard.update("session-1", {
			model: "gpt-5.6-sol",
			totalTokens: 500_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("fires soft at the configured percent and hard past it", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			softPercent: 50,
			hardPercent: 80,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});

		guard.update("session-1", { model: MODEL, totalTokens: 40_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("ok");

		guard.update("session-1", { model: MODEL, totalTokens: 55_000, updatedAt: 0 });
		const soft = guard.getAdvisory("session-1");
		expect(soft.level).toBe("soft");
		if (soft.level !== "ok") {
			expect(soft.windowSource).toBe("override");
			expect(soft.windowTokens).toBe(100_000);
		}

		guard.update("session-1", { model: MODEL, totalTokens: 85_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");
	});

	it("clears back to ok once usage drops (e.g. after /compact)", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, totalTokens: 90_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");

		guard.update("session-1", { model: MODEL, totalTokens: 10_000, updatedAt: 1 });
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("degrades a misconfigured soft >= hard rather than crashing or blocking always", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			softPercent: 90,
			hardPercent: 80,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		// soft clamped below hard (79), not left >= hard.
		guard.update("session-1", { model: MODEL, totalTokens: 75_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("ok");
		guard.update("session-1", { model: MODEL, totalTokens: 79_500, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("soft");
	});

	it("never guesses an override for an unestimated model, even when configured for another model", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { "some-other-model": 50_000 },
		});
		guard.update("session-1", {
			model: "gpt-5.6-sol",
			totalTokens: 900_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("evaluates percent against the model recorded on the latest turn, not a stale one", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { "small-model": 10_000, "big-model": 1_000_000 },
		});
		guard.update("session-1", {
			model: "small-model",
			totalTokens: 9_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1").level).toBe("hard");

		// Session moved to a model with a much larger window on the next turn.
		guard.update("session-1", {
			model: "big-model",
			totalTokens: 9_000,
			updatedAt: 1,
		});
		expect(guard.getAdvisory("session-1").level).toBe("ok");
	});

	it("prunes sessions untouched past the TTL", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, totalTokens: 90_000, updatedAt: 0 });
		const removed = guard.prune(7 * 60 * 60_000);
		expect(removed).toBe(1);
		expect(guard.getAdvisory("session-1", 7 * 60 * 60_000)).toEqual({ level: "ok" });
	});

	it("forgets a single session on request", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, totalTokens: 90_000, updatedAt: 0 });
		guard.forget("session-1");
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("treats an empty key as a no-op in both update and getAdvisory", () => {
		const guard = new ContextBudgetGuard({ enabled: true });
		guard.update("", { model: MODEL, totalTokens: 900_000, updatedAt: 0 });
		expect(guard.getAdvisory("")).toEqual({ level: "ok" });
	});
});
