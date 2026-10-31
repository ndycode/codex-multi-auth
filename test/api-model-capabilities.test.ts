import { describe, it, expect, vi } from "vitest";
import { resolveModelRoute } from "../lib/model-route-policy.js";
import {
	ApiModelCapabilities,
	parseApiReasoningDocumentation,
} from "../lib/runtime/api-model-capabilities.js";
describe("public API reasoning metadata", () => {
	it("reads only an explicit support statement for the exact model", () => {
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\n`reasoning.effort` supports `low`, `medium` (default), `high`, and `max`.",
			),
		).toEqual(["low", "medium", "high", "max"]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\nReasoning.effort supports: none, low, medium (default), high, xhigh, and max.",
			),
		).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `other`\nReasoning.effort supports: low, high.",
			),
		).toEqual([]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\nReasoning effort may include low or high depending on the model.",
			),
		).toEqual([]);
	});
	it("requests public metadata without credentials and fails closed on missing or malformed documentation", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high.",
				),
		);
		const reader = new ApiModelCapabilities(fetcher as typeof fetch);
		expect(await reader.reasoning("fixture")).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(
			new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization"),
		).toBe(false);
		expect(await reader.reasoning("../invalid")).toEqual([]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			await new ApiModelCapabilities(
				vi.fn(async () => new Response("no", { status: 404 })) as typeof fetch,
			).reasoning("fixture"),
		).toEqual([]);
	});
});

const route = {
	id: "fixture",
	label: "Fixture",
	apiKey: "fixture-key",
	kind: "zdr" as const,
	enabled: true,
	priority: 0,
	visibleModels: ["fixture"],
	probeCapabilities: true,
};
it("verifies API effort and equivalent fast tiers per credential and never treats a downgrade as fast", async () => {
	const calls: RequestInit[] = [];
	let now = 1;
	const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
		if (init?.method !== "POST")
			return new Response("missing", { status: 404 });
		calls.push(init);
		const body = JSON.parse(String(init.body));
		if (body.service_tier === "ultrafast")
			return Response.json({ service_tier: "default" });
		if (body.service_tier === "priority")
			return Response.json({ service_tier: "priority" });
		if (!["low", "high"].includes(body.reasoning?.effort))
			return new Response("unsupported", { status: 400 });
		return Response.json({
			service_tier: "default",
			reasoning: body.reasoning,
		});
	});
	const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(model?.supported_reasoning_levels).toEqual(
		expect.arrayContaining([
			{ effort: "low", description: expect.any(String) },
			{ effort: "high", description: expect.any(String) },
		]),
	);
	expect(model?.service_tiers).toEqual([
		{ id: "priority", name: "Fast", description: expect.any(String) },
	]);
	expect(model?.capability_probe_status).toMatchObject({
		ultrafast: "downgraded",
		fast: "verified",
	});
	expect(
		calls.every(
			(c) =>
				new Headers(c.headers).get("authorization") === "Bearer fixture-key" &&
				JSON.parse(String(c.body)).store === false &&
				JSON.parse(String(c.body)).max_output_tokens === 16,
		),
	).toBe(true);
	const count = calls.length;
	await reader.enrich([{ slug: "fixture" }], true, route);
	expect(calls).toHaveLength(count);
	await reader.enrich([{ slug: "fixture" }], false, {
		...route,
		apiKey: "other-fixture-key",
	});
	expect(calls.length).toBeGreaterThan(count);
	now += 900001;
	await reader.enrich([{ slug: "fixture" }], false, route);
	expect(calls.length).toBeGreaterThan(count * 2);
});
it("never runs paid probes without opt-in and never calls an authentication failure unsupported", async () => {
	const fetcher = vi.fn(async (_u: unknown, i?: RequestInit) =>
		i?.method === "POST"
			? new Response("unauthorized", { status: 401 })
			: new Response("missing", { status: 404 }),
	);
	const reader = new ApiModelCapabilities(fetcher as typeof fetch);
	await reader.enrich([{ slug: "fixture" }], false, {
		...route,
		probeCapabilities: false,
	});
	expect(fetcher.mock.calls.every((c) => c[1]?.method !== "POST")).toBe(true);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(model?.service_tiers).toEqual([]);
	expect(model?.capability_probe_status).toMatchObject({
		fast: "unverified",
		ultrafast: "unverified",
	});
});

it.each(["429", "network"])(
	"keeps inconclusive efforts routable after an undocumented model partially probes then hits %s",
	async (failure) => {
		const reader = new ApiModelCapabilities(
			vi.fn(async (_u: unknown, init?: RequestInit) => {
				if (init?.method !== "POST") return new Response("missing", { status: 404 });
				const body = JSON.parse(String(init.body));
				if (body.reasoning?.effort === "low")
					return Response.json({ reasoning: { effort: "low" } });
				if (body.reasoning?.effort === "medium") {
					if (failure === "network") throw Error("timeout");
					return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 });
				}
				return Response.json(
					{ error: { param: body.service_tier ? "service_tier" : "reasoning.effort" } },
					{ status: 400 },
				);
			}) as typeof fetch,
		);
		const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
		expect(model).toMatchObject({ reasoning_levels_known: false });
		expect(model?.supported_reasoning_levels?.map((value) => value.effort)).toEqual(
			expect.arrayContaining(["low", "medium"]),
		);
		expect(model?.supported_reasoning_levels?.map((value) => value.effort)).not.toContain("minimal");
		expect(
			resolveModelRoute("zdr/fixture", [{ ...route, models: [model!] }], {
				reasoningEffort: "medium",
			}).candidates,
		).toHaveLength(1);
		expect(
			resolveModelRoute("zdr/fixture", [{ ...route, models: [model!] }], {
				reasoningEffort: "minimal",
			}).candidates,
		).toHaveLength(0);
	},
);

