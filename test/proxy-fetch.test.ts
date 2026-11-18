import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithProxy, setProxyFetchImpl } from "../lib/request/proxy-fetch.js";
import { closeSharedProxyDispatchers } from "../lib/request/url-rewriting.js";

afterEach(async () => {
	setProxyFetchImpl(null);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await closeSharedProxyDispatchers();
});

function configureProxy(proxyUrl: string): void {
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
		vi.stubEnv(key, proxyUrl);
	}
	vi.stubEnv("NO_PROXY", "");
	vi.stubEnv("no_proxy", "");
}

describe("proxy-aware fetch", () => {
	it("uses a real HTTP proxy with the package's compatible Undici fetch", async () => {
		let proxiedUrl: string | undefined;
		const proxy = createServer((request, response) => {
			proxiedUrl = request.url;
			response.end("ok");
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("Missing proxy address");
		configureProxy(`http://127.0.0.1:${address.port}`);
		try {
			const response = await fetchWithProxy("http://upstream.invalid/probe");
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("ok");
			expect(proxiedUrl).toBe("http://upstream.invalid/probe");
		} finally {
			await closeSharedProxyDispatchers();
			await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("never routes loopback traffic through a configured proxy", async () => {
		// Point the proxy at a dead port: if the loopback bypass regressed, the
		// dispatcher would fail instead of serving the direct response.
		configureProxy("http://127.0.0.1:1");
		const upstream = createServer((request, response) => {
			response.end("direct");
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("Missing upstream address");
		try {
			const response = await fetchWithProxy(`http://127.0.0.1:${address.port}/probe`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("direct");
		} finally {
			await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("honors NO_PROXY and preserves a replaced global fetch", async () => {
		configureProxy("http://proxy.example:8080");
		vi.stubEnv("NO_PROXY", "upstream.example");
		vi.stubEnv("no_proxy", "upstream.example");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await fetchWithProxy("https://upstream.example/probe", { method: "GET" });
		expect(fetchMock).toHaveBeenCalledWith("https://upstream.example/probe", { method: "GET" });
	});

	it("prefers an explicit setProxyFetchImpl override over the global fetch", async () => {
		configureProxy("http://proxy.example:8080");
		const embedded = vi.fn<typeof fetch>().mockResolvedValue(new Response("embedded"));
		const ambient = vi.fn<typeof fetch>().mockResolvedValue(new Response("ambient"));
		vi.stubGlobal("fetch", ambient);
		setProxyFetchImpl(embedded);
		const response = await fetchWithProxy("https://upstream.invalid/probe");
		expect(await response.text()).toBe("embedded");
		expect(embedded).toHaveBeenCalledOnce();
		expect(ambient).not.toHaveBeenCalled();
		setProxyFetchImpl(null);
		const second = await fetchWithProxy("https://upstream.invalid/probe");
		expect(await second.text()).toBe("ambient");
	});

	it("preserves a caller-supplied init.dispatcher instead of installing a proxy agent", async () => {
		configureProxy("http://proxy.example:8080");
		const capture = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
		setProxyFetchImpl(capture);
		const callerDispatcher = { marker: "caller-dispatcher" };
		await fetchWithProxy("https://upstream.invalid/probe", {
			dispatcher: callerDispatcher,
		} as RequestInit);
		expect(capture).toHaveBeenCalledOnce();
		const init = capture.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
		expect(init?.dispatcher).toBe(callerDispatcher);
	});

	it("surfaces a proxy connect failure instead of swallowing it", async () => {
		// Port 1 is reserved: connecting fails immediately, so a broken proxy
		// must reject the request rather than hang or silently go direct.
		configureProxy("http://127.0.0.1:1");
		await expect(
			fetchWithProxy("http://upstream.invalid/probe"),
		).rejects.toThrow();
	});

	it("honors a non-platform fetch installed on globalThis before requests run", async () => {
		configureProxy("http://proxy.example:8080");
		// A host runtime may install its own fetch (Electron, bundler shim). The
		// function is not Vitest-marked and not named "fetch", but it must still
		// win over the package Undici transport even when a dispatcher exists.
		const hostFetch = async () => new Response("host");
		Object.defineProperty(hostFetch, "name", { value: "hostRuntimeFetch" });
		vi.stubGlobal("fetch", hostFetch as typeof fetch);
		const response = await fetchWithProxy("https://upstream.invalid/probe");
		expect(await response.text()).toBe("host");
	});
});
