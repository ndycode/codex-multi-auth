import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { ResponsesWebSocketGateway } from "../lib/runtime/responses-websocket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(settle => { resolve = settle; });
	return { promise, resolve };
}

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Missing fixture address");
	return `http://127.0.0.1:${address.port}`;
}

type Event = { type: string; response?: { id: string }; status?: number };

function event(ws: WebSocket, type: string, id?: string): Promise<Event> {
	return new Promise(resolve => {
		const listener = (raw: WebSocket.RawData) => {
			const value = JSON.parse(raw.toString()) as Event;
			if (value.type !== type || (id !== undefined && value.response?.id !== id)) return;
			ws.off("message", listener);
			resolve(value);
		};
		ws.on("message", listener);
	});
}

function send(ws: WebSocket, model = "completed", options: Record<string, unknown> = {}): void {
	ws.send(JSON.stringify({ type: "response.create", model, input: [], ...options }));
}

async function complete(ws: WebSocket, options: Record<string, unknown> = {}): Promise<void> {
	const done = event(ws, "response.completed");
	send(ws, "completed", options);
	await done;
}

function rawUpgrade(baseUrl: string, headers: Record<string, string>, method = "GET") {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const request = httpRequest(`${baseUrl}/responses`, {
			method,
			headers: {
				authorization: "Bearer capacity-fixture-local",
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
				"sec-websocket-version": "13",
				...headers,
			},
		});
		request.once("response", response => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", chunk => { body += chunk; });
			response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
			response.once("error", reject);
		});
		request.once("upgrade", (_response, socket) => {
			socket.destroy();
			reject(Error("Malformed fixture handshake was unexpectedly accepted"));
		});
		request.once("error", reject);
		request.end();
	});
}

async function fixture(upgrade?: (req: IncomingMessage) => Promise<boolean>) {
	const upstreamRequests: Record<string, unknown>[] = [];
	const held = new Map<string, WebSocket>();
	let httpCreates = 0;
	const upstream = createServer((_req, res) => {
		httpCreates++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end('data: {"type":"response.completed","response":{"id":"resp_http","output":[]}}\n\n');
	});
	const upstreamWss = new WebSocketServer({ server: upstream });
	const finish = (ws: WebSocket, id: string) => ws.send(JSON.stringify({
		type: "response.completed", response: { id, output: [] },
	}));
	upstreamWss.on("connection", ws => ws.on("message", raw => {
		const body = JSON.parse(raw.toString()) as Record<string, unknown>;
		upstreamRequests.push(body);
		const id = `resp_${String(body.model)}`;
		ws.send(JSON.stringify({ type: "response.created", response: { id } }));
		if (body.model === "disconnect") ws.close(1011);
		else if (String(body.model).startsWith("held-")) held.set(String(body.model), ws);
		else finish(ws, id);
	}));
	const upstreamUrl = await listen(upstream);
	const gateway = new ResponsesWebSocketGateway(fetch, { maxPayloadBytes: 16384, upgrade });
	const server = createServer((req, res) => gateway.handle(req, async () => {
		if (req.headers.authorization !== "Bearer capacity-fixture-local") {
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
			if (JSON.parse(Buffer.concat(chunks).toString()).model === "rejected") {
				res.writeHead(403, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: "unknown_model" } }));
				return;
			}
			const response = await gateway.fetch(`${upstreamUrl}/responses`, {
				method: "POST",
				headers: {
					authorization: "Bearer capacity-fixture-upstream",
					"chatgpt-account-id": "capacity-fixture-workspace",
					"content-type": "application/json",
				},
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
	const clients: WebSocket[] = [];
	cleanups.push(async () => {
		for (const ws of clients) ws.terminate();
		gateway.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		for (const ws of upstreamWss.clients) ws.terminate();
		upstreamWss.close();
		upstream.closeAllConnections();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	});
	async function connect(headers: Record<string, string> = {}, path = "/responses") {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + path, {
			headers: { authorization: "Bearer capacity-fixture-local", ...headers },
		});
		clients.push(ws);
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
	async function open(count: number) {
		const sockets: WebSocket[] = [];
		for (let index = 0; index < count; index++) {
			const connected = await connect();
			expect(connected.status).toBe(101);
			sockets.push(connected.ws);
		}
		return sockets;
	}
	return {
		connect, open, baseUrl, stats: gateway.stats, upstreamRequests,
		httpCreates: () => httpCreates,
		finishHeld(model: string) {
			const ws = held.get(model);
			if (!ws) throw Error(`No held request for ${model}`);
			held.delete(model);
			finish(ws, `resp_${model}`);
		},
	};
}

it("admits a 65th WebSocket by reclaiming the oldest unused client", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	const closed = once(clients[0], "close");
	const newcomer = await g.connect();
	expect(newcomer.status).toBe(101);
	await closed;
	expect(clients.slice(1).every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
	await complete(newcomer.ws);
	expect(g.stats).toMatchObject({ activeConnections: 64, capacityReclaims: 1 });
	expect(g.httpCreates()).toBe(0);
});

it("reclaims an idle prewarm-only client while keeping generation on WebSocket", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	await complete(clients[0], { generate: false });
	const closed = once(clients[0], "close");
	const newcomer = await g.connect();
	expect(newcomer.status).toBe(101);
	await closed;
	await complete(newcomer.ws);
	expect(g.upstreamRequests.map(body => body.generate)).toEqual([false, undefined]);
	expect(g.stats).toMatchObject({ activeConnections: 64, capacityReclaims: 1 });
	expect(g.httpCreates()).toBe(0);
});

it("preserves completed generation and its continuation when reclaiming an unused sibling", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	await complete(clients[0]);
	const closed = once(clients[1], "close");
	expect((await g.connect()).status).toBe(101);
	await closed;
	expect(clients[0].readyState).toBe(WebSocket.OPEN);
	await complete(clients[0], { previous_response_id: "resp_completed" });
	expect(g.upstreamRequests.at(-1)).toMatchObject({ previous_response_id: "resp_completed" });
	expect(g.stats).toMatchObject({ activeConnections: 64, capacityReclaims: 1 });
});

it("does not evict a streaming generation when an unused client can be reclaimed", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	const started = event(clients[0], "response.created");
	const done = event(clients[0], "response.completed");
	send(clients[0], "held-generation");
	await started;
	const closed = once(clients[1], "close");
	expect((await g.connect()).status).toBe(101);
	await closed;
	expect(clients[0].readyState).toBe(WebSocket.OPEN);
	g.finishHeld("held-generation");
	await done;
	expect(g.httpCreates()).toBe(0);
});

