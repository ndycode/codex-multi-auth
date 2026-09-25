import { promises as fs } from "node:fs";
import { z } from "zod";
import { getAccountPolicyKey, type AccountPolicyStore } from "../account-policy.js";
import type { AccountStorageV3 } from "../storage.js";
import { withFileTransactionLock } from "../storage/file-lock.js";
import { withRetry } from "../fs-retry.js";
import { tempPathFor } from "../temp-path.js";
import { logWarn } from "../logger.js";
export const AUTOMATIC_CHECK_INTERVAL_MS = 15 * 60000;
/** First tick after router start, so a short CLI session still gets its check. */
export const AUTOMATIC_CHECK_INITIAL_DELAY_MS = 5000;
const schema = z.record(z.string().regex(/^sha256:[a-f0-9]{64}$/), z.number().finite().nonnegative());
const retry = { maxAttempts: 6, backoffMs: 25 };
export interface AutomaticAccountCheckOptions {
    path: string;
    loadAccounts: () => Promise<AccountStorageV3 | null>;
    loadPolicies: () => Promise<AccountPolicyStore>;
    check: (storage: AccountStorageV3, index: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
    signal?: AbortSignal;
}
async function readAttempts(path: string): Promise<Record<string, number>> {
    try {
        const raw = await withRetry(() => fs.readFile(path, "utf8"), retry);
        if (Buffer.byteLength(raw) > 1024 * 1024)
            throw Error("Automatic-check history exceeds its size limit");
        return schema.parse(JSON.parse(raw));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return {};
        throw error;
    }
}
async function saveAttempts(path: string, attempts: Record<string, number>): Promise<void> {
    const temp = tempPathFor(path);
    try {
        await fs.writeFile(temp, JSON.stringify(attempts) + "\n", { mode: 0o600, flag: "wx" });
        await withRetry(() => fs.rename(temp, path), retry);
    }
    finally {
        await withRetry(() => fs.rm(temp, { force: true }), retry);
    }
}
/** A durable attempt precedes network I/O, so failures and competing routers cannot double-prime. */
export async function runAutomaticAccountChecks(options: AutomaticAccountCheckOptions): Promise<void> {
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted || !Object.values((await options.loadPolicies()).accounts).some(p => p.autoPrime))
        return;
    await withFileTransactionLock(options.path, async () => {
        const policies = await options.loadPolicies();
        const storage = await options.loadAccounts();
        if (!storage || signal.aborted)
            return;
        const attempts = await readAttempts(options.path);
        const keys = new Set(storage.accounts.map(a => getAccountPolicyKey(a)));
        for (const key of Object.keys(attempts))
            if (!keys.has(key))
                delete attempts[key];
        for (let index = 0; index < storage.accounts.length; index++) {
            if (signal.aborted)
                break;
            const account = storage.accounts[index];
            if (!account)
                continue;
            const key = getAccountPolicyKey(account), policy = policies.accounts[key], now = options.now?.() ?? Date.now();
            if (!policy?.autoPrime || policy.paused || policy.drained || account.enabled === false || account.authInvalidatedAt || (account.coolingDownUntil ?? 0) > now)
                continue;
            const lastAttempt = attempts[key];
            if (lastAttempt !== undefined && now - lastAttempt < AUTOMATIC_CHECK_INTERVAL_MS)
                continue;
            attempts[key] = now;
            await saveAttempts(options.path, attempts);
            try {
                await options.check(storage, index, signal);
            }
            catch {
                if (!signal.aborted)
                    logWarn("Automatic subscription check failed; retry deferred until the next interval.");
            }
        }
    }, { waitMs: 0 });
}
/**
 * No overlapping ticks; shutdown cancels the active probe and waits for its cleanup.
 * The first tick runs shortly after start, off the startup path; the durable
 * per-account attempts in runAutomaticAccountChecks keep it from repeating work
 * this or another router did recently, and it does nothing without an opt-in.
 */
export function startAutomaticAccountChecks(run: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    let pending: Promise<void> | undefined;
    const tick = () => {
        if (pending || controller.signal.aborted)
            return;
        pending = run(controller.signal).catch(() => {
            if (!controller.signal.aborted)
                logWarn("Automatic subscription checks unavailable; no unchecked retry was started.");
        }).finally(() => { pending = undefined; });
    };
    const initial = setTimeout(tick, AUTOMATIC_CHECK_INITIAL_DELAY_MS);
    initial.unref();
    const timer = setInterval(tick, AUTOMATIC_CHECK_INTERVAL_MS);
    timer.unref();
    return { async stop() { clearTimeout(initial); clearInterval(timer); controller.abort(); await pending; } };
}
