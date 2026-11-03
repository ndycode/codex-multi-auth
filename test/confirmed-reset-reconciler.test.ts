import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTokenTracker } from "../lib/rotation.js";
import { getRuntimeTrackerKey, AccountManager } from "../lib/accounts.js";
import { ConfirmedResetReconciler } from "../lib/runtime/confirmed-reset-reconciler.js";
import { workspaceModelScopes } from "../lib/runtime/workspace-model-scopes.js";
import type { ResetSnapshot } from "../lib/runtime/reset-credits.js";

beforeEach(() => AccountManager.resetVolatileRuntimeState());
afterEach(() => vi.restoreAllMocks());

type ResetState = NonNullable<Awaited<ReturnType<Parameters<ConfirmedResetReconciler["reconcile"]>[0]["state"]>>>;

function fixture() {
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now);
	const manager = new AccountManager(undefined, {version:3, activeIndex:0, accounts:[
		{recordId:"first", accountId:"workspace", refreshToken:"r", addedAt:1, lastUsed:1},
	]});
	vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => {});
	const account = manager.getAccountByIndex(0)!;
	const scope = workspaceModelScopes(account)[0]!;
	const snapshot: ResetSnapshot = {updatedAt:now, availableCount:1, credits:null, ordinaryUsageAllowed:true, planType:"pro", primary:{usedPercent:0}, secondary:{}};
	account.rateLimitResetTimes = {codex:now + 300_000};
	const state: ResetState = {version:1, policy:"manual", snapshots:{}, lastRedemption:{key:scope.id, at:now - 120_000, outcome:"reset", automatic:false}};
	const args: Parameters<ConfirmedResetReconciler["reconcile"]>[0] = {
		state:vi.fn(async () => state),
		account, scope, model:"chat-test", family:"codex", manager,
		read:vi.fn(async () => snapshot), isCurrent:() => true, now:() => now,
		observations:new Map(), clearQuotaScheduler:vi.fn(),
	};
	const reconciler = new ConfirmedResetReconciler();
	return {args, state, account, manager, snapshot, reconciler, run:() => reconciler.reconcile(args)};
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

