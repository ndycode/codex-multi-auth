import { describe, it, expect, vi } from "vitest";
import { runApiLoginMenu } from "../lib/codex-manager/api-login-menu.js";
import type { ApiRouteCredential } from "../lib/api-route-store.js";
/** A real menu can only return a value it offered; fail loudly if a fixture drifts. */
function offered(items: { value?: string }[], choice: string | null | undefined): string | null {
	if (choice == null) return null;
	if (!items.some((item) => item.value === choice)) throw new Error(`fixture chose unoffered value ${choice}`);
	return choice;
}
describe("API credential setup", () => {
	it("requires explicit model choices and keeps credentials out of menu labels", async () => {
		const choices = ["add", "zdr", "global", "9", "toggle:exclusive", "save", "back"];
		const labels: string[] = [];
		const saved: ApiRouteCredential[][] = [];
		const result = await runApiLoginMenu({
			load: async () => [],
			save: async (r) => {
				saved.push(structuredClone(r));
				return r;
			},
			select: async (items) => {
				labels.push(...items.map((i) => i.label));
				return offered(items, choices.shift());
			},
			text: async () => "Private pool",
			secret: async () => "fixture-api-secret",
			discover: async () => ["exclusive", "hidden"],
			log: vi.fn(),
		});
		expect(result).toBe(0);
		expect(saved).toHaveLength(1);
		expect(saved[0]?.[0]).toMatchObject({
			kind: "zdr",
			visibleModels: ["exclusive"],
			priority: 9,
		});
		expect(labels.join(" ")).not.toContain("fixture-api-secret");
	});
	it("does not save a partial credential when model selection is cancelled", async () => {
		const choices = ["add", "api", "global", "9", null, "back"];
		const save = vi.fn(async (routes:ApiRouteCredential[]) => routes);
		await runApiLoginMenu({
			load: async () => [],
			save,
			select: async (items) => offered(items, choices.shift()),
			text: async () => "Test",
			secret: async () => "fixture-secret",
			discover: async () => ["exclusive"],
			log: vi.fn(),
		});
		expect(save).not.toHaveBeenCalled();
	});
});

it("lets the operator opt into billable capability probes per credential", async () => {
	const route = {
		id: "fixture",
		label: "Fixture",
		kind: "zdr" as const,
		apiKey: "fixture-key",
		priority: 0,
		enabled: true,
		visibleModels: ["fixture"],
	};
	const choices = ["fixture", "probes", "back"];
	const save = vi.fn(async (routes:ApiRouteCredential[]) => routes);
	await runApiLoginMenu({
		load: async () => [route],
		save,
		select: async () => choices.shift() ?? null,
		log: vi.fn(),
	});
	expect(save.mock.calls[0]?.[0]?.[0]?.probeCapabilities).toBe(true);
});

it("offers a late API priority by default and reserves zero for subscription routing", async () => {
 const choices=["add","api","global", null,"back"];
 let priorities: {label:string;value?:string}[]=[];
 await runApiLoginMenu({load:async()=>[],save:vi.fn(async (routes:ApiRouteCredential[]) => routes),text:async()=>"Fixture",secret:async()=>"fixture-secret",log:vi.fn(),select:async(items,message)=>{
  if(message==="Failover priority")priorities=items;
  return choices.shift()??null;
 }});
 expect(priorities[0]).toMatchObject({value:"9"});
 expect(priorities.map(item=>item.value)).not.toContain("0");
});


it("requires operator-declared ZDR classification instead of inferring it from discovery", async () => {
 const choices = ["add", "api", "global", "9", "save", "back"];
 const save = vi.fn(async (routes:ApiRouteCredential[]) => routes);
 const prompts: string[] = [];
 const choicesOffered: string[] = [];
 await runApiLoginMenu({
  load: async () => [], save, text: async () => "Fixture", secret: async () => "fixture-secret", log: vi.fn(),
  discover: async () => ["model-test"],
  select: async (items, message) => { prompts.push(message); choicesOffered.push(...items.map(item => item.label)); return choices.shift() ?? null; },
 });
 expect(prompts.join(" ")).toContain("operator-declared");
 expect(choicesOffered.join(" ")).toContain("not detected from the key");
 expect(save.mock.calls[0]?.[0]?.[0]?.kind).toBe("api");
});

