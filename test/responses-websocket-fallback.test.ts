import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { ResponsesWebSocketGateway } from "../lib/runtime/responses-websocket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
	// No global restoreMocks is configured: restore Date.now/spies here so the
	// cooldown tests cannot leak fake clocks into later cases.
	vi.restoreAllMocks();
});

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Missing fixture address");
	return `http://127.0.0.1:${address.port}`;
}

function credential(headers: IncomingHttpHeaders): string | undefined {
	return headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
		?? (typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : undefined);
}

async function fixture() {
	let websocketCreates = 0;
	let httpCreates = 0;
	const controlledRequests = new Map<string, WebSocket>();
	const upstream = createServer((_req, res) => {
		httpCreates++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_http", output: [] } })}\n\n`);
	});
	const wss = new WebSocketServer({ server: upstream });
	wss.on("connection", ws => ws.on("message", raw => {
		websocketCreates++;
		const body = JSON.parse(raw.toString());
		if (body.model.startsWith("controlled-")) controlledRequests.set(body.model, ws);
		if (body.model.startsWith("rejected-")) {
			ws.send(JSON.stringify({ type: "error", status: Number(body.model.slice(9)), error: { code: "fixture_rejection" } }));
			return;
		}
		if (body.model !== "before-first-event") {
			ws.send(JSON.stringify({ type: "codex.rate_limits" }));
			ws.send(JSON.stringify({ type: "codex.response.metadata" }));
		}
		if (body.generate === false || body.model === "success") {
			ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_success", output: [] } }));
			return;
		}
		if (body.model !== "stall" && !body.model.startsWith("controlled-")) ws.close(1011);
	}));
	const upstreamUrl = await listen(upstream);
	cleanups.push(async () => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
		upstream.closeAllConnections();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	});
	const gateway = new ResponsesWebSocketGateway(fetch, { maxPayloadBytes: 16384 });
	const server = createServer((req, res) => gateway.handle(req, async () => {
		if (!["fixture-a", "fixture-b"].includes(credential(req.headers) ?? "")) {
			res.writeHead(401).end();
			return;
		}
		if (req.method !== "POST" || req.url !== "/responses") {
			res.writeHead(404).end();
			return;
		}
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const response = await gateway.fetch(`${upstreamUrl}/responses`, {
				method: "POST",
				headers: { authorization: "Bearer fixture-upstream", "chatgpt-account-id": "fixture-workspace", "content-type": "application/json" },
				body: Buffer.concat(chunks),
			});
			res.writeHead(response.status, Object.fromEntries(response.headers));
			if (response.body) for await (const chunk of response.body) res.write(chunk);
			res.end();
		} catch {
			res.destroy();
		}
	}));
	const baseUrl = await listen(server);
	gateway.attach(server, baseUrl);
	cleanups.push(async () => {
		gateway.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	async function connect(headers: Record<string, string>, path = "/responses") {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + path, { headers });
		cleanups.push(async () => ws.terminate());
		const status = await new Promise<number>((resolve, reject) => {
			ws.once("open", () => resolve(101));
			ws.once("unexpected-response", (_req, res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
				ws.terminate();
			});
			ws.on("error", reject);
		});
		return { ws, status };
	}
	function finishControlled(model: string, outcome: "disconnect" | "complete") {
		const ws = controlledRequests.get(model);
		if (!ws) throw Error(`No pending fixture request for ${model}`);
		controlledRequests.delete(model);
		if (outcome === "disconnect") ws.close(1011);
		else ws.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${model}`, output: [] } }));
	}
	return { connect, baseUrl, finishControlled, stats: gateway.stats, counts: () => ({ websocketCreates, httpCreates }) };
}

const scope = { authorization: "Bearer fixture-a", session_id: "fixture-session", conversation_id: "fixture-thread" };

function request(ws: WebSocket, model = "disconnect", generate?: boolean): Promise<void> {
	const done = new Promise<void>(resolve => {
		const onMessage = (raw: WebSocket.RawData) => {
			if (!["error", "response.completed"].includes(JSON.parse(raw.toString()).type)) return;
			ws.off("message", onMessage);
			resolve();
		};
		ws.on("message", onMessage);
	});
	ws.send(JSON.stringify({ type: "response.create", model, input: [], ...(generate === undefined ? {} : { generate }) }));
	return done;
}

async function disconnect(g: Awaited<ReturnType<typeof fixture>>, headers = scope, model = "disconnect") {
	const { ws, status } = await g.connect(headers);
	expect(status).toBe(101);
	await request(ws, model);
	const closed = once(ws, "close");
	ws.terminate();
	await closed;
}

async function repeatedDisconnect(g: Awaited<ReturnType<typeof fixture>>, headers = scope, model = "disconnect") {
	await disconnect(g, headers, model);
	await disconnect(g, headers, model);
}

async function expectHttpRecovery(g: Awaited<ReturnType<typeof fixture>>, headers: Record<string, string> = scope) {
 const before = g.counts();
 const {ws, status} = await g.connect(headers);
 expect(status).toBe(101);
 await request(ws, "success");
 expect(g.counts()).toEqual({websocketCreates: before.websocketCreates, httpCreates: before.httpCreates + 1});
 const closed = once(ws, "close");
 ws.terminate();
 await closed;
}

it.each(["before-first-event", "disconnect"])("allows one fresh WebSocket retry before HTTP recovery after %s without replay", async model => {
 const g = await fixture();
 await repeatedDisconnect(g, scope, model);
 expect(g.counts()).toEqual({ websocketCreates: 2, httpCreates: 0 });
 await expectHttpRecovery(g);
 expect(g.counts()).toEqual({ websocketCreates: 2, httpCreates: 1 });
});

async function startControlled(g: Awaited<ReturnType<typeof fixture>>, model: string) {
	const { ws, status } = await g.connect(scope);
	expect(status).toBe(101);
	const started = once(ws, "message");
	const done = request(ws, model);
	await started;
	return async (outcome: "disconnect" | "complete") => {
		g.finishControlled(model, outcome);
		await done;
	};
}

it("combines disconnects from concurrent sockets in the same scope without replay", async () => {
	const g = await fixture();
	const [first, second] = await Promise.all([
		startControlled(g, "controlled-first"),
		startControlled(g, "controlled-second"),
	]);
	await Promise.all([first("disconnect"), second("disconnect")]);
	await expectHttpRecovery(g, scope);
	expect(g.counts()).toEqual({ websocketCreates: 2, httpCreates: 1 });
});

it.each(["failure-first", "completion-first"])("orders shared failure recovery by concurrent socket events: %s", async order => {
	const g = await fixture();
	await disconnect(g);
	const [failed, completed] = await Promise.all([
		startControlled(g, "controlled-failed"),
		startControlled(g, "controlled-completed"),
	]);
	if (order === "failure-first") {
		await failed("disconnect");
		await expectHttpRecovery(g, scope);
		await completed("complete");
		expect((await g.connect(scope)).status).toBe(101);
		// The completion also clears the failure recorded by the other socket.
		await disconnect(g);
		expect((await g.connect(scope)).status).toBe(101);
	} else {
		await completed("complete");
		await failed("disconnect");
		// A later failure survives the earlier completion, but still gets one retry.
		expect((await g.connect(scope)).status).toBe(101);
	}
	await disconnect(g);
	await expectHttpRecovery(g, scope);
	expect(g.counts()).toEqual({ websocketCreates: order === "failure-first" ? 5 : 4, httpCreates: order === "failure-first" ? 2 : 1 });
});

it("isolates fallback by authenticated client and thread, including shared session IDs", async () => {
	const g = await fixture();
	await repeatedDisconnect(g);
	expect((await g.connect({ ...scope, conversation_id: "other-thread" })).status).toBe(101);
	expect((await g.connect({ ...scope, authorization: "Bearer fixture-b" })).status).toBe(101);
	await expectHttpRecovery(g, scope);
});

it("normalizes bearer and API-key client authentication for the same session", async () => {
	const g = await fixture();
	await repeatedDisconnect(g, { authorization: "bearer   fixture-a", session_id: "fixture-session", conversation_id: "fixture-thread" });
	await expectHttpRecovery(g, { "x-api-key": "fixture-a", session_id: "fixture-session", conversation_id: "fixture-thread" });
});

it.each(["thread-id", "session-id", "session_id", "conversation_id"])("supports a native scope containing only %s", async header => {
	const g = await fixture();
	const headers = { authorization: "Bearer fixture-a", [header]: "fixture-scope" };
	await repeatedDisconnect(g, headers);
	await expectHttpRecovery(g, headers);
});

it("prefers native thread-id over conflicting legacy conversation and session aliases", async () => {
	const g = await fixture();
	const headers = { ...scope, "thread-id": "native-thread", "session-id": "native-session" };
	await repeatedDisconnect(g, headers);
	expect((await g.connect({ ...headers, "thread-id": "sibling-thread" })).status).toBe(101);
	await expectHttpRecovery(g, { ...headers, conversation_id: "different-legacy-thread", "session-id": "different-session", session_id: "different-legacy-session" });
});

it("prefers a legacy conversation over shared session aliases when native thread-id is absent", async () => {
	const g = await fixture();
	const headers = { ...scope, "session-id": "native-session" };
	await repeatedDisconnect(g, headers);
	expect((await g.connect({ ...headers, conversation_id: "sibling-thread" })).status).toBe(101);
	await expectHttpRecovery(g, { ...headers, "session-id": "different-session" });
});

it("prefers native session-id over conflicting legacy session_id when no thread is provided", async () => {
	const g = await fixture();
	const headers = { authorization: "Bearer fixture-a", "session-id": "native-session", session_id: "legacy-session" };
	await repeatedDisconnect(g, headers);
	expect((await g.connect({ ...headers, "session-id": "other-native-session" })).status).toBe(101);
	await expectHttpRecovery(g, { ...headers, session_id: "other-legacy-session" });
});

it("does not use a global cooldown when the client has no stable scope", async () => {
	const g = await fixture();
	const headers = { authorization: "Bearer fixture-a" };
	await repeatedDisconnect(g, headers);
	expect((await g.connect(headers)).status).toBe(101);
	expect((await g.connect(scope)).status).toBe(101);
});

it("checks authentication, origin, and path before applying fallback", async () => {
	const g = await fixture();
	await repeatedDisconnect(g);
	expect((await g.connect({ ...scope, authorization: "Bearer invalid" })).status).toBe(401);
	expect((await g.connect({ ...scope, origin: "https://example.com" })).status).toBe(403);
	expect((await g.connect(scope, "/unknown")).status).toBe(404);
	await expectHttpRecovery(g, scope);
});

it("expires fallback after a short cooldown so a recovered transport can be retried", async () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
	const g = await fixture();
	await repeatedDisconnect(g);
	await expectHttpRecovery(g, scope);
	now.mockReturnValue(160_001);
	expect((await g.connect(scope)).status).toBe(101);
});

it("bounds the number of retained fallback scopes", async () => {
	const g = await fixture();
	for (let i = 0; i <= 256; i++) {
		await repeatedDisconnect(g, { ...scope, conversation_id: `fixture-thread-${i}` });
	}
	expect((await g.connect({ ...scope, conversation_id: "fixture-thread-0" })).status).toBe(101);
	await expectHttpRecovery(g, { ...scope, conversation_id: "fixture-thread-256" });
	expect(g.counts()).toEqual({ websocketCreates: 514, httpCreates: 1 });
}, 15_000);

it.each([401, 403, 429])("does not downgrade after an explicit upstream %s error", async status => {
	const g = await fixture();
	await disconnect(g);
	await disconnect(g, scope, `rejected-${status}`);
	expect((await g.connect(scope)).status).toBe(101);
});

it("does not downgrade after client cancellation", async () => {
	const g = await fixture();
	await disconnect(g);
	const previousDisconnect = g.stats.lastDisconnect;
	const { ws } = await g.connect(scope);
	const firstEvent = once(ws, "message");
	const done = request(ws, "stall");
	await firstEvent;
	ws.send(JSON.stringify({ type: "response.cancel" }));
	await done;
	expect(g.stats.lastDisconnect).toBe(previousDisconnect);
	expect((await g.connect(scope)).status).toBe(101);
	expect(g.counts()).toEqual({ websocketCreates: 2, httpCreates: 0 });
});

it("keeps WebSockets after a successful fresh connection and resets failure history", async () => {
	const g = await fixture();
	await disconnect(g);
	const { ws, status } = await g.connect(scope);
	expect(status).toBe(101);
	await request(ws, "success");
	ws.terminate();
	await disconnect(g);
	expect((await g.connect(scope)).status).toBe(101);
	expect(g.counts()).toEqual({ websocketCreates: 3, httpCreates: 0 });
});

it("does not let successful non-generating prewarm erase a repeated disconnect", async () => {
	const g = await fixture();
	await disconnect(g);
	const { ws, status } = await g.connect(scope);
	expect(status).toBe(101);
	await request(ws, "prewarm", false);
	await request(ws);
	ws.terminate();
	await expectHttpRecovery(g, scope);
	expect(g.counts()).toEqual({ websocketCreates: 3, httpCreates: 1 });
});

it("does not combine failures that are separated by the cooldown window", async () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
	const g = await fixture();
	await disconnect(g);
	now.mockReturnValue(160_001);
	await disconnect(g);
	expect((await g.connect(scope)).status).toBe(101);
});

it("keeps the native socket open during HTTP recovery and automatically returns upstream to WebSockets", async () => {
 const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
 const g = await fixture();
 await repeatedDisconnect(g);
 expect(g.counts()).toEqual({websocketCreates: 2, httpCreates: 0});
 const recovered = await g.connect(scope);
 expect(recovered.status).toBe(101);
 await request(recovered.ws, "prewarm", false);
 expect(g.counts()).toEqual({websocketCreates: 2, httpCreates: 0});
 await request(recovered.ws, "success");
 expect(g.counts()).toEqual({websocketCreates: 2, httpCreates: 1});
 // HTTP success must not prematurely clear the upstream recovery cooldown.
 await request(recovered.ws, "success");
 expect(g.counts()).toEqual({websocketCreates: 2, httpCreates: 2});
 now.mockReturnValue(160_001);
 await request(recovered.ws, "success");
 expect(g.counts()).toEqual({websocketCreates: 3, httpCreates: 2});
 expect(recovered.ws.readyState).toBe(WebSocket.OPEN);
});
