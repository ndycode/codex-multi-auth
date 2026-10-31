import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { AccountManager } from "../lib/accounts.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import { HTTP_STATUS, OPENAI_HEADERS } from "../lib/constants.js";
import * as runtimePolicy from "../lib/policy/runtime-policy.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import {
	RealtimeCallRegistry,
	RealtimeCallRequestError,
	isRealtimeCallPath,
	parseRealtimeCallId,
	resolveRealtimeSidebandTarget,
	translateRealtimeCallRequest,
} from "../lib/runtime/realtime-calls.js";
import * as tokenRefreshRuntime from "../lib/runtime/rotation-token-refresh.js";
import { resetTrackers } from "../lib/rotation.js";
import {
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const CLIENT_KEY = "runtime-secret";
const BOUNDARY = "codex-realtime-call-boundary";
const SESSION = { type: "realtime", model: "gpt-realtime", delegation: { type: "client" } };
const SDP_OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
const SDP_ANSWER = "v=0\r\no=- answer\r\n";
const CALL_ID = "rtc_fixture123";
const cleanups: Array<() => Promise<void> | void> = [];

function multipartCall(sdp = SDP_OFFER, session: unknown = SESSION): Buffer {
	return Buffer.from(
		`--${BOUNDARY}\r\nContent-Disposition: form-data; name="sdp"\r\nContent-Type: application/sdp\r\n\r\n${sdp}\r\n` +
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="session"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(session)}\r\n` +
			`--${BOUNDARY}--\r\n`,
	);
}

function createStorage(now: number, count = 2): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: count }, (_unused, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - (count - index) * 60_000,
			enabled: true,
		})),
	};
}

interface FetchCall {
	url: string;
	headers: Headers;
	bodyText: string;
}

function createRecordingFetch(handler: (call: FetchCall) => Response): { calls: FetchCall[]; fetchImpl: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const body = init?.body;
		const call = {
			url: String(input),
			headers: new Headers(init?.headers),
			bodyText: typeof body === "string" ? body : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "",
		};
		calls.push(call);
		return handler(call);
	};
	return { calls, fetchImpl };
}

function callCreated(callId = CALL_ID): Response {
	return new Response(SDP_ANSWER, {
		status: 201,
		headers: { "content-type": "application/sdp", location: `/v1/realtime/calls/calls/${callId}` },
	});
}

async function listen(server: Server): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("listen failed");
	return address.port;
}

/** A stand-in for the OpenAI realtime sideband endpoint. */
async function startSidebandUpstream(options: { status?: number } = {}) {
	const server = createServer();
	const wss = new WebSocketServer({ noServer: true });
	const handshakes: IncomingMessage[] = [];
	const peers: WebSocket[] = [];
	server.on("upgrade", (req, socket, head) => {
		handshakes.push(req);
		if (options.status) {
			socket.end(`HTTP/1.1 ${options.status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			peers.push(ws);
			ws.send(JSON.stringify({ type: "session.created" }));
			ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
		});
	});
	const port = await listen(server);
	cleanups.push(async () => {
		for (const peer of wss.clients) peer.terminate();
		wss.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { baseUrl: `http://127.0.0.1:${port}/v1`, handshakes, peers };
}

async function startProxy(
	fetchImpl: typeof fetch,
	options: Partial<Parameters<typeof startRuntimeRotationProxy>[0]> = {},
	accountManager = new AccountManager(undefined, createStorage(Date.now(), 2)),
): Promise<{ proxy: RuntimeRotationProxyServer; accountManager: AccountManager }> {
	const proxy = await startRuntimeRotationProxy({
		accountManager,
		fetchImpl,
		upstreamBaseUrl: "https://example.test/backend-api",
		clientApiKey: CLIENT_KEY,
		quotaRemainingPercentThreshold: 10,
		...options,
	});
	cleanups.push(async () => {
		await proxy.close();
		await accountManager.flushPendingSave();
	});
	return { proxy, accountManager };
}

function createCall(proxy: RuntimeRotationProxyServer, path = "/live", body = multipartCall()): Promise<Response> {
	return fetch(`${proxy.baseUrl}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${CLIENT_KEY}`,
			"content-type": `multipart/form-data; boundary=${BOUNDARY}`,
			"openai-alpha": "quicksilver=v2",
			"x-session-id": "voice-session",
			cookie: "caller=cookie",
		},
		body,
	});
}

