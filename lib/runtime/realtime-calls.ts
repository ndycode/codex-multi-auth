import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { OPENAI_HEADERS } from "../constants.js";

/**
 * Native Codex voice (`/voice`) through the runtime rotation proxy (#750).
 *
 * Codex picks the realtime request shape from its provider base URL. Against
 * ChatGPT (`.../backend-api/codex`) it POSTs JSON `{ sdp, session }` to
 * `realtime/calls`. Against the loopback proxy it sees an API-style base URL
 * and instead POSTs a multipart `sdp` + `session` body to `live` (frameless
 * voice) or `realtime/calls` (v1). The proxy translates that back to the
 * ChatGPT shape and forwards it with a managed account.
 *
 * Media then flows peer-to-peer over WebRTC. Only the sideband control
 * WebSocket comes back through the proxy (the bound config points
 * `experimental_realtime_ws_base_url` at it), and it must use the same account
 * that created the call: a call is owned by the account that created it.
 */

/** Where Codex sends the sideband control socket for ChatGPT-authenticated calls. */
export const REALTIME_SIDEBAND_UPSTREAM_BASE_URL = "https://api.openai.com/v1";
export const REALTIME_CALL_UPSTREAM_PATH = "/codex/realtime/calls";

const FRAMELESS_CALL_PATHS = new Set(["/live", "/v1/live"]);
const REALTIME_CALL_PATHS = new Set([
	...FRAMELESS_CALL_PATHS,
	"/realtime/calls",
	"/v1/realtime/calls",
	"/codex/realtime/calls",
]);
const CALL_ID_PATTERN = /^(?:rtc_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DEFAULT_CALL_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_CALLS = 64;
const SIDEBAND_HANDSHAKE_TIMEOUT_MS = 15_000;
/** Bytes queued toward a slow peer before the relay stops reading the other side. */
export const RELAY_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** Reading resumes once the queue has drained below this. */
export const RELAY_LOW_WATER_BYTES = 1024 * 1024;
/** Request headers that describe the local hop, or carry local credentials. */
const SIDEBAND_DROPPED_HEADERS = new Set([
	"host",
	"connection",
	"upgrade",
	"authorization",
	"x-api-key",
	"cookie",
	"proxy-authorization",
	"origin",
	"content-length",
	"x-openai-actor-authorization",
	OPENAI_HEADERS.ACCOUNT_ID.toLowerCase(),
]);

export class RealtimeCallRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RealtimeCallRequestError";
	}
}

export function isRealtimeCallPath(pathname: string): boolean {
	return REALTIME_CALL_PATHS.has(pathname);
}

export function isRealtimeCallId(value: string): boolean {
	return CALL_ID_PATTERN.test(value);
}

export interface RealtimeCallUpstreamRequest {
	body: Buffer;
	/** Content type to send upstream; null keeps the incoming one. */
	contentType: string | null;
	/** Query string for the upstream URL, including the leading `?` when present. */
	search: string;
}

/**
 * Translate a Codex API-shaped realtime call into the ChatGPT backend shape.
 * Raw SDP and already-JSON bodies are forwarded unchanged.
 */
export function translateRealtimeCallRequest(
	pathname: string,
	search: string,
	contentType: string | null,
	body: Buffer,
): RealtimeCallUpstreamRequest {
	const query = new URLSearchParams(search);
	// The backend selects frameless (AVAS) voice through the query, not the path.
	if (FRAMELESS_CALL_PATHS.has(pathname)) {
		if (!query.has("intent")) query.set("intent", "quicksilver");
		if (!query.has("architecture")) query.set("architecture", "avas");
	}
	const serializedQuery = query.toString();
	const upstreamSearch = serializedQuery ? `?${serializedQuery}` : "";
	const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
	if (mime !== "multipart/form-data") {
		return { body, contentType: null, search: upstreamSearch };
	}
	const boundary = readMultipartBoundary(contentType ?? "");
	if (!boundary) throw new RealtimeCallRequestError("Realtime call upload is missing its multipart boundary.");
	const parts = parseMultipartFields(body, boundary);
	const sdp = parts.get("sdp");
	if (typeof sdp !== "string" || sdp.length === 0) {
		throw new RealtimeCallRequestError("Realtime call upload is missing its SDP offer.");
	}
	const rawSession = parts.get("session");
	let session: unknown;
	if (rawSession !== undefined) {
		try {
			session = JSON.parse(rawSession);
		} catch {
			throw new RealtimeCallRequestError("Realtime call session is not valid JSON.");
		}
	}
	const translated = session === undefined ? { sdp } : { sdp, session };
	return {
		body: Buffer.from(JSON.stringify(translated)),
		contentType: "application/json",
		search: upstreamSearch,
	};
}

