import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { AccountManager } from "../lib/accounts.js";
import { saveApiRoutes } from "../lib/api-route-store.js";
import { startRuntimeRotationProxy } from "../lib/runtime-rotation-proxy.js";
import { createAutomaticApiCheck } from "../lib/runtime/automatic-api-checks.js";
import { discoverModelInventory } from "../lib/runtime/model-discovery-status.js";
import {resetPersistedApiCapabilitiesForTests} from "../lib/runtime/persisted-api-capabilities.js";
afterEach(()=>{vi.restoreAllMocks();resetPersistedApiCapabilitiesForTests();});
it("preserves transient backoff when scheduled program evidence is due", async () => {
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "automatic-program-backoff-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    let now = 1000, posts = 0, failing = false;
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method !== "POST") return new Response("missing", { status: 404 });
        posts++;
        if (failing) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 });
        const body = JSON.parse(String(init.body));
        return Response.json({ status: "completed", reasoning: body.reasoning, access_programs: body.access_programs, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
    };
    const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"], accessPrograms: { cyber: ["standard"] } };
    const check = () => enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, { fetchImpl: fetcher, now: () => now, programRefreshBefore: now + 86400_000 });
    try {
        await check();
        now++;
        failing = true;
        const [failed] = await check();
        expect(failed.program_checked_at).toBe(1000);
        expect(failed.capability_probe_status).toMatchObject({ retry: "transient" });
        const count = posts;
        now++;
        await check();
        expect(posts).toBe(count);
        now += 60_000;
        failing = false;
        const [retried] = await check();
        expect(posts).toBeGreaterThan(count);
        expect(retried.program_checked_at).toBe(now);
    } finally {
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("routes all capability enrichment traffic through the provided fetcher", async () => {
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "enrich-fetch-impl-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const calls: { url: string; method?: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        if (init?.method !== "POST") return new Response("missing", { status: 404 });
        const body = JSON.parse(String(init.body));
        return Response.json({ status: "completed", reasoning: body.reasoning, access_programs: body.access_programs, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
    };
    const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"], accessPrograms: { cyber: ["standard"] } };
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("capability checks must not bypass the configured fetcher"));
    try {
        await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, { fetchImpl: fetcher, now: () => 1000 });
        expect(calls).toContainEqual({ url: "https://api.openai.com/v1/responses", method: "POST" });
        expect(globalFetch).not.toHaveBeenCalled();
    } finally {
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it.each([1, 86400_000 - 300_000])("renews programs before claiming another daily interval after %s ms of live evidence", async (age) => {
    const { loadModelInventory } = await import("../lib/runtime/model-discovery-status.js");
    const root = await mkdtemp(join(tmpdir(), "automatic-program-horizon-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    let now = 1000, programs = 0, posts = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher: typeof fetch = async (input, init) => {
        if (String(input).includes("/models")) return Response.json({ data: [{ id: "fixture" }] });
        if (init?.method !== "POST") return new Response("missing", { status: 404 });
        const body = JSON.parse(String(init.body));
        posts++;
        if (body.access_programs) programs++;
        return Response.json({ status: "completed", reasoning: body.reasoning, access_programs: body.access_programs, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"], knownModels: ["fixture"], accessPrograms: { cyber: ["standard"] } };
    const live = () => discoverModelInventory(null, [route], { fetchImpl: fetcher, persistProbes: true, updateApiDiscovery: async () => route });
    try {
        await saveApiRoutes([route]);
        await live();
        expect(programs).toBe(1);
        now += age;
        await live(); // Plain refresh keeps the independent 24-hour program cache.
        expect(programs).toBe(1);
        const daily = createAutomaticApiCheck();
        const signal = new AbortController().signal;
        await daily(signal);
        expect(programs).toBe(2);
        expect((await loadModelInventory())?.entries[0].entitlements?.[0].programCheckedAt).toBe(now);
        const count = posts;
        await daily(signal);
        await live();
        expect(posts).toBe(count);
        now += 86400_000;
        await daily(signal);
        expect(programs).toBe(3);
    } finally {
        vi.restoreAllMocks();
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("preserves non-probing live catalog reasoning through a documentation outage", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-api-documentation-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const realFetch = globalThis.fetch;
    let outage = false, posts = 0;
    const fetcher: typeof fetch = async (input, init) => {
        if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
        if (String(input).startsWith("https://developers.openai.com/")) {
            expect(new Headers(init?.headers).has("authorization")).toBe(false);
            return outage ? new Response("unavailable", { status: 503 })
                : new Response("Model ID: `fixture`\nReasoning.effort supports: low, medium, high.");
        }
        if (init?.method !== "POST") return Response.json({ data: [{ id: "fixture" }], models: [] });
        posts++;
        return Response.json({ status: "completed", output: [] });
    };
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    const route = { id: "docs", label: "fixture", kind: "api" as const, apiKey: "fixture-secret", enabled: true, priority: 0, probeCapabilities: false, visibleModels: ["fixture"], knownModels: ["fixture"] };
    const manager = new AccountManager(undefined, { version: 3, activeIndex: 0, accounts: [] });
    let proxy: Awaited<ReturnType<typeof startRuntimeRotationProxy>> | undefined;
    const headers = { authorization: "Bearer fixture-local", "content-type": "application/json" };
    try {
        await saveApiRoutes([route]);
        proxy = await startRuntimeRotationProxy({ accountManager: manager, fetchImpl: fetcher, nativeOpenai: true, clientApiKey: "fixture-local" });
        const catalog = async () => {
            const response = await realFetch(`${proxy!.baseUrl}/models?refresh_capabilities=1`, { headers });
            expect(response.status).toBe(200);
            const body = await response.json();
            return body.models.find((model: { slug: string }) => model.slug === "api/fixture");
        };
        const first = await catalog();
        expect(first.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toContain("high");
        outage = true;
        const second = await catalog();
        expect(second.supported_reasoning_levels).toEqual(first.supported_reasoning_levels);
        expect(posts).toBe(0);
        const response = await realFetch(`${proxy.baseUrl}/responses`, {
            headers, method: "POST", body: JSON.stringify({ model: "api/fixture", reasoning: { effort: "high" }, input: "fixture", stream: false }),
        });
        expect(response.status).toBe(200);
        await response.text();
        expect(posts).toBe(1);
    } finally {
        await proxy?.close();
        await manager.flushPendingSave();
        mock.mockRestore();
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("shares paid probe results between production live catalogs, daily checks, and restarted discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-api-probes-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const realFetch = globalThis.fetch;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), first = new Promise<void>(r => { started = r; });
    let programPosts = 0, posts = 0;
    const fetcher: typeof fetch = async (input, init) => {
        if (String(input).startsWith("http://127.0.0.1:"))
            return realFetch(input, init);
        if (String(input).includes("/models"))
            return Response.json({ data: [{ id: "gpt-6-test-shared" }], models: [] });
        if (init?.method !== "POST")
            return new Response("missing", { status: 404 });
        const body = JSON.parse(String(init.body));
        posts++;
        if (posts === 1) {
            started();
            await gate;
        }
        if (body.access_programs)
            programPosts++;
        return Response.json({ status: "completed", reasoning: body.reasoning, access_programs: body.access_programs, service_tier: body.service_tier ?? "default", output: [{ type: "function_call", name: "capability_probe" }] });
    };
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    const route = { id: "shared", label: "shared", kind: "api" as const, apiKey: "fixture-secret", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["gpt-6-test-shared"], knownModels: ["gpt-6-test-shared"] };
    const manager = new AccountManager(undefined, { version: 3, activeIndex: 0, accounts: [] });
    let proxy: Awaited<ReturnType<typeof startRuntimeRotationProxy>> | undefined;
    try {
        await saveApiRoutes([route]);
        proxy = await startRuntimeRotationProxy({ accountManager: manager, fetchImpl: fetcher, nativeOpenai: true, clientApiKey: "fixture-local" });
        const live = realFetch(`${proxy.baseUrl}/models`, { headers: { authorization: "Bearer fixture-local" } });
        await first;
        const daily = createAutomaticApiCheck()(new AbortController().signal);
        release();
        await (await live).text();
        await daily;
        expect(programPosts).toBe(2);
        const before = posts;
        await discoverModelInventory(null, [route], { fetchImpl: fetcher, persistProbes: true, updateApiDiscovery: async () => route });
        expect(posts).toBe(before);
        await discoverModelInventory(null, [route], { fetchImpl: fetcher, persistProbes: true, forceProbes: true, updateApiDiscovery: async () => route });
        expect(programPosts).toBe(4);
    }
    finally {
        release();
        await proxy?.close();
        await manager.flushPendingSave();
        mock.mockRestore();
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("does not put non-probing inference metadata behind a paid probe lease", async () => {
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const { apiPickerModel } = await import("../lib/runtime/api-model-runtime.js");
    const root = await mkdtemp(join(tmpdir(), "shared-api-nonprobe-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), first = new Promise<void>(r => { started = r; });
    const route = { id: "shared", label: "shared", kind: "api" as const, apiKey: "fixture-secret", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] };
    const fetcher: typeof fetch = async (_input, init) => { if (init?.method !== "POST")
        return new Response("missing", { status: 404 }); started(); await gate; return Response.json({ output: [] }); };
    let paid: Promise<unknown> | undefined;
    let metadata: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
        paid = enrichPersistedApiCapabilities([apiPickerModel("fixture")], false, route, false, { fetchImpl: fetcher });
        await first;
        // Keep the paid request held while only fake retry time advances.
        let result: unknown;
        metadata = enrichPersistedApiCapabilities([apiPickerModel("fixture")], false, { ...route, probeCapabilities: false }, false, { fetchImpl: fetcher })
            .then(value => { result = value; });
        await vi.waitFor(() => expect(result).toHaveLength(1), { timeout: 1000, interval: 50 });
    }
    finally {
        release();
        let drained = false;
        const pending = Promise.allSettled([paid, metadata]).then(() => { drained = true; });
        try {
            // Keep advancing fake time for lock/backoff cleanup, including the
            // failure path where a regressed metadata call waits on the lease.
            await vi.waitFor(() => expect(drained).toBe(true), { timeout: 2000, interval: 50 });
            await pending;
        } finally {
            vi.useRealTimers();
            if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
            else process.env.CODEX_MULTI_AUTH_DIR = previous;
            await removeWithRetry(root, { recursive: true, force: true });
        }
    }
});

it("caps paid probes across independent routes at four", async () => {
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const { apiPickerModel } = await import("../lib/runtime/api-model-runtime.js");
    const root = await mkdtemp(join(tmpdir(), "shared-api-limit-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    let active = 0, maximum = 0;
    let release!:()=>void, started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), saturated=new Promise<void>(resolve=>{started=resolve;});
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method !== "POST")
            return new Response("missing", { status: 404 });
        active++;
        maximum = Math.max(maximum, active);
        if(active===4)started();
        await gate;
        active--;
        return Response.json({ output: [] });
    };
    try {
        const pending = Promise.all(Array.from({ length: 3 }, (_, i) => enrichPersistedApiCapabilities([apiPickerModel(`fixture-${i}`)], false, { id: `route-${i}`, label: "fixture", kind: "api", apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true }, false, { fetchImpl: fetcher })));
        try { await saturated; expect(()=>resetPersistedApiCapabilitiesForTests()).toThrow("Cannot reset active"); }
        finally { release(); await pending; }
        expect(maximum).toBeLessThanOrEqual(4);
        expect(maximum).toBeGreaterThan(1);
    }
    finally {
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("does not overwrite unrelated evidence updated at the same timestamp", async () => {
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const { apiPickerModel } = await import("../lib/runtime/api-model-runtime.js");
    const { writeFile, readFile } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "shared-api-merge-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const path = join(root, "api-capability-probes.json"), id = "a".repeat(64), at = 1000;
    const old = { at, levels: [], tiers: [], status: { responses: "unsupported" } }, updated = { ...old, status: { responses: "verified" } };
    await writeFile(path, JSON.stringify({ version: 1, entries: [[id, old]] }));
    let changed = false;
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method !== "POST")
            return new Response("missing", { status: 404 });
        if (!changed) {
            changed = true;
            await writeFile(path, JSON.stringify({ version: 1, entries: [[id, updated]] }));
        }
        return Response.json({ output: [] });
    };
    try {
        await enrichPersistedApiCapabilities([apiPickerModel("fixture")], false, { id: "route", label: "fixture", kind: "api", apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true }, false, { fetchImpl: fetcher, now: () => at });
        expect(new Map(JSON.parse(await readFile(path, "utf8")).entries).get(id)).toEqual(updated);
    }
    finally {
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("returns documentation without paid probes when another lease times out", async () => {
    const locks = await import("../lib/storage/file-lock.js");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const { apiPickerModel } = await import("../lib/runtime/api-model-runtime.js");
    const lock = vi.spyOn(locks, "withFileTransactionLock").mockRejectedValue(Object.assign(new Error("held"), { code: "ELOCKED" }));
    let posts = 0;
    const fetcher: typeof fetch = async (_input, init) => { if (init?.method === "POST")
        posts++; return new Response("missing", { status: 404 }); };
    try {
        const result = await enrichPersistedApiCapabilities([apiPickerModel("fixture")], false, { id: "route", label: "fixture", kind: "api", apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true }, false, { fetchImpl: fetcher });
        expect(result).toHaveLength(1);
        expect(posts).toBe(0);
    }
    finally {
        lock.mockRestore();
    }
});

it.each(["corrupt", "EACCES"])("preserves unreadable %s cache without paid probes", async (failure) => {
    const { promises: fs } = await import("node:fs");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "probe-read-failure-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const path = join(root, "api-capability-probes.json");
    const original = failure === "corrupt" ? "{broken" : JSON.stringify({ version: 1, entries: [] });
    await fs.writeFile(path, original);
    const read = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]) === path && failure === "EACCES")
            throw Object.assign(Error("denied"), { code: "EACCES" });
        return read(...args);
    });
    let posts = 0;
    try {
        const result = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, { id: "fixture", kind: "api", label: "fixture", apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] }, false, { fetchImpl: async (_url, init) => { if (init?.method === "POST")
                posts++; return new Response("missing", { status: 404 }); } });
        expect(result).toHaveLength(1);
        expect(posts).toBe(0);
        expect(await read(path, "utf8")).toBe(original);
    }
    finally {
        spy.mockRestore();
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("returns completed evidence after ENOSPC and avoids immediate duplicate probes", async () => {
    const { promises: fs } = await import("node:fs");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "probe-write-failure-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to).endsWith("api-capability-probes.json"))
        throw Object.assign(Error("full"), { code: "ENOSPC" }); return rename(from, to); });
    let posts = 0;
    const route = { id: "fixture", kind: "api" as const, label: "fixture", apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] };
    const options = { fetchImpl: async (_url: unknown, init?: RequestInit) => { if (init?.method !== "POST")
            return new Response("missing", { status: 404 }); posts++; const body = JSON.parse(String(init.body)); return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] }); } };
    try {
        const [first] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(first.capability_probe_status).toMatchObject({ responses: "verified" });
        const before = posts;
        const [second] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(second.capability_probe_status).toMatchObject({ responses: "verified" });
        expect(posts).toBe(before);
    }
    finally {
        spy.mockRestore();
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it.each(["fresh", "expired", "future", "changed-programs", "changed-credential"])("keeps only fresh matching retained evidence after write then read failure: %s", async (scenario) => {
    const { promises: fs } = await import("node:fs");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "probe-write-read-failure-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const path = join(root, "api-capability-probes.json");
    const rename = fs.rename.bind(fs), read = fs.readFile.bind(fs);
    let readFailed = false, now = 1000, posts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === path) throw Object.assign(Error("full"), { code: "ENOSPC" });
        return rename(from, to);
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (readFailed && String(args[0]) === path) throw Object.assign(Error("unavailable"), { code: "EIO" });
        return read(...args);
    });
    const route = { id: "fixture", kind: "api" as const, label: "fixture", apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, accessPrograms: { cyber: ["standard"] } };
    const options = { now: () => now, fetchImpl: async (_url: unknown, init?: RequestInit) => {
        if (init?.method !== "POST") return new Response("missing", { status: 404 });
        posts++;
        const body = JSON.parse(String(init.body));
        return Response.json({ status: "completed", reasoning: body.reasoning, service_tier: body.service_tier, access_programs: body.access_programs, output: [{ type: "function_call", name: "capability_probe" }] });
    } };
    try {
        const [first] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(first.capability_probe_status).toMatchObject({ responses: "verified", "program:cyber:standard": "verified" });
        const count = posts;
        readFailed = true;
        if (scenario === "expired") now += 900_001;
        else if (scenario === "future") now--;
        const current = scenario === "changed-programs" ? { ...route, accessPrograms: { cyber: ["daybreak_blue"] } }
            : scenario === "changed-credential" ? { ...route, apiKey: "new-fixture-key" } : route;
        const [second] = await enrichPersistedApiCapabilities([scenario === "fresh" ? { slug: "fixture" } : first], true, current, true, options);
        if (scenario === "fresh") {
            expect(second.capability_probe_status).toEqual(first.capability_probe_status);
            expect(second.service_tiers).toEqual(first.service_tiers);
            expect(second.capability_checked_at).toBe(1000);
            expect(second.program_checked_at).toBe(1000);
        } else {
            expect(second.capability_probe_status).toBeUndefined();
            expect(second.capability_checked_at).toBeUndefined();
            expect(second.program_checked_at).toBeUndefined();
            expect(second.service_tiers).toEqual([]);
        }
        expect(posts).toBe(count);
    } finally {
        vi.restoreAllMocks();
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("retries a transient locked cache read without losing existing entries", async () => {
    const { promises: fs } = await import("node:fs");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "probe-read-retry-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const path = join(root, "api-capability-probes.json"), id = "f".repeat(64), entry = { at: 1, levels: [], tiers: [], status: { responses: "verified" } };
    await fs.writeFile(path, JSON.stringify({ version: 1, entries: [[id, entry]] }));
    const read = fs.readFile.bind(fs);
    let reads = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => { if (String(args[0]) === path && ++reads === 1)
        throw Object.assign(Error("busy"), { code: "EBUSY" }); return read(...args); });
    let posts = 0;
    vi.useFakeTimers();
    try {
        const pending = enrichPersistedApiCapabilities([{ slug: "fixture" }], false, { id: "fixture", kind: "api", label: "fixture", apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] }, false, { fetchImpl: async (_url, init) => { if (init?.method === "POST")
                posts++; return new Response("missing", { status: 404 }); } });
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        await vi.runAllTimersAsync();
        await pending;
        expect(reads).toBeGreaterThanOrEqual(3);
        expect(posts).toBeGreaterThan(0);
        expect(new Map(JSON.parse(await read(path, "utf8")).entries).get(id)).toEqual(entry);
    }
    finally {
        vi.useRealTimers();
        spy.mockRestore();
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});

it.each(["EACCES", "EROFS", "ENOSPC"])("keeps API and ZDR metadata available when lease storage fails with %s", async (code) => {
    const locks = await import("../lib/storage/file-lock.js");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "probe-lease-unavailable-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const originalLock = locks.withFileTransactionLock;
    const lock = vi.spyOn(locks, "withFileTransactionLock").mockImplementation(async (...args) => {
        if (String(args[0]).includes("api-probe-locks")) throw Object.assign(new Error("fixture lease unavailable"), { code });
        return originalLock(...args);
    });
    let posts = 0;
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method === "POST") {
            posts++;
            throw Error("Paid probe must not run without its lease");
        }
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response("Model ID: `fixture`\nReasoning.effort supports: low, medium, high.");
    };
    try {
        for (const kind of ["api", "zdr"] as const) {
            const [model] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, {
                id: kind, label: "fixture", kind, apiKey: "fixture-key", enabled: true,
                priority: 0, probeCapabilities: true,
            }, false, { fetchImpl: fetcher });
            expect(model.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "high" })]));
        }
        expect(posts).toBe(0);
    } finally {
        lock.mockRestore();
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});

it.each([false, true])("replaces future-dated own evidence without repeating paid probes (save failure=%s)", async (saveFails) => {
	const { promises: fs } = await import("node:fs");
	const { createHash } = await import("node:crypto");
	const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
	const root = await mkdtemp(join(tmpdir(), "future-probes-"));
	const previous = process.env.CODEX_MULTI_AUTH_DIR;
	process.env.CODEX_MULTI_AUTH_DIR = root;
	const path = join(root, "api-capability-probes.json");
	const key = createHash("sha256").update("fixture\0fixture-key\0fixture").digest("hex");
	const future = { at: 2000, levels: [], tiers: [], status: { responses: "unsupported" } };
	await fs.writeFile(path, JSON.stringify({ version: 1, entries: [[key, future]] }));
	const rename = fs.rename.bind(fs);
	const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (saveFails && String(to) === path) throw Object.assign(Error("full"), { code: "ENOSPC" });
		return rename(from, to);
	});
	let posts = 0;
	const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true };
	const options = { now: () => 1000, fetchImpl: async (_url: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response("missing", { status: 404 });
		posts++;
		const body = JSON.parse(String(init.body));
		return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
	} };
	try {
		await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
		const firstPosts = posts;
		expect(firstPosts).toBeGreaterThan(0);
		await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
		expect(posts).toBe(firstPosts);
		spy.mockRestore();
		await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
		expect(posts).toBe(firstPosts);
		expect(new Map(JSON.parse(await fs.readFile(path, "utf8")).entries).get(key)).toMatchObject({ at: 1000, status: { responses: "verified" } });
	} finally {
		spy.mockRestore();
		if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = previous;
		await removeWithRetry(root, { recursive: true, force: true });
	}
});

it.each(["throttled", "transport", "revoked"])("preserves shared documentation during leased probe refresh with %s responses", async (failure) => {
    const { ApiModelCapabilities } = await import("../lib/runtime/api-model-capabilities.js");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const { resolveModelRoute } = await import("../lib/model-route-policy.js");
    const root = await mkdtemp(join(tmpdir(), "leased-documentation-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    let outage = false, now = 1000, docs = 0;
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method !== "POST") {
            docs++;
            expect(new Headers(init?.headers).has("authorization")).toBe(false);
            return outage ? new Response("unavailable", { status: 503 }) : new Response("Model ID: `fixture`\nReasoning.effort supports: low, medium, high.\n## Model details\n- Input modalities: text, image\n");
        }
        if (outage) {
            if (failure === "transport") throw Error("offline");
            return Response.json({ error: { code: failure === "revoked" ? "invalid_api_key" : "rate_limit_exceeded" } }, { status: failure === "revoked" ? 401 : 429 });
        }
        const body = JSON.parse(String(init.body));
        return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
    };
    const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] };
    const metadata = new ApiModelCapabilities(fetcher, () => now);
    const options = { fetchImpl: fetcher, now: () => now, metadata };
    try {
        const [first] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(first.supported_reasoning_levels).toContainEqual(expect.objectContaining({ effort: "high" }));
        expect(first.capability_probe_status).not.toHaveProperty("effort:high");
        now += 900_001;
        outage = true;
        const [second] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], true, route, false, options);
        const resolved = resolveModelRoute("api/fixture", [{ ...route, models: [second] }], { reasoningEffort: "high" });
        if (failure === "revoked") {
            expect(second.supported_reasoning_levels).toEqual([]);
            expect(resolved.candidates).toEqual([]);
        } else {
            expect(second.supported_reasoning_levels).toContainEqual(expect.objectContaining({ effort: "high" }));
            expect(second.input_modalities).toEqual(["text", "image"]);
            expect(resolved.candidates).toHaveLength(1);
        }
        expect(docs).toBe(2);
    } finally {
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});