it("keeps an explicitly rejected effort denied across a transient retry", async () => {
	let round = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST") return new Response("missing", { status: 404 });
			const body = JSON.parse(String(init.body));
			if (body.reasoning?.effort === "minimal") {
				if (round === 0)
					return Response.json({ error: { param: "reasoning.effort" } }, { status: 400 });
				throw Error("timeout");
			}
			if (body.reasoning?.effort === "medium")
				return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 });
			return Response.json({ reasoning: { effort: body.reasoning?.effort } });
		}) as typeof fetch,
	);
	const [first] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(first?.capability_probe_status?.["effort:minimal"]).toBe("unsupported");
	round = 1;
	const [second] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(second).toMatchObject({ reasoning_levels_known: false });
	expect(second?.capability_probe_status?.["effort:minimal"]).toBe("unsupported");
	expect(second?.supported_reasoning_levels?.map((value) => value.effort)).not.toContain("minimal");
	expect(resolveModelRoute("zdr/fixture", [{ ...route, models: [second!] }], {
		reasoningEffort: "minimal",
	}).candidates).toHaveLength(0);
});

it("coalesces concurrent paid probes for the same credential and model", async () => {
	let posts = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low.",
				);
			posts++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return Response.json({
				service_tier: JSON.parse(String(i.body)).service_tier,
			});
		}) as typeof fetch,
	);
	await Promise.all([
		reader.enrich([{ slug: "fixture" }], false, route),
		reader.enrich([{ slug: "fixture" }], false, route),
	]);
	expect(posts).toBe(9);
});

it("explicit checks bypass the paid-probe cache while automatic refreshes reuse it", async () => {
	let posts = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low.",
				);
			posts++;
			return Response.json({
				service_tier: JSON.parse(String(i.body)).service_tier,
			});
		}) as typeof fetch,
	);
	await reader.enrich([{ slug: "fixture" }], true, route);
	await reader.enrich([{ slug: "fixture" }], true, route);
	expect(posts).toBe(9);
	await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(posts).toBe(18);
});

it("runs independent probes concurrently with a shared four-request limit and stable effort ordering", async () => {
	let active = 0,
		peak = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST") return new Response("missing", { status: 404 });
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			const body = JSON.parse(String(i.body));
			return Response.json({
				reasoning: body.reasoning,
				service_tier: body.service_tier ?? "default",
			});
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(peak).toBe(4);
	expect(model?.supported_reasoning_levels).toEqual(
		["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
			(effort) => ({ effort, description: expect.any(String) }),
		),
	);
});

it("discovers newly entitled effort levels absent from documentation and excludes rejected levels", async () => {
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high.",
				);
			const body = JSON.parse(String(init.body));
			if (!body.service_tier && body.reasoning.effort === "xhigh")
				return Response.json({ reasoning: { effort: "xhigh" } });
			return Response.json(
				{
					error: {
						param: body.service_tier ? "service_tier" : "reasoning.effort",
					},
				},
				{ status: 400 },
			);
		}) as typeof fetch,
	);
	const [model] = await reader.enrich(
		[{ slug: "fixture", reasoning_levels_known: false, supported_reasoning_levels: [] }],
		true,
		route,
		true,
	);
	expect(model).toMatchObject({ reasoning_levels_known: true });
	expect(model?.supported_reasoning_levels).toEqual(
		["low", "medium", "high", "xhigh", "ultra"].map((effort) => ({
			effort,
			description: expect.any(String),
		})),
	);
	expect(model?.capability_probe_status).toMatchObject({
		"effort:xhigh": "verified",
		"effort:max": "unsupported",
	});
	expect(
		resolveModelRoute(
			"zdr/fixture",
			[{ ...route, models: [model!] }],
			{ reasoningEffort: "max" },
		).candidates,
	).toHaveLength(0);
});

it("keeps native Ultra separate from API effort probes and maps it to a supported maximum", async () => {
	const calls: string[] = [];
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high, max.",
				);
			const body = JSON.parse(String(init.body));
			calls.push(body.reasoning?.effort);
			return Response.json(
				{ error: { param: "reasoning.effort" } },
				{ status: 400 },
			);
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.supported_reasoning_levels).toContainEqual({
		effort: "ultra",
		description: expect.any(String),
	});
	expect(model?.multi_agent_reasoning_effort).toBe("max");
	expect(calls).not.toContain("ultra");
	expect(model?.capability_probe_status).not.toHaveProperty("effort:ultra");
	const [unknown] = await new ApiModelCapabilities(
		vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch,
	).enrich([{ slug: "fixture" }]);
	expect(unknown?.supported_reasoning_levels).toEqual([]);
	expect(unknown?.multi_agent_reasoning_effort).toBeNull();
});

