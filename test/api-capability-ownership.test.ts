import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiRoutes, saveApiRoutes, updateApiModelDiscovery } from "../lib/api-route-store.js";
import { enrichPersistedApiCapabilities, resetPersistedApiCapabilitiesForTests } from "../lib/runtime/persisted-api-capabilities.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import * as locks from "../lib/storage/file-lock.js";
afterEach(() => { vi.restoreAllMocks(); resetPersistedApiCapabilitiesForTests(); });
const fixture = { id: "a", label: "a", kind: "api" as const, apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"], knownModels: ["fixture"] };
async function sandbox(action: (root: string) => Promise<void>) {
    const root = await fs.mkdtemp(join(tmpdir(), "capability-owner-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    try {
        await action(root);
    }
    finally {
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
}
const success = (init: RequestInit) => { const body = JSON.parse(String(init.body)); return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] }); };
it("keeps a completed probe when another route discovers new models", async () => sandbox(async (root) => {
    await saveApiRoutes([fixture, { ...fixture, id: "b" }]);
    const [a, b] = await loadApiRoutes();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    let posts = 0;
    const fetcher: typeof fetch = async (_url, init) => {
        if (init?.method !== "POST")
            return new Response("missing", { status: 404 });
        posts++;
        entered();
        await gate;
        return success(init);
    };
    const pending = enrichPersistedApiCapabilities([{ slug: "fixture" }], false, a, false, { fetchImpl: fetcher, requireStoredRoute: true });
    try {
        await started;
        await updateApiModelDiscovery(b, ["fixture", "gpt-new"]);
        release();
        const [result] = await pending;
        expect(result.capability_probe_status).toHaveProperty("responses");
        const count = posts;
        await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, a, false, { fetchImpl: fetcher, requireStoredRoute: true });
        expect(posts).toBe(count);
        expect(await fs.stat(join(root, "api-capability-probes.json"))).toBeDefined();
    }
    finally {
        release();
        await pending;
    }
}));
it.each(["cache", "routes"].flatMap(target => ["ELOCKED", "ENOSPC", "EROFS", "EACCES"].map(code => ({ target, code }))))("keeps cached evidence when $target lease fails with $code", async ({ target, code }) => sandbox(async (root) => {
    await saveApiRoutes([fixture]);
    const [route] = await loadApiRoutes();
    let posts = 0;
    const fetcher: typeof fetch = async (_url, init) => {
        if (init?.method !== "POST")
            return new Response("missing", { status: 404 });
        posts++;
        return success(init);
    };
    const original = locks.withFileTransactionLock;
    if (target === "cache")
        vi.spyOn(locks, "withFileTransactionLock").mockImplementation(async (...args) => {
            if (String(args[0]) === join(root, "api-capability-probes.json"))
                throw Object.assign(Error("readonly"), { code });
            return original(...args);
        });
    const options = { fetchImpl: fetcher, requireStoredRoute: true };
    const [first] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
    expect(first.capability_probe_status).toBeDefined();
    const before = posts;
    if (target === "routes")
        vi.spyOn(locks, "withFileTransactionLock").mockImplementation(async (...args) => {
            if (String(args[0]) === join(root, "api-routes.json"))
                throw Object.assign(Error("readonly"), { code });
            return original(...args);
        });
    const [second] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
    expect(second.capability_probe_status).toEqual(first.capability_probe_status);
    expect(posts).toBe(before);
}));
it("mints store-owned epochs for readd and policy changes, preserves discovery and irrelevant edits", async () => sandbox(async () => {
    await saveApiRoutes([fixture]);
    const [initial] = await loadApiRoutes();
    expect(initial.capabilityEpoch).toEqual(expect.any(String));
    await saveApiRoutes([{ ...fixture, label: "renamed", priority: 2, capabilityEpoch: "00000000-0000-4000-8000-000000000000" }]);
    const [renamed] = await loadApiRoutes();
    expect(renamed.capabilityEpoch).toBe(initial.capabilityEpoch);
    const expanded = await updateApiModelDiscovery(renamed, ["fixture", "gpt-new"]);
    expect(expanded.capabilityEpoch).toBe(initial.capabilityEpoch);
    await saveApiRoutes([{ ...expanded, visibleModels: ["fixture"] }]);
    const [policy] = await loadApiRoutes();
    expect(policy.capabilityEpoch).not.toBe(initial.capabilityEpoch);
    await saveApiRoutes([]);
    await saveApiRoutes([initial]);
    const [readded] = await loadApiRoutes();
    expect(readded.capabilityEpoch).not.toBe(initial.capabilityEpoch);
    let calls = 0;
    await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, initial, false, { requireStoredRoute: true, fetchImpl: async (_url, init) => {
            if (init?.method === "POST")
                calls++;
            return new Response("missing", { status: 404 });
        } });
    expect(calls).toBe(0);
}));
it("migrates a legacy route before paid probes without requiring a discovery change", async () => sandbox(async (root) => {
    await fs.writeFile(join(root, "api-routes.json"), JSON.stringify({ version: 1, routes: [fixture] }));
    let posts = 0;
    await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, fixture, false, { requireStoredRoute: true, fetchImpl: async (_url, init) => {
            if (init?.method !== "POST")
                return new Response("missing", { status: 404 });
            posts++;
            return success(init);
        } });
    expect(posts).toBeGreaterThan(0);
    expect((await loadApiRoutes())[0].capabilityEpoch).toEqual(expect.any(String));
}));
it("keeps the migrated epoch when the same credential is readded after its save returns", async () => sandbox(async (root) => {
    const transactions = await import("../lib/storage/transactions.js");
    const { ensureApiRouteCapabilityEpoch } = await import("../lib/api-route-store.js");
    await fs.writeFile(join(root, "api-routes.json"), JSON.stringify({ version: 1, routes: [fixture] }));
    const original = transactions.withStorageLock;
    let armed = true;
    const spy = vi.spyOn(transactions, "withStorageLock").mockImplementation(async (action) => {
        const result = await original(action);
        if (armed) {
            armed = false;
            await saveApiRoutes([]);
            await saveApiRoutes([fixture]);
        }
        return result;
    });
    try {
        const migrated = await ensureApiRouteCapabilityEpoch(fixture);
        const [current] = await loadApiRoutes();
        expect(migrated?.capabilityEpoch).not.toBe(current.capabilityEpoch);
        expect((await updateApiModelDiscovery(migrated!, ["fixture", "gpt-new"])).enabled).toBe(false);
        expect((await loadApiRoutes())[0].visibleModels).toEqual(["fixture"]);
    }
    finally {
        spy.mockRestore();
    }
}));
it.each(["legacy", "readd", "foreign"])("scopes persisted evidence while preserving legitimate %s cache", async (scenario) => sandbox(async (root) => {
    const { createHash, randomUUID } = await import("node:crypto");
    const key = createHash("sha256").update("a\0fixture\0fixture").digest("hex");
    if (scenario === "legacy")
        await fs.writeFile(join(root, "api-routes.json"), JSON.stringify({ version: 1, routes: [fixture] }));
    else {
        await saveApiRoutes([fixture]);
        if (scenario === "readd") {
            await saveApiRoutes([]);
            await saveApiRoutes([{ ...fixture, legacyCapabilityCache: true }]);
        }
    }
    await fs.writeFile(join(root, "api-capability-probes.json"), JSON.stringify({ version: 1, entries: [[key, { at: Date.now(), levels: ["low"], tiers: [], status: { responses: "verified" }, ...(scenario === "foreign" ? { ownerEpoch: randomUUID() } : {}) }]] }));
    let posts = 0;
    const [route] = await loadApiRoutes();
    const [result] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, { requireStoredRoute: true, fetchImpl: async (_url, init) => { if (init?.method !== "POST")
            return new Response("missing", { status: 404 }); posts++; return success(init); } });
    expect(result.capability_probe_status).toBeDefined();
    if (scenario === "legacy")
        expect(posts).toBe(0);
    else
        expect(posts).toBeGreaterThan(0);
    const cache = JSON.parse(await fs.readFile(join(root, "api-capability-probes.json"), "utf8"));
    expect(cache.entries[0][1].ownerEpoch).toBe((await loadApiRoutes())[0].capabilityEpoch);
}));
it("uses readable legacy evidence without migration writes when the route lease is read-only", async () => sandbox(async (root) => {
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update("a\0fixture\0fixture").digest("hex");
    const routes = JSON.stringify({ version: 1, routes: [fixture] });
    await fs.writeFile(join(root, "api-routes.json"), routes);
    const cache = JSON.stringify({ version: 1, entries: [[key, { at: Date.now(), levels: ["low"], tiers: [], status: { responses: "verified" } }]] });
    await fs.writeFile(join(root, "api-capability-probes.json"), cache);
    const original = locks.withFileTransactionLock;
    vi.spyOn(locks, "withFileTransactionLock").mockImplementation(async (...args) => { if (String(args[0]) === join(root, "api-routes.json"))
        throw Object.assign(Error("readonly"), { code: "EROFS" }); return original(...args); });
    let posts = 0;
    const options = { requireStoredRoute: true, fetchImpl: async (_url: unknown, init?: RequestInit) => { if (init?.method === "POST")
            posts++; return new Response("missing", { status: 404 }); } };
    const [result] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, fixture, false, options);
    expect(result.capability_probe_status).toEqual({ responses: "verified" });
    const [changed] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, { ...fixture, apiKey: "changed" }, false, options);
    expect(changed.capability_probe_status).toBeUndefined();
    expect(posts).toBe(0);
    expect(await fs.readFile(join(root, "api-routes.json"), "utf8")).toBe(routes);
    expect(await fs.readFile(join(root, "api-capability-probes.json"), "utf8")).toBe(cache);
}));
it.each([false, true])("does not trust caller legacy flags after an ownership read fails (has epoch=%s)", async hasEpoch => sandbox(async root => {
 const api=await import("../lib/api-route-store.js");const {createHash}=await import("node:crypto");
 await saveApiRoutes([fixture]);const [stored]=await loadApiRoutes();const key=createHash("sha256").update("a\0fixture\0fixture").digest("hex");
 await fs.writeFile(join(root,"api-capability-probes.json"),JSON.stringify({version:1,entries:[[key,{at:Date.now(),levels:["low"],tiers:[],status:{responses:"verified"}}]]}));
 vi.spyOn(api,"ensureApiRouteCapabilityEpoch").mockRejectedValueOnce(Object.assign(Error("readonly"),{code:"EROFS"}));
 let posts=0;const [result]=await enrichPersistedApiCapabilities([{slug:"fixture"}],false,{...(hasEpoch?stored:fixture),legacyCapabilityCache:true},false,{requireStoredRoute:true,fetchImpl:async(_url,init)=>{if(init?.method==="POST")posts++;return new Response("missing",{status:404});}});
 expect(result.capability_probe_status).toBeUndefined();expect(posts).toBe(0);
}));
it("does not adopt ownership after the required fallback snapshot read fails",async()=>sandbox(async root=>{
 const api=await import("../lib/api-route-store.js");const {createHash}=await import("node:crypto");
 await saveApiRoutes([fixture]);const [stored]=await loadApiRoutes();const key=createHash("sha256").update("a\0fixture\0fixture").digest("hex");
 await fs.writeFile(join(root,"api-capability-probes.json"),JSON.stringify({version:1,entries:[[key,{at:Date.now(),levels:["low"],tiers:[],status:{responses:"verified"}}]]}));
 vi.spyOn(api,"ensureApiRouteCapabilityEpoch").mockRejectedValueOnce(Error("unavailable"));
 const load=vi.spyOn(api,"loadApiRoutes").mockRejectedValueOnce(Error("unreadable"));
 let posts=0;const [result]=await enrichPersistedApiCapabilities([{slug:"fixture"}],false,{...stored,legacyCapabilityCache:true},false,{requireStoredRoute:true,fetchImpl:async(_url,init)=>{if(init?.method==="POST")posts++;return new Response("missing",{status:404});}});
 expect(result.capability_probe_status).toBeUndefined();expect(posts).toBe(0);expect(load).toHaveBeenCalledTimes(1);
}));
