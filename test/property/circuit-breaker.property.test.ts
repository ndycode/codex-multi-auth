import { afterEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import {
	CircuitBreaker,
	CircuitOpenError,
	type CircuitState,
} from "../../lib/circuit-breaker.js";

// Small, fast windows so generated sequences can cross every timing boundary.
const CONFIG = {
	failureThreshold: 3,
	failureWindowMs: 1_000,
	resetTimeoutMs: 500,
	halfOpenMaxAttempts: 1,
};

const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

type Event =
	| { kind: "failure" }
	| { kind: "success" }
	| { kind: "attempt" }
	| { kind: "advance"; ms: number };

// Advance spans both sides of every boundary: inside the half-open probe
// wait, exactly at resetTimeoutMs, and past failureWindowMs.
const arbEvent: fc.Arbitrary<Event> = fc.oneof(
	fc.constant<Event>({ kind: "failure" }),
	fc.constant<Event>({ kind: "success" }),
	fc.constant<Event>({ kind: "attempt" }),
	fc
		.integer({ min: 1, max: CONFIG.failureWindowMs + 200 })
		.map<Event>((ms) => ({ kind: "advance", ms })),
);

const arbSequence = fc.array(arbEvent, { minLength: 1, maxLength: 40 });

function attemptOutcome(breaker: CircuitBreaker): "allowed" | "rejected" {
	try {
		breaker.canExecute();
		return "allowed";
	} catch (error) {
		expect(error).toBeInstanceOf(CircuitOpenError);
		return "rejected";
	}
}

describe("CircuitBreaker property invariants", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("isAvailable/getTimeUntilAvailable always agree with what canExecute does next", () => {
		fc.assert(
			fc.property(arbSequence, (events) => {
				vi.useFakeTimers();
				try {
					let now = T0;
					vi.setSystemTime(now);
					const breaker = new CircuitBreaker(CONFIG);

					for (const event of events) {
						if (event.kind === "advance") {
							now += event.ms;
							vi.setSystemTime(now);
							continue;
						}
						if (event.kind === "failure") {
							breaker.recordFailure();
						} else if (event.kind === "success") {
							breaker.recordSuccess();
						} else {
							// The published availability view must be a faithful
							// prediction of the very next canExecute() call: callers
							// poll isAvailable()/getTimeUntilAvailable() to decide
							// whether to route to this account.
							const available = breaker.isAvailable(now);
							const wait = breaker.getTimeUntilAvailable(now);
							expect(wait >= 0).toBe(true);
							expect(wait === 0).toBe(available);
							expect(attemptOutcome(breaker)).toBe(
								available ? "allowed" : "rejected",
							);
						}
						const state: CircuitState = breaker.getState();
						expect(["closed", "open", "half-open"]).toContain(state);
						expect(breaker.getFailureCount()).toBeGreaterThanOrEqual(0);
					}
				} finally {
					vi.useRealTimers();
				}
			}),
		);
	});

	it("an open circuit rejects strictly before resetTimeoutMs and admits a probe at it", () => {
		fc.assert(
			fc.property(
				arbSequence,
				fc.integer({ min: 0, max: CONFIG.resetTimeoutMs - 1 }),
				(events, earlyMs) => {
					vi.useFakeTimers();
					try {
						let now = T0;
						vi.setSystemTime(now);
						const breaker = new CircuitBreaker(CONFIG);

						// Drive an arbitrary prefix, then force the breaker open from
						// whatever state it landed in.
						for (const event of events) {
							if (event.kind === "advance") {
								now += event.ms;
								vi.setSystemTime(now);
							} else if (event.kind === "failure") {
								breaker.recordFailure();
							} else if (event.kind === "success") {
								breaker.recordSuccess();
							} else {
								attemptOutcome(breaker);
							}
						}
						// Force a FRESH open transition at the current instant — the
						// prefix may have left the breaker open at an older timestamp,
						// which would make the timing assertions below meaningless.
						// Whatever history the prefix produced, reset + threshold
						// failures must always yield a clean open.
						breaker.reset();
						for (let i = 0; i < CONFIG.failureThreshold; i += 1) {
							breaker.recordFailure();
						}
						expect(breaker.getState()).toBe("open");
						const openedAt = now;

						now = openedAt + earlyMs;
						vi.setSystemTime(now);
						expect(breaker.isAvailable(now)).toBe(false);
						expect(attemptOutcome(breaker)).toBe("rejected");
						expect(breaker.getState()).toBe("open");
						expect(breaker.getTimeUntilAvailable(now)).toBe(
							CONFIG.resetTimeoutMs - earlyMs,
						);
						// getTimeUntilReset() has an independent implementation reading
						// Date.now() internally; under fake timers it must agree while
						// the circuit is open.
						expect(breaker.getTimeUntilReset()).toBe(
							CONFIG.resetTimeoutMs - earlyMs,
						);

						now = openedAt + CONFIG.resetTimeoutMs;
						vi.setSystemTime(now);
						expect(breaker.isAvailable(now)).toBe(true);
						expect(attemptOutcome(breaker)).toBe("allowed");
						expect(breaker.getState()).toBe("half-open");
						// ...and report zero for any non-open state.
						expect(breaker.getTimeUntilReset()).toBe(0);
					} finally {
						vi.useRealTimers();
					}
				},
			),
		);
	});

	it("opens exactly at failureThreshold for failures inside one window, never below it", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: CONFIG.failureThreshold + 2 }),
				fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 6, maxLength: 6 }),
				(count, gaps) => {
					vi.useFakeTimers();
					try {
						let now = T0;
						vi.setSystemTime(now);
						const breaker = new CircuitBreaker(CONFIG);

						for (let i = 0; i < count; i += 1) {
							// Total spread stays within failureWindowMs (6 * 200 > 1000
							// is impossible here because only count-1 <= 4 gaps apply,
							// each <= 200ms), so no failure ever ages out.
							if (i > 0) {
								now += gaps[i - 1] ?? 0;
								vi.setSystemTime(now);
							}
							breaker.recordFailure();
						}

						expect(breaker.getState()).toBe(
							count >= CONFIG.failureThreshold ? "open" : "closed",
						);
						if (count < CONFIG.failureThreshold) {
							expect(breaker.getFailureCount()).toBe(count);
						}
					} finally {
						vi.useRealTimers();
					}
				},
			),
		);
	});

	it("never opens when consecutive failures are spaced beyond the failure window", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.integer({
						min: CONFIG.failureWindowMs + 1,
						max: CONFIG.failureWindowMs * 2,
					}),
					{ minLength: CONFIG.failureThreshold, maxLength: 10 },
				),
				(gaps) => {
					vi.useFakeTimers();
					try {
						let now = T0;
						vi.setSystemTime(now);
						const breaker = new CircuitBreaker(CONFIG);

						breaker.recordFailure();
						for (const gap of gaps) {
							now += gap;
							vi.setSystemTime(now);
							breaker.recordFailure();
							// Each prior failure has aged out, so the window only ever
							// holds the one just recorded.
							expect(breaker.getState()).toBe("closed");
							expect(breaker.getFailureCount()).toBe(1);
						}
					} finally {
						vi.useRealTimers();
					}
				},
			),
		);
	});

	it("a half-open probe slot admits exactly one attempt, then success closes or failure reopens", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.integer({ min: 1, max: 5 }),
				(probeSucceeds, extraAttempts) => {
					vi.useFakeTimers();
					try {
						let now = T0;
						vi.setSystemTime(now);
						const breaker = new CircuitBreaker(CONFIG);

						for (let i = 0; i < CONFIG.failureThreshold; i += 1) {
							breaker.recordFailure();
						}
						now += CONFIG.resetTimeoutMs;
						vi.setSystemTime(now);

						expect(attemptOutcome(breaker)).toBe("allowed");
						for (let i = 0; i < extraAttempts; i += 1) {
							// While the single probe is outstanding, every further
							// attempt in the probe window is rejected.
							expect(attemptOutcome(breaker)).toBe("rejected");
						}

						if (probeSucceeds) {
							breaker.recordSuccess();
							expect(breaker.getState()).toBe("closed");
							expect(breaker.getFailureCount()).toBe(0);
							expect(breaker.isAvailable(now)).toBe(true);
						} else {
							breaker.recordFailure();
							expect(breaker.getState()).toBe("open");
							expect(breaker.isAvailable(now)).toBe(false);
							expect(breaker.getTimeUntilAvailable(now)).toBe(
								CONFIG.resetTimeoutMs,
							);
						}
					} finally {
						vi.useRealTimers();
					}
				},
			),
		);
	});
});
