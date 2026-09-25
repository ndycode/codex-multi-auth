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
		const choices = ["add", "zdr", "9", "toggle:exclusive", "save", "back"];
		const labels: string[] = [];
		const saved: ApiRouteCredential[][] = [];
		const result = await runApiLoginMenu({
			load: async () => [],
			save: async (r) => {
				saved.push(structuredClone(r));
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
		const choices = ["add", "api", "9", null, "back"];
		const save = vi.fn();
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
	const save = vi.fn();
	await runApiLoginMenu({
		load: async () => [route],
		save,
		select: async () => choices.shift() ?? null,
		log: vi.fn(),
	});
	expect(save.mock.calls[0]?.[0]?.[0]?.probeCapabilities).toBe(true);
});

it("offers a late API priority by default and reserves zero for subscription routing", async () => {
 const choices=["add","api",null,"back"];
 let priorities: {label:string;value?:string}[]=[];
 await runApiLoginMenu({load:async()=>[],save:vi.fn(),text:async()=>"Fixture",secret:async()=>"fixture-secret",log:vi.fn(),select:async(items,message)=>{
  if(message==="Failover priority")priorities=items;
  return choices.shift()??null;
 }});
 expect(priorities[0]).toMatchObject({value:"9"});
 expect(priorities.map(item=>item.value)).not.toContain("0");
});


it("requires operator-declared ZDR classification instead of inferring it from discovery", async () => {
 const choices = ["add", "api", "9", "save", "back"];
 const save = vi.fn();
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
 const choices=["add","back"];const log=vi.fn();const save=vi.fn();const secret=vi.fn(async()=>"fixture-secret");
 await runApiLoginMenu({load:async()=>[],save,secret,log,text:async()=>"x".repeat(81),discover:async()=>["model"],select:async()=>choices.shift()??null});
 expect(secret).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
 const output=log.mock.calls.flat().join(" ");
 expect(output).toMatch(/label/i);expect(output).not.toMatch(/check the key/);
});

it("keeps a route in place when its visible models are edited",async()=>{
 const route=(id:string):ApiRouteCredential=>({id,label:id,kind:"api",apiKey:"fixture",priority:9,enabled:true,visibleModels:[]});
 const choices=["first","models","toggle:model","save","back"];const save=vi.fn();
 await runApiLoginMenu({load:async()=>[route("first"),route("second")],save,log:vi.fn(),discover:async()=>["model"],select:async()=>choices.shift()??null});
 expect(save.mock.calls[0]?.[0]?.map((r:ApiRouteCredential)=>r.id)).toEqual(["first","second"]);
 expect(save.mock.calls[0]?.[0]?.[0]?.visibleModels).toEqual(["model"]);
});

it("rejects a selection the menu did not offer instead of saving it", async () => {
 const route:ApiRouteCredential={id:"fixture",label:"Fixture",kind:"api",apiKey:"fixture",priority:9,enabled:true,visibleModels:[]};
 const choices=["fixture","priority","0","back"];const save=vi.fn();
 await runApiLoginMenu({load:async()=>[route],save,log:vi.fn(),select:async()=>choices.shift()??null});
 // Tier 0 is reserved for subscriptions and never offered to API credentials.
 expect(save).not.toHaveBeenCalled();
});
