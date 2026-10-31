import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { ResponsesWebSocketGateway } from "../lib/runtime/responses-websocket.js";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("listen failed");
	return `http://127.0.0.1:${address.port}`;
}
async function fixture(respond?: (ws: WebSocket, body: Record<string, unknown>, id: string) => boolean, options: {signal?: AbortSignal; sendFailure?: boolean; cancelBody?: () => void; bridgeKeepAliveMs?: number; bodyReadTimeoutMs?: number; upstreamSilenceMs?: number} = {}) {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream });
	const calls: Record<string, unknown>[] = [];
	let connections = 0;
	let upstreamCredential = "fixture-upstream";
	wss.on("connection", (ws) => {
		connections++;
		ws.on("message", (data) => {
			const body = JSON.parse(data.toString());
			calls.push(body);
			const id = `resp_${calls.length}`;
			if (body.model === "rejected") {
				ws.send(
					JSON.stringify({
						type: "error",
						status: 400,
						error: {
							code: "model_not_found",
							param: "model",
							message: "Unsupported model",
						},
					}),
				);
				return;
			}
			ws.send(JSON.stringify({ type: "response.created", response: { id } }));
			if (respond?.(ws, body, id)) return;
			if (body.model === "disconnect") {
				ws.close();
				return;
			}
			if (body.model === "stall") return;
			ws.send(
				JSON.stringify({
					type: "response.completed",
					response: {
						id,
						output: body.generate === false ? [] : [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "OK" }],
							},
						],
					},
				}),
			);
		});
	});
	const upstreamUrl = await listen(upstream);
	const peers = new Set<WebSocket>();
	const originalSend = WebSocket.prototype.send;
	const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function(this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
		if (this.url === upstreamUrl.replace("http:", "ws:") + "/responses") {
			peers.add(this);
			if (options.sendFailure) {
				const callback = typeof args[1] === "function" ? args[1] : args[2];
				callback?.(Error("fixture send failure"));
				return;
			}
		}
		originalSend.apply(this, args);
	});
	cleanups.push(async () => { sendSpy.mockRestore(); });

	cleanups.push(async () => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
		await new Promise<void>((r) => upstream.close(() => r()));
	});
	const gateway = new ResponsesWebSocketGateway(fetch, {
		maxPayloadBytes: 16384,
		bridgeKeepAliveMs: options.bridgeKeepAliveMs,
		upstreamSilenceMs: options.upstreamSilenceMs,
	});
	const server = createServer((req, res) => {
		gateway.handle(req, async () => {
			if (req.headers.authorization !== "Bearer fixture-local") {
				res.writeHead(401);
				res.end();
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(404);
				res.end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const response = await gateway.fetch(`${upstreamUrl}/responses`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstreamCredential}`,
					"content-type": "application/json",
				},
				body: Buffer.concat(chunks),
				signal: options.signal,
			});
			res.writeHead(response.status, Object.fromEntries(response.headers));
            if (options.cancelBody) {
                const closed = [...peers].map(peer => once(peer, "close"));
                await response.body?.cancel();
                await Promise.all(closed);
                options.cancelBody();
                res.end();
                return;
            }
			try {
				if (response.body && options.bodyReadTimeoutMs) {
					const reader = response.body.getReader();
					for (;;) {
						let timer: NodeJS.Timeout | undefined;
						const result = await Promise.race([
							reader.read(),
							new Promise<never>((_resolve, reject) => {
								timer = setTimeout(() => reject(Error("bridge body read timeout")), options.bodyReadTimeoutMs);
							}),
						]).finally(() => clearTimeout(timer));
						if (result.done) break;
						res.write(result.value);
					}
				} else if (response.body)
					for await (const chunk of response.body) res.write(chunk);
				res.end();
			} catch {
				res.destroy();
			}
		});
	});
	const baseUrl = await listen(server);
	gateway.attach(server, baseUrl);
	cleanups.push(async () => {
		gateway.close();
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	});
	const connect = async (token = "fixture-local") => {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/responses", {
			headers: { authorization: `Bearer ${token}` },
		});
		await once(ws, "open");
		cleanups.push(async () => ws.terminate());
		return ws;
	};
	return { peers, stats: gateway.stats, disconnectUpstream: async () => { const closed = [...peers].filter(socket=>socket.readyState !== WebSocket.CLOSED).map(socket=>once(socket,"close")); for(const socket of wss.clients) socket.terminate(); await Promise.all(closed); }, connect, calls, connections: () => connections, baseUrl, useCredential: (credential: string) => { upstreamCredential = credential; } };
}
function turn(
	ws: WebSocket,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const events: Record<string, unknown>[] = [];
		const timer = setTimeout(() => {
			ws.off("message", onMessage);
			reject(Error("turn timeout"));
		}, 3000);
		const onMessage = (raw: WebSocket.RawData) => {
			const event = JSON.parse(raw.toString());
			events.push(event);
			if (
				["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)
			) {
				clearTimeout(timer);
				ws.off("message", onMessage);
				resolve(events);
			}
		};
		ws.on("message", onMessage);
		ws.send(JSON.stringify({ type: "response.create", ...body }));
	});
}
it("uses real upstream WebSockets and reuses the socket for a continuation", async () => {
	const f = await fixture();
	const ws = await f.connect();
	await turn(ws, {
		model: "shared",
		input: [{ role: "user", content: "hello" }],
	});
	await turn(ws, {
		model: "shared",
		previous_response_id: "resp_1",
		input: [{ role: "user", content: "again" }],
	});
	expect(f.connections()).toBe(1);
	expect(f.calls[1]).toMatchObject({
		type: "response.create",
		previous_response_id: "resp_1",
		input: [{ role: "user", content: "again" }],
		store: false,
	});
	expect(f.calls[0]).not.toHaveProperty("stream");
});
it("replaces an upstream socket before its five-minute lease expires", async () => {
	const f = await fixture();
	const ws = await f.connect();
	await turn(ws, {
		model: "api/shared",
		input: [{ role: "user", content: "hello" }],
	});
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60_000 + 1);
	try {
		await turn(ws, {
			model: "api/shared",
			previous_response_id: "resp_1",
			input: [{ role: "user", content: "again" }],
		});
	} finally {
		clock.mockRestore();
	}
	expect(f.connections()).toBe(2);
	expect(f.calls[1]).not.toHaveProperty("previous_response_id");
	expect(f.calls[1]?.input).toEqual(expect.arrayContaining([
		{ role: "user", content: "hello" },
		{ role: "user", content: "again" },
	]));
});
it.each([undefined, false, true])("preserves caller permission metadata over WebSocket (%s)", async (enabled) => {
	const f = await fixture();
	const ws = await f.connect();
	const metadata = enabled === undefined ? undefined : {
		thread_id: "fixture-thread",
		sandbox: enabled ? "seatbelt" : "none",
		sandbox_mode: enabled ? "workspace-write" : "danger-full-access",
		approval_policy: "on-request",
		auto_review_enabled: enabled,
		node_repl_auto_review_required: enabled,
		node_repl_disabled: !enabled,
	};
	const clientMetadata = metadata === undefined ? undefined : {
		"x-codex-turn-metadata": JSON.stringify(metadata),
		...metadata,
	};
	expect((await turn(ws, { model: "shared", input: [], client_metadata: clientMetadata })).at(-1)?.type).toBe("response.completed");
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]?.client_metadata).toEqual(clientMetadata);
});

it.each(["api","zdr","psp"] as const)("rejects unknown or cross-pool %s continuations without sending them upstream", async kind => {
	const f = await fixture();
	const ws = await f.connect();
	expect(
		(
			await turn(ws, {
				model: `${kind}/shared`,
				previous_response_id: "unknown",
				input: [],
			})
		)[0],
	).toMatchObject({
		type: "error",
		error: { code: "previous_response_not_found" },
	});
	await turn(ws, { model: `${kind}/shared`, input: [] });
	expect(
		(
			await turn(ws, {
				model: "shared",
				previous_response_id: "resp_1",
				input: [],
			})
		)[0],
	).toMatchObject({
		type: "error",
		error: { code: "model_route_pool_mismatch" },
	});
	expect(f.calls).toHaveLength(1);
});
it("does not open an upstream connection for an unauthorized handshake", async () => {
	const f = await fixture();
	await expect(f.connect("wrong")).rejects.toThrow();
	expect(f.connections()).toBe(0);
});
it("passes a pre-generation rejection through the routing pipeline as an HTTP failure", async () => {
	const f = await fixture();
	const ws = await f.connect();
	expect((await turn(ws, { model: "rejected", input: [] }))[0]).toMatchObject({
		type: "error",
		status: 400,
		error: { code: "model_not_found" },
	});
	expect(f.calls).toHaveLength(1);
});
it("fails explicitly for unsupported control events", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const event = once(ws, "message");
	ws.send(JSON.stringify({ type: "unknown.control" }));
	expect(JSON.parse((await event)[0].toString())).toMatchObject({
		type: "error",
		error: { code: "unsupported_websocket_event" },
	});
	expect(f.calls).toHaveLength(0);
});
it("forwards steering to the active upstream response", async () => {
	const f = await fixture((_ws, body) => body.model === "steer-target" || body.type === "response.steer");
	const ws = await f.connect();
	const created = once(ws, "message");
	ws.send(JSON.stringify({ type: "response.create", model: "steer-target", input: [] }));
	await created;
	ws.send(JSON.stringify({ type: "response.steer", previous_response_id: "resp_1", input: "narrow scope" }));
	await vi.waitFor(() => expect(f.calls).toHaveLength(2));
	expect(f.calls[1]).toEqual({ type: "response.steer", previous_response_id: "resp_1", input: "narrow scope" });
});
it("rejects steering owned by another authenticated local session", async () => {
	const f = await fixture((_ws, body) => body.model === "steer-target");
	const owner = await f.connect();
	const other = await f.connect();
	const created = once(owner, "message");
	owner.send(JSON.stringify({ type: "response.create", model: "steer-target", input: [] }));
	await created;
	const rejected = once(other, "message");
	other.send(JSON.stringify({ type: "response.steer", previous_response_id: "resp_1", input: "not mine" }));
	expect(JSON.parse((await rejected)[0].toString())).toMatchObject({
		type: "error",
		error: { code: "previous_response_not_found" },
	});
	expect(f.calls).toHaveLength(1);
});
it("keeps the local bridge readable during a quiet upstream response", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	try {
	const f = await fixture((ws, body, id) => {
		if (body.model !== "quiet") return false;
		setTimeout(() => ws.send(JSON.stringify({ type: "response.completed", response: { id, output: [] } })), 80);
		return true;
	}, { bridgeKeepAliveMs: 5, bodyReadTimeoutMs: 20 });
	const ws = await f.connect();
	const created = once(ws, "message");
	const ping = once(ws, "ping");
	const result = turn(ws, { model: "quiet", input: [] });
	await created;
	await vi.advanceTimersByTimeAsync(5);
	await ping;
	for (let elapsed = 5; elapsed < 80; elapsed += 5) {
		await vi.advanceTimersByTimeAsync(5);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	expect((await result).at(-1)?.type).toBe("response.completed");
	} finally { vi.useRealTimers(); }
});
it("times out a genuinely silent upstream independently of bridge keepalives", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	try {
	const f = await fixture((_ws, body) => body.model === "silent", {
		bridgeKeepAliveMs: 5,
		bodyReadTimeoutMs: 20,
		upstreamSilenceMs: 40,
	});
	const ws = await f.connect();
	const created = once(ws, "message");
	const result = turn(ws, { model: "silent", input: [] });
	await created;
	for (let elapsed = 0; elapsed < 40; elapsed += 5) {
		await vi.advanceTimersByTimeAsync(5);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	const events = await result;
	expect(events[0]?.type).toBe("response.created");
	expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "upstream_websocket_disconnected" } });
	expect(f.calls).toHaveLength(1);
	} finally { vi.useRealTimers(); }
});

it("does not let a completed turn's silence timer terminate a later active turn", async () => {
	let active: { socket: WebSocket; id: string } | undefined;
	const f = await fixture((upstream, body, id) => {
		if (body.model !== "active-continuation") return false;
		active = { socket: upstream, id };
		return true;
	}, { bridgeKeepAliveMs: 10_000, upstreamSilenceMs: 1000 });
	const ws = await f.connect();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		expect((await turn(ws, { model: "first", input: [] })).at(-1)?.type).toBe("response.completed");
		const created = once(ws, "message");
		const continuation = turn(ws, { model: "active-continuation", input: [], previous_response_id: "resp_1" });
		await created;
		expect(active).toBeDefined();
		await vi.advanceTimersByTimeAsync(600);
		const delta = once(ws, "message");
		active!.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "x" }));
		await delta;
		await vi.advanceTimersByTimeAsync(600);
		if (active!.socket.readyState === WebSocket.OPEN)
			active!.socket.send(JSON.stringify({ type: "response.completed", response: { id: active!.id, output: [] } }));
		expect((await continuation).at(-1)?.type).toBe("response.completed");
		expect(f.connections()).toBe(1);
		expect(f.calls).toHaveLength(2);
	} finally {
		vi.useRealTimers();
	}
});

it("does not replay after generation starts and the upstream disconnects", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const events = await turn(ws, { model: "disconnect", input: [] });
	expect(events[0]?.type).toBe("response.created");
	expect(events.at(-1)).toMatchObject({ type: "error", status: 502, error: { code: "upstream_websocket_disconnected" } });
	expect(events.at(-1)?.error).toMatchObject({ message: expect.stringContaining("Upstream WebSocket") });
	expect(f.calls).toHaveLength(1);
});
it.each(["oauth", "api", "zdr", "psp"] as const)("records sanitized %s close context without replaying generation", async (routeKind) => {
 const f = await fixture(ws => { ws.close(1011, "secret fixture reason"); return true; });
 const ws = await f.connect();
 const before = Date.now();
 await turn(ws, {model:routeKind === "oauth" ? "shared" : `${routeKind}/shared`,input:[]});
 expect(f.stats.lastDisconnect).toMatchObject({at:expect.any(Number),cause:"close",stage:"streaming",closeCode:1011,routeKind,connectionAgeMs:expect.any(Number),eventCount:1});
 expect(f.stats.lastDisconnect?.connectionAgeMs).toBeGreaterThanOrEqual(0);
 expect(f.stats.lastDisconnect?.at).toBeGreaterThanOrEqual(before);
 expect(JSON.stringify(f.stats)).not.toContain("secret fixture reason");
 expect(f.calls).toHaveLength(1);
});
it("distinguishes invalid upstream events from transport disconnects", async () => {
 const f = await fixture(ws => { ws.send("not JSON: secret"); return true; });
 const ws = await f.connect();
 await turn(ws,{model:"shared",input:[]});
 expect(f.stats.lastDisconnect).toMatchObject({at:expect.any(Number),cause:"invalid_event",stage:"streaming",routeKind:"oauth",connectionAgeMs:expect.any(Number),eventCount:1});
 expect(JSON.stringify(f.stats)).not.toContain("secret");
});
it("does not report an idle close after completion as an interrupted response", async () => {
 const f=await fixture(); const ws=await f.connect();
 await turn(ws,{model:"shared",input:[]});
 await f.disconnectUpstream();
 expect(f.stats.lastDisconnect).toBeUndefined();
 expect((await turn(ws,{model:"shared",input:[]})).at(-1)?.type).toBe("response.completed");
 expect(f.connections()).toBe(2);
});
it("cancels active generation and can start another request", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const event = once(ws, "message");
	const first = turn(ws, { model: "stall", input: [] });
	await event;
	ws.send(JSON.stringify({ type: "response.cancel" }));
	expect((await first).at(-1)?.type).toBe("error");
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)?.type).toBe(
		"response.completed",
	);
	expect(f.calls).toHaveLength(2);
	expect(f.stats.lastDisconnect).toBeUndefined();
});
it("rejects oversized frames before any upstream request", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const closed = once(ws, "close");
	ws.send(
		JSON.stringify({
			type: "response.create",
			model: "shared",
			input: [{ role: "user", content: "x".repeat(20000) }],
		}),
	);
	await closed;
	expect(f.calls).toHaveLength(0);
});
it("never shares continuation IDs between client connections", async () => {
	const f = await fixture();
	await turn(await f.connect(), { model: "shared", input: [] });
	const second = await f.connect();
	expect(
		(
			await turn(second, {
				model: "shared",
				previous_response_id: "resp_1",
				input: [],
			})
		)[0],
	).toMatchObject({ error: { code: "previous_response_not_found" } });
	expect(f.calls).toHaveLength(1);
});


it("does not inherit generate false from native prewarm into subsequent turns", async () => {
 const f = await fixture();
 const ws = await f.connect();
 const warmup = await turn(ws, {model:"shared", generate:false, input:[{role:"user",content:"hello"}]});
 expect(warmup.at(-1)?.response).toMatchObject({output:[]});
 const response = await turn(ws, {model:"shared", previous_response_id:"resp_1", input:[]});
 expect(f.calls[0]?.generate).toBe(false);
 expect(f.calls[1]).not.toHaveProperty("generate");
 expect(response.at(-1)?.response).toMatchObject({output:[{type:"message"}]});
 await turn(ws, {model:"shared", previous_response_id:"resp_2", input:[{role:"user",content:"again"}]});
 expect(f.calls[2]).not.toHaveProperty("generate");
 const secondWarmup = await turn(ws, {model:"shared", previous_response_id:"resp_3", generate:false, input:[]});
 expect(f.calls[3]?.generate).toBe(false);
 expect(secondWarmup.at(-1)?.response).toMatchObject({output:[]});
});

const toolCall={type:"custom_tool_call",id:"item-tool",call_id:"call-fixture",name:"fixture_tool",input:"fixture input"};
const toolResult={type:"custom_tool_call_output",call_id:"call-fixture",output:"fixture result"};
it.each([{output:undefined}, {output:[]}, {output:[toolCall]}])("replays streamed tool calls after rotation when terminal output is $output",async ({output:terminalOutput})=>{
 const f=await fixture((ws,body,id)=>{
  if(id!=="resp_1")return false;
  const reasoning={type:"reasoning",id:"item-reasoning",summary:[],encrypted_content:"fixture-encrypted"};
  // Completion order differs from output order. Added items are unfinished.
  for(const [index,item] of [[0,reasoning],[1,{...toolCall,input:""}]] as const)
   ws.send(JSON.stringify({type:"response.output_item.added",output_index:index,item}));
  for(const [index,item] of [[1,toolCall],[0,reasoning]] as const)
   ws.send(JSON.stringify({type:"response.output_item.done",output_index:index,item}));
  ws.send(JSON.stringify({type:"response.completed",response:{id,...(terminalOutput===undefined?{}:{output:terminalOutput})}}));
  return true;
 });
 const ws=await f.connect();
 const initial=[{role:"user",content:"Use the fixture tool"}];
 await turn(ws,{model:"shared",input:initial});
 f.useCredential("another-account");
 await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[toolResult]});
 expect(f.connections()).toBe(2);
 expect(f.calls[1]).not.toHaveProperty("previous_response_id");
 expect(f.calls[1]?.input).toEqual([...initial,expect.objectContaining({type:"reasoning",encrypted_content:"fixture-encrypted"}),toolCall,toolResult]);
});

it("refuses to cache unfinished tool history and requests full context",async()=>{
 const f=await fixture((ws,_body,id)=>{
  ws.send(JSON.stringify({type:"response.output_item.added",output_index:0,item:{...toolCall,input:""}}));
  ws.send(JSON.stringify({type:"response.completed",response:{id}}));
  return true;
 });
 const ws=await f.connect();
 await turn(ws,{model:"shared",input:[]});
 f.useCredential("another-account");
 const events=await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[toolResult]});
 expect(events.at(-1)).toMatchObject({type:"error",error:{code:"previous_response_not_found"}});
 expect(f.calls).toHaveLength(1);
});

it("does not send orphan tool results upstream during cross-account replay",async()=>{
 const f=await fixture();const ws=await f.connect();
 await turn(ws,{model:"shared",input:[]});
 f.useCredential("another-account");
 const events=await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[toolResult]});
 expect(events.at(-1)).toMatchObject({type:"error",error:{code:"previous_response_not_found"}});
 expect(f.calls).toHaveLength(1);
});

it("does not reuse a previous response ID on a replacement socket with the same credentials",async()=>{
 const f=await fixture(); const ws=await f.connect();
 await turn(ws,{model:"shared",input:[{role:"user",content:"first"}]});
 await f.disconnectUpstream();
 await turn(ws,{model:"shared",input:[{role:"user",content:"new root"}]});
 await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[{role:"user",content:"old branch"}]});
 expect(f.connections()).toBe(2);
 expect(f.calls[2]).not.toHaveProperty("previous_response_id");
 expect(f.calls[2]?.input).toEqual([{role:"user",content:"first"},expect.objectContaining({type:"message"}),{role:"user",content:"old branch"}]);
});

it("handles upgraded socket errors while authentication is pending", async()=>{
 // A local auth endpoint that holds every check open, so the probe is really pending.
 const held: import("node:http").ServerResponse[] = [];
 let received!: () => void; const probed = new Promise<void>(r => { received = r; });
 const auth=createServer((_req,res)=>{held.push(res);received();});
 const authUrl=await listen(auth);
 const server=createServer(),gateway=new ResponsesWebSocketGateway(fetch,{maxPayloadBytes:16384}),socket=new PassThrough();
 try {
  gateway.attach(server,authUrl);
  const req={headers:{},url:"/responses"} as IncomingMessage;
  server.emit("upgrade",req,socket,Buffer.alloc(0));
  await probed;
  expect(()=>socket.emit("error",Object.assign(Error("reset"),{code:"ECONNRESET"}))).not.toThrow();
 } finally {for(const res of held){res.writeHead(401);res.end();}socket.destroy();gateway.close();auth.closeAllConnections();await new Promise<void>(r=>auth.close(()=>r()));}
});

it("cancels queued creates as well as the streaming turn without blocking new work", async () => {
 const f = await fixture();
 const ws = await f.connect();
 const created = once(ws, "message");
 const first = turn(ws, {model:"stall",input:[]});
 await created;
 ws.send(JSON.stringify({type:"response.create",model:"discarded",input:[]}));
 ws.send(JSON.stringify({type:"response.cancel"}));
 expect((await first).at(-1)?.type).toBe("error");
 await turn(ws,{model:"after-cancel",input:[]});
 await vi.waitFor(()=>expect(f.calls.some(call=>call.model==="after-cancel")).toBe(true));
 expect(f.calls.map(call=>call.model)).toEqual(["stall","after-cancel"]);
});

/** Gateway in front of an arbitrary upstream; records the Response each routed turn produced. */
async function customGateway(options: {
	upstream: Server;
	apiRetry?: boolean;
 apiKind?: "api" | "zdr" | "psp";
	auth?: (req: IncomingMessage) => number | null;
	outboundHeaders?: Record<string, string>;
	maxPayloadBytes?: number;
}) {
	const upstreamUrl = await listen(options.upstream);
	cleanups.push(async () => {
		options.upstream.closeAllConnections();
		await new Promise<void>((r) => options.upstream.close(() => r()));
	});
	const gateway = new ResponsesWebSocketGateway(fetch, { maxPayloadBytes: options.maxPayloadBytes ?? 16384 });
	const runtime = new ApiModelRuntime(async (_url, init) => init?.method === "POST"
		? gateway.fetch(`${upstreamUrl}/responses`, init)
		: Response.json({data:[{id:"shared"}]}), () => Date.now());
	const responses: Response[] = [];
	const server = createServer((req, res) => {
		gateway.handle(req, async () => {
			const denied = options.auth ? options.auth(req) : req.headers.authorization === "Bearer fixture-local" ? null : 401;
			if (denied !== null) {
				res.writeHead(denied);
				res.end();
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(404);
				res.end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const response = options.apiRetry
				? await runtime.request(`${options.apiKind ?? "api"}/shared`, JSON.parse(Buffer.concat(chunks).toString()), [{id:"fixture",label:"Fixture",kind:options.apiKind ?? "api",priority:0,enabled:true,apiKey:"fixture-upstream",visibleModels:["shared"]}])
				: await gateway.fetch(`${upstreamUrl}/responses`, {
				method: "POST",
				headers: { authorization: "Bearer fixture-upstream", "content-type": "application/json", ...options.outboundHeaders },
				body: Buffer.concat(chunks),
			});
			responses.push(response);
			res.writeHead(response.status, Object.fromEntries(response.headers));
			try {
				if (response.body) for await (const chunk of response.body) res.write(chunk);
				res.end();
				if (options.apiRetry) runtime.completeRequest(response, true);
			} catch {
				res.destroy();
				if (options.apiRetry) runtime.completeRequest(response, false);
			}
		});
	});
	const baseUrl = await listen(server);
	gateway.attach(server, baseUrl);
	cleanups.push(async () => {
		gateway.close();
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	});
	const connect = async (headers: Record<string, string> = { authorization: "Bearer fixture-local" }) => {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/responses", { headers });
		cleanups.push(async () => ws.terminate());
		await once(ws, "open");
		return ws;
	};
	const handshakeStatus = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/responses", { headers });
		cleanups.push(async () => ws.terminate());
		ws.once("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); res.resume(); });
		ws.once("open", () => resolve(101));
		ws.once("error", reject);
	});
	return { stats: gateway.stats, connect, handshakeStatus, responses };
}

function rejectingUpstream(status: number, headers: Record<string, string>, onPost?: (body: string) => void): Server {
	const upstream = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		onPost?.(Buffer.concat(chunks).toString("utf8"));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_http", output: [] } })}\n\n`);
	});
	upstream.on("upgrade", (_req, socket) => {
		socket.end(`HTTP/1.1 ${status} Rejected\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}Content-Length: 0\r\nConnection: close\r\n\r\n`);
	});
	return upstream;
}

it.each(["api","zdr","psp"] as const)("keeps the local %s socket open while retrying a rejected upstream create", async kind => {
	const upstream=createServer(); const wss=new WebSocketServer({server:upstream});
	let creates=0; const received:Record<string,unknown>[]=[];
	wss.on("connection",ws=>ws.on("message",raw=>{
		received.push(JSON.parse(raw.toString())); creates++;
		ws.send(JSON.stringify(creates===1
			? {type:"error",status:429,headers:{"retry-after":"2"},error:{code:"rate_limit_exceeded"}}
			: {type:"response.completed",response:{id:"resp_recovered",output:[]}}));
	}));
	const g=await customGateway({upstream,apiRetry:true,apiKind:kind});
	cleanups.push(async()=>{for(const ws of wss.clients)ws.terminate();wss.close();});
	const ws=await g.connect();
	vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]});
	const jitter=vi.spyOn(Math,"random").mockReturnValue(0);
	let parked!:()=>void;const waiting=new Promise<void>(resolve=>{parked=resolve;});
	const fakeTimeout=globalThis.setTimeout;
	const timer=vi.spyOn(globalThis,"setTimeout").mockImplementation(((...args:Parameters<typeof setTimeout>)=>{
		const result=fakeTimeout(...args);if(args[1]===2000)parked();return result;
	}) as typeof setTimeout);
	try {
		const result=turn(ws,{model:`${kind}/shared`,input:[],reasoning:{effort:"ultra"}});
		expect(await Promise.race([waiting.then(()=>"parked"),result])).toBe("parked");
		await vi.advanceTimersByTimeAsync(1999);expect(creates).toBe(1);expect(ws.readyState).toBe(WebSocket.OPEN);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).map(event=>event.type)).toEqual(["response.completed"]);
		expect(creates).toBe(2);expect(received[1]).toMatchObject({reasoning:{effort:"ultra"}});
	} finally {timer.mockRestore();jitter.mockRestore();vi.useRealTimers();}
});

