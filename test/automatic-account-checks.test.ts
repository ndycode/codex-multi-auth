import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccountPolicyKey, upsertAccountPolicy, type AccountPolicyStore } from "../lib/account-policy.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { runAutomaticAccountChecks, startAutomaticAccountChecks, AUTOMATIC_CHECK_INTERVAL_MS, AUTOMATIC_CHECK_INITIAL_DELAY_MS } from "../lib/runtime/automatic-account-checks.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "automatic-checks-")); });
afterEach(async () => { vi.useRealTimers(); await removeWithRetry(dir, { recursive: true, force: true }); });
function fixture() {
    const storage: AccountStorageV3 = { version: 3, activeIndex: 0, accounts: [0, 1, 2].map(i => ({ accountId: `fixture-${i}`, refreshToken: `fixture-${i}`, addedAt: 1, lastUsed: 1 })) };
    const policies: AccountPolicyStore = { version: 1, accounts: {} };
    const check = vi.fn(async (_storage: AccountStorageV3, _index: number, _signal: AbortSignal) => { });
    let now = 1000;
    const options = { path: join(dir, "attempts.json"), loadAccounts: async () => storage, loadPolicies: async () => policies, check, now: () => now };
    const enable = (index: number) => upsertAccountPolicy(policies, getAccountPolicyKey(storage.accounts[index]!), p => { p.autoPrime = true; });
    return { storage, policies, check, options, enable, advance: () => { now += AUTOMATIC_CHECK_INTERVAL_MS; } };
}
it("does no probing or state writes until an account opts in", async () => {
    const f = fixture();
    await runAutomaticAccountChecks(f.options);
    expect(f.check).not.toHaveBeenCalled();
    expect(await fs.readdir(dir)).toEqual([]);
    f.enable(1);
    await runAutomaticAccountChecks(f.options);
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.check.mock.calls[0]?.[1]).toBe(1);
});
it("shares attempt limits across independent check runners, including failed probes", async () => {
    const f = fixture();
    f.enable(0);
    f.check.mockRejectedValue(Error("fixture secret"));
    await Promise.allSettled([runAutomaticAccountChecks(f.options), runAutomaticAccountChecks({ ...f.options })]);
    expect(f.check).toHaveBeenCalledTimes(1);
    f.advance();
    await runAutomaticAccountChecks(f.options);
    expect(f.check).toHaveBeenCalledTimes(2);
    const raw = await fs.readFile(f.options.path, "utf8");
    expect(raw).not.toContain("fixture");
});
it("skips disabled, invalidated, paused, drained, and cooling accounts", async () => {
    const f = fixture();
    f.enable(0);
    const a = f.storage.accounts[0]!;
    for (const state of [{ enabled: false }, { authInvalidatedAt: 1 }, { coolingDownUntil: 2000 }]) {
        const before = { ...a };
        Object.assign(a, state);
        await runAutomaticAccountChecks(f.options);
        for (const key of Object.keys(a))
            Reflect.deleteProperty(a, key);
        Object.assign(a, before);
    }
    const policy = f.policies.accounts[getAccountPolicyKey(a)]!;
    policy.paused = true;
    await runAutomaticAccountChecks(f.options);
    policy.paused = false;
    policy.drained = true;
    await runAutomaticAccountChecks(f.options);
    expect(f.check).not.toHaveBeenCalled();
});
it("fails closed on unreadable attempt history", async () => {
    const f = fixture();
    f.enable(0);
    await fs.writeFile(f.options.path, "broken");
    await expect(runAutomaticAccountChecks(f.options)).rejects.toThrow();
    expect(f.check).not.toHaveBeenCalled();
});
it("runs periodically without overlap and aborts cleanly on stop", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const started = new Promise<void>(r => entered = r);
    const run = vi.fn(async (signal: AbortSignal) => { entered(); await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true })); });
    const service = startAutomaticAccountChecks(run);
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INITIAL_DELAY_MS);
    await started;
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INTERVAL_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
    await service.stop();
    expect(run.mock.calls[0]?.[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(1);
});

describe("initial automatic check", () => {
    const startWith = (f: ReturnType<typeof fixture>) => startAutomaticAccountChecks(signal => runAutomaticAccountChecks({ ...f.options, signal }));
    it("checks an opted-in account shortly after start, long before the interval", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
        const f = fixture();
        f.enable(0);
        const service = startWith(f);
        await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INITIAL_DELAY_MS);
        await vi.waitFor(() => expect(f.check).toHaveBeenCalledTimes(1));
        await service.stop();
    });
    it("skips the initial check when another router attempted it recently", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
        const f = fixture();
        f.enable(0);
        await runAutomaticAccountChecks(f.options);
        expect(f.check).toHaveBeenCalledTimes(1);
        const service = startWith(f);
        await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INITIAL_DELAY_MS);
        await service.stop();
        expect(f.check).toHaveBeenCalledTimes(1);
    });
    it("does nothing at start when no account opted in", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
        const f = fixture();
        const service = startWith(f);
        await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INITIAL_DELAY_MS);
        await service.stop();
        expect(f.check).not.toHaveBeenCalled();
        expect(await fs.readdir(dir)).toEqual([]);
    });
    it("cancels the pending initial check on stop", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
        const run = vi.fn(async () => undefined);
        const service = startAutomaticAccountChecks(run);
        await service.stop();
        await vi.advanceTimersByTimeAsync(AUTOMATIC_CHECK_INTERVAL_MS * 2);
        expect(run).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