it("reads newly named efforts from exact model documentation without accepting prose or control characters", () => {
	expect(
		parseApiReasoningDocumentation(
			"fixture",
			"Model ID: `fixture`\nReasoning.effort supports: low, high, and deeper_v2.",
		),
	).toEqual(["low", "high", "deeper_v2"]);
	expect(
		parseApiReasoningDocumentation(
			"fixture",
			"Model ID: `fixture`\nReasoning.effort supports: low, high depending on access.",
		),
	).toEqual([]);
});

it("checks Responses tool compatibility before advertising an explicitly rejected API model", async () => {
	const reader = new ApiModelCapabilities((async (_url, init) => {
		if (init?.method !== "POST")
			return new Response(
				"Model ID: `fixture`\nReasoning.effort supports: low, high.",
			);
		const body = JSON.parse(String(init.body));
		if (body.tools)
			return Response.json(
				{ error: { code: "model_not_found", param: "model" } },
				{ status: 404 },
			);
		return Response.json({
			reasoning: body.reasoning,
			service_tier: body.service_tier ?? "default",
		});
	}) as typeof fetch);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.capability_probe_status).toMatchObject({
		responses: "unsupported",
	});
	const { buildVisibleModelUnion, resolveModelRoute } = await import(
		"../lib/model-route-policy.js"
	);
	const catalog = {
		id: "fixture",
		kind: "zdr" as const,
		enabled: true,
		priority: 0,
		visibleModels: ["fixture"],
		models: [model!],
	};
	expect(buildVisibleModelUnion([catalog])).toEqual([]);
	expect(resolveModelRoute("zdr/fixture", [catalog]).candidates).toEqual([]);
});

it("verifies a tool call with a tiny benign payload and reports it in check entitlements", async () => {
	let probe: Record<string, unknown> | undefined;
	const reader = new ApiModelCapabilities((async (_url, init) => {
		if (init?.method !== "POST")
			return new Response(
				"Model ID: `fixture`\nReasoning.effort supports: low, high.",
			);
		const body = JSON.parse(String(init.body));
		if (body.tools) {
			probe = body;
			return Response.json({
				output: [
					{ type: "function_call", name: "capability_probe", arguments: "{}" },
				],
			});
		}
		return Response.json({
			reasoning: body.reasoning,
			service_tier: body.service_tier ?? "default",
		});
	}) as typeof fetch);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(probe).toMatchObject({
		store: false,
		max_output_tokens: 16,
		tool_choice: { type: "function", name: "capability_probe" },
	});
	const { modelEntitlements } = await import("../lib/model-route-policy.js");
	expect(modelEntitlements(model!).probes).toMatchObject({
		responses: "verified",
	});
});

it("preserves established efforts across a documentation outage",async()=>{
 let now=1000;
 const fetcher=vi.fn(async()=>new Response("Model ID: `fixture`\nReasoning.effort supports: low, medium, high."));
 const reader=new ApiModelCapabilities(fetcher as typeof fetch,()=>now);
 const [before] = await reader.enrich([{slug:"fixture"}], false, {...route, probeCapabilities:false});
 expect(before).toMatchObject({reasoning_levels_known:true});
 expect(before?.supported_reasoning_levels).not.toContainEqual(expect.objectContaining({effort:"max"}));
 expect(resolveModelRoute("zdr/fixture", [{...route, probeCapabilities:false, models:[before!]}], {reasoningEffort:"max"}).candidates).toHaveLength(0);
 now+=61000;fetcher.mockResolvedValue(new Response("unavailable",{status:503}));
 const [after] = await reader.enrich([{slug:"fixture"}], true, {...route, probeCapabilities:false});
 expect(after).toMatchObject({reasoning_levels_known:true});
 expect(after?.supported_reasoning_levels).toEqual(before?.supported_reasoning_levels);
 expect(resolveModelRoute("zdr/fixture", [{...route, probeCapabilities:false, models:[after!]}], {reasoningEffort:"max"}).candidates).toHaveLength(0);
});
it("probes the exact priority tier exposed by the native picker",async()=>{
 const tiers:string[]=[];
 const fetcher=vi.fn(async (_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("Model ID: `fixture`\nReasoning.effort supports: low.");
  const body=JSON.parse(String(init.body));if(body.service_tier)tiers.push(body.service_tier);
  if(body.service_tier==='fast')return Response.json({error:{code:'invalid_value',param:'service_tier'}},{status:400});
  return Response.json({service_tier:body.service_tier??'default'});
 });
 const reader=new ApiModelCapabilities(fetcher as typeof fetch);
 const [model]=await reader.enrich([{slug:'fixture'}],false,{id:'fixture',kind:'zdr',label:'Fixture',enabled:true,priority:9,apiKey:'fixture-key',visibleModels:['fixture'],probeCapabilities:true});
 expect(tiers).toContain('priority');expect(tiers).not.toContain('fast');
 expect(model?.service_tiers).toEqual(expect.arrayContaining([expect.objectContaining({id:'priority'})]));
});