it("protects queued generation behind an unfinished prewarm", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	const started = event(clients[0], "response.created");
	const queuedDone = event(clients[0], "response.completed", "resp_queued-generation");
	send(clients[0], "held-prewarm", { generate: false });
	send(clients[0], "queued-generation");
	await started;
	const closed = once(clients[1], "close");
	expect((await g.connect()).status).toBe(101);
	await closed;
	expect(clients[0].readyState).toBe(WebSocket.OPEN);
	g.finishHeld("held-prewarm");
	await queuedDone;
	expect(g.upstreamRequests.map(body => body.model)).toEqual(["held-prewarm", "queued-generation"]);
	expect(g.httpCreates()).toBe(0);
});

it("protects a create already queued before its request controller exists", async () => {
	let oldestServerSocket: WebSocket | undefined;
	const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
	vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(function(req, socket, head, callback) {
		originalUpgrade.call(this, req, socket, head, (ws, request) => {
			if (request.headers["x-fixture-oldest"] === "true") oldestServerSocket = ws;
			callback(ws, request);
		});
	});
	const admissionEntered = deferred<void>();
	const admissionReleased = deferred<boolean>();
	const g = await fixture(req => {
		if (req.headers["x-fixture-gate"] !== "true") return Promise.resolve(false);
		admissionEntered.resolve();
		return admissionReleased.promise;
	});
	const oldest = await g.connect({ "x-fixture-oldest": "true" });
	expect(oldest.status).toBe(101);
	const otherClients = await g.open(63);
	if (!oldestServerSocket) throw Error("Missing accepted fixture socket");
	const newcomer = g.connect({ "x-fixture-gate": "true" });
	await admissionEntered.promise;
	// Queue admission's continuation first, then let the real gateway message
	// handler accept the create. Capacity runs before its queued request callback.
	oldestServerSocket.prependOnceListener("message", () => admissionReleased.resolve(false));
	const victim = Promise.race([
		once(oldest.ws, "close").then(() => "queued"),
		once(otherClients[0], "close").then(() => "unused"),
	]);
	const started = event(oldest.ws, "response.created");
	const done = event(oldest.ws, "response.completed");
	send(oldest.ws, "held-newly-queued");
	expect((await newcomer).status).toBe(101);
	expect(await victim).toBe("unused");
	await started;
	g.finishHeld("held-newly-queued");
	await done;
	expect(g.stats).toMatchObject({ activeConnections: 64, capacityReclaims: 1 });
	expect(g.httpCreates()).toBe(0);
});

it("reclaims distinct idle clients under concurrent admission without exceeding 64", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	const closed = clients.slice(0, 8).map(ws => once(ws, "close"));
	const newcomers = await Promise.all(Array.from({ length: 8 }, () => g.connect()));
	expect(newcomers.map(client => client.status)).toEqual(Array(8).fill(101));
	await Promise.all(closed);
	expect(clients.slice(8).every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
	expect(newcomers.every(client => client.ws.readyState === WebSocket.OPEN)).toBe(true);
	expect(g.stats).toMatchObject({ activeConnections: 64, capacityReclaims: 8 });
});

