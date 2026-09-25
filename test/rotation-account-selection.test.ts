import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import type { RuntimePolicyDecision } from "../lib/policy/runtime-policy.js";
import { chooseAccount } from "../lib/runtime/rotation-account-selection.js";
import { SessionAffinityStore } from "../lib/session-affinity.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";

const NOW = Date.now();
const FAMILY = "gpt-5-codex" as const;

function storageWith(
	count: number,
	overridesByIndex: Record<number, Partial<AccountMetadataV3>> = {},
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { [FAMILY]: 0 },
		accounts: Array.from({ length: count }, (_unused, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: NOW + 3_600_000,
			addedAt: NOW - 60_000,
			lastUsed: NOW - (count - index) * 60_000,
			enabled: true,
			...overridesByIndex[index],
		})),
	};
}

function manager(
	count = 3,
	overridesByIndex: Record<number, Partial<AccountMetadataV3>> = {},
): AccountManager {
	return new AccountManager(undefined, storageWith(count, overridesByIndex));
}

function policyWith(blocked: number[] = []): RuntimePolicyDecision {
	return {
		allowed: true,
		statusCode: 200,
		errorCode: null,
		reasons: [],
		projectKey: null,
		blockedAccountIndexes: new Set(blocked),
		scoreBoostByAccount: {},
		budgetEvaluations: [],
	};
}

function baseParams(accountManager: AccountManager) {
	return {
		accountManager,
		sessionAffinityStore: null,
		sessionKey: null,
		family: FAMILY,
		model: null,
		attemptedIndexes: new Set<number>(),
		now: NOW,
		policy: null,
		pinnedIndex: null,
	};
}

beforeEach(() => {
	// Circuit breakers and rate-limit trackers are module-level state.
	AccountManager.resetVolatileRuntimeState();
});

describe("chooseAccount pinned selection (issue #474)", () => {
	it("returns the pinned account without advancing any cursor", () => {
		const accountManager = manager();
		const markSwitched = vi.spyOn(accountManager, "markSwitched");

		const selected = chooseAccount({
			...baseParams(accountManager),
			pinnedIndex: 1,
		});

		expect(selected?.index).toBe(1);
		// The proxy must not clobber the pin set by the CLI.
		expect(markSwitched).not.toHaveBeenCalled();
	});

	it("reselects a healthy pin that this request already tried", () => {
		const accountManager = manager();
		const markSwitched = vi.spyOn(accountManager, "markSwitched");
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([1]),
			pinnedIndex: 1,
			skipReasons,
		});

		expect(selected?.index).toBe(1);
		expect(skipReasons.has(1)).toBe(false);
		expect(markSwitched).not.toHaveBeenCalled();
	});

	it.each([
		["missing", { pinnedIndex: 7, attemptedIndexes: new Set([7]) }],
		[
			"policy-blocked",
			{
				pinnedIndex: 1,
				attemptedIndexes: new Set([1]),
				policy: policyWith([1]),
			},
		],
	] as const)(
		"refuses the pin with reason %s instead of falling back",
		(reason, overrides) => {
			const accountManager = manager();
			const skipReasons = new Map<number, string>();

			const selected = chooseAccount({
				...baseParams(accountManager),
				...overrides,
				skipReasons,
			});

			// A pin never falls back to another account; the request fails over
			// to the caller with the reason recorded.
			expect(selected).toBeNull();
			expect(skipReasons.get(overrides.pinnedIndex)).toBe(reason);
		},
	);

	it("refuses a disabled pinned account", () => {
		const accountManager = manager(3, { 1: { enabled: false } });
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([1]),
			pinnedIndex: 1,
			skipReasons,
		});

		expect(selected).toBeNull();
		expect(skipReasons.get(1)).toBe("disabled");
	});

	it("refuses a rate-limited pinned account with the runtime reason", () => {
		const accountManager = manager(3, {
			1: { rateLimitResetTimes: { [FAMILY]: NOW + 600_000 } },
		});
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([1]),
			pinnedIndex: 1,
			skipReasons,
		});

		expect(selected).toBeNull();
		expect(skipReasons.get(1)).toBe("rate-limited");
	});

	it("refuses a cooling-down pinned account with the tagged reason", () => {
		const accountManager = manager();
		const pinned = accountManager.getAccountByIndex(1);
		if (!pinned) throw new Error("fixture account missing");
		accountManager.markAccountCoolingDown(pinned, 60_000, "auth-failure");
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([1]),
			pinnedIndex: 1,
			skipReasons,
		});

		expect(selected).toBeNull();
		expect(skipReasons.get(1)).toBe("cooling-down:auth-failure");
	});

	it("refuses a pinned account whose circuit breaker is open", () => {
		const accountManager = manager();
		const pinned = accountManager.getAccountByIndex(1);
		if (!pinned) throw new Error("fixture account missing");
		// Trip the breaker (threshold is 3 failures).
		for (let i = 0; i < 3; i += 1) {
			accountManager.recordFailure(pinned, FAMILY, null);
		}
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([1]),
			pinnedIndex: 1,
			skipReasons,
		});

		expect(selected).toBeNull();
		expect(skipReasons.get(1)).toBe("circuit-open");
	});
});

