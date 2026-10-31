import { saveApiRoutes } from "../lib/api-route-store.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
	discoverModelInventory,
	formatModelInventory,
} from "../lib/runtime/model-discovery-status.js";
import { promises as isolationFs } from "node:fs";
import { tmpdir as isolationTmpdir } from "node:os";
import { join as isolationJoin } from "node:path";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
// Inventory writes merge with whatever is already on disk, so every test gets
// its own multi-auth directory instead of the worker's shared one.
let previousMultiAuthDir: string | undefined;
let multiAuthDir: string;
it("drains inventory writes before resetting their test queue", async () => {
	const inventory = await import("../lib/runtime/model-discovery-status.js");
	const locks = await import("../lib/storage/file-lock.js");
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { entered = resolve; });
	const original = locks.withFileTransactionLock;
	const lock = vi.spyOn(locks, "withFileTransactionLock").mockImplementationOnce(async (...args) => {
		entered();
		await gate;
		return original(...args);
	});
	let first: Promise<void> | undefined;
	let second: Promise<void> | undefined;
	try {
		first = inventory.saveModelInventory({ version: 1, checkedAt: 1, entries: [] });
		await started;
		let resetFinished = false;
		const reset = inventory.resetModelInventoryWritesForTests().then(() => { resetFinished = true; });
		second = inventory.saveModelInventory({ version: 1, checkedAt: 2, entries: [] });
		await Promise.resolve();
		expect(resetFinished).toBe(false);
		release();
		await Promise.all([first, second, reset]);
		expect((await inventory.loadModelInventory())?.checkedAt).toBe(2);
		await inventory.resetModelInventoryWritesForTests();
	} finally {
		release();
		await Promise.allSettled([first, second]);
		lock.mockRestore();
	}
});
beforeEach(async () => {
	previousMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;
	multiAuthDir = await isolationFs.mkdtemp(isolationJoin(isolationTmpdir(), "model-discovery-"));
	process.env.CODEX_MULTI_AUTH_DIR = multiAuthDir;
});
afterEach(async () => {
	const { resetModelInventoryWritesForTests } = await import("../lib/runtime/model-discovery-status.js");
	await resetModelInventoryWritesForTests();
	if (previousMultiAuthDir === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
	else process.env.CODEX_MULTI_AUTH_DIR = previousMultiAuthDir;
	await removeWithRetry(multiAuthDir, { recursive: true, force: true });
});
describe("model discovery reporting", () => {
	it.each(["api", "zdr", "psp"] as const)("labels %s programs as local configuration", async (kind) => {
		const inventory = await discoverModelInventory(null, [{
			id: "fixture", label: "API fixture", kind, apiKey: "fixture-secret",
			enabled: true, priority: 0, visibleModels: ["configured", "unconfigured"],
			modelAccessPrograms: { configured: { cyber: ["standard", "daybreak_blue"] } },
		}], { fetchImpl: vi.fn(async () => Response.json({ data: [
			{ id: "configured" }, { id: "unconfigured" },
		] })), now: () => 1234 });
		const output = formatModelInventory(inventory, 1234).join("\n");
		expect(output).toContain("configured programs=cyber:standard, cyber:daybreak_blue");
		expect(output).toContain("configured programs=none");
		expect(output).not.toContain("programs=not advertised");
	});
	it("preserves upstream program wording for OAuth catalogs", () => {
		const output = formatModelInventory({ version: 1, checkedAt: 1234, entries: [{
			id: "fixture", label: "OAuth fixture", kind: "oauth", enabled: true,
			error: false, checkedAt: 1234, models: ["fixture"], visibleModels: ["fixture"],
			entitlements: [{ model: "fixture", serviceTiers: [], reasoningLevels: [], accessPrograms: [] }],
		}] }, 1234).join("\n");
		expect(output).toContain("programs=not advertised");
		expect(output).not.toContain("configured programs=");
	});
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

it("discovers only the selected enabled workspace without changing the stored binding", async () => {
 const storage = { version: 3 as const, activeIndex: 0, accounts: [{
  recordId: "fixture-record", accountId: "primary", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now()+3600000, addedAt: 1, lastUsed: 1,
  currentWorkspaceIndex: 1, workspaces: [{id:"primary",enabled:true},{id:"secondary",enabled:true},{id:"disabled",enabled:false}],
 }] };
 const seen: string[] = [];
 const inventory = await discoverModelInventory(storage, [], {fetchImpl: (async (_url, init) => {
  const id = new Headers(init?.headers).get("chatgpt-account-id")!; seen.push(id);
  return Response.json({models:[{slug:`model-${id}`} ]});
 }) as typeof fetch});
 expect(seen).toEqual(["secondary"]);
 expect(inventory.entries).toHaveLength(3);
 expect(inventory.entries[0]).toMatchObject({models:[],routable:false});
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
  fetchImpl:vi.fn(async()=>new Response(null,{status:503})),loadInventory:async()=>null,detectClientVersion:async()=>null,
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
  await saveApiRoutes([route]);
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
   loadInventory: load, now: () => 100, forceProbes, detectClientVersion: async () => null,
  });
 }
 expect(urls).toEqual(["http://127.0.0.1:12345/models?refresh_capabilities=1", "http://127.0.0.1:12345/models?refresh_capabilities=1&force_probes=1"]);
});

