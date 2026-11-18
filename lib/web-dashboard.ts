import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { renderDashboardHtml } from "./web-dashboard-html.js";
import { localized, resolveOutputLocale, type OutputLocale } from "./locale.js";

export interface WebStatusSnapshot {
	[key: string]: unknown;
}

export interface WebServerOptions {
	host?: string;
	port?: number;
	token?: string | null;
	refreshMs?: number;
	getStatus: () => Promise<WebStatusSnapshot>;
	openBrowser?: (url: string) => void;
	locale?: OutputLocale;
	/** Called when an SSE client is dropped for falling behind on broadcasts. */
	onSseClientDrop?: (client: ServerResponse) => void;
}

export interface WebServerHandle {
	server: Server;
	url: string;
	token: string | null;
	close: () => Promise<void>;
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function parsePort(value: string | undefined): number {
	const port = value === undefined ? 4317 : Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("Web port must be an integer between 0 and 65535.");
	}
	return port;
}

function unauthorized(response: ServerResponse): void {
	response.writeHead(401, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"www-authenticate": "Bearer",
	});
	response.end(JSON.stringify({ error: "Unauthorized" }));
}

function authorized(request: IncomingMessage, token: string | null, url: URL): boolean {
	if (!token) return true;
	const header = request.headers.authorization;
	const bearer = typeof header === "string" && header.startsWith("Bearer ")
		? header.slice("Bearer ".length).trim()
		: "";
	return bearer === token || url.searchParams.get("token") === token;
}

/**
 * Reject requests addressed to a foreign Host. A loopback listener without a
 * token is otherwise reachable via DNS rebinding: a hostile page resolving its
 * own domain to 127.0.0.1 would read the pool status as same-origin. Token-gated
 * binds skip the check — the bearer token is already the guard there.
 */