it("keeps Retry-After and quota headers from a rejected upstream handshake", async () => {
	const g = await customGateway({
		upstream: rejectingUpstream(429, { "retry-after": "120", "x-codex-primary-used-percent": "100" }),
		outboundHeaders: { "chatgpt-account-id": "acc_fixture" },
	});
	const ws = await g.connect();
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)).toMatchObject({ type: "error", status: 429, headers: {"retry-after":"120"} });
	expect(g.responses[0]?.headers.get("retry-after")).toBe("120");
	expect(g.responses[0]?.headers.get("x-codex-primary-used-percent")).toBe("100");
});

it("keeps headers carried by a pre-generation error event", async () => {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream });
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	wss.on("connection", (ws) => ws.on("message", () => ws.send(JSON.stringify({
		type: "error", status: 429, headers: { "retry-after": "45", "x-codex-secondary-used-percent": "100" },
		error: { code: "rate_limit_exceeded", message: "fixture" },
	}))));
	const g = await customGateway({ upstream, outboundHeaders: { "chatgpt-account-id": "acc_fixture" } });
	const ws = await g.connect();
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)).toMatchObject({ type: "error", status: 429 });
	expect(g.responses[0]?.headers.get("retry-after")).toBe("45");
	expect(g.responses[0]?.headers.get("x-codex-secondary-used-percent")).toBe("100");
});