it.each(["EACCES", "ELOCKED"])("reuses only valid readable disk evidence when lease fails with %s", async (code) => {
    const locks = await import("../lib/storage/file-lock.js");
    const { promises: fs } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const { resolveModelRoute } = await import("../lib/model-route-policy.js");
    const root = await mkdtemp(join(tmpdir(), "lease-disk-evidence-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const path = join(root, "api-capability-probes.json");
    const key = createHash("sha256").update("fixture\0fixture-key\0fixture").digest("hex");
    const entry = { at: 1000, programCheckedAt: 1000, levels: ["high"], tiers: ["fast"], status: { responses: "verified", "program:cyber:standard": "verified" } };
    const contents = JSON.stringify({ version: 1, entries: [[key, entry]] });
    await fs.writeFile(path, contents);
    const lock = vi.spyOn(locks, "withFileTransactionLock").mockRejectedValue(Object.assign(Error("unavailable"), { code }));
    let posts = 0;
    const fetcher: typeof fetch = async (_input, init) => { if (init?.method === "POST") posts++; return new Response("missing", { status: 404 }); };
    const route = { id: "fixture", label: "fixture", kind: "zdr" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"], accessPrograms: { cyber: ["standard"] } };
    try {
        for (const scenario of ["fresh", "expired", "future", "changed-credential", "changed-programs"]) {
            const now = scenario === "expired" ? 901_001 : scenario === "future" ? 999 : 1001;
            const current = scenario === "changed-credential" ? { ...route, apiKey: "other-key" } : scenario === "changed-programs" ? { ...route, accessPrograms: { cyber: ["daybreak_blue"] } } : route;
            const [model] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], true, current, true, { fetchImpl: fetcher, now: () => now, programRefreshBefore: now + 86400_000 });
            const resolved = resolveModelRoute("zdr/fixture", [{ ...current, models: [model] }], { reasoningEffort: "high", serviceTier: "priority" });
            if (scenario === "fresh") {
                expect(model.capability_probe_status).toEqual(entry.status);
                expect(model.capability_checked_at).toBe(1000);
                expect(resolved.candidates).toHaveLength(1);
            } else {
                expect(model.capability_probe_status).toBeUndefined();
                expect(resolved.candidates).toEqual([]);
            }
        }
        expect(posts).toBe(0);
        expect(await fs.readFile(path, "utf8")).toBe(contents);
    } finally {
        lock.mockRestore();
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});

it.each([1000, 1001])("prefers readable disk denial over retained positive evidence at %s", async (at) => {
    const locks = await import("../lib/storage/file-lock.js");
    const { promises: fs } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const { resolveModelRoute } = await import("../lib/model-route-policy.js");
    const root = await mkdtemp(join(tmpdir(), "lease-disk-denial-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const path = join(root, "api-capability-probes.json");
    const rename = fs.rename.bind(fs);
    const failedSave = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === path) throw Object.assign(Error("full"), { code: "ENOSPC" });
        return rename(from, to);
    });
    let now = 1000, posts = 0;
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method !== "POST") return new Response("missing", { status: 404 });
        posts++;
        const body = JSON.parse(String(init.body));
        return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
    };
    const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] };
    const options = { fetchImpl: fetcher, now: () => now };
    try {
        const [first] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(first.capability_probe_status).toMatchObject({ responses: "verified" });
        const count = posts;
        failedSave.mockRestore();
        const key = createHash("sha256").update("fixture\0fixture-key\0fixture").digest("hex");
        await fs.writeFile(path, JSON.stringify({ version: 1, entries: [[key, { at, levels: [], tiers: [], status: { responses: "unsupported" } }]] }));
        now = at;
        vi.spyOn(locks, "withFileTransactionLock").mockRejectedValue(Object.assign(Error("readonly"), { code: "EROFS" }));
        const [second] = await enrichPersistedApiCapabilities([first], false, route, false, options);
        expect(second.capability_probe_status).toEqual({ responses: "unsupported" });
        expect(resolveModelRoute("api/fixture", [{ ...route, models: [second] }]).candidates).toEqual([]);
        expect(posts).toBe(count);
    } finally {
        vi.restoreAllMocks();
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});

