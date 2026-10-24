import { promises as fs } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiRoutes, saveApiRoutes } from "../lib/api-route-store.js";
import { withRetry } from "../lib/fs-retry.js";
const dirs: string[] = [];
async function tempDir() {
	const path = await mkdtemp(join(tmpdir(), "api-route-test-"));
	dirs.push(path);
	return path;
}
async function removeWithRetry(path: string) {
	await withRetry(() => rm(path, { recursive: true, force: true }), {
		maxAttempts: 6,
		backoffMs: 25,
	});
}
afterEach(async () => {
	for (const path of dirs.splice(0)) await removeWithRetry(path);
});
it("API-only catalog entries need no matching OAuth model", async () => {
	const { buildVisibleModelUnion, resolveModelRoute } = await import(
		"../lib/model-route-policy.js"
	);
	const catalogs = [
		{
			id: "api-exclusive",
			kind: "zdr" as const,
			enabled: true,
			priority: 0,
			models: [{ slug: "exclusive-preview" }],
			visibleModels: ["exclusive-preview"],
		},
	];
	expect(buildVisibleModelUnion(catalogs)[0]?.slug).toBe(
		"zdr/exclusive-preview",
	);
	expect(
		resolveModelRoute("zdr/exclusive-preview", catalogs).candidates,
	).toHaveLength(1);
	expect(resolveModelRoute("exclusive-preview", catalogs).candidates).toEqual(
		[],
	);
});
describe("private API route storage", () => {
	it("roundtrips explicit model visibility and priority with private file permissions", async () => {
		const file = join(await tempDir(), "routes.json");
		const routes = [
			{
				id: "fixture",
				label: "Test API",
				kind: "zdr" as const,
				apiKey: "fixture-key",
				enabled: true,
				priority: 2,
				visibleModels: ["model-a"],
			},
		];
		await saveApiRoutes(routes, file);
		expect(await loadApiRoutes(file)).toMatchObject(routes);
		if (process.platform !== "win32")
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
	});
	it("fails closed on malformed stores rather than silently enabling fallback", async () => {
		const file = join(await tempDir(), "routes.json");
		await writeFile(file, '{"version":1,"routes":[{"kind":"oauth"}]}');
		await expect(loadApiRoutes(file)).rejects.toThrow(
			"Invalid API route configuration",
		);
	});
	it("repairs a malformed store on an unconditional save while strict saves still reject", async () => {
		const file = join(await tempDir(), "routes.json");
		await writeFile(file, "{broken");
		const route = {
			id: "fixture",
			label: "Fixture",
			kind: "api" as const,
			apiKey: "fixture-key",
			enabled: true,
			priority: 0,
			visibleModels: ["model-a"],
		};
		await expect(saveApiRoutes([route], file, [])).rejects.toThrow(
			"Invalid API route configuration",
		);
		await saveApiRoutes([route], file);
		expect(await loadApiRoutes(file)).toMatchObject([
			{ id: "fixture", capabilityEpoch: expect.any(String) },
		]);
	});
});

it("rejects a stale login menu save rather than re-enabling another writer's disabled credential", async () => {
	const file = join(await tempDir(), "routes.json");
	const initial = [
		{
			id: "fixture",
			label: "Fixture",
			kind: "api" as const,
			apiKey: "fixture-key",
			enabled: true,
			priority: 0,
			visibleModels: ["model-a"],
		},
	];
	await saveApiRoutes(initial, file);
	const changed = [{ ...initial[0]!, enabled: false }];
	await saveApiRoutes(changed, file);
	await expect(
		saveApiRoutes([{ ...initial[0]!, priority: 1 }], file, initial),
	).rejects.toThrow("changed");
	expect(await loadApiRoutes(file)).toMatchObject(changed);
});

it("refuses configurations larger than its bounded reader accepts", async () => {
	const file = join(await tempDir(), "routes.json");
	const routes = Array.from({ length: 10 }, (_, i) => ({
		id: `fixture-${i}`,
		label: "Fixture",
		kind: "api" as const,
		apiKey: "fixture-key",
		enabled: true,
		priority: 0,
		visibleModels: Array.from({ length: 1000 }, () => "m".repeat(200)),
	}));
	await expect(saveApiRoutes(routes, file)).rejects.toThrow("too large");
	expect(await loadApiRoutes(file)).toEqual([]);
});

