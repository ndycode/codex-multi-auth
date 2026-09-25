import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager, type ManagedAccount } from "../lib/accounts.js";
import { PreemptiveQuotaScheduler } from "../lib/preemptive-quota-scheduler.js";
import {
	buildQuotaScheduleAccountPrefix,
	buildQuotaScheduleKey,
	resetPinCacheForTesting,
} from "../lib/runtime-rotation-proxy.js";
import {
	type AccountStorageV3,
	readPinAndGenFromDisk,
	setStoragePathDirect,
} from "../lib/storage.js";

const tmpDirs: string[] = [];

function makeTmpDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pr691-${label}-`));
	tmpDirs.push(dir);
	return dir;
}

function makeTmpStoragePath(): string {
	return join(makeTmpDir("storage"), "openai-codex-accounts.json");
}

function createStorage(
	count = 2,
	overrides: Partial<AccountStorageV3> = {},
): AccountStorageV3 {
	const now = Date.now();
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: count }, (_, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - 60_000,
			enabled: true,
		})),
		...overrides,
	};
}

function writeStorageFile(path: string, storage: AccountStorageV3): void {
	writeFileSync(path, JSON.stringify(storage), "utf8");
}

/**
 * Build a manager whose selection metadata reads always fail: the storage path
 * points at a directory, so `existsSync` passes but `readFileSync` raises
 * EISDIR/EPERM. That is the "selection unreadable" branch of
 * `markRateLimitedWithReason`, without stubbing any module.
 */
function managerWithUnreadableSelection(): {
	manager: AccountManager;
	account: ManagedAccount;
} {
	setStoragePathDirect(makeTmpDir("unreadable"));
	const manager = new AccountManager(undefined, createStorage(2));
	const account = manager.getAccountByIndex(0);
	if (!account) throw new Error("fixture account missing");
	return { manager, account };
}

beforeEach(() => {
	resetPinCacheForTesting();
});

afterEach(() => {
	resetPinCacheForTesting();
	setStoragePathDirect(null);
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("readPinAndGenFromDisk strict mode", () => {
	it("throws when the file exists but cannot be read", () => {
		// A newer pin may be hiding behind an EBUSY/EPERM, so persisting our
		// possibly-stale in-memory pin would be the #474 clobber.
		const dir = makeTmpDir("unreadable-strict");
		expect(() => readPinAndGenFromDisk(dir, { strict: true })).toThrow(
			/Unable to read account selection metadata/,
		);
	});

	it("throws on malformed JSON, which can be a torn read of a newer write", () => {
		const path = join(makeTmpDir("torn"), "accounts.json");
		writeFileSync(path, '{"pinnedAccountIndex": 1, "affinityGen', "utf8");
		expect(() => readPinAndGenFromDisk(path, { strict: true })).toThrow(
			/Unable to read account selection metadata/,
		);
	});

	it("falls back to defaults for the same failures when not strict", () => {
		const dir = makeTmpDir("unreadable-lenient");
		expect(readPinAndGenFromDisk(dir)).toEqual({
			pinnedAccountIndex: undefined,
			affinityGeneration: 0,
		});
	});

	it("returns defaults for a missing file even in strict mode", () => {
		// Nothing on disk can be clobbered by the write that follows, and
		// throwing here would mean storage could never be recreated: the
		// recreation goes through the same save path. See the regression at
		// "does not restore stale account state after an intentional clear" below.
		const path = join(makeTmpDir("missing"), "accounts.json");
		expect(readPinAndGenFromDisk(path, { strict: true })).toEqual({
			pinnedAccountIndex: undefined,
			affinityGeneration: 0,
		});
	});

	it.each([
		["null pin", { pinnedAccountIndex: null, affinityGeneration: 4 }, 4],
		["negative pin", { pinnedAccountIndex: -1, affinityGeneration: 4 }, 4],
		["fractional pin", { pinnedAccountIndex: 1.5, affinityGeneration: 4 }, 4],
		["string pin", { pinnedAccountIndex: "1", affinityGeneration: 4 }, 4],
		["negative generation", { pinnedAccountIndex: 1, affinityGeneration: -2 }, 0],
	])(
		"normalizes an invalid field rather than throwing: %s",
		(_label, payload, expectedGeneration) => {
			// The file parsed, so nothing is hidden from us and the value is
			// simply unusable. Throwing would wedge every future save with no
			// path to self-repair.
			const path = join(makeTmpDir("invalid"), "accounts.json");
			writeFileSync(path, JSON.stringify(payload), "utf8");
			const meta = readPinAndGenFromDisk(path, { strict: true });
			expect(meta.affinityGeneration).toBe(expectedGeneration);
		},
	);

	it("returns defaults for a non-record top-level value without throwing", () => {
		// `null` in particular used to be dereferenced before the isRecord guard.
		for (const body of ["null", "[]", "42", '"pinned"']) {
			const path = join(makeTmpDir("nonrecord"), "accounts.json");
			writeFileSync(path, body, "utf8");
			expect(readPinAndGenFromDisk(path, { strict: true })).toEqual({
				pinnedAccountIndex: undefined,
				affinityGeneration: 0,
			});
		}
	});

	it("round-trips a valid pin and generation", () => {
		const path = join(makeTmpDir("valid"), "accounts.json");
		writeFileSync(
			path,
			JSON.stringify({ pinnedAccountIndex: 2, affinityGeneration: 9 }),
			"utf8",
		);
		expect(readPinAndGenFromDisk(path, { strict: true })).toEqual({
			pinnedAccountIndex: 2,
			affinityGeneration: 9,
		});
	});
});

describe("AccountManager.applyManualSelection", () => {
	it("clears the switched account's rate-limit markers", () => {
		setStoragePathDirect(makeTmpStoragePath());
		const manager = new AccountManager(undefined, createStorage(2));
		const account = manager.getAccountByIndex(0);
		if (!account) throw new Error("fixture account missing");
		account.rateLimitResetTimes = { codex: Date.now() + 600_000 };
		account.lastRateLimitReason = "quota";

		manager.applyManualSelection({
			pinnedAccountIndex: 0,
			affinityGeneration: 1,
		});

		expect(account.rateLimitResetTimes).toEqual({});
		expect(account.lastRateLimitReason).toBeUndefined();
	});

	it("is a no-op when the on-disk generation is not newer", () => {
		setStoragePathDirect(makeTmpStoragePath());
		const manager = new AccountManager(
			undefined,
			createStorage(2, { affinityGeneration: 3 }),
		);
		const account = manager.getAccountByIndex(0);
		if (!account) throw new Error("fixture account missing");
		const resetAt = Date.now() + 600_000;
		account.rateLimitResetTimes = { codex: resetAt };

		manager.applyManualSelection({
			pinnedAccountIndex: 0,
			affinityGeneration: 3,
		});

		expect(account.rateLimitResetTimes).toEqual({ codex: resetAt });
	});

	it("replays a 429 that raced the switch it is applying", () => {
		const { manager, account } = managerWithUnreadableSelection();
		manager.markRateLimitedWithReason(account, 600_000, "codex", "quota");
		expect(account.rateLimitResetTimes.codex).toBeGreaterThan(Date.now());

		manager.applyManualSelection({
			pinnedAccountIndex: 0,
			affinityGeneration: 1,
		});

		// The 429 was recorded while the selection was unreadable, so we cannot
		// prove it predates the switch. Keep it.
		expect(account.rateLimitResetTimes.codex).toBeGreaterThan(Date.now());
		expect(account.lastRateLimitReason).toBe("quota");
	});

	it("does NOT replay an unsequenced 429 that is older than the ambiguity window", () => {
		// Regression: an unsequenced entry used to live until the next 429 or the
		// next switch to that account, so an hours-old 429 was resurrected by the
		// very `switch` meant to revalidate the account after a quota reset.
		const { manager, account } = managerWithUnreadableSelection();
		const base = Date.now();
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);

		manager.markRateLimitedWithReason(account, 3_600_000, "codex", "quota");
		expect(account.rateLimitResetTimes.codex).toBe(base + 3_600_000);

		nowSpy.mockReturnValue(base + 3_600_000 - 1);
		manager.applyManualSelection({
			pinnedAccountIndex: 0,
			affinityGeneration: 1,
		});

		expect(account.rateLimitResetTimes).toEqual({});
		expect(account.lastRateLimitReason).toBeUndefined();
	});

	it("does not extend an expired unsequenced entry through a later 429", () => {
		const { manager, account } = managerWithUnreadableSelection();
		const base = Date.now();
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
		manager.markRateLimitedWithReason(account, 3_600_000, "codex", "quota");

		// A second, much later 429 must not carry the stale entry's windows
		// forward under a fresh timestamp.
		nowSpy.mockReturnValue(base + 600_000);
		manager.markRateLimitedWithReason(account, 1_000, "gpt", "tokens", "gpt-5");

		nowSpy.mockReturnValue(base + 600_000 + 1);
		manager.applyManualSelection({
			pinnedAccountIndex: 0,
			affinityGeneration: 1,
		});

		expect(account.rateLimitResetTimes.codex).toBeUndefined();
	});

	it("drops the pin when the switched index is out of range", () => {
		setStoragePathDirect(makeTmpStoragePath());
		const manager = new AccountManager(undefined, createStorage(2));
		manager.applyManualSelection({
			pinnedAccountIndex: 7,
			affinityGeneration: 2,
		});
		expect(manager.getAccountByIndex(7)).toBeNull();
	});
});

describe("AccountManager save resilience", () => {
	it("refuses to recreate deleted storage from a stale manager after a switch", async () => {
        // A missing primary is authoritative. An in-flight daemon must not
        // restore credentials removed after its snapshot was loaded.
        const path = makeTmpStoragePath();
        const storage = createStorage(2, {pinnedAccountIndex:1,affinityGeneration:5});
        writeStorageFile(path,storage);setStoragePathDirect(path);
        const manager = new AccountManager(undefined,storage);
        rmSync(path,{force:true});
        await expect(manager.saveToDisk()).rejects.toMatchObject({code:"ESTALE"});
        expect(existsSync(path)).toBe(false);
    });

	it("does not restore stale account state after an intentional clear", async () => {
		const path = makeTmpStoragePath();
		const storage = createStorage(2, {pinnedAccountIndex: 1, affinityGeneration: 5});
		writeStorageFile(path, storage);
		setStoragePathDirect(path);
		const manager = new AccountManager(undefined, storage);
		const { clearAccounts, loadAccounts } = await import("../lib/storage.js");
		await clearAccounts();
		await manager.saveToDisk();
		expect((await loadAccounts())?.accounts ?? []).toEqual([]);
	});

	it("re-arms a debounced save that failed instead of dropping it", async () => {
		// Regression: the debounce timer clears itself before the save runs, so a
		// single transient failure silently discarded every rate-limit window,
		// cooldown and rotated refresh token since the last successful write.
		vi.useFakeTimers();
		setStoragePathDirect(makeTmpStoragePath());
		const manager = new AccountManager(undefined, createStorage(2));
		const saveSpy = vi
			.spyOn(manager, "saveToDisk")
			.mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"))
			.mockResolvedValue();

		manager.saveToDiskDebounced(10);
		await vi.advanceTimersByTimeAsync(10);
		expect(saveSpy).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(20);
		expect(saveSpy).toHaveBeenCalledTimes(2);
	});

	it("gives up after a bounded number of retries", async () => {
		vi.useFakeTimers();
		setStoragePathDirect(makeTmpStoragePath());
		const manager = new AccountManager(undefined, createStorage(2));
		const saveSpy = vi
			.spyOn(manager, "saveToDisk")
			.mockRejectedValue(new Error("EBUSY: resource busy or locked"));

		manager.saveToDiskDebounced(10);
		// 1 initial attempt + MAX_DEBOUNCED_SAVE_RETRIES re-arms, with the delay
		// doubling up to the 8s ceiling.
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(saveSpy).toHaveBeenCalledTimes(6);

		// The counter resets, so a later save is still attempted.
		saveSpy.mockClear();
		manager.saveToDiskDebounced(10);
		await vi.advanceTimersByTimeAsync(10);
		expect(saveSpy).toHaveBeenCalledTimes(1);
	});

	it("does not reject flushPendingSave when the save fails", async () => {
		// `RuntimeRotationProxy.close` awaits this without a catch, so a
		// rejection here aborts the rest of proxy teardown.
		setStoragePathDirect(makeTmpStoragePath());
		const manager = new AccountManager(undefined, createStorage(2));
		vi.spyOn(manager, "saveToDisk").mockRejectedValue(
			new Error("EPERM: operation not permitted"),
		);

		manager.saveToDiskDebounced(10_000);
		await expect(manager.flushPendingSave()).resolves.toBeUndefined();
	});
});

describe("quota scheduler account isolation", () => {
	const account = {
		email: "foo@example.com",
		accountId: "acc_foo",
		refreshToken: "refresh-foo",
		addedAt: 1_700_000_000_000,
	};
	const neighbour = {
		email: "foobar@example.com",
		accountId: "acc_foobar",
		refreshToken: "refresh-foobar",
		addedAt: 1_700_000_000_000,
	};

	it("produces a prefix that every key for that account starts with", () => {
		const prefix = buildQuotaScheduleAccountPrefix(account);
		expect(prefix.endsWith(":")).toBe(true);
		for (const key of [
			buildQuotaScheduleKey(account, "codex"),
			buildQuotaScheduleKey(account, "codex", "gpt-5.6"),
			buildQuotaScheduleKey(account, "gpt", "gpt-5.6-codex"),
		]) {
			expect(key.startsWith(prefix)).toBe(true);
		}
	});

	it("does not let one account's prefix match a neighbouring identity", () => {
		const prefix = buildQuotaScheduleAccountPrefix(account);
		expect(
			buildQuotaScheduleKey(neighbour, "codex").startsWith(prefix),
		).toBe(false);
	});

	it("clears every model key for one account and leaves the neighbour deferred", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = Date.now();
		const mine = [
			buildQuotaScheduleKey(account, "codex"),
			buildQuotaScheduleKey(account, "codex", "gpt-5.6"),
		];
		const theirs = buildQuotaScheduleKey(neighbour, "codex");
		for (const key of [...mine, theirs]) {
			scheduler.markRateLimited(key, 600_000, now);
		}

		scheduler.clearByPrefix(buildQuotaScheduleAccountPrefix(account));

		for (const key of mine) {
			expect(scheduler.getDeferral(key, now).defer).toBe(false);
		}
		expect(scheduler.getDeferral(theirs, now).defer).toBe(true);
	});

	it("treats an empty prefix as a no-op rather than a clear-all", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = Date.now();
		const key = buildQuotaScheduleKey(account, "codex");
		scheduler.markRateLimited(key, 600_000, now);

		scheduler.clearByPrefix("");

		expect(scheduler.getDeferral(key, now).defer).toBe(true);
	});

	it("clearAll drops every observation", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = Date.now();
		const keys = [
			buildQuotaScheduleKey(account, "codex"),
			buildQuotaScheduleKey(neighbour, "codex"),
		];
		for (const key of keys) scheduler.markRateLimited(key, 600_000, now);

		scheduler.clearAll();

		for (const key of keys) {
			expect(scheduler.getDeferral(key, now).defer).toBe(false);
		}
	});
});
