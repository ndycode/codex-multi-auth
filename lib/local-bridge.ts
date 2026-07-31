import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { fetch as undiciFetch } from "undici";
import { verifyLocalClientBearerToken } from "./local-client-tokens.js";
import {
	createMiniMaxModelsResponse,
	getMiniMaxEndpoints,
	type MiniMaxRegion,
} from "./providers/minimax.js";
import { appendUsageLedgerRow } from "./usage/index.js";

export interface LocalBridgeServer {
	host: string;
	port: number;
	baseUrl: string;
	close: () => Promise<void>;
}

interface LocalBridgeCommonOptions {
	host?: string;
	port?: number;
	fetchImpl?: typeof fetch;
	requireAuth?: boolean;
	verifyBearerToken?: typeof verifyLocalClientBearerToken;
}

export interface MiniMaxBridgeBackendOptions {
	apiKey: string;
	region?: MiniMaxRegion;
}

export type LocalBridgeOptions = LocalBridgeCommonOptions &
	(
		| {
				runtimeBaseUrl: string;
				runtimeClientApiKey?: string;
				miniMax?: never;
		  }
		| {
				miniMax: MiniMaxBridgeBackendOptions;
				runtimeBaseUrl?: never;
				runtimeClientApiKey?: never;
		  }
	);

const DEFAULT_HOST = "127.0.0.1";
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"content-length",
	"expect",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const DECODED_UPSTREAM_RESPONSE_HEADERS = new Set(["content-encoding"]);

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "127.0.0.1" ||
		normalized === "localhost" ||
		normalized === "::1" ||
		// new URL("http://[::1]:port").hostname yields the bracketed form, so the
		// IPv6 loopback runtime proxy must match here too (mirrors the guard in
		// lib/runtime-rotation-proxy.ts). Without this, a valid [::1] runtimeBaseUrl
		// is falsely rejected as non-loopback.
		normalized === "[::1]"
	);
}

/** Strip surrounding brackets from an IPv6 literal: "[::1]" -> "::1". */
function stripIpv6Brackets(host: string): string {
	const trimmed = host.trim();
	return trimmed.startsWith("[") && trimmed.endsWith("]")
		? trimmed.slice(1, -1)
		: trimmed;
}

/** Raw literal for server.listen (IPv6 must be unbracketed: "::1", not "[::1]"). */
function toBindHost(host: string): string {
	return stripIpv6Brackets(host);
}

/** Authority for a URL: IPv6 must be bracketed ("[::1]"), IPv4/hostnames as-is. */
function toUrlHost(host: string): string {
	const bare = stripIpv6Brackets(host);
	return bare.includes(":") ? `[${bare}]` : bare;
}

function responseHeadersForClient(headers: Headers): Headers {
	const result = new Headers();
	for (const [key, value] of headers.entries()) {
		if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
		if (DECODED_UPSTREAM_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
		result.set(key, value);
	}
	return result;
}

function forwardHeaders(headers: Headers, outboundBearerToken?: string): Headers {
	const result = new Headers(headers);
	for (const key of HOP_BY_HOP_HEADERS) {
		result.delete(key);
	}
	result.delete("host");
	// runtime-proxy-02: never forward inbound client credentials upstream. Beyond
	// Authorization (handled below), an inbound `x-api-key` would also leak the
	// caller's local credential across the bridge boundary and could change which
	// auth the runtime proxy evaluates — strip it unconditionally.
	result.delete("x-api-key");
	// Same contract: never carry an inbound Cookie / proxy-auth header upstream
	// alongside the managed token.
	result.delete("cookie");
	result.delete("proxy-authorization");
	// Present only the configured backend credential. The inbound client's
	// Authorization was already validated locally and must never cross this bridge.
	if (outboundBearerToken && outboundBearerToken.trim().length > 0) {
		result.set("authorization", `Bearer ${outboundBearerToken.trim()}`);
	} else {
		result.delete("authorization");
	}
	return result;
}

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array> | null): Promise<ArrayBuffer | null> {
	if (!stream) return null;
	const response = new Response(stream);
	return response.arrayBuffer();
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	if (!server.listening) return;
	const closed = new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
	server.closeIdleConnections?.();
	for (const socket of sockets) {
		socket.destroy();
	}
	await closed;
}

async function toWebRequest(req: IncomingMessage, host: string, port: number): Promise<Request> {
	const url = new URL(req.url ?? "/", `http://${host}:${port}`);
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else {
			headers.set(key, value);
		}
	}
	const method = req.method ?? "GET";
	const body =
		method === "GET" || method === "HEAD"
			? undefined
			: await new Response(req).arrayBuffer();
	return new Request(url, { method, headers, body });
}

