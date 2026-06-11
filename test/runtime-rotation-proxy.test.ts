import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { AccountManager } from "../lib/accounts.js";
import { CodexValidationError } from "../lib/errors.js";
import { HTTP_STATUS, OPENAI_HEADERS } from "../lib/constants.js";
import {
	startRuntimeRotationProxy,
	buildTokenInvalidationBody,
	chooseAccount,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { SessionAffinityStore } from "../lib/session-affinity.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import {
	__resetRoutingMutexForTests,
	isRoutingMutexHeld,
	withRoutingMutex,
} from "../lib/routing-mutex.js";
import * as runtimePolicy from "../lib/policy/runtime-policy.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import { resetTrackers } from "../lib/rotation.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const {
	refreshAccessTokenMock,
	saveAccountsMock,
	withAccountStorageTransactionMock,
} = vi.hoisted(
	() => ({
		refreshAccessTokenMock: vi.fn(),
		saveAccountsMock: vi.fn(),
		withAccountStorageTransactionMock: vi.fn(),
	}),
);

vi.mock("../lib/auth/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/auth.js")>();
	return {
		...actual,
		refreshAccessToken: refreshAccessTokenMock,
	};
});

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

interface FetchCall {
	url: string;
	headers: Headers;
	bodyText: string;
}

const openServers: RuntimeRotationProxyServer[] = [];
const openManagers: AccountManager[] = [];
const DEFAULT_CLIENT_API_KEY = "runtime-secret";

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

function bodyTextFromInit(init: RequestInit | undefined): string {
	const body = init?.body;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
	return "";
}

function createRecordingFetch(
	handler: (call: FetchCall, attempt: number) => Response | Promise<Response>,
): { calls: FetchCall[]; fetchImpl: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const call = {
			url: String(input),
			headers: new Headers(init?.headers),
			bodyText: bodyTextFromInit(init),
		};
		calls.push(call);
		return handler(call, calls.length);
	};
	return { calls, fetchImpl };
}

function timeoutResult(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		setTimeout(() => resolve("timeout"), ms);
	});
}

async function startProxy(params: {
	accountManager: AccountManager;
	fetchImpl: typeof fetch;
	options?: Partial<Parameters<typeof startRuntimeRotationProxy>[0]>;
}): Promise<RuntimeRotationProxyServer> {
	openManagers.push(params.accountManager);
	const proxy = await startRuntimeRotationProxy({
		accountManager: params.accountManager,
		fetchImpl: params.fetchImpl,
		upstreamBaseUrl: "https://example.test/backend-api",
		clientApiKey: DEFAULT_CLIENT_API_KEY,
		quotaRemainingPercentThreshold: 10,
		...params.options,
	});
	openServers.push(proxy);
	return proxy;
}

async function postResponses(
	proxy: RuntimeRotationProxyServer,
	body: Record<string, unknown>,
	path = "/responses",
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${proxy.baseUrl}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}`,
			"content-type": "application/json",
			"x-api-key": "caller-key",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

async function getModels(
	proxy: RuntimeRotationProxyServer,
	path = "/models?client_version=0.125.0",
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${proxy.baseUrl}${path}`, {
		method: "GET",
		headers: {
			authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}`,
			"x-api-key": "caller-key",
			...headers,
		},
	});
}

async function postThreadGoal(
	proxy: RuntimeRotationProxyServer,
	body: Record<string, unknown>,
	path = "/thread/goal/get",
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${proxy.baseUrl}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}`,
			"content-type": "application/json",
			"x-api-key": "caller-key",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

async function getThreadGoal(
	proxy: RuntimeRotationProxyServer,
	path = "/thread/goal/get",
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${proxy.baseUrl}${path}`, {
		method: "GET",
		headers: {
			authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}`,
			"x-api-key": "caller-key",
			...headers,
		},
	});
}

async function postRawResponses(
	proxy: RuntimeRotationProxyServer,
	body: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${proxy.baseUrl}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}`,
			"content-type": "application/json",
			...headers,
		},
		body,
	});
}

async function postResponsesWithHttp(
	proxy: RuntimeRotationProxyServer,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
	const url = new URL(`${proxy.baseUrl}/responses`);
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: url.hostname,
				port: Number(url.port),
				path: url.pathname,
				method: "POST",
				headers: {
					authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}`,
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload).toString(),
					...headers,
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) =>
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
				);
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						text: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

interface ActiveHandleProcess {
	_getActiveHandles?: () => unknown[];
}

interface ActiveServerHandle {
	address?: () => unknown;
	emit?: (event: "error", error: Error) => boolean;
}

function emitServerErrorForProxy(
	proxy: RuntimeRotationProxyServer,
	error: Error,
): void {
	const handles =
		(process as unknown as ActiveHandleProcess)._getActiveHandles?.() ?? [];
	for (const handle of handles) {
		const candidate = handle as ActiveServerHandle;
		if (
			typeof candidate.address !== "function" ||
			typeof candidate.emit !== "function"
		) {
			continue;
		}
		const address = candidate.address();
		const port =
			typeof address === "object" && address !== null && "port" in address
				? (address as { port?: unknown }).port
				: null;
		if (port === proxy.port) {
			candidate.emit("error", error);
			return;
		}
	}
	throw new Error(`runtime proxy server on port ${proxy.port} was not found`);
}

function textEventStream(body = "data: {}\n\n", headers?: HeadersInit): Response {
	return new Response(body, {
		status: HTTP_STATUS.OK,
		headers: {
			"content-type": "text/event-stream",
			...headers,
		},
	});
}

beforeEach(() => {
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	__resetRoutingMutexForTests();
	refreshAccessTokenMock.mockReset();
	saveAccountsMock.mockReset();
	saveAccountsMock.mockResolvedValue(undefined);
	withAccountStorageTransactionMock.mockReset();
	withAccountStorageTransactionMock.mockImplementation(async (handler) =>
		handler(null, async () => undefined),
	);
});

afterEach(async () => {
	for (const proxy of openServers.splice(0, openServers.length)) {
		await proxy.close();
	}
	for (const accountManager of openManagers.splice(0, openManagers.length)) {
		await accountManager.flushPendingSave();
	}
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	__resetRoutingMutexForTests();
});