it("carries handshake quota headers on the first response of a fresh upstream socket", async () => {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream });
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	wss.on("headers", (headers) => headers.push("x-codex-primary-used-percent: 42"));
	wss.on("connection", (ws) => ws.on("message", () => {
		ws.send(JSON.stringify({ type: "response.created", response: { id: "resp_q" } }));
		ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_q", output: [] } }));
	}));
	const g = await customGateway({ upstream, outboundHeaders: { "chatgpt-account-id": "acc_fixture" } });
	const ws = await g.connect();
	await turn(ws, { model: "shared", input: [] });
	expect(g.responses[0]?.headers.get("x-codex-primary-used-percent")).toBe("42");
	expect(g.responses[0]?.headers.get("content-type")).toBe("text/event-stream");
});

it("answers a transient auth outage with 503 and only a real 401 with 401", async () => {
	let status = 503;
	const g = await customGateway({ upstream: rejectingUpstream(404, {}), auth: () => status });
	expect(await g.handshakeStatus({ authorization: "Bearer fixture-local" })).toBe(503);
	status = 401;
	expect(await g.handshakeStatus({ authorization: "Bearer fixture-local" })).toBe(401);
});

it("authenticates a WebSocket upgrade that presents the client key as x-api-key", async () => {
	const g = await customGateway({
		upstream: rejectingUpstream(404, {}),
		auth: (req) => req.headers["x-api-key"] === "fixture-local" || req.headers.authorization === "Bearer fixture-local" ? null : 401,
	});
	expect(await g.handshakeStatus({ "x-api-key": "fixture-local" })).toBe(101);
	expect(await g.handshakeStatus({ "x-api-key": "wrong" })).toBe(401);
});