it("reports an unreadable route configuration without rejecting the dashboard",async()=>{
 const log=vi.fn();const select=vi.fn();
 await expect(runApiLoginMenu({load:async()=>{throw Error("Invalid API route configuration");},select,log})).resolves.toBe(1);
 expect(log).toHaveBeenCalledWith(expect.stringMatching(/configuration.*read/i));expect(select).not.toHaveBeenCalled();
});
it.each([false,true])("reports a concurrent edit and tolerates recovery reload failure=%s",async failReload=>{
 const route:ApiRouteCredential={id:"fixture",label:"Fixture",kind:"api",apiKey:"fixture",priority:9,enabled:true,visibleModels:[]};
 const choices=["fixture","toggle","back"];const log=vi.fn();
 const load=vi.fn().mockResolvedValueOnce([route]);
 if(failReload)load.mockRejectedValueOnce(Error("busy"));else load.mockResolvedValueOnce([{...route,label:"Updated"}]);
 const select=vi.fn(async(_items:unknown)=>choices.shift()??null);
 await expect(runApiLoginMenu({load,select,log,save:async()=>{throw Error("API route configuration changed; reopen the menu before saving.");}})).resolves.toBe(0);
 expect(log.mock.calls.flat().join(" ")).toMatch(/changed in another process/);
 expect(log.mock.calls.flat().join(" ")).not.toMatch(/check the key/);
 expect(select.mock.calls[2]?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({label:expect.stringContaining(failReload?"Fixture":"Updated")})]));
});

it("rejects an over-long label before asking for the key instead of blaming the key later",async()=>{
 const choices=["add","back"];const log=vi.fn();const save=vi.fn(async (routes:ApiRouteCredential[]) => routes);const secret=vi.fn(async()=>"fixture-secret");
 await runApiLoginMenu({load:async()=>[],save,secret,log,text:async()=>"x".repeat(81),discover:async()=>["model"],select:async()=>choices.shift()??null});
 expect(secret).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
 const output=log.mock.calls.flat().join(" ");
 expect(output).toMatch(/label/i);expect(output).not.toMatch(/check the key/);
});

it("keeps a route in place when its visible models are edited",async()=>{
 const route=(id:string):ApiRouteCredential=>({id,label:id,kind:"api",apiKey:"fixture",priority:9,enabled:true,visibleModels:[]});
 const choices=["first","models","toggle:model","save","back"];const save=vi.fn(async (routes:ApiRouteCredential[]) => routes);
 await runApiLoginMenu({load:async()=>[route("first"),route("second")],save,log:vi.fn(),discover:async()=>["model"],select:async()=>choices.shift()??null});
 expect(save.mock.calls[0]?.[0]?.map((r:ApiRouteCredential)=>r.id)).toEqual(["first","second"]);
 expect(save.mock.calls[0]?.[0]?.[0]?.visibleModels).toEqual(["model"]);
});

it("rejects a selection the menu did not offer instead of saving it", async () => {
 const route:ApiRouteCredential={id:"fixture",label:"Fixture",kind:"api",apiKey:"fixture",priority:9,enabled:true,visibleModels:[]};
 const choices=["fixture","priority","0","back"];const save=vi.fn(async (routes:ApiRouteCredential[]) => routes);
 await runApiLoginMenu({load:async()=>[route],save,log:vi.fn(),select:async()=>choices.shift()??null});
 // Tier 0 is reserved for subscriptions and never offered to API credentials.
 expect(save).not.toHaveBeenCalled();
});

it.each(["add", "toggle", "probes", "models", "legacy-priority"])("keeps the canonical store snapshot for consecutive %s edits", async first => {
 const {promises:fs}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const {saveApiRoutes,loadApiRoutes}=await import("../lib/api-route-store.js");
 const {removeWithRetry}=await import("./helpers/remove-with-retry.js");
 const root=await fs.mkdtemp(join(tmpdir(),"api-menu-snapshot-"));const previous=process.env.CODEX_MULTI_AUTH_DIR;
 process.env.CODEX_MULTI_AUTH_DIR=root;
 try {
  const route:ApiRouteCredential={id:"fixture",label:"Fixture",kind:"api",apiKey:"fixture-key",priority:9,enabled:true,visibleModels:[],knownModels:["model"]};
  if(first==="legacy-priority")await fs.writeFile(join(root,"api-routes.json"),JSON.stringify({version:1,routes:[route]}));
  else await saveApiRoutes(first==="add"?[]:[route]);
  const initial=first==="add"?["add","api","global", "9","toggle:model","save"]:
   first==="models"?["fixture","models","toggle:model","save"]:
   first==="legacy-priority"?["fixture","priority","8"]:["fixture",first];
  const choices=[...initial,"saved-route","priority","2","back"];
  const log=vi.fn();
  await runApiLoginMenu({
   select:async items=>{
    const choice=choices.shift();
    return offered(items,choice==="saved-route"?items.find(i=>i.value!=="add"&&i.value!=="back")?.value:choice);
   },text:async()=>"Fixture",secret:async()=>"fixture-key",discover:async()=>["model"],log,
  });
  const [saved]=await loadApiRoutes();
  expect(saved.priority).toBe(2);expect(saved.capabilityEpoch).toEqual(expect.any(String));
  if(first==="toggle")expect(saved.enabled).toBe(false);
  if(first==="probes")expect(saved.probeCapabilities).toBe(true);
  if(first==="add"||first==="models")expect(saved.visibleModels).toEqual(["model"]);
  expect(log.mock.calls.flat().join(" ")).not.toMatch(/changed in another process|did not complete/);
 } finally {
  if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;
  await removeWithRetry(root,{recursive:true,force:true});
 }
});


