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
});


it.each([[12, 1], [-1, 1], [2.5, 1], [Number.NaN, 1], [0, 0], [9, 9], [4, 4]])("normalizes an upserted priority %s the way loading does (%s)", async (priority, expected) => {
	const { upsertAccountPolicy } = await import("../lib/account-policy.js");
	const store = { version: 1 as const, accounts: {} };
	const saved = upsertAccountPolicy(store, "fixture", (policy) => { policy.priority = priority; });
	expect(saved.priority).toBe(expected);
});
