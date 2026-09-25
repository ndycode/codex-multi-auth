import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { logWarn } from "../logger.js";
import { withRetry } from "../fs-retry.js";
type Lease = {
    active: boolean;
};
const abandonedOwners = new Set<string>();
const leases = new AsyncLocalStorage<Map<string, Lease>>();
const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const ownerPattern = /^([a-f0-9]{16})\.([1-9][0-9]*)\.([a-f0-9-]{36})$/;
function code(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}
function dead(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return code(error) === "ESRCH";
    }
}
async function removeEmpty(path: string): Promise<void> {
    try {
        await fs.rmdir(path);
    }
    catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? ""))
            throw error;
    }
}
function retryAbandonedRelease(path: string, owner: string, remaining = 30): void {
    const timer = setTimeout(() => {
        void (async () => {
            try {
                try { await fs.unlink(join(path, owner)); }
                catch (error) { if (code(error) !== "ENOENT") throw error; }
                // Owner filenames are unique; never delete another owner's contents.
                await removeEmpty(path);
                abandonedOwners.delete(owner);
            } catch {
                if (remaining > 1) retryAbandonedRelease(path, owner, remaining - 1);
            }
        })();
    }, 250);
    timer.unref();
}
async function recoverDeadOwner(path: string): Promise<void> {
    let entries: string[];
    try {
        const stat = await fs.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw Error("Invalid storage lock; manual repair required");
        entries = await fs.readdir(path);
    }
    catch (error) {
        if (code(error) === "ENOENT")
            return;
        throw error;
    }
    // Published locks always have an owner. Empty means a release/recovery was interrupted.
    if (!entries.length) {
        await removeEmpty(path);
        return;
    }
    if (entries.length !== 1)
        throw Error("Invalid storage lock contents; manual repair required");
    const name = entries[0];
    if (!name)
        return;
    const owner = ownerPattern.exec(name);
    if (!owner || owner[1] !== host || !Number.isSafeInteger(Number(owner[2])))
        return;
    if (!abandonedOwners.has(name) && !dead(Number(owner[2])))
        return;
    try {
        await fs.unlink(join(path, name));
    }
    catch (error) {
        if (code(error) === "ENOENT")
            return;
        throw error;
    }
    // Never recursively remove: another writer may already have published a new nonempty lock.
    abandonedOwners.delete(name);
    await removeEmpty(path);
}
async function recoverDeadCandidates(lock: string): Promise<void> {
    const parent = dirname(lock), prefix = `${basename(lock)}.candidate-`;
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = join(parent, entry.name);
        try {
            const owners = await fs.readdir(candidate);
            // An empty candidate may belong to a live writer still publishing its owner.
            if (owners.length !== 1 || !ownerPattern.test(owners[0] ?? "")) continue;
            await recoverDeadOwner(candidate);
        } catch (error) {
            if (code(error) !== "ENOENT") logWarn("Storage candidate cleanup deferred", { code: code(error) ?? "unknown" });
        }
    }
}
/** Local-disk transaction lock. Live processes are never evicted by age.
 * Publish an already-populated directory atomically: there is no ownerless acquisition window.
 * Recovery unlinks only the dead owner's unique filename; rmdir cannot erase a new owner's lock.
 * A reused PID fails closed (bounded contention) rather than risking two writers.
 */
export async function withFileTransactionLock<T>(path: string, action: () => Promise<T>, options: {
    waitMs?: number;
} = {}): Promise<T> {
    const absolute = resolve(path);
    await fs.mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    // Canonicalize the existing parent so /tmp and its symlink aliases share a lock.
    const key = join(await fs.realpath(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
    if (leases.getStore()?.get(key)?.active)
        return action();
    const lock = `${key}.write-lock`;
    await recoverDeadCandidates(lock);
    const candidate = await fs.mkdtemp(`${lock}.candidate-`);
    const owner = `${host}.${process.pid}.${randomUUID()}`;
    let published = false;
    try {
        await fs.chmod(candidate, 0o700);
        await fs.writeFile(join(candidate, owner), "", { flag: "wx", mode: 0o600 });
        await withRetry(async () => {
            try {
                await fs.rename(candidate, lock);
                published = true;
            }
            catch (error) {
                if (!["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(code(error) ?? ""))
                    throw error;
                // Permission errors without a destination are not lock contention.
                if (["EPERM", "EACCES"].includes(code(error) ?? "")) {
                    try {
                        await fs.lstat(lock);
                    }
                    catch {
                        throw error;
                    }
                }
                await recoverDeadOwner(lock);
                throw Object.assign(Error("Storage is busy with another live writer; retry shortly."), { code: "ELOCKED" });
            }
        }, { maxAttempts: Math.max(1, Math.ceil((options.waitMs ?? 10000) / 25) + 1), backoffMs: 25, retryableCodes: ["ELOCKED", "EBUSY", "EPERM", "EACCES", "EAGAIN"] });
        const lease = { active: true };
        const context = new Map(leases.getStore());
        context.set(key, lease);
        try {
            return await leases.run(context, action);
        }
        finally {
            lease.active = false;
        }
    }
    finally {
        const directory = published ? lock : candidate;
        try { await withRetry(async () => {
            try {
                await fs.unlink(join(directory, owner));
            }
            catch (error) {
                if (code(error) !== "ENOENT")
                    throw error;
            }
            await removeEmpty(directory);
        }, { maxAttempts: 6, backoffMs: 25 });
        } catch (error) {
            abandonedOwners.add(owner);retryAbandonedRelease(directory, owner);
            logWarn("Storage lock cleanup deferred", { code: code(error) ?? "unknown" });
        }
    }
}
