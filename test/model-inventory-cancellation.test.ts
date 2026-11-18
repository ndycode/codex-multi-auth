import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveModelInventory, resetModelInventoryWritesForTests } from "../lib/runtime/model-discovery-status.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
import { createAutomaticApiCheck, runAutomaticApiChecks } from "../lib/runtime/automatic-api-checks.js";
import { saveApiRoutes } from "../lib/api-route-store.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
let root: string;
const value = (checkedAt: number) => ({ version: 1 as const, checkedAt, entries: [] });
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "inventory-cancel-")); vi.stubEnv("CODEX_MULTI_AUTH_DIR", root); vi.useFakeTimers(); });
afterEach(async () => { await resetModelInventoryWritesForTests(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); await removeWithRetry(root, { recursive: true, force: true }); });
it("cancels a queued inventory write promptly without releasing another writer's queue", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    const path = join(root, "model-discovery.json"), rename = fs.rename.bind(fs);
    let first = true;
    const published: number[] = [];
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to) === path && first) {
        first = false;
        entered();
        await gate;
    } if (String(to) === path)
        published.push(JSON.parse(await fs.readFile(from, "utf8")).checkedAt); return rename(from, to); });
    const a = saveModelInventory(value(1));
    await started;
    const stop = new AbortController();
    let cancelled = false, third = false;
    const b = saveModelInventory(value(2), { signal: stop.signal }).catch(error => { expect(error).toBe(stop.signal.reason); cancelled = true; });
    const c = saveModelInventory(value(3)).then(() => { third = true; });
    try {
        stop.abort();
        await vi.waitFor(() => expect(cancelled).toBe(true));
        expect(third).toBe(false);
        release();
        await Promise.all([a, b, c]);
        expect(JSON.parse(await fs.readFile(path, "utf8")).checkedAt).toBe(3);
        expect(published).toEqual([1, 3]);
    }
    finally {
        release();
        await vi.waitFor(async () => { await Promise.allSettled([a, b, c]); });
    }
});
it.each([false, true])("cancels inventory lock contention before its owner releases (daily=%s)", async (daily) => {
    const path = join(root, "model-discovery.json");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    const held = withFileTransactionLock(path, async () => { entered(); await gate; });
    await started;
    const rename = fs.rename.bind(fs);
    const canonicalLock = join(await fs.realpath(root), "model-discovery.json.write-lock");
    let contended = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        try { return await rename(from, to); }
        catch (error) {
            if (String(to) === canonicalLock) {
                expect(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]).toContain((error as NodeJS.ErrnoException).code);
                contended = true;
            }
            throw error;
        }
    });
    const stop = new AbortController();
    let settled = false;
    let pending: Promise<unknown> | undefined;
    try {
        if (daily) {
            await saveApiRoutes([{ id: "fixture", label: "fixture", kind: "api", apiKey: "fixture", enabled: true, priority: 9, visibleModels: [], knownModels: [], probeCapabilities: true }]);
            pending = createAutomaticApiCheck(async () => Response.json({ data: [] }))(stop.signal).finally(() => { settled = true; });
        }
        else
            pending = saveModelInventory(value(1), { signal: stop.signal }).catch(error => { expect(error).toBe(stop.signal.reason); }).finally(() => { settled = true; });
        await vi.waitFor(() => expect(contended).toBe(true));
        stop.abort();
        await vi.waitFor(() => expect(settled).toBe(true));
        await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    finally {
        release();
        await vi.waitFor(async () => { await Promise.allSettled([held, pending]); });
    }
});
it("does not publish an inventory temp file after cancellation during its write", async () => {
    const stop = new AbortController(), write = fs.writeFile.bind(fs), path = join(root, "model-discovery.json");
    let inventoryWritten = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await write(...args);
        const target = String(args[0]);
        if (target.startsWith(`${path}.`) && target.endsWith(".tmp")) {
            expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(value(1));
            inventoryWritten = true;
            stop.abort();
        }
    });
    await expect(saveModelInventory(value(1), { signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(inventoryWritten).toBe(true);
    await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
it("retries exhausted preparation errors shortly without repeating claimed routes", async () => {
    const route = { id: "retry", label: "retry", kind: "api" as const, apiKey: "fixture", enabled: true, priority: 9, visibleModels: [], probeCapabilities: true };
    const later = { ...route, id: "claimed" };
    let now = 1000, failed = true;
    const checked: string[] = [];
    const options = { path: join(root, "automatic-api-checks.json"), now: () => now, loadRoutes: async () => [route, later], prepareRoute: async (r: typeof route) => { if (r.id === "retry" && failed) {
            now += 5000;
            throw Object.assign(Error("exhausted"), { code: "EBUSY" });
        } return r; }, check: async (r: typeof route) => { checked.push(r.id); } };
    const next = await runAutomaticApiChecks(options);
    expect(next).toBe(now + 60000);
    expect(checked).toEqual(["claimed"]);
    now = next!;
    failed = false;
    await runAutomaticApiChecks(options);
    expect(checked).toEqual(["claimed", "retry"]);
});