it("does not send the HTTP routing beta to the OAuth WebSocket endpoint", async () => {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream });
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	const betas: (string | undefined)[] = [];
	wss.on("connection", (ws, req) => {
		betas.push(req.headers["openai-beta"] as string | undefined);
		ws.on("message", () => {
		// The OAuth endpoint accepts the handshake, emits metadata, then closes
		// 1011 when the HTTP-only responses=experimental flag is combined with WS.
		if (req.headers["openai-beta"]?.includes("responses=experimental")) {
			ws.send(JSON.stringify({type: "codex.rate_limits"}));
			ws.send(JSON.stringify({type: "codex.response.metadata", headers: {}}));
			ws.close(1011);
			return;
		}
		ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_b", output: [] } }));
	});
	});
	const g = await customGateway({ upstream, outboundHeaders: { "chatgpt-account-id": "acc_fixture", "openai-beta": "responses=experimental" } });
	const ws = await g.connect({ authorization: "Bearer fixture-local", "openai-beta": "responses_websockets=2026-02-06" });
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)).toMatchObject({type: "response.completed"});
	expect(betas).toEqual(["responses_websockets=2026-02-06"]);
});

it("falls back to HTTP for an API credential whose WebSocket handshake is refused", async () => {
	const posts: string[] = [];
	const g = await customGateway({ upstream: rejectingUpstream(404, {}, (body) => posts.push(body)) });
	const ws = await g.connect();
	expect((await turn(ws, { model: "api/fixture", input: [] })).at(-1)).toMatchObject({ type: "response.completed" });
	expect((await turn(ws, { model: "api/fixture", input: [] })).at(-1)).toMatchObject({ type: "response.completed" });
	expect(posts).toHaveLength(2);
	expect(JSON.parse(posts[0]!)).toMatchObject({ model: "api/fixture", stream: true });
});