function readMultipartBoundary(contentType: string): string | null {
	const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
	const boundary = match?.[1] ?? match?.[2];
	return boundary && boundary.length <= 200 ? boundary : null;
}

function parseMultipartFields(body: Buffer, boundary: string): Map<string, string> {
	const fields = new Map<string, string>();
	const sections = body.toString("utf8").split(`--${boundary}`);
	// sections[0] is the preamble; the closing delimiter is followed by "--".
	for (const section of sections.slice(1)) {
		if (section.startsWith("--")) break;
		const part = section.replace(/^\r?\n/, "");
		const headerEnd = part.indexOf("\r\n\r\n");
		if (headerEnd < 0) continue;
		const headers = part.slice(0, headerEnd);
		const disposition = headers
			.split("\r\n")
			.find((line) => /^content-disposition\s*:/i.test(line));
		const name = disposition ? /;\s*name="([^"]*)"/i.exec(disposition)?.[1] : undefined;
		if (!name || fields.has(name)) continue;
		fields.set(name, part.slice(headerEnd + 4).replace(/\r?\n$/, ""));
	}
	return fields;
}

/** Mirrors Codex: the call id is the last path segment that looks like one. */
export function parseRealtimeCallId(location: string | null): string | null {
	if (!location) return null;
	const path = location.split("?")[0] ?? "";
	return path.split("/").reverse().find((segment) => isRealtimeCallId(segment)) ?? null;
}

export interface RealtimeCallCredential {
	accessToken: string;
	accountId: string;
	accountIndex: number;
}

/**
 * Remembers which managed account created each call, so the sideband socket
 * joins with that account. Bounded in size and age: an entry lives ten
 * minutes from the call's creation or its last sideband connect/disconnect,
 * so a sideband that reconnects within that window keeps its account.
 */
export class RealtimeCallRegistry {
	private readonly calls = new Map<string, { credential: RealtimeCallCredential; expiresAt: number }>();
	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs = DEFAULT_CALL_TTL_MS,
		private readonly maxCalls = DEFAULT_MAX_CALLS,
	) {}

	remember(callId: string, credential: RealtimeCallCredential): void {
		if (!isRealtimeCallId(callId)) return;
		this.prune();
		this.calls.delete(callId);
		this.calls.set(callId, { credential, expiresAt: this.now() + this.ttlMs });
		while (this.calls.size > this.maxCalls) {
			const oldest = this.calls.keys().next().value;
			if (oldest === undefined) break;
			this.calls.delete(oldest);
		}
	}

	get(callId: string): RealtimeCallCredential | null {
		this.prune();
		return this.calls.get(callId)?.credential ?? null;
	}

	get size(): number {
		this.prune();
		return this.calls.size;
	}

	clear(): void {
		this.calls.clear();
	}

	private prune(): void {
		const now = this.now();
		for (const [callId, entry] of this.calls) {
			if (entry.expiresAt <= now) this.calls.delete(callId);
		}
	}
}

export interface RealtimeSidebandTarget {
	callId: string;
	/** Path relative to the realtime upstream base (which ends in `/v1`). */
	upstreamPath: string;
	search: string;
}

/**
 * Codex joins a call's sideband at `<base>/v1/live/<call_id>` (frameless) or
 * `<base>/v1/realtime?call_id=<call_id>` (v1).
 */
export function resolveRealtimeSidebandTarget(rawUrl: string): RealtimeSidebandTarget | null {
	let url: URL;
	try {
		url = new URL(rawUrl, "http://127.0.0.1");
	} catch {
		return null;
	}
	const path = url.pathname.replace(/\/+$/, "");
	const frameless = /^(?:\/v1)?\/live\/([^/]+)$/.exec(path);
	if (frameless?.[1]) {
		let callId: string;
		try {
			callId = decodeURIComponent(frameless[1]);
		} catch {
			return null;
		}
		if (!isRealtimeCallId(callId)) return null;
		return { callId, upstreamPath: `/live/${callId}`, search: url.search };
	}
	if (/^(?:\/v1)?\/realtime$/.test(path)) {
		const callId = url.searchParams.get("call_id");
		if (!callId || !isRealtimeCallId(callId)) return null;
		return { callId, upstreamPath: "/realtime", search: url.search };
	}
	return null;
}

export function isRealtimeSidebandPath(rawUrl: string): boolean {
	try {
		const path = new URL(rawUrl, "http://127.0.0.1").pathname.replace(/\/+$/, "");
		return /^(?:\/v1)?\/live(?:\/|$)/.test(path) || /^(?:\/v1)?\/realtime$/.test(path);
	} catch {
		return false;
	}
}