it.each([
 [401, 'HTTP 401'], [403, 'HTTP 403'], [429, 'HTTP 429'], [503, 'HTTP 503'],
])('reports model discovery HTTP %s without exposing response bodies', async (status, expected) => {
 const choices = ['add', 'api', "global", '9', 'back'];
 const log = vi.fn(); const save = vi.fn(async (routes: ApiRouteCredential[]) => routes);
 vi.stubGlobal('fetch', vi.fn(async () => new Response('private-upstream-secret', {status})));
 try {
  await runApiLoginMenu({load:async()=>[], save, log, text:async()=> 'Second', secret:async()=> 'fixture-secret', select:async()=>choices.shift()??null});
  const output=log.mock.calls.flat().join(' ');
  expect(output).toContain(expected);
  expect(output).not.toContain('private-upstream-secret');
  expect(output).not.toContain('fixture-secret');
  expect(save).not.toHaveBeenCalled();
 } finally {vi.unstubAllGlobals();}
});
it.each([
 ['TimeoutError', 'timed out'], ['TypeError', 'network'],
])('distinguishes discovery %s from a rejected key', async (name, expected) => {
 const choices=['add','api',"global", '9','back'];const log=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const error=new Error('private-secret');error.name=name;throw error;}));
 try {
  await runApiLoginMenu({load:async()=>[],log,text:async()=> 'Second',secret:async()=> 'fixture-secret',select:async()=>choices.shift()??null});
  expect(log.mock.calls.flat().join(' ')).toContain(expected);
  expect(log.mock.calls.flat().join(' ')).not.toContain('private-secret');
 } finally {vi.unstubAllGlobals();}
});

it('adds a second credential without changing the existing route', async () => {
 const first: ApiRouteCredential={id:'existing',label:'Existing',kind:'zdr',apiKey:'fixture-first',priority:9,enabled:true,visibleModels:['old']};
 const choices=['add','api',"global", '9','toggle:new','save','back'];
 const save=vi.fn(async(routes:ApiRouteCredential[])=>routes);
 await runApiLoginMenu({load:async()=>[first],save,log:vi.fn(),text:async()=> 'Second',secret:async()=> 'fixture-second',discover:async()=>['new'],select:async(items)=>offered(items,choices.shift())});
 expect(save).toHaveBeenCalledTimes(1);
 expect(save.mock.calls[0][0]).toEqual([first,expect.objectContaining({label:'Second',apiKey:'fixture-second',visibleModels:['new']})]);
});

it("adds a US credential through the normal menu",async()=>{
 const choices=["add","api","us","9","toggle:exclusive","save","back"];
 const save=vi.fn(async(routes:ApiRouteCredential[])=>routes);
 const discover=vi.fn(async()=>["exclusive"]);
 await runApiLoginMenu({load:async()=>[],save,discover,log:vi.fn(),text:async()=>"Regional",secret:async()=>"fixture",select:async(items)=>offered(items,choices.shift())});
 expect(save.mock.calls[0]?.[0]?.[0]).toMatchObject({region:"us",visibleModels:["exclusive"]});
 expect(discover.mock.calls).toHaveLength(1);
});

it("changes a saved credential's region only after selecting models from the new region",async()=>{
 const route:ApiRouteCredential={id:"fixture",label:"Fixture",kind:"api",apiKey:"fixture",priority:9,enabled:true,visibleModels:["old"],knownModels:["old"]};
 const choices=["fixture","region","us","toggle:new","save","back"];
 const save=vi.fn(async(routes:ApiRouteCredential[])=>routes);
 await runApiLoginMenu({load:async()=>[route],save,log:vi.fn(),discover:async r=>{expect(r.region).toBe("us");return ["new"];},select:async(items)=>offered(items,choices.shift())});
 expect(save.mock.calls[0]?.[0]?.[0]).toMatchObject({region:"us",visibleModels:["new"],knownModels:["new"]});
 expect(route.visibleModels).toEqual(["old"]);
});

it("lets operators declare reasoning and Daybreak Red metadata", async () => {
 const route:ApiRouteCredential={id:"fixture",label:"Fixture",kind:"api",apiKey:"fixture",priority:9,enabled:true,visibleModels:["astra-cyber-preview"]};
 const choices=["fixture","metadata","model:astra-cyber-preview","toggle:low","toggle:medium","toggle:high","toggle:xhigh","toggle:max","daybreak_red","save","back"];
 const save=vi.fn(async(routes:ApiRouteCredential[])=>routes);
 await runApiLoginMenu({load:async()=>[route],save,log:vi.fn(),select:async(items)=>offered(items,choices.shift())});
 expect(save.mock.calls[0]?.[0]?.[0]).toMatchObject({modelReasoningLevels:{"astra-cyber-preview":["low","medium","high","xhigh","max"]},modelAccessPrograms:{"astra-cyber-preview":{cyber:["daybreak_red"]}}});
});
