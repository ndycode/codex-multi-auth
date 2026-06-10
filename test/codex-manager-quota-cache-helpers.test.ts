import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaCacheData, QuotaCacheEntry } from "../lib/quota-cache.js";
import type { CodexQuotaSnapshot } from "../lib/quota-probe.js";
import {
	cloneQuotaCacheData,
	getPersistedQuotaViewForAccount,
	pruneUnsafeQuotaEmailCacheEntry,
	updateQuotaCacheForAccount,
} from "../lib/codex-manager/quota-cache-helpers.js";
import { DEFAULT_MODEL } from "../lib/request/helpers/model-map.js";

const NOW = 1_700_000_000_000;

function makeEntry(overrides: Partial<QuotaCacheEntry> = {}): QuotaCacheEntry {
	return {
		updatedAt: NOW - 1_000,
		status: 200,
		model: "gpt-5-codex",
		primary: { usedPercent: 50, windowMinutes: 300, resetAtMs: NOW + 10_000 },
		secondary: { usedPercent: 10, windowMinutes: 10080, resetAtMs: NOW + 20_000 },
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<CodexQuotaSnapshot> = {}): CodexQuotaSnapshot {
	return {
		status: 200,
		model: "gpt-5-codex",
		primary: { usedPercent: 75, windowMinutes: 300, resetAtMs: NOW + 30_000 },
		secondary: { usedPercent: 20, windowMinutes: 10080, resetAtMs: NOW + 40_000 },
		...overrides,
	};
}

function makeCache(overrides: Partial<QuotaCacheData> = {}): QuotaCacheData {
	return { byAccountId: {}, byEmail: {}, ...overrides };
}

const uniqueAccount = { accountId: "acc_a", email: "a@example.com" };
const accounts = [uniqueAccount, { accountId: "acc_b", email: "b@example.com" }];

describe("getPersistedQuotaViewForAccount", () => {
	it("returns the cached entry for a unique account id when no persisted reset exists", () => {
		const entry = makeEntry();
		const cache = makeCache({ byAccountId: { acc_a: entry } });
		expect(
			getPersistedQuotaViewForAccount(cache, uniqueAccount, accounts, NOW),
		).toBe(entry);
	});

	it("returns null with no cache and no persisted rate-limit reset", () => {
		expect(getPersistedQuotaViewForAccount(null, uniqueAccount, accounts, NOW)).toBeNull();
	});

	it("synthesizes a 429 view from a persisted reset when the cache is empty", () => {
		const account = {
			...uniqueAccount,
			rateLimitResetTimes: { codex: NOW + 60_000 },
		};
		expect(
			getPersistedQuotaViewForAccount(null, account, accounts, NOW),
		).toEqual({
			updatedAt: NOW,
			status: 429,
			model: DEFAULT_MODEL,
			planType: undefined,
			primary: { resetAtMs: NOW + 60_000 },
			secondary: {},
		});
	});

	it("keeps a cached 429 that already covers the persisted reset", () => {
		const entry = makeEntry({
			status: 429,
			primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: NOW + 90_000 },
		});
		const cache = makeCache({ byAccountId: { acc_a: entry } });
		const account = {
			...uniqueAccount,
			rateLimitResetTimes: { codex: NOW + 60_000 },
		};
		expect(getPersistedQuotaViewForAccount(cache, account, accounts, NOW)).toBe(entry);
	});

	it("upgrades a cached 200 to a 429 view with the max of cached and persisted resets", () => {
		const entry = makeEntry();
		const cache = makeCache({ byAccountId: { acc_a: entry } });
		const account = {
			...uniqueAccount,
			rateLimitResetTimes: { codex: NOW + 60_000 },
		};
		const view = getPersistedQuotaViewForAccount(cache, account, accounts, NOW);
		expect(view).toMatchObject({
			status: 429,
			model: "gpt-5-codex",
			updatedAt: entry.updatedAt,
		});
		expect(view?.primary.resetAtMs).toBe(NOW + 60_000);
		expect(view?.primary.usedPercent).toBe(50);
		expect(view?.secondary).toBe(entry.secondary);
	});
});