describe("chooseAccount session affinity tier", () => {
	it("prefers the remembered account and commits the cursor", () => {
		const accountManager = manager();
		const markSwitched = vi.spyOn(accountManager, "markSwitched");
		const store = new SessionAffinityStore();
		store.remember("sess-1", 2, NOW);

		const selected = chooseAccount({
			...baseParams(accountManager),
			sessionAffinityStore: store,
			sessionKey: "sess-1",
		});

		expect(selected?.index).toBe(2);
		expect(markSwitched).toHaveBeenCalledExactlyOnceWith(
			selected,
			"rotation",
			FAMILY,
		);
	});

	it("records the skip reason and falls through when the sticky account is unusable", () => {
		const accountManager = manager(3, {
			2: { rateLimitResetTimes: { [FAMILY]: NOW + 600_000 } },
		});
		vi.spyOn(
			accountManager,
			"getCurrentOrNextForFamilyHybrid",
		).mockReturnValue(accountManager.getAccountByIndex(0));
		const store = new SessionAffinityStore();
		store.remember("sess-1", 2, NOW);
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			sessionAffinityStore: store,
			sessionKey: "sess-1",
			skipReasons,
		});

		expect(skipReasons.get(2)).toBe("rate-limited");
		expect(selected?.index).toBe(0);
	});
});

describe("chooseAccount hybrid tier and linear fallback", () => {
	it("returns the hybrid selector's pick without an extra cursor commit", () => {
		const accountManager = manager();
		vi.spyOn(
			accountManager,
			"getCurrentOrNextForFamilyHybrid",
		).mockReturnValue(accountManager.getAccountByIndex(1));
		const markSwitched = vi.spyOn(accountManager, "markSwitched");

		const selected = chooseAccount(baseParams(accountManager));

		expect(selected?.index).toBe(1);
		// The hybrid selector advances its own cursor internally.
		expect(markSwitched).not.toHaveBeenCalled();
	});

	it("falls back to a linear scan that commits the cursor when the hybrid pick was attempted", () => {
		const accountManager = manager();
		vi.spyOn(
			accountManager,
			"getCurrentOrNextForFamilyHybrid",
		).mockReturnValue(accountManager.getAccountByIndex(0));
		const markSwitched = vi.spyOn(accountManager, "markSwitched");
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([0]),
			policy: policyWith([1]),
			skipReasons,
		});

		// 0 was attempted, 1 is policy-blocked, 2 wins and becomes the cursor.
		expect(selected?.index).toBe(2);
		expect(skipReasons.get(0)).toBe("already-attempted");
		expect(skipReasons.get(1)).toBe("policy-blocked");
		expect(markSwitched).toHaveBeenCalledExactlyOnceWith(
			selected,
			"rotation",
			FAMILY,
		);
	});

	it("returns null with a reason per account when the pool is exhausted", () => {
		const accountManager = manager();
		vi.spyOn(
			accountManager,
			"getCurrentOrNextForFamilyHybrid",
		).mockReturnValue(accountManager.getAccountByIndex(0));
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([0, 1, 2]),
			skipReasons,
		});

		expect(selected).toBeNull();
		expect([...skipReasons.entries()]).toEqual([
			[0, "already-attempted"],
			[1, "already-attempted"],
			[2, "already-attempted"],
		]);
	});
});

