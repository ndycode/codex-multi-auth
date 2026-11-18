import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountManager, isRateLimitedForFamily } from "../lib/accounts.js";
import { RATE_LIMIT_CACHE_TTL_MS } from "../lib/constants.js";
import { boundRateLimitCache } from "../lib/accounts/rate-limits.js";
import { PreemptiveQuotaScheduler } from "../lib/preemptive-quota-scheduler.js";
import { isQuotaCacheEntryExhausted } from "../lib/quota-readiness.js";
import { loadAccounts, setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const tmpDirs: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	setStoragePathDirect(null);
	for (const dir of tmpDirs.splice(0)) await removeWithRetry(dir, { recursive: true, force: true });
});

function writeLegacyPool(resetAt: number, now: number): string {
	const dir = mkdtempSync(join(tmpdir(), "rate-limit-ttl-"));
	tmpDirs.push(dir);
	const path = join(dir, "openai-codex-accounts.json");
	const storage: AccountStorageV3 = { version: 3, activeIndex: 0, activeIndexByFamily: { codex: 0 }, accounts: [{
		accountId: "acc-ttl", email: "ttl@example.com", refreshToken: "RT_TTL", accessToken: "AT_TTL",
		expiresAt: now + 24 * RATE_LIMIT_CACHE_TTL_MS, addedAt: now, lastUsed: now,
		rateLimitResetTimes: { codex: resetAt },
	}] };
	writeFileSync(path, JSON.stringify(storage), "utf8");
	setStoragePathDirect(path);
	return path;
}

const persistedReset = (path: string) =>
	(JSON.parse(readFileSync(path, "utf8")) as AccountStorageV3).accounts[0]?.rateLimitResetTimes?.codex;
describe("hourly rate-limit cache revalidation", () => {
	it("bounds legacy deadlines without extending shorter or already persisted bounds", () => {
		const now = 1_000_000;
		const old = { codex: now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS, "codex:model": now + 30_000 };
		const bounded = boundRateLimitCache(old, now);
		expect(bounded).toEqual({ codex: now + RATE_LIMIT_CACHE_TTL_MS, "codex:model": now + 30_000 });
		expect(boundRateLimitCache(bounded, now + 10_000)).toEqual(bounded);
		expect(old.codex).toBe(now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS);
	});

	it("keeps the deadline across a manager reload and retains independent auth blockers", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
		const now = Date.now();
		const stored: AccountStorageV3 = { version: 3, activeIndex: 0, accounts: [{
			refreshToken: "synthetic-refresh", addedAt: now, lastUsed: now,
			rateLimitResetTimes: { codex: now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS },
			authInvalidatedAt: now,
		}] };
		const manager = new AccountManager(undefined, stored);
		const snapshot = manager.buildStorageSnapshot();
		vi.advanceTimersByTime(RATE_LIMIT_CACHE_TTL_MS - 1);
		const restored = new AccountManager(undefined, snapshot);
		const account = restored.getAccountByIndex(0)!;
		expect(isRateLimitedForFamily(account, "codex")).toBe(true);
		vi.advanceTimersByTime(1);
		expect(isRateLimitedForFamily(account, "codex")).toBe(false);
		expect(account.authInvalidatedAt).toBe(now);
	});

	it.each([200, 429])("expires a %i snapshot at exactly an hour without sliding on reads", status => {
		const now = 1_000_000;
		const scheduler = new PreemptiveQuotaScheduler();
		const snapshot = { status, primary: { usedPercent: 100, resetAtMs: now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS }, secondary: {}, updatedAt: now };
		scheduler.update("account:model", snapshot);
		expect(scheduler.getDeferral("account:model", now + RATE_LIMIT_CACHE_TTL_MS - 1)).toMatchObject({ defer: true, waitMs: 1 });
		expect(scheduler.getDeferral("account:model", now + RATE_LIMIT_CACHE_TTL_MS)).toEqual({ defer: false, waitMs: 0 });
		expect(isQuotaCacheEntryExhausted(snapshot, now + RATE_LIMIT_CACHE_TTL_MS - 1)).toBe(true);
		expect(isQuotaCacheEntryExhausted(snapshot, now + RATE_LIMIT_CACHE_TTL_MS)).toBe(false);
	});

	it("persists a bounded legacy deadline through saveToDisk so a restart does not extend it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
		const now = Date.now();
		const path = writeLegacyPool(now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS, now);
		const stored = await loadAccounts();
		const manager = new AccountManager(undefined, stored);
		await manager.saveToDisk();
		expect(persistedReset(path)).toBe(now + RATE_LIMIT_CACHE_TTL_MS);

		vi.setSystemTime(now + 30 * 60_000);
		const restarted = await AccountManager.loadFromDisk();
		const account = restarted.getAccountByIndex(0)!;
		expect(account.rateLimitResetTimes.codex).toBe(now + RATE_LIMIT_CACHE_TTL_MS);
		await restarted.saveToDisk();
		expect(persistedReset(path)).toBe(now + RATE_LIMIT_CACHE_TTL_MS);
		vi.setSystemTime(now + RATE_LIMIT_CACHE_TTL_MS);
		expect(isRateLimitedForFamily(account, "codex")).toBe(false);
	});

	it("persists the bound on load so restarts without another save do not slide it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
		const now = Date.now();
		const path = writeLegacyPool(now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS, now);
		await AccountManager.loadFromDisk();
		expect(persistedReset(path)).toBe(now + RATE_LIMIT_CACHE_TTL_MS);
		vi.setSystemTime(now + 30 * 60_000);
		const restarted = await AccountManager.loadFromDisk();
		expect(restarted.getAccountByIndex(0)!.rateLimitResetTimes.codex).toBe(now + RATE_LIMIT_CACHE_TTL_MS);
		expect(persistedReset(path)).toBe(now + RATE_LIMIT_CACHE_TTL_MS);
	});

	it("keeps a newer concurrent rejection when saving a bounded legacy deadline", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
		const now = Date.now();
		const path = writeLegacyPool(now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS, now);
		const manager = new AccountManager(undefined, await loadAccounts());
		vi.setSystemTime(now + 40 * 60_000);
		const concurrent = JSON.parse(readFileSync(path, "utf8")) as AccountStorageV3;
		concurrent.accounts[0]!.rateLimitResetTimes = { codex: now + 100 * 60_000 };
		writeFileSync(path, JSON.stringify(concurrent), "utf8");
		await manager.saveToDisk();
		expect(persistedReset(path)).toBe(now + 100 * 60_000);
	});
});
