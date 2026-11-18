import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { renderDashboardHtml } from "../lib/web-dashboard-html.js";
import { startWebServer } from "../lib/web-dashboard.js";

const handles: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	while (handles.length) await handles.pop()!.close();
});

function rawRequest(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const req = httpRequest(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname + target.search,
				method: "GET",
				headers,
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => { body += chunk; });
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("web dashboard server", () => {
	it("serves the live dashboard and JSON status on loopback", async () => {
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			refreshMs: 1000,
			getStatus: async () => ({ accountCount: 2, accounts: [] }),
		});
		handles.push(handle);
		const html = await (await fetch(handle.url)).text();
		const status = await (await fetch(new URL("api/status", handle.url))).json();
		expect(html).toContain("Codex Multi-Auth");
		expect(html).toContain("号池实时监控");
		expect(status).toMatchObject({ accountCount: 2 });
	});

	it("requires a token when bound beyond loopback", async () => {
		await expect(startWebServer({
			host: "0.0.0.0",
			port: 0,
			getStatus: async () => ({}),
		})).rejects.toThrow("requires a token");
	});

	it("protects API and dashboard routes with a token", async () => {
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			token: "fixture-token",
			getStatus: async () => ({ ok: true }),
		});
		handles.push(handle);
		const baseUrl = handle.url.split("?")[0]!;
		const unauthorized = await fetch(baseUrl);
		const apiUnauthorized = await fetch(new URL("/api/status", baseUrl));
		const eventsUnauthorized = await fetch(new URL("/events", baseUrl));
		const authorized = await fetch(`${baseUrl}?token=fixture-token`);
		const bearer = await fetch(new URL("/api/status", baseUrl), {
			headers: { authorization: "Bearer fixture-token" },
		});
		expect(unauthorized.status).toBe(401);
		expect(apiUnauthorized.status).toBe(401);
		expect(eventsUnauthorized.status).toBe(401);
		expect(authorized.status).toBe(200);
		expect(bearer.status).toBe(200);
	});

	it("rejects a malformed Host header with a 4xx instead of crashing", async () => {
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			getStatus: async () => ({ ok: true }),
		});
		handles.push(handle);
		// On a loopback bind the Host check rejects a non-loopback name before
		// the URL ever gets parsed; either way the response must be a clean 4xx.
		const response = await rawRequest(handle.url, { host: "%%bad host" });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		// The server keeps serving after the malformed request.
		const healthy = await fetch(new URL("api/health", handle.url));
		expect(healthy.status).toBe(200);
	});

	it("answers a malformed Host with 400 on a token-protected bind", async () => {
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			token: "fixture-token",
			getStatus: async () => ({ ok: true }),
		});
		handles.push(handle);
		const base = handle.url.split("?")[0]!;
		// The token path skips the loopback Host check, so the URL parser itself
		// must still turn a malformed Host into a clean 400 rather than a crash.
		const response = await rawRequest(base + "?token=fixture-token", { host: "%%bad host" });
		expect(response.status).toBe(400);
		const healthy = await fetch(base + "api/health?token=fixture-token");
		expect(healthy.status).toBe(200);
	});

	it("rejects a foreign Host on an untokened loopback bind (DNS rebinding)", async () => {
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			getStatus: async () => ({ ok: true }),
		});
		handles.push(handle);
		const foreign = await rawRequest(handle.url, { host: "rebind.attacker.example:4317" });
		expect(foreign.status).toBe(403);
		const loopback = await rawRequest(handle.url, { host: "localhost:4317" });
		expect(loopback.status).toBe(200);
	});

	it("still serves foreign Host headers when the bind is token-protected", async () => {
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			token: "fixture-token",
			getStatus: async () => ({ ok: true }),
		});
		handles.push(handle);
		const base = handle.url.split("?")[0]!;
		const response = await rawRequest(base + "?token=fixture-token", { host: "anything.example" });
		expect(response.status).toBe(200);
	});

	it("keeps serving after an SSE client disconnects mid-refresh", async () => {
		let resolveStatus: ((value: { ok: boolean }) => void) | undefined;
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			refreshMs: 60_000,
			getStatus: () => new Promise((resolve) => { resolveStatus = resolve; }),
		});
		handles.push(handle);
		const base = handle.url.split("?")[0]!;
		const target = new URL(base);
		const socket = netConnect({ host: target.hostname, port: Number(target.port) });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		socket.write(`GET /events HTTP/1.1\r\nHost: ${target.host}\r\nConnection: keep-alive\r\n\r\n`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// Disconnect while the initial status snapshot is still pending: the
		// client must be dropped when its socket closes, not at shutdown.
		socket.destroy();
		resolveStatus?.({ ok: true });
		const status = await rawRequest(base + "api/health", { host: target.host });
		expect(status.status).toBe(200);
	});

	it("drops an SSE client that never reads once its buffer backs up", async () => {
		// The snapshot must comfortably exceed loopback kernel buffers (which can
		// absorb MBs) so the broadcast write() sees real backpressure.
		const fat = "x".repeat(2 * 1024 * 1024);
		let dropped = false;
		const handle = await startWebServer({
			host: "127.0.0.1",
			port: 0,
			refreshMs: 1000,
			getStatus: async () => ({ blob: fat }),
			onSseClientDrop: () => { dropped = true; },
		});
		handles.push(handle);
		const base = handle.url.split("?")[0]!;
		const target = new URL(base);
		const socket = netConnect({ host: target.hostname, port: Number(target.port) });
		socket.on("error", () => undefined);
		socket.write(`GET /events HTTP/1.1\r\nHost: ${target.host}\r\nConnection: keep-alive\r\n\r\n`);
		// Never read: once the client's buffers back up the broadcast write fails
		// and the server must drop the connection rather than queue unbounded.
		// (The client never observes a 'close': pending unread data masks the RST
		// — the drop is asserted from the server side.)
		const deadline = Date.now() + 10_000;
		while (!dropped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		socket.destroy();
		expect(dropped).toBe(true);
	}, 15_000);
});

describe("dashboard html", () => {
	it("renders API/ZDR account wiring and honors a server locale", () => {
		const html = renderDashboardHtml(null, "en");
		expect(html).toContain('var lang="en"');
		expect(html).toContain("apiAccounts");
		expect(html).toContain("windowMinutes");
		expect(html).not.toContain("__CMA_LANG__");
	});
});