describe("chooseAccount sequential mode (issue #509)", () => {
	it("follows the drain-first selector and skips the affinity tier", () => {
		const accountManager = manager();
		const sequential = vi
			.spyOn(accountManager, "getCurrentOrNextForFamilySequential")
			.mockReturnValue(accountManager.getAccountByIndex(0));
		const store = new SessionAffinityStore();
		store.remember("sess-1", 2, NOW);
		const affinity = vi.spyOn(store, "getPreferredAccountIndex");

		const selected = chooseAccount({
			...baseParams(accountManager),
			sessionAffinityStore: store,
			sessionKey: "sess-1",
			schedulingStrategy: "sequential",
		});

		// Every request follows the single active account: no per-chat
		// stickiness consulted.
		expect(selected?.index).toBe(0);
		expect(sequential).toHaveBeenCalledTimes(1);
		expect(affinity).not.toHaveBeenCalled();
	});

	it("routes around a policy-blocked primary without moving it", () => {
		const accountManager = manager();
		const sequential = vi
			.spyOn(accountManager, "getCurrentOrNextForFamilySequential")
			.mockReturnValue(accountManager.getAccountByIndex(0));
		const markSwitched = vi.spyOn(accountManager, "markSwitched");
		const policy = policyWith([0]);
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			policy,
			schedulingStrategy: "sequential",
			skipReasons,
		});

		// The blocked set is threaded into the drain-first selector, the linear
		// fallback records the block, and the primary pointer stays put.
		expect(sequential).toHaveBeenCalledExactlyOnceWith(
			FAMILY,
			null,
			policy.blockedAccountIndexes,
		);
		expect(selected?.index).toBe(1);
		expect(skipReasons.get(0)).toBe("policy-blocked");
		expect(markSwitched).not.toHaveBeenCalled();
	});

	it("retries another account without moving the drain-first primary", () => {
		const accountManager = manager();
		vi.spyOn(
			accountManager,
			"getCurrentOrNextForFamilySequential",
		).mockReturnValue(accountManager.getAccountByIndex(0));
		const markSwitched = vi.spyOn(accountManager, "markSwitched");
		const skipReasons = new Map<number, string>();

		const selected = chooseAccount({
			...baseParams(accountManager),
			attemptedIndexes: new Set([0]),
			schedulingStrategy: "sequential",
			skipReasons,
		});

		// The transiently failed active account stays primary: the fallback
		// only finds an account to TRY, it must not commit the cursor.
		expect(selected?.index).toBe(1);
		expect(markSwitched).not.toHaveBeenCalled();
		expect(skipReasons.get(0)).toBe("already-attempted");
	});
});


describe("capability-aware priority tiers",()=>{
 it("tries the first eligible tier before affinity or the preferred active account",()=>{
  const m=manager();const policy={...policyWith(),priorityByAccount:{0:2,1:0,2:1}};
  const selected=chooseAccount({...baseParams(m),policy,preferredIndex:0});
  expect(selected?.index).toBe(1);
 });
 it("falls through unsupported, exhausted and already-attempted accounts",()=>{
  const m=manager();const policy={...policyWith([0]),priorityByAccount:{0:0,1:1,2:2}};
  expect(chooseAccount({...baseParams(m),policy,preferredIndex:0})?.index).toBe(1);
  expect(chooseAccount({...baseParams(m),policy,preferredIndex:0,attemptedIndexes:new Set([1])})?.index).toBe(2);
  vi.spyOn(m,"getAccountRuntimeSkipReason").mockImplementation(i=>i===1?"rate-limited":null);
  expect(chooseAccount({...baseParams(m),policy,preferredIndex:0})?.index).toBe(2);
 });
 it("prefers the selected account within a tier and never mutates policy eligibility",()=>{
  const m=manager();const policy={...policyWith(),priorityByAccount:{0:1,1:1,2:2}};
  expect(chooseAccount({...baseParams(m),policy,preferredIndex:1})?.index).toBe(1);
  expect(policy.blockedAccountIndexes.size).toBe(0);
 });
});