it("baselines existing models, then adds only newly discovered GPT text models without resurrecting hidden choices", async () => {
	const { updateApiModelDiscovery } = await import("../lib/api-route-store.js");
	const file = join(await tempDir(), "routes.json");
	const route = {
		id: "fixture",
		label: "Fixture",
		kind: "zdr" as const,
		apiKey: "fixture-key",
		enabled: true,
		priority: 0,
		visibleModels: ["gpt-selected"],
	};
	await saveApiRoutes([route], file);
	const baseline = await updateApiModelDiscovery(
		route,
		["gpt-selected", "gpt-hidden"],
		file,
	);
	expect(baseline.visibleModels).toEqual(["gpt-selected"]);
	const fresh = await updateApiModelDiscovery(
		baseline,
		["gpt-selected", "gpt-hidden", "gpt-new", "other-new"],
		file,
	);
	expect(fresh.visibleModels).toEqual(["gpt-selected", "gpt-new"]);
	const hidden = { ...fresh, visibleModels: ["gpt-selected"] };
	await saveApiRoutes([hidden], file);
	// A stale runtime snapshot must not re-enable a manually hidden choice.
	const next = await updateApiModelDiscovery(
		fresh,
		["gpt-selected", "gpt-hidden", "gpt-new", "gpt-next"],
		file,
	);
	expect(next.enabled).toBe(false);
	expect((await loadApiRoutes(file))[0]?.visibleModels).toEqual(["gpt-selected"]);
	expect((await loadApiRoutes(file))[0]?.knownModels).toContain("other-new");
	const [current] = await loadApiRoutes(file);
	const refreshed = await updateApiModelDiscovery(current, ["gpt-selected", "gpt-hidden", "gpt-new", "gpt-next"], file);
	expect(refreshed.visibleModels).toEqual(["gpt-selected", "gpt-next"]);
});

it("serializes discovery updates for multiple credentials without losing either baseline", async () => {
	const { updateApiModelDiscovery } = await import("../lib/api-route-store.js");
	const file = join(await tempDir(), "routes.json");
	const routes = ["one", "two"].map((id) => ({
		id,
		label: "Fixture",
		kind: "zdr" as const,
		apiKey: `fixture-${id}`,
		enabled: true,
		priority: 0,
		visibleModels: ["gpt-old"],
		knownModels: ["gpt-old"],
	}));
	await saveApiRoutes(routes, file);
	await Promise.all(
		routes.map((route) =>
			updateApiModelDiscovery(route, ["gpt-old", "gpt-new"], file),
		),
	);
	expect(
		(await loadApiRoutes(file)).every((r) =>
			r.visibleModels.includes("gpt-new"),
		),
	).toBe(true);
});

it("preserves validated program configuration through discovery updates",async()=>{
 const {updateApiModelDiscovery}=await import("../lib/api-route-store.js");
 const file=join(await tempDir(),"routes.json");
 const route={id:"private",label:"Fixture",kind:"zdr" as const,apiKey:"fixture-key",priority:9,enabled:true,visibleModels:["example"],accessPrograms:{research:["extended"]},modelAccessPrograms:{example:{research:["restricted"]}}};
 await saveApiRoutes([route],file);
 expect((await loadApiRoutes(file))[0]).toMatchObject(route);
 const updated=await updateApiModelDiscovery(route,["example","gpt-fixture"],file);
 expect(updated.accessPrograms).toEqual(route.accessPrograms);
 expect(updated.modelAccessPrograms).toEqual(route.modelAccessPrograms);
});

it("retries EPERM when publishing API route configuration",async()=>{
 const path=join(await tempDir(),"routes.json"),rename=fs.rename.bind(fs);let failed=false;
 const spy=vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{if(String(to)===path&&!failed){failed=true;throw Object.assign(Error("locked"),{code:"EPERM"});}return rename(from,to);});
 try {await saveApiRoutes([],path);expect(failed).toBe(true);expect(await loadApiRoutes(path)).toEqual([]);}
 finally{spy.mockRestore();}
});