it("uses HTTP for the next API create after an unexpected upstream close", async () => {
	const posts: string[] = [];
	const upstream = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		posts.push(Buffer.concat(chunks).toString("utf8"));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_http", output: [] } })}\n\n`);
	});
	const wss = new WebSocketServer({ server: upstream });
	let websocketCreates = 0;
	wss.on("connection", (socket) => socket.on("message", () => {
		websocketCreates++;
		socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_ws" } }));
		socket.terminate();
	}));
	cleanups.push(async () => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
	const g = await customGateway({ upstream });
	const ws = await g.connect();
	expect((await turn(ws, { model: "api/fixture", input: [] })).at(-1)).toMatchObject({ type: "error", status: 502 });
	expect((await turn(ws, { model: "api/fixture", input: [] })).at(-1)?.type).toBe("response.completed");
	expect(websocketCreates).toBe(1);
	expect(posts).toHaveLength(1);
});

it.each([undefined, false, true])("preserves caller permission metadata during HTTP recovery (%s)", async (enabled) => {
	const posts: string[] = [];
	const receivedHeaders: IncomingMessage["headers"][] = [];
	const upstream = rejectingUpstream(404, {}, (body) => posts.push(body));
	upstream.prependListener("request", (req) => {
		if (req.method === "POST") receivedHeaders.push(req.headers);
	});
	const metadata = enabled === undefined ? undefined : {
		sandbox: enabled ? "seatbelt" : "none",
		auto_review_enabled: enabled,
	};
	const encoded = metadata === undefined ? undefined : JSON.stringify(metadata);
	const clientMetadata = metadata === undefined ? undefined : {
		...metadata, "x-codex-turn-metadata": encoded,
	};
	const g = await customGateway({ upstream, outboundHeaders: {
		"openai-beta": "responses=experimental",
		...(encoded === undefined ? {} : { "x-codex-turn-metadata": encoded }),
	} });
	const ws = await g.connect({ authorization: "Bearer fixture-local", "openai-beta": "responses_websockets=2026-02-06" });
	expect((await turn(ws, { model: "api/fixture", input: [], client_metadata: clientMetadata })).at(-1)?.type).toBe("response.completed");
	expect(posts).toHaveLength(1);
	expect(JSON.parse(posts[0]!).client_metadata).toEqual(clientMetadata);
	expect(receivedHeaders[0]?.["x-codex-turn-metadata"]).toBe(encoded);
	expect(receivedHeaders[0]?.["openai-beta"]).toBe("responses=experimental");
});

it("does not fall back to HTTP for a ChatGPT workspace whose handshake is refused", async () => {
	const posts: string[] = [];
	const g = await customGateway({ upstream: rejectingUpstream(403, {}, (body) => posts.push(body)), outboundHeaders: { "chatgpt-account-id": "acc_fixture" } });
	const ws = await g.connect();
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)).toMatchObject({ type: "error", status: 403 });
	expect(posts).toHaveLength(0);
});