it("advertises documented image input on API and ZDR aliases using the existing metadata fetch", async () => {
 const fetcher = vi.fn(async () => new Response("Model ID: `fixture`\nReasoning.effort supports: low, high.\n\n## Model details\n\n- Input modalities: text, image\n- Output modalities: text\n\n## Pricing\n"));
 const reader = new ApiModelCapabilities(fetcher as typeof fetch);
 const { apiPickerModel } = await import("../lib/runtime/api-model-runtime.js");
 const { buildVisibleModelUnion } = await import("../lib/model-route-policy.js");
 const models = await reader.enrich([apiPickerModel("fixture")]);
 expect(models[0]?.input_modalities).toEqual(["text", "image"]);
 const aliases = buildVisibleModelUnion(["api", "zdr"].map(kind => ({...route, kind:kind as "api"|"zdr", models, probeCapabilities:false})));
 expect(aliases).toHaveLength(2);
 expect(aliases.every(model => Array.isArray(model.input_modalities) && model.input_modalities.includes("image"))).toBe(true);
 expect(await reader.reasoning("fixture")).toEqual(["low", "high"]);
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
});

it.each([
 "Model ID: `other`\n\n## Model details\n- Input modalities: text, image\n",
 "Model ID: `fixture`\n\n## Model details\n- Input modalities: text\n- Output modalities: image\n",
 "Model ID: `fixture`\n\n## Examples\n- Input modalities: text, image\n",
 "Model ID: `fixture`\n\n## Model details\n- Input modalities: text, image depending on access\n",
])("does not infer image input from other models, output support, examples, or ambiguous prose", async doc => {
 const reader = new ApiModelCapabilities(vi.fn(async () => new Response(doc)) as typeof fetch);
 const [model] = await reader.enrich([{slug:"fixture", input_modalities:["text"]}]);
 expect(model?.input_modalities).toEqual(["text"]);
});

it("retains documented image support through a metadata outage and adopts an explicit text-only update", async () => {
 let now=1000;
 const fetcher=vi.fn(async()=>new Response("Model ID: `fixture`\n\n## Model details\n- Input modalities: text, image\n"));
 const reader=new ApiModelCapabilities(fetcher as typeof fetch,()=>now);
 const input=[{slug:"fixture", input_modalities:["text"]}];
 expect((await reader.enrich(input))[0]?.input_modalities).toContain("image");
 now+=61000;
 fetcher.mockResolvedValue(new Response("unavailable",{status:503}));
 expect((await reader.enrich(input))[0]?.input_modalities).toContain("image");
 fetcher.mockResolvedValue(new Response("Model ID: `fixture`\n\n## Model details\n- Input modalities: text\n"));
 expect((await reader.enrich(input,true))[0]?.input_modalities).toEqual(["text"]);
});

it("keeps verified efforts and speed tiers through a throttled re-probe and retries it soon", async () => {
	let now = 1;
	let throttled = false;
	let posts = 0;
	const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response("missing", { status: 404 });
		posts++;
		if (throttled) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 });
		const body = JSON.parse(String(init.body));
		if (body.tools) return Response.json({ output: [{ type: "function_call", name: "capability_probe" }] });
		if (body.service_tier === "priority") return Response.json({ service_tier: "priority" });
		if (body.service_tier) return Response.json({ service_tier: "default" });
		return Response.json({ service_tier: "default", reasoning: body.reasoning });
	});
	const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
	const efforts = async () => ((await reader.enrich([{ slug: "fixture" }], false, route))[0]);
	const first = await efforts();
	expect(first?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "xhigh" })]));
	expect(first?.service_tiers).toEqual([expect.objectContaining({ id: "priority" })]);
	throttled = true;
	now += 900_001;
	const second = await efforts();
	expect(second?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "xhigh" })]));
	expect(second?.service_tiers).toEqual([expect.objectContaining({ id: "priority" })]);
	// Not trusted as fresh for 15 minutes: a minute later it probes again.
	const afterThrottle = posts;
	now += 60_001;
	await efforts();
	expect(posts).toBeGreaterThan(afterThrottle);
});

it("stops advertising a credential's verified settings once it loses access", async () => {
	let now = 1;
	let revoked = false;
	const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response("missing", { status: 404 });
		if (revoked) return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
		const body = JSON.parse(String(init.body));
		if (body.tools) return Response.json({ output: [{ type: "function_call", name: "capability_probe" }] });
		if (body.service_tier === "priority") return Response.json({ service_tier: "priority" });
		if (body.service_tier) return Response.json({ service_tier: "default" });
		return Response.json({ service_tier: "default", reasoning: body.reasoning });
	});
	const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
	const enrich = async () => (await reader.enrich([{ slug: "fixture" }], false, route))[0];
	expect((await enrich())?.service_tiers).toEqual([expect.objectContaining({ id: "priority" })]);
	revoked = true;
	now += 900_001;
	const after = await enrich();
	expect(after?.service_tiers).toEqual([]);
	expect(after?.supported_reasoning_levels ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ effort: "xhigh" })]));
});

it("a setting-specific 403 removes only the denied effort", async () => {
 let now=1, deny=false;
 const fetcher=vi.fn(async (_u:unknown, init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(deny && body.reasoning?.effort==="xhigh") return Response.json({error:{code:"unsupported_value",param:"reasoning.effort"}},{status:403});
  if(body.tools)return Response.json({output:[{type:"function_call",name:"capability_probe"}]});
  return Response.json({reasoning:body.reasoning,service_tier:body.service_tier??"default"});
 });
 const reader=new ApiModelCapabilities(fetcher as typeof fetch,()=>now);
 await reader.enrich([{slug:"fixture"}],false,route);
 deny=true;now+=900001;
 const [model]=await reader.enrich([{slug:"fixture"}],false,route);
 expect(model?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({effort:"high"})]));
 expect(model?.supported_reasoning_levels).not.toEqual(expect.arrayContaining([expect.objectContaining({effort:"xhigh"})]));
 expect(model?.service_tiers).toEqual(expect.arrayContaining([expect.objectContaining({id:"priority"})]));
});