it("uses immediate HTTP recovery when all 64 sessions carry generated history", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	await Promise.all(clients.map(ws => complete(ws)));
	const newcomers = await Promise.all(Array.from({ length: 3 }, () => g.connect()));
	expect(newcomers.map(client => client.status)).toEqual([426, 426, 426]);
	expect(clients.every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
	expect(g.stats).toMatchObject({
		activeConnections: 64, capacityReclaims: 0,
		lastUpgradeRejection: { reason: "capacity", status: 426, activeConnections: 64 },
	});
	expect(Object.keys(Reflect.get(g.stats, "lastUpgradeRejection")).sort())
		.toEqual(["activeConnections", "at", "reason", "status"]);
	const response = await fetch(`${g.baseUrl}/responses`, {
		method: "POST",
		headers: { authorization: "Bearer capacity-fixture-local", "content-type": "application/json" },
		body: JSON.stringify({ model: "completed", input: [], stream: true }),
	});
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("response.completed");
	expect(g.httpCreates()).toBe(1);
});

it("releases a normally closed protected session without reclaiming another client", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	await Promise.all(clients.map(ws => complete(ws)));
	const closed = once(clients[0], "close");
	clients[0].close(1000);
	await closed;
	expect((await g.connect()).status).toBe(101);
	expect(clients.slice(1).every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
	expect(g.stats).toMatchObject({ activeConnections: 64, capacityReclaims: 0 });
});

it("checks credentials, Origin, and path before reclaiming capacity", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	expect((await g.connect({ authorization: "Bearer wrong-fixture", origin: "https://fixture.invalid" })).status).toBe(401);
	expect((await g.connect({ origin: "https://fixture.invalid" })).status).toBe(403);
	expect(g.stats).toMatchObject({
		activeConnections: 64, capacityReclaims: 0,
		lastUpgradeRejection: { reason: "origin", status: 403, activeConnections: 64 },
	});
	expect((await g.connect({}, "/unknown-fixture")).status).toBe(404);
	expect(clients.every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
	expect(g.stats).toMatchObject({ activeConnections: 64, capacityReclaims: 0 });
});

it.each([
	{ name: "key", headers: { "sec-websocket-key": "invalid-fixture-key" }, method: "GET", status: 400, message: "Missing or invalid Sec-WebSocket-Key header" },
	{ name: "version", headers: { "sec-websocket-version": "12" }, method: "GET", status: 400, message: "Missing or invalid Sec-WebSocket-Version header" },
	{ name: "subprotocol", headers: { "sec-websocket-protocol": "fixture, fixture" }, method: "GET", status: 400, message: "Invalid Sec-WebSocket-Protocol header" },
	{ name: "method", headers: {}, method: "POST", status: 405, message: "Invalid HTTP method" },
])("rejects malformed $name before evicting any authenticated idle client", async ({ headers, method, status, message }) => {
	const g = await fixture();
	const clients = await g.open(64);
	const response = await rawUpgrade(g.baseUrl, headers, method);
	expect(response).toEqual({ status, body: message });
	expect(g.stats).toMatchObject({ connections: 64, activeConnections: 64, capacityReclaims: 0 });
	expect(clients.every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
	expect(g.upstreamRequests).toEqual([]);
	expect(g.httpCreates()).toBe(0);
});

it("does not reclaim an idle sibling for a scope already requiring HTTP recovery", async () => {
	const g = await fixture();
	const headers = { "thread-id": "capacity-fixture-disconnected-thread" };
	for (let index = 0; index < 2; index++) {
		const client = await g.connect(headers);
		expect(client.status).toBe(101);
		const failed = event(client.ws, "error");
		send(client.ws, "disconnect");
		await failed;
		const closed = once(client.ws, "close");
		client.ws.close(1000);
		await closed;
	}
	const clients = await g.open(64);
	expect((await g.connect(headers)).status).toBe(426);
	expect(clients.every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
	expect(g.stats).toMatchObject({
		activeConnections: 64, capacityReclaims: 0,
		lastUpgradeRejection: { reason: "repeated_disconnect", status: 426, activeConnections: 64 },
	});
});

it("reclaims rejected creates without evicting retained generation history", async () => {
	const g = await fixture();
	const clients = await g.open(64);
	await complete(clients[0]);
	for (const client of clients) {
		const rejected = event(client, "error");
		send(client, "rejected");
		expect((await rejected).status).toBe(403);
	}
	const closed = once(clients[1], "close");
	const newcomer = await g.connect();
	expect(newcomer.status).toBe(101);
	await closed;
	expect(clients[0].readyState).toBe(WebSocket.OPEN);
	await complete(clients[0], { previous_response_id: "resp_completed" });
	await complete(newcomer.ws);
	expect(g.stats.capacityReclaims).toBe(1);
	expect(g.httpCreates()).toBe(0);
});