it("sends the installed codex version for direct discovery and stores it for the next check", async () => {
	const { refreshAndPrintModelInventory, loadModelInventory } = await import(
		"../lib/runtime/model-discovery-status.js"
	);
	const storage = {
		version: 3 as const,
		activeIndex: 0,
		activeIndexByFamily: {},
		accounts: [
			{
				accountId: "acct-1",
				refreshToken: "rt",
				accessToken: "at",
				expiresAt: Date.now() + 3600_000,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
	const catalogUrls: string[] = [];
	const fetchImpl = (async (url: URL) => {
		const u = new URL(String(url));
		if (u.pathname.endsWith("/codex/models")) {
			catalogUrls.push(u.toString());
			if (!u.searchParams.get("client_version")) {
				return Response.json(
					{ detail: [{ loc: ["query", "client_version"], msg: "Field required" }] },
					{ status: 400 },
				);
			}
			return Response.json({ models: [{ slug: "model-a" }] });
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	const ok = await refreshAndPrintModelInventory(vi.fn(), {
		getBinding: async () => ({ running: false, state: null }),
		fetchImpl,
		loadInventory: async () => null,
		loadAccounts: async () => storage,
		loadApiRoutes: async () => [],
		detectClientVersion: async () => "0.160.1",
	});
	expect(ok).toBe(true);
	expect(catalogUrls).toHaveLength(1);
	expect(catalogUrls[0]).toContain("client_version=0.160.1");
	// The detected version is persisted so the next check reuses it instead of
	// re-detecting the installed client.
	expect((await loadModelInventory())?.clientVersion).toBe("0.160.1");
});

it("prefers the stored inventory version over a fresh detection", async () => {
	const { refreshAndPrintModelInventory } = await import(
		"../lib/runtime/model-discovery-status.js"
	);
	const urls: string[] = [];
	const detect = vi.fn(async () => "9.9.9");
	const load = vi
		.fn()
		.mockResolvedValueOnce({ version: 1, checkedAt: 1, clientVersion: "1.2.3", entries: [] })
		.mockResolvedValueOnce({ version: 1, checkedAt: 200, entries: [] });
	await refreshAndPrintModelInventory(vi.fn(), {
		getBinding: async () => ({
			running: true,
			state: { nativeOpenai: true, baseUrl: "http://127.0.0.1:12345", clientApiKey: "k" },
		}),
		fetchImpl: (async (url: URL) => {
			urls.push(String(url));
			return Response.json({ models: [] });
		}) as unknown as typeof fetch,
		loadInventory: load,
		detectClientVersion: detect,
		now: () => 100,
	});
	expect(detect).not.toHaveBeenCalled();
	expect(urls[0]).toBe(
		"http://127.0.0.1:12345/models?refresh_capabilities=1&client_version=1.2.3",
	);
});

it("forwards the detected codex version to a running proxy refresh when none is stored", async () => {
	const { refreshAndPrintModelInventory } = await import(
		"../lib/runtime/model-discovery-status.js"
	);
	const urls: string[] = [];
	const load = vi
		.fn()
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce({ version: 1, checkedAt: 200, entries: [] });
	await refreshAndPrintModelInventory(vi.fn(), {
		getBinding: async () => ({
			running: true,
			state: { nativeOpenai: true, baseUrl: "http://127.0.0.1:12345", clientApiKey: "k" },
		}),
		fetchImpl: (async (url: URL) => {
			urls.push(String(url));
			return Response.json({ models: [] });
		}) as unknown as typeof fetch,
		loadInventory: load,
		detectClientVersion: async () => "0.160.1",
		now: () => 100,
	});
	expect(urls).toEqual([
		"http://127.0.0.1:12345/models?refresh_capabilities=1&client_version=0.160.1",
	]);
});

it("forwards client_version to the models catalog when discoverModelInventory is given one", async () => {
	const storage = {
		version: 3 as const,
		activeIndex: 0,
		activeIndexByFamily: {},
		accounts: [
			{
				accountId: "acct-1",
				refreshToken: "rt",
				accessToken: "at",
				expiresAt: Date.now() + 3600_000,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
	const urls: string[] = [];
	await discoverModelInventory(storage, [], {
		clientVersion: "0.160.1",
		fetchImpl: (async (url: URL) => {
			urls.push(String(url));
			return Response.json({ models: [{ slug: "model-a" }] });
		}) as unknown as typeof fetch,
	});
	expect(urls[0]).toContain("client_version=0.160.1");
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
  await saveApiRoutes([route("one"), route("two")]);
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

it("persists daily program evidence separately from the shorter capability cache",async()=>{
 let now=1000;
 let programRequests=0;
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["daybreak_blue"]}};
 const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs)programRequests++;
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 await saveApiRoutes([route]);
 const options={fetchImpl:fetcher,now:()=>now,persistProbes:true,updateApiDiscovery:async()=>route};
 await discoverModelInventory(null,[route],options);
 expect(programRequests).toBe(1);
 now+=900001;
 const inventory=await discoverModelInventory(null,[route],options);
 expect(programRequests).toBe(1);
 expect(formatModelInventory(inventory,now).join("\n")).toContain("program:cyber:daybreak_blue=verified");
});

it("atomically merges partial inventories without losing OAuth or other API rows",async()=>{
 const {saveModelInventory,loadModelInventory}=await import("../lib/runtime/model-discovery-status.js");
 const entry=(id:string,kind:"api"|"oauth",checkedAt:number)=>({id,label:id,kind,checkedAt,enabled:true,error:false,models:[id],visibleModels:[id]});
 await saveModelInventory({version:1,checkedAt:100,clientVersion:"1.2.3",entries:[entry("oauth","oauth",100),entry("a","api",100),entry("b","api",100)]});
 await Promise.all([
 saveModelInventory({version:1,checkedAt:200,entries:[entry("a","api",200)]},{mergeEntries:true}),
 saveModelInventory({version:1,checkedAt:300,entries:[entry("b","api",300)]},{mergeEntries:true}),
 ]);
 const result=await loadModelInventory();
 expect(result?.entries.map(e=>[e.id,e.checkedAt]).sort()).toEqual([["a",200],["b",300],["oauth",100]]);
 expect(result?.clientVersion).toBe("1.2.3");
 await saveModelInventory({version:1,checkedAt:150,entries:[entry("a","api",150)]},{mergeEntries:true});
 expect((await loadModelInventory())?.entries.find(e=>e.id==="a")?.checkedAt).toBe(200);
});

it.each([429,403])("preserves the daily program cache through unrelated capability failures (%s)",async(status)=>{
 let now=1000,programRequests=0,failed=false;
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["daybreak_blue"]}};
 const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs)programRequests++;
  if(failed && body.tools)return Response.json({error:{code:"temporary"}},{status});
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 await saveApiRoutes([route]);
 const options={fetchImpl:fetcher,now:()=>now,persistProbes:true,updateApiDiscovery:async()=>route};
 await discoverModelInventory(null,[route],options);
 now+=900001;failed=true;
 await discoverModelInventory(null,[route],options);
 now+=60001;failed=false;
 const inventory=await discoverModelInventory(null,[route],options);
 expect(programRequests).toBe(1);
 expect(inventory.entries[0].entitlements?.[0]).toMatchObject({programCheckedAt:1000,probes:{"program:cyber:daybreak_blue":"verified"}});
});

it("does not claim a program check when a model has no whitelisted candidates",async()=>{
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["unknown_program"]}};
 const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  expect(body.access_programs).toBeUndefined();
  return Response.json({status:"completed",reasoning:body.reasoning});
 });
 await saveApiRoutes([route]);
 const inventory=await discoverModelInventory(null,[route],{fetchImpl:fetcher,now:()=>1000,persistProbes:true,updateApiDiscovery:async()=>route});
 expect(inventory.entries[0].entitlements?.[0]).not.toHaveProperty("programCheckedAt");
 expect(formatModelInventory(inventory,1000).join("\n")).not.toContain("programs checked");
});

it("persists program-specific transient retries without renewing old evidence",async()=>{
 let now=1000,programRequests=0,failed=false;
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["daybreak_blue"]}};
 const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs){programRequests++;if(failed)return Response.json({error:{code:"temporary"}},{status:429});}
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 await saveApiRoutes([route]);
 const options={fetchImpl:fetcher,now:()=>now,persistProbes:true,updateApiDiscovery:async()=>route};
 await discoverModelInventory(null,[route],options);
 now+=1000;failed=true;
 await discoverModelInventory(null,[route],{...options,forceProbes:true});
 now+=60001;failed=false;
 const inventory=await discoverModelInventory(null,[route],options);
 expect(programRequests).toBe(3);
 expect(inventory.entries[0].entitlements?.[0]).toMatchObject({programCheckedAt:now,probes:{"program:cyber:daybreak_blue":"verified"}});
});