describe("403 probe outcomes", () => {
	const run = async (deny: (body: Record<string, unknown>) => Response | null) => {
		let now = 1;
		let denying = false;
		let posts = 0;
		const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST") return new Response("missing", { status: 404 });
			posts++;
			const body = JSON.parse(String(init.body));
			const denied = denying ? deny(body) : null;
			if (denied) return denied;
			if (body.tools) return Response.json({ output: [{ type: "function_call", name: "capability_probe" }] });
			return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier ?? "default" });
		});
		const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
		await reader.enrich([{ slug: "fixture" }], false, route);
		denying = true;
		now += 900_001;
		const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
		const efforts = (model?.supported_reasoning_levels as { effort: string }[] | undefined ?? []).map((level) => level.effort);
		const tiers = (model?.service_tiers as { id: string }[] | undefined ?? []).map((tier) => tier.id);
		const before = posts;
		now += 60_001;
		await reader.enrich([{ slug: "fixture" }], false, route);
		return { efforts, tiers, status: (model?.capability_probe_status ?? {}) as Record<string, string>, reprobedSoon: posts > before };
	};
	it("drops everything the credential verified on a 403 that names the key or project", async () => {
		const result = await run(() => Response.json({ error: { code: "insufficient_permissions", message: "fixture" } }, { status: 403 }));
		expect(result.efforts).not.toContain("xhigh");
		expect(result.tiers).toEqual([]);
	});
	it("hides the whole model on this credential after a model-entitlement 403", async () => {
		const result = await run((body) => (body.reasoning as { effort?: string } | undefined)?.effort === "xhigh"
			? Response.json({ error: { code: "model_access_denied", message: "fixture" } }, { status: 403 })
			: null);
		expect(result.efforts).toEqual([]);
		expect(result.tiers).toEqual([]);
		expect(result.status.responses).toBe("unsupported");
		expect(result.reprobedSoon).toBe(false);
	});
	it("removes only the named effort on a 403 whose param is the probed setting", async () => {
		const result = await run((body) => (body.reasoning as { effort?: string } | undefined)?.effort === "xhigh" && !body.tools && !body.service_tier
			? Response.json({ error: { code: "unsupported_value", param: "reasoning.effort" } }, { status: 403 })
			: null);
		expect(result.efforts).not.toContain("xhigh");
		expect(result.efforts).toContain("high");
		expect(result.tiers).toEqual(expect.arrayContaining(["priority", "ultrafast"]));
		expect(result.reprobedSoon).toBe(false);
	});
	it("does not treat an effort-param 403 on the compatibility or tier probes as a denial of what they test", async () => {
		const result = await run((body) => body.tools || body.service_tier
			? Response.json({ error: { code: "forbidden", param: "reasoning.effort" } }, { status: 403 })
			: null);
		expect(result.status.responses).not.toBe("unsupported");
		expect(result.status.fast).not.toBe("unsupported");
		expect(result.status.ultrafast).not.toBe("unsupported");
		expect(result.tiers).toEqual(expect.arrayContaining(["priority", "ultrafast"]));
		expect(result.efforts).toContain("xhigh");
		expect(result.reprobedSoon).toBe(true);
	});
	it("changes nothing on an unexplained 403 and retries the probe soon", async () => {
		const result = await run((body) => (body.reasoning as { effort?: string } | undefined)?.effort === "xhigh" && !body.service_tier && !body.tools
			? new Response("denied", { status: 403 })
			: null);
		expect(result.efforts).toContain("xhigh");
		expect(result.efforts).toContain("high");
		expect(result.tiers).toEqual(expect.arrayContaining(["priority", "ultrafast"]));
		expect(result.reprobedSoon).toBe(true);
	});
});

it("periodically verifies configured programs without advertising or selecting them", async () => {
 let now = 1000;
 const programs: string[] = [];
 const route = { id: "program-fixture", kind: "api" as const, label: "fixture", apiKey: "fixture-key", enabled: true, priority: 0, visibleModels: ["fixture"], probeCapabilities: true, modelAccessPrograms: {fixture:{cyber:["standard","daybreak_blue"]}} };
 const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
  if (init?.method !== "POST") return new Response("missing", {status:404});
  const body = JSON.parse(String(init.body));
  if (body.access_programs) {
   programs.push(body.access_programs.cyber);
   expect(body.store).toBe(false);
   expect(body.max_output_tokens).toBe(16);
   return Response.json({status:"completed",access_programs:body.access_programs});
  }
  return Response.json({reasoning:body.reasoning, service_tier:body.service_tier, output:[{type:"function_call",name:"capability_probe"}]});
 });
 const service = new ApiModelCapabilities(fetcher,()=>now);
 const [model] = await service.enrich([{slug:"fixture"}],false,route);
 expect(programs).toEqual(["standard","daybreak_blue"]);
 expect(model.capability_probe_status).toMatchObject({"program:cyber:standard":"verified","program:cyber:daybreak_blue":"verified"});
 expect(model.available_access_programs).toBeUndefined();
 now += 900001;
 const restored = new ApiModelCapabilities(fetcher,()=>now);
 restored.importProbes(service.exportProbes());
 await restored.enrich([{slug:"fixture"}],false,route);
 expect(programs).toHaveLength(2);
 now += 86400000;
 await restored.enrich([{slug:"fixture"}],false,route);
 expect(programs).toHaveLength(4);
 await restored.enrich([{slug:"fixture"}],false,{...route,apiKey:"different-key"});
 expect(programs).toHaveLength(6);
 await restored.enrich([{slug:"fixture"}],false,{...route,enabled:false},true);
 expect(programs).toHaveLength(6);
});