it("does not replay a sent create when a reused socket closes before its first event", async () => {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream });
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	let connections = 0; let messages = 0;
	wss.on("connection", (ws) => {
		connections++;
		ws.on("message", () => {
			messages++;
			if (messages === 2) { ws.terminate(); return; }
			ws.send(JSON.stringify({ type: "response.created", response: { id: `resp_${messages}` } }));
			ws.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${messages}`, output: [] } }));
		});
	});
	const g = await customGateway({ upstream, outboundHeaders: { "chatgpt-account-id": "acc_fixture" } });
	const ws = await g.connect();
	await turn(ws, { model: "shared", input: [] });
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)).toMatchObject({ type: "error" });
	expect(connections).toBe(1);
	expect(messages).toBe(2);
	expect(g.stats.lastDisconnect).toMatchObject({cause:"close",stage:"awaiting_first_event",closeCode:1006});
});

it("keeps loopback hops off an environment HTTP proxy", async () => {
	const undici = await import("undici");
	const previous = undici.getGlobalDispatcher();
	const f = await fixture();
	undici.setGlobalDispatcher(new undici.ProxyAgent("http://127.0.0.1:9"));
	try {
		const ws = await f.connect();
		expect((await turn(ws, { model: "shared", input: [] })).at(-1)).toMatchObject({ type: "response.completed" });
	} finally {
		undici.setGlobalDispatcher(previous);
	}
});

it("ends a turn on response.cancelled so queued creates are not held behind it", async () => {
	const f = await fixture((ws, body, id) => {
		if (body.model !== "cancelled-upstream") return false;
		ws.send(JSON.stringify({ type: "response.cancelled", response: { id, status: "cancelled" } }));
		return true;
	});
	const ws = await f.connect();
	const events: Record<string, unknown>[] = [];
	ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
	ws.send(JSON.stringify({ type: "response.create", model: "cancelled-upstream", input: [] }));
	await vi.waitFor(() => expect(events.some((event) => event.type === "response.cancelled")).toBe(true));
	expect((await turn(ws, { model: "after", input: [] })).at(-1)).toMatchObject({ type: "response.completed" });
	expect(f.calls.map((call) => call.model)).toEqual(["cancelled-upstream", "after"]);
});

it("keeps the real status of a per-turn error with an empty body", async () => {
	const g = await customGateway({ upstream: rejectingUpstream(404, {}), auth: (req) => req.method === "POST" ? 401 : null });
	const ws = await g.connect();
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)).toMatchObject({ type: "error", status: 401, error: { code: "websocket_request_failed" } });
});


it("does not diagnose a local request timeout as an upstream disconnect",async()=>{
 const controller=new AbortController();
 const f=await fixture(undefined,{signal:controller.signal});const ws=await f.connect();
 const created=once(ws,"message");const pending=turn(ws,{model:"stall",input:[]});
 await created;controller.abort(new DOMException("Timeout","TimeoutError"));
 await pending;
 expect(f.stats.lastDisconnect).toBeUndefined();
 expect(f.stats.upstreamRequests).toBe(1);
});

it.each(["transport_error","buffer_limit"] as const)("records one %s diagnostic without replay even when close follows",async(cause)=>{
 const f=await fixture();const ws=await f.connect();
 const created=once(ws,"message");const pending=turn(ws,{model:"stall",input:[]});await created;
 const peer=[...f.peers][0]!;
 if(cause==="transport_error")peer.emit("error",Error("secret transport error"));
 else for(let i=0;i<8;i++)peer.emit("message",Buffer.from(JSON.stringify({type:"response.output_text.delta",delta:"x".repeat(8192)})),false);
 const diagnostic=f.stats.lastDisconnect;
 peer.emit("close",1006,Buffer.from("secret close reason"));
 await pending;
 expect(f.stats.lastDisconnect).toBe(diagnostic);
 expect(diagnostic).toMatchObject({cause,stage:"streaming"});
 expect(JSON.stringify(diagnostic)).not.toContain("secret");
 expect(f.stats.upstreamRequests).toBe(1);
 expect(f.calls).toHaveLength(1);
 peer.terminate();
});

it("records a send callback failure without replaying the create",async()=>{
 const f=await fixture(undefined,{sendFailure:true});const ws=await f.connect();
 await turn(ws,{model:"shared",input:[]});
 expect(f.stats.lastDisconnect).toMatchObject({cause:"send_error",stage:"awaiting_first_event",sendCompleted:false,transportErrorCode:"OTHER",requestBytes:expect.any(Number),inputItemCount:0});
 const peer=[...f.peers][0]!;
 expect(peer.readyState).not.toBe(WebSocket.OPEN);
 if(peer.readyState!==WebSocket.CLOSED)await once(peer,"close");
 expect(peer.readyState).toBe(WebSocket.CLOSED);
 expect(f.stats.upstreamRequests).toBe(1);
 expect(f.calls).toHaveLength(0);
});

it("does not diagnose response body cancellation as an upstream disconnect",async()=>{
 const controller=new AbortController();
 let cancelled!:()=>void;const cancellation=new Promise<void>(resolve=>{cancelled=resolve;});
 const f=await fixture(undefined,{signal:controller.signal,cancelBody:cancelled});
 const ws=await f.connect();
 ws.send(JSON.stringify({type:"response.create",model:"stall",input:[]}));
 await cancellation;
 expect(controller.signal.aborted).toBe(false);
 expect(f.stats.lastDisconnect).toBeUndefined();
 expect([...f.peers].every(peer=>peer.readyState===WebSocket.CLOSED)).toBe(true);
 expect(f.stats.upstreamRequests).toBe(1);
 expect(f.calls).toHaveLength(1);
});

it.each([
	{name: "future client flags", current: "responses=experimental, routing=fixture", client: "responses_websockets=future, custom=one, custom=one", expected: "routing=fixture, responses_websockets=future, custom=one"},
	{name: "missing client beta", current: "responses=experimental", client: undefined, expected: undefined},
	{name: "explicit client HTTP beta", current: "responses=experimental", client: "responses=experimental, client=explicit", expected: "responses=experimental, client=explicit"},
	{name: "API beta flags", current: "api=fixture", client: "responses_websockets=future", expected: "api=fixture, responses_websockets=future"},
])("preserves beta provenance for $name", async ({current, client, expected}) => {
	const upstream = createServer();
	const wss = new WebSocketServer({server: upstream});
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	const betas: (string | undefined)[] = [];
	wss.on("connection", (ws, req) => {
		betas.push(req.headers["openai-beta"] as string | undefined);
		ws.on("message", () => ws.send(JSON.stringify({type: "response.completed", response: {id: "resp_beta", output: []}})));
	});
	const g = await customGateway({upstream, outboundHeaders: {"openai-beta": current}});
	const headers: Record<string, string> = {authorization: "Bearer fixture-local"};
	if (client !== undefined) headers["openai-beta"] = client;
	const ws = await g.connect(headers);
	expect((await turn(ws, {model: "api/fixture", input: []})).at(-1)?.type).toBe("response.completed");
	expect(betas).toEqual([expected]);
});


it.each([
	{ mode: "end", reused: false, prewarm: false },
	{ mode: "reset", reused: false, prewarm: false },
	{ mode: "end", reused: true, prewarm: true },
])("records safe transport evidence for $mode before the first event (reused=$reused)", async ({ mode, reused, prewarm }) => {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream });
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	let messages = 0;
	let requestBytes = 0;
	wss.on("connection", (ws, req) => ws.on("message", raw => {
		messages++;
		if (reused && messages === 1) {
			ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", output: [] } }));
			return;
		}
		requestBytes = Buffer.byteLength(raw.toString());
		if (mode === "reset") req.socket.resetAndDestroy();
		else req.socket.end();
	}));
	const g = await customGateway({ upstream, outboundHeaders: { "chatgpt-account-id": "acc_fixture" } });
	const ws = await g.connect();
	if (reused) await turn(ws, { model: "shared", input: [] });
	const events = await turn(ws, {
		model: "shared", input: [{ role: "user", content: "private-prompt 🔒" }],
		...(prewarm ? { generate: false } : {}),
		...(reused ? { previous_response_id: "resp_fixture" } : {}),
	});
	expect(events.at(-1)?.type).toBe("error");
	expect(g.stats.lastDisconnect).toMatchObject({
		cause: "close", closeCode: 1006, stage: "awaiting_first_event",
		requestBytes, inputItemCount: 1, isPrewarm: prewarm, hasPreviousResponse: reused,
		reusedConnection: reused, sendCompleted: true, compressionNegotiated: false,
		tcpEndReceived: mode === "end", tcpCloseHadError: mode === "reset",
	});
	if (mode === "reset") expect(g.stats.lastDisconnect?.transportErrorCode).toBe("ECONNRESET");
	else expect(g.stats.lastDisconnect).not.toHaveProperty("transportErrorCode");
	expect(messages).toBe(reused ? 2 : 1);
	expect(g.stats.upstreamRequests).toBe(messages);
	expect(JSON.stringify(g.stats.lastDisconnect)).not.toMatch(/private-prompt|resp_fixture|acc_fixture/);
});

it.each(["EPIPE", "ETIMEDOUT", "private-code"])("allowlists transport error codes: %s", async code => {
	const f = await fixture();
	const ws = await f.connect();
	const created = once(ws, "message");
	const pending = turn(ws, { model: "stall", input: [] });
	await created;
	const peer = [...f.peers][0]!;
	peer.emit("error", Object.assign(Error("private-error-message"), { code }));
	await pending;
	expect(f.stats.lastDisconnect).toMatchObject({ transportErrorCode: code === "private-code" ? "OTHER" : code });
	expect(JSON.stringify(f.stats.lastDisconnect)).not.toMatch(/private-code|private-error-message/);
	expect(f.stats.upstreamRequests).toBe(1);
	peer.terminate();
});

it("negotiates bounded upstream compression and transmits the full request with fewer wire bytes", async () => {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream, perMessageDeflate: true });
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	const received: { extensions: string; wireBytes: number; body: Record<string, unknown> }[] = [];
	wss.on("connection", (ws, req) => {
		const before = req.socket.bytesRead;
		ws.on("message", raw => {
			received.push({ extensions: ws.extensions, wireBytes: req.socket.bytesRead - before, body: JSON.parse(raw.toString()) });
			ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_compressed", output: [] } }));
		});
	});
	const g = await customGateway({ upstream, outboundHeaders: { "chatgpt-account-id": "acc_fixture" } });
	const ws = await g.connect();
	const input = [{ role: "user", content: [{ type: "input_text", text: "synthetic padding ".repeat(500) }] }];
	expect((await turn(ws, { model: "shared", input })).at(-1)?.type).toBe("response.completed");
	expect(received).toHaveLength(1);
	expect(received[0]?.extensions).toBe("permessage-deflate");
	expect(received[0]?.body.input).toEqual(input);
	expect(received[0]?.wireBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(input)) / 4);
});

it("enforces the decompressed upstream payload limit without replay or HTTP fallback", async () => {
	let posts = 0, requests = 0, extensions = "";
	const upstream = createServer((_req, res) => { posts++; res.writeHead(500); res.end(); });
	const wss = new WebSocketServer({ server: upstream, perMessageDeflate: true });
	cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
	wss.on("connection", ws => {
		extensions = ws.extensions;
		ws.on("error", () => {});
		ws.on("message", () => {
			requests++;
			ws.send(JSON.stringify({ type: "response.output_text.delta", delta: "synthetic output ".repeat(4000) }));
		});
	});
	const g = await customGateway({ upstream, outboundHeaders: { "chatgpt-account-id": "acc_fixture" } });
	const ws = await g.connect();
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)?.type).toBe("error");
	expect(extensions).toBe("permessage-deflate");
	expect(requests).toBe(1);
	expect(posts).toBe(0);
	expect(g.stats.lastDisconnect).toMatchObject({ cause: "transport_error", stage: "awaiting_first_event", eventCount: 0 });
});


it("routes oversized UTF-8 creates over HTTP without downgrading the client socket or generating prewarm", async () => {
 const posts: string[] = [];
 const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  posts.push(Buffer.concat(chunks).toString());
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({type: "response.completed", response: {id: "resp_http_large", output: []}})}\n\n`);
 });
 const wss = new WebSocketServer({server: upstream});
 cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
 const creates: Record<string, unknown>[] = [];
 wss.on("connection", ws => ws.on("message", raw => {
  creates.push(JSON.parse(raw.toString()));
  ws.send(JSON.stringify({type: "response.completed", response: {id: "resp_small", output: []}}));
 }));
 const g = await customGateway({upstream, maxPayloadBytes: 12 * 1024 * 1024, outboundHeaders: {"chatgpt-account-id": "fixture-workspace"}});
 const ws = await g.connect();
 const input = [{role: "user", content: "é".repeat(4 * 1024 * 1024)}];
 expect((await turn(ws, {model: "fixture", input, generate: false})).at(-1)).toMatchObject({type: "response.completed"});
 expect(posts).toHaveLength(0);
 expect(creates).toHaveLength(0);
 expect((await turn(ws, {model: "fixture", input})).at(-1)).toMatchObject({type: "response.completed"});
 expect(posts).toHaveLength(1);
 expect(JSON.parse(posts[0]!)).toMatchObject({input, stream: true});
 expect(creates).toHaveLength(0);
 expect((await turn(ws, {model: "fixture", input: []})).at(-1)).toMatchObject({type: "response.completed"});
 expect(creates).toHaveLength(1);
 expect(posts).toHaveLength(1);
 expect(ws.readyState).toBe(WebSocket.OPEN);
});


