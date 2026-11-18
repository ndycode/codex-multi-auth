import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountManager } from "../lib/accounts.js";
import { saveApiRoutes } from "../lib/api-route-store.js";
import { startRuntimeRotationProxy } from "../lib/runtime-rotation-proxy.js";
import { createAutomaticApiCheck } from "../lib/runtime/automatic-api-checks.js";
import { loadModelInventory } from "../lib/runtime/model-discovery-status.js";
import { resetPersistedApiCapabilitiesForTests } from "../lib/runtime/persisted-api-capabilities.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

afterEach(() => { vi.restoreAllMocks(); resetPersistedApiCapabilitiesForTests(); });
it.each(["live", "daily", "scheduled"])("uses the configured raw transport for %s capability discovery", async mode => {
 const root = await mkdtemp(join(tmpdir(), "capability-custom-fetch-"));
 const previous = process.env.CODEX_MULTI_AUTH_DIR;
 process.env.CODEX_MULTI_AUTH_DIR = root;
 const clientFetch = globalThis.fetch;
 const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Unexpected global egress"));
 let docs = 0, probes = 0;
 const upstream: typeof fetch = vi.fn(async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://developers.openai.com/")) {
   docs++;
   expect(new Headers(init?.headers).has("authorization")).toBe(false);
   return new Response("Model ID: `fixture`\nReasoning.effort supports: low, high.");
  }
  if (init?.method !== "POST") return Response.json({ data: [{ id: "fixture" }], models: [] });
  probes++;
  expect(url).toBe("https://api.openai.com/v1/responses");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-key");
  const body = JSON.parse(String(init.body));
  expect(body.store).toBe(false);
  return Response.json({ status: "completed", reasoning: body.reasoning, service_tier: body.service_tier,
   output: [{ type: "function_call", name: "capability_probe" }] });
 });
 const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 9, probeCapabilities: true, visibleModels: ["fixture"], knownModels: ["fixture"] };
 const manager = new AccountManager(undefined, { version: 3, activeIndex: 0, accounts: [] });
 let proxy: Awaited<ReturnType<typeof startRuntimeRotationProxy>> | undefined;
 try {
  await saveApiRoutes([route]);
  if (mode === "live") {
   proxy = await startRuntimeRotationProxy({ accountManager: manager, fetchImpl: upstream, nativeOpenai: true, clientApiKey: "local-fixture" });
   const response = await clientFetch(`${proxy.baseUrl}/models?refresh_capabilities=1`, { headers: { authorization: "Bearer local-fixture" } });
   expect(response.status).toBe(200);
   const catalog = await response.json();
   const model = catalog.models.find((value: { slug: string }) => value.slug === "api/fixture");
   expect(model.capability_probe_status).toMatchObject({ responses: "verified" });
  } else {
   if (mode === "scheduled") {
    const automatic = await import("../lib/runtime/automatic-api-checks.js");
    let scheduled: Parameters<typeof automatic.startAutomaticApiChecks>[0] | undefined;
    vi.spyOn(automatic, "startAutomaticApiChecks").mockImplementation(run => {
     scheduled = run;
     return { stop: async () => {} };
    });
    vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
    proxy = await startRuntimeRotationProxy({ fetchImpl: upstream, nativeOpenai: true, clientApiKey: "local-fixture" });
    expect(scheduled).toBeDefined();
    await scheduled!(new AbortController().signal);
   } else await createAutomaticApiCheck(upstream)(new AbortController().signal);
   expect((await loadModelInventory())?.entries[0].entitlements?.[0]?.probes).toMatchObject({ responses: "verified" });
  }
  expect(docs).toBeGreaterThan(0);
  expect(probes).toBeGreaterThan(0);
  expect(globalFetch).not.toHaveBeenCalled();
 } finally {
  await proxy?.close();
  await manager.flushPendingSave();
  if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
  else process.env.CODEX_MULTI_AUTH_DIR = previous;
  await removeWithRetry(root, { recursive: true, force: true });
 }
});
