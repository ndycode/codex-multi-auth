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
});
