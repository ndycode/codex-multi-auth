import { describe, it, expect, vi } from "vitest";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
import type { ApiRouteCredential } from "../lib/api-route-store.js";
const credential = (
	id: string,
	kind: "api" | "zdr" = "zdr",
	priority = 0,
): ApiRouteCredential => ({
	id,
	label: "Fixture",
	kind,
	priority,
	enabled: true,
	apiKey: `test-${id}`,
	visibleModels: ["exclusive"],
});
describe("API model discovery and isolated inference", () => {
	it("serves an explicitly visible model while discovery persistence is blocked",async()=>{
		let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
		const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method==="POST"?new Response("ok"):Response.json({data:[{id:"exclusive"}]}));
		const runtime=new ApiModelRuntime(fetcher as typeof fetch,Date.now,async ():Promise<ApiRouteCredential>=>{await gate;throw Error("fixture lock unavailable");});
		try {
			const result=await runtime.request("zdr/exclusive",{model:"zdr/exclusive"},[credential("private")]);
			expect(result?.status).toBe(200);
		}finally{release();}
	});
	it("learns a streamed model rejection for the next request without crossing privacy pools",async()=>{
		const posts:string[]=[];
		const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{if(init?.method!=="POST")return Response.json({data:[{id:"exclusive"}]});posts.push(new Headers(init.headers).get("authorization")!);return new Response("ok");});
		const runtime=new ApiModelRuntime(fetcher as typeof fetch);
		const primary=credential("primary"),backup=credential("backup","zdr",2);
		runtime.recordStreamFailure(primary,"zdr/exclusive",{}, {error:{code:"model_not_found",param:"model"}});
		await runtime.request("zdr/exclusive",{model:"zdr/exclusive"},[primary,credential("ordinary","api"),backup]);
		expect(posts).toEqual(["Bearer test-backup"]);
	});
	it("discovers API-only models and sends inference only to the matching privacy pool", async () => {
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
			init?.method === "POST"
				? new Response('data: {"type":"response.completed"}\n\n', {
						headers: { "content-type": "text/event-stream" },
					})
				: Response.json({
						data: [{ id: "exclusive" }, { id: "not-selected" }],
					}),
		);
		const runtime = new ApiModelRuntime(fetcher as typeof fetch);
		const routes = [credential("ordinary", "api"), credential("private")];
		const catalogs = await runtime.catalogs(routes);
		expect(catalogs[1]?.models.map((m) => m.slug)).toEqual([
			"exclusive",
			"not-selected",
		]);
		const result = await runtime.request(
			"zdr/exclusive",
			{
				model: "zdr/exclusive",
				input: "test",
				stream: true,
				store: true,
				client_metadata: { private: "value" },
			},
			routes,
		);
		expect(result.status).toBe(200);
		await result.text();
		const post = fetcher.mock.calls.find((c) => c[1]?.method === "POST")!;
		expect(post[0]).toBe("https://api.openai.com/v1/responses");
		expect(new Headers(post[1]?.headers).get("authorization")).toBe(
			"Bearer test-private",
		);
		expect(JSON.parse(String(post[1]?.body))).toMatchObject({
			model: "exclusive",
			store: false,
		});
		expect(JSON.parse(String(post[1]?.body))).not.toHaveProperty(
			"client_metadata",
		);
	});
	it("fails over in priority order only before a successful stream starts", async () => {
		const posts: string[] = [];
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
			if (init?.method !== "POST")
				return Response.json({ data: [{ id: "exclusive" }] });
			const auth = new Headers(init.headers).get("authorization")!;
			posts.push(auth);
			return auth.endsWith("primary")
				? new Response("busy", { status: 429 })
				: new Response("ok");
		});
		const runtime = new ApiModelRuntime(fetcher as typeof fetch);
		const response = await runtime.request(
			"zdr/exclusive",
			{ model: "zdr/exclusive" },
			[
				credential("ordinary", "api"),
				credential("backup", "zdr", 2),
				credential("primary", "zdr", 0),
			],
		);
		expect(response.status).toBe(200);
		expect(posts).toEqual(["Bearer test-primary", "Bearer test-backup"]);
	});
	it("does not route a hidden model or fall back to ordinary API credentials", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({ data: [{ id: "exclusive" }, { id: "hidden" }] }),
		);
		const runtime = new ApiModelRuntime(fetcher as typeof fetch);
		expect(
			(
				await runtime.request("zdr/hidden", { model: "zdr/hidden" }, [
					credential("private"),
				])
			).status,
		).toBe(503);
		expect(
			(
				await runtime.request("zdr/exclusive", { model: "zdr/exclusive" }, [
					credential("ordinary", "api"),
				])
			).status,
		).toBe(503);
		expect(
			fetcher.mock.calls.every(
				(c) =>
					c.length < 2 || (c[1] as RequestInit | undefined)?.method !== "POST",
			),
		).toBe(true);
	});
	it("never retries a continuation across credentials", async () => {
		const posts: string[] = [];
		const fetcher = vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST")
				return Response.json({ data: [{ id: "exclusive" }] });
			posts.push(new Headers(i.headers).get("authorization")!);
			return new Response("bad", { status: 429 });
		});
		const runtime = new ApiModelRuntime(fetcher as typeof fetch);
		await runtime.request(
			"zdr/exclusive",
			{ model: "zdr/exclusive", previous_response_id: "response-fixture" },
			[credential("one"), credential("two")],
		);
		expect(posts).toHaveLength(0);
	});
});