it("replaces future inventory evidence after clock rollback while preserving valid newer and unrelated rows", async () => {
	const { saveModelInventory, loadModelInventory } = await import("../lib/runtime/model-discovery-status.js");
	const clock = vi.spyOn(Date, "now").mockReturnValue(2000);
	const entry = (id: string, checkedAt: number, model: string) => ({ id, label: id, kind: "api" as const, checkedAt, enabled: true, error: false, models: [model], visibleModels: [model] });
	try {
		await saveModelInventory({ version: 1, checkedAt: 2000, entries: [entry("rollback", 2000, "old"), entry("valid", 900, "newer"), entry("unrelated", 800, "keep")] });
		const unrelated = (await loadModelInventory())!.entries.find(row => row.id === "unrelated");
		clock.mockReturnValue(1000);
		await saveModelInventory({ version: 1, checkedAt: 1000, entries: [entry("rollback", 1000, "fresh"), entry("valid", 850, "stale")] }, { mergeEntries: true });
		const saved = (await loadModelInventory())!;
		expect(saved.checkedAt).toBe(1000);
		expect(saved.entries.find(row => row.id === "rollback")).toMatchObject({ checkedAt: 1000, models: ["fresh"] });
		expect(saved.entries.find(row => row.id === "valid")).toMatchObject({ checkedAt: 900, models: ["newer"] });
		expect(saved.entries.find(row => row.id === "unrelated")).toEqual(unrelated);
		// A delayed partial result must still leave a genuinely newer global timestamp alone.
		clock.mockReturnValue(1100);
		await saveModelInventory({ version: 1, checkedAt: 950, entries: [] }, { mergeEntries: true });
		expect((await loadModelInventory())!.checkedAt).toBe(1000);
	} finally {
		clock.mockRestore();
	}
});