it.each(["EBUSY","EPERM","EACCES"])("retries a transient %s opening the API routes",async code=>{
 const path=join(await tempDir(),"api-routes.json");await saveApiRoutes([],path);
 const original=fs.open.bind(fs);let calls=0;
 const open=vi.spyOn(fs,"open").mockImplementation(async(...args)=>{
  if(String(args[0])===path && ++calls===1)throw Object.assign(new Error("locked"),{code});
  return original(...args);
 });
 try{expect(await loadApiRoutes(path)).toEqual([]);expect(calls).toBe(2);}finally{open.mockRestore();}
});

it("returns its own canonical save snapshot and still rejects a later writer's edits",async()=>{
 const {saveApiRoutesSnapshot}=await import("../lib/api-route-store.js");
 const transactions=await import("../lib/storage/transactions.js");
 const file=join(await tempDir(),"routes.json");
 const route={id:"fixture",label:"Fixture",kind:"api" as const,apiKey:"fixture",priority:9,enabled:true,visibleModels:[]};
 const initial=await saveApiRoutesSnapshot([route],file,[]);
 expect(initial).toEqual(await loadApiRoutes(file));
 const original=transactions.withStorageLock;let armed=true;
 const spy=vi.spyOn(transactions,"withStorageLock").mockImplementation(async action=>{
  const result=await original(action);
  if(armed){armed=false;const current=await loadApiRoutes(file);await saveApiRoutes(current.map(value=>({...value,enabled:false})),file,current);}
  return result;
 });
 try{
  const saved=await saveApiRoutesSnapshot(initial.map(value=>({...value,priority:2})),file,initial);
  expect(saved[0]).toMatchObject({priority:2,enabled:true,capabilityEpoch:initial[0].capabilityEpoch});
  expect((await loadApiRoutes(file))[0].enabled).toBe(false);
  await expect(saveApiRoutesSnapshot(saved.map(value=>({...value,priority:3})),file,saved)).rejects.toThrow("changed");
  expect((await loadApiRoutes(file))[0]).toMatchObject({priority:2,enabled:false});
 }finally{spy.mockRestore();}
});

it.each(["not-json", JSON.stringify({version:1,routes:[{id:"broken"}]})])("repairs an invalid store only with an unconditional save: %s", async raw => {
 const file=join(await tempDir(),"routes.json");
 const route={id:"repair",label:"Repair",kind:"api" as const,apiKey:"fixture",enabled:true,priority:0,visibleModels:["fixture"],capabilityEpoch:"00000000-0000-4000-8000-000000000001",legacyCapabilityCache:true};
 await writeFile(file,raw);
 await expect(saveApiRoutes([route],file,[])).rejects.toThrow("Invalid API route configuration");
 expect(await readFile(file,"utf8")).toBe(raw);
 await saveApiRoutes([route],file);
 const [saved]=await loadApiRoutes(file);
 expect(saved).toMatchObject({id:"repair",apiKey:"fixture",visibleModels:["fixture"]});
 expect(saved.capabilityEpoch).toEqual(expect.any(String));
 expect(saved.capabilityEpoch).not.toBe(route.capabilityEpoch);
 expect(saved.legacyCapabilityCache).toBeUndefined();
});
it.each(["oversized","EACCES","EIO"])("does not repair an unreadable store (%s)",async failure=>{
 const file=join(await tempDir(),"routes.json"),raw=failure==="oversized"?"x".repeat(1024*1024+1):"not-json";
 await writeFile(file,raw);
 const open=fs.open.bind(fs);
 const spy=vi.spyOn(fs,"open").mockImplementation(async(...args)=>{if(args[0]===file&&failure!=="oversized")throw Object.assign(Error("unreadable"),{code:failure});return open(...args);});
 try{await expect(saveApiRoutes([],file)).rejects.toThrow("Unable to read API route configuration");expect(await readFile(file,"utf8")).toBe(raw);}finally{spy.mockRestore();}
});

