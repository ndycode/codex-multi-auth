import { expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
it("does not create any directories when acquisition ownership is rejected", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lock-guard-")), action = vi.fn(async () => { });
    try {
        await expect(withFileTransactionLock(join(root, "missing", "file"), action, { guardAcquisition: async () => { throw Error("no owner"); } })).rejects.toThrow("no owner");
        expect(await fs.readdir(root)).toEqual([]);
        expect(action).not.toHaveBeenCalled();
    }
    finally {
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("releases the acquisition guard before contention retries and the action", async () => {
    vi.useFakeTimers();
    const root = await fs.mkdtemp(join(tmpdir(), "lock-guard-retry-"));
    const path = join(root, "file");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    let held = false, guards = 0;
    const guard = async <T>(action: () => Promise<T>) => { expect(held).toBe(false); held = true; guards++; try {
        return await action();
    }
    finally {
        held = false;
    } };
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    try {
        first = withFileTransactionLock(path, async () => { entered(); await gate; });
        await started;
        second = withFileTransactionLock(path, async () => { expect(held).toBe(false); }, { guardAcquisition: guard });
        await vi.waitFor(() => { expect(guards).toBeGreaterThanOrEqual(2); expect(held).toBe(false); });
        release();
        await first;
        await vi.waitFor(async () => { await second; });
        expect(guards).toBeGreaterThanOrEqual(3);
    }
    finally {
        release();
        try {
            await vi.waitFor(async () => { await Promise.allSettled([first, second]); });
        }
        finally {
            vi.useRealTimers();
            await removeWithRetry(root, { recursive: true, force: true });
        }
    }
});
it("cleans only its candidate if ownership is revoked before publication", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lock-guard-revoked-"));
    let attempts = 0;
    try {
        await expect(withFileTransactionLock(join(root, "file"), async () => { }, { guardAcquisition: async (action) => { if (++attempts === 2)
                throw Error("revoked"); return action(); } })).rejects.toThrow("revoked");
        expect(await fs.readdir(root)).toEqual([]);
    }
    finally {
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("cleans its unique candidate when writing the owner fails", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lock-guard-owner-failure-"));
    const write = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => { if (String(args[0]).includes(".candidate-"))
        throw Error("owner write failed"); return write(...args); });
    try {
        await expect(withFileTransactionLock(join(root, "file"), async () => { }, { guardAcquisition: async (action) => action() })).rejects.toThrow("owner write failed");
        expect(await fs.readdir(root)).toEqual([]);
    }
    finally {
        spy.mockRestore();
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
