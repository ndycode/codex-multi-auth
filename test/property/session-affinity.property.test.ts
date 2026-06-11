import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { SessionAffinityStore } from "../../lib/session-affinity.js";

// ttlMs has a 1s floor in the constructor; keep it at the floor so generated
// advances cross the expiry boundary often.
const TTL_MS = 1_000;

const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

const KEYS = ["session-a", "session-b", "session-c"] as const;

// Session keys are normalized by trim; route every call through a decorated
// spelling so the properties also pin that mapping.
const arbDecoration = fc.constantFrom(
	(key: string) => key,
	(key: string) => `  ${key}`,
	(key: string) => `${key}\t`,
	(key: string) => ` ${key} `,
);

type Event =
	| { kind: "remember"; key: number; accountIndex: number }
	| { kind: "updateResponse"; key: number; responseId: string }
	| { kind: "forget"; key: number }
	| { kind: "advance"; ms: number };

const arbEvent: fc.Arbitrary<Event> = fc.oneof(
	fc.record({
		kind: fc.constant("remember" as const),
		key: fc.integer({ min: 0, max: 2 }),
		accountIndex: fc.integer({ min: 0, max: 5 }),
	}),
	fc.record({
		kind: fc.constant("updateResponse" as const),
		key: fc.integer({ min: 0, max: 2 }),
		responseId: fc.constantFrom("resp-1", "resp-2", "resp-3"),
	}),
	fc.record({
		kind: fc.constant("forget" as const),
		key: fc.integer({ min: 0, max: 2 }),
	}),
	fc.record({
		kind: fc.constant("advance" as const),
		ms: fc.integer({ min: 1, max: TTL_MS + 200 }),
	}),
);

const arbSequence = fc.array(arbEvent, { minLength: 1, maxLength: 40 });

interface ModelEntry {
	accountIndex: number;
	expiresAt: number;
	responseId: string | null;
}

