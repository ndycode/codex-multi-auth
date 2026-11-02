import { beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { ConfirmedResetReconciler } from "../lib/runtime/confirmed-reset-reconciler.js";
import { workspaceModelScopes } from "../lib/runtime/workspace-model-scopes.js";
import type { ResetSnapshot } from "../lib/runtime/reset-credits.js";

beforeEach(() => AccountManager.resetVolatileRuntimeState());

function fixture() {
	const now = Date.now();
	const manager = new AccountManager(undefined, {version:3, activeIndex:0, accounts:[
		{recordId:"first", accountId:"workspace", refreshToken:"r", addedAt:1, lastUsed:1},
	]});
	vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => {});
	const account = manager.getAccountByIndex(0)!;
	const scope = workspaceModelScopes(account)[0]!;
	const snapshot: ResetSnapshot = {updatedAt:now, availableCount:1, credits:null, ordinaryUsageAllowed:true, planType:"pro", primary:{usedPercent:0}, secondary:{}};
	account.rateLimitResetTimes = {codex:now + 300_000};
	const args: Parameters<ConfirmedResetReconciler["reconcile"]>[0] = {
		state:{version:1, policy:"manual", snapshots:{}, lastRedemption:{key:scope.id, at:now - 120_000, outcome:"reset", automatic:false}},
		account, scope, model:"chat-test", family:"codex", manager,
		read:vi.fn(async () => snapshot), isCurrent:() => true, now:() => now,
		observations:new Map(), clearQuotaScheduler:vi.fn(),
	};
	const reconciler = new ConfirmedResetReconciler();
	return {args, account, manager, snapshot, reconciler, run:() => reconciler.reconcile(args)};
}

it("rechecks an old receipt after restart and clears only the ordinary family block", async () => {
	const f = fixture();
	f.account.rateLimitResetTimes["codex:other-model"] = f.args.now() + 300_000;
	expect(await f.run()).toBe(true);
	expect(f.account.rateLimitResetTimes).toEqual({"codex:other-model":f.args.now() + 300_000});
	expect(f.args.read).toHaveBeenCalledTimes(1);
	expect(f.args.clearQuotaScheduler).toHaveBeenCalledTimes(1);
});

it("applies a receipt once and preserves a later 429, even with the same deadline", async () => {
	const f = fixture();
	expect(await f.run()).toBe(true);
	f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "chat-test");
	const deadlines = {...f.account.rateLimitResetTimes};
	expect(await f.run()).toBe(false);
	expect(f.account.rateLimitResetTimes).toEqual(deadlines);
	expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("shares a read across simultaneous requests", async () => {
	const f = fixture();
	expect(await Promise.all([f.run(), f.run(), f.run()])).toEqual([true, false, false]);
	expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("does not revive an old receipt after a more recent rejection", async () => {
	const f = fixture();
	f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "chat-test");
	expect(await f.run()).toBe(false);
	expect(f.args.read).not.toHaveBeenCalled();
	expect(f.account.rateLimitResetTimes.codex).toBeDefined();
});

it.each(["new-429", "manager-replaced", "disabled", "workspace-changed"])("preserves blockers if %s happens during the read", async event => {
	const f = fixture();
	f.args.read = async () => {
		if (event === "new-429") f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "chat-test");
		if (event === "manager-replaced") f.args.isCurrent = () => false;
		if (event === "disabled") f.account.enabled = false;
		if (event === "workspace-changed") { f.account.workspaces = [{id:"different", enabled:true}]; f.account.currentWorkspaceIndex = 0; }
		return f.snapshot;
	};
	expect(await f.run()).toBe(false);
	expect(f.account.rateLimitResetTimes.codex).toBeDefined();
	expect(f.args.clearQuotaScheduler).not.toHaveBeenCalled();
});

it.each(["pending", "wrong-workspace", "failed-outcome", "auth", "reserve", "tokens", "unknown", "exhausted", "stale-read"])("does not lift a block for %s", async condition => {
	const f = fixture();
	if (condition === "pending") f.args.state!.pending = {key:f.args.scope.id, idempotencyKey:"pending"};
	if (condition === "wrong-workspace") f.args.state!.lastRedemption!.key = "different";
	if (condition === "failed-outcome") f.args.state!.lastRedemption!.outcome = "noCredit";
	if (condition === "auth") f.account.authInvalidatedAt = 1;
	if (condition === "reserve") f.args.model = "gpt-reserve";
	if (condition === "tokens") f.account.lastRateLimitReason = "tokens";
	if (condition === "unknown") f.snapshot.ordinaryUsageAllowed = null;
	if (condition === "exhausted") f.snapshot.ordinaryUsageAllowed = false;
	if (condition === "stale-read") f.snapshot.updatedAt -= 1;
	expect(await f.run()).toBe(false);
	expect(f.account.rateLimitResetTimes.codex).toBeDefined();
	expect(f.args.clearQuotaScheduler).not.toHaveBeenCalled();
});

it("retries a failed read without spending another credit", async () => {
	const f = fixture();
	f.args.read = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce(f.snapshot);
	expect(await f.run()).toBe(false);
	expect(await f.run()).toBe(true);
	expect(f.args.read).toHaveBeenCalledTimes(2);
});