function requestHostAllowed(request: IncomingMessage, host: string, token: string | null): boolean {
	if (token) return true;
	const bound = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (!isLoopbackHost(bound)) return true;
	const hostHeader = request.headers.host;
	if (typeof hostHeader !== "string" || !hostHeader.trim()) return true;
	let hostname = hostHeader.trim();
	const bracketed = hostname.match(/^\[(.*)\](?::\d+)?$/);
	hostname = (bracketed ? bracketed[1] ?? "" : hostname.replace(/:\d+$/, "")).toLowerCase();
	return isLoopbackHost(hostname);
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

function openBrowserDefault(url: string): void {
	const command = process.platform === "darwin"
		? { file: "open", args: [url] }
		: process.platform === "win32"
			? { file: "cmd", args: ["/c", "start", "", url] }
			: { file: "xdg-open", args: [url] };
	try {
		const child = spawn(command.file, command.args, {
			detached: true,
			stdio: "ignore",
		});
		// A missing opener (e.g. no xdg-open on a headless box) fails
		// asynchronously: without a listener the process-level default would
		// tear down the already-running dashboard.
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// The server remains usable when no graphical opener is installed.
	}
}

function parseArgs(args: string[]): { host: string; port: number; token: string | null; refreshMs: number; noOpen: boolean } {
	let host = "127.0.0.1";
	let port = 4317;
	let token = (process.env.CODEX_MULTI_AUTH_WEB_TOKEN ?? "").trim() || null;
	let refreshMs = 5000;
	let noOpen = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		const next = () => {
			const value = args[i + 1];
			i += 1;
			return value;
		};
		if (arg === "--host") host = (next() ?? "").trim();
		else if (arg.startsWith("--host=")) host = arg.slice("--host=".length).trim();
		else if (arg === "--port") port = parsePort(next());
		else if (arg.startsWith("--port=")) port = parsePort(arg.slice("--port=".length));
		else if (arg === "--token") token = (next() ?? "").trim() || null;
		else if (arg.startsWith("--token=")) token = arg.slice("--token=".length).trim() || null;
		else if (arg === "--interval") refreshMs = Math.max(1000, Number(next() ?? 5000));
		else if (arg.startsWith("--interval=")) refreshMs = Math.max(1000, Number(arg.slice("--interval=".length)));
		else if (arg === "--no-open") noOpen = true;
		else if (arg === "--help" || arg === "-h") {
			throw new Error("Usage: codex-multi-auth web [--host 127.0.0.1] [--port 4317] [--token <token>] [--interval <ms>] [--no-open]");
		} else {
			throw new Error("Unknown web option: " + arg);
		}
	}
	if (!host) throw new Error("Web host cannot be empty.");
	if (!Number.isFinite(refreshMs) || refreshMs < 1000) throw new Error("Web refresh interval must be at least 1000 ms.");
	if (!isLoopbackHost(host) && !token) {
		throw new Error("Binding the web dashboard beyond loopback requires --token or CODEX_MULTI_AUTH_WEB_TOKEN.");
	}
	return { host, port, token, refreshMs: Math.round(refreshMs), noOpen };
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const host = options.host?.trim() || "127.0.0.1";
	const port = options.port ?? 4317;
	const refreshMs = Math.max(1000, options.refreshMs ?? 5000);
	const token = options.token?.trim() || null;
	if (!isLoopbackHost(host) && !token) {
		throw new Error("Binding the web dashboard beyond loopback requires a token.");
	}
	let latest: WebStatusSnapshot | null = null;
	let refreshPromise: Promise<WebStatusSnapshot> | null = null;
	const clients = new Set<ServerResponse>();
	const refresh = async (): Promise<WebStatusSnapshot> => {
		if (!refreshPromise) {
			refreshPromise = options.getStatus().finally(() => {
				refreshPromise = null;
			});
		}
		latest = await refreshPromise;
		return latest;
	};
	const broadcast = (snapshot: WebStatusSnapshot) => {
		const message = "data: " + JSON.stringify(snapshot) + "\n\n";
		for (const client of clients) {
			try {
				if (client.write(message)) continue;
				// A client that stopped reading would otherwise accumulate one full
				// snapshot per refresh forever. end() would stall behind its own
				// unsent queue, so hard-close the connection instead.
				clients.delete(client);
				client.destroy();
				client.socket?.destroy();
				options.onSseClientDrop?.(client);
			} catch { clients.delete(client); }
		}
	};
	// The request handler intentionally awaits the status read before answering;
	// this keeps one response atomic while the server continues accepting SSE
	// connections. Node's callback type is void-returning, so mark the promise
	// boundary explicitly for the linter.
	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	const server = createServer(async (request, response) => {
		try {
			if (!requestHostAllowed(request, host, token)) {
				sendJson(response, { error: "Host header not allowed" }, 403);
				return;
			}
			let requestUrl: URL;
			try {
				requestUrl = new URL(request.url ?? "/", "http://" + (request.headers.host ?? host));
			} catch {
				sendJson(response, { error: "Malformed request" }, 400);
				return;
			}
			if (!authorized(request, token, requestUrl)) {
				unauthorized(response);
				return;
			}
			if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
				response.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
				});
				response.end(renderDashboardHtml(token, options.locale));
				return;
			}
			if (requestUrl.pathname === "/api/health") {
				sendJson(response, { ok: true, service: "codex-multi-auth-web" });
				return;
			}
			if (requestUrl.pathname === "/api/status") {
				try { sendJson(response, await refresh()); }
				catch (error) { sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 503); }
				return;
			}
			if (requestUrl.pathname === "/events") {
				// Cleanup must register before the awaited refresh: a disconnect
				// during that read would otherwise leave the response registered
				// until server shutdown.
				response.on("close", () => clients.delete(response));
				response.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-store",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				});
				response.write("retry: " + refreshMs + "\n\n");
				clients.add(response);
				try { response.write("data: " + JSON.stringify(await refresh()) + "\n\n"); } catch { response.end(); }
				return;
			}
			sendJson(response, { error: "Not found" }, 404);
		} catch {
			try { sendJson(response, { error: "Internal error" }, 500); }
			catch { response.destroy(); }
		}
	});
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
		const onListening = () => { server.off("error", onError); resolve(); };
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	const hostForUrl = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
	const baseUrl = "http://" + hostForUrl + ":" + actualPort + "/";
	const url = token ? baseUrl + "?token=" + encodeURIComponent(token) : baseUrl;
	const interval = setInterval(() => { void refresh().then(broadcast).catch(() => undefined); }, refreshMs);
	interval.unref();
	return {
		server,
		url,
		token,
		close: async () => {
			clearInterval(interval);
			for (const client of clients) client.end();
			clients.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export async function runWebCommand(
	args: string[],
	deps: { getStatus: () => Promise<WebStatusSnapshot>; logInfo?: (message: string) => void; openBrowser?: (url: string) => void; locale?: OutputLocale } ,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		(deps.logInfo ?? ((message: string) => process.stdout.write(message + "\n")))("Usage: codex-multi-auth web [--host 127.0.0.1] [--port 4317] [--token <token>] [--interval <ms>] [--no-open]");
		return 0;
	}
	let parsed;
	try { parsed = parseArgs(args); }
	catch (error) {
		(deps.logInfo ?? ((message: string) => process.stderr.write(message + "\n")))(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const logInfo = deps.logInfo ?? ((message: string) => process.stdout.write(message + "\n"));
	const locale = deps.locale ?? resolveOutputLocale();
	let handle: WebServerHandle;
	try {
		handle = await startWebServer({
			...parsed,
			getStatus: deps.getStatus,
			openBrowser: deps.openBrowser,
			locale,
		});
	} catch (error) {
		(deps.logInfo ?? ((message: string) => process.stderr.write(message + "\n")))(error instanceof Error ? error.message : String(error));
		return 1;
	}
	logInfo("Codex Multi-Auth web dashboard: " + handle.url);
	logInfo(localized(locale, `Live refresh every ${parsed.refreshMs} ms; press Ctrl-C to stop.`, `实时刷新间隔：${parsed.refreshMs} ms；按 Ctrl-C 停止。`));
	if (!parsed.noOpen) (deps.openBrowser ?? openBrowserDefault)(handle.url);
	return await new Promise<number>((resolve) => {
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
			void handle.close().finally(() => resolve(0));
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

export function parseWebCommandArgs(args: string[]): { host: string; port: number; token: string | null; refreshMs: number; openBrowser: boolean } {
	const parsed = parseArgs(args);
	return { ...parsed, openBrowser: !parsed.noOpen };
}