describe("app-bind pin first with fallback", () => {
 it("tries an eligible pin before earlier configured tiers then falls back in tier order", () => {
  const m=manager();const policy={...policyWith(),priorityByAccount:{0:8,1:1,2:2}};
  const params={...baseParams(m),policy,fallbackPinnedIndex:0};
  expect(chooseAccount(params)?.index).toBe(0);
  expect(chooseAccount({...params,attemptedIndexes:new Set([0])})?.index).toBe(1);
  expect(chooseAccount({...params,attemptedIndexes:new Set([0,1])})?.index).toBe(2);
  expect(policy.priorityByAccount).toEqual({0:8,1:1,2:2});
 });
 it.each(["unsupported", "disabled", "cooldown", "missing"])("skips a %s pin without preventing fallback", (reason) => {
  const m=manager(3,reason==="disabled"?{0:{enabled:false}}:{});
  const policy={...policyWith(reason==="unsupported"?[0]:[]),priorityByAccount:{0:8,1:1,2:2}};
  if(reason==="cooldown")vi.spyOn(m,"getAccountRuntimeSkipReason").mockImplementation(i=>i===0?"cooling-down:test":null);
  expect(chooseAccount({...baseParams(m),policy,fallbackPinnedIndex:reason==="missing"?9:0})?.index).toBe(1);
 });
 it("does not override an explicit strict invocation pin", () => {
  expect(chooseAccount({...baseParams(manager()),pinnedIndex:2,fallbackPinnedIndex:0})?.index).toBe(2);
 });
});

it("picks the earliest reset regardless of where an unmeasured account sits in storage",()=>{
 const m=manager();const policy={...policyWith(),priorityByAccount:{0:1,1:1,2:1}};
 const q=(hours:number)=>({plan:"subscription" as const,remainingPercent:20,resetAtMs:NOW+hours*3600000,urgency:null,exhausted:false,observedAt:NOW});
 // [B reset 24h, U unmeasured, A reset 1h]
 expect(chooseAccount({...baseParams(m),policy,subscriptionQuotaByAccount:{0:q(24),2:q(1)}})?.index).toBe(2);
});

it("uses subscription quota order inside a tier before active-account preference",()=>{
 const m=manager();const policy={...policyWith(),priorityByAccount:{0:1,1:1,2:1}};
 const q=(urgency:number)=>({plan:"subscription" as const,remainingPercent:20,resetAtMs:NOW+3600000/urgency,urgency,exhausted:false,observedAt:NOW});
 expect(chooseAccount({...baseParams(m),policy,preferredIndex:0,subscriptionQuotaByAccount:{0:q(1),1:q(20),2:q(10)}})?.index).toBe(1);
 expect(chooseAccount({...baseParams(m),policy,fallbackPinnedIndex:0,subscriptionQuotaByAccount:{0:q(1),1:q(20),2:q(10)}})?.index).toBe(0);
});

it("keeps five percent reserved across tiers and a native pin, then uses it as subscription-only last resort",()=>{
 const m=manager();const policy={...policyWith(),priorityByAccount:{0:1,1:8,2:1}};
 const q=(remainingPercent:number)=>({plan:"subscription" as const,remainingPercent,resetAtMs:NOW+3600000,urgency:remainingPercent,exhausted:remainingPercent===0,observedAt:NOW});
 const params={...baseParams(m),policy,fallbackPinnedIndex:0,subscriptionQuotaByAccount:{0:q(5),1:q(20),2:q(0)}};
 expect(chooseAccount(params)?.index).toBe(1);
 expect(chooseAccount({...params,attemptedIndexes:new Set([1])})?.index).toBe(0);
 expect(chooseAccount({...params,attemptedIndexes:new Set([0,1])})).toBeNull();
});

it("keeps native pin and configured tiers ahead of an unused subscription",()=>{
 const m=manager();const policy={...policyWith(),priorityByAccount:{0:1,1:9,2:1}};
 const q=(remainingPercent:number)=>({plan:"subscription" as const,remainingPercent,resetAtMs:NOW+3600000,urgency:remainingPercent,exhausted:false,observedAt:NOW});
 const params={...baseParams(m),policy,fallbackPinnedIndex:0,subscriptionQuotaByAccount:{0:q(20),1:q(100),2:q(50)}};
 expect(chooseAccount(params)?.index).toBe(0);
 expect(chooseAccount({...params,fallbackPinnedIndex:null})?.index).toBe(2);
 expect(chooseAccount({...params,attemptedIndexes:new Set([1])})?.index).toBe(0);
 expect(chooseAccount({...params,policy:{...policy,blockedAccountIndexes:new Set([1])}})?.index).toBe(0);
});