it.each([
 [400,{error:{code:"invalid_access_program"}},"unsupported"],
 [400,{error:{code:"unsupported_access_program"}},"unsupported"],
 [403,{error:{code:"access_program_not_enabled",param:"access_programs.cyber"}},"unsupported"],
 [403,{error:{code:"forbidden"}},"unverified"],
 [429,{error:{code:"rate_limit_exceeded"}},"unverified"],
 [503,{error:{code:"server_error"}},"unverified"],
 [200,{status:"failed",access_programs:{cyber:"daybreak_blue"}},"unverified"],
 [200,{status:"error",access_programs:{cyber:"daybreak_blue"}},"unverified"],
 [200,{},"unverified"],
 [200,{access_programs:{cyber:"standard"}},"unverified"],
] as const)("classifies program evidence conservatively (%s)",async(status,data,expected)=>{
 const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs)return Response.json(data,{status});
  return Response.json({reasoning:body.reasoning,service_tier:body.service_tier,output:[]});
 });
 const [model]=await new ApiModelCapabilities(fetcher).enrich([{slug:"fixture"}],false,{id:"fixture",kind:"api",label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,modelAccessPrograms:{fixture:{cyber:["daybreak_blue"]}}});
 expect(model.capability_probe_status).toMatchObject({"program:cyber:daybreak_blue":expected});
});

it.each([
 ["gpt-6.1-sol",["standard","daybreak_blue"]],
 ["gpt-5.6-cyber",["daybreak_red"]],
 ["unrelated",[]],
] as const)("uses bounded program candidates for %s",async(id,expected)=>{
 const programs:string[]=[];
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs)programs.push(body.access_programs.cyber);
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 const service=new ApiModelCapabilities(fetcher);
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:[id],probeCapabilities:false};
 await service.enrich([{slug:id}],false,route);
 expect(programs).toEqual([]);
 await service.enrich([{slug:id}],false,{...route,probeCapabilities:true});
 expect(programs).toEqual(expected);
});

it("does not present a previous program success as a new verification after transport failure",async()=>{
 let fail=false;
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs && fail)throw Error("network");
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 const service=new ApiModelCapabilities(fetcher);
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["daybreak_blue"]}};
 await service.enrich([{slug:"fixture"}],false,route);
 fail=true;
 const [model]=await service.enrich([{slug:"fixture"}],false,route,true);
 expect(model.capability_probe_status).toMatchObject({"program:cyber:daybreak_blue":"unverified"});
});


it("discovers family program candidates beyond configured defaults",async()=>{
 const programs:string[]=[];
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs)programs.push(body.access_programs.cyber);
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 await new ApiModelCapabilities(fetcher).enrich([{slug:"gpt-6.1-sol"}],false,{id:"fixture",kind:"api",label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["gpt-6.1-sol"],probeCapabilities:true,modelAccessPrograms:{"gpt-6.1-sol":{cyber:["standard"]}}});
 expect(programs).toEqual(["standard","daybreak_blue"]);
});

it.each([401,403])("clears earlier capability evidence when a program probe loses credential access (%s)",async(status)=>{
 const programs:string[]=[];
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs){
   programs.push(body.access_programs.cyber);
   return Response.json({error:{code:"invalid_api_key"}},{status});
  }
  return Response.json({reasoning:body.reasoning,service_tier:body.service_tier,output:[{type:"function_call",name:"capability_probe"}]});
 });
 const [model]=await new ApiModelCapabilities(fetcher).enrich([{slug:"fixture"}],false,{id:"fixture",kind:"api",label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["standard","daybreak_blue"]}});
 expect(programs).toEqual(["standard"]);
 expect(model.supported_reasoning_levels).toEqual([]);
 expect(model.additional_speed_tiers).toEqual([]);
 expect(model.capability_probe_status).toMatchObject({responses:"unverified",fast:"unverified",retry:"transient","program:cyber:standard":"unverified","program:cyber:daybreak_blue":"unverified"});
});

it.each([429,503,"network"] as const)("retries inconclusive program probes after 60 seconds (%s)",async(failure)=>{
 let now=1000, failing=true, attempts=0;
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs){
   attempts++;
   if(failing){if(failure==="network")throw Error("network");return Response.json({error:{code:"temporary"}},{status:failure});}
  }
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 const service=new ApiModelCapabilities(fetcher,()=>now);
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["daybreak_blue"]}};
 const [first]=await service.enrich([{slug:"fixture"}],false,route);
 expect(first.program_checked_at).toBeUndefined();
 expect(first.capability_probe_status).toMatchObject({"program:cyber:daybreak_blue":"unverified",retry:"transient"});
 failing=false;now+=60001;
 const [second]=await service.enrich([{slug:"fixture"}],false,route);
 expect(attempts).toBe(2);
 expect(second.capability_probe_status).toMatchObject({"program:cyber:daybreak_blue":"verified"});
 expect(second.program_checked_at).toBe(now);
});