it("rejects background and server-side conversation state for explicit privacy routes", async () => {
	const fetcher = vi.fn(async () =>
		Response.json({ data: [{ id: "exclusive" }] }),
	);
	const runtime = new ApiModelRuntime(fetcher as typeof fetch);
	for (const field of [
		{ background: true },
		{ conversation: "fixture-conversation" },
	]) {
		expect(
			(
				await runtime.request(
					"zdr/exclusive",
					{ model: "zdr/exclusive", ...field },
					[credential("private")],
				)
			).status,
		).toBe(400);
	}
});
it("never emits credential-bearing upstream headers", async () => {
	const fetcher = vi.fn(async (_u: unknown, i?: RequestInit) =>
		i?.method === "POST"
			? new Response("ok", {
					headers: {
						"openai-organization": "org-fixture",
						authorization: "fixture-private",
						"content-type": "text/event-stream",
					},
				})
			: Response.json({ data: [{ id: "exclusive" }] }),
	);
	const response = await new ApiModelRuntime(fetcher as typeof fetch).request(
		"api/exclusive",
		{ model: "api/exclusive" },
		[credential("api", "api")],
	);
	expect(response.headers.has("openai-organization")).toBe(false);
	expect(response.headers.has("authorization")).toBe(false);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
});

it("includes the instruction template required by native ModelsResponse deserialization", async () => {
	const { apiPickerModel } = await import(
		"../lib/runtime/api-model-runtime.js"
	);
	const model = apiPickerModel("fixture");
	expect(model.model_messages).toMatchObject({
		instructions_template: expect.any(String),
	});
});

it("drops stale availability after a failed refresh and excludes disabled credentials immediately", async () => {
	let now = 0,
		ok = true,
		posts = 0;
	const fetcher = vi.fn(async (_u: unknown, i?: RequestInit) => {
		if (i?.method === "POST") {
			posts++;
			return new Response("ok");
		}
		return ok
			? Response.json({ data: [{ id: "exclusive" }] })
			: new Response("unavailable", { status: 403 });
	});
	const runtime = new ApiModelRuntime(fetcher as typeof fetch, () => now);
	const route = credential("fixture");
	await runtime.catalogs([route]);
	expect(
		(
			await runtime.request("zdr/exclusive", { model: "zdr/exclusive" }, [
				{ ...route, enabled: false },
			])
		).status,
	).toBe(503);
	now = 5 * 60_000 + 1;
	ok = false;
	expect(
		(
			await runtime.request("zdr/exclusive", { model: "zdr/exclusive" }, [
				route,
			])
		).status,
	).toBe(503);
	expect(posts).toBe(0);
});
it("does not rotate after an accepted stream fails", async () => {
	const posts: string[] = [];
	const fetcher = vi.fn(async (_u: unknown, i?: RequestInit) => {
		if (i?.method !== "POST")
			return Response.json({ data: [{ id: "exclusive" }] });
		posts.push(new Headers(i.headers).get("authorization") ?? "");
		return new Response(
			new ReadableStream({
				start(c) {
					c.error(Error("stream lost"));
				},
			}),
		);
	});
	const response = await new ApiModelRuntime(fetcher as typeof fetch).request(
		"zdr/exclusive",
		{ model: "zdr/exclusive" },
		[credential("primary"), credential("backup", "zdr", 1)],
	);
	await expect(response.text()).rejects.toThrow("stream lost");
	expect(posts).toEqual(["Bearer test-primary"]);
});