describe("updateQuotaCacheForAccount", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes by unique account id and drops the now-redundant email entry", () => {
		const cache = makeCache({
			byEmail: { "a@example.com": makeEntry() },
		});
		expect(updateQuotaCacheForAccount(cache, uniqueAccount, makeSnapshot(), accounts)).toBe(true);
		expect(cache.byAccountId.acc_a).toMatchObject({
			updatedAt: NOW,
			status: 200,
			primary: { usedPercent: 75, windowMinutes: 300, resetAtMs: NOW + 30_000 },
		});
		expect(cache.byEmail).toEqual({});
	});

	it("falls back to the email key when the account id is not unique", () => {
		const duplicated = [
			{ accountId: "acc_dup", email: "a@example.com" },
			{ accountId: "acc_dup", email: "b@example.com" },
		];
		const cache = makeCache();
		expect(
			updateQuotaCacheForAccount(cache, duplicated[0], makeSnapshot(), duplicated),
		).toBe(true);
		expect(cache.byAccountId).toEqual({});
		expect(cache.byEmail["a@example.com"]).toMatchObject({ updatedAt: NOW, status: 200 });
	});

	it("reports no change when neither key is safe to write", () => {
		// Same id AND same email across two accounts: no unique id, no safe
		// email fallback, and nothing cached to prune.
		const clones = [
			{ accountId: "acc_dup", email: "shared@example.com" },
			{ accountId: "acc_dup", email: "shared@example.com" },
		];
		const cache = makeCache();
		expect(updateQuotaCacheForAccount(cache, clones[0], makeSnapshot(), clones)).toBe(false);
		expect(cache).toEqual(makeCache());
	});

	it("prunes a stale email entry when the fallback became unsafe", () => {
		const clones = [
			{ accountId: "acc_dup", email: "shared@example.com" },
			{ accountId: "acc_dup", email: "shared@example.com" },
		];
		const cache = makeCache({
			byEmail: { "shared@example.com": makeEntry() },
		});
		expect(updateQuotaCacheForAccount(cache, clones[0], makeSnapshot(), clones)).toBe(true);
		expect(cache.byEmail).toEqual({});
	});
});

describe("cloneQuotaCacheData", () => {
	it("clones the maps so mutations do not leak back", () => {
		const original = makeCache({
			byAccountId: { acc_a: makeEntry() },
			byEmail: { "a@example.com": makeEntry() },
		});
		const clone = cloneQuotaCacheData(original);
		expect(clone).toEqual(original);
		expect(clone).not.toBe(original);
		delete clone.byAccountId.acc_a;
		clone.byEmail["c@example.com"] = makeEntry();
		expect(original.byAccountId.acc_a).toBeDefined();
		expect(original.byEmail["c@example.com"]).toBeUndefined();
	});
});

describe("pruneUnsafeQuotaEmailCacheEntry", () => {
	it("returns false when the email has no cache entry", () => {
		expect(pruneUnsafeQuotaEmailCacheEntry(makeCache(), "a@example.com", accounts)).toBe(false);
		expect(pruneUnsafeQuotaEmailCacheEntry(makeCache(), undefined, accounts)).toBe(false);
	});

	it("keeps the entry while exactly one account still owns the email", () => {
		const cache = makeCache({ byEmail: { "a@example.com": makeEntry() } });
		expect(pruneUnsafeQuotaEmailCacheEntry(cache, "A@Example.com ", accounts)).toBe(false);
		expect(cache.byEmail["a@example.com"]).toBeDefined();
	});

	it("prunes the entry once the email is shared by multiple accounts", () => {
		const shared = [
			{ accountId: "acc_a", email: "a@example.com" },
			{ accountId: "acc_c", email: "a@example.com" },
		];
		const cache = makeCache({ byEmail: { "a@example.com": makeEntry() } });
		expect(pruneUnsafeQuotaEmailCacheEntry(cache, "a@example.com", shared)).toBe(true);
		expect(cache.byEmail).toEqual({});
	});
});
