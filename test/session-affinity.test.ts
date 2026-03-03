import { describe, expect, it } from "vitest";
import { SessionAffinityStore } from "../lib/session-affinity.js";

describe("SessionAffinityStore", () => {
	it("returns remembered account while entry is fresh", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000 });
		store.remember("session-a", 2, 1_000);

		expect(store.getPreferredAccountIndex("session-a", 5_000)).toBe(2);
	});

	it("expires entries after ttl", () => {
		const store = new SessionAffinityStore({ ttlMs: 1_000 });
		store.remember("session-a", 1, 1_000);

		expect(store.getPreferredAccountIndex("session-a", 2_500)).toBeNull();
		expect(store.size()).toBe(0);
	});

	it("evicts oldest entry when max size is reached", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 2 });
		store.remember("s1", 0, 1_000);
		store.remember("s2", 1, 2_000);
		store.remember("s3", 2, 3_000);

		expect(store.getPreferredAccountIndex("s1", 3_100)).toBeNull();
		expect(store.getPreferredAccountIndex("s2", 3_100)).toBe(1);
		expect(store.getPreferredAccountIndex("s3", 3_100)).toBe(2);
	});

	it("forgets all sessions mapped to account", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0);
		store.remember("s2", 1);
		store.remember("s3", 1);

		const removed = store.forgetAccount(1);
		expect(removed).toBe(2);
		expect(store.getPreferredAccountIndex("s2")).toBeNull();
		expect(store.getPreferredAccountIndex("s3")).toBeNull();
		expect(store.getPreferredAccountIndex("s1")).toBe(0);
	});

	it("reindexes sessions after account removal", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0);
		store.remember("s2", 2);
		store.remember("s3", 3);

		const shifted = store.reindexAfterRemoval(1);
		expect(shifted).toBe(2);
		expect(store.getPreferredAccountIndex("s2")).toBe(1);
		expect(store.getPreferredAccountIndex("s3")).toBe(2);
	});
	it("rejects invalid session keys and invalid account indices", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
		store.remember("   ", 1, 1_000);
		store.remember("session-x", Number.NaN, 1_000);
		store.remember("session-y", -1, 1_000);

		expect(store.getPreferredAccountIndex("session-x", 2_000)).toBeNull();
		expect(store.getPreferredAccountIndex(null, 2_000)).toBeNull();
		expect(store.size()).toBe(0);
	});

	it("truncates oversized session keys and can retrieve by truncated form", () => {
		const store = new SessionAffinityStore({ ttlMs: 10_000, maxEntries: 8 });
		const longKey = `  ${"x".repeat(300)}  `;
		const truncated = "x".repeat(256);
		store.remember(longKey, 3, 1_000);

		expect(store.getPreferredAccountIndex(truncated, 2_000)).toBe(3);
	});

	it("does not evict when updating an existing key at capacity", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 2 });
		store.remember("s1", 0, 1_000);
		store.remember("s2", 1, 2_000);
		store.remember("s2", 2, 3_000);

		expect(store.getPreferredAccountIndex("s1", 3_500)).toBe(0);
		expect(store.getPreferredAccountIndex("s2", 3_500)).toBe(2);
		expect(store.size()).toBe(2);
	});

	it("forgets a specific session and no-ops on blank session key", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0, 1_000);
		store.forgetSession("   ");
		store.forgetSession("s1");

		expect(store.getPreferredAccountIndex("s1", 2_000)).toBeNull();
		expect(store.size()).toBe(0);
	});

	it("returns zero for invalid forget/reindex requests", () => {
		const store = new SessionAffinityStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("s1", 0, 1_000);

		expect(store.forgetAccount(Number.NaN)).toBe(0);
		expect(store.forgetAccount(-1)).toBe(0);
		expect(store.reindexAfterRemoval(Number.NaN)).toBe(0);
		expect(store.reindexAfterRemoval(-1)).toBe(0);
		expect(store.getPreferredAccountIndex("s1", 2_000)).toBe(0);
	});

	it("prunes expired sessions and keeps non-expired entries", () => {
		const store = new SessionAffinityStore({ ttlMs: 1_000, maxEntries: 10 });
		store.remember("s1", 0, 1_000);
		store.remember("s2", 1, 2_000);

		expect(store.prune(2_001)).toBe(1);
		expect(store.getPreferredAccountIndex("s1", 2_001)).toBeNull();
		expect(store.getPreferredAccountIndex("s2", 2_001)).toBe(1);
	});
});