it("hides non-Responses endpoint families while preserving future text model IDs", async () => {
	const ids = [
		"tts-1",
		"whisper-1",
		"gpt-realtime-fixture",
		"gpt-image-fixture",
		"text-embedding-fixture",
		"future-text-fixture",
	];
	const runtime = new ApiModelRuntime(
		vi.fn(async () =>
			Response.json({ data: ids.map((id) => ({ id })) }),
		) as typeof fetch,
	);
	const routes = [{ ...credential("fixture"), visibleModels: ids }];
	const [catalog] = await runtime.catalogs(routes);
	expect(catalog?.models.map((m) => m.slug)).toEqual(["future-text-fixture"]);
	expect(
		(await runtime.request("zdr/tts-1", { model: "zdr/tts-1" }, routes)).status,
	).toBe(400);
});

it("refreshes visibility through the discovery callback and serves new models immediately", async () => {
	let ids = ["gpt-old"];
	const persist = vi.fn(
		async (route: ApiRouteCredential, models: string[]) => ({
			...route,
			knownModels: models,
			visibleModels: [
				...route.visibleModels,
				...models.filter((id) => !(route.knownModels ?? models).includes(id)),
			],
		}),
	);
	const runtime = new ApiModelRuntime(
		vi.fn(async (_u: unknown, i?: RequestInit) =>
			i?.method === "POST"
				? new Response("ok")
				: Response.json({ data: ids.map((id) => ({ id })) }),
		) as typeof fetch,
		Date.now,
		persist,
	);
	const routes = [
		{
			...credential("fixture"),
			visibleModels: ["gpt-old"],
			knownModels: ["gpt-old"],
		},
	];
	await runtime.catalogs(routes, true);
	ids = ["gpt-old", "gpt-new", "gpt-image-new"];
	const catalogs = await runtime.catalogs(routes, true);
	expect(catalogs[0]?.visibleModels).toContain("gpt-new");
	expect(persist.mock.calls.at(-1)?.[1]).not.toContain("gpt-image-new");
	expect(runtime.statuses(routes)[0]?.visibleModels).toContain("gpt-new");
	// Inference reads the current explicit policy from the persisted route store.
	routes[0]!.visibleModels = catalogs[0]?.visibleModels ?? [];
	expect(
		(await runtime.request("zdr/gpt-new", { model: "zdr/gpt-new" }, routes))
			.status,
	).toBe(200);
});

it("does not hold native model discovery open while probes run, then updates the served catalog", async () => {
	let finish!: (
		models: import("../lib/model-route-policy.js").RouteModel[],
	) => void;
	const ready = vi.fn();
	const runtime = new ApiModelRuntime(
		vi.fn(async () =>
			Response.json({ data: [{ id: "exclusive" }] }),
		) as typeof fetch,
		Date.now,
		undefined,
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
		ready,
	);
	const catalogs = await runtime.catalogs(
		[credential("fixture")],
		true,
		false,
		false,
	);
	expect(catalogs[0]?.models[0]?.supported_reasoning_levels).toEqual([]);
	expect(ready).not.toHaveBeenCalled();
	finish([
		{
			slug: "exclusive",
			supported_reasoning_levels: [{ effort: "high" }],
			service_tiers: [{ id: "priority", name: "Fast", description: "Fixture" }],
		},
	]);
	await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
	expect(
		runtime.cachedCatalogs()[0]?.models[0]?.supported_reasoning_levels,
	).toEqual([{ effort: "high" }]);
});