function buildSidebandUpstreamUrl(baseUrl: string, target: RealtimeSidebandTarget): string {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}${target.upstreamPath}`;
	url.search = target.search;
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return url.toString();
}

function buildSidebandHeaders(
	incoming: IncomingHttpHeaders,
	credential: RealtimeCallCredential,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(incoming)) {
		const key = name.toLowerCase();
		if (typeof value !== "string") continue;
		if (SIDEBAND_DROPPED_HEADERS.has(key) || key.startsWith("sec-websocket-")) continue;
		headers[key] = value;
	}
	headers.authorization = `Bearer ${credential.accessToken}`;
	headers[OPENAI_HEADERS.ACCOUNT_ID.toLowerCase()] = credential.accountId;
	return headers;
}

function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
	if (socket.destroyed) return;
	const body = `${JSON.stringify({ error: { code, message } })}\n`;
	const reason = status === 404 ? "Not Found" : status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Bad Gateway";
	socket.end(
		`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
	);
}

/** Codes a peer may legally send in a close frame. */
function sendableCloseCode(code: number): number {
	if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) {
		return code;
	}
	return code === 1006 ? 1011 : 1000;
}

function closeQuietly(socket: WebSocket, code: number, reason: Buffer): void {
	if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
	if (socket.readyState === WebSocket.CONNECTING) {
		socket.terminate();
		return;
	}
	try {
		socket.close(sendableCloseCode(code), reason.byteLength <= 123 ? reason : undefined);
	} catch {
		socket.terminate();
	}
}

function rawDataBytes(data: WebSocket.RawData): number {
	if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
	return data.byteLength;
}

/** The parts of a WebSocket the backpressured forwarder needs. */
export interface RelaySocket {
	readonly readyState: number;
	send(data: WebSocket.RawData, options: { binary: boolean }, callback: (error?: Error) => void): void;
	pause(): void;
	resume(): void;
}

/**
 * Forward frames from `source` to `target` without unbounded buffering.
 * `maxPayload` bounds a single frame, not the total waiting for a slow
 * reader, so count bytes until `send` reports them flushed and stop reading
 * `source` while too much is queued.
 */
export function createBackpressuredForwarder(
	source: RelaySocket,
	target: RelaySocket,
	limits: { highWaterBytes: number; lowWaterBytes: number } = {
		highWaterBytes: RELAY_HIGH_WATER_BYTES,
		lowWaterBytes: RELAY_LOW_WATER_BYTES,
	},
): { forward: (data: WebSocket.RawData, isBinary: boolean) => void; readonly pendingBytes: number; readonly paused: boolean } {
	let pending = 0;
	let paused = false;
	const forward = (data: WebSocket.RawData, isBinary: boolean) => {
		if (target.readyState !== WebSocket.OPEN) return;
		const size = rawDataBytes(data);
		pending += size;
		target.send(data, { binary: isBinary }, () => {
			pending -= size;
			if (paused && pending <= limits.lowWaterBytes) {
				paused = false;
				source.resume();
			}
		});
		if (!paused && pending > limits.highWaterBytes) {
			paused = true;
			source.pause();
		}
	};
	return {
		forward,
		get pendingBytes() {
			return pending;
		},
		get paused() {
			return paused;
		},
	};
}

export interface RealtimeSidebandRelayOptions {
	registry: RealtimeCallRegistry;
	upstreamBaseUrl?: string;
	maxPayloadBytes: number;
	/** Record a sanitized failure for status output. Never receives credentials. */
	onError?: (message: string) => void;
}

export interface RealtimeSidebandRelay {
	/** Returns true when the upgrade was a realtime sideband and has been handled. */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
	readonly activeConnections: number;
	close(): void;
}

/**
 * Relay the sideband control socket to the account that created the call.
 * The upstream handshake completes before the local upgrade is accepted, so
 * an upstream 404 (call not active yet) reaches Codex as a 404 it retries.
 */
