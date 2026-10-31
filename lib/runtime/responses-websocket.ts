import { MAX_API_ROUTES } from "../api-route-store.js";
import { apiRetryDelayMs } from "../request/api-retry-delay.js";
import { OPENAI_HEADER_VALUES } from "../constants.js";
import { ClientCancellationError } from "../request/client-cancellation.js";
import type { Duplex } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { Agent, fetch as undiciFetch } from "undici";
import { parseModelRoute } from "../model-route-policy.js";
import { isRecord } from "../utils.js";
import { ResponseOutputHistory, hasOrphanToolResult } from "./response-output-history.js";

/** Safe operational evidence only: never persist upstream reason text or payloads. */
export interface WebSocketDisconnectDiagnostic {
 at: number;
 cause: "close" | "transport_error" | "invalid_event" | "buffer_limit" | "send_error";
 stage: "awaiting_first_event" | "streaming";
 closeCode?: number;
 routeKind?: "oauth" | "api" | "zdr" | "psp";
 connectionAgeMs?: number;
 eventCount?: number;
 requestBytes?: number;
 inputItemCount?: number;
 isPrewarm?: boolean;
 hasPreviousResponse?: boolean;
 reusedConnection?: boolean;
 /** Local send callback success, not evidence of upstream receipt. */
 sendCompleted?: boolean;
 compressionNegotiated?: boolean;
 transportErrorCode?: "ECONNRESET" | "EPIPE" | "ETIMEDOUT" | "OTHER";
 tcpEndReceived?: boolean;
 tcpCloseHadError?: boolean;
}
/** Local admission evidence only; no headers, credentials, or conversation IDs. */
export interface WebSocketUpgradeRejectionDiagnostic {
 at: number;
 reason: "origin" | "capacity" | "repeated_disconnect";
 status: number;
 activeConnections: number;
}
interface WebSocketStats {
 connections: number;
 activeConnections: number;
 capacityReclaims: number;
 upstreamConnections: number;
 upstreamRequests: number;
 lastDisconnect?: WebSocketDisconnectDiagnostic;
 lastUpgradeRejection?: WebSocketUpgradeRejectionDiagnostic;
}
const CONTEXT_HEADER = "x-local-responses-transport";
const HTTP_FALLBACK_COOLDOWN_MS = 60_000;
const MAX_HTTP_FALLBACK_SCOPES = 256;
const HTTP_FALLBACK_FAILURE_THRESHOLD = 2;
const MAX_CLIENT_SESSIONS = 64;
// Conservative request ceiling below observed upstream 1009 rejections. This
// is a local routing guard, not a claim about the upstream's undocumented cap.
const MAX_UPSTREAM_WEBSOCKET_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_BRIDGE_KEEPALIVE_MS = 10_000;
const DEFAULT_UPSTREAM_SILENCE_MS = 5 * 60_000;
// Retire pooled API channels before the upstream's observed five-minute lease can
// expire during a newly submitted turn. Continuations reconstruct their full
// input on the fresh channel; a sent create is still never replayed.
const DEFAULT_UPSTREAM_REUSE_MS = 4 * 60_000;
const terminal = new Set([
	"response.completed",
	"response.failed",
	"response.incomplete",
	"response.cancelled",
	"error",
]);
type Json = Record<string, unknown>;
type Chain = { body: Json; output: unknown[]; pool: string; bytes: number };
type Context = { routeKind: "oauth" | "api" | "zdr" | "psp"; signal: AbortSignal; session: SocketSession; previousId?: string; delta?: unknown; clientBeta?: string };
/** A thread-scoped hint only; authentication is checked separately before use. */
function fallbackScope(req: IncomingMessage): string | undefined {
	// Native clients can share a session across threads. Prefer the conversation
	// identity so a failed thread does not downgrade a healthy sibling.
	// Current native clients send hyphenated names; retain older underscore
	// aliases, with thread identity taking priority over a shared session.
	const identity = ["thread-id", "conversation_id", "session-id", "session_id"]
		.map(name => req.headers[name])
		.find((value): value is string => typeof value === "string" && !!value.trim())
		?.trim();
	if (!identity || identity.length > 1024) return undefined;
	const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	const apiKey = req.headers["x-api-key"];
	const credentials = [...new Set([
		bearer,
		typeof apiKey === "string" ? apiKey.trim() : undefined,
	].filter((value): value is string => !!value))].sort();
	if (!credentials.length) return undefined;
	return createHash("sha256").update(JSON.stringify([credentials, identity])).digest("hex");
}
/** Headers that describe the synthetic body or the upgrade itself, never the upstream decision. */
const LOCAL_ONLY_HEADERS = /^(connection|upgrade|keep-alive|sec-websocket-.*|content-length|content-encoding|content-type|transfer-encoding|set-cookie)$/i;
function upstreamHeaders(source: unknown): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!isRecord(source)) return headers;
	for (const [key, value] of Object.entries(source)) {
		if (LOCAL_ONLY_HEADERS.test(key)) continue;
		if (typeof value === "string") headers[key] = value;
		else if (typeof value === "number") headers[key] = String(value);
		else if (Array.isArray(value) && value.every(item => typeof item === "string")) headers[key] = value.join(", ");
	}
	return headers;
}
/** Remove the router's HTTP-only flag; preserve every explicit client beta. */
function mergeBeta(current: string | null, client: string | undefined): string | null {
	const routingFlags = (current ?? "").split(",").map(item => item.trim())
		.filter(item => item && item !== OPENAI_HEADER_VALUES.BETA_RESPONSES);
	const clientFlags = (client ?? "").split(",").map(item => item.trim()).filter(Boolean);
	return [...new Set([...routingFlags, ...clientFlags])].join(", ") || null;
}
function wireError(code: string, status = 400): Json {
	return {
		type: "error",
		status,
		error: {
			type: "invalid_request_error",
			code,
			message:
				code === "previous_response_not_found"
					? "Retry with complete input and no previous_response_id."
					: code === "upstream_websocket_disconnected"
						? "Upstream WebSocket closed before completing the response."
					: "The local WebSocket request could not be served.",
		},
	};
}
function bodyJson(body: RequestInit["body"]): Json {
	const value: unknown = JSON.parse(
		typeof body === "string"
			? body
			: Buffer.from(body as Uint8Array).toString("utf8"),
	);
	if (!isRecord(value)) throw Error("Invalid response body");
	return value;
}