it("retries API WebSocket support after a temporary handshake rejection", async () => {
 const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
 let upgrades = 0;
 let posts = 0;
 const upstream = rejectingUpstream(404, {}, () => { posts++; });
 upstream.on("upgrade", () => { upgrades++; });
 const g = await customGateway({upstream});
 const ws = await g.connect();
 await turn(ws, {model: "api/fixture", input: []});
 await turn(ws, {model: "api/fixture", input: []});
 expect(upgrades).toBe(1);
 now.mockReturnValue(160_001);
 await turn(ws, {model: "api/fixture", input: []});
 expect(upgrades).toBe(2);
 expect(posts).toBe(3);
});


it("restores WebSockets with complete tool history after HTTP recovery without replaying failed creates", async () => {
 const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
 const posts: Record<string, unknown>[] = [];
 const creates: Record<string, unknown>[] = [];
 const call = {type: "function_call", call_id: "call_recovery", name: "fixture", arguments: "{}"};
 const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  posts.push(JSON.parse(Buffer.concat(chunks).toString()));
  res.writeHead(200, {"content-type": "text/event-stream"});
  res.end(`data: ${JSON.stringify({type: "response.completed", response: {id: "resp_recovery", output: [call]}})}\n\n`);
 });
 const wss = new WebSocketServer({server: upstream});
 cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
 wss.on("connection", ws => ws.on("message", raw => {
  creates.push(JSON.parse(raw.toString()));
  if (creates.length <= 2) ws.close(1011);
  else ws.send(JSON.stringify({type: "response.completed", response: {id: "resp_restored", output: []}}));
 }));
 const g = await customGateway({upstream, outboundHeaders: {"chatgpt-account-id": "fixture-workspace"}});
 const ws = await g.connect({authorization: "Bearer fixture-local", "thread-id": "fixture-recovery"});
 for (let i = 0; i < 2; i++) expect((await turn(ws, {model: "fixture", input: []})).at(-1)?.type).toBe("error");
 expect(posts).toHaveLength(0);
 const input = [{role: "user", content: "fixture input"}];
 expect((await turn(ws, {model: "fixture", input})).at(-1)?.type).toBe("response.completed");
 expect(creates).toHaveLength(2);
 now.mockReturnValue(160_001);
 const result = {type: "function_call_output", call_id: "call_recovery", output: "done"};
 expect((await turn(ws, {model: "fixture", previous_response_id: "resp_recovery", input: [result]})).at(-1)?.type).toBe("response.completed");
 expect(posts).toHaveLength(1);
 expect(creates).toHaveLength(3);
 expect(creates[2]).toMatchObject({input: [...input, call, result]});
 expect(creates[2]).not.toHaveProperty("previous_response_id");
});