it("keeps ownership when a menu sorts discovered visibility without changing the selected set", async () => {
 const {saveApiRoutesSnapshot,updateApiModelDiscovery}=await import("../lib/api-route-store.js");
 const file=join(await tempDir(),"routes.json");
 const initial={id:"order",label:"Order",kind:"api" as const,apiKey:"fixture",enabled:true,probeCapabilities:true,priority:0,visibleModels:["gpt-z"],knownModels:["gpt-z"]};
 await saveApiRoutes([initial],file);
 const discovered=await updateApiModelDiscovery(initial,["gpt-z","gpt-a"],file);
 expect(discovered.visibleModels).toEqual(["gpt-z","gpt-a"]);
 const before=JSON.stringify(discovered);
 const selection={...discovered,visibleModels:[...discovered.visibleModels].sort()};
 const selectionBefore=JSON.stringify(selection);
 const [saved]=await saveApiRoutesSnapshot([selection],file,[discovered]);
 expect(saved.capabilityEpoch).toBe(discovered.capabilityEpoch);
 expect(saved.visibleModels).toEqual(["gpt-a","gpt-z"]);
 expect(JSON.stringify(discovered)).toBe(before);
 expect(JSON.stringify(selection)).toBe(selectionBefore);
 const [added]=await saveApiRoutesSnapshot([{...saved,visibleModels:[...saved.visibleModels,"gpt-new"]}],file,[saved]);
 expect(added.capabilityEpoch).not.toBe(saved.capabilityEpoch);
 const [removed]=await saveApiRoutesSnapshot([{...added,visibleModels:["gpt-a"]}],file,[added]);
 expect(removed.capabilityEpoch).not.toBe(added.capabilityEpoch);
});

it("persists US region using a store version that old readers reject",async()=>{
 const file=join(await tempDir(),"routes.json");
 const route={id:"regional",label:"US",kind:"api" as const,apiKey:"fixture",enabled:true,priority:9,visibleModels:[],region:"us" as const};
 await saveApiRoutes([route],file);
 expect((await loadApiRoutes(file))[0]).toMatchObject({region:"us"});
 expect(JSON.parse(await readFile(file,"utf8")).version).toBe(2);
});

it("persists operator metadata using a store version that old readers reject",async()=>{
 const file=join(await tempDir(),"routes.json");
 const route={id:"declared",label:"Declared",kind:"api" as const,apiKey:"fixture",enabled:true,priority:9,visibleModels:["astra"],modelReasoningLevels:{astra:["medium" as const]},modelAccessPrograms:{astra:{cyber:["daybreak_red"]}}};
 await saveApiRoutes([route],file);
 expect(JSON.parse(await readFile(file,"utf8")).version).toBe(3);
 expect((await loadApiRoutes(file))[0]).toMatchObject({modelReasoningLevels:{astra:["medium"]},modelAccessPrograms:{astra:{cyber:["daybreak_red"]}}});
});

it("invalidates regional capability ownership and rejects stale discovery",async()=>{
 const {updateApiModelDiscovery}=await import("../lib/api-route-store.js");
 const file=join(await tempDir(),"routes.json");
 const route={id:"regional",label:"Region",kind:"api" as const,apiKey:"fixture",enabled:true,priority:9,visibleModels:[]};
 await saveApiRoutes([route],file);const [old]=await loadApiRoutes(file);
 await saveApiRoutes([{...old,region:"us"}],file,[old]);
 const [current]=await loadApiRoutes(file);
 expect(current.capabilityEpoch).not.toBe(old.capabilityEpoch);
 expect(await updateApiModelDiscovery(old,["gpt-fixture"],file)).toMatchObject({enabled:false});
 expect((await loadApiRoutes(file))[0].visibleModels).toEqual([]);
});
it("rejects arbitrary regional hosts at the storage boundary",async()=>{
 const file=join(await tempDir(),"routes.json");
 await writeFile(file,JSON.stringify({version:2,routes:[{id:"bad",label:"Bad",kind:"api",apiKey:"fixture",enabled:true,priority:9,visibleModels:[],region:"attacker.example"}]}));
 await expect(loadApiRoutes(file)).rejects.toThrow("Invalid API route configuration");
});