describe("runtime rotation proxy", () => {
	it("requires a client API key at startup", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { fetchImpl } = createRecordingFetch(() => textEventStream());

		await expect(
			startRuntimeRotationProxy({
				accountManager,
				fetchImpl,
				upstreamBaseUrl: "https://example.test/backend-api",
			} as Parameters<typeof startRuntimeRotationProxy>[0]),
		).rejects.toThrow("clientApiKey");
	});

	// §4.3 error-contract adoption: the startup guards throw typed validation
	// errors so callers can branch on the class/field instead of message text.
	it("throws CodexValidationError with the offending field from both startup guards", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { fetchImpl } = createRecordingFetch(() => textEventStream());

		const missingKey = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
		} as Parameters<typeof startRuntimeRotationProxy>[0]).then(
			() => null,
			(error: unknown) => error,
		);
		expect(missingKey).toBeInstanceOf(CodexValidationError);
		expect((missingKey as CodexValidationError).field).toBe("clientApiKey");
		expect((missingKey as CodexValidationError).expected).toBe(
			"a non-empty string",
		);

		const badHost = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			clientApiKey: DEFAULT_CLIENT_API_KEY,
			host: "0.0.0.0",
			upstreamBaseUrl: "https://example.test/backend-api",
		}).then(
			() => null,
			(error: unknown) => error,
		);
		expect(badHost).toBeInstanceOf(CodexValidationError);
		expect((badHost as CodexValidationError).field).toBe("host");
		expect((badHost as CodexValidationError).expected).toBe("a loopback host");
		expect((badHost as CodexValidationError).context).toEqual({
			host: "0.0.0.0",
		});
	});

	// Regression (runtime-proxy-01): the proxy forwards managed OAuth tokens and must
	// stay loopback-only. A non-loopback host must be refused unless explicitly opted in.
	it("refuses to bind a non-loopback host by default", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { fetchImpl } = createRecordingFetch(() => textEventStream());

		await expect(
			startRuntimeRotationProxy({
				accountManager,
				fetchImpl,
				clientApiKey: DEFAULT_CLIENT_API_KEY,
				host: "0.0.0.0",
				upstreamBaseUrl: "https://example.test/backend-api",
			}),
		).rejects.toThrow(/non-loopback/i);
	});

	it("refuses a non-loopback host unconditionally (no opt-out)", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { fetchImpl } = createRecordingFetch(() => textEventStream());

		// The proxy forwards managed OAuth tokens, so binding off-box is refused with
		// no escape hatch — 0.0.0.0 must throw rather than expose accounts.
		await expect(
			startRuntimeRotationProxy({
				accountManager,
				fetchImpl,
				clientApiKey: DEFAULT_CLIENT_API_KEY,
				host: "0.0.0.0",
				upstreamBaseUrl: "https://example.test/backend-api",
			}),
		).rejects.toThrow(/loopback-only/i);
	});

	// Regression (runtime-proxy IPv6 bug): the loopback guard accepted both "::1"
	// and "[::1]", but the bind and the emitted baseUrl conflated the two forms.
	// server.listen needs the RAW literal ("::1") or the bind misbehaves, while the
	// baseUrl needs the BRACKETED literal so "http://[::1]:port" parses. Both input
	// spellings must end up listening (port > 0) AND emit a bracketed baseUrl.
	it.each(["::1", "[::1]"])(
		"normalizes IPv6 loopback host %s for both bind and baseUrl",
		async (hostInput) => {
			const now = Date.now();
			const accountManager = new AccountManager(undefined, createStorage(now));
			const { fetchImpl } = createRecordingFetch(() => textEventStream());

			const proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { host: hostInput },
			});

			// Server actually bound (raw literal accepted by listen()).
			expect(proxy.port).toBeGreaterThan(0);
			// baseUrl always emits the bracketed IPv6 authority, regardless of input form.
			expect(proxy.baseUrl).toContain(`http://[::1]:`);
			expect(proxy.baseUrl).toBe(`http://[::1]:${proxy.port}`);

			await proxy.close();
		},
	);
	it("applies routingMutex=enabled to the account manager at startup", async () => {
		const prev = process.env.CODEX_AUTH_ROUTING_MUTEX;
		process.env.CODEX_AUTH_ROUTING_MUTEX = "enabled";
		try {
			const now = Date.now();
			const accountManager = new AccountManager(undefined, createStorage(now));
			const { fetchImpl } = createRecordingFetch(() => textEventStream());
			const proxy = await startProxy({ accountManager, fetchImpl });
			expect(accountManager.getRoutingMutexMode()).toBe("enabled");
			await proxy.close();
		} finally {
			if (prev === undefined) delete process.env.CODEX_AUTH_ROUTING_MUTEX;
			else process.env.CODEX_AUTH_ROUTING_MUTEX = prev;
		}
	});

	it("leaves routingMutex in legacy mode by default", async () => {
		const prev = process.env.CODEX_AUTH_ROUTING_MUTEX;
		delete process.env.CODEX_AUTH_ROUTING_MUTEX;
		try {
			const now = Date.now();
			const accountManager = new AccountManager(undefined, createStorage(now));
			const { fetchImpl } = createRecordingFetch(() => textEventStream());
			const proxy = await startProxy({ accountManager, fetchImpl });
			expect(accountManager.getRoutingMutexMode()).toBe("legacy");
			await proxy.close();
		} finally {
			if (prev !== undefined) process.env.CODEX_AUTH_ROUTING_MUTEX = prev;
		}
	});

	it("records post-startup server errors without throwing uncaught errors", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { fetchImpl } = createRecordingFetch(() => textEventStream());
		const proxy = await startProxy({ accountManager, fetchImpl });

		expect(() =>
			emitServerErrorForProxy(proxy, new Error("post-startup server boom")),
		).not.toThrow();
		expect(proxy.getStatus().lastError).toBe("post-startup server boom");
	});

	it("fails closed when runtime policy cannot be loaded", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() => textEventStream());
		const policySpy = vi
			.spyOn(runtimePolicy, "loadRuntimePolicyState")
			.mockRejectedValueOnce(new Error("policy store unreadable"));
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, {
			model: "gpt-5.3-codex",
			input: "hello",
		});
		const payload = (await response.json()) as {
			error?: { code?: string; message?: string };
		};

		expect(policySpy).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error?.code).toBe("runtime_policy_unavailable");
		expect(calls).toHaveLength(0);
		expect(proxy.getStatus().lastError).toBe("policy store unreadable");
	});

	it("masks email/token material in getStatus().lastError (errors-logging-08)", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { fetchImpl } = createRecordingFetch(() => textEventStream());
		// Inject a failure whose message embeds a bearer token and an email so a
		// future refactor that drops the masking would leak secrets through the
		// status surface. getStatus() must redact both on read.
		vi.spyOn(runtimePolicy, "loadRuntimePolicyState").mockRejectedValueOnce(
			new Error("refresh failed Bearer sk-supersecrettokenvalue123 for bob@example.com"),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		await postResponses(proxy, { model: "gpt-5.3-codex", input: "hello" });

		const lastError = proxy.getStatus().lastError ?? "";
		// Raw secrets must NOT survive into the status surface.
		expect(lastError).not.toContain("bob@example.com");
		expect(lastError).not.toContain("sk-supersecrettokenvalue123");
		// And the masked markers should be present: email redacted to its prefix +
		// tld, and the bearer token collapsed to head...tail (maskToken).
		expect(lastError).toContain("bo***@***.com");
		expect(lastError).toContain("Bearer...");
		await proxy.close();
	});

	it("closes active streaming clients during shutdown", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const encoder = new TextEncoder();
		const { fetchImpl } = createRecordingFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: still-open\n\n"));
						},
					}),
					{
						status: HTTP_STATUS.OK,
						headers: { "content-type": "text/event-stream" },
					},
				),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { streamStallTimeoutMs: 60_000 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
		});
		expect(response.status).toBe(HTTP_STATUS.OK);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected streaming response body");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("data: still-open\n\n");

		await expect(
			Promise.race([proxy.close().then(() => "closed" as const), timeoutResult(500)]),
		).resolves.toBe("closed");
		await reader.cancel().catch(() => undefined);
	});

	it("rejects unauthenticated local clients when a wrapper token is configured", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n", {
				"x-codex-multi-auth-account-index": "1",
				"x-codex-multi-auth-account-email": "account-1@example.com",
				"x-codex-multi-auth-account-label":
					"Account 1 (account-1@example.com, id:acc_1)",
				"x-codex-multi-auth-account-id": "acc_1",
			}),
		);
		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: "runtime-secret",
		});
		openServers.push(proxy);
		openManagers.push(accountManager);

		const rejected = await postResponses(
			proxy,
			{ model: "gpt-5-codex" },
			"/responses",
			{
				authorization: "Bearer caller-token",
				"x-api-key": "caller-key",
			},
		);

		expect(rejected.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(calls).toHaveLength(0);

		const accepted = await postResponses(
			proxy,
			{ model: "gpt-5-codex" },
			"/responses",
			{ authorization: "Bearer runtime-secret" },
		);

		expect(accepted.status).toBe(HTTP_STATUS.OK);
		expect(await accepted.text()).toBe("data: forwarded\n\n");
		expect(calls).toHaveLength(1);

		const acceptedWithApiKey = await postResponses(
			proxy,
			{ model: "gpt-5-codex" },
			"/responses",
			{
				authorization: "Bearer wrong-token",
				"x-api-key": "runtime-secret",
			},
		);

		expect(acceptedWithApiKey.status).toBe(HTTP_STATUS.OK);
		expect(await acceptedWithApiKey.text()).toBe("data: forwarded\n\n");
		expect(calls).toHaveLength(2);
	});

	// L5 (endpoint enumeration): the auth check must run BEFORE path/method
	// discrimination so an unauthenticated caller cannot distinguish a valid
	// endpoint from an invalid one — both must return 401. Authorized callers
	// must still receive 404 on unsupported paths.
	it("returns 401 (not 404) for unauthenticated requests to unknown paths", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() => new Response('{"ok":true}', { status: HTTP_STATUS.OK }),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		// Unauthenticated caller hitting a bogus path: must NOT be told the path
		// is invalid (404). It must look identical to any other unauthorized
		// request (401), revealing nothing about which endpoints exist.
		const unauthUnknownPath = await fetch(`${proxy.baseUrl}/totally/unknown/path`, {
			method: "GET",
			headers: { authorization: "Bearer caller-token", "x-api-key": "caller-key" },
		});
		expect(unauthUnknownPath.status).toBe(HTTP_STATUS.UNAUTHORIZED);

		// Same for an unauthenticated caller using an unsupported method on a
		// path that would otherwise be valid: still 401, never 404/405.
		const unauthBadMethod = await fetch(`${proxy.baseUrl}/responses`, {
			method: "DELETE",
			headers: { authorization: "Bearer caller-token", "x-api-key": "caller-key" },
		});
		expect(unauthBadMethod.status).toBe(HTTP_STATUS.UNAUTHORIZED);

		// Authorized caller hitting a bogus path: ordering preserved, still 404.
		const authUnknownPath = await fetch(`${proxy.baseUrl}/totally/unknown/path`, {
			method: "GET",
			headers: { authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}` },
		});
		expect(authUnknownPath.status).toBe(404);
		expect(await authUnknownPath.json()).toEqual({
			error: {
				message:
					"Runtime rotation proxy only accepts Responses API, model discovery, and Codex thread goal requests.",
				code: "runtime_rotation_proxy_not_found",
			},
		});

		// No request should have been forwarded upstream for any of the above.
		expect(calls).toHaveLength(0);
	});

	it("forwards Responses requests unchanged while replacing caller auth", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n"),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });
		const requestBody = {
			model: "gpt-5-codex",
			stream: true,
			instructions: "preserve me",
			input: [{ type: "message", role: "user", content: "hello" }],
			tools: [{ type: "function", function: { name: "lookup" } }],
			reasoning: { encrypted_content: "ciphertext" },
			metadata: { session_id: "session-a" },
		};

		const response = await postResponses(proxy, requestBody, "/v1/responses?trace=1");

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: forwarded\n\n");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://example.test/backend-api/codex/responses?trace=1",
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[0]?.headers.get("x-api-key")).toBeNull();
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
		expect(response.headers.get("x-codex-multi-auth-account-index")).toBeNull();
		expect(response.headers.get("x-codex-multi-auth-account-email")).toBeNull();
		expect(response.headers.get("x-codex-multi-auth-account-label")).toBeNull();
		expect(response.headers.get("x-codex-multi-auth-account-id")).toBeNull();
		expect(proxy.getStatus()).toMatchObject({
			lastAccountIndex: 0,
			lastAccountLabel: "Account 1",
			lastAccountId: "acc_1",
		});
		expect(proxy.getStatus()).not.toHaveProperty("lastAccountEmail");
		expect(JSON.parse(calls[0]?.bodyText ?? "{}")).toEqual(requestBody);
	});

	it("forwards model discovery requests through managed account auth", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response('{"data":[]}\n', {
					status: HTTP_STATUS.OK,
					headers: {
						"content-type": "application/json",
						"content-encoding": "br",
						"content-length": "17",
					},
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await getModels(proxy);

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(response.headers.get("content-length")).toBeNull();
		expect(await response.text()).toBe('{"data":[]}\n');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://example.test/backend-api/models?client_version=0.125.0",
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[0]?.headers.get("x-api-key")).toBeNull();
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
		expect(calls[0]?.bodyText).toBe("");
		expect(proxy.getStatus()).toMatchObject({
			totalRequests: 1,
			upstreamRequests: 1,
			lastAccountIndex: 0,
			lastAccountLabel: "Account 1",
			lastAccountId: "acc_1",
		});
	});

	it("forwards TUI thread goal requests through managed account auth", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response('{"goal":"ship it"}\n', {
					status: HTTP_STATUS.OK,
					headers: { "content-type": "application/json" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postThreadGoal(proxy, {
			threadId: "thread-1",
			turnId: "turn-1",
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe('{"goal":"ship it"}\n');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://example.test/backend-api/codex/thread/goal/get",
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[0]?.headers.get("x-api-key")).toBeNull();
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
		expect(JSON.parse(calls[0]?.bodyText ?? "{}")).toEqual({
			threadId: "thread-1",
			turnId: "turn-1",
		});
	});

	it("forwards TUI thread goal set requests without duplicating codex path", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response('{"ok":true}\n', {
					status: HTTP_STATUS.OK,
					headers: { "content-type": "application/json" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postThreadGoal(
			proxy,
			{ threadId: "thread-1", turnId: "turn-1", goal: "ship it" },
			"/codex/thread/goal/set?source=tui",
		);

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://example.test/backend-api/codex/thread/goal/set?source=tui",
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[0]?.headers.get("x-api-key")).toBeNull();
	});

	it("falls back locally when upstream blocks TUI thread goal requests", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response("<html>blocked</html>", {
					status: HTTP_STATUS.FORBIDDEN,
					headers: { "content-type": "text/html" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const setResponse = await postThreadGoal(
			proxy,
			{ threadId: "thread-1", goal: "ship it" },
			"/thread/goal/set",
		);
		const getResponse = await postThreadGoal(
			proxy,
			{ threadId: "thread-1" },
			"/thread/goal/get",
		);

		expect(setResponse.status).toBe(HTTP_STATUS.OK);
		expect(await setResponse.json()).toEqual({ ok: true, goal: "ship it" });
		expect(getResponse.status).toBe(HTTP_STATUS.OK);
		expect(await getResponse.json()).toEqual({ goal: "ship it" });
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.url)).toEqual([
			"https://example.test/backend-api/codex/thread/goal/set",
			"https://example.test/backend-api/codex/thread/goal/get",
		]);
	});

	it("rejects anonymous blocked thread goal fallbacks instead of sharing state", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response("<html>blocked</html>", {
					status: HTTP_STATUS.FORBIDDEN,
					headers: { "content-type": "text/html" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postThreadGoal(proxy, { goal: "ship it" }, "/thread/goal/set");

		expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(await response.json()).toEqual({
			error: {
				message: "Thread goal fallback requires a thread_id, threadId, or session header.",
				code: "thread_goal_session_key_required",
			},
		});
		expect(calls).toHaveLength(1);
	});

	it("keys blocked GET thread goal fallbacks by query thread id", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response("<html>blocked</html>", {
					status: HTTP_STATUS.FORBIDDEN,
					headers: { "content-type": "text/html" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		await postThreadGoal(
			proxy,
			{ threadId: "thread-1", goal: "ship it" },
			"/thread/goal/set",
		);
		const response = await getThreadGoal(proxy, "/thread/goal/get?thread_id=thread-1");

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.json()).toEqual({ goal: "ship it" });
		expect(calls.map((call) => call.url)).toEqual([
			"https://example.test/backend-api/codex/thread/goal/set",
			"https://example.test/backend-api/codex/thread/goal/get?thread_id=thread-1",
		]);
	});

	it("stores null blocked thread goal fallbacks by snake-case body thread id", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response("<html>blocked</html>", {
					status: HTTP_STATUS.FORBIDDEN,
					headers: { "content-type": "text/html" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const setResponse = await postThreadGoal(
			proxy,
			{ thread_id: "thread-snake" },
			"/thread/goal/set",
		);
		const getResponse = await getThreadGoal(
			proxy,
			"/thread/goal/get?threadId=thread-snake",
		);

		expect(setResponse.status).toBe(HTTP_STATUS.OK);
		expect(await setResponse.json()).toEqual({ ok: true, goal: null });
		expect(getResponse.status).toBe(HTTP_STATUS.OK);
		expect(await getResponse.json()).toEqual({ goal: null });
		expect(calls).toHaveLength(2);
	});

	it("prioritizes workspace-disabled 403 handling over thread goal fallback", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { code: "workspace_disabled" } }), {
				status: HTTP_STATUS.FORBIDDEN,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postThreadGoal(
			proxy,
			{ threadId: "thread-disabled", goal: "ship it" },
			"/thread/goal/set",
		);
		const payload = (await response.json()) as { error: { reason: string } };

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error.reason).toBe("deactivated");
		expect(calls).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(false);
	});

	it("passes through non-fallback thread goal client errors", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const recordSuccessSpy = vi.spyOn(accountManager, "recordSuccess");
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response('{"error":{"code":"bad_goal"}}\n', {
					status: HTTP_STATUS.BAD_REQUEST,
					headers: { "content-type": "application/json" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postThreadGoal(
			proxy,
			{ threadId: "thread-1", goal: "" },
			"/thread/goal/set",
		);

		expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(await response.text()).toBe('{"error":{"code":"bad_goal"}}\n');
		expect(calls).toHaveLength(1);
		expect(recordSuccessSpy).not.toHaveBeenCalled();
	});

	it("rejects unauthenticated thread goal requests", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() => new Response('{"ok":true}', { status: HTTP_STATUS.OK }),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postThreadGoal(
			proxy,
			{ threadId: "thread-1" },
			"/thread/goal/get",
			{ authorization: "Bearer caller-token", "x-api-key": "caller-key" },
		);

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(calls).toHaveLength(0);
	});

	it("isolates local thread goal fallback state across concurrent threads", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response("<html>blocked</html>", {
					status: HTTP_STATUS.FORBIDDEN,
					headers: { "content-type": "text/html" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const [setA, setB] = await Promise.all([
			postThreadGoal(proxy, { threadId: "thread-a", goal: "goal-a" }, "/thread/goal/set"),
			postThreadGoal(proxy, { threadId: "thread-b", goal: "goal-b" }, "/thread/goal/set"),
		]);
		const [getA, getB] = await Promise.all([
			postThreadGoal(proxy, { threadId: "thread-a" }, "/thread/goal/get"),
			postThreadGoal(proxy, { threadId: "thread-b" }, "/thread/goal/get"),
		]);

		expect(setA.status).toBe(HTTP_STATUS.OK);
		expect(setB.status).toBe(HTTP_STATUS.OK);
		expect(await getA.json()).toEqual({ goal: "goal-a" });
		expect(await getB.json()).toEqual({ goal: "goal-b" });
		expect(calls).toHaveLength(4);
		expect(
			calls.filter(
				(call) => call.url === "https://example.test/backend-api/codex/thread/goal/set",
			),
		).toHaveLength(2);
		expect(
			calls.filter(
				(call) => call.url === "https://example.test/backend-api/codex/thread/goal/get",
			),
		).toHaveLength(2);
	});

	it("evicts oldest local thread goal fallbacks when capacity is exceeded", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 600));
		const { fetchImpl } = createRecordingFetch(
			() =>
				new Response("<html>blocked</html>", {
					status: HTTP_STATUS.FORBIDDEN,
					headers: { "content-type": "text/html" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		for (let index = 0; index < 513; index += 1) {
			const response = await postThreadGoal(
				proxy,
				{ threadId: `thread-${index}`, goal: `goal-${index}` },
				"/thread/goal/set",
			);
			expect(response.status).toBe(HTTP_STATUS.OK);
		}

		const evicted = await postThreadGoal(
			proxy,
			{ threadId: "thread-0" },
			"/thread/goal/get",
		);
		const retained = await postThreadGoal(
			proxy,
			{ threadId: "thread-512" },
			"/thread/goal/get",
		);

		expect(await evicted.json()).toEqual({ goal: null });
		expect(await retained.json()).toEqual({ goal: "goal-512" });
	});

	it("rejects unauthenticated model discovery requests", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response('{"data":[]}\n', {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await getModels(proxy, "/models", {
			authorization: "Bearer caller-token",
			"x-api-key": "caller-key",
		});

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(calls).toHaveLength(0);
	});

	it("strips decoded upstream content encoding before forwarding to clients", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { fetchImpl } = createRecordingFetch(
			() =>
				new Response('{"ok":true}\n', {
					status: HTTP_STATUS.OK,
					headers: {
						"content-type": "application/json",
						"content-encoding": "gzip",
						"content-length": "41",
					},
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(response.headers.get("content-length")).toBeNull();
		expect(await response.text()).toBe('{"ok":true}\n');
	});

	it("rejects arbitrary local paths that merely end with responses", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n"),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(
			proxy,
			{ model: "gpt-5-codex" },
			"/foo/responses",
		);

		expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
		expect(calls).toHaveLength(0);
	});

	it("rejects oversized request bodies before selecting an account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: unreachable\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { maxRequestBodyBytes: 8 },
		});

		const response = await postRawResponses(proxy, '{"model":"gpt-5-codex"}');
		const payload = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
		expect(payload.error.code).toBe("runtime_rotation_proxy_payload_too_large");
		expect(calls).toHaveLength(0);
	});

	it("persists the actually served account as the realtime active selection", async () => {
		const previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "0";
		const persisted: AccountStorageV3[] = [];
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(null, async (storage: AccountStorageV3) => {
				persisted.push(structuredClone(storage));
			}),
		);
		try {
			const now = Date.now();
			const storage = createStorage(now, 2);
			const firstAccount = storage.accounts[0];
			if (firstAccount) {
				firstAccount.rateLimitResetTimes = { "gpt-5-codex": now + 60_000 };
			}
			const accountManager = new AccountManager(undefined, storage);
			const { calls, fetchImpl } = createRecordingFetch(() =>
				textEventStream("data: served\n\n"),
			);
			const proxy = await startProxy({ accountManager, fetchImpl });

			const response = await postResponses(proxy, {
				model: "gpt-5-codex",
				stream: true,
			});

			expect(response.status).toBe(HTTP_STATUS.OK);
			expect(await response.text()).toBe("data: served\n\n");
			await accountManager.flushPendingSave();
			expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_2");
			expect(persisted.at(-1)).toMatchObject({
				activeIndex: 0,
				activeIndexByFamily: { codex: 0, "gpt-5-codex": 1 },
			});
			expect(persisted.at(-1)?.accounts[1]?.lastSwitchReason).toBe("rotation");
		} finally {
			if (previousSync === undefined) {
				delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
			} else {
				process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
			}
		}
	});

	it("preserves caller headers except credentials and hop-by-hop values", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n"),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		await (
			await postResponses(
				proxy,
				{ model: "gpt-5-codex", stream: false },
				"/responses",
				{
					accept: "application/json",
					connection: "close",
					"x-custom-trace": "trace-1",
					cookie: "session=inbound-cookie-secret",
					"proxy-authorization": "Basic inbound-proxy-cred",
				},
			)
		).text();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("accept")).toBe("application/json");
		expect(calls[0]?.headers.get("x-custom-trace")).toBe("trace-1");
		expect(calls[0]?.headers.get("connection")).toBeNull();
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[0]?.headers.get("x-api-key")).toBeNull();
		// Inbound client credentials must never ride upstream with the managed token.
		expect(calls[0]?.headers.get("cookie")).toBeNull();
		expect(calls[0]?.headers.get("proxy-authorization")).toBeNull();
	});

	it("strips expect before forwarding to fetch", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n"),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponsesWithHttp(
			proxy,
			{ model: "gpt-5-codex", stream: false },
			{ expect: "100-continue" },
		);

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("expect")).toBeNull();
	});

	it("rotates the next request when quota headers leave less than ten percent", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			textEventStream(`data: attempt-${attempt}\n\n`, {
				"x-codex-primary-used-percent": attempt === 1 ? "95" : "10",
				"x-codex-primary-reset-after-seconds": "60",
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		await (await postResponses(proxy, { model: "gpt-5-codex", stream: true })).text();
		await (await postResponses(proxy, { model: "gpt-5-codex", stream: true })).text();

		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
		]);
		expect(proxy.getStatus()).toMatchObject({
			lastAccountIndex: 1,
			lastAccountLabel: "Account 2",
		});
		expect(proxy.getStatus()).not.toHaveProperty("lastAccountEmail");
		expect(
			accountManager.getAccountByIndex(0)?.rateLimitResetTimes["gpt-5-codex"],
		).toBeTypeOf("number");
	});

	it("pins repeated session requests to the first served account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 3));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			textEventStream(`data: session-${attempt}\n\n`),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });
		const body = {
			model: "gpt-5-codex",
			stream: true,
			metadata: { session_id: "thread-a" },
		};

		await (await postResponses(proxy, body)).text();
		await (await postResponses(proxy, body)).text();

		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_1",
		]);
	});

	it("retries a 429 on another account before returning bytes to the client", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response(
					JSON.stringify({ error: { retry_after_ms: 60_000 } }),
					{
						status: HTTP_STATUS.TOO_MANY_REQUESTS,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return textEventStream("data: recovered\n\n");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex", stream: true });

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: recovered\n\n");
		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
		]);
		expect(proxy.getStatus().retries).toBe(1);
	});

	it("disables a deactivated workspace account and rebinds session affinity", async () => {
		const now = Date.now();
		const persisted: AccountStorageV3[] = [];
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(null, async (storage: AccountStorageV3) => {
				persisted.push(structuredClone(storage));
			}),
		);
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response(
					JSON.stringify({ error: { code: "deactivated_workspace" } }),
					{
						status: 402,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return textEventStream("data: recovered\n\n");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });
		const body = {
			model: "gpt-5-codex",
			stream: true,
			metadata: { session_id: "thread-deactivated" },
		};

		const first = await postResponses(proxy, body);
		expect(first.status).toBe(HTTP_STATUS.OK);
		expect(await first.text()).toBe("data: recovered\n\n");
		const second = await postResponses(proxy, body);
		expect(second.status).toBe(HTTP_STATUS.OK);
		await second.text();
		await accountManager.flushPendingSave();

		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
			"acc_2",
		]);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(false);
		expect(accountManager.getAccountByIndex(1)?.enabled).toBe(true);
		expect(proxy.getStatus()).toMatchObject({
			retries: 1,
			rotations: 1,
			lastAccountIndex: 1,
		});
		expect(persisted.at(-1)?.accounts[0]?.enabled).toBe(false);

		const reloadedStorage = persisted.at(-1);
		expect(reloadedStorage).toBeDefined();
		if (!reloadedStorage) throw new Error("expected persisted storage");
		const reloadedManager = new AccountManager(undefined, reloadedStorage);
		const reloadedFetch = createRecordingFetch(() => textEventStream("data: restart\n\n"));
		const reloadedProxy = await startProxy({
			accountManager: reloadedManager,
			fetchImpl: reloadedFetch.fetchImpl,
		});

		await (await postResponses(reloadedProxy, { model: "gpt-5-codex" })).text();

		expect(
			reloadedFetch.calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID)),
		).toEqual(["acc_2"]);
	});

	it("disables a 403 workspace-disabled account and retries another account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response(
					JSON.stringify({ error: { code: "workspace_disabled" } }),
					{
						status: HTTP_STATUS.FORBIDDEN,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return textEventStream("data: recovered\n\n");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: recovered\n\n");
		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
		]);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(false);
		expect(accountManager.getAccountByIndex(1)?.enabled).toBe(true);
		expect(proxy.getStatus()).toMatchObject({
			retries: 1,
			rotations: 1,
			lastAccountIndex: 1,
		});
	});

	it("records a concurrent deactivation failure once for the account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const recordFailureSpy = vi.spyOn(accountManager, "recordFailure");
		let disabledCalls = 0;
		let releaseDisabledCalls: (() => void) | null = null;
		const allDisabledCallsArrived = new Promise<void>((resolve) => {
			releaseDisabledCalls = resolve;
		});
		const { calls, fetchImpl } = createRecordingFetch(async (call) => {
			if (call.headers.get(OPENAI_HEADERS.ACCOUNT_ID) === "acc_1") {
				disabledCalls += 1;
				if (disabledCalls === 2) releaseDisabledCalls?.();
				await allDisabledCallsArrived;
				return new Response(
					JSON.stringify({ error: { code: "deactivated_workspace" } }),
					{
						status: 402,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return textEventStream("data: recovered\n\n");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });
		const body = {
			model: "gpt-5-codex",
			stream: true,
			metadata: { session_id: "thread-concurrent-deactivated" },
		};

		const responses = await Promise.all([postResponses(proxy, body), postResponses(proxy, body)]);
		const payloads = (await Promise.all(responses.map((response) => response.json()))) as Array<{
			error: { reason: string };
		}>;

		expect(responses.map((response) => response.status)).toEqual([
			HTTP_STATUS.SERVICE_UNAVAILABLE,
			HTTP_STATUS.SERVICE_UNAVAILABLE,
		]);
		expect(payloads.map((payload) => payload.error.reason)).toEqual([
			"deactivated",
			"deactivated",
		]);
		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_1",
		]);
		expect(
			recordFailureSpy.mock.calls.filter(([account]) => account.index === 0),
		).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(false);
	});

	it("returns pool exhaustion after all accounts are deactivated", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 6));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { code: "deactivated_workspace" } }), {
				status: 402,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as { error: { code: string; reason: string } };

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error).toMatchObject({
			code: "codex_runtime_rotation_pool_exhausted",
			reason: "deactivated",
		});
		expect(calls).toHaveLength(6);
		expect(accountManager.getAccountsSnapshot().every((account) => account.enabled === false)).toBe(
			true,
		);
	});

	it("reports a transient exhaustion reason when deactivated skips also occurred", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 3));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 2) {
				return new Response("upstream failed", { status: 503 });
			}
			return new Response(
				JSON.stringify({ error: { code: "deactivated_workspace" } }),
				{
					status: 402,
					headers: { "content-type": "application/json" },
				},
			);
		});
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as { error: { reason: string } };

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error.reason).toBe("server-error");
		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
			"acc_3",
		]);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(false);
		expect(accountManager.getAccountByIndex(1)?.cooldownReason).toBe("server-error");
		expect(accountManager.getAccountByIndex(2)?.enabled).toBe(false);
	});

	it("forwards unrelated 402 errors without disabling the account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { code: "payment_required" } }), {
				status: 402,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(402);
		expect(payload.error.code).toBe("payment_required");
		expect(calls).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(true);
		expect(accountManager.getAccountByIndex(1)?.enabled).toBe(true);
	});

	it("forwards unrelated 403 errors without disabling the account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { code: "permission_denied" } }), {
				status: HTTP_STATUS.FORBIDDEN,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
		expect(payload.error.code).toBe("permission_denied");
		expect(calls).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(true);
		expect(accountManager.getAccountByIndex(1)?.enabled).toBe(true);
	});

	it("persists cooldowns so a restarted proxy avoids limited accounts", async () => {
		const now = Date.now();
		const persisted: AccountStorageV3[] = [];
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(null, async (storage: AccountStorageV3) => {
				persisted.push(structuredClone(storage));
			}),
		);
		const firstManager = new AccountManager(undefined, createStorage(now, 2));
		const firstFetch = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response(
					JSON.stringify({ error: { retry_after_ms: 120_000 } }),
					{
						status: HTTP_STATUS.TOO_MANY_REQUESTS,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return textEventStream("data: recovered\n\n");
		});
		const firstProxy = await startProxy({
			accountManager: firstManager,
			fetchImpl: firstFetch.fetchImpl,
		});

		await (await postResponses(firstProxy, { model: "gpt-5-codex" })).text();
		await firstManager.flushPendingSave();

		const reloadedStorage = persisted.at(-1);
		expect(reloadedStorage).toBeDefined();
		if (!reloadedStorage) throw new Error("expected persisted storage");
		expect(reloadedStorage?.accounts[0]?.rateLimitResetTimes["gpt-5-codex"]).toBeTypeOf(
			"number",
		);
		const secondManager = new AccountManager(undefined, reloadedStorage);
		const secondFetch = createRecordingFetch(() => textEventStream("data: restart\n\n"));
		const secondProxy = await startProxy({
			accountManager: secondManager,
			fetchImpl: secondFetch.fetchImpl,
		});

		await (await postResponses(secondProxy, { model: "gpt-5-codex" })).text();

		expect(secondFetch.calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_2",
		]);
	});

	it("cools down server-error and network-failure accounts before retrying", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 3));
		const saveToDiskDebouncedSpy = vi.spyOn(accountManager, "saveToDiskDebounced");
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response("upstream failed", { status: 503 });
			}
			if (attempt === 2) {
				throw new Error("socket closed");
			}
			return textEventStream("data: third\n\n");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex", stream: true });

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: third\n\n");
		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
			"acc_3",
		]);
		expect(accountManager.getAccountByIndex(0)?.cooldownReason).toBe("server-error");
		expect(accountManager.getAccountByIndex(1)?.cooldownReason).toBe("network-error");
		expect(saveToDiskDebouncedSpy).toHaveBeenCalled();
	});

	it("deduplicates concurrent expired-token refresh and persistence", async () => {
		const now = Date.now();
		const storage = createStorage(now, 1);
		const account = storage.accounts[0];
		if (!account) throw new Error("expected account");
		account.accessToken = "expired-access";
		account.expiresAt = now - 60_000;
		const persisted: AccountStorageV3[] = [];
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(null, async (nextStorage: AccountStorageV3) => {
				persisted.push(structuredClone(nextStorage));
				await saveAccountsMock(nextStorage);
			}),
		);
		let releaseRefresh: (() => void) | undefined;
		const refreshBlocked = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		refreshAccessTokenMock.mockImplementation(async () => {
			await refreshBlocked;
			return {
				type: "success",
				access: "fresh-access",
				refresh: "refresh-1",
				expires: now + 3_600_000,
			};
		});
		const accountManager = new AccountManager(undefined, storage);
		vi.spyOn(accountManager, "saveToDiskDebounced").mockImplementation(() => undefined);
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			textEventStream(`data: refreshed-${attempt}\n\n`),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const first = postResponses(proxy, { model: "gpt-5-codex" });
		const second = postResponses(proxy, { model: "gpt-5-codex" });
		await vi.waitFor(() => expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1));
		releaseRefresh?.();
		const responses = await Promise.all([first, second]);

		expect(responses.map((response) => response.status)).toEqual([
			HTTP_STATUS.OK,
			HTTP_STATUS.OK,
		]);
		await Promise.all(responses.map((response) => response.text()));
		expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(persisted[0]?.accounts[0]?.accessToken).toBe("fresh-access");
		expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
			"Bearer fresh-access",
			"Bearer fresh-access",
		]);
		await accountManager.flushPendingSave();
	});

	it("deduplicates pending refresh commits per account when OAuth tuples differ", async () => {
		const now = Date.now();
		const storage = createStorage(now, 1);
		const account = storage.accounts[0];
		if (!account) throw new Error("expected account");
		account.accessToken = "expired-access";
		account.expiresAt = now - 60_000;
		const persisted: AccountStorageV3[] = [];
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(null, async (nextStorage: AccountStorageV3) => {
				persisted.push(structuredClone(nextStorage));
				await saveAccountsMock(nextStorage);
			}),
		);
		refreshAccessTokenMock
			.mockResolvedValueOnce({
				type: "success",
				access: "fresh-access-1",
				refresh: "refresh-1",
				expires: now + 3_600_000,
			})
			.mockResolvedValueOnce({
				type: "success",
				access: "fresh-access-2",
				refresh: "refresh-1",
				expires: now + 7_200_000,
			});
		const accountManager = new AccountManager(undefined, storage);
		vi.spyOn(accountManager, "saveToDiskDebounced").mockImplementation(() => undefined);
		const originalCommit = accountManager.commitRefreshedAuth.bind(accountManager);
		let releaseCommit: (() => void) | undefined;
		const commitBlocked = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const commitSpy = vi
			.spyOn(accountManager, "commitRefreshedAuth")
			.mockImplementation(async (...args) => {
				await commitBlocked;
				return originalCommit(...args);
			});
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			textEventStream(`data: refreshed-${attempt}\n\n`),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const first = postResponses(proxy, { model: "gpt-5-codex" });
		await vi.waitFor(() => expect(commitSpy).toHaveBeenCalledTimes(1));
		resetRefreshQueue();
		const second = postResponses(proxy, { model: "gpt-5-codex" });
		await vi.waitFor(() => expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2));
		releaseCommit?.();
		const responses = await Promise.all([first, second]);

		expect(responses.map((response) => response.status)).toEqual([
			HTTP_STATUS.OK,
			HTTP_STATUS.OK,
		]);
		await Promise.all(responses.map((response) => response.text()));
		expect(commitSpy).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(persisted[0]?.accounts[0]?.accessToken).toBe("fresh-access-1");
		expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
			"Bearer fresh-access-1",
			"Bearer fresh-access-1",
		]);
		await accountManager.flushPendingSave();
	});

	it("returns a structured pool exhaustion response when no account can satisfy the request", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { retry_after_ms: 45_000 } }), {
				status: HTTP_STATUS.TOO_MANY_REQUESTS,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex", stream: true });
		const payload = (await response.json()) as {
			error: { code: string; reason: string; retry_after_ms: number; hint: string };
		};

		expect(response.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		expect(payload.error).toMatchObject({
			code: "codex_runtime_rotation_pool_exhausted",
			reason: "rate-limit",
			hint: "Run `codex-multi-auth rotation status` to inspect account state.",
		});
		expect(payload.error.retry_after_ms).toBeGreaterThan(0);
	});

	it("includes per-account skip reasons in final pool exhaustion responses", async () => {
		const now = Date.now();
		const storage = createStorage(now, 2);
		const first = storage.accounts[0];
		if (first) {
			first.rateLimitResetTimes = { codex: now + 60_000 };
		}
		const second = storage.accounts[1];
		if (second) {
			second.enabled = true;
			second.coolingDownUntil = now + 60_000;
			second.cooldownReason = "server-error";
		}
		const accountManager = new AccountManager(undefined, storage);
		const managedFirst = accountManager.getAccountByIndex(0);
		const managedSecond = accountManager.getAccountByIndex(1);
		if (managedFirst) {
			accountManager.markAccountCoolingDown(
				managedFirst,
				60_000,
				"network-error",
			);
		}
		if (managedSecond) {
			accountManager.markAccountCoolingDown(
				managedSecond,
				60_000,
				"server-error",
			);
		}
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response("should not be called", { status: HTTP_STATUS.OK }),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as {
			error: {
				code: string;
				reason: string;
				account_skip_reasons: Record<string, string>;
				hint: string;
			};
		};

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error.code).toBe("codex_runtime_rotation_pool_exhausted");
		expect(payload.error.reason).toBe("no-account");
		expect(payload.error.account_skip_reasons).toMatchObject({
			"0": "cooling-down:network-error",
			"1": "cooling-down:server-error",
		});
		expect(payload.error.hint).toContain("rotation reset-runtime");
		expect(calls).toHaveLength(0);
	});

	it("deduplicates concurrent stale-runtime reload recovery", async () => {
		const now = Date.now();
		const staleManager = new AccountManager(undefined, createStorage(now, 2));
		const freshManager = new AccountManager(undefined, createStorage(now, 2));
		let releaseReload: (() => void) | null = null;
		const originalSkipReason = staleManager.getAccountRuntimeSkipReason;
		const skipReasonSpy = vi
			.spyOn(AccountManager.prototype, "getAccountRuntimeSkipReason")
			.mockImplementation(function mockedSkipReason(index, family, model) {
				if (this === staleManager) return "circuit-open";
				return originalSkipReason.call(this, index, family, model);
			});
		const loadSpy = vi
			.spyOn(AccountManager, "loadFromDisk")
			.mockImplementationOnce(
				async () =>
					new Promise<AccountManager>((resolveReload) => {
						releaseReload = () => resolveReload(freshManager);
					}),
			);
		const resetSpy = vi.spyOn(AccountManager, "resetVolatileRuntimeState");
		const { calls, fetchImpl } = createRecordingFetch(() => textEventStream());
		try {
			const proxy = await startProxy({
				accountManager: staleManager,
				fetchImpl,
			});
			const responses = [
				postResponses(proxy, { model: "gpt-5-codex" }),
				postResponses(proxy, { model: "gpt-5-codex" }),
			];
			await vi.waitFor(() => {
				expect(loadSpy).toHaveBeenCalledTimes(1);
			});
			releaseReload?.();
			const settled = await Promise.all(responses);
			expect(settled.map((response) => response.status)).toEqual([
				HTTP_STATUS.OK,
				HTTP_STATUS.OK,
			]);
			await Promise.all(settled.map((response) => response.text()));
			expect(loadSpy).toHaveBeenCalledTimes(1);
			expect(resetSpy).toHaveBeenCalledTimes(1);
			expect(calls).toHaveLength(2);
		} finally {
			skipReasonSpy.mockRestore();
			loadSpy.mockRestore();
			resetSpy.mockRestore();
		}
	});

	it("recovers stale runtime state when real circuit breakers are open", async () => {
		const now = Date.now();
		const staleManager = new AccountManager(undefined, createStorage(now, 2));
		const freshManager = new AccountManager(undefined, createStorage(now, 2));
		for (let index = 0; index < staleManager.getAccountCount(); index += 1) {
			const account = staleManager.getAccountByIndex(index);
			if (!account) continue;
			staleManager.recordFailure(account, "codex", "gpt-5-codex");
			staleManager.recordFailure(account, "codex", "gpt-5-codex");
			staleManager.recordFailure(account, "codex", "gpt-5-codex");
		}
		expect(staleManager.getMinWaitTimeForFamily("codex", "gpt-5-codex")).toBeGreaterThan(0);
		const loadSpy = vi
			.spyOn(AccountManager, "loadFromDisk")
			.mockResolvedValueOnce(freshManager);
		const resetSpy = vi.spyOn(AccountManager, "resetVolatileRuntimeState");
		const { calls, fetchImpl } = createRecordingFetch(() => textEventStream());
		try {
			const proxy = await startProxy({
				accountManager: staleManager,
				fetchImpl,
			});

			const response = await postResponses(proxy, { model: "gpt-5-codex" });
			await response.text();

			expect(response.status).toBe(HTTP_STATUS.OK);
			expect(loadSpy).toHaveBeenCalledTimes(1);
			expect(resetSpy).toHaveBeenCalledTimes(1);
			expect(calls).toHaveLength(1);
		} finally {
			loadSpy.mockRestore();
			resetSpy.mockRestore();
		}
	});

	it("refreshes request pool limits when stale-runtime reload increases account count", async () => {
		const now = Date.now();
		const staleManager = new AccountManager(undefined, createStorage(now, 1));
		const freshManager = new AccountManager(undefined, createStorage(now, 2));
		const originalSkipReason = staleManager.getAccountRuntimeSkipReason;
		const skipReasonSpy = vi
			.spyOn(AccountManager.prototype, "getAccountRuntimeSkipReason")
			.mockImplementation(function mockedSkipReason(index, family, model) {
				if (this === staleManager) return "circuit-open";
				return originalSkipReason.call(this, index, family, model);
			});
		const loadSpy = vi
			.spyOn(AccountManager, "loadFromDisk")
			.mockResolvedValueOnce(freshManager);
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			attempt === 1
				? new Response("first account failed", { status: HTTP_STATUS.SERVICE_UNAVAILABLE })
				: textEventStream(),
		);
		try {
			const proxy = await startProxy({
				accountManager: staleManager,
				fetchImpl,
			});

			const response = await postResponses(proxy, { model: "gpt-5-codex" });
			await response.text();

			expect(response.status).toBe(HTTP_STATUS.OK);
			expect(loadSpy).toHaveBeenCalledTimes(1);
			expect(calls).toHaveLength(2);
			expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
				"acc_1",
				"acc_2",
			]);
		} finally {
			skipReasonSpy.mockRestore();
			loadSpy.mockRestore();
		}
	});

	it("caps per-request upstream attempts instead of walking a large pool", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 6));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response("upstream failed", { status: 503 }),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as { error: { reason: string } };

		expect(response.status).toBe(503);
		expect(payload.error.reason).toBe("budget");
		expect(calls).toHaveLength(4);
	});

	it("times out a hung upstream fetch and cools down the account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch(
			() => new Promise<Response>(() => undefined),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { fetchTimeoutMs: 10 },
		});

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as { error: { reason: string } };

		expect(response.status).toBe(503);
		expect(payload.error.reason).toBe("network-error");
		expect(calls).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)?.cooldownReason).toBe(
			"network-error",
		);
	});

	it("does not replay a request after the upstream stream has started", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const encoder = new TextEncoder();
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("data: first\n\n"));
						controller.error(new Error("stream interrupted"));
					},
				}),
				{
					status: HTTP_STATUS.OK,
					headers: { "content-type": "text/event-stream" },
				},
			),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		await expect(
			postResponses(proxy, { model: "gpt-5-codex", stream: true }),
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)?.cooldownReason).toBe("network-error");
		expect(proxy.getStatus().streamsStarted).toBe(1);
	});

	it("returns 401 to client and does not rotate when upstream explicitly invalidates the token", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const invalidationBody = JSON.stringify({
			error: { message: "Encountered invalidated oauth token for user, failing request" },
		});
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(invalidationBody, {
				status: HTTP_STATUS.UNAUTHORIZED,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		// upstream-401 invalidation path emits the same machine-readable contract as
		// the refresh-failure path, preserving the upstream message
		const body = (await response.json()) as { error: { message: string; code: string } };
		expect(body.error.code).toBe("token_invalidated");
		expect(body.error.message).toBe(
			"Encountered invalidated oauth token for user, failing request",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
		expect(accountManager.getAccountByIndex(0)?.cooldownReason).toBe("auth-failure");
		// token invalidation applies the long cooldown (~5min), not the generic 30s
		const coolingDownUntil = accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(coolingDownUntil).toBeGreaterThan(now + 250_000);
		expect(coolingDownUntil).toBeLessThan(now + 350_000);
		expect(proxy.getStatus().rotations).toBe(0);
	});

	it("rotates to next account on a generic 401 that is not a token invalidation", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
					status: HTTP_STATUS.UNAUTHORIZED,
					headers: { "content-type": "application/json" },
				});
			}
			return textEventStream("data: recovered\n\n");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex", stream: true });

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: recovered\n\n");
		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
		]);
		// generic 401 applies the short 30s cooldown, not the 5-min invalidation cooldown
		const coolingDownUntil = accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(coolingDownUntil).toBeGreaterThan(now + 20_000);
		expect(coolingDownUntil).toBeLessThan(now + 40_000);
		expect(proxy.getStatus().rotations).toBe(1);
	});

	it("rotates on empty 401 body instead of treating as token invalidation", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response("", { status: HTTP_STATUS.UNAUTHORIZED });
			}
			return textEventStream("data: recovered\n\n");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex", stream: true });

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: recovered\n\n");
		expect(calls).toHaveLength(2);
		expect(proxy.getStatus().rotations).toBe(1);
	});

	it("returns 401 to client and does not rotate when token refresh endpoint returns invalidation error", async () => {
		const now = Date.now();
		const storage = createStorage(now, 2);
		const account0 = storage.accounts[0];
		if (!account0) throw new Error("expected account");
		account0.expiresAt = now - 60_000; // force refresh
		refreshAccessTokenMock.mockResolvedValueOnce({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "Your authentication token has been invalidated.",
		});
		const accountManager = new AccountManager(undefined, storage);
		const { calls, fetchImpl } = createRecordingFetch(() => textEventStream("data: ok\n\n"));
		const proxy = await startProxy({ accountManager, fetchImpl });

		const bodyWithSession = {
			model: "gpt-5-codex",
			metadata: { session_id: "session-refresh-inv" },
		};
		const response = await postResponses(proxy, bodyWithSession);
		const body = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(body.error.code).toBe("token_invalidated");
		expect(calls).toHaveLength(0);
		const coolingDownUntil = accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(coolingDownUntil).toBeGreaterThan(now + 250_000);
		expect(proxy.getStatus().rotations).toBe(0);
		// session affinity cleared — next request with same session routes to healthy account
		const followUp = await postResponses(proxy, bodyWithSession);
		expect(followUp.status).toBe(HTTP_STATUS.OK);
		await followUp.text();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_2");
	});

	it("minRotationIntervalMs window slides on each successful serve (regression)", async () => {
		// Without the sliding fix, lastGlobalSwitchAt only updates on account change.
		// Serving acc_1 at t=0 then t=55s would keep the anchor at t=0. A request at
		// t=61s (>60s since t=0) would rotate to acc_2, even though acc_1 served just
		// 6s earlier. With the fix, lastGlobalSwitchAt refreshes every serve so the
		// t=61s request sees a 6s-old anchor and keeps acc_1.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.stubEnv("CODEX_AUTH_MIN_ROTATION_INTERVAL_MS", "60000");
		try {
			vi.setSystemTime(0);
			const now = Date.now;
			const storage = createStorage(0, 2);
			const accountManager = new AccountManager(undefined, storage);
			const { calls, fetchImpl } = createRecordingFetch(() =>
				textEventStream("data: ok\n\n"),
			);
			const proxy = await startProxy({ accountManager, fetchImpl, options: { now } });

			await (await postResponses(proxy, { model: "gpt-5-codex" })).text();

			vi.setSystemTime(55_000);
			await (await postResponses(proxy, { model: "gpt-5-codex" })).text();

			// t=61s: 61s past original switch (>60s) but only 6s since last serve
			vi.setSystemTime(61_000);
			await (await postResponses(proxy, { model: "gpt-5-codex" })).text();

			expect(calls.map((c) => c.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
				"acc_1",
				"acc_1",
				"acc_1",
			]);
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
		}
	});

	it("sticks to last served account within minRotationIntervalMs window", async () => {
		vi.stubEnv("CODEX_AUTH_MIN_ROTATION_INTERVAL_MS", "60000");
		try {
			const now = Date.now();
			const accountManager = new AccountManager(undefined, createStorage(now, 2));
			const { calls, fetchImpl } = createRecordingFetch(() =>
				textEventStream("data: ok\n\n"),
			);
			const proxy = await startProxy({ accountManager, fetchImpl });

			await (await postResponses(proxy, { model: "gpt-5-codex" })).text();
			await (await postResponses(proxy, { model: "gpt-5-codex" })).text();

			expect(calls).toHaveLength(2);
			expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
			expect(calls[1]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("detects token invalidation phrase in non-json 401 body (e.g. html error page)", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const htmlBody =
			"<html><body>error: oauth token has been invalidated by the server</body></html>";
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(htmlBody, {
				status: HTTP_STATUS.UNAUTHORIZED,
				headers: { "content-type": "text/html" },
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		// non-JSON upstream body falls back to the stable message rather than echoing
		// markup back to the client, but still carries the consistent code
		const body = (await response.json()) as { error: { message: string; code: string } };
		expect(body.error.code).toBe("token_invalidated");
		expect(body.error.message).toBe("OAuth token has been invalidated. Please re-login.");
		expect(calls).toHaveLength(1);
		expect(proxy.getStatus().rotations).toBe(0);
	});
});

describe("routing mutex serializes selection + cursor commit (issue #14 / L4)", () => {
	const prevEnv = process.env.CODEX_AUTH_ROUTING_MUTEX;

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.CODEX_AUTH_ROUTING_MUTEX;
		else process.env.CODEX_AUTH_ROUTING_MUTEX = prevEnv;
		__resetRoutingMutexForTests();
	});

	// Deterministic, fix-sensitive proof of the property the hot path depends on:
	// when `routingMutex === "enabled"`, a "select + commit" critical section that
	// spans an await must NOT let a second critical section begin its selection
	// until the first has fully committed. The pre-fix code committed the cursor in
	// a SEPARATE mutex acquisition (markSwitched ran unlocked during selection,
	// markSwitchedLocked ran later in persist), so two requests could both select
	// before either committed. This test models that exact shape at the mutex layer
	// and asserts strict serialization (maxConcurrent === 1) plus reentrancy.
	it("never overlaps two enabled-mode select+commit sections, and is reentrant", async () => {
		__resetRoutingMutexForTests();
		let active = 0;
		let maxConcurrent = 0;
		const selectionOrder: number[] = [];
		// Gate that holds the FIRST critical section open across an await, so that if
		// selection were allowed outside the lock the second request's selection
		// would interleave here and bump maxConcurrent to 2.
		let releaseFirst: (() => void) | undefined;
		const firstHeld = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const runSelectCommit = (id: number, gateOpen: boolean): Promise<void> =>
			withRoutingMutex("enabled", async () => {
				// SELECTION happens here, inside the held mutex.
				selectionOrder.push(id);
				active += 1;
				maxConcurrent = Math.max(maxConcurrent, active);
				// Reentrancy: the real hot path calls markSwitchedLocked (which itself
				// routes through withRoutingMutex) WHILE already holding the mutex.
				// That nested acquisition must run inline rather than deadlock.
				expect(isRoutingMutexHeld()).toBe(true);
				await withRoutingMutex("enabled", async () => {
					expect(isRoutingMutexHeld()).toBe(true);
					// COMMIT happens here, still inside the same held section.
				});
				if (gateOpen) {
					// Hold the first section open until the second has been scheduled.
					await firstHeld;
				}
				active -= 1;
			});

		const first = runSelectCommit(0, true);
		// Ensure the first task has acquired the mutex before scheduling the second.
		await Promise.resolve();
		const second = runSelectCommit(1, false);
		// Let the event loop spin: a buggy (non-serialized) implementation would run
		// the second selection now, while the first is parked on `firstHeld`.
		await new Promise((resolve) => setTimeout(resolve, 20));
		releaseFirst?.();
		await Promise.all([first, second]);

		// Strict serialization: the two critical sections never overlapped.
		expect(maxConcurrent).toBe(1);
		// And they ran in FIFO order, second strictly after the first committed.
		expect(selectionOrder).toEqual([0, 1]);
	});

	// End-to-end: two concurrent proxy requests under routingMutex="enabled" against
	// a 2-account pool must serialize selection + cursor advance, hand out DISTINCT
	// accounts, and both complete without deadlock (the reentrant markSwitchedLocked
	// commit on the hot path + the gated commit in persistRuntimeActiveAccount).
	it("hands distinct accounts to concurrent enabled-mode requests without deadlock", async () => {
		process.env.CODEX_AUTH_ROUTING_MUTEX = "enabled";
		__resetRoutingMutexForTests();
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));

		// Barrier: hold BOTH upstream fetches open until both requests are in-flight,
		// guaranteeing genuine concurrency through the select+commit critical section.
		let releaseFetch: (() => void) | undefined;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		let inFlight = 0;
		let bothInFlight: (() => void) | undefined;
		const bothStarted = new Promise<void>((resolve) => {
			bothInFlight = resolve;
		});
		const { calls, fetchImpl } = createRecordingFetch(async () => {
			inFlight += 1;
			if (inFlight >= 2) bothInFlight?.();
			await fetchGate;
			return textEventStream("data: forwarded\n\n");
		});

		const proxy = await startProxy({ accountManager, fetchImpl });
		expect(accountManager.getRoutingMutexMode()).toBe("enabled");

		const bodyFor = (session: string) => ({
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
			metadata: { session_id: session },
		});

		const reqA = postResponses(proxy, bodyFor("session-a"));
		const reqB = postResponses(proxy, bodyFor("session-b"));

		// Wait until both requests have passed selection and reached the upstream
		// fetch, then release them. A deadlock here (e.g. non-reentrant re-acquire)
		// would hang and fail the test via timeout rather than passing silently.
		await bothStarted;
		releaseFetch?.();
		const [resA, resB] = await Promise.all([reqA, reqB]);

		expect(resA.status).toBe(HTTP_STATUS.OK);
		expect(resB.status).toBe(HTTP_STATUS.OK);
		await Promise.all([resA.text(), resB.text()]);

		// Both upstream calls happened, and selection+advance serialized so the two
		// concurrent requests landed on DISTINCT accounts (no stampede onto acc_1).
		expect(calls).toHaveLength(2);
		const servedAuth = calls.map((c) => c.headers.get("authorization")).sort();
		expect(servedAuth).toEqual(["Bearer access-1", "Bearer access-2"]);
	});
});

describe("sequential mode survives the routing-mutex path (issue #509)", () => {
	const prevMutex = process.env.CODEX_AUTH_ROUTING_MUTEX;
	const prevStrategy = process.env.CODEX_AUTH_SCHEDULING_STRATEGY;

	afterEach(() => {
		if (prevMutex === undefined) delete process.env.CODEX_AUTH_ROUTING_MUTEX;
		else process.env.CODEX_AUTH_ROUTING_MUTEX = prevMutex;
		if (prevStrategy === undefined)
			delete process.env.CODEX_AUTH_SCHEDULING_STRATEGY;
		else process.env.CODEX_AUTH_SCHEDULING_STRATEGY = prevStrategy;
		__resetRoutingMutexForTests();
	});

	// Regression for the P1 caught in review: under routingMutex="enabled" the hot
	// path re-commits the selected account via markSwitchedLocked after
	// chooseAccount. In sequential mode the sequential selector already committed
	// the active index inside the held mutex, so the re-commit must be skipped;
	// otherwise the drain-first primary could double-advance. This test drives the
	// real proxy with both flags on and asserts three back-to-back requests all
	// stick to the SAME account while it stays healthy.
	it("keeps sticking to one account across requests under enabled mutex", async () => {
		process.env.CODEX_AUTH_ROUTING_MUTEX = "enabled";
		process.env.CODEX_AUTH_SCHEDULING_STRATEGY = "sequential";
		__resetRoutingMutexForTests();
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));

		const { calls, fetchImpl } = createRecordingFetch(async () =>
			textEventStream("data: forwarded\n\n"),
		);

		const proxy = await startProxy({ accountManager, fetchImpl });
		expect(accountManager.getRoutingMutexMode()).toBe("enabled");

		const bodyFor = (session: string) => ({
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
			metadata: { session_id: session },
		});

		// Distinct sessions so any per-session affinity would scatter them; sequential
		// mode must ignore affinity and keep all three on the same active account.
		for (const session of ["s-1", "s-2", "s-3"]) {
			const res = await postResponses(proxy, bodyFor(session));
			expect(res.status).toBe(HTTP_STATUS.OK);
			await res.text();
		}

		expect(calls).toHaveLength(3);
		const servedAuth = calls.map((c) => c.headers.get("authorization"));
		expect(servedAuth).toEqual([
			"Bearer access-1",
			"Bearer access-1",
			"Bearer access-1",
		]);
		expect(accountManager.getActiveIndexForFamily("codex")).toBe(0);
	});
});

describe("buildTokenInvalidationBody", () => {
	const FALLBACK = "OAuth token has been invalidated. Please re-login.";
	const parse = (raw: string) =>
		JSON.parse(raw) as { error: { message: string; code: string } };

	it("always emits the token_invalidated code", () => {
		expect(parse(buildTokenInvalidationBody("")).error.code).toBe("token_invalidated");
		expect(
			parse(buildTokenInvalidationBody(JSON.stringify({ message: "x" }))).error.code,
		).toBe("token_invalidated");
	});

	it("uses the stable fallback message for empty input", () => {
		expect(parse(buildTokenInvalidationBody("")).error.message).toBe(FALLBACK);
	});

	it("preserves a top-level message", () => {
		const body = JSON.stringify({ message: "Encountered invalidated oauth token" });
		expect(parse(buildTokenInvalidationBody(body)).error.message).toBe(
			"Encountered invalidated oauth token",
		);
	});

	it("preserves a nested error.message when no top-level message is present", () => {
		const body = JSON.stringify({ error: { message: "nested invalidation detail" } });
		expect(parse(buildTokenInvalidationBody(body)).error.message).toBe(
			"nested invalidation detail",
		);
	});

	it("prefers a top-level message over a nested error.message", () => {
		const body = JSON.stringify({
			message: "top-level wins",
			error: { message: "nested loses" },
		});
		expect(parse(buildTokenInvalidationBody(body)).error.message).toBe("top-level wins");
	});

	it("falls back to nested error.message when top-level message is blank/whitespace", () => {
		const body = JSON.stringify({
			message: "   ",
			error: { message: "nested fallback" },
		});
		expect(parse(buildTokenInvalidationBody(body)).error.message).toBe("nested fallback");
	});

	it("falls back to the stable message for non-JSON bodies (no markup echoed)", () => {
		const html = "<html><body>oauth token has been invalidated</body></html>";
		expect(parse(buildTokenInvalidationBody(html)).error.message).toBe(FALLBACK);
	});

	it("falls back to the stable message when no usable message field exists", () => {
		const body = JSON.stringify({ error: { code: "something_else" } });
		expect(parse(buildTokenInvalidationBody(body)).error.message).toBe(FALLBACK);
	});
});

describe("chooseAccount sequential mode (issue #509)", () => {
	beforeEach(() => {
		resetTrackers();
		clearCircuitBreakers();
	});

	const makeManager = (count: number) => {
		const now = Date.now();
		const stored = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: Array.from({ length: count }, (_, i) => ({
				refreshToken: `token-${i}`,
				addedAt: now,
				lastUsed: now - i * 1000,
			})),
		};
		return new AccountManager(undefined, stored as never);
	};

	it("ignores session affinity and follows the active account", () => {
		const manager = makeManager(2);
		manager.setActiveIndex(0);

		// Affinity store points this session at account 1 — sequential must NOT honor it.
		const affinity = new SessionAffinityStore();
		affinity.remember("session-xyz", 1);

		const selected = chooseAccount({
			accountManager: manager,
			sessionAffinityStore: affinity,
			sessionKey: "session-xyz",
			family: "codex",
			model: null,
			attemptedIndexes: new Set(),
			now: Date.now(),
			policy: null,
			pinnedIndex: null,
			schedulingStrategy: "sequential",
		});

		expect(selected?.index).toBe(0);
	});

	it("honors a manual pin over sequential mode", () => {
		const manager = makeManager(2);
		manager.setActiveIndex(0);

		const selected = chooseAccount({
			accountManager: manager,
			sessionAffinityStore: null,
			sessionKey: null,
			family: "codex",
			model: null,
			attemptedIndexes: new Set(),
			now: Date.now(),
			policy: null,
			pinnedIndex: 1,
			schedulingStrategy: "sequential",
		});

		// Pin tier runs first, so the pinned account wins regardless of the active one.
		expect(selected?.index).toBe(1);
	});

	it("advances to the next account when the active one is exhausted", () => {
		const manager = makeManager(2);
		const account0 = manager.setActiveIndex(0)!;
		manager.markRateLimited(account0, 60_000, "codex");

		const selected = chooseAccount({
			accountManager: manager,
			sessionAffinityStore: null,
			sessionKey: null,
			family: "codex",
			model: null,
			attemptedIndexes: new Set(),
			now: Date.now(),
			policy: null,
			pinnedIndex: null,
			schedulingStrategy: "sequential",
		});

		expect(selected?.index).toBe(1);
	});

	it("does not move the active primary when a healthy active account is only attempted (P1 #509)", () => {
		const manager = makeManager(2);
		manager.setActiveIndex(0);

		// Simulate a transient, non-exhausting failure on the active account: it
		// is still usable but already in attemptedIndexes for THIS request, so the
		// sequential tier falls through to the linear-scan fallback.
		const tried = chooseAccount({
			accountManager: manager,
			sessionAffinityStore: null,
			sessionKey: null,
			family: "codex",
			model: null,
			attemptedIndexes: new Set([0]),
			now: Date.now(),
			policy: null,
			pinnedIndex: null,
			schedulingStrategy: "sequential",
		});

		// The fallback hands account 1 to TRY this request...
		expect(tried?.index).toBe(1);
		// ...but the drain-first primary must NOT have advanced: account 0 was
		// never exhausted, so the next fresh request must stick to it again.
		expect(manager.getActiveIndexForFamily("codex")).toBe(0);

		const nextRequest = chooseAccount({
			accountManager: manager,
			sessionAffinityStore: null,
			sessionKey: null,
			family: "codex",
			model: null,
			attemptedIndexes: new Set(),
			now: Date.now(),
			policy: null,
			pinnedIndex: null,
			schedulingStrategy: "sequential",
		});
		expect(nextRequest?.index).toBe(0);
	});

	it("returns null when every account is exhausted in sequential mode", () => {
		const manager = makeManager(2);
		const account0 = manager.setActiveIndex(0)!;
		const account1 = manager.getAccountByIndex(1)!;
		manager.markRateLimited(account0, 60_000, "codex");
		manager.markRateLimited(account1, 60_000, "codex");

		const selected = chooseAccount({
			accountManager: manager,
			sessionAffinityStore: null,
			sessionKey: null,
			family: "codex",
			model: null,
			attemptedIndexes: new Set(),
			now: Date.now(),
			policy: null,
			pinnedIndex: null,
			schedulingStrategy: "sequential",
		});

		expect(selected).toBeNull();
	});
});
