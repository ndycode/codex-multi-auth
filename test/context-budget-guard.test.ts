import { describe, expect, it } from "vitest";
import { ContextBudgetGuard } from "../lib/context-budget-guard.js";

const MODEL = "gpt-5.5";

describe("context budget guard", () => {
	it("is disabled by default", () => {
		const guard = new ContextBudgetGuard();
		guard.update("session-1", { model: MODEL, contextTokens: 1_000_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("records nothing at all while disabled", () => {
		// Both call sites invoke update() on every forwarded turn without
		// checking the flag, so a default-off install must not accumulate a
		// per-session map it will never read.
		const guard = new ContextBudgetGuard({
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, contextTokens: 99_000, updatedAt: 0 });
		guard.configure({ enabled: true });
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("drops what it tracked when it is switched off", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, contextTokens: 99_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");
		guard.configure({ enabled: false });
		guard.configure({ enabled: true });
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
			contextTokens: 500_000,
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

		guard.update("session-1", { model: MODEL, contextTokens: 40_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("ok");

		guard.update("session-1", { model: MODEL, contextTokens: 55_000, updatedAt: 0 });
		const soft = guard.getAdvisory("session-1");
		expect(soft.level).toBe("soft");
		if (soft.level !== "ok") {
			expect(soft.windowSource).toBe("override");
			expect(soft.windowTokens).toBe(100_000);
		}

		guard.update("session-1", { model: MODEL, contextTokens: 85_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");
	});

	it("clears back to ok once usage drops (e.g. after /compact)", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, contextTokens: 90_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");

		guard.update("session-1", { model: MODEL, contextTokens: 10_000, updatedAt: 1 });
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
		guard.update("session-1", { model: MODEL, contextTokens: 75_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("ok");
		guard.update("session-1", { model: MODEL, contextTokens: 79_500, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("soft");
	});

	it("never guesses an override for an unestimated model, even when configured for another model", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { "some-other-model": 50_000 },
		});
		guard.update("session-1", {
			model: "gpt-5.6-sol",
			contextTokens: 900_000,
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
			contextTokens: 9_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1").level).toBe("hard");

		// Session moved to a model with a much larger window on the next turn.
		guard.update("session-1", {
			model: "big-model",
			contextTokens: 9_000,
			updatedAt: 1,
		});
		expect(guard.getAdvisory("session-1").level).toBe("ok");
	});

	it("prunes sessions untouched past the TTL", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, contextTokens: 90_000, updatedAt: 0 });
		const removed = guard.prune(7 * 60 * 60_000);
		expect(removed).toBe(1);
		expect(guard.getAdvisory("session-1", 7 * 60 * 60_000)).toEqual({ level: "ok" });
	});

	it("forgets a single session on request", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, contextTokens: 90_000, updatedAt: 0 });
		guard.forget("session-1");
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("treats an empty key as a no-op in both update and getAdvisory", () => {
		const guard = new ContextBudgetGuard({ enabled: true });
		guard.update("", { model: MODEL, contextTokens: 900_000, updatedAt: 0 });
		expect(guard.getAdvisory("")).toEqual({ level: "ok" });
	});

	it("ignores a non-finite or negative token count instead of recording it", () => {
		// percent is a division by the window: a non-finite count puts
		// "Infinity%" in the notice a user reads, and every threshold comparison
		// against NaN is false, which disables the guard silently.
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			guard.update("session-1", {
				model: MODEL,
				contextTokens: bad,
				updatedAt: 0,
			});
			expect(guard.getAdvisory("session-1", 0, MODEL), `${bad}`).toEqual({
				level: "ok",
			});
		}
		// A good value still records after a rejected one.
		guard.update("session-1", {
			model: MODEL,
			contextTokens: 99_000,
			updatedAt: 1,
		});
		expect(guard.getAdvisory("session-1", 1, MODEL).level).toBe("hard");
	});

	it("evaluates the window of the model the NEXT request will use", () => {
		// The snapshot says how much context the session carries; the window
		// belongs to the model about to be sent. Pairing carried tokens with the
		// PREVIOUS turn's window pauses a switch to a roomier model for no reason.
		const guard = new ContextBudgetGuard({
			enabled: true,
			hardPercent: 80,
			modelWindowOverrides: { "small-model": 100_000, "big-model": 1_000_000 },
		});
		guard.update("session-1", {
			model: "small-model",
			contextTokens: 90_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1", 0, "small-model").level).toBe("hard");
		// 90k of 1M is 9%: nothing to pause.
		expect(guard.getAdvisory("session-1", 0, "big-model")).toEqual({ level: "ok" });
	});

	it("does not pause a request for a model it refuses to estimate", () => {
		const guard = new ContextBudgetGuard({ enabled: true, hardPercent: 70 });
		guard.update("session-1", {
			model: "gpt-5-codex",
			contextTokens: 250_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1", 0, "gpt-5-codex").level).toBe("hard");
		// gpt-5.6-sol is in UNESTIMATED_ROUTABLE_MODELS: cannot evaluate, so it
		// must not be paused against the previous model's window.
		expect(guard.getAdvisory("session-1", 0, "gpt-5.6-sol")).toEqual({ level: "ok" });
	});

	it("names the model it evaluated, not the one it last recorded", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			hardPercent: 50,
			modelWindowOverrides: { "old-model": 100_000, "new-model": 100_000 },
		});
		guard.update("session-1", {
			model: "old-model",
			contextTokens: 90_000,
			updatedAt: 0,
		});
		const advisory = guard.getAdvisory("session-1", 0, "new-model");
		expect(advisory.level).toBe("hard");
		if (advisory.level !== "ok") expect(advisory.model).toBe("new-model");
	});

	it("falls back to the recorded model when the request declares none", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			hardPercent: 50,
			modelWindowOverrides: { "old-model": 100_000 },
		});
		guard.update("session-1", {
			model: "old-model",
			contextTokens: 90_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1", 0, null).level).toBe("hard");
		expect(guard.getAdvisory("session-1", 0, "   ").level).toBe("hard");
	});

	it("stops repeating a hard pause once the caller has emitted one", () => {
		// The pause short-circuits before the request is forwarded, so update()
		// never runs for it and the recorded usage can never fall on its own.
		// Without this the first crossing wedges the session forever.
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, contextTokens: 90_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");

		guard.noteHardPauseEmitted("session-1");
		// The very next request (e.g. the /compact the pause message asks for)
		// is forwarded rather than paused again.
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("pauses again if the forwarded turn is still over budget", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		guard.update("session-1", { model: MODEL, contextTokens: 90_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");
		guard.noteHardPauseEmitted("session-1");
		expect(guard.getAdvisory("session-1").level).toBe("ok");

		// The let-through turn re-measures and is still over: warn again.
		guard.update("session-1", { model: MODEL, contextTokens: 92_000, updatedAt: 1 });
		expect(guard.getAdvisory("session-1").level).toBe("hard");
	});

	it("floors a hard percent of 0, which would otherwise pause every session", () => {
		const guard = new ContextBudgetGuard({
			enabled: true,
			hardPercent: 0,
			modelWindowOverrides: { [MODEL]: 100_000 },
		});
		// 5% of the window: under any floor worth having, so still ok.
		guard.update("session-1", { model: MODEL, contextTokens: 5_000, updatedAt: 0 });
		expect(guard.getAdvisory("session-1")).toEqual({ level: "ok" });
	});

	it("resolves the window for the raw model string a client actually sends", () => {
		// The rotation proxy passes body.model verbatim; gpt-5-codex is Codex
		// CLI's own default and is an alias, not a table key.
		const guard = new ContextBudgetGuard({ enabled: true, hardPercent: 80 });
		guard.update("session-1", {
			model: "gpt-5-codex",
			contextTokens: 250_000,
			updatedAt: 0,
		});
		const advisory = guard.getAdvisory("session-1");
		expect(advisory.level).toBe("hard");
		if (advisory.level !== "ok") {
			expect(advisory.windowSource).toBe("estimate");
			expect(advisory.windowTokens).toBe(260_000);
		}
	});

	it("resolves the window through a reasoning-suffixed alias", () => {
		const guard = new ContextBudgetGuard({ enabled: true, hardPercent: 80 });
		guard.update("session-1", {
			model: "gpt-5.3-codex-high",
			contextTokens: 250_000,
			updatedAt: 0,
		});
		expect(guard.getAdvisory("session-1").level).toBe("hard");
	});
});
