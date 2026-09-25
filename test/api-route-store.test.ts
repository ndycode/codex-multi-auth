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
		expect(await loadApiRoutes(file)).toEqual(routes);
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
	expect(await loadApiRoutes(file)).toEqual(changed);
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
	expect(next.visibleModels).toEqual(["gpt-selected", "gpt-next"]);
	expect((await loadApiRoutes(file))[0]?.knownModels).toContain("other-new");
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
 expect((await loadApiRoutes(file))[0]).toEqual(route);
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