type TransportErrorCode = NonNullable<WebSocketDisconnectDiagnostic["transportErrorCode"]>;
interface SocketTransportEvidence {
	tcpEndReceived: boolean;
	tcpCloseHadError?: boolean;
	transportErrorCode?: TransportErrorCode;
}
function transportErrorCode(error: unknown): TransportErrorCode {
	const code = isRecord(error) ? error.code : undefined;
	return code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT" ? code : "OTHER";
}

/** Per-client memory only; credentials never leave the existing routing boundary. */
class SocketSession {
	readonly channels = new Map<string, WebSocket>();
	private readonly openedAt = new WeakMap<WebSocket, number>();
	private readonly transportEvidence = new WeakMap<WebSocket, SocketTransportEvidence>();
	readonly owners = new Map<string, WebSocket>();
	private readonly interrupts = new Map<string, () => void>();
	readonly chains = new Map<string, Chain>();
	bytes = 0;
	controller: AbortController | undefined;
	closed = false;
	constructor(
		readonly maxBytes: number,
		readonly stats: WebSocketStats,
		private readonly httpFetch: typeof fetch = fetch,
		private readonly onDisconnect?: () => void,
		private readonly onComplete?: () => void,
		private readonly needsHttpRecovery: () => boolean = () => false,
		private readonly httpOnly: Map<string, number> = new Map(),
		private readonly bridgeKeepAliveMs = DEFAULT_BRIDGE_KEEPALIVE_MS,
		private readonly upstreamSilenceMs = DEFAULT_UPSTREAM_SILENCE_MS,
		private readonly upstreamReuseMs = DEFAULT_UPSTREAM_REUSE_MS,
	) {}
	close() {
		this.closed = true;
		for (const cleanup of this.interrupts.values()) cleanup();
		this.controller?.abort();
		for (const socket of this.channels.values()) socket.terminate();
		this.channels.clear();
		this.owners.clear();
		this.chains.clear();
		this.bytes = 0;
	}
	/** Interrupt acknowledgements can follow the terminal generation event. */
	interrupt(event: Json, send: (event: Json) => void): void {
		const id = event.response_id;
		if (typeof id !== "string" || !id || id.length > 1024) {
			send(wireError("invalid_websocket_interrupt"));
			return;
		}
		const failed = () => send({ type: "response.interrupt.failed", response_id: id });
		const owner = this.owners.get(id);
		if (event.mode !== "discard_partial_items" || !owner || owner.readyState !== WebSocket.OPEN) {
			failed();
			return;
		}
		// Native sends one interrupt per response. Do not duplicate it upstream.
		if (this.interrupts.has(id)) return;
		if (this.interrupts.size >= 64) { failed(); return; }
		const cleanup = () => {
			clearTimeout(timer);
			owner.off("message", onMessage);
			owner.off("close", onClose);
			this.interrupts.delete(id);
		};
		const onClose = () => { cleanup(); if (!this.closed) failed(); };
		const onMessage = (raw: WebSocket.RawData, binary: boolean) => {
			if (binary) return;
			let acknowledgement: unknown;
			try { acknowledgement = JSON.parse(raw.toString()); } catch { return; }
			if (!isRecord(acknowledgement) || acknowledgement.response_id !== id ||
				(acknowledgement.type !== "response.interrupt.accepted" && acknowledgement.type !== "response.interrupt.failed")) return;
			cleanup();
			send({ type: acknowledgement.type, response_id: id });
		};
		const timer = setTimeout(onClose, this.upstreamSilenceMs);
		timer.unref();
		this.interrupts.set(id, cleanup);
		owner.on("message", onMessage);
		owner.once("close", onClose);
		owner.send(JSON.stringify({ type: "response.interrupt", response_id: id, mode: "discard_partial_items" }), error => {
			if (error && this.interrupts.get(id) === cleanup) onClose();
		});
	}
	remember(id: string, body: Json, output: unknown[], pool: string) {
		const bytes = Buffer.byteLength(JSON.stringify({ body, output }));
		if (bytes > this.maxBytes) return false;
		const old = this.chains.get(id);
		if (old) this.bytes -= old.bytes;
		this.chains.delete(id);
		this.chains.set(id, { body, output, pool, bytes });
		this.bytes += bytes;
		while (this.bytes > this.maxBytes || this.chains.size > 32) {
			const first = this.chains.keys().next().value;
			if (!first) break;
			const entry = this.chains.get(first);
			this.bytes -= entry?.bytes ?? 0;
			this.chains.delete(first);
			this.owners.delete(first);
		}
		return true;
	}
	private httpRecovery(input: string | URL | Request, init: RequestInit, body: Json): Promise<Response> {
		// generate=false is a WebSocket-only prewarm control. Never turn a
		// transport warmup into a generating HTTP request. The local chain is
		// remembered by serve(), so the next create can reconstruct its input.
		if (body.generate === false) {
			return Promise.resolve(new Response(`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: `resp_local_prewarm_${randomUUID()}`, object: "response", status: "completed", output: [] },
			})}\n\n`, { headers: { "content-type": "text/event-stream" } }));
		}
		// This is a newly submitted create. Never retry a create already sent
		// over a WebSocket; its generation outcome can be ambiguous.
		return this.httpFetch(input, init);
	}
	private rememberHttpRecovery(key: string): void {
		if (!this.httpOnly.has(key) && this.httpOnly.size >= MAX_API_ROUTES) {
			const oldest = this.httpOnly.keys().next().value;
			if (oldest) this.httpOnly.delete(oldest);
		}
		this.httpOnly.delete(key);
		this.httpOnly.set(key, Date.now() + HTTP_FALLBACK_COOLDOWN_MS);
	}
	private retireChannel(key: string, socket: WebSocket): void {
		socket.terminate();
		this.channels.delete(key);
		for (const [responseId, owner] of this.owners)
			if (owner === socket) this.owners.delete(responseId);
	}
	async fetch(
		input: string | URL | Request,
		init: RequestInit,
		context: Context,
	): Promise<Response> {
        if (context.signal.aborted || this.closed) throw new ClientCancellationError();
		const url = new URL(String(input));
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const headers = new Headers(init.headers);
		// The OAuth HTTP beta selects an incompatible upstream protocol when
		// combined with the native WebSocket beta (metadata then close 1011).
		// Keep the original client flags, without the router's HTTP injection.
		const beta = mergeBeta(headers.get("openai-beta"), context.clientBeta);
		if (beta) headers.set("openai-beta", beta);
		else headers.delete("openai-beta");
		const key = createHash("sha256")
			.update(url.toString())
			.update("\0")
			.update(headers.get("authorization") ?? "")
			.update("\0")
			.update(headers.get("chatgpt-account-id") ?? "")
			.digest("hex");
		const apiCredential = !headers.has("chatgpt-account-id");
		const body = bodyJson(init.body);
		for (const [credential, until] of this.httpOnly) {
			if (until <= Date.now()) this.httpOnly.delete(credential);
		}
		if (this.needsHttpRecovery() || (apiCredential && this.httpOnly.has(key))) {
			return this.httpRecovery(input, init, body);
		}
		delete body.stream;
		delete body.background;
		body.store = false;
		body.type = "response.create";
		let socket = this.channels.get(key);
		if (socket?.readyState !== WebSocket.OPEN) {
			if (socket) this.retireChannel(key, socket);
			socket = undefined;
		}
		if (
			apiCredential && socket &&
			Date.now() - (this.openedAt.get(socket) ?? Date.now()) >= this.upstreamReuseMs
		) {
			this.retireChannel(key, socket);
			socket = undefined;
		}
		if (
			context.previousId &&
			socket &&
			this.owners.get(context.previousId) === socket
		) {
			body.previous_response_id = context.previousId;
			body.input = context.delta;
		}
		else if (context.previousId && hasOrphanToolResult(body.input)) {
			return Response.json(wireError("previous_response_not_found"), {status: 400});
		}
		const serializedBody = JSON.stringify(body);
		// Measure the actual UTF-8 create after connection-local delta reduction.
		// HTTP receives the original reconstructed request, never a WS-only delta.
		if (Buffer.byteLength(serializedBody) > MAX_UPSTREAM_WEBSOCKET_REQUEST_BYTES) {
			return this.httpRecovery(input, init, body);
		}
		const reusedConnection = !!socket;
		let handshakeHeaders: Record<string, string> | undefined;
		if (!socket) {
			if (context.signal.aborted || this.closed) throw new ClientCancellationError();
			if (this.channels.size >= 16) {
				const first = this.channels.keys().next().value;
				if (first) {
					this.channels.get(first)?.terminate();
					this.channels.delete(first);
				}
			}
			for (const name of [
				"connection",
				"upgrade",
				"content-length",
				"content-type",
				"content-encoding",
				"host",
			])
				headers.delete(name);
			this.stats.upstreamConnections++;
			socket = new WebSocket(url, {
				headers: Object.fromEntries(headers),
				followRedirects: false,
				handshakeTimeout: 15000,
				maxPayload: this.maxBytes,
				// Offer native compression with modest zlib work and request dictionary
				// resets. Message limits also apply after inflation; peers can decline
				// the extension and continue using WebSockets.
				perMessageDeflate: {
					clientNoContextTakeover: true,
					serverNoContextTakeover: true,
					concurrencyLimit: 4,
					threshold: 1024,
					zlibDeflateOptions: { level: 3 },
				},
			});
			const opening = socket;
			const rejected = await new Promise<Response | undefined>(
				(resolve, reject) => {
					const abort = () => {
						opening.terminate();
						cleanup();
                        reject(context.signal.aborted ? new ClientCancellationError() : Error("WebSocket request cancelled"));
					};
					const cleanup = () => {
                        init.signal?.removeEventListener("abort", abort);
                        context.signal.removeEventListener("abort", abort);
                    };
                    context.signal.addEventListener("abort", abort, {once:true});
					init.signal?.addEventListener("abort", abort, { once: true });
					opening.once("upgrade", (response) => {
						handshakeHeaders = upstreamHeaders(response.headers);
						// ws consumes TCP/TLS errors without re-emitting them. Observe
						// the public upgrade socket before its close handler runs.
						const tcp = response.socket;
						const evidence: SocketTransportEvidence = { tcpEndReceived: false };
						this.transportEvidence.set(opening, evidence);
						const onEnd = () => { evidence.tcpEndReceived = true; };
						const onError = (error: Error) => { evidence.transportErrorCode = transportErrorCode(error); };
						tcp.once("end", onEnd);
						tcp.once("error", onError);
						tcp.once("close", (hadError) => {
							evidence.tcpCloseHadError = hadError;
							tcp.off("end", onEnd);
							tcp.off("error", onError);
						});
					});
					opening.once("open", () => {
						cleanup();
						resolve(undefined);
					});
					opening.once("error", () => {
						cleanup();
						reject(context.signal.aborted ? new ClientCancellationError() : Error("Upstream WebSocket connection failed"));
					});
					opening.once("unexpected-response", (_request, response) => {
						cleanup();
						response.resume();
						const status = response.statusCode ?? 502;
						resolve(
							Response.json(
								{
									error: {
										code: "websocket_handshake_rejected",
										message: "Upstream rejected the WebSocket handshake.",
									},
								},
								// Retry-After and x-codex-* quota headers drive cooldowns.
								{ status: status >= 400 && status <= 599 ? status : 502, headers: upstreamHeaders(response.headers) },
							),
						);
						opening.terminate();
					});
				},
			);
			if (rejected) {
				if (!apiCredential) return rejected;
				this.rememberHttpRecovery(key);
				return this.httpRecovery(input, init, body);
			}
			this.openedAt.set(socket, Date.now());
			this.channels.set(key, socket);
		}
		const active = socket;
		return new Promise<Response>((resolve, reject) => {
			let accepted = false,
				finished = false;
			let bodyCancelled = false;
			let eventCount = 0;
			let sendCompleted = false;
			let requestTransportErrorCode: TransportErrorCode | undefined;
			let upstreamSilence: NodeJS.Timeout | undefined;
			let streamController: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						streamController = controller;
					},
					cancel() {
						bodyCancelled = true;
						active.terminate();
					},
				},
				{ highWaterMark: this.maxBytes, size: (chunk) => chunk.byteLength },
			);
			const keepalive = setInterval(() => {
				if (!finished && !bodyCancelled)
					streamController.enqueue(Buffer.from(": keepalive\n\n"));
			}, this.bridgeKeepAliveMs);
			keepalive.unref();
			const cleanup = () => {
				clearInterval(keepalive);
				clearTimeout(upstreamSilence);
				active.off("message", resetUpstreamSilence);
				active.off("message", onMessage);
				active.off("close", onSocketClose);
				active.off("error", onError);
				init.signal?.removeEventListener("abort", abort);
                context.signal.removeEventListener("abort", abort);
			};
			const onClose = (closeCode?: number, cause: WebSocketDisconnectDiagnostic["cause"] = "close") => {
				if (finished) return;
				finished = true;
				cleanup();
				this.channels.delete(key);
                const cancelled = bodyCancelled || init.signal?.aborted || context.signal.aborted || this.closed;
                if (!cancelled) {
					if (apiCredential) this.rememberHttpRecovery(key);
                    this.onDisconnect?.();
                    const at = Date.now();
                    const transport = this.transportEvidence.get(active);
                    const errorCode = transport?.transportErrorCode ?? requestTransportErrorCode;
                    this.stats.lastDisconnect = {
                        at, cause, routeKind: context.routeKind,
                        connectionAgeMs: Math.max(0, at - (this.openedAt.get(active) ?? at)), eventCount,
                        stage: accepted ? "streaming" : "awaiting_first_event",
                        ...(typeof closeCode === "number" ? {closeCode} : {}),
                        requestBytes: Buffer.byteLength(serializedBody),
                        ...(Array.isArray(body.input) ? { inputItemCount: body.input.length } : {}),
                        isPrewarm: body.generate === false,
                        hasPreviousResponse: typeof body.previous_response_id === "string" && body.previous_response_id.length > 0,
                        reusedConnection, sendCompleted,
                        compressionNegotiated: active.extensions.split(",").some(extension => extension.trim() === "permessage-deflate"),
                        ...(transport ? { tcpEndReceived: transport.tcpEndReceived,
                            ...(transport.tcpCloseHadError !== undefined ? { tcpCloseHadError: transport.tcpCloseHadError } : {}),
                        } : {}),
                        ...(errorCode ? { transportErrorCode: errorCode } : {}),
                    };
                }
                // Once create has been sent, a disconnect cannot prove generation
                // did not start. Never replay it, even before the first event.
                const error = cancelled
                    ? new ClientCancellationError()
                    : Error("Upstream WebSocket disconnected");
                if (accepted && !cancelled) {
                    // Preserve a protocol error through the loopback SSE bridge.
                    // Destroying its HTTP stream loses the cause at the local WS.
                    streamController.enqueue(Buffer.from(`data: ${JSON.stringify(wireError("upstream_websocket_disconnected", 502))}\n\n`));
                    streamController.close();
                }
                else if (accepted) streamController.error(error);
                else if (cancelled) reject(error);
                else {
                    // A sent create has an ambiguous outcome. Return a terminal
                    // stream error so the HTTP router cannot retry generation.
                    resolve(new Response(`data: ${JSON.stringify(wireError("upstream_websocket_disconnected", 502))}\n\n`, {
                        headers: {"content-type":"text/event-stream"},
                    }));
                }
			};
			const onSocketClose = (code: number) => onClose(code);
			const onError = (error: Error) => {
				requestTransportErrorCode = transportErrorCode(error);
				onClose(undefined, "transport_error");
			};
			const abort = () => active.terminate();
			const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
				let failureCause: WebSocketDisconnectDiagnostic["cause"] = "invalid_event";
				try {
					if (isBinary) throw Error("Unexpected binary response");
					const text = raw.toString();
					const event: unknown = JSON.parse(text);
					if (!isRecord(event) || typeof event.type !== "string")
						throw Error("Invalid response event");
					// Owned control listeners deliver these even after this stream ends.
					if (event.type === "response.interrupt.accepted" || event.type === "response.interrupt.failed") return;
					eventCount++;
					if (event.type === "error" && !accepted) {
						finished = true;
						cleanup();
						const status =
							typeof event.status === "number" &&
							event.status >= 400 &&
							event.status <= 599
								? event.status
								: 400;
						resolve(Response.json(event, { status, headers: upstreamHeaders(event.headers) }));
						return;
					}
					if (!accepted) {
						accepted = true;
						// Handshake headers describe the account only at connect time,
						// so they ride on the first response of a fresh socket.
						resolve(
							new Response(stream, {
								headers: { ...handshakeHeaders, "content-type": "text/event-stream" },
							}),
						);
					}
					if ((streamController.desiredSize ?? 0) < -this.maxBytes) {
						failureCause = "buffer_limit";
						throw Error("Upstream buffer exceeded");
					}
					streamController.enqueue(Buffer.from(`data: ${text}\n\n`));
					if (
						isRecord(event.response) &&
						typeof event.response.id === "string"
					) {
						this.owners.set(event.response.id, active);
						if (this.owners.size > 64) {
							const first = this.owners.keys().next().value;
							if (first) this.owners.delete(first);
						}
					}
					if (terminal.has(event.type)) {
						// A prewarm completion proves only connection setup, not that
						// generation works. It must not erase a real disconnect history.
						if (event.type === "response.completed" && body.generate !== false)
							this.onComplete?.();
						finished = true;
						cleanup();
						streamController.close();
					}
				} catch {
					onClose(undefined, failureCause);
					active.terminate();
				}
			};
			const resetUpstreamSilence = () => {
				clearTimeout(upstreamSilence);
				if (finished) return;
				upstreamSilence = setTimeout(() => active.terminate(), this.upstreamSilenceMs);
				upstreamSilence.unref();
			};
			active.on("message", onMessage);
			active.once("close", onSocketClose);
			active.once("error", onError);
			init.signal?.addEventListener("abort", abort, { once: true });
			context.signal.addEventListener("abort", abort, {once:true});
			active.on("message", resetUpstreamSilence);
			resetUpstreamSilence();
            if (init.signal?.aborted || context.signal.aborted) {
				abort();
				return;
			}
			this.stats.upstreamRequests++;
			active.send(serializedBody, (error) => {
				if (error) {
					requestTransportErrorCode = transportErrorCode(error);
					onClose(undefined, "send_error");
					active.terminate();
				} else sendCompleted = true;
			});
		});
	}
}