it("keeps old successful program evidence without renewing it after a nonforced transient failure",async()=>{
 let now=1000,failing=false;
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs&&failing)return Response.json({error:{code:"rate_limit_exceeded"}},{status:429});
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 const service=new ApiModelCapabilities(fetcher,()=>now);
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["daybreak_blue"]}};
 await service.enrich([{slug:"fixture"}],false,route);
 now+=86400001;failing=true;
 const [model]=await service.enrich([{slug:"fixture"}],false,route);
 expect(model.capability_probe_status).toMatchObject({"program:cyber:daybreak_blue":"verified",retry:"transient"});
 expect(model.program_checked_at).toBe(1000);
});

it("retries inconclusive legacy program cache entries without the separate retry flag",async()=>{
 let now=1000,programRequests=0;
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs)programRequests++;
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["daybreak_blue"]}};
 const original=new ApiModelCapabilities(fetcher,()=>now);
 await original.enrich([{slug:"fixture"}],false,route);
 const entries=original.exportProbes();
 entries[0]![1].status["program:cyber:daybreak_blue"]="unverified";
 entries[0]![1].status.retry="transient";
 delete entries[0]![1].programRetry;
 now+=60001;
 const restored=new ApiModelCapabilities(fetcher,()=>now);
 restored.importProbes(entries);
 const [model]=await restored.enrich([{slug:"fixture"}],false,route);
 expect(programRequests).toBe(2);
 expect(model.capability_probe_status).toMatchObject({"program:cyber:daybreak_blue":"verified"});
 expect(model.program_checked_at).toBe(now);
});

describe("program cache invalidation",()=>{
 function fixture(){
  let now=1000;
  const programs:string[]=[];
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   if(init?.method!=="POST")return new Response("missing",{status:404});
   const body=JSON.parse(String(init.body));
   if(body.access_programs)programs.push(body.access_programs.cyber);
   return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
  });
  const service=new ApiModelCapabilities(fetcher,()=>now);
  const route={id:"fixture",kind:"api" as const,label:"fixture",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["fixture"],probeCapabilities:true,accessPrograms:{cyber:["standard"]}};
  return {service,route,programs,setNow:(value:number)=>{now=value;}};
 }
 it("checks expired program evidence despite a fresh general capability result",async()=>{
  const f=fixture();await f.service.enrich([{slug:"fixture"}],false,f.route);
  f.setNow(86400000);await f.service.enrich([{slug:"fixture"}],false,f.route);
  expect(f.programs).toEqual(["standard"]);
  f.setNow(86401001);const [model]=await f.service.enrich([{slug:"fixture"}],false,f.route);
  expect(f.programs).toEqual(["standard","standard"]);
  expect(model.program_checked_at).toBe(86401001);
 });
 it("invalidates added and removed candidates on the same credential",async()=>{
  const f=fixture();await f.service.enrich([{slug:"fixture"}],false,f.route);
  f.route.accessPrograms.cyber.push("daybreak_blue");
  const [added]=await f.service.enrich([{slug:"fixture"}],false,f.route);
  expect(f.programs).toContain("daybreak_blue");
  expect(added.capability_probe_status).toMatchObject({"program:cyber:daybreak_blue":"verified"});
  f.route.accessPrograms.cyber=["daybreak_blue"];
  const [removed]=await f.service.enrich([{slug:"fixture"}],false,f.route);
  expect(removed.capability_probe_status).not.toHaveProperty("program:cyber:standard");
  f.route.accessPrograms.cyber=[];
  const [empty]=await f.service.enrich([{slug:"fixture"}],false,f.route);
  expect(empty.program_checked_at).toBeUndefined();
  expect(empty.capability_probe_status).not.toHaveProperty("program:cyber:daybreak_blue");
 });
 it("uses the whole model override instead of falling back to route cyber values",async()=>{
  const f=fixture();
  await f.service.enrich([{slug:"fixture"}],false,{...f.route,modelAccessPrograms:{fixture:{}}});
  expect(f.programs).toEqual([]);
 });
});

it.each(["effort", "program"])("caches conclusive model denial during %s probes beyond the transient retry window", async (phase) => {
	let now = 1000;
	let posts = 0;
	const service = new ApiModelCapabilities(async (_url, init) => {
		if (init?.method !== "POST") return new Response("missing", { status: 404 });
		posts++;
		const body = JSON.parse(String(init.body));
		if (phase === "effort" || body.access_programs) {
			return Response.json({ error: { code: "model_access_denied" } }, { status: 403 });
		}
		return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
	}, () => now);
	const route = { id: "fixture", kind: "api" as const, label: "fixture", apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true, accessPrograms: { cyber: ["standard", "daybreak_blue"] } };
	const [first] = await service.enrich([{ slug: "fixture" }], false, route);
	expect(first.capability_probe_status).toMatchObject({ responses: "unsupported", "program:cyber:standard": "unsupported", "program:cyber:daybreak_blue": "unsupported" });
	expect(first.program_checked_at).toBe(now);
	expect(service.exportProbes()[0][1].programRetry).not.toBe(true);
	expect(service.exportProbes()[0][1].status.retry).toBeUndefined();
	const count = posts;
	now += 60_001;
	// Exercise persisted-cache import too: separate consumers must honour the denial.
	const restarted = new ApiModelCapabilities(async (_url, init) => { if (init?.method === "POST") posts++; return new Response("missing", { status: 404 }); }, () => now);
	restarted.importProbes(service.exportProbes());
	const [cached] = await restarted.enrich([{ slug: "fixture" }], false, route);
	// Public documentation may be read, but no authenticated capability request is needed.
	expect(cached.capability_probe_status).toEqual(first.capability_probe_status);
	expect(posts).toBe(count);
});