it("keeps API handshake backoff across local reconnects and isolates credentials", async () => {
 const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
 let upgrades = 0;
 let posts = 0;
 const upstream = rejectingUpstream(404, {}, () => { posts++; });
 upstream.on("upgrade", () => { upgrades++; });
 const outboundHeaders = {authorization: "Bearer fixture-first"};
 const g = await customGateway({upstream, outboundHeaders});
 const ws = await g.connect();
 await turn(ws, {model: "api/fixture", input: []});
 const closed = once(ws, "close"); ws.close(); await closed;
 const replacement = await g.connect();
 await turn(replacement, {model: "api/fixture", input: []});
 expect(upgrades).toBe(1);
 now.mockReturnValue(160_001);
 await turn(replacement, {model: "api/fixture", input: []});
 expect(upgrades).toBe(2);
 expect(posts).toBe(3);
 outboundHeaders.authorization = "Bearer fixture-second";
 await turn(replacement, {model: "api/fixture", input: []});
 expect(upgrades).toBe(3);
});

it("retains API handshake backoff for all 100 supported route credentials", async () => {
 vi.spyOn(Date, "now").mockReturnValue(100_000);
 let upgrades = 0;
 const upstream = rejectingUpstream(404, {});
 upstream.on("upgrade", () => { upgrades++; });
 const outboundHeaders = {authorization: "Bearer fixture-0"};
 const g = await customGateway({upstream, outboundHeaders});
 const ws = await g.connect();
 for (let i = 0; i < 100; i++) {
  outboundHeaders.authorization = `Bearer fixture-${i}`;
  await turn(ws, {model: "api/fixture", input: []});
 }
 expect(upgrades).toBe(100);
 const closed = once(ws, "close"); ws.close(); await closed;
 const replacement = await g.connect();
 for (let i = 0; i < 100; i++) {
  outboundHeaders.authorization = `Bearer fixture-${i}`;
  await turn(replacement, {model: "api/fixture", input: []});
 }
 expect(upgrades).toBe(100);
});

it.each([
	["interrupted", true],
	["max_output_tokens", false],
])("remembers a response.incomplete chain only when it was interrupted (%s)", async (reason, chainable) => {
	const kept = { id: "kept", type: "message", role: "assistant", content: [{ type: "output_text", text: "partial answer" }] };
	const f = await fixture((ws, body, id) => {
		if (body.previous_response_id !== undefined || id !== "resp_1") return false;
		ws.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...kept, content: [] } }));
		ws.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item: kept }));
		ws.send(JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { id: "discarded", type: "reasoning", summary: [] } }));
		ws.send(JSON.stringify({ type: "response.output_item.interrupted", item_id: "discarded", output_index: 1 }));
		ws.send(JSON.stringify({ type: "response.incomplete", response: { id, status: "incomplete", incomplete_details: { reason }, output: [kept] } }));
		return true;
	});
	const ws = await f.connect();
	const initial = [{ role: "user", content: "start" }];
	expect((await turn(ws, { model: "shared", input: initial })).at(-1)?.type).toBe("response.incomplete");
	// A different account cannot see resp_1 upstream, so the gateway must
	// rebuild the continuation from the chain it remembered locally.
	f.useCredential("another-account");
	const followUp = { role: "user", content: "continue" };
	const events = await turn(ws, { model: "shared", previous_response_id: "resp_1", input: [followUp] });
	if (!chainable) {
		expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "previous_response_not_found" } });
		expect(f.calls).toHaveLength(1);
		return;
	}
	expect(events.at(-1)?.type).toBe("response.completed");
	expect(f.calls).toHaveLength(2);
	expect(f.calls[1]).not.toHaveProperty("previous_response_id");
	expect(f.calls[1]?.input).toEqual([...initial, kept, followUp]);
});

it("answers a Responses upgrade with 426 when the gateway does not serve Responses sockets", async () => {
	const gateway = new ResponsesWebSocketGateway(fetch, { maxPayloadBytes: 16384 });
	const server = createServer((req, res) => {
		gateway.handle(req, async () => {
			// Authenticated unknown paths are 404; anything else is unauthorized.
			res.writeHead(req.headers.authorization === "Bearer fixture-local" ? 404 : 401);
			res.end();
		});
	});
	const baseUrl = await listen(server);
	gateway.attach(server, baseUrl, { responses: false });
	cleanups.push(async () => {
		gateway.close();
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	});
	const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/responses", {
		headers: { authorization: "Bearer fixture-local" },
	});
	// A rejected handshake leaves the client CONNECTING; terminating it then
	// emits an error that is expected here.
	ws.on("error", () => undefined);
	cleanups.push(async () => ws.terminate());
	const [, response] = (await once(ws, "unexpected-response")) as [unknown, IncomingMessage];
	expect(response.statusCode).toBe(426);
	expect(response.headers.connection).toBe("close");
	expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
	const chunks: Buffer[] = [];
	for await (const chunk of response) chunks.push(Buffer.from(chunk));
	expect(JSON.parse(Buffer.concat(chunks).toString("utf8")).error.code).toBe("runtime_rotation_proxy_http_required");
});
