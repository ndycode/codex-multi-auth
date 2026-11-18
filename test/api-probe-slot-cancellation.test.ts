import { expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveApiRoutes } from "../lib/api-route-store.js";
import { createAutomaticApiCheck } from "../lib/runtime/automatic-api-checks.js";
import { enrichPersistedApiCapabilities, persistedProbeSlotsForTests, resetPersistedApiCapabilitiesForTests } from "../lib/runtime/persisted-api-capabilities.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
it.each(["queued", "granted"])("cancels daily probe %s without leaking shared permits", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "slot-cancel-"));
    vi.stubEnv("CODEX_MULTI_AUTH_DIR", root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, max = 0;
    const posts: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/models"))
            return Response.json({ data: [{ id: "scheduled" }] });
        if (init?.method !== "POST")
            return new Response("missing", { status: 404 });
        const model = JSON.parse(String(init.body)).model as string;
        posts.push(model);
        active++;
        max = Math.max(max, active);
        await gate;
        active--;
        return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
    };
    const route = (id: string) => ({ id, label: id, kind: "api" as const, apiKey: `fixture-${id}`, enabled: true, priority: 0, probeCapabilities: true, visibleModels: [id] });
    const live = (id: string) => enrichPersistedApiCapabilities([{ slug: id }], false, route(id), false, { fetchImpl: fetcher });
    const pending: Promise<unknown>[] = [];
    const stop = new AbortController();
    try {
        pending.push(...Array.from({ length: 4 }, (_, i) => live(`live-${i}`)));
        await vi.waitFor(() => expect(active).toBe(4));
        const baseline = persistedProbeSlotsForTests().waiting;
        await saveApiRoutes([route("scheduled")]);
        let stopped = false;
        const daily = createAutomaticApiCheck(fetcher)(stop.signal).finally(() => { stopped = true; });
        pending.push(daily);
        await vi.waitFor(() => expect(persistedProbeSlotsForTests().waiting).toBeGreaterThan(baseline));
        if (mode === "queued") {
            stop.abort();
            await vi.waitFor(() => expect(stopped).toBe(true));
            expect(active).toBe(4);
            expect(persistedProbeSlotsForTests().waiting).toBe(baseline);
        }
        else {
            // Grant removes the queued abort listener synchronously before resolving
            // its promise. Abort in that exact gap, before the operation continuation.
            const remove = stop.signal.removeEventListener.bind(stop.signal);
            let abortedOnGrant = false;
            vi.spyOn(stop.signal, "removeEventListener").mockImplementation((...args) => {
                remove(...args);
                if (args[0] === "abort" && !abortedOnGrant) {
                    abortedOnGrant = true;
                    stop.abort();
                }
            });
            release();
            await vi.waitFor(() => expect(stopped).toBe(true));
            expect(abortedOnGrant).toBe(true);
        }
        expect(posts).not.toContain("scheduled");
        pending.push(live("later"));
        if (mode === "queued")
            await vi.waitFor(() => expect(persistedProbeSlotsForTests().waiting).toBeGreaterThan(baseline));
        release();
        await Promise.all(pending);
        expect(posts).toContain("later");
        expect(max).toBe(4);
        expect(persistedProbeSlotsForTests()).toEqual({ active: 0, waiting: 0 });
    }
    finally {
        stop.abort();
        release();
        await Promise.allSettled(pending);
        resetPersistedApiCapabilitiesForTests();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await removeWithRetry(root, { recursive: true, force: true });
    }
});
