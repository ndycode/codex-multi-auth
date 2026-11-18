import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { ResponsesWebSocketGateway } from "../lib/runtime/responses-websocket.js";

type Event = Record<string, unknown>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(http = false) {
	const calls: Event[] = [];
	const peers: WebSocket[] = [];
	const upstream = createServer();
	const wss = new WebSocketServer({ noServer: true });
	upstream.on("upgrade", (req, socket, head) => {
		if (http) { socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n"); return; }
		wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
	});
	wss.on("connection", ws => {
		peers.push(ws);
		ws.on("message", raw => {
			const body = JSON.parse(raw.toString()) as Event;
			calls.push(body);
			if (body.type === "response.create") ws.send(JSON.stringify({ type: "response.created", response: { id: `resp_${calls.length}` } }));
		});
	});
	upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
	const address = upstream.address(); if (!address || typeof address === "string") throw Error("address");
	const upstreamUrl = `http://127.0.0.1:${address.port}/responses`;
	let httpController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const gateway = new ResponsesWebSocketGateway(async () => {
		calls.push({ type: "http.create" });
		return new Response(new ReadableStream<Uint8Array>({ start(controller) {
			httpController = controller;
			controller.enqueue(Buffer.from('data: {"type":"response.created","response":{"id":"resp_http"}}\n\n'));
		} }), { headers: { "content-type": "text/event-stream" } });
	}, { maxPayloadBytes: 16384 });
	const server = createServer((req, res) => gateway.handle(req, async () => {
		if (req.headers.authorization !== "Bearer fixture-local") { res.writeHead(401).end(); return; }
		if (req.method !== "POST") { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const response = await gateway.fetch(upstreamUrl, { method: "POST", headers: { authorization: "Bearer fixture-upstream" }, body: Buffer.concat(chunks) });
		res.writeHead(response.status, Object.fromEntries(response.headers));
		try { if (response.body) for await (const chunk of response.body) res.write(chunk); res.end(); } catch { res.destroy(); }
	}));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const local = server.address(); if (!local || typeof local === "string") throw Error("address");
	const baseUrl = `http://127.0.0.1:${local.port}`; gateway.attach(server, baseUrl);
	cleanup.push(async () => {
		gateway.close(); server.closeAllConnections();
		for (const peer of peers) peer.terminate(); wss.close();
		await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
	});
	return { calls, peers, gateway, httpComplete: () => { httpController?.enqueue(Buffer.from('data: {"type":"response.completed","response":{"id":"resp_http","output":[]}}\n\n')); httpController?.close(); }, connect: async () => {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/responses", { headers: { authorization: "Bearer fixture-local" } });
		await once(ws, "open");
		const events: Event[] = []; ws.on("message", raw => events.push(JSON.parse(raw.toString()) as Event));
		return { ws, events };
	} };
}
async function waitForEvent(ws: WebSocket, predicate: (event: Event) => boolean): Promise<Event> {
	for (;;) { const [raw] = await once(ws, "message"); const event = JSON.parse(raw.toString()) as Event; if (predicate(event)) return event; }
}
async function create(ws: WebSocket) {
	const created = waitForEvent(ws, e => e.type === "response.created");
	ws.send(JSON.stringify({ type: "response.create", model: "api/preview", input: [], reasoning: { effort: "ultra" } }));
	return String(((await created).response as Event).id);
}
const interrupt = (responseId: string) => ({ type: "response.interrupt", response_id: responseId, mode: "discard_partial_items" });
const acknowledgement = (responseId: string, accepted = true) => ({ type: `response.interrupt.${accepted ? "accepted" : "failed"}`, response_id: responseId });
const completed = (responseId: string) => ({ type: "response.completed", response: { id: responseId, output: [] } });

it.each(["ack-first", "completion-first"])("forwards native interrupt and both terminal events (%s)", async order => {
	const f = await fixture(); const { ws, events } = await f.connect(); const id = await create(ws);
	const upstreamControl = once(f.peers[0], "message");
	ws.send(JSON.stringify(interrupt(id)));
	// A rejected control is observable immediately; do not wait for a fake timeout on RED.
	const result = await Promise.race([upstreamControl.then(([raw]) => JSON.parse(raw.toString()) as Event), once(ws, "message").then(([raw]) => JSON.parse(raw.toString()) as Event)]);
	expect(result).toEqual(interrupt(id));
	for (const event of order === "ack-first" ? [acknowledgement(id), completed(id)] : [completed(id), acknowledgement(id)]) {
		const received = waitForEvent(ws, e => e.type === event.type);
		f.peers[0].send(JSON.stringify(event));
		await received;
	}
	expect(events.filter(e => e.type === "response.interrupt.accepted")).toEqual([acknowledgement(id)]);
	expect(events.filter(e => e.type === "response.completed")).toEqual([completed(id)]);
	expect(events.some(e => e.type === "error")).toBe(false);
	expect(f.calls.filter(e => e.type === "response.create")).toHaveLength(1);
	expect(f.calls[0].reasoning).toEqual({ effort: "ultra" });
});

it("rejects an interrupt from another local session without touching its owner", async () => {
	const f = await fixture(); const owner = await f.connect(); const other = await f.connect(); const id = await create(owner.ws);
	const response = once(other.ws, "message"); other.ws.send(JSON.stringify(interrupt(id)));
	expect(JSON.parse((await response)[0].toString())).toEqual(acknowledgement(id, false));
	expect(f.calls).toHaveLength(1); expect(owner.events).toHaveLength(1);
});

it("does not claim HTTP recovery can interrupt an upstream generation", async () => {
	const f = await fixture(true); const { ws, events } = await f.connect(); const id = await create(ws);
	const response = once(ws, "message"); ws.send(JSON.stringify(interrupt(id)));
	expect(JSON.parse((await response)[0].toString())).toEqual(acknowledgement(id, false));
	const done = waitForEvent(ws, e => e.type === "response.completed"); f.httpComplete(); await done;
	expect(f.calls).toEqual([{ type: "http.create" }]);
	expect(events.some(e => e.type === "error")).toBe(false);
});

it("keeps a late acknowledgement separate from the next response", async () => {
	const f = await fixture(); const { ws, events } = await f.connect(); const first = await create(ws);
	const control = once(f.peers[0], "message"); ws.send(JSON.stringify(interrupt(first))); await control;
	const firstDone = waitForEvent(ws, e => e.type === "response.completed");
	f.peers[0].send(JSON.stringify(completed(first))); await firstDone;
	const second = await create(ws);
	const ack = waitForEvent(ws, e => e.type === "response.interrupt.accepted");
	f.peers[0].send(JSON.stringify(acknowledgement("not-owned")));
	f.peers[0].send(JSON.stringify(acknowledgement(first))); await ack;
	const secondDone = waitForEvent(ws, e => e.type === "response.completed");
	f.peers[0].send(JSON.stringify(completed(second))); await secondDone;
	expect(events.filter(e => e.type === "response.interrupt.accepted")).toEqual([acknowledgement(first)]);
	expect(events.filter(e => e.type === "response.completed")).toEqual([completed(first), completed(second)]);
	expect(f.calls.filter(e => e.type === "response.create")).toHaveLength(2);
	expect(f.peers).toHaveLength(1);
});

it("reports interrupted-socket loss without replaying the create", async () => {
	const f = await fixture(); const { ws } = await f.connect(); const id = await create(ws);
	const control = once(f.peers[0], "message"); ws.send(JSON.stringify(interrupt(id))); await control;
	const failed = waitForEvent(ws, e => e.type === "response.interrupt.failed");
	const generationFailed = waitForEvent(ws, e => e.type === "error");
	f.peers[0].terminate();
	expect(await failed).toEqual(acknowledgement(id, false));
	expect(await generationFailed).toMatchObject({ status: 502, error: { code: "upstream_websocket_disconnected" } });
	expect(f.calls.map(e => e.type)).toEqual(["response.create", "response.interrupt"]);
});

it("validates interrupt mode and sends only supported control fields", async () => {
	const f = await fixture(); const { ws } = await f.connect(); const id = await create(ws);
	const failed = once(ws, "message"); ws.send(JSON.stringify({ ...interrupt(id), mode: "unrecognized" }));
	expect(JSON.parse((await failed)[0].toString())).toEqual(acknowledgement(id, false));
	const control = once(f.peers[0], "message"); ws.send(JSON.stringify({ ...interrupt(id), model: "other-pool", input: ["must not forward"] }));
	expect(JSON.parse((await control)[0].toString())).toEqual(interrupt(id));
	const ack = waitForEvent(ws, e => e.type === "response.interrupt.failed");
	f.peers[0].send(JSON.stringify(acknowledgement(id, false))); await ack;
	expect(f.calls.filter(e => e.type === "response.create")).toHaveLength(1);
});