it.each(["throttled", "transport", "revoked", "unsupported"])("retains disk-only documented efforts after restarted daily checks unless denied: %s", async (failure) => {
    const { loadModelInventory } = await import("../lib/runtime/model-discovery-status.js");
    const { resolveModelRoute } = await import("../lib/model-route-policy.js");
    const root = await mkdtemp(join(tmpdir(), "restart-program-docs-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    let now = 1000, outage = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
        if (init?.method !== "POST") return outage ? new Response("offline", { status: 503 }) : new Response("Model ID: `fixture`\nReasoning.effort supports: low, medium, high.");
        const body = JSON.parse(String(init.body));
        if (outage) {
            if (failure === "transport") throw Error("offline");
            if (failure === "unsupported" && body.reasoning?.effort === "high") return Response.json({ error: { code: "unsupported_value", param: "reasoning.effort" } }, { status: 400 });
            if (failure !== "unsupported") return Response.json({ error: { code: failure === "revoked" ? "invalid_api_key" : "rate_limit_exceeded" } }, { status: failure === "revoked" ? 401 : 429 });
        }
        return Response.json({ status: "completed", reasoning: body.reasoning, access_programs: body.access_programs, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"], knownModels: ["fixture"], accessPrograms: { cyber: ["standard"] } };
    try {
        await saveApiRoutes([route]);
        const initial = await discoverModelInventory(null, [route], { fetchImpl: fetcher, persistProbes: true, updateApiDiscovery: async () => route });
        expect(initial.entries[0].entitlements![0].reasoningLevels).toContain("high");
        // No process-local capability/documentation object survives into this first scheduler pass.
        resetPersistedApiCapabilitiesForTests();
        now += 86400_000;
        outage = true;
        await createAutomaticApiCheck()(new AbortController().signal);
        const saved = (await loadModelInventory())!;
        const entitlement = saved.entries[0].entitlements![0];
        if (failure === "throttled" || failure === "transport") expect(entitlement.reasoningLevels).toContain("high");
        else expect(entitlement.reasoningLevels).not.toContain("high");
        const inventory = await discoverModelInventory(null, [route], { fetchImpl: fetcher, persistProbes: true, updateApiDiscovery: async () => route });
        expect(inventory.entries[0].entitlements![0].reasoningLevels).toEqual(entitlement.reasoningLevels);
        const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
        const [model] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, { fetchImpl: fetcher });
        const resolved = resolveModelRoute("api/fixture", [{ ...route, models: [model] }], { reasoningEffort: "high" });
        if (failure === "revoked" || failure === "unsupported") {
            expect(resolved.candidates).toEqual([]);
        } else {
            expect(model.supported_reasoning_levels).toContainEqual(expect.objectContaining({ effort: "high" }));
            expect(resolved.candidates).toHaveLength(1);
            expect(model.capability_probe_status).toMatchObject({ "effort:high": "unverified" });
        }
    } finally {
        vi.restoreAllMocks();
        if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
        else process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});

it.each(["wipe", "rotate", "disable", "readd"])("does not persist completed production discovery after credential %s", async (change) => {
 const {promises:fs}=await import("node:fs");
 const {clearCredentialSidecars}=await import("../lib/storage/credential-sidecars.js");
 const {updateApiModelDiscovery}=await import("../lib/api-route-store.js");
 const root=await mkdtemp(join(tmpdir(),"probe-owner-change-"));
 const previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=root;
 const route={id:"fixture",label:"fixture",kind:"api" as const,apiKey:"fixture",enabled:true,priority:0,probeCapabilities:true,visibleModels:["fixture"],knownModels:["fixture"]};
 let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),first=new Promise<void>(r=>{started=r;});
 const fetcher:typeof fetch=async(input,init)=>{
  if(String(input).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(init?.method!=="POST")return new Response("missing",{status:404});
  started();await gate;
  const body=JSON.parse(String(init.body));return Response.json({reasoning:body.reasoning,service_tier:body.service_tier,output:[{type:"function_call",name:"capability_probe"}]});
 };
 let pending:Promise<unknown>|undefined;
 try{
  await saveApiRoutes([route]);
  pending=discoverModelInventory(null,[route],{fetchImpl:fetcher,persistProbes:true,updateApiDiscovery:updateApiModelDiscovery});
  await first;
  if(change==="wipe"||change==="readd"){await clearCredentialSidecars();if(change==="readd")await saveApiRoutes([route]);}
  else await saveApiRoutes([{...route,...(change==="rotate"?{apiKey:"replacement"}:{enabled:false})}]);
  release();await pending;
  await expect(fs.stat(join(root,"api-capability-probes.json"))).rejects.toMatchObject({code:"ENOENT"});
 }finally{release();await pending;if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;await removeWithRetry(root,{recursive:true,force:true});}
});

it("invalidates retained production evidence after wipe and same-key readd", async () => {
    const { promises: fs } = await import("node:fs");
    const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
    const root = await mkdtemp(join(tmpdir(), "probe-write-failure-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to).endsWith("api-capability-probes.json"))
        throw Object.assign(Error("full"), { code: "ENOSPC" }); return rename(from, to); });
    let posts = 0;
    const route = { id: "fixture", kind: "api" as const, label: "fixture", apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] };
    const options = { requireStoredRoute: true, fetchImpl: async (_url: unknown, init?: RequestInit) => { if (init?.method !== "POST")
            return new Response("missing", { status: 404 }); posts++; const body = JSON.parse(String(init.body)); return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] }); } };
    try {
        await saveApiRoutes([route]);
        const [first] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(first.capability_probe_status).toMatchObject({ responses: "verified" });
        const before = posts;
        const [second] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(second.capability_probe_status).toMatchObject({ responses: "verified" });
        expect(posts).toBe(before);
        const { clearCredentialSidecars } = await import("../lib/storage/credential-sidecars.js");
        await clearCredentialSidecars();
        const [missing] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(posts).toBe(before);
        expect(missing.capability_probe_status).toBeUndefined();
        await saveApiRoutes([route]);
        spy.mockRestore();
        const [readded] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
        expect(posts).toBeGreaterThan(before);
        expect(readded.capability_probe_status).toMatchObject({ responses: "verified" });
    }
    finally {
        spy.mockRestore();
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("discards cache-only evidence when credentials are wiped while documentation is pending", async () => {
	const locks = await import("../lib/storage/file-lock.js");
	const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
	const { clearCredentialSidecars } = await import("../lib/storage/credential-sidecars.js");
	const { promises: fs } = await import("node:fs");
	const root = await mkdtemp(join(tmpdir(), "probe-fallback-wipe-"));
	const previous = process.env.CODEX_MULTI_AUTH_DIR;
	process.env.CODEX_MULTI_AUTH_DIR = root;
	const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["fixture"] };
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const entered = new Promise<void>(resolve => { started = resolve; });
	let blocked = false, posts = 0;
	const fetcher: typeof fetch = async (_input, init) => {
		if (init?.method !== "POST") {
			if (blocked) { started(); await gate; }
			return new Response("Model ID: `fixture`\nReasoning.effort supports: low.");
		}
		posts++;
		const body = JSON.parse(String(init.body));
		return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier });
	};
	const options = { fetchImpl: fetcher, requireStoredRoute: true };
	const original = locks.withFileTransactionLock;
	let lock: ReturnType<typeof vi.spyOn> | undefined;
	let pending: ReturnType<typeof enrichPersistedApiCapabilities> | undefined;
	try {
		await saveApiRoutes([route]);
		await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
		const before = posts;
		blocked = true;
		lock = vi.spyOn(locks, "withFileTransactionLock").mockImplementation(async (...args) => {
			if (String(args[0]).includes("api-probe-locks")) throw Object.assign(Error("unavailable"), { code: "EACCES" });
			return original(...args);
		});
		pending = enrichPersistedApiCapabilities([{ slug: "fixture" }], false, route, false, options);
		await entered;
		await clearCredentialSidecars();
		await saveApiRoutes([route]);
		release();
		const [result] = await pending;
		expect(result.capability_probe_status).toBeUndefined();
		expect(posts).toBe(before);
		await expect(fs.stat(join(root, "api-capability-probes.json"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		release();
		try { await pending; } finally {
			lock?.mockRestore();
			if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
			else process.env.CODEX_MULTI_AUTH_DIR = previous;
			await removeWithRetry(root, { recursive: true, force: true });
		}
	}
});

it("does not retain paid evidence when a credential changes regions during a probe", async () => {
 const {enrichPersistedApiCapabilities}=await import("../lib/runtime/persisted-api-capabilities.js");
 const {loadApiRoutes}=await import("../lib/api-route-store.js");
 const root=await mkdtemp(join(tmpdir(),"regional-probe-ownership-")), previous=process.env.CODEX_MULTI_AUTH_DIR;
 process.env.CODEX_MULTI_AUTH_DIR=root; let release!:()=>void, entered!:()=>void, posts=0, now=1000;
 const started=new Promise<void>(resolve=>entered=resolve), continueProbe=new Promise<void>(resolve=>release=resolve);
 const fetcher:typeof fetch=async(input,init)=>{if(init?.method!=="POST")return Response.json({data:[{id:"fixture"}]});posts++;entered();await continueProbe;const body=JSON.parse(String(init.body));return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs,output:[{type:"function_call",name:"capability_probe"}]});};
 try {
  const route={id:"fixture",label:"fixture",kind:"api" as const,apiKey:"fixture",enabled:true,priority:9,probeCapabilities:true,visibleModels:["fixture"],accessPrograms:{cyber:["standard"]}};
  await saveApiRoutes([route]);const [owned]=await loadApiRoutes();
  const pending=enrichPersistedApiCapabilities([{slug:"fixture"}],false,owned,false,{fetchImpl:fetcher,now:()=>now,requireStoredRoute:true});
  await started;await saveApiRoutes([{...owned,region:"us"}],undefined,[owned]);release();
  expect((await pending)[0]?.program_checked_at).toBeUndefined();
  now++;const [us]=await loadApiRoutes();await enrichPersistedApiCapabilities([{slug:"fixture"}],false,us,false,{fetchImpl:async(input,init)=>{posts++;return Response.json({error:{code:"rate_limit_exceeded"}},{status:429});},now:()=>now,requireStoredRoute:true});
  expect(posts).toBeGreaterThan(1);
 } finally {if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;await removeWithRetry(root,{recursive:true,force:true});}
});

it("does not reuse global paid evidence or daily claims after switching to US", async () => {
	const { enrichPersistedApiCapabilities } = await import("../lib/runtime/persisted-api-capabilities.js");
	const { loadApiRoutes } = await import("../lib/api-route-store.js");
	const root = await mkdtemp(join(tmpdir(), "regional-paid-evidence-"));
	const previous = process.env.CODEX_MULTI_AUTH_DIR;
	process.env.CODEX_MULTI_AUTH_DIR = root;
	let now = 1000;
	const posts: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		if (init?.method !== "POST") return new Response("missing", { status: 404 });
		posts.push(String(input));
		const body = JSON.parse(String(init.body));
		return Response.json({
			status: "completed",
			reasoning: body.reasoning,
			access_programs: body.access_programs,
			output: [{ type: "function_call", name: "capability_probe" }],
		});
	};
	try {
		const route = {
			id: "fixture",
			label: "fixture",
			kind: "api" as const,
			apiKey: "fixture",
			enabled: true,
			priority: 9,
			probeCapabilities: true,
			visibleModels: ["fixture"],
			accessPrograms: { cyber: ["standard"] },
		};
		await saveApiRoutes([route]);
		const [global] = await loadApiRoutes();
		await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, global, false, {
			fetchImpl: fetcher,
			now: () => now,
			programRefreshBefore: now + 86_400_000,
			requireStoredRoute: true,
		});
		const globalPosts = posts.length;
		await saveApiRoutes([{ ...global, region: "us" }], undefined, [global]);
		now++;
		const [us] = await loadApiRoutes();
		const [refreshed] = await enrichPersistedApiCapabilities([{ slug: "fixture" }], false, us, false, {
			fetchImpl: fetcher,
			now: () => now,
			programRefreshBefore: now + 86_400_000,
			requireStoredRoute: true,
		});
		expect(posts.length).toBeGreaterThan(globalPosts);
		expect(posts.slice(globalPosts).every((url) => url === "https://us.api.openai.com/v1/responses")).toBe(true);
		expect(refreshed.program_checked_at).toBe(now);
	} finally {
		if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = previous;
		await removeWithRetry(root, { recursive: true, force: true });
	}
});
