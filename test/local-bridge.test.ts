import { afterEach, describe, expect, it, vi } from "vitest";
import {
	startLocalBridge,
	type LocalBridgeServer,
} from "../lib/local-bridge.js";

const openServers: LocalBridgeServer[] = [];

function createFetch(): { calls: Array<{ url: string; init?: RequestInit }>; fetchImpl: typeof fetch } {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		if (String(input).endsWith("/v1/models")) {
			return new Response('{"data":[]}\n', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("data: ok\n\n", {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"content-encoding": "br",
			},
		});
	};
	return { calls, fetchImpl };
}

afterEach(async () => {
	for (const server of openServers.splice(0, openServers.length)) {
		await server.close();
	}
	vi.restoreAllMocks();
});

describe("local bridge", () => {
	it("rejects non-loopback hosts", async () => {
		await expect(
			startLocalBridge({
				host: "0.0.0.0",
				runtimeBaseUrl: "http://127.0.0.1:1234",
			}),
		).rejects.toThrow("loopback");
	});

	it.each(["::1", "[::1]"])(
		"binds and emits a parseable baseUrl for IPv6 loopback host %s",
		async (hostInput) => {
			// Regression: server.listen needs the raw "::1" (bracketed "[::1]" fails
			// the bind), while baseUrl needs the bracketed form ("http://::1:port" is
			// invalid). Both input shapes must start successfully and yield a baseUrl
			// that round-trips through new URL().
			const { fetchImpl } = createFetch();
			const server = await startLocalBridge({
				host: hostInput,
				runtimeBaseUrl: "http://127.0.0.1:9999/",
				fetchImpl,
				requireAuth: false,
			});
			openServers.push(server);
			expect(server.port).toBeGreaterThan(0);
			// baseUrl must parse and carry the bracketed IPv6 authority.
			const parsed = new URL(server.baseUrl);
			expect(parsed.hostname).toBe("[::1]");
			expect(parsed.port).toBe(String(server.port));
			// The returned host is the raw (unbracketed) literal used for the bind.
			expect(server.host).toBe("::1");
		},
	);

	it("accepts an IPv6-loopback runtimeBaseUrl ([::1])", async () => {
		// Regression: new URL("http://[::1]:port").hostname yields the bracketed
		// "[::1]", which the egress guard must treat as loopback. It previously only
		// matched "::1" and threw "non-loopback runtimeBaseUrl host" at startup for a
		// valid IPv6 runtime proxy URL. Assert startup succeeds (the bug was a
		// pre-bind rejection); no request is sent.
		const { fetchImpl } = createFetch();
		const server = await startLocalBridge({
			host: "127.0.0.1",
			runtimeBaseUrl: "http://[::1]:9999/",
			fetchImpl,
			requireAuth: false,
		});
		openServers.push(server);
		expect(server.port).toBeGreaterThan(0);
	});

	it("serves health and forwards allowed OpenAI-compatible paths", async () => {
		const { calls, fetchImpl } = createFetch();
		const server = await startLocalBridge({
			runtimeBaseUrl: "http://127.0.0.1:9999/",
			fetchImpl,
			requireAuth: false,
		});
		openServers.push(server);

		const health = await fetch(`${server.baseUrl}/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			ok: true,
			service: "codex-multi-auth-local-bridge",
		});

		const models = await fetch(`${server.baseUrl}/v1/models`);
		expect(models.status).toBe(200);
		expect(await models.text()).toBe('{"data":[]}\n');

		const responses = await fetch(`${server.baseUrl}/v1/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer local",
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello" }),
		});
		expect(responses.status).toBe(200);
		expect(await responses.text()).toBe("data: ok\n\n");
		expect(responses.headers.get("content-encoding")).toBeNull();

		expect(calls.map((call) => call.url)).toEqual([
			"http://127.0.0.1:9999/v1/models",
			"http://127.0.0.1:9999/v1/responses",
		]);
		expect(calls[1]?.init?.method).toBe("POST");
	});

	it("rejects unsupported paths", async () => {
		const { fetchImpl } = createFetch();
		const server = await startLocalBridge({
			runtimeBaseUrl: "http://127.0.0.1:9999",
			fetchImpl,
			requireAuth: false,
		});
		openServers.push(server);

		const rejected = await fetch(`${server.baseUrl}/v1/chat/completions`, {
			method: "POST",
		});
		expect(rejected.status).toBe(404);
		expect(await rejected.text()).toContain("local_bridge_not_found");
	});

	it("requires bearer tokens by default for forwarded paths", async () => {
		const { calls, fetchImpl } = createFetch();
		const verifyBearerToken = vi.fn().mockResolvedValue(null);
		const server = await startLocalBridge({
			runtimeBaseUrl: "http://127.0.0.1:9999",
			fetchImpl,
			verifyBearerToken,
		});
		openServers.push(server);

		const rejected = await fetch(`${server.baseUrl}/v1/models`);
		expect(rejected.status).toBe(401);
		expect(await rejected.text()).toContain("local_bridge_unauthorized");
		expect(calls).toHaveLength(0);

		verifyBearerToken.mockResolvedValue({
			id: "token-1",
			label: "test",
			prefix: "cma_local_abc",
			tokenHash: "sha256:test",
			createdAt: 1,
			lastUsedAt: null,
			revokedAt: null,
		});
		const accepted = await fetch(`${server.baseUrl}/v1/models`, {
			headers: { authorization: "Bearer cma_local_secret" },
		});
		expect(accepted.status).toBe(200);
		expect(calls).toHaveLength(1);
	});

	// Regression (runtime-proxy-02): the bridge forwards the caller's bearer token to
	// runtimeBaseUrl, so that target must be loopback. A remote runtimeBaseUrl would
	// exfiltrate the local client token off-box; startup must refuse it.
	it("refuses a non-loopback runtimeBaseUrl", async () => {
		const { fetchImpl } = createFetch();
		await expect(
			startLocalBridge({
				host: "127.0.0.1",
				port: 0,
				runtimeBaseUrl: "http://evil.example.com:8080",
				fetchImpl,
				requireAuth: false,
			}),
		).rejects.toThrow(/non-loopback runtimeBaseUrl/i);
	});

	it("rejects an invalid runtimeBaseUrl", async () => {
		const { fetchImpl } = createFetch();
		await expect(
			startLocalBridge({
				host: "127.0.0.1",
				port: 0,
				runtimeBaseUrl: "not a url",
				fetchImpl,
				requireAuth: false,
			}),
		).rejects.toThrow(/not a valid URL/i);
	});

	// runtime-proxy-03: the bridge can authenticate to an auth-enabled runtime proxy
	// by injecting a configured client key, replacing the inbound Authorization —
	// but only when inbound auth is also required (see rejection test below).
	it("forwards the configured runtimeClientApiKey as Authorization", async () => {
		const { calls, fetchImpl } = createFetch();
		const server = await startLocalBridge({
			runtimeBaseUrl: "http://127.0.0.1:9999/",
			fetchImpl,
			requireAuth: true,
			verifyBearerToken: async () => ({
				id: "test-id",
				label: "test",
				prefix: "tst",
				tokenHash: "hash",
				createdAt: 0,
				lastUsedAt: null,
				revokedAt: null,
			}),
			runtimeClientApiKey: "runtime-secret-key",
		});
		openServers.push(server);

		await fetch(`${server.baseUrl}/v1/models`, {
			headers: { authorization: "Bearer inbound-client-token" },
		});

		const forwarded = calls.find((c) => c.url.endsWith("/v1/models"));
		const headers = new Headers(forwarded?.init?.headers as HeadersInit);
		// The runtime key replaced the inbound client's token.
		expect(headers.get("authorization")).toBe("Bearer runtime-secret-key");
	});

	// runtime-proxy-02/03: the x-api-key strip must hold even when auth is enabled and
	// a runtime key is injected. The runtime key lands as Authorization (above), so a
	// regression that only strips on the no-runtime-key path would leak the inbound
	// x-api-key upstream here. Assert it is dropped on the auth-enabled runtime-proxy flow.
	it("strips an inbound x-api-key on the auth-enabled runtime-proxy path", async () => {
		const { calls, fetchImpl } = createFetch();
		const server = await startLocalBridge({
			runtimeBaseUrl: "http://127.0.0.1:9999/",
			fetchImpl,
			requireAuth: true,
			verifyBearerToken: async () => ({
				id: "test-id",
				label: "test",
				prefix: "tst",
				tokenHash: "hash",
				createdAt: 0,
				lastUsedAt: null,
				revokedAt: null,
			}),
			runtimeClientApiKey: "runtime-secret-key",
		});
		openServers.push(server);

		await fetch(`${server.baseUrl}/v1/models`, {
			headers: {
				authorization: "Bearer inbound-client-token",
				"x-api-key": "inbound-secret-key",
				cookie: "session=inbound-cookie-secret",
				"proxy-authorization": "Basic inbound-proxy-cred",
			},
		});

		const forwarded = calls.find((c) => c.url.endsWith("/v1/models"));
		const headers = new Headers(forwarded?.init?.headers as HeadersInit);
		// The runtime key is injected as Authorization, but every inbound credential
		// header is still stripped — none may cross the bridge, runtime key or not.
		expect(headers.get("authorization")).toBe("Bearer runtime-secret-key");
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("cookie")).toBeNull();
		expect(headers.get("proxy-authorization")).toBeNull();
	});

	it("refuses to start with a runtimeClientApiKey when auth is disabled", async () => {
		const { fetchImpl } = createFetch();
		// Security regression: a configured runtime key + requireAuth:false would
		// expose upstream access to any local process. Fail fast instead.
		await expect(
			startLocalBridge({
				runtimeBaseUrl: "http://127.0.0.1:9999/",
				fetchImpl,
				requireAuth: false,
				runtimeClientApiKey: "runtime-secret-key",
			}),
		).rejects.toThrow(/requireAuth=true when runtimeClientApiKey is configured/i);
	});

	it("strips inbound Authorization when no runtime key is configured", async () => {
		const { calls, fetchImpl } = createFetch();
		const server = await startLocalBridge({
			runtimeBaseUrl: "http://127.0.0.1:9999/",
			fetchImpl,
			requireAuth: false,
		});
		openServers.push(server);

		await fetch(`${server.baseUrl}/v1/models`, {
			headers: { authorization: "Bearer inbound-client-token" },
		});

		const forwarded = calls.find((c) => c.url.endsWith("/v1/models"));
		const headers = new Headers(forwarded?.init?.headers as HeadersInit);
		// runtime-proxy-02: don't leak the caller's bridge token upstream.
		expect(headers.get("authorization")).toBeNull();
	});

	it("strips an inbound x-api-key before forwarding upstream", async () => {
		const { calls, fetchImpl } = createFetch();
		const server = await startLocalBridge({
			runtimeBaseUrl: "http://127.0.0.1:9999/",
			fetchImpl,
			requireAuth: false,
		});
		openServers.push(server);

		await fetch(`${server.baseUrl}/v1/models`, {
			headers: {
				authorization: "Bearer inbound-client-token",
				"x-api-key": "inbound-secret-key",
				cookie: "session=inbound-cookie-secret",
				"proxy-authorization": "Basic inbound-proxy-cred",
			},
		});

		const forwarded = calls.find((c) => c.url.endsWith("/v1/models"));
		const headers = new Headers(forwarded?.init?.headers as HeadersInit);
		// runtime-proxy-02: no inbound credential header crosses the bridge.
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("cookie")).toBeNull();
		expect(headers.get("proxy-authorization")).toBeNull();
	});
});