/** Resolves with the open socket, or the HTTP status a rejected handshake returned. */
function connectSideband(
	proxy: RuntimeRotationProxyServer,
	path: string,
	token = CLIENT_KEY,
): Promise<WebSocket | number> {
	const ws = new WebSocket(`${proxy.baseUrl.replace("http:", "ws:")}${path}`, {
		headers: { authorization: `Bearer ${token}`, "openai-alpha": "quicksilver=v2", "x-session-id": "voice-session" },
	});
	cleanups.push(() => ws.terminate());
	// The relay can deliver the upstream's first frame in the same packet as the
	// handshake, before a test could attach a listener after "open".
	const inbox: Array<{ data: string; isBinary: boolean }> = [];
	const waiters: Array<(message: { data: string; isBinary: boolean }) => void> = [];
	ws.on("message", (data, isBinary) => {
		const message = { data: Buffer.from(data as Buffer).toString("utf8"), isBinary };
		const waiter = waiters.shift();
		if (waiter) waiter(message);
		else inbox.push(message);
	});
	inboxes.set(ws, { inbox, waiters });
	return new Promise((resolve, reject) => {
		ws.once("open", () => resolve(ws));
		ws.once("unexpected-response", (_req, res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		ws.once("error", reject);
	});
}

const inboxes = new WeakMap<WebSocket, {
	inbox: Array<{ data: string; isBinary: boolean }>;
	waiters: Array<(message: { data: string; isBinary: boolean }) => void>;
}>();

function nextMessage(ws: WebSocket): Promise<{ data: string; isBinary: boolean }> {
	const queue = inboxes.get(ws);
	if (!queue) throw new Error("socket was not opened by connectSideband");
	const ready = queue.inbox.shift();
	if (ready) return Promise.resolve(ready);
	return new Promise((resolve) => queue.waiters.push(resolve));
}

beforeEach(() => {
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	tokenRefreshRuntime.resetRuntimeRefreshStateForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	tokenRefreshRuntime.resetRuntimeRefreshStateForTests();
	vi.restoreAllMocks();
});

describe("realtime call translation", () => {
	it("turns a frameless multipart call into the ChatGPT backend JSON shape", () => {
		const result = translateRealtimeCallRequest("/live", "", `multipart/form-data; boundary=${BOUNDARY}`, multipartCall());
		expect(result.contentType).toBe("application/json");
		expect(result.search).toBe("?intent=quicksilver&architecture=avas");
		expect(JSON.parse(result.body.toString("utf8"))).toEqual({ sdp: SDP_OFFER, session: SESSION });
	});

	it("keeps the v1 query and accepts a quoted boundary", () => {
		const result = translateRealtimeCallRequest(
			"/realtime/calls",
			"?intent=quicksilver&architecture=avas",
			`multipart/form-data; boundary="${BOUNDARY}"`,
			multipartCall(),
		);
		expect(result.search).toBe("?intent=quicksilver&architecture=avas");
		expect(JSON.parse(result.body.toString("utf8")).sdp).toBe(SDP_OFFER);
	});

	it("forwards raw SDP and backend JSON bodies unchanged", () => {
		const raw = Buffer.from(SDP_OFFER);
		expect(translateRealtimeCallRequest("/realtime/calls", "", "application/sdp", raw)).toEqual({ body: raw, contentType: null, search: "" });
	});

	it.each([
		["no boundary", "multipart/form-data", multipartCall()],
		["no SDP part", `multipart/form-data; boundary=${BOUNDARY}`, multipartCall("")],
		["an invalid session", `multipart/form-data; boundary=${BOUNDARY}`, Buffer.from(multipartCall().toString("utf8").replace(JSON.stringify(SESSION), "{not json"))],
	])("rejects a multipart call with %s", (_label, contentType, body) => {
		expect(() => translateRealtimeCallRequest("/live", "", contentType, body)).toThrow(RealtimeCallRequestError);
	});

	it("recognizes only the call creation routes", () => {
		for (const path of ["/live", "/v1/live", "/realtime/calls", "/v1/realtime/calls", "/codex/realtime/calls"]) {
			expect(isRealtimeCallPath(path)).toBe(true);
		}
		expect(isRealtimeCallPath("/live/rtc_x")).toBe(false);
		expect(isRealtimeCallPath("/realtime")).toBe(false);
	});

	it("parses the call id the way Codex does", () => {
		expect(parseRealtimeCallId("/v1/realtime/calls/calls/rtc_abc?x=1")).toBe("rtc_abc");
		expect(parseRealtimeCallId("/v1/live/rtc_frameless")).toBe("rtc_frameless");
		expect(parseRealtimeCallId("/calls/123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
		expect(parseRealtimeCallId("/v1/realtime/calls")).toBeNull();
		expect(parseRealtimeCallId(null)).toBeNull();
	});

	it("maps sideband URLs and refuses anything that is not a call id", () => {
		expect(resolveRealtimeSidebandTarget("/v1/live/rtc_abc")).toEqual({ callId: "rtc_abc", upstreamPath: "/live/rtc_abc", search: "" });
		expect(resolveRealtimeSidebandTarget("/live/rtc_abc/")).toMatchObject({ upstreamPath: "/live/rtc_abc" });
		expect(resolveRealtimeSidebandTarget("/v1/realtime?intent=quicksilver&call_id=rtc_abc")).toEqual({
			callId: "rtc_abc",
			upstreamPath: "/realtime",
			search: "?intent=quicksilver&call_id=rtc_abc",
		});
		for (const path of ["/v1/live", "/v1/live/..", "/v1/live/rtc_a%2F..%2Fx", "/v1/realtime", "/v1/realtime?call_id=../x"]) {
			expect(resolveRealtimeSidebandTarget(path)).toBeNull();
		}
	});

	it("expires and bounds remembered calls", () => {
		let now = 1_000;
		const registry = new RealtimeCallRegistry(() => now, 100, 2);
		const credential = { accessToken: "a", accountId: "acc", accountIndex: 0 };
		registry.remember("rtc_one", credential);
		registry.remember("rtc_two", credential);
		registry.remember("rtc_three", credential);
		expect(registry.get("rtc_one")).toBeNull();
		expect(registry.get("rtc_three")).toEqual(credential);
		registry.remember("not a call", credential);
		expect(registry.size).toBe(2);
		now += 100;
		expect(registry.get("rtc_three")).toBeNull();
	});
});

describe("runtime proxy voice calls (#750)", () => {
	it("creates a frameless call through a managed account in the backend shape", async () => {
		const record = vi.fn(async () => undefined);
		const recorder = vi.spyOn(runtimePolicy, "createRuntimeUsageRecorder")
			.mockReturnValue({ hasRecorded: () => record.mock.calls.length > 0, record });
		const { calls, fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl);

		const response = await createCall(proxy);

		expect(response.status).toBe(201);
		expect(await response.text()).toBe(SDP_ANSWER);
		expect(response.headers.get("location")).toBe(`/v1/realtime/calls/calls/${CALL_ID}`);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://example.test/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
		expect(calls[0]?.headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(calls[0]?.bodyText ?? "{}")).toEqual({ sdp: SDP_OFFER, session: SESSION });
		expect(calls[0]?.headers.get("authorization")).toMatch(/^Bearer access-\d$/);
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toMatch(/^acc_\d$/);
		expect(calls[0]?.headers.get("openai-alpha")).toBe("quicksilver=v2");
		expect(calls[0]?.headers.get("x-session-id")).toBe("voice-session");
		expect(calls[0]?.headers.has("cookie")).toBe(false);
		expect(recorder).toHaveBeenCalledWith(expect.objectContaining({ operation: "realtime" }));
	});

	it("passes an upstream rejection through once, without replaying the call or cooling the account", async () => {
		const body = { error: { code: "realtime_not_enabled", message: "fixture" } };
		const { calls, fetchImpl } = createRecordingFetch(() => Response.json(body, { status: HTTP_STATUS.FORBIDDEN }));
		const { proxy, accountManager } = await startProxy(fetchImpl);

		const response = await createCall(proxy);

		expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
		expect(await response.json()).toEqual(body);
		expect(calls).toHaveLength(1);
		for (const account of accountManager.getAccountsSnapshot()) expect(account.coolingDownUntil).toBeUndefined();
	});

	it("rejects a malformed call upload before contacting upstream", async () => {
		const { calls, fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl);

		const response = await createCall(proxy, "/live", multipartCall(""));

		expect(response.status).toBe(400);
		expect((await response.json()).error.code).toBe("invalid_realtime_call");
		expect(calls).toHaveLength(0);
	});

	it.each([false, true])("relays the sideband with the account that created the call (native: %s)", async (nativeOpenai) => {
		const upstream = await startSidebandUpstream();
		const { calls, fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl, {
			realtimeSidebandUpstreamBaseUrl: upstream.baseUrl,
			...(nativeOpenai ? { nativeOpenai: true, readNativeAccountStorage: async () => createStorage(Date.now(), 2) } : {}),
		});
		expect((await createCall(proxy)).status).toBe(201);

		const ws = await connectSideband(proxy, `/v1/live/${CALL_ID}`);
		if (typeof ws === "number") throw new Error(`sideband rejected with ${ws}`);
		expect(await nextMessage(ws)).toEqual({ data: '{"type":"session.created"}', isBinary: false });

		const handshake = upstream.handshakes[0];
		expect(handshake?.url).toBe(`/v1/live/${CALL_ID}`);
		expect(handshake?.headers.authorization).toBe(calls[0]?.headers.get("authorization"));
		expect(handshake?.headers[OPENAI_HEADERS.ACCOUNT_ID.toLowerCase()]).toBe(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID));
		expect(handshake?.headers["openai-alpha"]).toBe("quicksilver=v2");
		expect(handshake?.headers["x-session-id"]).toBe("voice-session");
		expect(handshake?.headers.authorization).not.toContain(CLIENT_KEY);

		const text = nextMessage(ws);
		ws.send(JSON.stringify({ type: "conversation.item.create" }));
		expect(await text).toEqual({ data: '{"type":"conversation.item.create"}', isBinary: false });
		const binary = nextMessage(ws);
		ws.send(Buffer.from([1, 2, 3]));
		expect((await binary).isBinary).toBe(true);

		const upstreamClosed = once(upstream.peers[0] as WebSocket, "close");
		ws.close(1000, "done");
		const [code] = await upstreamClosed;
		expect(code).toBe(1000);
	});

	it("relays a v1 sideband that joins with a call_id query", async () => {
		const upstream = await startSidebandUpstream();
		const { fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl, { realtimeSidebandUpstreamBaseUrl: upstream.baseUrl });
		await createCall(proxy, "/realtime/calls?intent=quicksilver&architecture=avas");

		const ws = await connectSideband(proxy, `/v1/realtime?intent=quicksilver&call_id=${CALL_ID}`);

		expect(typeof ws).not.toBe("number");
		expect(upstream.handshakes[0]?.url).toBe(`/v1/realtime?intent=quicksilver&call_id=${CALL_ID}`);
	});

	it("refuses a sideband for a call it did not create, without contacting upstream", async () => {
		const upstream = await startSidebandUpstream();
		const { fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl, { realtimeSidebandUpstreamBaseUrl: upstream.baseUrl });

		expect(await connectSideband(proxy, "/v1/live/rtc_unknown")).toBe(404);
		expect(await connectSideband(proxy, "/v1/live")).toBe(404);
		expect(upstream.handshakes).toHaveLength(0);
	});

	it("requires the local client token on the sideband", async () => {
		const upstream = await startSidebandUpstream();
		const { fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl, { realtimeSidebandUpstreamBaseUrl: upstream.baseUrl });
		await createCall(proxy);

		expect(await connectSideband(proxy, `/v1/live/${CALL_ID}`, "wrong-token")).toBe(401);
		expect(upstream.handshakes).toHaveLength(0);
	});

	it.each([
		[404, 404],
		[401, 502],
	])("maps an upstream sideband %s to %s", async (upstreamStatus, localStatus) => {
		const upstream = await startSidebandUpstream({ status: upstreamStatus });
		const { fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl, { realtimeSidebandUpstreamBaseUrl: upstream.baseUrl });
		await createCall(proxy);

		expect(await connectSideband(proxy, `/v1/live/${CALL_ID}`)).toBe(localStatus);
	});

	it("keeps Responses on HTTP streaming outside native binds", async () => {
		const { fetchImpl } = createRecordingFetch(() => callCreated());
		const { proxy } = await startProxy(fetchImpl);

		expect(await connectSideband(proxy, "/responses")).toBe(426);
		expect(await connectSideband(proxy, "/responses", "wrong-token")).toBe(401);
	});

	it("rejects a non-loopback http sideband upstream", async () => {
		const { fetchImpl } = createRecordingFetch(() => callCreated());
		await expect(startProxy(fetchImpl, { realtimeSidebandUpstreamBaseUrl: "http://example.test/v1" })).rejects.toThrow();
	});
});