it("shares a read across simultaneous requests and reports its recovery to each", async () => {
	const f = fixture();
	expect(await Promise.all([f.run(), f.run(), f.run()])).toEqual([true, true, true]);
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
	if (condition === "pending") f.state.pending = {key:f.args.scope.id, idempotencyKey:"pending"};
	if (condition === "wrong-workspace") f.state.lastRedemption!.key = "different";
	if (condition === "failed-outcome") f.state.lastRedemption!.outcome = "noCredit";
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

it.each(["error", "unknown", "exhausted"])("backs off %s reads, then retries the same receipt", async outcome => {
	const f = fixture();
	let now = f.args.now(); f.args.now = () => now;
	const read = vi.fn<() => Promise<ResetSnapshot | undefined>>(); f.args.read = read;
	if (outcome === "error") read.mockRejectedValueOnce(Error("offline"));
	else read.mockResolvedValueOnce({...f.snapshot, ordinaryUsageAllowed:outcome === "unknown" ? null : false});
	expect(await f.run()).toBe(false);
	for (let i = 0; i < 3; i++) expect(await f.run()).toBe(false);
	expect(read).toHaveBeenCalledTimes(1);
	now += 5_000; f.snapshot.updatedAt = now; read.mockResolvedValueOnce(f.snapshot);
	expect(await f.run()).toBe(true);
	expect(read).toHaveBeenCalledTimes(2);
});

it("doubles the wait between unconfirmed reads of the same receipt up to five minutes", async () => {
	const f = fixture(); let now = f.args.now(); f.args.now = () => now;
	f.account.rateLimitResetTimes = {codex:now + 3_600_000};
	const read = vi.fn(async (): Promise<ResetSnapshot> => ({...f.snapshot, updatedAt:now, ordinaryUsageAllowed:false})); f.args.read = read;
	expect(await f.run()).toBe(false);
	for (const seconds of [5, 10, 20, 40, 80, 160, 300, 300]) {
		const reads = read.mock.calls.length;
		now += seconds * 1_000 - 1; expect(await f.run()).toBe(false); expect(read).toHaveBeenCalledTimes(reads);
		now += 1; expect(await f.run()).toBe(false); expect(read).toHaveBeenCalledTimes(reads + 1);
	}
	// A different receipt is a new redemption and is checked immediately.
	f.state.lastRedemption!.at = now - 1_000;
	expect(await f.run()).toBe(false); expect(read).toHaveBeenCalledTimes(10);
});

it("retries an aborted read after the manager becomes current again", async () => {
	const f = fixture();
	f.args.read = vi.fn(async () => { f.args.isCurrent = () => false; return f.snapshot; });
	expect(await f.run()).toBe(false);
	f.args.isCurrent = () => true; f.args.read = vi.fn(async () => f.snapshot);
	expect(await f.run()).toBe(true);
	expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("reconciles the same receipt in a replacement manager with persisted blockers", async () => {
	const f = fixture(); expect(await f.run()).toBe(true);
	const replacement = fixture();
	expect(await f.reconciler.reconcile({...replacement.args, state:f.args.state})).toBe(true);
	expect(replacement.account.rateLimitResetTimes.codex).toBeUndefined();
});

it("does not retry a receipt after a concurrent 429 that follows it", async () => {
	const f = fixture(); let now = f.args.now(); f.args.now = () => now;
	f.args.read = vi.fn(async () => { f.account.rateLimitObservations = {codex:{revision:1, observedAt:now, reason:"quota"}}; throw Error("offline"); });
	expect(await f.run()).toBe(false); now += 10_000;
	expect(await f.run()).toBe(false); expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("rechecks a receipt after a concurrent rejection to a request sent before it", async () => {
	const f = fixture(); let now = f.args.now(); f.args.now = () => now;
	Object.assign(f.state.lastRedemption!, {generation:1});
	const read = vi.fn<() => Promise<ResetSnapshot | undefined>>()
		.mockImplementationOnce(async () => {
			f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "chat-test", f.args.scope.id, {workspaceId:"workspace", receipts:{}});
			return f.snapshot;
		})
		.mockImplementation(async () => ({...f.snapshot, updatedAt:now}));
	f.args.read = read;
	expect(await f.run()).toBe(false);
	expect(await f.run()).toBe(false); expect(read).toHaveBeenCalledTimes(1);
	now += 5_000;
	expect(await f.run()).toBe(true); expect(read).toHaveBeenCalledTimes(2);
});

it.each([1, 2] as const)("does not replay a v%i receipt predating a rejection after clock rollback", async version => {
 const f=fixture();
 const before=f.args.now();
 f.state.version=version;
 f.state.lastRedemption!.at=before-1000;
 f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test");
 const rollback=before-10000;
 vi.spyOn(Date,"now").mockReturnValue(rollback);
 f.args.now=()=>rollback;f.snapshot.updatedAt=rollback;
 const deadlines={...f.account.rateLimitResetTimes};
 expect(await f.run()).toBe(false);
 expect(f.args.read).not.toHaveBeenCalled();
 expect(f.account.rateLimitResetTimes).toEqual(deadlines);
});

it.each([1,2] as const)("retains a visible legacy v%i receipt identity when rollback precedes rejection", async version => {
 const f=fixture(),receipt=f.state.lastRedemption!;
 f.state.version=version;
 receipt.at=f.args.now();
 f.account.resetReceiptIdentities={[f.args.scope.id]:JSON.stringify([receipt.key,receipt.at,receipt.outcome,receipt.automatic])};
 const now=receipt.at-10000;
 vi.spyOn(Date,"now").mockReturnValue(now);f.args.now=()=>now;f.snapshot.updatedAt=now;
 f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test",f.args.scope.id);
 expect(await f.run()).toBe(false);expect(f.args.read).not.toHaveBeenCalled();
 // A different legacy receipt completed after the clock step may recover.
 receipt.at=now+1000;f.args.now=()=>now+1000;f.snapshot.updatedAt=now+1000;
 expect(await f.run()).toBe(true);
});

it.each([1,2] as const)("accepts a distinct sequenced legacy v%i receipt after clock catch-up", async version => {
 for (const appliedPrevious of [false,true]) {
  const f=fixture(),receipt=f.state.lastRedemption!;
  f.state.version=version;
  const before=f.args.now();receipt.at=before-1000;
  if(appliedPrevious)expect(await f.run()).toBe(true);
  f.account.resetReceiptIdentities={[f.args.scope.id]:JSON.stringify([receipt.key,receipt.at,receipt.outcome,receipt.automatic])};
  vi.spyOn(Date,"now").mockReturnValue(before);
  f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test",f.args.scope.id);
  receipt.at=before-10000;
  f.args.now=()=>before+1000;f.snapshot.updatedAt=before+1000;
  expect(await f.run()).toBe(true);
  expect(f.args.read).toHaveBeenCalledTimes(appliedPrevious?2:1);
  f.account.rateLimitResetTimes.codex=before+300000;
  expect(await f.run()).toBe(false);
  vi.restoreAllMocks();
 }
});

it("accepts a new receipt after a backward clock step", async () => {
	const f = fixture(); let now = f.args.now(); f.args.now = () => now;
	expect(await f.run()).toBe(true);
	f.account.rateLimitObservations = {codex:{revision:1, observedAt:now, reason:"quota"}}; f.account.rateLimitResetTimes.codex = now + 300_000;
	now -= 600_000;
	f.state.lastRedemption!.at = now; f.snapshot.updatedAt = now;
	expect(await f.run()).toBe(true); expect(f.args.read).toHaveBeenCalledTimes(2);
});

it("rechecks a distinct legacy receipt stamped before an applied one", async () => {
	const f = fixture(); let now = f.args.now(); f.args.now = () => now; vi.spyOn(Date, "now").mockImplementation(() => now);
	const receipt = f.state.lastRedemption!; receipt.at = now;
	expect(await f.run()).toBe(true);
	now -= 10_000;
	f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "chat-test", f.args.scope.id);
	// Completed during the rollback, after that rejection; no request sees it until the clock catches up.
	receipt.at = now + 1_000;
	now += 11_000; f.snapshot.updatedAt = now;
	expect(await f.run()).toBe(true); expect(f.args.read).toHaveBeenCalledTimes(2);
});

it("orders a distinct legacy receipt by the identity a rejection saw, not wall time", async () => {
	const f = fixture(); let now = f.args.now(); f.args.now = () => now; vi.spyOn(Date, "now").mockImplementation(() => now);
	const receipt = f.state.lastRedemption!; receipt.at = now;
	f.account.resetReceiptIdentities = {[f.args.scope.id]:JSON.stringify([receipt.key, receipt.at, receipt.outcome, receipt.automatic])};
	f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "chat-test", f.args.scope.id);
	expect(await f.run()).toBe(false); expect(f.args.read).not.toHaveBeenCalled();
	// An older CLI completes a different receipt during a rollback; no request sees it until catch-up.
	receipt.at = now - 9_000;
	now += 1_000; f.snapshot.updatedAt = now;
	expect(await f.run()).toBe(true); expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("does not read receipts or native quota for a healthy account with an old receipt", async () => {
	const f = fixture(); f.account.rateLimitResetTimes = {};
	expect(await f.run()).toBe(false); expect(await f.run()).toBe(false);
	expect(f.args.state).not.toHaveBeenCalled(); expect(f.args.read).not.toHaveBeenCalled();
	f.args.hasQuotaDeferral = () => true;
	expect(await f.run()).toBe(true);
});

it.each([false, true])("bounds quota observations without evicting an updated key: %s", async update => {
	const f = fixture(); const key = JSON.stringify([f.args.scope.id, f.args.model]);
	for (let i = 0; i < 1000; i++) f.args.observations.set(update && i === 0 ? key : `old-${i}`, {updatedAt:1, status:200, model:"old", primary:{}, secondary:{}});
	expect(await f.run()).toBe(true);
	expect(f.args.observations.size).toBe(1000);
	expect(f.args.observations.has(key)).toBe(true);
	expect(f.args.observations.has("old-1")).toBe(true);
	expect(f.args.observations.has("old-0")).toBe(false);
});


it.each(["before", "during"])("keeps Reserve and model-specific rejections separate from ordinary recovery: %s", async phase => {
 const f = fixture();
 const reject = () => {
  f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "gpt-reserve");
  f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "tokens", "other-model");
 };
 if (phase === "before") reject();
 else f.args.read = async () => { reject(); return f.snapshot; };
 expect(await f.run()).toBe(true);
 expect(f.account.rateLimitResetTimes.codex).toBeUndefined();
 expect(f.account.rateLimitResetTimes["codex:gpt-reserve"]).toBeDefined();
 expect(f.account.rateLimitResetTimes["codex:other-model"]).toBeDefined();
});

it("accepts an idempotently completed redemption only after fresh permission", async () => {
 const f = fixture(); f.state.lastRedemption!.outcome = "alreadyRedeemed";
 expect(await f.run()).toBe(true); expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("handles a clock rollback after the receipt and still applies that receipt once", async () => {
 const f = fixture(); const receiptAt = f.args.now();
 f.state.lastRedemption!.at = receiptAt;
 f.args.now = () => receiptAt - 600_000; f.snapshot.updatedAt = f.args.now();
 expect(await Promise.all([f.run(), f.run()])).toEqual([true, true]);
 f.account.rateLimitResetTimes.codex = receiptAt + 300_000;
 expect(await f.run()).toBe(false); expect(f.args.read).toHaveBeenCalledTimes(1);
});


it("accepts a later durable generation after the clock catches up to an older receipt", async () => {
 const f = fixture(); const originalNow = f.args.now();
 Object.assign(f.state.lastRedemption!, {generation:1});
 f.state.lastRedemption!.at = originalNow;
 expect(await f.run()).toBe(true);
 f.manager.markRateLimitedWithReason(f.account, 300_000, "codex", "quota", "chat-test");
 Object.assign(f.state.lastRedemption!, {generation:2, at:originalNow-600_000});
 // No request observes the intervening backward-clock period.
 expect(await f.run()).toBe(true);
 expect(f.args.read).toHaveBeenCalledTimes(2);
});


it("refills only the confirmed account/model admission bucket", async () => {
 const f = fixture(); const key = getRuntimeTrackerKey(f.account), tracker = getTokenTracker();
 tracker.drain(key,"codex:chat-test",1000); tracker.drain(key,"codex:other-model",1000); tracker.drain("other-account","codex:chat-test",1000);
 expect(tracker.tryConsume(key,"codex:chat-test")).toBe(false);
 expect(await f.run()).toBe(true);
 expect(tracker.tryConsume(key,"codex:chat-test")).toBe(true);
 expect(tracker.tryConsume(key,"codex:other-model")).toBe(false);
 expect(tracker.tryConsume("other-account","codex:chat-test")).toBe(false);
});

it("does not replay a generation after a later 429 even following manager replacement", async () => {
 const f = fixture(); Object.assign(f.state.lastRedemption!,{generation:1});
 expect(await f.run()).toBe(true);
 f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test");
 const replacement = fixture(); replacement.account.rateLimitObservations = f.account.rateLimitObservations;
 replacement.account.resetReceiptGenerations = {...f.account.resetReceiptGenerations};
 replacement.args.state = f.args.state;
 expect(await f.reconciler.reconcile(replacement.args)).toBe(false);
 expect(replacement.args.read).not.toHaveBeenCalled();
});

it("rejects a stale generation even after retry backoff expires", async () => {
 const f = fixture(); Object.assign(f.state.lastRedemption!,{generation:2});
 let now = f.args.now(); f.args.now=()=>now; f.args.read=vi.fn(async()=>undefined);
 expect(await f.run()).toBe(false);
 now+=10000; Object.assign(f.state.lastRedemption!,{generation:1});
 expect(await f.run()).toBe(false); expect(f.args.read).toHaveBeenCalledTimes(1);
});


it("reconciles a completed receipt while a different workspace redemption is pending", async () => {
 const f=fixture();f.state.pending={key:"other-workspace",idempotencyKey:"pending"};
 expect(await f.run()).toBe(true);expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("reconciles when a rejected account's exact admission bucket is the only remaining blocker", async () => {
 const f=fixture();Object.assign(f.state.lastRedemption!,{generation:1});
 f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test");f.account.rateLimitResetTimes={};
 const tracker=getTokenTracker(),key=getRuntimeTrackerKey(f.account);
 tracker.drain(key,"codex:chat-test",1000);
 expect(await f.run()).toBe(true);
 expect(tracker.tryConsume(key,"codex:chat-test")).toBe(true);
});

it("does not read or refill a bucket drained by load without a quota rejection", async () => {
 const f=fixture();Object.assign(f.state.lastRedemption!,{generation:1,at:f.args.now()-7*86_400_000});
 f.account.rateLimitResetTimes={};
 const tracker=getTokenTracker(),key=getRuntimeTrackerKey(f.account);
 tracker.drain(key,"codex:chat-test",1000);
 expect(await f.run()).toBe(false);
 expect(f.args.read).not.toHaveBeenCalled();
 expect(tracker.tryConsume(key,"codex:chat-test")).toBe(false);
});

it.each(["before","during"])("ignores another workspace's rejection chronology: %s", async phase => {
 const f=fixture();f.account.workspaces=[{id:"workspace",enabled:true},{id:"other-workspace",enabled:true}];f.account.currentWorkspaceIndex=0;
 const other=workspaceModelScopes(f.account).find(s=>s.accountId==="other-workspace")!;
 Object.assign(f.state.lastRedemption!,{generation:1});
 f.account.resetReceiptGenerations={[f.args.scope.id]:1,[other.id]:2};
 const reject=()=>f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test",other.id);
 if(phase==="before")reject();else f.args.read=async()=>{reject();return f.snapshot;};
 expect(await f.run()).toBe(true);
});


it("skips bucket-only checks for callers that bypass local admission", async () => {
 const f=fixture();f.account.rateLimitResetTimes={};f.args.usesAdmissionBucket=false;
 getTokenTracker().drain(getRuntimeTrackerKey(f.account),"codex:chat-test",1000);
 expect(await f.run()).toBe(false);expect(f.args.read).not.toHaveBeenCalled();
});


it("retains an unscoped concurrent rejection even when scoped history already exists", async () => {
 const f=fixture();Object.assign(f.state.lastRedemption!,{generation:2});
 f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test",f.args.scope.id);
 f.args.read=async()=>{f.manager.markRateLimitedWithReason(f.account,300000,"codex","quota","chat-test");return f.snapshot;};
 expect(await f.run()).toBe(false);expect(f.args.clearQuotaScheduler).not.toHaveBeenCalled();
});

it("bounds an unsequenced rejection by the next successful read, even when it has no receipt", async () => {
 const f=fixture();const now=f.args.now();
 f.manager.markRateLimitedWithReason(f.account,3_600_000,"codex","quota","chat-test",f.args.scope.id,{workspaceId:"workspace",receiptReadFailed:true});
 const other={key:"other-workspace",at:now,outcome:"reset" as const,automatic:false,generation:1};
 Object.assign(f.state,{version:3,redemptionGeneration:1,lastRedemption:other,redemptions:{[other.key]:other}});
 expect(await f.run()).toBe(false);
 // This workspace's first redemption follows that read.
 const mine={key:f.args.scope.id,at:now,outcome:"reset" as const,automatic:false,generation:2};
 Object.assign(f.state,{redemptionGeneration:2,lastRedemption:mine,redemptions:{[other.key]:other,[mine.key]:mine}});
 expect(await f.run()).toBe(true);expect(f.args.read).toHaveBeenCalledTimes(1);
});

it("bounds an unsequenced rejection by the legacy receipt visible at the next read", async () => {
 const f=fixture();const receipt=f.state.lastRedemption!;
 f.manager.markRateLimitedWithReason(f.account,3_600_000,"codex","quota","chat-test",f.args.scope.id,{workspaceId:"workspace",receiptReadFailed:true});
 expect(await f.run()).toBe(false);expect(await f.run()).toBe(false);
 expect(f.args.read).not.toHaveBeenCalled();
 // A different legacy receipt can only have been written after that read.
 receipt.at+=1;
 expect(await f.run()).toBe(true);expect(f.args.read).toHaveBeenCalledTimes(1);
});