it.each(["low", "blank", "unavailable", "malformed", "verified"])("uses reasoning documentation provenance during an inconclusive refresh: %s", async (scenario) => {
	let refreshed = false, now = 1000;
	const fetcher: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") {
			if (refreshed && scenario === "unavailable") return new Response("offline", { status: 503 });
			if (refreshed && scenario === "malformed") return new Response("Model ID: `fixture`\nReasoning.effort might support high.");
			return new Response(`Model ID: \`fixture\`\nReasoning.effort supports: ${refreshed ? (scenario === "blank" ? "" : "low") : (scenario === "verified" ? "low" : "low, high")}.`);
		}
		if (refreshed) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 });
		const body = JSON.parse(String(init.body));
		return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
	};
	const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true };
	const first = new ApiModelCapabilities(fetcher, () => now);
	await first.enrich([{ slug: "fixture" }], false, route);
	const restarted = new ApiModelCapabilities(fetcher, () => now);
	restarted.importProbes(first.exportProbes());
	now += 900_001;
	refreshed = true;
	const [model] = await restarted.enrich([{ slug: "fixture" }], true, route);
	const levels = (model.supported_reasoning_levels as Array<{ effort: string }>).map(value => value.effort);
	if (scenario === "low") expect(levels).not.toContain("high");
	else expect(levels).toContain("high");
});

it.each([false, true])("reconciles cached doc-only levels without refreshing evidence (cache-only=%s)", async (cacheOnly) => {
	let now = 1000, narrowed = false, outage = false, posts = 0;
	const fetcher: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") return outage ? new Response("offline", { status: 503 }) : new Response(`Model ID: \`fixture\`\nReasoning.effort supports: ${narrowed ? "low" : "low, high"}.`);
		posts++;
		if (outage) return new Response("throttled", { status: 429 });
		const body = JSON.parse(String(init.body));
		return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier, output: [{ type: "function_call", name: "capability_probe" }] });
	};
	const route = { id: "fixture", label: "fixture", kind: "api" as const, apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true };
	const service = new ApiModelCapabilities(fetcher, () => now);
	await service.enrich([{ slug: "fixture" }], false, route);
	const prior = service.exportProbes();
	const count = posts;
	now++;
	narrowed = true;
	const [model] = await service.enrich([{ slug: "fixture" }], true, route, false, cacheOnly ? prior : undefined);
	expect(model.supported_reasoning_levels).not.toContainEqual(expect.objectContaining({ effort: "high" }));
	expect(model.supported_reasoning_levels).toContainEqual(expect.objectContaining({ effort: "max" }));
	expect(model.capability_checked_at).toBe(1000);
	expect(posts).toBe(count);
	if (!cacheOnly) {
		expect(service.exportProbes()[0][1].levels).not.toContain("high");
		const restarted = new ApiModelCapabilities(fetcher, () => now);
		restarted.importProbes(service.exportProbes());
		outage = true;
		now += 900_001;
		const [afterRestart] = await restarted.enrich([{ slug: "fixture" }], true, route);
		expect(afterRestart.supported_reasoning_levels).not.toContainEqual(expect.objectContaining({ effort: "high" }));
	}
});

it("does not use an unavailable cached document to remove newer persisted doc-only efforts", async () => {
	let outage = false;
	const service = new ApiModelCapabilities(async () => outage ? new Response("offline", { status: 503 }) : new Response("Model ID: `fixture`\nReasoning.effort supports: low."), () => 2000);
	await service.reasoning("fixture");
	const { createHash } = await import("node:crypto");
	const key = createHash("sha256").update("fixture\0fixture-key\0fixture").digest("hex");
	service.importProbes([[key, { at: 2000, levels: ["low", "high"], tiers: [], status: { responses: "verified" } }]]);
	outage = true;
	const [model] = await service.enrich([{ slug: "fixture" }], true, { id: "fixture", label: "fixture", kind: "api", apiKey: "fixture-key", enabled: true, priority: 0, probeCapabilities: true });
	expect(model.supported_reasoning_levels).toContainEqual(expect.objectContaining({ effort: "high" }));
	expect(service.exportProbes()[0][1].levels).toEqual(["low", "high"]);
});

it("keeps authenticated capability probes on their selected region and separates the cache",async()=>{
 const urls:string[]=[];
 const reader=new ApiModelCapabilities(async(url,init)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  urls.push(String(url));return Response.json({});
 });
 await reader.enrich([{slug:"fixture"}],false,route);
 const count=urls.length;expect(count).toBeGreaterThan(0);
 await reader.enrich([{slug:"fixture"}],false,{...route,region:"us"});
 expect(urls.length).toBeGreaterThan(count);
 expect(urls.slice(count).every(url=>url==="https://us.api.openai.com/v1/responses")).toBe(true);
});