/** Adapts only the transport; authenticated HTTP routing remains the policy authority. */
export class ResponsesWebSocketGateway {
	readonly stats: WebSocketStats = {
		connections: 0,
		activeConnections: 0,
		capacityReclaims: 0,
		upstreamConnections: 0,
		upstreamRequests: 0,
	};
	private readonly contexts = new Map<string, Context>();
	private readonly scope = new AsyncLocalStorage<Context>();
	private readonly sessions = new Map<SocketSession, { socket: WebSocket; canReclaim: () => boolean }>();
	/** Credential-hashed, bounded API handshake backoff survives local reconnects. */
	private readonly apiHandshakeBackoff = new Map<string, number>();
	private readonly websocketFailures = new Map<string, { until: number; count: number }>();
	private readonly wss: WebSocketServer;
	private readonly maxBytes: number;
	/** Loopback hops must never go through an environment HTTP proxy (NODE_USE_ENV_PROXY). */
	private readonly loopback = new Agent();
	private readonly loopbackFetch = ((input: string, init?: RequestInit) =>
		undiciFetch(input, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: this.loopback })) as unknown as typeof fetch;
	constructor(
		private readonly upstreamFetch: typeof fetch,
		private readonly options: {
			maxPayloadBytes: number;
			bridgeKeepAliveMs?: number;
			upstreamSilenceMs?: number;
			upstreamReuseMs?: number;
			upgrade?: (
				req: IncomingMessage,
				socket: Duplex,
				head: Buffer,
			) => Promise<boolean>;
			routeModel?: (model: string, headers: Headers) => string;
		},
	) {
		this.maxBytes = options.maxPayloadBytes;
		if (options.bridgeKeepAliveMs !== undefined && options.bridgeKeepAliveMs < 1)
			throw Error("bridgeKeepAliveMs must be positive");
		if (options.upstreamSilenceMs !== undefined && options.upstreamSilenceMs < 1)
			throw Error("upstreamSilenceMs must be positive");
		if (options.upstreamReuseMs !== undefined && options.upstreamReuseMs < 1)
			throw Error("upstreamReuseMs must be positive");
		this.wss = new WebSocketServer({
			noServer: true,
			maxPayload: this.maxBytes,
			perMessageDeflate: false,
			// ws validates method/key/version/subprotocol before this synchronous gate.
			// An invalid newcomer must never evict an existing usable connection.
			verifyClient: ({ req }, done) => {
				if (req.socket.destroyed || !req.socket.readable || !req.socket.writable) {
					done(false, 503);
					return;
				}
				if (this.sessions.size >= MAX_CLIENT_SESSIONS && !this.reclaimIdleSession()) {
					// Capacity is not an authentication failure. Native Codex handles
					// 426 immediately instead of retrying five rejected handshakes.
					this.recordUpgradeRejection("capacity", 426);
					done(false, 426);
					return;
				}
				done(true);
			},
		});
	}
	readonly fetch: typeof fetch = async (input, init) => {
		const context = this.scope.getStore();
		if (
			context &&
			init?.method === "POST" &&
			new URL(String(input)).pathname.endsWith("/responses")
		)
			return context.session.fetch(input, init, context);
		return this.upstreamFetch(input, init);
	};
	private rememberDisconnect(scope: string | undefined): void {
		if (!scope) return;
		const now = Date.now();
		for (const [key, failure] of this.websocketFailures) {
			if (failure.until <= now) this.websocketFailures.delete(key);
		}
		const count = Math.min((this.websocketFailures.get(scope)?.count ?? 0) + 1, HTTP_FALLBACK_FAILURE_THRESHOLD);
		this.websocketFailures.delete(scope);
		this.websocketFailures.set(scope, { until: now + HTTP_FALLBACK_COOLDOWN_MS, count });
		while (this.websocketFailures.size > MAX_HTTP_FALLBACK_SCOPES) {
			const oldest = this.websocketFailures.keys().next().value;
			if (oldest === undefined) break;
			this.websocketFailures.delete(oldest);
		}
	}
	private needsHttpFallback(req: IncomingMessage): boolean {
		const scope = fallbackScope(req);
		if (!scope) return false;
		const failure = this.websocketFailures.get(scope);
		if (!failure) return false;
		if (failure.until > Date.now()) return failure.count >= HTTP_FALLBACK_FAILURE_THRESHOLD;
		this.websocketFailures.delete(scope);
		return false;
	}
	/** One writer for the upgrade-rejection diagnostic so the two reject paths cannot drift. */
	private recordUpgradeRejection(reason: WebSocketUpgradeRejectionDiagnostic["reason"], status: number): void {
		this.stats.lastUpgradeRejection = { at: Date.now(), reason, status, activeConnections: this.sessions.size };
	}
	/** Release idle setup sockets only; active work and generated history stay pinned. */
	private reclaimIdleSession(): boolean {
		for (const [session, client] of this.sessions) {
			if (!client.canReclaim()) continue;
			this.sessions.delete(session);
			this.stats.activeConnections = this.sessions.size;
			this.stats.capacityReclaims++;
			session.close();
			client.socket.terminate();
			return true;
		}
		return false;
	}
	handle(req: IncomingMessage, handler: () => Promise<void>): void {
		const id = req.headers[CONTEXT_HEADER];
		delete req.headers[CONTEXT_HEADER];
		const context = typeof id === "string" ? this.contexts.get(id) : undefined;
		if (typeof id === "string") this.contexts.delete(id);
		if (context)
			this.scope.run(context, () => {
				void handler();
			});
		else void handler();
	}
	attach(server: Server, baseUrl: string): void {
		server.on("upgrade", (req, socket, head) => {
            // Node relinquishes its socket error handler before emitting upgrade.
            socket.on("error", () => socket.destroy());
			const reject = (status: number) => {
                if (socket.destroyed) return;
				socket.end(
					`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
				);
			};
			const rejectAdmission = (reason: WebSocketUpgradeRejectionDiagnostic["reason"], status: number) => {
				if (socket.destroyed) return;
				this.recordUpgradeRejection(reason, status);
				reject(status);
			};
			void (async () => {
				const credentials: Record<string, string> = {};
				for (const name of ["authorization", "x-api-key"]) {
					const value = req.headers[name];
					if (typeof value === "string") credentials[name] = value;
				}
				// An authenticated unknown HTTP path returns 404; all unknown credentials return 401.
				const auth = await this.loopbackFetch(`${baseUrl}/__websocket_auth_check__`, {
					headers: credentials,
					signal: AbortSignal.timeout(5000),
				});
				await auth.body?.cancel();
				if (auth.status !== 404) {
					// Only a real 401 means bad credentials; a storage or policy outage is
					// transient and must not make the native client distrust its login.
					reject(auth.status === 401 ? 401 : auth.status >= 500 ? 503 : auth.status);
					return;
				}
				if (req.headers.origin) {
					rejectAdmission("origin", 403);
					return;
				}
				if (await this.options.upgrade?.(req, socket, head)) return;
				const path = new URL(req.url ?? "/", baseUrl).pathname;
				if (
					![
						"/responses",
						"/v1/responses",
						"/backend-api/codex/responses",
					].includes(path)
				) {
					reject(404);
					return;
				}
                // Keep native transport on WebSocket during temporary upstream
                // HTTP recovery. At capacity, preserve admission behavior rather
                // than evicting another session just to serve a recovery scope.
                if (this.needsHttpFallback(req) && this.sessions.size >= MAX_CLIENT_SESSIONS) {
                    rejectAdmission("repeated_disconnect", 426);
                    return;
                }
                if (socket.destroyed) return;
				this.wss.handleUpgrade(req, socket, head, (ws) =>
					this.serve(ws, req, baseUrl),
				);
			})().catch(() => reject(503));
		});
	}
	private serve(ws: WebSocket, req: IncomingMessage, baseUrl: string): void {
		this.stats.connections++;
		const scope = fallbackScope(req);
		const session = new SocketSession(
			this.maxBytes, this.stats, this.upstreamFetch,
			() => this.rememberDisconnect(scope),
			() => { if (scope) this.websocketFailures.delete(scope); },
			() => this.needsHttpFallback(req),
			this.apiHandshakeBackoff,
			this.options.bridgeKeepAliveMs ?? DEFAULT_BRIDGE_KEEPALIVE_MS,
			this.options.upstreamSilenceMs ?? DEFAULT_UPSTREAM_SILENCE_MS,
			this.options.upstreamReuseMs ?? DEFAULT_UPSTREAM_REUSE_MS,
		);
		let queue = Promise.resolve(),
			queued = 0,
			queuedBytes = 0;
		let generation = 0;
		// Pending work is protected by queued/controller; rejected creates retain no history.
		let hasGeneratedHistory = false;
		this.sessions.set(session, {
			socket: ws,
			canReclaim: () => !hasGeneratedHistory && queued === 0 && !session.controller && !session.closed && ws.readyState === WebSocket.OPEN,
		});
		this.stats.activeConnections = this.sessions.size;
		const send = (event: Json) => {
			if (ws.readyState !== WebSocket.OPEN) return;
			if (ws.bufferedAmount > this.maxBytes) {
				ws.terminate();
				return;
			}
			ws.send(JSON.stringify(event));
		};
		ws.on("error", () => ws.terminate());
		ws.once("close", () => {
			session.close();
			this.sessions.delete(session);
			this.stats.activeConnections = this.sessions.size;
		});
		const bridgeKeepalive = setInterval(() => {
			if (session.controller && ws.readyState === WebSocket.OPEN) ws.ping();
		}, this.options.bridgeKeepAliveMs ?? DEFAULT_BRIDGE_KEEPALIVE_MS);
		bridgeKeepalive.unref();
		ws.once("close", () => clearInterval(bridgeKeepalive));
		ws.on("message", (raw, isBinary) => {
			let event: Json;
			try {
				const parsed: unknown = JSON.parse(raw.toString());
				if (isBinary || !isRecord(parsed)) throw Error();
				event = parsed;
			} catch {
				send(wireError("invalid_websocket_event"));
				return;
			}
			if (event.type === "response.cancel") {
				// Invalidate work accepted before cancellation, including queued creates.
				generation++;
				session.controller?.abort();
				for (const channel of session.channels.values()) channel.terminate();
				return;
			}
			if (event.type === "response.steer") {
				const previousId = typeof event.previous_response_id === "string"
					? event.previous_response_id
					: undefined;
				const owner = previousId ? session.owners.get(previousId) : undefined;
				if (!owner || owner.readyState !== WebSocket.OPEN) {
					send(wireError("previous_response_not_found"));
					return;
				}
				owner.send(raw.toString(), (error) => {
					if (error) send(wireError("websocket_steer_failed", 502));
				});
				return;
			}
			if (event.type === "response.interrupt") {
				session.interrupt(event, send);
				return;
			}
			if (event.type !== "response.create") {
				send(wireError("unsupported_websocket_event"));
				return;
			}
			const eventBytes = Buffer.byteLength(raw.toString());
			if (++queued > 16 || queuedBytes + eventBytes > this.maxBytes) {
				queued--;
				send(wireError("websocket_queue_full", 429));
				return;
			}
			queuedBytes += eventBytes;
			const acceptedGeneration = generation;
			queue = queue
				.then(async () => {
					if (session.closed || acceptedGeneration !== generation) return;
					try {
						if (typeof event.model !== "string" || !Array.isArray(event.input))
							throw Error("invalid_request_body");
						const routingHeaders = new Headers();
						for (const [key, value] of Object.entries(req.headers))
							if (typeof value === "string") routingHeaders.set(key, value);
						event.model =
							this.options.routeModel?.(event.model, routingHeaders) ??
							event.model;
						const pool = parseModelRoute(event.model as string).kind;
						const previousId =
							typeof event.previous_response_id === "string"
								? event.previous_response_id
								: undefined;
						const prior = previousId
							? session.chains.get(previousId)
							: undefined;
						if (previousId && !prior) {
							send(wireError("previous_response_not_found"));
							return;
						}
						if (prior && prior.pool !== pool) {
							send(wireError("model_route_pool_mismatch"));
							return;
						}
						const body: Json = {
							...prior?.body,
							...event,
							input: prior
								? [
										...(Array.isArray(prior.body.input)
											? prior.body.input
											: []),
										...prior.output,
										...event.input,
									]
								: event.input,
							stream: true,
							store: false,
						};
						delete body.type;
						delete body.previous_response_id;
						// Native prewarm sets generate=false; omission on the next create
						// means generate normally, not inherit the warm-up's control flag.
						if (event.generate === undefined) delete body.generate;
						if (Buffer.byteLength(JSON.stringify(body)) > this.maxBytes) {
							send(wireError("websocket_context_too_large", 413));
							return;
						}
						const id = randomUUID();
						const controller = new AbortController();
                        session.controller = controller;
                        const clientBeta = req.headers["openai-beta"];
                        this.contexts.set(id, { routeKind: pool, session, previousId, delta: event.input, signal: controller.signal, clientBeta: typeof clientBeta === "string" ? clientBeta : undefined });
						const headers = new Headers();
						for (const [key, value] of Object.entries(req.headers)) {
							if (
								typeof value === "string" &&
								!/^(host|connection|upgrade|sec-websocket-|content-|origin)/i.test(
									key,
								)
							)
								headers.set(key, value);
						}
						headers.set(CONTEXT_HEADER, id);
						headers.set("content-type", "application/json");
						try {
							const response = await this.loopbackFetch(`${baseUrl}/responses`, {
								method: "POST",
								headers,
								body: JSON.stringify(body),
								signal: controller.signal,
							});
							if (!response.ok) {
								// An empty or non-JSON error body must not turn a real 401 into a 502.
								const data: unknown = await response.json().catch(() => undefined);
								const retryMs = apiRetryDelayMs(data, Date.now(), response.headers);
								send(
									{ ...(isRecord(data) ? data : wireError("websocket_request_failed", response.status)),
										type: "error", status: response.status,
										...(retryMs > 0 ? {headers:{"retry-after":String(Math.ceil(retryMs / 1000))}} : {}),
									},
								);
								return;
							}
							if (!response.body) throw Error("missing_response_body");
							let buffer = "";
							const outputHistory = new ResponseOutputHistory(this.maxBytes);
							const decoder = new TextDecoder();
							for await (const chunk of response.body) {
								buffer += decoder.decode(chunk, { stream: true });
								if (Buffer.byteLength(buffer) > this.maxBytes)
									throw Error("websocket_event_too_large");
								let index: number;
								while ((index = buffer.indexOf("\n\n")) >= 0) {
									const frame = buffer.slice(0, index);
									buffer = buffer.slice(index + 2);
									const data = frame
										.split("\n")
										.filter((line) => line.startsWith("data:"))
										.map((line) => line.slice(5).trimStart())
										.join("\n");
									if (!data || data === "[DONE]") continue;
									const parsed: unknown = JSON.parse(data);
									if (!isRecord(parsed)) throw Error("invalid_response_event");
									outputHistory.observe(parsed);
									if (
										parsed.type === "response.completed" &&
										isRecord(parsed.response) &&
										typeof parsed.response.id === "string"
									) {
										const output = outputHistory.finish(parsed.response.output);
										if (output && session.remember(
											parsed.response.id,
											body,
											output,
											pool,
										) && body.generate !== false) hasGeneratedHistory = true;
									}
									send(parsed);
								}
							}
						} finally {
							this.contexts.delete(id);
							if (session.controller === controller)
								session.controller = undefined;
						}
					} catch {
						if (!session.closed)
							send(wireError("websocket_request_failed", 502));
					}
				})
				.finally(() => {
					queued--;
					queuedBytes -= eventBytes;
				});
		});
	}
	close() {
		for (const ws of this.wss.clients) ws.terminate();
		for (const session of this.sessions.keys()) session.close();
		this.sessions.clear();
		this.stats.activeConnections = 0;
		this.contexts.clear();
		this.websocketFailures.clear();
		this.apiHandshakeBackoff.clear();
		this.wss.close();
		void this.loopback.close().catch(() => undefined);
	}
}
