import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
	discoverModelInventory,
	formatModelInventory,
} from "../lib/runtime/model-discovery-status.js";
import { promises as isolationFs } from "node:fs";
import { tmpdir as isolationTmpdir } from "node:os";
import { join as isolationJoin } from "node:path";
// Inventory writes merge with whatever is already on disk, so every test gets
// its own multi-auth directory instead of the worker's shared one.
let previousMultiAuthDir: string | undefined;
let multiAuthDir: string;
beforeEach(async () => {
	previousMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;
	multiAuthDir = await isolationFs.mkdtemp(isolationJoin(isolationTmpdir(), "model-discovery-"));
	process.env.CODEX_MULTI_AUTH_DIR = multiAuthDir;
});
afterEach(async () => {
	if (previousMultiAuthDir === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
	else process.env.CODEX_MULTI_AUTH_DIR = previousMultiAuthDir;
	await isolationFs.rm(multiAuthDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
describe("model discovery reporting", () => {
	it("reports each credential independently including API-only and hidden IDs", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({ data: [{ id: "exclusive" }, { id: "hidden" }] }),
		);
		const inventory = await discoverModelInventory(
			null,
			[
				{
					id: "fixture",
					label: "API fixture",
					kind: "zdr",
					apiKey: "fixture-secret",
					enabled: true,
					priority: 0,
					visibleModels: ["exclusive"],
				},
			],
			{ fetchImpl: fetcher as typeof fetch, now: () => 1234 },
		);
		expect(inventory.entries[0]).toMatchObject({
			kind: "zdr",
			models: ["exclusive", "hidden"],
			visibleModels: ["exclusive"],
			checkedAt: 1234,
			error: false,
		});
		expect(JSON.stringify(inventory)).not.toContain("fixture-secret");
		expect(formatModelInventory(inventory, 70000).join("\n")).toContain(
			"stale",
		);
	});
	it("shows discovery failures and never advertises guessed availability", async () => {
		const result = await discoverModelInventory(
			null,
			[
				{
					id: "fixture",
					label: "API fixture",
					kind: "api",
					apiKey: "fixture-secret",
					enabled: true,
					priority: 0,
					visibleModels: ["exclusive"],
				},
			],
			{
				fetchImpl: vi.fn(
					async () => new Response("bad", { status: 401 }),
				) as typeof fetch,
			},
		);
		expect(result.entries[0]).toMatchObject({ error: true, models: [] });
		expect(formatModelInventory(result).join("\n")).toContain(
			"discovery failed",
		);
	});
});

it("reports per-model speed, reasoning and advertised access programs without private instructions", async () => {
	const storage = {
		version: 3 as const,
		activeIndex: 0,
		activeIndexByFamily: {},
		accounts: [
			{
				accountId: "fixture-account",
				refreshToken: "fixture-refresh",
				accessToken: "fixture-access",
				expiresAt: Date.now() + 3600000,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
	const inventory = await discoverModelInventory(storage, [], {
		fetchImpl: vi.fn(async () =>
			Response.json({
				models: [
					{
						slug: "fixture-model",
						service_tiers: [
							{
								id: "accelerated",
								name: "Accelerated",
								description: "Fixture speed",
							},
						],
						supported_reasoning_levels: [{ effort: "high" }],
						available_access_programs: { research: ["preview"] },
						model_messages: { instructions_template: "private-instructions" },
					},
				],
			}),
		) as typeof fetch,
	});
	const output = formatModelInventory(inventory).join("\n");
	expect(output).toContain("Accelerated");
	expect(output).toContain("high");
	expect(output).toContain("research:preview");
	expect(JSON.stringify(inventory)).not.toContain("private-instructions");
});

it("refreshes the running native proxy instead of only an independent discovery cache", async () => {
	const { refreshAndPrintModelInventory } = await import(
		"../lib/runtime/model-discovery-status.js"
	);
	const inventory = {
		version: 1 as const,
		checkedAt: 200,
		clientVersion: "1.2.3",
		entries: [],
	};
	const load = vi
		.fn()
		.mockResolvedValueOnce({ ...inventory, checkedAt: 1 })
		.mockResolvedValueOnce(inventory);
	const fetcher = vi.fn(async () =>
		Response.json({ models: [{ slug: "fixture" }] }),
	);
	const log = vi.fn();
	await refreshAndPrintModelInventory(log, {
		getBinding: async () => ({
			running: true,
			state: {
				nativeOpenai: true,
				baseUrl: "http://127.0.0.1:12345",
				clientApiKey: "fixture-token",
			},
		}),
		fetchImpl: fetcher as typeof fetch,
		loadInventory: load,
		now: () => 100,
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(String(fetcher.mock.calls[0]?.[0])).toBe(
		"http://127.0.0.1:12345/models?refresh_capabilities=1&client_version=1.2.3",
	);
	expect(
		new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
	).toBe("Bearer fixture-token");
	expect(log.mock.calls.flat().join("\n")).toContain(
		"Running proxy model catalog refreshed",
	);
});
it.each(["https://remote.invalid", "http://127.0.0.1:12345/redirect"])(
	"never sends the local binding secret to an invalid refresh target %s",
	async (baseUrl) => {
		const { refreshAndPrintModelInventory } = await import(
			"../lib/runtime/model-discovery-status.js"
		);
		const fetcher = vi.fn();
		const log = vi.fn();
		await refreshAndPrintModelInventory(log, {
			getBinding: async () => ({
				running: true,
				state: { nativeOpenai: true, baseUrl, clientApiKey: "fixture-token" },
			}),
			fetchImpl: fetcher,
			loadInventory: async () => null,
		});
		expect(fetcher).not.toHaveBeenCalled();
		expect(log.mock.calls.flat().join("\n")).toContain("failed");
	},
);

it("serializes status writes so a slow older snapshot cannot replace fresh probe results", async () => {
	const { promises: fs } = await import("node:fs");
	const { saveModelInventory, loadModelInventory } = await import(
		"../lib/runtime/model-discovery-status.js"
	);
	const original = fs.writeFile.bind(fs);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		if (String(args[1]).includes('"checkedAt":1,')) {
			entered();
			await gate;
		}
		return original(...args);
	});
	try {
		const older = saveModelInventory({ version: 1, checkedAt: 1, entries: [] });
		await started;
		const newer = saveModelInventory({ version: 1, checkedAt: 2, entries: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		release();
		await Promise.all([older, newer]);
		expect((await loadModelInventory())?.checkedAt).toBe(2);
	} finally {
		release();
		spy.mockRestore();
	}
});

it("discovers each enabled workspace independently without changing the stored binding", async () => {
 const storage = { version: 3 as const, activeIndex: 0, accounts: [{
  recordId: "fixture-record", accountId: "primary", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now()+3600000, addedAt: 1, lastUsed: 1,
  currentWorkspaceIndex: 1, workspaces: [{id:"primary",enabled:true},{id:"secondary",enabled:true},{id:"disabled",enabled:false}],
 }] };
 const seen: string[] = [];
 const inventory = await discoverModelInventory(storage, [], {fetchImpl: (async (_url, init) => {
  const id = new Headers(init?.headers).get("chatgpt-account-id")!; seen.push(id);
  return Response.json({models:[{slug:`model-${id}`} ]});
 }) as typeof fetch});
 expect(seen.sort()).toEqual(["primary","secondary"]);
 expect(inventory.entries).toHaveLength(3);
 expect(inventory.entries[0]).toMatchObject({models:["model-primary"],routable:true});
 expect(inventory.entries[1]).toMatchObject({models:["model-secondary"],routable:true});
 expect(inventory.entries[2]).toMatchObject({enabled:false,models:[]});
 expect(storage.accounts[0].accountId).toBe("primary");
 expect(storage.accounts[0].currentWorkspaceIndex).toBe(1);
 expect(JSON.stringify(inventory)).not.toContain("fixture-access");
});

it("highlights changes by stable scope and never treats failed discovery as lost access", async () => {
 const { withInventoryChanges } = await import("../lib/runtime/model-discovery-status.js");
 const entry = {id:"scope",label:"Account 1",kind:"oauth" as const,enabled:true,error:false,checkedAt:1,models:["shared"],visibleModels:["shared"],entitlements:[{model:"shared",serviceTiers:[],reasoningLevels:["low"],accessPrograms:[]}]};
 const before = {version:1 as const,checkedAt:1,entries:[entry]};
 const current = {version:1 as const,checkedAt:2,entries:[{...entry,label:"Account 2",checkedAt:2,models:["shared","novel"],entitlements:[{...entry.entitlements[0],reasoningLevels:["low","ultra"]}]}]};
 const changed = withInventoryChanges(current,before);
 expect(changed.entries[0].changes).toMatchObject({added:["novel"],removed:[],capabilities:["shared"]});
 expect(withInventoryChanges(current,null).entries[0].changes).toBeUndefined();
 const failed = withInventoryChanges({...current,checkedAt:3,entries:[{...current.entries[0],error:true,models:[],entitlements:[]}]},changed);
 expect(failed.entries[0].changes?.removed).toEqual([]);
 const recovered = withInventoryChanges({...current,checkedAt:4},failed);
 expect(recovered.entries[0].changes?.added).toEqual(["novel"]);
 expect(recovered.entries[0].changes?.observedAt).toBe(2);
});

it("summarizes model and capability differences with incomplete coverage marked unknown", () => {
 const base = {kind:"oauth" as const,enabled:true,error:false,checkedAt:1,visibleModels:[]};
 const inventory = {version:1 as const,checkedAt:1,entries:[
  {...base,id:"a",label:"Account 1 / Workspace 1",models:["shared","exclusive"],entitlements:[{model:"shared",serviceTiers:[{id:"priority",name:"Fast"}],reasoningLevels:["high"],accessPrograms:[]}]},
  {...base,id:"b",label:"Account 1 / Workspace 2",models:["shared"],entitlements:[{model:"shared",serviceTiers:[],reasoningLevels:["high"],accessPrograms:[]}]},
 ]};
 const lines = formatModelInventory(inventory,1).join("\n");
 expect(lines).toContain("Only on Account 1 / Workspace 1: exclusive");
 expect(lines).toContain("shared speed priority: Account 1 / Workspace 1");
 const incomplete = formatModelInventory({...inventory,entries:[...inventory.entries,{...base,id:"c",label:"Account 2",models:[],error:true}]},1).join("\n");
 expect(incomplete).toContain("incomplete");
 expect(incomplete).not.toContain("Only on");
});

it("styles inventory meaningfully without changing plain output or inventory data", async () => {
 const {setUiRuntimeOptions,resetUiRuntimeOptions,getUiRuntimeOptions}=await import("../lib/ui/runtime.js");
 const {stripVTControlCharacters}=await import("node:util");
 const inventory={version:1 as const,checkedAt:1000,entries:[{label:"API fixture",kind:"api" as const,enabled:true,error:true,checkedAt:1000,models:[],visibleModels:[],changes:{observedAt:1000,added:["fixture-model"],removed:[],capabilities:[]}}]};
 const before=JSON.stringify(inventory);
 vi.stubEnv("FORCE_COLOR","1");setUiRuntimeOptions({});
 try {
  const output=formatModelInventory(inventory,2000).join("\n");
  expect(output).toContain(getUiRuntimeOptions().theme.colors.heading+"Model discovery");
  expect(output).toContain(getUiRuntimeOptions().theme.colors.success+"  NEW");
  expect(output).toContain(getUiRuntimeOptions().theme.colors.danger+"discovery failed");
  vi.stubEnv("FORCE_COLOR","0");
  expect(stripVTControlCharacters(output)).toBe(formatModelInventory(inventory,2000).join("\n"));
  vi.stubEnv("FORCE_COLOR","");vi.stubEnv("NO_COLOR","1");
  expect(formatModelInventory(inventory,2000).join("\n")).not.toContain("\x1b");
  expect(JSON.stringify(inventory)).toBe(before);
 } finally {vi.unstubAllEnvs();resetUiRuntimeOptions();}
});
it("retains the API comparison baseline through an invalid configuration without advertising its models",async()=>{
 const {withInventoryChanges}=await import('../lib/runtime/model-discovery-status.js');
 const previous={version:1 as const,checkedAt:1,entries:[{id:'private-fixture',label:'API fixture',kind:'zdr' as const,enabled:true,error:false,checkedAt:1,models:['old-model'],visibleModels:['old-model']}]};
 const unavailable=withInventoryChanges({version:1,checkedAt:2,apiConfigurationUnavailable:true,entries:[]},previous);
 expect(unavailable.entries[0]).toMatchObject({error:true,visibleModels:[],lastSuccessful:{models:['old-model']}});
 const restored=withInventoryChanges({...previous,checkedAt:3,entries:[{...previous.entries[0]!,models:['new-model']}]},unavailable);
 expect(restored.entries[0]?.changes).toMatchObject({added:['new-model'],removed:['old-model']});
});

it("reports a failed capability refresh to the focused CLI caller", async () => {
 const {refreshAndPrintModelInventory} = await import('../lib/runtime/model-discovery-status.js');
 expect(await refreshAndPrintModelInventory(vi.fn(), {
  getBinding:async()=>({running:true,state:{nativeOpenai:true,baseUrl:'http://127.0.0.1:12345',clientApiKey:'fixture-token'}}),
  fetchImpl:vi.fn(async()=>new Response(null,{status:503})),loadInventory:async()=>null,
 })).toBe(false);
});

it("serializes independent inventory writers and preserves both successful baselines",async()=>{
 const {promises:fs}=await import("node:fs");
 const first=await import("../lib/runtime/model-discovery-status.js");
 vi.resetModules();const second=await import("../lib/runtime/model-discovery-status.js");
 const originalWrite=fs.writeFile.bind(fs),originalRename=fs.rename.bind(fs);
 let release!:()=>void,entered!:()=>void,checkpoint!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),overlap=new Promise<void>(r=>checkpoint=r);
 let parked=false;
 const write=vi.spyOn(fs,"writeFile").mockImplementation(async(...args)=>{
  if(String(args[1]).startsWith('{"version":1,"checkedAt":101,')){parked=true;entered();await gate;}
  await originalWrite(...args);
  if(String(args[1]).startsWith('{"version":1,"checkedAt":102,'))checkpoint();
 });
 const rename=vi.spyOn(fs,"rename").mockImplementation(async(...args)=>{if(parked&&String(args[1]).endsWith("model-discovery.json.write-lock"))checkpoint();return originalRename(...args);});
 const entry=(id:string,ok:boolean)=>({id,label:id,kind:"oauth" as const,enabled:true,error:!ok,checkedAt:ok?101:102,models:ok?[id]:[],visibleModels:[]});
 let pending:Promise<unknown>|undefined;
 try {
  const a=first.saveModelInventory({version:1,checkedAt:101,entries:[entry("writer-a",true),entry("writer-b",false)]});
  await started;
  const b=second.saveModelInventory({version:1,checkedAt:102,entries:[entry("writer-a",false),entry("writer-b",true)]});
  pending=Promise.all([a,b]);await overlap;await new Promise(r=>setImmediate(r));release();await pending;
  const result=await second.loadModelInventory();
  expect(result?.entries.map(e=>e.lastSuccessful?.models)).toEqual([["writer-a"],["writer-b"]]);
 }finally{release();await pending;write.mockRestore();rename.mockRestore();}
});

it("honours the persisted 15-minute probe cache across fresh CLI processes unless probes are forced", async () => {
 const { promises: fs } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = await fs.mkdtemp(join(tmpdir(), "probe-cache-"));
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
 try {
  let probes = 0;
  const fetcher = vi.fn(async (url: string | URL) => {
   const href = String(url);
   if (href.endsWith("/v1/responses")) { probes++; return Response.json({ error: { message: "no" } }, { status: 500 }); }
   if (href.includes("/v1/models")) return Response.json({ data: [{ id: "fixture-model" }] });
   return new Response("missing", { status: 404 });
  });
  const route = { id: "fixture", label: "API fixture", kind: "api" as const, apiKey: "fixture-secret", enabled: true, priority: 0, visibleModels: ["fixture-model"], probeCapabilities: true };
  let clock = 1_000_000;
  const run = async (forceProbes?: boolean) => {
   vi.resetModules();
   const fresh = await import("../lib/runtime/model-discovery-status.js");
   await fresh.discoverModelInventory(null, [route], { fetchImpl: fetcher as typeof fetch, now: () => clock, updateApiDiscovery: async (r) => r, persistProbes: true, forceProbes });
  };
  await run();
  const first = probes;
  expect(first).toBeGreaterThan(0);
  clock += 60_000;
  await run();
  expect(probes).toBe(first);
  expect(await fs.readFile(join(dir, "api-capability-probes.json"), "utf8")).not.toContain("fixture-secret");
  await run(true);
  expect(probes).toBe(first * 2);
  clock += 16 * 60_000;
  await run();
  expect(probes).toBe(first * 3);
 } finally {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
 }
});

it("asks a running proxy to force paid probes only for an explicit capability check", async () => {
 const { refreshAndPrintModelInventory } = await import("../lib/runtime/model-discovery-status.js");
 const urls: string[] = [];
 for (const forceProbes of [false, true]) {
  const inventory = { version: 1 as const, checkedAt: 200, entries: [] };
  const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(inventory);
  await refreshAndPrintModelInventory(vi.fn(), {
   getBinding: async () => ({ running: true, state: { nativeOpenai: true, baseUrl: "http://127.0.0.1:12345", clientApiKey: "fixture-token" } }),
   fetchImpl: (async (url: URL) => { urls.push(String(url)); return Response.json({ models: [] }); }) as unknown as typeof fetch,
   loadInventory: load, now: () => 100, forceProbes,
  });
 }
 expect(urls).toEqual(["http://127.0.0.1:12345/models?refresh_capabilities=1", "http://127.0.0.1:12345/models?refresh_capabilities=1&force_probes=1"]);
});

it("merges concurrent checks' probe results instead of replacing the shared cache", async () => {
 const { promises: fs } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = await fs.mkdtemp(join(tmpdir(), "probe-merge-"));
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
 try {
  let probes = 0;
  const fetcher = vi.fn(async (url: string | URL) => {
   const href = String(url);
   if (href.endsWith("/v1/responses")) { probes++; return Response.json({ error: { message: "no" } }, { status: 500 }); }
   if (href.includes("/v1/models")) return Response.json({ data: [{ id: "fixture-model" }] });
   return new Response("missing", { status: 404 });
  });
  const route = (id: string) => ({ id, label: id, kind: "api" as const, apiKey: `key-${id}`, enabled: true, priority: 0, visibleModels: ["fixture-model"], probeCapabilities: true });
  vi.resetModules();
  const a = await import("../lib/runtime/model-discovery-status.js");
  vi.resetModules();
  const b = await import("../lib/runtime/model-discovery-status.js");
  const options = { fetchImpl: fetcher as typeof fetch, now: () => 1_000_000, updateApiDiscovery: async (r: never) => r, persistProbes: true };
  // Both start from the same (empty) cache and probe different credentials.
  await Promise.all([a.discoverModelInventory(null, [route("one")], options), b.discoverModelInventory(null, [route("two")], options)]);
  const cached = JSON.parse(await fs.readFile(join(dir, "api-capability-probes.json"), "utf8")).entries;
  expect(cached).toHaveLength(2);
  const before = probes;
  vi.resetModules();
  const c = await import("../lib/runtime/model-discovery-status.js");
  await c.discoverModelInventory(null, [route("one"), route("two")], options);
  expect(probes).toBe(before);
 } finally {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
 }
});