it("returns fresh capabilities to an explicit check even when another refresh supersedes its cache entry", async () => {
	const pending: Array<
		(m: import("../lib/model-route-policy.js").RouteModel[]) => void
	> = [];
	const runtime = new ApiModelRuntime(
		vi.fn(async () =>
			Response.json({ data: [{ id: "exclusive" }] }),
		) as typeof fetch,
		Date.now,
		undefined,
		() => new Promise((resolve) => pending.push(resolve)),
	);
	const first = runtime.catalogs([credential("fixture")], true, true, true);
	await vi.waitFor(() => expect(pending).toHaveLength(1));
	const second = runtime.catalogs([credential("fixture")], true, false, true);
	await vi.waitFor(() => expect(pending).toHaveLength(2));
	pending[0]!([
		{ slug: "exclusive", supported_reasoning_levels: [{ effort: "high" }] },
	]);
	const firstResult = await first;
	pending[1]!([
		{ slug: "exclusive", supported_reasoning_levels: [{ effort: "low" }] },
	]);
	await second;
	expect(firstResult[0]?.models[0]?.supported_reasoning_levels).toEqual([
		{ effort: "high" },
	]);
	expect(
		runtime.cachedCatalogs()[0]?.models[0]?.supported_reasoning_levels,
	).toEqual([{ effort: "low" }]);
});

it("learns a model rejection and moves to the next priority within the same privacy pool", async()=>{
 const posts:string[]=[];
 const runtime=new ApiModelRuntime((async(_url,init)=>{if(init?.method!=="POST")return Response.json({data:[{id:"exclusive"}]});const auth=new Headers(init.headers).get("authorization")??"";posts.push(auth);return auth.endsWith("primary")?Response.json({error:{code:"model_not_found",param:"model"}},{status:404}):new Response("ok");}) as typeof fetch);
 const routes=[credential("primary","zdr",0),credential("backup","zdr",2),credential("ordinary","api",0)];
 for(let i=0;i<2;i++){const result=await runtime.request("zdr/exclusive",{model:"zdr/exclusive"},routes);expect(result.status).toBe(200);await result.text();}
 expect(posts).toEqual(["Bearer test-primary","Bearer test-backup","Bearer test-backup"]);
});

it("advertises only the configured credential's programs and refreshes metadata without refetching models", async () => {
 const fetcher=vi.fn(async()=>Response.json({data:[{id:"exclusive"}]}));
 const runtime=new ApiModelRuntime(fetcher as typeof fetch);
 const entitled={...credential("private"),accessPrograms:{research:["extended"]}};
 let catalogs=await runtime.catalogs([credential("ordinary","api"),entitled]);
 expect(catalogs[0]?.models[0]).not.toHaveProperty("available_access_programs");
 expect(catalogs[1]?.models[0]?.available_access_programs).toEqual({research:["extended"]});
 catalogs=await runtime.catalogs([{...entitled,modelAccessPrograms:{exclusive:{research:["restricted"]}}}]);
 expect(catalogs[0]?.models[0]?.available_access_programs).toEqual({research:["restricted"]});
 catalogs=await runtime.catalogs([credential("private")]);
 expect(catalogs[0]?.models[0]).not.toHaveProperty("available_access_programs");
 expect(fetcher).toHaveBeenCalledTimes(2);
});

