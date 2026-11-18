import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("account policy store", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	async function resetAccountPolicyQueue(): Promise<void> {
		const { resetAccountPolicyWriteQueueForTests } = await import(
			"../lib/account-policy.js"
		);
		resetAccountPolicyWriteQueueForTests();
	}

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-account-policy-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
		await resetAccountPolicyQueue();
	});

	afterEach(async () => {
		await resetAccountPolicyQueue();
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("persists an emergency-only policy without converting it into a pause", async () => {
		const {loadAccountPolicyStore,updateAccountPolicyStore,upsertAccountPolicy}=await import("../lib/account-policy.js");
		await updateAccountPolicyStore(store=>{upsertAccountPolicy(store,"sha256:fixture",policy=>{policy.emergencyOnly=true;policy.paused=false;});return {result:undefined,dirty:true};});
		expect((await loadAccountPolicyStore({strict:true})).accounts["sha256:fixture"]).toMatchObject({emergencyOnly:true,paused:false});
	});

	it("distinguishes missing policies from malformed policies in strict reads", async () => {
		const {loadAccountPolicyStore, getAccountPolicyPath} = await import("../lib/account-policy.js");
		await expect(loadAccountPolicyStore({strict:true})).resolves.toEqual({version:1,accounts:{}});
		for (const content of ["{broken", "null", '{"version":1,"accounts":[]}']) {
			await fs.writeFile(getAccountPolicyPath(), content);
			await expect(loadAccountPolicyStore({strict:true})).rejects.toThrow();
			await expect(loadAccountPolicyStore()).resolves.toEqual({version:1,accounts:{}});
		}
	});

	it.each([null, [], "invalid", {emergencyOnly:"true"}, {autoPrime:"true"}, {autoPrime:0}, {autoPrime:null}, {paused:"true"}, {paused:0}, {drained:"false"}, {drained:null}])("rejects malformed account policy rows in strict mode: %j", async row => {
		const {loadAccountPolicyStore, getAccountPolicyPath} = await import("../lib/account-policy.js");
		await fs.writeFile(getAccountPolicyPath(), JSON.stringify({version:1,accounts:{"sha256:fixture":row}}));
		await expect(loadAccountPolicyStore({strict:true})).rejects.toThrow("Invalid account policy");
		await expect(loadAccountPolicyStore()).resolves.toMatchObject({accounts:{"sha256:fixture":{autoPrime:false}}});
	});

	it.each([{}, {autoPrime:false}, {autoPrime:true}])("accepts legacy and boolean priming policies in strict mode: %j", async row => {
		const {loadAccountPolicyStore, getAccountPolicyPath} = await import("../lib/account-policy.js");
		await fs.writeFile(getAccountPolicyPath(), JSON.stringify({version:1,accounts:{"sha256:fixture":row}}));
		await expect(loadAccountPolicyStore({strict:true})).resolves.toMatchObject({accounts:{"sha256:fixture":{autoPrime:"autoPrime" in row && row.autoPrime === true}}});
	});

	it.each(["EBUSY", "EPERM"])("preserves strict failure and tolerant fallback after exhausted %s retries", async code => {
		const { loadAccountPolicyStore } = await import("../lib/account-policy.js");
		const logger = await import("../lib/logger.js");
		const failure = Object.assign(new Error("fixture locked"), { code });
		const read = vi.spyOn(fs, "readFile").mockRejectedValue(failure);
		const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => undefined);
		vi.useFakeTimers();
		try {
			const strict = expect(loadAccountPolicyStore({ strict: true })).rejects.toBe(failure);
			await vi.runAllTimersAsync();
			await strict;
			expect(read).toHaveBeenCalledTimes(5);
			expect(warn).not.toHaveBeenCalled();
			read.mockClear();
			const tolerant = loadAccountPolicyStore();
			await vi.runAllTimersAsync();
			await expect(tolerant).resolves.toEqual({ version: 1, accounts: {} });
			expect(read).toHaveBeenCalledTimes(5);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("fixture locked"));
		} finally {
			read.mockRestore();
			warn.mockRestore();
			vi.useRealTimers();
		}
	});

	it("keeps automatic first-use priming off for fresh accounts and pre-2.17 policy files", async () => {
		const { getAccountPolicyKey, getAccountPolicyPath, loadAccountPolicyStore, upsertAccountPolicy } = await import("../lib/account-policy.js");
		const { runAutomaticAccountChecks } = await import("../lib/runtime/automatic-account-checks.js");
		const accounts = [{ accountId: "fixture-new", refreshToken: "fixture-new", addedAt: 1, lastUsed: 1 }, { accountId: "fixture-legacy", refreshToken: "fixture-legacy", addedAt: 1, lastUsed: 1 }];
		const legacyKey = getAccountPolicyKey(accounts[1]!);
		// A policy file written before this PR: no autoPrime (or priority) field.
		await fs.writeFile(getAccountPolicyPath(), JSON.stringify({ version: 1, accounts: { [legacyKey]: { accountKey: legacyKey, tags: ["team"], weight: 2, paused: false, drained: false, note: null, updatedAt: 1 } } }));
		const store = await loadAccountPolicyStore();
		expect(store.accounts[legacyKey]?.autoPrime).toBe(false);
		// A fresh account that only gets an unrelated policy edit.
		const fresh = upsertAccountPolicy(store, getAccountPolicyKey(accounts[0]!), (policy) => { policy.note = "fixture"; });
		expect(fresh.autoPrime).toBe(false);
		const check = vi.fn();
		await runAutomaticAccountChecks({ path: join(tempDir, "attempts.json"), loadAccounts: async () => ({ version: 3, activeIndex: 0, accounts }), loadPolicies: async () => store, check, now: () => 1000 });
		expect(check).not.toHaveBeenCalled();
		// Turning it on affects only that account.
		upsertAccountPolicy(store, legacyKey, (policy) => { policy.autoPrime = true; });
		await runAutomaticAccountChecks({ path: join(tempDir, "attempts.json"), loadAccounts: async () => ({ version: 3, activeIndex: 0, accounts }), loadPolicies: async () => store, check, now: () => 1000 });
		expect(check.mock.calls.map((call) => call[1])).toEqual([1]);
	});

	it("stores policy rows by hashed account identity", async () => {
		const {
			getAccountPolicyKey,
			getAccountPolicyPath,
			loadAccountPolicyStore,
			saveAccountPolicyStore,
			upsertAccountPolicy,
		} = await import("../lib/account-policy.js");
		const account = {
			accountId: "acct_sensitive",
			email: "owner@example.com",
		};
		const accountKey = getAccountPolicyKey(account, 0);
		const store = await loadAccountPolicyStore();
		upsertAccountPolicy(store, accountKey, (policy) => {
			policy.tags.push("Team A");
			policy.weight = 2;
			policy.priority = 3;
			policy.paused = true;
			policy.note = "local note";
		}, 123);
		await saveAccountPolicyStore(store);

		const raw = await fs.readFile(getAccountPolicyPath(), "utf8");
		expect(raw).toContain("team-a");
		expect(raw).not.toContain("acct_sensitive");
		expect(raw).not.toContain("owner@example.com");

		const loaded = await loadAccountPolicyStore();
		expect(loaded.accounts[accountKey]).toMatchObject({
			tags: ["team-a"],
			weight: 2,
			priority: 3,
			paused: true,
			note: "local note",
			updatedAt: 123,
		});
	});

	it("does not use mutable account indexes as policy identity", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");
		const unidentified = {
			accountId: undefined,
			email: undefined,
		};

		expect(getAccountPolicyKey(unidentified, 0)).toBe(
			getAccountPolicyKey(unidentified, 4),
		);
	});

	it("separates two accounts that have neither an accountId nor an email", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");

		// Both used to hash the literal "unknown" and share one policy entry, so
		// pausing, draining or tagging either one silently applied to both.
		expect(
			getAccountPolicyKey({ refreshToken: "refresh-a" }, 0),
		).not.toBe(getAccountPolicyKey({ refreshToken: "refresh-b" }, 1));
	});

	it("keeps the refresh-token fallback key stable across slots", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");
		const account = { refreshToken: "refresh-a" };

		// Policy state is persisted and survives reordering, so the key must not
		// move when the account does.
		expect(getAccountPolicyKey(account, 0)).toBe(getAccountPolicyKey(account, 6));
	});

	it("prefers a real identity over the refresh-token fallback", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");
		const withId = { accountId: "acc_1", refreshToken: "refresh-a" };
		const withEmail = { email: "user@example.com", refreshToken: "refresh-a" };

		// Hydrating an account's identity must not orphan its existing policy.
		expect(getAccountPolicyKey(withId)).toBe(
			getAccountPolicyKey({ accountId: "acc_1", refreshToken: "refresh-z" }),
		);
		expect(getAccountPolicyKey(withEmail)).toBe(
			getAccountPolicyKey({ email: "USER@example.com", refreshToken: "refresh-z" }),
		);
		expect(getAccountPolicyKey(withId)).not.toBe(getAccountPolicyKey(withEmail));
	});

	it("namespaces the refresh token so it cannot collide with an email", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");

		expect(getAccountPolicyKey({ refreshToken: "user@example.com" })).not.toBe(
			getAccountPolicyKey({ email: "user@example.com", refreshToken: "refresh-a" }),
		);
	});

	it("re-applies a mutation over the freshest store instead of merging whole records", async () => {
		const {
			getAccountPolicyPath,
			loadAccountPolicyStore,
			updateAccountPolicyStore,
		} = await import("../lib/account-policy.js");
		const key = "sha256:contended";
		// A concurrent process already committed fields we never touched, with a
		// much newer updatedAt than our mutation's clock — under the old
		// whole-record updatedAt merge, our save would either clobber those
		// fields wholesale or be silently discarded as "older".
		await fs.writeFile(
			getAccountPolicyPath(),
			JSON.stringify({
				version: 1,
				accounts: {
					[key]: {
						accountKey: key,
						tags: ["team"],
						weight: 5,
						paused: false,
						drained: false,
						note: "other writer",
						updatedAt: 1_000_000_000_000,
					},
				},
			}),
		);

		const written = await updateAccountPolicyStore((store) => ({
			result: (() => {
				const record = store.accounts[key]!;
				record.paused = true;
				return record;
			})(),
			dirty: true,
		}));
		expect(written.paused).toBe(true);

		const loaded = await loadAccountPolicyStore();
		// Our paused mutation landed AND the other fields the fresher record
		// carried are preserved — disjoint field updates both survive.
		expect(loaded.accounts[key]).toMatchObject({
			tags: ["team"],
			weight: 5,
			paused: true,
			note: "other writer",
		});
	});

	it("does not write the store when the mutation reports no change", async () => {
		const { getAccountPolicyPath, updateAccountPolicyStore } = await import(
			"../lib/account-policy.js"
		);
		const result = await updateAccountPolicyStore(() => ({
			result: "skipped",
			dirty: false,
		}));
		expect(result).toBe("skipped");
		await expect(fs.stat(getAccountPolicyPath())).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("survives a backward clock jump between writes (hybrid updatedAt floor)", async () => {
		const {
			getAccountPolicyKey,
			loadAccountPolicyStore,
			saveAccountPolicyStore,
			upsertAccountPolicy,
		} = await import("../lib/account-policy.js");
		const key = getAccountPolicyKey({ accountId: "skew-acct" }, 0);

		// First write lands at wall time T2.
		const first = await loadAccountPolicyStore();
		upsertAccountPolicy(first, key, (policy) => {
			policy.note = "before-skew";
		}, 5_000);
		await saveAccountPolicyStore(first);

		// Clock regresses to T1 < T2; the next load sees the T2 stamp, so the
		// upsert must clamp forward or the merge drops this write silently.
		const reloaded = await loadAccountPolicyStore();
		const mutated = upsertAccountPolicy(reloaded, key, (policy) => {
			policy.note = "after-skew";
		}, 100);
		expect(mutated.updatedAt).toBe(5_001);
		await saveAccountPolicyStore(reloaded);

		const final = await loadAccountPolicyStore();
		expect(final.accounts[key]?.note).toBe("after-skew");
		expect(final.accounts[key]?.updatedAt).toBe(5_001);
	});

	it("does not lose a deliberate edit that races a concurrent write under clock skew", async () => {
		const {
			getAccountPolicyKey,
			loadAccountPolicyStore,
			saveAccountPolicyStore,
			upsertAccountPolicy,
		} = await import("../lib/account-policy.js");
		const key = getAccountPolicyKey({ accountId: "race-acct" }, 0);

		// Seed the key at wall time T2.
		const seed = await loadAccountPolicyStore();
		upsertAccountPolicy(seed, key, (policy) => {
			policy.note = "base";
		}, 5_000);
		await saveAccountPolicyStore(seed);

		// This writer loads its snapshot BEFORE the concurrent write lands.
		const working = await loadAccountPolicyStore();
		const baseline = structuredClone(working);

		// A concurrent writer lands a newer entry first.
		const raced = await loadAccountPolicyStore();
		upsertAccountPolicy(raced, key, (policy) => {
			policy.weight = 9;
			policy.note = "raced";
		}, 7_000);
		await saveAccountPolicyStore(raced);

		// The clock regressed to T1 << T2: the snapshot floor stamps 5_001,
		// below the raced on-disk 7_000 — without a merge-time floor over the
		// fresh disk entry this deliberate edit is silently dropped.
		const mutated = upsertAccountPolicy(working, key, (policy) => {
			policy.paused = true;
		}, 100);
		expect(mutated.updatedAt).toBe(5_001);
		await saveAccountPolicyStore(working, baseline);

		const final = await loadAccountPolicyStore();
		expect(final.accounts[key]?.paused).toBe(true);
		expect(final.accounts[key]?.updatedAt).toBe(7_001);
	});

	it("leaves a raced newer entry alone when the caller only carried it", async () => {
		const {
			getAccountPolicyKey,
			loadAccountPolicyStore,
			saveAccountPolicyStore,
			upsertAccountPolicy,
		} = await import("../lib/account-policy.js");
		const editedKey = getAccountPolicyKey({ accountId: "edit-acct" }, 0);
		const carriedKey = getAccountPolicyKey({ accountId: "other-acct" }, 1);

		const seed = await loadAccountPolicyStore();
		upsertAccountPolicy(seed, editedKey, (policy) => {
			policy.note = "k";
		}, 5_000);
		upsertAccountPolicy(seed, carriedKey, (policy) => {
			policy.note = "l";
		}, 5_000);
		await saveAccountPolicyStore(seed);

		const working = await loadAccountPolicyStore();
		const baseline = structuredClone(working);

		// A concurrent writer moves ONLY the carried key to a newer entry.
		const raced = await loadAccountPolicyStore();
		upsertAccountPolicy(raced, carriedKey, (policy) => {
			policy.weight = 9;
		}, 9_000);
		await saveAccountPolicyStore(raced);

		// The caller edits only the other key; the carried snapshot copy of
		// carriedKey must not be re-stamped over the raced write.
		upsertAccountPolicy(working, editedKey, (policy) => {
			policy.paused = true;
		}, 100);
		await saveAccountPolicyStore(working, baseline);

		const final = await loadAccountPolicyStore();
		expect(final.accounts[editedKey]?.paused).toBe(true);
		expect(final.accounts[carriedKey]?.weight).toBe(9);
		expect(final.accounts[carriedKey]?.updatedAt).toBe(9_000);
	});

	it("keeps updatedAt order for saves without a baseline", async () => {
		const {
			getAccountPolicyKey,
			loadAccountPolicyStore,
			saveAccountPolicyStore,
			upsertAccountPolicy,
		} = await import("../lib/account-policy.js");
		const key = getAccountPolicyKey({ accountId: "compat-acct" }, 0);

		const seed = await loadAccountPolicyStore();
		upsertAccountPolicy(seed, key, (policy) => {
			policy.note = "base";
		}, 5_000);
		await saveAccountPolicyStore(seed);

		// A stale snapshot saved without a baseline is a plain `updatedAt >=`
		// upsert: it must not clobber a concurrent newer entry.
		const stale = await loadAccountPolicyStore();
		const raced = await loadAccountPolicyStore();
		upsertAccountPolicy(raced, key, (policy) => {
			policy.note = "newer";
		}, 9_000);
		await saveAccountPolicyStore(raced);
		await saveAccountPolicyStore(stale);

		const final = await loadAccountPolicyStore();
		expect(final.accounts[key]?.note).toBe("newer");
		expect(final.accounts[key]?.updatedAt).toBe(9_000);
	});
});


it.each([[12, 1], [-1, 1], [2.5, 1], [Number.NaN, 1], [0, 0], [9, 9], [4, 4]])("normalizes an upserted priority %s the way loading does (%s)", async (priority, expected) => {
	const { upsertAccountPolicy } = await import("../lib/account-policy.js");
	const store = { version: 1 as const, accounts: {} };
	const saved = upsertAccountPolicy(store, "fixture", (policy) => { policy.priority = priority; });
	expect(saved.priority).toBe(expected);
});