describe("SessionAffinityStore property invariants", () => {
	it("matches a TTL model for any remember/update/forget/advance interleaving", () => {
		fc.assert(
			fc.property(
				arbSequence,
				fc.array(arbDecoration, { minLength: 3, maxLength: 3 }),
				(events, decorations) => {
					// maxEntries far above the working set so LRU eviction cannot
					// fire: this property isolates the TTL/upsert semantics.
					const store = new SessionAffinityStore({ ttlMs: TTL_MS, maxEntries: 64 });
					const model = new Map<string, ModelEntry>();
					let now = T0;

					const spell = (key: number): string => {
						const decorate = decorations[key] ?? ((value: string) => value);
						return decorate(KEYS[key] ?? KEYS[0]);
					};
					const liveModel = (key: string): ModelEntry | null => {
						const entry = model.get(key);
						return entry && entry.expiresAt > now ? entry : null;
					};

					for (const event of events) {
						if (event.kind === "advance") {
							now += event.ms;
						} else if (event.kind === "remember") {
							store.remember(spell(event.key), event.accountIndex, now);
							// remember() preserves the continuation id only from a LIVE
							// entry: the assertion block below reads every key after
							// every event, and reads lazily reap expired entries, so an
							// expired entry's id is always gone by the next remember.
							const previous = liveModel(KEYS[event.key] ?? "");
							model.set(KEYS[event.key] ?? "", {
								accountIndex: event.accountIndex,
								expiresAt: now + TTL_MS,
								responseId: previous?.responseId ?? null,
							});
						} else if (event.kind === "updateResponse") {
							store.updateLastResponseId(spell(event.key), event.responseId, now);
							const live = liveModel(KEYS[event.key] ?? "");
							if (live) {
								model.set(KEYS[event.key] ?? "", {
									...live,
									responseId: event.responseId,
									// A response-id write refreshes the session's TTL.
									expiresAt: now + TTL_MS,
								});
							}
							// updateLastResponseId never creates entries; expired or
							// missing sessions stay absent in the model too.
						} else {
							store.forgetSession(spell(event.key));
							model.delete(KEYS[event.key] ?? "");
						}

						for (const [index, key] of KEYS.entries()) {
							const live = liveModel(key);
							expect(store.getPreferredAccountIndex(spell(index), now)).toBe(
								live ? live.accountIndex : null,
							);
							expect(store.getLastResponseId(spell(index), now)).toBe(
								live ? live.responseId : null,
							);
						}
					}
				},
			),
		);
	});

	it("never exceeds maxEntries and always retains the most recently written live session", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.array(
					fc.record({
						key: fc.integer({ min: 0, max: 9 }),
						accountIndex: fc.integer({ min: 0, max: 5 }),
						advanceMs: fc.integer({ min: 1, max: 200 }),
					}),
					{ minLength: 1, maxLength: 30 },
				),
				(maxEntries, writes) => {
					const store = new SessionAffinityStore({ ttlMs: TTL_MS, maxEntries });
					let now = T0;

					for (const write of writes) {
						now += write.advanceMs;
						store.remember(`session-${write.key}`, write.accountIndex, now);
						expect(store.size()).toBeLessThanOrEqual(maxEntries);
						// Eviction removes the oldest updatedAt, so the entry written
						// just now must always survive the insert that may have
						// evicted something else.
						expect(store.getPreferredAccountIndex(`session-${write.key}`, now)).toBe(
							write.accountIndex,
						);
					}
				},
			),
		);
	});

	it("a stale writeVersion never overwrites a live entry but does replace an expired one", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 100 }),
				fc.integer({ min: 0, max: 5 }),
				fc.integer({ min: 0, max: 5 }),
				(freshVersion, firstIndex, secondIndex) => {
					const store = new SessionAffinityStore({ ttlMs: TTL_MS, maxEntries: 8 });
					const staleVersion = freshVersion - 1;

					store.rememberWithVersion("session", firstIndex, T0, freshVersion);
					// Live entry: the stale write must lose, for both the account
					// index and the response id channel.
					store.rememberWithVersion("session", secondIndex, T0 + 1, staleVersion);
					expect(store.getPreferredAccountIndex("session", T0 + 1)).toBe(firstIndex);
					store.updateLastResponseId("session", "resp-stale", T0 + 1, staleVersion);
					expect(store.getLastResponseId("session", T0 + 1)).toBeNull();

					// Expired entry: the same stale version may rebind the session.
					const later = T0 + TTL_MS + 1;
					store.rememberWithVersion("session", secondIndex, later, staleVersion);
					expect(store.getPreferredAccountIndex("session", later)).toBe(secondIndex);
				},
			),
		);
	});

	it("forgetAccount + reindexAfterRemoval mirror an account-array splice", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						key: fc.integer({ min: 0, max: 7 }),
						accountIndex: fc.integer({ min: 0, max: 5 }),
					}),
					{ minLength: 1, maxLength: 16 },
				),
				fc.integer({ min: 0, max: 5 }),
				(writes, removedIndex) => {
					const store = new SessionAffinityStore({ ttlMs: TTL_MS, maxEntries: 32 });
					const model = new Map<string, number>();
					let now = T0;

					for (const write of writes) {
						now += 1;
						store.remember(`session-${write.key}`, write.accountIndex, now);
						model.set(`session-${write.key}`, write.accountIndex);
					}

					const expectedForgotten = [...model.values()].filter(
						(index) => index === removedIndex,
					).length;
					expect(store.forgetAccount(removedIndex)).toBe(expectedForgotten);
					expect(store.reindexAfterRemoval(removedIndex)).toBe(
						[...model.values()].filter((index) => index > removedIndex).length,
					);

					for (const [key, index] of model.entries()) {
						const expected =
							index === removedIndex ? null : index > removedIndex ? index - 1 : index;
						expect(store.getPreferredAccountIndex(key, now)).toBe(expected);
					}
				},
			),
		);
	});

	it("prune removes exactly the expired entries and reads agree before and after", () => {
		fc.assert(
			fc.property(
				arbSequence,
				fc.array(arbDecoration, { minLength: 3, maxLength: 3 }),
				(events, decorations) => {
				const store = new SessionAffinityStore({ ttlMs: TTL_MS, maxEntries: 64 });
				const writtenAt = new Map<string, number>();
				let now = T0;
				const spell = (key: number): string => {
					const decorate = decorations[key] ?? ((value: string) => value);
					return decorate(KEYS[key] ?? KEYS[0]);
				};

				for (const event of events) {
					if (event.kind === "advance") {
						now += event.ms;
					} else if (event.kind === "remember") {
						store.remember(spell(event.key), event.accountIndex, now);
						writtenAt.set(KEYS[event.key] ?? "", now);
					} else if (event.kind === "forget") {
						store.forgetSession(spell(event.key));
						writtenAt.delete(KEYS[event.key] ?? "");
					} else {
						store.updateLastResponseId(spell(event.key), event.responseId, now);
						if ((writtenAt.get(KEYS[event.key] ?? "") ?? -Infinity) + TTL_MS > now) {
							writtenAt.set(KEYS[event.key] ?? "", now);
						} else {
							// Touching an expired session deletes it outright (the store
							// lazily reaps on access), so it must not count as prunable.
							writtenAt.delete(KEYS[event.key] ?? "");
						}
					}
				}

				const expectedExpired = [...writtenAt.values()].filter(
					(at) => at + TTL_MS <= now,
				).length;
				const sizeBefore = store.size();
				expect(store.prune(now)).toBe(expectedExpired);
				expect(store.size()).toBe(sizeBefore - expectedExpired);
				// Pruning is invisible to readers: every surviving session still
				// resolves, every pruned one already read as null.
				for (const [key, at] of writtenAt.entries()) {
					const live = at + TTL_MS > now;
					expect(store.getPreferredAccountIndex(key, now) !== null).toBe(live);
				}
				},
			),
		);
	});

	it("clearAll empties the store completely and leaves it usable (#474 invalidation)", () => {
		fc.assert(
			fc.property(arbSequence, (events) => {
				const store = new SessionAffinityStore({ ttlMs: TTL_MS, maxEntries: 64 });
				let now = T0;
				for (const event of events) {
					if (event.kind === "advance") {
						now += event.ms;
					} else if (event.kind === "remember") {
						store.remember(KEYS[event.key], event.accountIndex, now);
					} else if (event.kind === "updateResponse") {
						store.updateLastResponseId(KEYS[event.key], event.responseId, now);
					} else {
						store.forgetSession(KEYS[event.key]);
					}
				}

				store.clearAll();
				expect(store.size()).toBe(0);
				for (const key of KEYS) {
					expect(store.getPreferredAccountIndex(key, now)).toBeNull();
					expect(store.getLastResponseId(key, now)).toBeNull();
				}
				// The store stays fully usable after invalidation.
				store.remember(KEYS[0], 3, now);
				expect(store.getPreferredAccountIndex(KEYS[0], now)).toBe(3);
			}),
		);
	});
});