it("uses cached request capabilities without running probes or inspecting another pool",async()=>{
 let now=1000,block=false;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method==='POST'?Response.json({ok:true}):Response.json({data:[{id:'exclusive'}]}));
 const enrich=vi.fn(async(models:import('../lib/model-route-policy.js').RouteModel[])=>{if(block)await gate;return models.map(m=>({...m,supported_reasoning_levels:[{effort:'low'}]}));});
 const runtime=new ApiModelRuntime(fetcher as typeof fetch,()=>now,undefined,enrich);
 const routes=[credential('private'),credential('ordinary','api')];await runtime.catalogs(routes);
 block=true;now+=16*60000;enrich.mockClear();fetcher.mockClear();
 try {
  const response=await runtime.request('zdr/exclusive',{reasoning:{effort:'low'}},routes);
  expect(response?.status).toBe(200);expect(enrich).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([,init])=>new Headers(init?.headers).get('authorization')==='Bearer test-ordinary')).toBe(false);
 }finally{release();}
});
it("preserves a bounded non-retryable upstream error code for client recovery",async()=>{
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method==='POST'?Response.json({error:{code:'context_length_exceeded',type:'invalid_request_error',param:'input',message:'Input too long.'}},{status:400}):Response.json({data:[{id:'exclusive'}]}));
 const runtime=new ApiModelRuntime(fetcher as typeof fetch);
 const response=await runtime.request('zdr/exclusive',{},[credential('private')]);
 expect(response.status).toBe(400);expect((await response.json()).error.code).toBe('context_length_exceeded');
});
it("fails over a credential transport AbortError while preserving real client cancellation",async()=>{
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=='POST')return Response.json({data:[{id:'exclusive'}]});
  if(new Headers(init.headers).get('authorization')==='Bearer test-first')throw new DOMException('Operation timed out','AbortError');
  return Response.json({ok:true});
 });
 const runtime=new ApiModelRuntime(fetcher as typeof fetch);
 const response=await runtime.request('zdr/exclusive',{},[credential('first'),credential('second','zdr',2)]);
 expect(response.status).toBe(200);expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2);
});
it("enriches capability metadata when a failed cold catalog recovers",async()=>{
 let now=1000,healthy=false;
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method==='POST'?Response.json({ok:true}):healthy?Response.json({data:[{id:'exclusive'}]}):new Response('unavailable',{status:503}));
 const enrich=vi.fn(async(models:import('../lib/model-route-policy.js').RouteModel[])=>models.map(m=>({...m,supported_reasoning_levels:[{effort:'high'}]})));
 const runtime=new ApiModelRuntime(fetcher as typeof fetch,()=>now,undefined,enrich);
 await runtime.request('zdr/exclusive',{reasoning:{effort:'high'}},[credential('private')]);
 now+=6000;healthy=true;
 expect((await runtime.request('zdr/exclusive',{reasoning:{effort:'high'}},[credential('private')])).status).toBe(200);
});

it.each([true,false])("uses typed cancellation and never retries another credential (preaborted=%s)",async preaborted=>{
 const {ClientCancellationError}=await import("../lib/request/client-cancellation.js");
 const controller=new AbortController();let entered!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return Response.json({data:[{id:"exclusive"}]});
  entered();return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));
 });
 const runtime=new ApiModelRuntime(fetcher as typeof fetch);
 if(preaborted)controller.abort();
 const pending=runtime.request("zdr/exclusive",{model:"zdr/exclusive"},[credential("one"),credential("two")],controller.signal);
 const assertion=expect(pending).rejects.toBeInstanceOf(ClientCancellationError);
 if(!preaborted){await started;controller.abort();}
 await assertion;expect(fetcher.mock.calls.filter(c=>c[1]?.method==="POST")).toHaveLength(preaborted?0:1);
});

it.each([401,403])("answers an API pool whose credentials all return %i with 503, not an auth status",async status=>{
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method==="POST"?Response.json({error:{code:"invalid_api_key"}},{status}):Response.json({data:[{id:"exclusive"}]}));
 const runtime=new ApiModelRuntime(fetcher as typeof fetch);
 const response=await runtime.request("api/exclusive",{model:"api/exclusive"},[credential("one","api"),credential("two","api",2)]);
 expect(response?.status).toBe(503);
 expect((await response!.json()).error.code).toBe("model_route_pool_unavailable");
 expect(fetcher.mock.calls.filter(call=>(call[1] as RequestInit|undefined)?.method==="POST")).toHaveLength(2);
});

it("preserves the final sanitized setting rejection after trying every ZDR credential", async () => {
 const fetcher=vi.fn(async (_u:unknown,init?:RequestInit)=>init?.method==="POST"
  ?Response.json({error:{code:"invalid_value",param:"reasoning.effort",message:"private upstream detail"}},{status:400})
  :Response.json({data:[{id:"exclusive"}]}));
 const runtime=new ApiModelRuntime(fetcher as typeof fetch, Date.now, undefined, async models=>models.map(model=>({...model,supported_reasoning_levels:[{effort:"high",description:"High"}]})));
 await runtime.catalogs([credential("first"),credential("second")]);
 const response=await runtime.request("zdr/exclusive",{model:"zdr/exclusive",reasoning:{effort:"high"}},[credential("first"),credential("second")]);
 expect(response.status).toBe(400);
 expect(await response.json()).toEqual({error:{code:"invalid_value",param:"reasoning.effort",message:"Upstream rejected the API request."}});
 expect(fetcher.mock.calls.filter(call=>call[1]?.method==="POST")).toHaveLength(2);
});