function writeWebResponse(res: ServerResponse, response: Response): void {
	res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	if (!response.body) {
		res.end();
		return;
	}
	const reader = response.body.getReader();
	const pump = async (): Promise<void> => {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) res.write(Buffer.from(value));
		}
		res.end();
	};
	void pump().catch((error) => {
		if (!res.destroyed) {
			res.destroy(error instanceof Error ? error : undefined);
		}
	});
}

export async function startLocalBridge(
	options: LocalBridgeOptions,
): Promise<LocalBridgeServer> {
	const host = options.host ?? DEFAULT_HOST;
	if (!isLoopbackHost(host)) {
		throw new Error("Local bridge only supports loopback hosts.");
	}
	// Normalize once: server.listen needs the raw IPv6 literal ("::1"), while the
	// emitted baseUrl / request URL authority needs the bracketed form ("[::1]").
	// Using the raw host for both (the prior bug) made "[::1]" fail the bind and
	// "::1" produce an invalid "http://::1:port".
	const bindHost = toBindHost(host);
	const urlHost = toUrlHost(host);
	const port = options.port ?? 0;
	const fetchImpl = options.fetchImpl ?? (undiciFetch as typeof fetch);
	const requireAuth = options.requireAuth ?? true;
	const verifyBearerToken = options.verifyBearerToken ?? verifyLocalClientBearerToken;
	const miniMax = options.miniMax;
	const runtimeBaseUrl = options.runtimeBaseUrl?.trim().replace(/\/+$/, "") || null;
	const runtimeClientApiKey = options.runtimeClientApiKey?.trim() || undefined;
	const miniMaxRegion = miniMax?.region ?? "global";
	if (miniMaxRegion !== "global" && miniMaxRegion !== "cn") {
		throw new Error(`Local bridge received an unsupported MiniMax region: ${miniMaxRegion}`);
	}
	const miniMaxApiKey = miniMax?.apiKey.trim() || undefined;
	const miniMaxEndpoints = miniMax ? getMiniMaxEndpoints(miniMaxRegion) : null;

	if (miniMax) {
		if (!miniMaxApiKey) {
			throw new Error("Local bridge requires a MiniMax apiKey.");
		}
		if (!requireAuth) {
			throw new Error(
				"Local bridge requires requireAuth=true for a MiniMax backend.",
			);
		}
	} else {
		if (!runtimeBaseUrl) {
			throw new Error("Local bridge requires a runtimeBaseUrl.");
		}
		// The runtime target must remain loopback-only. Allowing an arbitrary URL
		// here would send local bridge credentials outside the trusted boundary.
		let runtimeHost: string;
		try {
			runtimeHost = new URL(runtimeBaseUrl).hostname;
		} catch {
			throw new Error(
				`Local bridge runtimeBaseUrl is not a valid URL: ${runtimeBaseUrl}`,
			);
		}
		if (!isLoopbackHost(runtimeHost)) {
			throw new Error(
				`Local bridge refuses to forward to non-loopback runtimeBaseUrl host "${runtimeHost}". ` +
					"It must target the loopback runtime proxy.",
			);
		}
	}

	if (runtimeClientApiKey && !requireAuth) {
		// Security: forwarding a runtime client key while accepting unauthenticated
		// inbound requests turns the bridge into an open local capability proxy —
		// any local process that can reach the loopback port gets upstream access
		// for free. The runtime-proxy-03 feature (inject a client key to reach an
		// auth-enabled proxy) is only safe when inbound auth is also required, so
		// fail fast on this combination rather than silently granting it.
		throw new Error(
			"Local bridge requires requireAuth=true when runtimeClientApiKey is configured.",
		);
	}
	const app = new Hono();

	app.get("/health", (context) => {
		if (miniMax) {
			return context.json({
				ok: true,
				service: "codex-multi-auth-local-bridge",
				backend: "MiniMax",
				region: miniMaxRegion,
			});
		}
		return context.json({
			ok: true,
			service: "codex-multi-auth-local-bridge",
			runtimeBaseUrl,
		});
	});

	const authorize = async (
		request: Request,
		startedAt: number,
	): Promise<Response | null> => {
		if (!requireAuth) return null;
		let token = await verifyBearerToken(
			request.headers.get("authorization"),
			startedAt,
		);
		if (!token) {
			const apiKey = request.headers.get("x-api-key")?.trim();
			if (apiKey) {
				token = await verifyBearerToken(`Bearer ${apiKey}`, startedAt);
			}
		}
		if (token) return null;
		return new Response(
			JSON.stringify({
				error: {
					message: "Local bridge rejected an unauthenticated request.",
					code: "local_bridge_unauthorized",
				},
			}),
			{
				status: 401,
				headers: { "content-type": "application/json; charset=utf-8" },
			},
		);
	};

	const forward = async (
		request: Request,
		targetUrl: string,
		operation: "models" | "responses" | "messages",
		outboundBearerToken?: string,
	): Promise<Response> => {
		const startedAt = Date.now();
		const unauthorized = await authorize(request, startedAt);
		if (unauthorized) return unauthorized;
		let upstream: Response;
		try {
			upstream = await fetchImpl(targetUrl, {
				method: request.method,
				headers: forwardHeaders(request.headers, outboundBearerToken),
				body:
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: await streamToArrayBuffer(request.body),
			});
		} catch {
			await appendUsageLedgerRow({
				source: "local-bridge",
				operation,
				outcome: "failure",
				statusCode: 502,
				errorCode: "local_bridge_upstream_error",
				durationMs: Date.now() - startedAt,
			}).catch(() => undefined);
			return new Response(
				JSON.stringify({
					error: {
						message: "Local bridge failed to reach the configured backend.",
						code: "local_bridge_upstream_error",
					},
				}),
				{
					status: 502,
					headers: { "content-type": "application/json; charset=utf-8" },
				},
			);
		}
		await appendUsageLedgerRow({
			source: "local-bridge",
			operation,
			outcome: upstream.ok ? "success" : "failure",
			statusCode: upstream.status,
			durationMs: Date.now() - startedAt,
		}).catch(() => undefined);
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeadersForClient(upstream.headers),
		});
	};

	if (miniMaxEndpoints && miniMaxApiKey) {
		app.get("/v1/models", async (context) => {
			const startedAt = Date.now();
			const unauthorized = await authorize(context.req.raw, startedAt);
			if (unauthorized) return unauthorized;
			await appendUsageLedgerRow({
				source: "local-bridge",
				operation: "models",
				outcome: "success",
				statusCode: 200,
				durationMs: Date.now() - startedAt,
			}).catch(() => undefined);
			return context.json(createMiniMaxModelsResponse());
		});
		app.post("/v1/responses", (context) =>
			forward(
				context.req.raw,
				`${miniMaxEndpoints.responsesBaseUrl}/responses`,
				"responses",
				miniMaxApiKey,
			),
		);
		app.post("/anthropic/v1/messages", (context) =>
			forward(
				context.req.raw,
				`${miniMaxEndpoints.messagesBaseUrl}/v1/messages`,
				"messages",
				miniMaxApiKey,
			),
		);
		app.post("/anthropic/v1/messages/count_tokens", (context) =>
			forward(
				context.req.raw,
				`${miniMaxEndpoints.messagesBaseUrl}/v1/messages/count_tokens`,
				"messages",
				miniMaxApiKey,
			),
		);
	} else if (runtimeBaseUrl) {
		app.get("/v1/models", (context) =>
			forward(
				context.req.raw,
				`${runtimeBaseUrl}/v1/models`,
				"models",
				runtimeClientApiKey,
			),
		);
		app.post("/v1/responses", (context) =>
			forward(
				context.req.raw,
				`${runtimeBaseUrl}/v1/responses`,
				"responses",
				runtimeClientApiKey,
			),
		);
	}
	const notFoundMessage = miniMax
		? "Local bridge only accepts /health, /v1/models, /v1/responses, and MiniMax Messages API paths."
		: "Local bridge only accepts /health, /v1/models, and /v1/responses.";
	app.all("*", (context) =>
		context.json(
			{
				error: {
					message: notFoundMessage,
					code: "local_bridge_not_found",
				},
			},
			404,
		),
	);

	const server = createServer((req, res) => {
		void (async () => {
			try {
				const webRequest = await toWebRequest(req, urlHost, resolvedPort);
				writeWebResponse(res, await app.fetch(webRequest));
			} catch (error) {
				if (!res.headersSent) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(
						`${JSON.stringify({
							error: {
								message: "Local bridge failed before forwarding the request.",
								code: "local_bridge_error",
							},
						})}\n`,
					);
				} else if (!res.destroyed) {
					res.destroy(error instanceof Error ? error : undefined);
				}
			}
		})();
	});
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	let resolvedPort = port;
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			const address = server.address();
			resolvedPort =
				typeof address === "object" && address ? address.port : port;
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, bindHost);
	});

	return {
		host: bindHost,
		port: resolvedPort,
		baseUrl: `http://${urlHost}:${resolvedPort}`,
		close: async () => {
			await closeServer(server, sockets);
		},
	};
}
