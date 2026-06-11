import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import {
	AuthRateLimitError,
	canAttemptAuth,
	checkAuthRateLimit,
	configureAuthRateLimit,
	getAttemptsRemaining,
	getTimeUntilReset,
	recordAuthAttempt,
	resetAllAuthRateLimits,
	resetAuthRateLimit,
} from "../../lib/auth-rate-limit.js";

// Small window so generated sequences cross the expiry boundary often.
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 1_000;

const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

// Module-level state: namespace ids per iteration so no run can see another
// run's buckets even if a reset were ever missed.
let runCounter = 0;

type Event =
	| { kind: "record"; account: number }
	| { kind: "reset"; account: number }
	| { kind: "advance"; ms: number };

const arbEvent: fc.Arbitrary<Event> = fc.oneof(
	fc.record({ kind: fc.constant("record" as const), account: fc.integer({ min: 0, max: 2 }) }),
	fc.record({ kind: fc.constant("reset" as const), account: fc.integer({ min: 0, max: 2 }) }),
	fc.record({
		kind: fc.constant("advance" as const),
		ms: fc.integer({ min: 1, max: WINDOW_MS + 200 }),
	}),
);

const arbSequence = fc.array(arbEvent, { minLength: 1, maxLength: 40 });

// The limiter canonicalizes ids by trim + lowercase; generate decorated
// spellings so every property also exercises that mapping.
const arbDecoration = fc.constantFrom(
	(id: string) => id,
	(id: string) => id.toUpperCase(),
	(id: string) => `  ${id}`,
	(id: string) => `${id}\t`,
	(id: string) => ` ${id.toUpperCase()} `,
);

describe("auth rate limit property invariants", () => {
	beforeEach(() => {
		configureAuthRateLimit({ maxAttempts: MAX_ATTEMPTS, windowMs: WINDOW_MS });
		resetAllAuthRateLimits();
	});

	afterEach(() => {
		// configureAuthRateLimit merges partials over module state; restore the
		// documented defaults explicitly so later suites see them.
		configureAuthRateLimit({ maxAttempts: 5, windowMs: 60_000 });
		resetAllAuthRateLimits();
		vi.useRealTimers();
	});

	it("matches a sliding-window oracle under any record/reset/advance sequence", () => {
		fc.assert(
			fc.property(arbSequence, fc.array(arbDecoration, { minLength: 3, maxLength: 3 }), (events, decorations) => {
				vi.useFakeTimers();
				try {
					let now = T0;
					vi.setSystemTime(now);
					resetAllAuthRateLimits();
					const run = runCounter++;
					const ids = [0, 1, 2].map((n) => `account-${run}-${n}@example.com`);
					// Oracle: per canonical account, the raw attempt timestamps.
					const model = new Map<string, number[]>(ids.map((id) => [id, []]));

					const spell = (account: number): string => {
						const decorate = decorations[account] ?? ((id: string) => id);
						return decorate(ids[account] ?? ids[0] ?? "");
					};
					const inWindow = (timestamps: number[]): number[] =>
						timestamps.filter((ts) => ts > now - WINDOW_MS);

					for (const event of events) {
						if (event.kind === "advance") {
							now += event.ms;
							vi.setSystemTime(now);
						} else if (event.kind === "record") {
							recordAuthAttempt(spell(event.account));
							model.get(ids[event.account] ?? "")?.push(now);
						} else if (event.kind === "reset") {
							resetAuthRateLimit(spell(event.account));
							model.set(ids[event.account] ?? "", []);
						}

						// Every account agrees with the oracle after every step,
						// regardless of which spelling recorded the attempts.
						for (const [index, id] of ids.entries()) {
							const live = inWindow(model.get(id) ?? []).length;
							const expectedRemaining = Math.max(0, MAX_ATTEMPTS - live);
							expect(getAttemptsRemaining(spell(index))).toBe(expectedRemaining);
							expect(canAttemptAuth(id)).toBe(live < MAX_ATTEMPTS);
						}
					}
				} finally {
					vi.useRealTimers();
				}
			}),
		);
	});

	it("checkAuthRateLimit throws exactly when blocked, carrying the live reset hint", () => {
		fc.assert(
			fc.property(arbSequence, (events) => {
				vi.useFakeTimers();
				try {
					let now = T0;
					vi.setSystemTime(now);
					resetAllAuthRateLimits();
					const id = `gate-${runCounter++}@example.com`;

					for (const event of events) {
						if (event.kind === "advance") {
							now += event.ms;
							vi.setSystemTime(now);
						} else if (event.kind === "record") {
							recordAuthAttempt(id);
						} else if (event.kind === "reset") {
							resetAuthRateLimit(id);
						}

						const allowed = canAttemptAuth(id);
						if (allowed) {
							expect(() => checkAuthRateLimit(id)).not.toThrow();
						} else {
							let thrown: unknown;
							try {
								checkAuthRateLimit(id);
							} catch (error) {
								thrown = error;
							}
							expect(thrown).toBeInstanceOf(AuthRateLimitError);
							const gateError = thrown as AuthRateLimitError;
							expect(gateError.accountId).toBe(id);
							expect(gateError.attemptsRemaining).toBe(0);
							expect(gateError.resetAfterMs).toBe(getTimeUntilReset(id));
							expect(gateError.resetAfterMs).toBeGreaterThan(0);
						}
					}
				} finally {
					vi.useRealTimers();
				}
			}),
		);
	});

	it("a blocked account always unblocks after a full quiet window", () => {
		fc.assert(
			fc.property(
				// Burst beyond maxAttempts to prove over-recording cannot wedge the
				// bucket shut past one full window of silence.
				fc.integer({ min: MAX_ATTEMPTS, max: MAX_ATTEMPTS * 4 }),
				// One gap per attempt after the first, sized for the largest burst
				// so every inter-attempt spacing stays generator-driven.
				fc.array(fc.integer({ min: 0, max: 50 }), {
					minLength: MAX_ATTEMPTS * 4 - 1,
					maxLength: MAX_ATTEMPTS * 4 - 1,
				}),
				(burst, gaps) => {
					vi.useFakeTimers();
					try {
						let now = T0;
						vi.setSystemTime(now);
						resetAllAuthRateLimits();
						const id = `burst-${runCounter++}@example.com`;

						for (let i = 0; i < burst; i += 1) {
							if (i > 0) {
								now += gaps[i - 1] ?? 0;
								vi.setSystemTime(now);
							}
							recordAuthAttempt(id);
						}
						expect(canAttemptAuth(id)).toBe(false);
						expect(getTimeUntilReset(id)).toBeGreaterThan(0);
						expect(getTimeUntilReset(id)).toBeLessThanOrEqual(WINDOW_MS);

						now += WINDOW_MS + 1;
						vi.setSystemTime(now);
						expect(canAttemptAuth(id)).toBe(true);
						expect(getAttemptsRemaining(id)).toBe(MAX_ATTEMPTS);
						expect(getTimeUntilReset(id)).toBe(0);
					} finally {
						vi.useRealTimers();
					}
				},
			),
		);
	});
});