export function createRealtimeSidebandRelay(options: RealtimeSidebandRelayOptions): RealtimeSidebandRelay {
	const upstreamBaseUrl = options.upstreamBaseUrl ?? REALTIME_SIDEBAND_UPSTREAM_BASE_URL;
	const wss = new WebSocketServer({
		noServer: true,
		perMessageDeflate: false,
		maxPayload: options.maxPayloadBytes,
	});
	const pairs = new Set<{ client: WebSocket; upstream: WebSocket }>();
	let closed = false;

	const pipe = (
		client: WebSocket,
		upstream: WebSocket,
		early: Array<[WebSocket.RawData, boolean]>,
		refresh: () => void,
	) => {
		const pair = { client, upstream };
		pairs.add(pair);
		const toClient = createBackpressuredForwarder(upstream, client).forward;
		const toUpstream = createBackpressuredForwarder(client, upstream).forward;
		for (const [data, isBinary] of early.splice(0)) toClient(data, isBinary);
		client.on("message", toUpstream);
		upstream.on("message", toClient);
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			pairs.delete(pair);
			// Keep the call joinable for a reconnect after this socket drops.
			refresh();
		};
		client.on("close", (code, reason) => {
			end();
			closeQuietly(upstream, code, reason);
		});
		upstream.on("close", (code, reason) => {
			end();
			closeQuietly(client, code, reason);
		});
		client.on("error", () => upstream.terminate());
		upstream.on("error", () => {
			options.onError?.("Realtime sideband upstream socket failed.");
			client.terminate();
		});
	};

	const handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> => {
		if (!isRealtimeSidebandPath(req.url ?? "/")) return false;
		const target = resolveRealtimeSidebandTarget(req.url ?? "/");
		if (!target) {
			rejectUpgrade(
				socket,
				404,
				"realtime_websocket_unsupported",
				"Only WebRTC voice sideband sockets for calls created through this proxy are supported.",
			);
			return true;
		}
		const credential = options.registry.get(target.callId);
		if (!credential || closed) {
			rejectUpgrade(socket, 404, "realtime_call_not_found", "No realtime call with this id was created through this proxy.");
			return true;
		}
		const upstream = new WebSocket(buildSidebandUpstreamUrl(upstreamBaseUrl, target), {
			headers: buildSidebandHeaders(req.headers, credential),
			followRedirects: false,
			handshakeTimeout: SIDEBAND_HANDSHAKE_TIMEOUT_MS,
			maxPayload: options.maxPayloadBytes,
			perMessageDeflate: false,
		});
		// Until the pair is piped, keep the socket from throwing on an error event
		// and hold any frame the upstream sends right after its handshake.
		upstream.on("error", () => undefined);
		const early: Array<[WebSocket.RawData, boolean]> = [];
		const holdEarly = (data: WebSocket.RawData, isBinary: boolean) => {
			if (early.length < 64) early.push([data, isBinary]);
		};
		upstream.on("message", holdEarly);
		const opened = await new Promise<{ ok: true } | { ok: false; status: number }>((resolve) => {
			const settle = (result: { ok: true } | { ok: false; status: number }) => {
				upstream.off("open", onOpen);
				upstream.off("unexpected-response", onUnexpected);
				upstream.off("error", onError);
				socket.off("close", onClientGone);
				resolve(result);
			};
			const onOpen = () => settle({ ok: true });
			const onUnexpected = (_request: unknown, response: IncomingMessage) => {
				response.resume();
				settle({ ok: false, status: response.statusCode ?? 502 });
			};
			const onError = () => settle({ ok: false, status: 502 });
			const onClientGone = () => settle({ ok: false, status: 499 });
			upstream.once("open", onOpen);
			upstream.once("unexpected-response", onUnexpected);
			upstream.once("error", onError);
			socket.once("close", onClientGone);
		});
		if (!opened.ok) {
			upstream.terminate();
			if (opened.status === 499) return true;
			options.onError?.(`Realtime sideband upstream handshake returned ${opened.status}.`);
			// Codex retries 404 while a new call activates. Do not echo 401/403:
			// the managed account was rejected, not the local client.
			const status = opened.status === 404 || opened.status === 429 ? opened.status : 502;
			rejectUpgrade(
				socket,
				status,
				status === 404 ? "realtime_call_not_found" : "realtime_sideband_upstream_error",
				`Realtime sideband upstream handshake failed with status ${opened.status}.`,
			);
			return true;
		}
		if (socket.destroyed || closed) {
			upstream.terminate();
			return true;
		}
		// The call is in use: restart its lifetime so a later reconnect still
		// finds the account that created it.
		const refresh = () => {
			if (!closed) options.registry.remember(target.callId, credential);
		};
		refresh();
		wss.handleUpgrade(req, socket, head, (client) => {
			upstream.off("message", holdEarly);
			pipe(client, upstream, early, refresh);
		});
		return true;
	};

	return {
		handleUpgrade,
		get activeConnections() {
			return pairs.size;
		},
		close() {
			closed = true;
			for (const { client, upstream } of pairs) {
				client.terminate();
				upstream.terminate();
			}
			pairs.clear();
			wss.close();
		},
	};
}
