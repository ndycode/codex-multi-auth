import { expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureApiRouteCapabilityEpoch, getApiRoutesPath, loadApiRoutes, updateApiModelDiscovery } from "../lib/api-route-store.js";
import { discoverModelInventory } from "../lib/runtime/model-discovery-status.js";
import { runAutomaticApiChecks } from "../lib/runtime/automatic-api-checks.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture", enabled: true, priority: 0, probeCapabilities: true, visibleModels: ["gpt-a", "gpt-b", "gpt-c"], knownModels: ["gpt-a", "gpt-b", "gpt-c"] };
it("allows every model in a forced legacy discovery despite concurrent migration", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "epoch-concurrent-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const posts = new Set<string>();
    try {
        await fs.writeFile(getApiRoutesPath(), JSON.stringify({ version: 1, routes: [route] }));
        const fetcher: typeof fetch = async (input, init) => { if (init?.method === "POST") {
            const body = JSON.parse(String(init.body));
            posts.add(body.model);
            return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier });
        } if (String(input).endsWith("/models"))
            return Response.json({ data: route.knownModels.map(id => ({ id })) }); return new Response("missing", { status: 404 }); };
        await discoverModelInventory(null, [route], { fetchImpl: fetcher, persistProbes: true, forceProbes: true, updateApiDiscovery: updateApiModelDiscovery });
        expect([...posts].sort()).toEqual(route.visibleModels);
    }
    finally {
        vi.restoreAllMocks();
        if (previous === undefined)
            delete process.env.CODEX_MULTI_AUTH_DIR;
        else
            process.env.CODEX_MULTI_AUTH_DIR = previous;
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it.each([false, true])("isolates preparation failure from later routes while respecting cancellation=%s", async (cancel) => {
    const root = await fs.mkdtemp(join(tmpdir(), "epoch-prepare-")), signal = new AbortController(), check = vi.fn(async () => { });
    try {
        await runAutomaticApiChecks({ path: join(root, "history.json"), signal: signal.signal, loadRoutes: async () => [route, { ...route, id: "second" }], prepareRoute: async (value) => { if (value.id === route.id) {
                if (cancel)
                    signal.abort();
                throw Error("migration unavailable");
            } return value; }, check });
        expect(check).toHaveBeenCalledTimes(cancel ? 0 : 1);
        if (!cancel)
            expect(check.mock.calls[0][0].id).toBe("second");
    }
    finally {
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
it("serializes competing legacy migrations before reading their canonical snapshot", async () => {
    const transactions = await import("../lib/storage/transactions.js");
    const root = await fs.mkdtemp(join(tmpdir(), "epoch-barrier-")), previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    let release!: () => void, entered!: () => void, queued!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r), secondQueued = new Promise<void>(r => queued = r);
    const rename = fs.rename.bind(fs), storage = transactions.withStorageLock;
    let calls = 0, first = true;
    let a: ReturnType<typeof ensureApiRouteCapabilityEpoch> | undefined, b: typeof a;
    try {
        await fs.writeFile(getApiRoutesPath(), JSON.stringify({ version: 1, routes: [route] }));
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => { if (first && String(args[1]) === getApiRoutesPath()) {
            first = false;
            entered();
            await gate;
        } return rename(...args); });
        vi.spyOn(transactions, "withStorageLock").mockImplementation(operation => { calls++; if (calls === 2)
            queued(); return storage(operation); });
        a = ensureApiRouteCapabilityEpoch(route);
        await started;
        b = ensureApiRouteCapabilityEpoch(route);
        await secondQueued;
        release();
        const [one, two] = await Promise.all([a, b]);
        expect(one?.capabilityEpoch).toEqual(expect.any(String));
        expect(two?.capabilityEpoch).toBe(one?.capabilityEpoch);
        expect((await loadApiRoutes())[0].capabilityEpoch).toBe(one?.capabilityEpoch);
    }
    finally {
        release();
        try {
            await Promise.allSettled([a, b]);
        }
        finally {
            vi.restoreAllMocks();
            if (previous === undefined)
                delete process.env.CODEX_MULTI_AUTH_DIR;
            else
                process.env.CODEX_MULTI_AUTH_DIR = previous;
            await removeWithRetry(root, { recursive: true, force: true });
        }
    }
});
it("coordinates a live legacy discovery with the daily production check", async () => {
    const transactions = await import("../lib/storage/transactions.js");
    const { createAutomaticApiCheck } = await import("../lib/runtime/automatic-api-checks.js");
    const { loadModelInventory } = await import("../lib/runtime/model-discovery-status.js");
    const root = await fs.mkdtemp(join(tmpdir(), "epoch-live-daily-"));
    const previous = process.env.CODEX_MULTI_AUTH_DIR;
    process.env.CODEX_MULTI_AUTH_DIR = root;
    const later = { ...route, id: "later", label: "later", apiKey: "later-fixture" };
    let release!: () => void, entered!: () => void, queued!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { queued = resolve; });
    const rename = fs.rename.bind(fs), storage = transactions.withStorageLock;
    let publishing = false, parked = false;
    const requests = new Map<string, number>();
    let live: Promise<unknown> | undefined, daily: Promise<unknown> | undefined;
    try {
        await fs.writeFile(getApiRoutesPath(), JSON.stringify({ version: 1, routes: [route, later] }));
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
            if (!parked && String(args[1]) === getApiRoutesPath()) {
                parked = true; publishing = true; entered(); await gate; publishing = false;
            }
            return rename(...args);
        });
        vi.spyOn(transactions, "withStorageLock").mockImplementation(action => {
            if (publishing) queued();
            return storage(action);
        });
        const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                const key = `${new Headers(init.headers).get("authorization")}:${body.model}:${JSON.stringify(body)}`;
                requests.set(key, (requests.get(key) ?? 0) + 1);
                return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
            }
            if (String(input).endsWith("/models")) return Response.json({ data: route.visibleModels.map(id => ({ id })) });
            return new Response("missing", { status: 404 });
        });
        live = discoverModelInventory(null, [route], { fetchImpl: network, persistProbes: true, updateApiDiscovery: updateApiModelDiscovery });
        await started;
        daily = createAutomaticApiCheck()(new AbortController().signal);
        await waiting;
        release();
        await Promise.all([live, daily]);
        const inventory = await loadModelInventory();
        expect(inventory?.entries.map(entry => entry.label).sort()).toEqual(["fixture", "later"]);
        for (const credential of ["fixture", "later-fixture"]) for (const model of route.visibleModels) {
            expect([...requests.keys()].some(key => key.startsWith(`Bearer ${credential}:${model}:`))).toBe(true);
        }
        expect([...requests.values()].every(count => count === 1)).toBe(true);
        const before = [...requests.entries()];
        await createAutomaticApiCheck()(new AbortController().signal);
        expect([...requests.entries()]).toEqual(before);
        expect(Object.keys(JSON.parse(await fs.readFile(join(root, "automatic-api-checks.json"), "utf8")))).toHaveLength(2);
    } finally {
        release();
        try { await Promise.allSettled([live, daily]); } finally {
            vi.restoreAllMocks();
            if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
            else process.env.CODEX_MULTI_AUTH_DIR = previous;
            await removeWithRetry(root, { recursive: true, force: true });
        }
    }
});
