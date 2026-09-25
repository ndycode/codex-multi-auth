import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import * as nativeStorageReader from "../lib/runtime/native-account-storage.js";
import * as tokenRefreshRuntime from "../lib/runtime/rotation-token-refresh.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib";
import * as zlib from "node:zlib";
import { AccountManager, getRuntimeTrackerKey } from "../lib/accounts.js";
import { getModelFamily } from "../lib/prompts/codex.js";
import { CodexValidationError } from "../lib/errors.js";
import { HTTP_STATUS, OPENAI_HEADERS } from "../lib/constants.js";
import {
	startRuntimeRotationProxy,
	buildTokenInvalidationBody,
	buildQuotaScheduleKey,
	chooseAccount,
	normalizeForcedAccountIndex,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { PreemptiveQuotaScheduler } from "../lib/preemptive-quota-scheduler.js";
import { SessionAffinityStore } from "../lib/session-affinity.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import {
	__resetRoutingMutexForTests,
	isRoutingMutexHeld,
	withRoutingMutex,
} from "../lib/routing-mutex.js";
import * as storageMetaModule from "../lib/runtime/rotation-storage-meta.js";
import * as runtimePolicy from "../lib/policy/runtime-policy.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import {
	DEFAULT_TOKEN_BUCKET_CONFIG,
	getTokenTracker,
	resetTrackers,
} from "../lib/rotation.js";
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

const COMPLETED_FRAME = 'data: {"type":"response.completed","response":{"id":"fixture-completed"}}\n\n';
function textEventStream(body = "data: {}\n\n", headers?: HeadersInit): Response {
	if (!/"type"\s*:\s*"(?:response\.(?:completed|failed|incomplete|cancelled)|error)"/.test(body)) body += COMPLETED_FRAME;
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
	// Forced-account pin (#623) is read from the ambient env by startRuntimeRotationProxy;
	// never let one test's value bleed into the next.
	delete process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX;
});

describe("normalizeForcedAccountIndex (#623)", () => {
	it("accepts non-negative integers from numbers and strings", () => {
		expect(normalizeForcedAccountIndex(0)).toBe(0);
		expect(normalizeForcedAccountIndex(3)).toBe(3);
		expect(normalizeForcedAccountIndex("2")).toBe(2);
		expect(normalizeForcedAccountIndex("  4 ")).toBe(4);
	});

	it("returns null for absent, blank, or invalid values", () => {
		expect(normalizeForcedAccountIndex(null)).toBeNull();
		expect(normalizeForcedAccountIndex(undefined)).toBeNull();
		expect(normalizeForcedAccountIndex("")).toBeNull();
		expect(normalizeForcedAccountIndex("   ")).toBeNull();
		expect(normalizeForcedAccountIndex("abc")).toBeNull();
		expect(normalizeForcedAccountIndex(-1)).toBeNull();
		expect(normalizeForcedAccountIndex(1.5)).toBeNull();
	});
});

describe("runtime rotation proxy", () => {
	it("does not treat the local capability marker as client authentication", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => textEventStream());
		const proxy = await startProxy({ accountManager, fetchImpl });
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { "x-openai-actor-authorization": "codex-multi-auth-local" },
			body: "{}",
		});
		expect(response.status).toBe(401);
		await response.text();
		expect(calls).toHaveLength(0);
	});
	it.each(["/responses", "/v1/responses"])("strips mixed-case actor marker before dispatch to ChatGPT on %s", async (path) => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => new Response('{}', { headers: { "content-type": "application/json" } }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { upstreamBaseUrl: "https://chatgpt.com/backend-api" } });
		const response = await postResponses(proxy, { model: "gpt-5.6-sol" }, path, { "X-OpenAI-Actor-Authorization": "arbitrary-spoof" });
		await response.text();
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0].url).hostname).toBe("chatgpt.com");
		expect(calls[0].headers.has("x-openai-actor-authorization")).toBe(false);
		expect(calls[0].headers.get("authorization")).toMatch(/^Bearer access-/);
	});
	it("records image operation and successful outcome through the runtime recorder", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const record = vi.fn(async () => undefined);
		const recorder = vi.spyOn(runtimePolicy, "createRuntimeUsageRecorder")
			.mockReturnValue({ hasRecorded: () => record.mock.calls.length > 0, record });
		const { fetchImpl } = createRecordingFetch(() => new Response('{"data":[]}', {
			headers: { "content-type": "application/json" },
		}));
		const proxy = await startProxy({ accountManager, fetchImpl });
		const response = await postResponses(proxy, { model: "gpt-image-2" }, "/images/generations");
		await response.text();
		expect(response.status).toBe(200);
		expect(recorder).toHaveBeenCalledWith(expect.objectContaining({ operation: "images", model: "gpt-image-2" }));
		await vi.waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", statusCode: 200 })));
	});
	it("keeps Responses usable after image success and a textual 429 with session affinity", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now(), 15));
		const policySpy = vi.spyOn(runtimePolicy, "evaluateRuntimePolicy").mockResolvedValue({
			allowed: true, statusCode: 200, errorCode: null, reasons: [], projectKey: null,
			blockedAccountIndexes: new Set(Array.from({ length: 13 }, (_, i) => i + 2)),
			scoreBoostByAccount: {}, budgetEvaluations: [],
		});
		const limited = vi.spyOn(accountManager, "markRateLimitedWithReason");
		const { calls, fetchImpl } = createRecordingFetch((call, attempt) => {
			if (attempt === 3) return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429, headers: { "retry-after": "60" } });
			return call.url.includes("/images/")
				? new Response('{"data":[]}', { headers: { "content-type": "application/json" } })
				: textEventStream();
		});
		const proxy = await startProxy({ accountManager, fetchImpl });
		const headers = { "session_id": "image-text-rotation" };
		for (const [model, path] of [["gpt-5.6-sol", "/responses"], ["gpt-image-2", "/images/generations"], ["gpt-5.6-sol", "/responses"], ["gpt-5.6-luna", "/responses"]]) {
			const response = await postResponses(proxy, { model, stream: path === "/responses" }, path, headers);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(calls).toHaveLength(5);
		expect(limited).toHaveBeenCalled();
		expect(calls[2].headers.get("authorization")).not.toBe(calls[3].headers.get("authorization"));
		expect(calls[4].headers.get("authorization")).toBe(calls[3].headers.get("authorization"));
		policySpy.mockRestore();
	});
	it.each(["/images/generations", "/images/edits", "/v1/images/generations", "/v1/images/edits"])("forwards image route %s through managed OAuth without rewriting JSON", async (path) => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const payload = { model: "gpt-image-2", prompt: "test", images: [{ image_url: "data:image/png;base64,AA==" }], background: "auto" };
		const result = { created: 123, data: [{ b64_json: "aW1hZ2U=" }], model: "upstream-model" };
		const { calls, fetchImpl } = createRecordingFetch(() => new Response(JSON.stringify(result), { headers: { "content-type": "application/json", "x-codex-imagegen-request-id": "image-test-id" } }));
		const proxy = await startProxy({ accountManager, fetchImpl });
		const response = await postResponses(proxy, payload, path, { "cookie": "local-secret" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(result);
		expect(response.headers.get("x-codex-imagegen-request-id")).toBe("image-test-id");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`https://example.test/backend-api/codex${path.replace(/^\/v1/, "")}`);
		expect(calls[0].bodyText).toBe(JSON.stringify(payload));
		expect(calls[0].headers.get("authorization")).toMatch(/^Bearer access-/);
		expect(calls[0].headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toMatch(/^acc_/);
		expect(calls[0].headers.get("cookie")).toBeNull();
	});
	it.each([400, 403, 500])("does not replay image error %s", async (status) => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => new Response('{"error":{"code":"image_test_error"}}', { status, headers: { "content-type": "application/json" } }));
		const proxy = await startProxy({ accountManager, fetchImpl });
		const response = await postResponses(proxy, { model: "gpt-image-2" }, "/images/generations");
		expect(response.status).toBe(status);
		expect((await response.json()).error.code).toBe("image_test_error");
		expect(calls).toHaveLength(1);
	});
	it("does not replay an ambiguous image transport failure", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => { throw new Error("connection lost"); });
		const proxy = await startProxy({ accountManager, fetchImpl });
		const response = await postResponses(proxy, { model: "gpt-image-2" }, "/images/edits");
		expect(response.status).toBe(502);
		expect(calls).toHaveLength(1);
	});
	it("rotates images on an explicit quota rejection", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => attempt === 1 ? new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }) : new Response('{"data":[{"b64_json":"aW1hZ2U="}]}', { headers: { "content-type": "application/json" } }));
		const proxy = await startProxy({ accountManager, fetchImpl });
		const response = await postResponses(proxy, { model: "gpt-image-2" }, "/images/generations");
		expect(response.status).toBe(200);
		await response.text();
		expect(calls).toHaveLength(2);
		expect(calls[0].headers.get("authorization")).not.toBe(calls[1].headers.get("authorization"));
	});
	it("requires a bearer for image requests", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => new Response("unused"));
		const proxy = await startProxy({ accountManager, fetchImpl });
		for (const path of ["/images/generations", "/images/edits"]) {
			const response = await fetch(`${proxy.baseUrl}${path}`, { method: "POST", headers: {}, body: "{}" });
			expect(response.status).toBe(401);
			await response.text();
		}
		expect(calls).toHaveLength(0);
	});
	it("refreshes an expired managed OAuth token for image edits", async () => {
		const now = Date.now();
		const storage = createStorage(now, 1);
		storage.accounts[0].expiresAt = now - 60_000;
		refreshAccessTokenMock.mockResolvedValueOnce({ type: "success", access: "fresh-image-access", refresh: "refresh-1", expires: now + 3_600_000 });
		const accountManager = new AccountManager(undefined, storage);
		const { calls, fetchImpl } = createRecordingFetch(() => new Response('{"data":[]}', { headers: { "content-type": "application/json" } }));
		const proxy = await startProxy({ accountManager, fetchImpl });
		const response = await postResponses(proxy, { model: "gpt-image-2" }, "/images/edits");
		expect(response.status).toBe(200);
		await response.text();
		expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
		expect(calls[0].headers.get("authorization")).toBe("Bearer fresh-image-access");
	});
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
		expect(await accepted.text()).toBe("data: forwarded\n\n" + COMPLETED_FRAME);
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
		expect(await acceptedWithApiKey.text()).toBe("data: forwarded\n\n" + COMPLETED_FRAME);
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
					"Runtime rotation proxy only accepts Responses API, images, model discovery, and Codex thread goal requests.",
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
		expect(await response.text()).toBe("data: forwarded\n\n" + COMPLETED_FRAME);
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

	it("routes every request to the ephemeral forced account without rotating (#623)", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 3));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 2 },
		});
		const body = {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		};

		const first = await postResponses(proxy, body);
		const second = await postResponses(proxy, body);

		expect(first.status).toBe(HTTP_STATUS.OK);
		expect(second.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(2);
		// Both requests pinned to account 3 (index 2); no rotation to 1 or 2.
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-3");
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-3");
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_3");
		expect(proxy.getStatus()).toMatchObject({
			lastAccountIndex: 2,
			lastAccountId: "acc_3",
		});
	});

	it("retries a healthy forced pin after a zero-cooldown upstream 503", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			attempt === 1
				? new Response("upstream failed", {
						status: HTTP_STATUS.SERVICE_UNAVAILABLE,
					})
				: textEventStream("data: recovered\n\n"),
		);
		const previousServerErrorCooldown =
			process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
		process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS = "0";
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			if (previousServerErrorCooldown === undefined) {
				delete process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
			} else {
				process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS =
					previousServerErrorCooldown;
			}
		}

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
		expect(
			calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID)),
		).toEqual(["acc_1", "acc_1"]);
		expect(proxy.getStatus().retries).toBe(1);
	});

	it("bounds forced-pin transport retries by the configured attempt budget", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch(() => {
			throw new TypeError("fetch failed");
		});
		const previousNetworkErrorCooldown =
			process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS;
		const previousMaxRetries = process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
		process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS = "0";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "2";
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			if (previousNetworkErrorCooldown === undefined) {
				delete process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS;
			} else {
				process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS =
					previousNetworkErrorCooldown;
			}
			if (previousMaxRetries === undefined) {
				delete process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
			} else {
				process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = previousMaxRetries;
			}
		}

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});
		const payload = (await response.json()) as {
			error: { code: string; reason: string | null };
		};

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error).toMatchObject({
			code: "codex_pinned_account_unavailable",
			reason: "network-error",
		});
		expect(calls).toHaveLength(3);
		expect(
			calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID)),
		).toEqual(["acc_1", "acc_1", "acc_1"]);
	});

	it("caps forced-pin upstream attempts regardless of how high the pool retry knob goes", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch(() => {
			throw new TypeError("fetch failed");
		});
		const previousNetworkErrorCooldown =
			process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS;
		const previousMaxRetries = process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
		process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS = "0";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "20";
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			if (previousNetworkErrorCooldown === undefined) {
				delete process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS;
			} else {
				process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS =
					previousNetworkErrorCooldown;
			}
			if (previousMaxRetries === undefined) {
				delete process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
			} else {
				process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = previousMaxRetries;
			}
		}

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});
		const payload = (await response.json()) as {
			error: { code: string; reason: string | null };
		};

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error).toMatchObject({
			code: "codex_pinned_account_unavailable",
			reason: "network-error",
		});
		// `retryAllAccountsMaxRetries` is the "retry when every account is
		// rate-limited" POOL knob. For a pin each unit of it is another copy of
		// the same non-idempotent request to the same upstream, so it is capped
		// at MAX_PINNED_TRANSIENT_ATTEMPTS instead of being spent 1:1.
		expect(calls).toHaveLength(4);
		expect(
			new Set(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))),
		).toEqual(new Set(["acc_1"]));
	});

	it("retries a forced pin through the cooldown its own failure created", async () => {
		// Every transient branch cools the account down before continuing, and
		// chooseAccount refuses a cooling-down pin. With a REAL cooldown (the
		// shipped defaults are 4s/6s, not 0) the retry budget was unreachable and
		// a pin got exactly one upstream attempt -- the bug this whole change is
		// supposed to fix. Zeroing the cooldown, as the other tests here do,
		// bypasses the only thing that was blocking the retry, so this one uses
		// a deliberately huge 60s cooldown: the retry has to happen because a
		// pinned retry WAIVES its own cooldown, not because it outlasted one.
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt <= 2) throw new TypeError("fetch failed");
			return textEventStream("data: recovered\n\n");
		});
		const previousNetworkErrorCooldown =
			process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS;
		const previousMaxRetries = process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
		process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS = "30";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "2";
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			if (previousNetworkErrorCooldown === undefined) {
				delete process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS;
			} else {
				process.env.CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS =
					previousNetworkErrorCooldown;
			}
			if (previousMaxRetries === undefined) {
				delete process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
			} else {
				process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = previousMaxRetries;
			}
		}

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
		expect(calls).toHaveLength(3);
		expect(
			new Set(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))),
		).toEqual(new Set(["acc_1"]));
		// A pin re-attempts ONE account; none of that is a rotation.
		expect(proxy.getStatus().rotations).toBe(0);
		expect(proxy.getStatus().retries).toBe(2);
	});

	it("never credits the pool token bucket during a pinned failure storm", async () => {
		// A pin bypasses the bucket on the way in, so the refund sites must not
		// pay it back on the way out -- a refund without a matching consume mints
		// tokens the pool never issued, and every pinned failure would top the
		// bucket up for the unpinned requests sharing it.
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const pinned = accountManager.getAccountByIndex(0);
		if (!pinned) throw new Error("missing pinned account");
		const tokenTracker = getTokenTracker();
		const trackerKey = getRuntimeTrackerKey(pinned);
		const quotaKey = "codex:gpt-5-codex";
		const before = tokenTracker.getTokens(trackerKey, quotaKey);
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response("upstream failed", {
					status: HTTP_STATUS.SERVICE_UNAVAILABLE,
				}),
		);
		const previousServerErrorCooldown =
			process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
		process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS = "0";
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			if (previousServerErrorCooldown === undefined) {
				delete process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
			} else {
				process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS =
					previousServerErrorCooldown;
			}
		}

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls.length).toBeGreaterThan(1);
		expect(tokenTracker.getTokens(trackerKey, quotaKey)).toBe(before);
	});

	it("does not extend the pinned cooldown waiver to unpinned selection", async () => {
		// allowPinnedCooldown is set only on the pinned branch. An unpinned pool
		// must keep skipping a cooling-down account and rotate past it.
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const first = accountManager.getAccountByIndex(0);
		if (!first) throw new Error("missing account");
		accountManager.markAccountCoolingDown(first, 60_000, "server-error");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: ok\n\n"),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(
			calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID)),
		).toEqual(["acc_2"]);
	});

	it("still refuses a pin that arrives already cooling down from another request", async () => {
		// The waiver is scoped to the RETRY passes of one request. A pin that is
		// already cooling down when the request arrives must still 503 on the
		// spot, exactly as before -- otherwise the cooldown would stop protecting
		// the account from new traffic at all.
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const pinned = accountManager.getAccountByIndex(0);
		if (!pinned) throw new Error("missing pinned account");
		accountManager.markAccountCoolingDown(pinned, 60_000, "server-error");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: should-not-be-reached\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(0);
	});

	it("does not apply the pinned selection guard to an unpinned pool", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 17));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			attempt === 17
				? textEventStream("data: recovered\n\n")
				: new Response("upstream failed", {
						status: HTTP_STATUS.SERVICE_UNAVAILABLE,
					}),
		);
		const previousServerErrorCooldown =
			process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
		const previousMaxRetries = process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
		process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS = "0";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "16";
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		try {
			proxy = await startProxy({ accountManager, fetchImpl });
		} finally {
			if (previousServerErrorCooldown === undefined) {
				delete process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
			} else {
				process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS =
					previousServerErrorCooldown;
			}
			if (previousMaxRetries === undefined) {
				delete process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
			} else {
				process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = previousMaxRetries;
			}
		}

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
		expect(calls).toHaveLength(17);
		expect(
			new Set(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).size,
		).toBe(17);
	});

	it("reports the final server error at the forced-pin budget boundary", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response("upstream failed", {
					status: HTTP_STATUS.SERVICE_UNAVAILABLE,
				}),
		);
		const previousServerErrorCooldown =
			process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
		const previousMaxRetries = process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
		process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS = "0";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "1";
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			if (previousServerErrorCooldown === undefined) {
				delete process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
			} else {
				process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS =
					previousServerErrorCooldown;
			}
			if (previousMaxRetries === undefined) {
				delete process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES;
			} else {
				process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = previousMaxRetries;
			}
		}

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});
		const payload = (await response.json()) as {
			error: {
				code: string;
				message: string;
				reason: string | null;
				account_skip_reasons: Record<string, string>;
			};
		};

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error).toMatchObject({
			code: "codex_pinned_account_unavailable",
			reason: "server-error",
			account_skip_reasons: { "0": "server-error" },
		});
		expect(payload.error.message).toContain("(upstream server error)");
		expect(payload.error.message).not.toContain("(server-error)");
		expect(calls).toHaveLength(2);
	});

	it("ends a forced-pin loop immediately when nothing in it can change the verdict", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const consumeTokenSpy = vi
			.spyOn(accountManager, "consumeTokenWithReason")
			.mockReturnValue({ ok: false, reason: "circuit-open" });
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: should-not-be-reached\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});
		const payload = (await response.json()) as {
			error: { code: string; reason: string | null };
		};

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error).toMatchObject({
			code: "codex_pinned_account_unavailable",
			// The pool bucket is bypassed for a pin, so circuit admission is the
			// only gate consumeTokenWithReason can reject on, and the reported
			// reason is the gate that actually rejected.
			reason: "circuit-open",
		});
		// Neither gate can change inside the loop and a pin cannot move to
		// another account, so re-selecting only re-derives the same answer. This
		// used to spend all 16 ceiling iterations to return the same 503.
		expect(consumeTokenSpy).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(0);
	});
	it("does not let the pool token bucket starve a forced pin", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const pinnedAccount = accountManager.getAccountByIndex(0);
		if (!pinnedAccount) throw new Error("expected pinned account");
		const tokenTracker = getTokenTracker();
		const trackerKey = getRuntimeTrackerKey(pinnedAccount);
		const quotaKey = "codex:gpt-5-codex";
		tokenTracker.drain(
			trackerKey,
			quotaKey,
			DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
		);
		const tryConsumeSpy = vi.spyOn(tokenTracker, "tryConsume");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: pinned\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		try {
			const response = await postResponses(proxy, {
				model: "gpt-5-codex",
				stream: true,
				input: [{ type: "message", role: "user", content: "hi" }],
			});

			expect(response.status).toBe(HTTP_STATUS.OK);
			expect(await response.text()).toBe("data: pinned\n\n" + COMPLETED_FRAME);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
			// A pinned request neither consumes nor refills the pool-scoring bucket.
			expect(tryConsumeSpy).not.toHaveBeenCalled();
			expect(tokenTracker.getTokens(trackerKey, quotaKey)).toBeLessThan(1);
		} finally {
			tryConsumeSpy.mockRestore();
		}
	});

	it("fails hard (503, no upstream call) when the forced account is unavailable (#623)", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: should-not-be-reached\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			// Out of range for a 2-account pool: the pin is deterministic, so this
			// must fail rather than spill onto a different account.
			options: { forcedAccountIndex: 5 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		// The whole point of --account: it never rotates to another account.
		expect(calls).toHaveLength(0);
	});

	it("carries pin source and recovery metadata when the forced account 429s directly", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response('{"error":{"message":"rate limited"}}', {
					status: HTTP_STATUS.TOO_MANY_REQUESTS,
					headers: {
						"content-type": "application/json",
						"retry-after": "120",
					},
				}),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		// The 429 creates a real blocker, so the pin stops after one upstream
		// attempt rather than rotating or spending retries against the same limit.
		expect(calls).toHaveLength(1);
		const payload = (await response.json()) as {
			error: {
				code: string;
				pin_source: string | null;
				reason: string | null;
				reset_at: string | null;
				retry_after_ms: number | null;
				message: string;
			};
		};
		expect(payload.error.code).toBe("codex_pinned_account_unavailable");
		expect(payload.error.pin_source).toBe("forced");
		// Re-selection reports the live blocker instead of masking it with
		// attempted-index bookkeeping.
		expect(payload.error.reason).toBe("rate-limited");
		expect(payload.error.retry_after_ms).toBeGreaterThan(0);
		expect(Date.parse(payload.error.reset_at ?? "")).toBeGreaterThan(now);
		// The human sentence and machine-readable reason now agree on the 429's
		// live blocker and its persisted recovery deadline.
		expect(payload.error.message).toContain("(rate-limited)");
		expect(payload.error.message).toContain("the rate limit resets at");
		expect(payload.error.message).not.toContain("already-attempted");
		expect(payload.error.message).toContain("launcher");
		expect(payload.error.message).not.toContain("unpin");
	});

	it("carries cooldown recovery metadata when the forced account fails with a network error", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const recordFailureSpy = vi.spyOn(accountManager, "recordFailure");
		const { calls, fetchImpl } = createRecordingFetch(() => {
			throw new TypeError("fetch failed");
		});
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		// A pin has no other account to fall back to, so it spends its bounded
		// retry budget (MAX_PINNED_TRANSIENT_ATTEMPTS) before giving up. It used
		// to stop after one attempt only because its own cooldown blocked
		// re-selection.
		expect(calls).toHaveLength(4);
		const payload = (await response.json()) as {
			error: {
				code: string;
				pin_source: string | null;
				reset_at: string | null;
				retry_after_ms: number | null;
			};
		};
		// A transport failure must not cost a pinned request its recovery
		// contract. The pin is still the only selectable account, so the caller
		// needs pin_source/reset_at here, not a generic "pool exhausted" that
		// claims every account is unavailable while the rest are healthy.
		expect(payload.error.code).toBe("codex_pinned_account_unavailable");
		expect(payload.error.pin_source).toBe("forced");
		// The network-error cooldown bounds recovery.
		expect(payload.error.retry_after_ms).toBeGreaterThan(0);
		expect(Date.parse(payload.error.reset_at ?? "")).toBeGreaterThan(now);
		// ...but the broken network path is not the account's fault, so nothing
		// credits its circuit breaker or health tracker (#677).
		expect(recordFailureSpy).not.toHaveBeenCalled();
	});

	it("suppresses recovery when this request itself disables the pinned account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		// Two upstream 5xx responses record breaker failures without disabling;
		// the third response is a workspace-disabled 403, which records the
		// failure that opens the breaker AND calls setAccountEnabled(index, false).
		// Selection on the next pass reports the permanent disable. The 503 must
		// refuse to advertise the circuit's ~30s reset for an account no timer
		// will re-admit.
		//
		// The first two failures are 5xx rather than transport exceptions on
		// purpose: a transport exception deliberately does not credit the
		// breaker (#677), so it could never open the circuit this guard exists
		// to suppress, and the assertion below would pass vacuously.
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt < 3) {
				return new Response("upstream failed", {
					status: HTTP_STATUS.SERVICE_UNAVAILABLE,
				});
			}
			return new Response(
				JSON.stringify({
					error: { code: "workspace_disabled", message: "workspace has been disabled" },
				}),
				{ status: HTTP_STATUS.FORBIDDEN, headers: { "content-type": "application/json" } },
			);
		});
		// Zero the server-error cooldown so every request reaches upstream and
		// records a breaker failure; otherwise the cooldown absorbs the retries
		// and the breaker never opens.
		// Restored in a finally: if startProxy rejects, an inline unstub never
		// runs and the zero cooldown leaks into every later test in this file —
		// the shared afterEach does not clear env stubs. Scoped to the one
		// variable rather than vi.unstubAllEnvs(), which would also clear stubs
		// an enclosing hook set.
		const previousServerErrorCooldown =
			process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		vi.stubEnv("CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS", "0");
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			vi.stubEnv(
				"CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS",
				previousServerErrorCooldown,
			);
		}
		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});
		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		// The first two 5xx responses and the disabling 403 all happen inside
		// this request's bounded pin-retry budget.
		expect(calls).toHaveLength(3);
		expect(accountManager.getAccountByIndex(0)?.enabled).toBe(false);

		const payload = (await response.json()) as {
			error: {
				code: string;
				pin_source: string | null;
				reset_at: string | null;
				retry_after_ms: number | null;
			};
		};
		expect(payload.error.code).toBe("codex_pinned_account_unavailable");
		expect(payload.error.pin_source).toBe("forced");
		// The account is disabled for good; no timer clears that.
		expect(payload.error.reset_at).toBeNull();
		expect(payload.error.retry_after_ms).toBeNull();
	});

	it("advertises the circuit deadline after repeated pinned-account 5xx responses", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response("upstream failed", { status: HTTP_STATUS.SERVICE_UNAVAILABLE }),
		);
		const previousServerErrorCooldown =
			process.env.CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS;
		let proxy: Awaited<ReturnType<typeof startProxy>>;
		vi.stubEnv("CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS", "0");
		try {
			proxy = await startProxy({
				accountManager,
				fetchImpl,
				options: { forcedAccountIndex: 0 },
			});
		} finally {
			vi.stubEnv(
				"CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS",
				previousServerErrorCooldown,
			);
		}
		const body = {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		};

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const failed = await postResponses(proxy, body);
			expect(failed.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		}
		expect(calls).toHaveLength(3);

		const response = await postResponses(proxy, body);
		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(3);
		const payload = (await response.json()) as {
			error: {
				code: string;
				retry_after_ms: number | null;
				reset_at: string | null;
			};
		};
		expect(payload.error.code).toBe("codex_pinned_account_unavailable");
		expect(payload.error.retry_after_ms).toBeGreaterThan(10_000);
		expect(payload.error.retry_after_ms).toBeLessThanOrEqual(30_000);
		expect(Date.parse(payload.error.reset_at ?? "")).toBeGreaterThan(now);
	});

	it("does not word a later cooldown deadline as the rate-limit reset (#675)", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const pinned = accountManager.getAccountByIndex(0);
		if (!pinned) throw new Error("setup failed");
		// Both records gate the account. Selection reports "rate-limited" by
		// precedence, but recovery is bounded by whichever record ends last —
		// here a server-error cooldown that outlives the limit by 50s. The
		// sentence must not attribute that later timestamp to the rate limit.
		// The record is keyed by the requested model's family (retired
		// "gpt-5-codex" runs on gpt-5.6-sol, family "gpt-5.2", not "codex"), or
		// it would not gate at all.
		pinned.rateLimitResetTimes = { "gpt-5.2": now + 10_000 };
		pinned.coolingDownUntil = now + 60_000;
		pinned.cooldownReason = "server-error";
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: should-not-be-reached\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(0);
		const payload = (await response.json()) as {
			error: {
				code: string;
				reason: string | null;
				reset_at: string | null;
				retry_after_ms: number | null;
				message: string;
			};
		};
		expect(payload.error.code).toBe("codex_pinned_account_unavailable");
		expect(payload.error.reason).toBe("rate-limited");
		// The machine contract still advertises the full recovery bound: the
		// cooldown's end, not the limit's earlier reset.
		expect(payload.error.retry_after_ms).toBeGreaterThan(10_000);
		expect(payload.error.retry_after_ms).toBeLessThanOrEqual(60_000);
		expect(Date.parse(payload.error.reset_at ?? "")).toBeGreaterThan(
			now + 10_000,
		);
		// The sentence names the blocker but keeps the deadline neutral.
		expect(payload.error.message).toContain("(rate-limited)");
		expect(payload.error.message).toContain(
			"the account is expected to be available again at",
		);
		expect(payload.error.message).not.toContain("limit resets");
	});

	it("suppresses timed recovery when a permanent blocker holds the pinned account", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		const pinned = accountManager.getAccountByIndex(0);
		if (!pinned) throw new Error("setup failed");
		// Disabled outlives the record: after the rate limit expires the
		// account is still unselectable, so no recovery time is honest.
		pinned.enabled = false;
		pinned.rateLimitResetTimes = { codex: now + 60_000 };
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: should-not-be-reached\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(0);
		const payload = (await response.json()) as {
			error: {
				code: string;
				reason: string | null;
				reset_at: string | null;
				retry_after_ms: number | null;
				message: string;
			};
		};
		expect(payload.error.code).toBe("codex_pinned_account_unavailable");
		expect(payload.error.reason).toBe("disabled");
		expect(payload.error.reset_at).toBeNull();
		expect(payload.error.retry_after_ms).toBeNull();
		expect(payload.error.message).not.toContain("resets at");
	});

	it("reads the forced account from CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX env when no option is passed (#623)", async () => {
		// This is the exact mechanism the pin uses to cross the launcher -> detached
		// app-helper process boundary: no option, env only.
		process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX = "2";
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 3));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n"),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-3");
		expect(proxy.getStatus()).toMatchObject({ lastAccountIndex: 2 });
	});

	it("prefers an explicit forcedAccountIndex option over the env value (#623)", async () => {
		process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX = "2";
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 3));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			textEventStream("data: forwarded\n\n"),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { forcedAccountIndex: 0 },
		});

		const response = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
		});

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		// Option index 0 wins over env index 2; also proves index 0 is honored.
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(proxy.getStatus()).toMatchObject({ lastAccountIndex: 0 });
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

	it("keeps the thread goal fallback when a transport failure exhausts the pool", async () => {
		const now = Date.UTC(2099, 0, 1);
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch(() => {
			throw new TypeError("fetch failed");
		});
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postThreadGoal(proxy, { threadId: "thread-1" });
		const payload = (await response.json()) as { goal: string | null };

		// v2.1.5 contract: thread/goal/get answers recoverable upstream failures
		// with { goal: null } so the Codex TUI does not surface a noisy
		// goal-read error. A transport failure is recoverable, and the all-5xx
		// exhaustion path in the same block already answers this way.
		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(payload.goal).toBeNull();
		// Both accounts are tried before the pool is declared exhausted.
		expect(calls).toHaveLength(2);
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
		// 513 sequential loopback round-trips are inherently slow; the default 5s
		// timeout is too tight on slower machines (e.g. Windows dev checkouts).
	}, 30_000);

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
				firstAccount.rateLimitResetTimes = { "gpt-5.2": now + 60_000 };
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
			expect(await response.text()).toBe("data: served\n\n" + COMPLETED_FRAME);
			await accountManager.flushPendingSave();
			expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_2");
			expect(persisted.at(-1)).toMatchObject({
				activeIndex: 0,
				activeIndexByFamily: { codex: 0, "gpt-5.2": 1 },
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
			accountManager.getAccountByIndex(0)?.rateLimitResetTimes["gpt-5.2"],
		).toBeTypeOf("number");
	});

	it("uses the preemptive scheduler fallback when exhaustion has no reset header", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			textEventStream(`data: attempt-${attempt}\n\n`, {
				"x-codex-primary-used-percent": attempt === 1 ? "100" : "10",
			}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		await (await postResponses(proxy, { model: "gpt-5-codex", stream: true })).text();
		await (await postResponses(proxy, { model: "gpt-5-codex", stream: true })).text();

		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
		]);
		expect(
			(accountManager.getAccountByIndex(0)?.rateLimitResetTimes["gpt-5.2"] ?? 0) -
				Date.now(),
		).toBeGreaterThan(60 * 60 * 1_000);
	});

	it("keeps quota snapshots attached to account identity across index changes", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = Date.now();
		const originalAccount = {
			accountId: "stable-account",
			email: "stable@example.com",
			refreshToken: "refresh-stable",
		};
		const reorderedAccount = { ...originalAccount };
		const replacementAccount = {
			accountId: "different-account",
			email: "different@example.com",
			refreshToken: "refresh-different",
		};
		const originalKey = buildQuotaScheduleKey(
			originalAccount,
			"codex",
			"gpt-5-codex",
		);
		scheduler.update(originalKey, {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: now + 60 * 60_000 },
			secondary: {},
			updatedAt: now,
		});

		expect(
			buildQuotaScheduleKey(reorderedAccount, "codex", "gpt-5-codex"),
		).toBe(originalKey);
		expect(
			scheduler.getDeferral(
				buildQuotaScheduleKey(reorderedAccount, "codex", "gpt-5-codex"),
				now,
			),
		).toMatchObject({ defer: true, reason: "quota-near-exhaustion" });
		expect(
			scheduler.getDeferral(
				buildQuotaScheduleKey(replacementAccount, "codex", "gpt-5-codex"),
				now,
			),
		).toEqual({ defer: false, waitMs: 0 });
	});

	it("keeps quota identity stable when an account gains an account id", () => {
		const beforeRefresh = {
			email: "  User@Example.com ",
			refreshToken: "refresh-before",
		};
		const afterRefresh = {
			email: "user@example.com",
			accountId: "account-id-after-refresh",
			refreshToken: "refresh-after",
		};

		expect(
			buildQuotaScheduleKey(beforeRefresh, "codex", "gpt-5-codex"),
		).toBe(buildQuotaScheduleKey(afterRefresh, "codex", "gpt-5-codex"));
	});

	it("does not merge quota identity for distinct emails sharing an account id", () => {
		const first = {
			email: "first@example.com",
			accountId: "shared-account-id",
			refreshToken: "refresh-first",
		};
		const second = {
			email: "second@example.com",
			accountId: "shared-account-id",
			refreshToken: "refresh-second",
		};

		expect(buildQuotaScheduleKey(first, "codex", "gpt-5-codex")).not.toBe(
			buildQuotaScheduleKey(second, "codex", "gpt-5-codex"),
		);
	});

	it("does not merge quota identity for distinct accounts sharing a normalized email", () => {
		const first = {
			email: "Shared@example.com",
			accountId: "account-one",
			refreshToken: "refresh-one",
			addedAt: 1_000,
			recordId: "record-one",
		};
		const second = {
			email: " shared@example.com ",
			accountId: "account-two",
			refreshToken: "refresh-two",
			addedAt: 1_000,
			recordId: "record-two",
		};
		const firstKey = buildQuotaScheduleKey(first, "codex", "gpt-5-codex");
		const secondKey = buildQuotaScheduleKey(second, "codex", "gpt-5-codex");
		const scheduler = new PreemptiveQuotaScheduler();

		scheduler.update(firstKey, {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: Date.now() + 60 * 60_000 },
			secondary: {},
			updatedAt: Date.now(),
		});

		expect(firstKey).not.toBe(secondKey);
		expect(scheduler.getDeferral(secondKey, Date.now())).toEqual({
			defer: false,
			waitMs: 0,
		});
	});

	it("derives distinct stable quota record ids for same-email records", () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "shared@example.com",
					accountId: "same-account-id",
					refreshToken: "refresh-one",
					addedAt: now,
					lastUsed: now,
				},
				{
					email: "SHARED@example.com",
					accountId: "same-account-id",
					refreshToken: "refresh-two",
					addedAt: now,
					lastUsed: now,
				},
			],
		});
		const first = accountManager.getAccountByIndex(0);
		const second = accountManager.getAccountByIndex(1);

		expect(first?.recordId).toBeTypeOf("string");
		expect(first?.recordId).not.toBe(second?.recordId);
		expect(
			first && second
				? buildQuotaScheduleKey(first, "codex", "gpt-5-codex")
				: null,
		).not.toBe(
			first && second
				? buildQuotaScheduleKey(second, "codex", "gpt-5-codex")
				: null,
		);
	});

	it("normalizes email casing and whitespace in quota identity keys", () => {
		expect(
			buildQuotaScheduleKey(
				{ email: "  MixedCase@Example.COM  ", refreshToken: "refresh-a" },
				"codex",
				"gpt-5-codex",
			),
		).toBe(
			buildQuotaScheduleKey(
				{ email: "mixedcase@example.com", refreshToken: "refresh-b" },
				"codex",
				"gpt-5-codex",
			),
		);
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
		expect(await response.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
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
		expect(await first.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
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
		expect(await response.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
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
		expect(reloadedStorage?.accounts[0]?.rateLimitResetTimes["gpt-5.2"]).toBeTypeOf(
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
		const recordFailureSpy = vi.spyOn(accountManager, "recordFailure");
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
		expect(await response.text()).toBe("data: third\n\n" + COMPLETED_FRAME);
		expect(calls.map((call) => call.headers.get(OPENAI_HEADERS.ACCOUNT_ID))).toEqual([
			"acc_1",
			"acc_2",
			"acc_3",
		]);
		expect(accountManager.getAccountByIndex(0)?.cooldownReason).toBe("server-error");
		expect(accountManager.getAccountByIndex(1)?.cooldownReason).toBe("network-error");
		expect(saveToDiskDebouncedSpy).toHaveBeenCalled();
		// The 5xx is the account's own failure and credits its breaker. The
		// transport failure on acc_2 is a property of the network path, so it
		// cools that account down without crediting anything (#677).
		expect(recordFailureSpy.mock.calls.map((call) => call[0].index)).toEqual([0]);
	});

	it("persists the cooldown when an account has no resolvable accountId", async () => {
		const now = Date.now();
		// Account with no stored accountId and a non-JWT access token, so
		// resolveAccountId returns null and the missing-accountId cooldown branch
		// fires. The cooldown must be persisted like every other cooldown branch
		// so a restart inside the window honors it (regression: this branch used
		// to mutate cooldown state without scheduling a disk write).
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "no-id@example.com",
					refreshToken: "refresh-1",
					accessToken: "plain-access-not-a-jwt",
					expiresAt: now + 3_600_000,
					addedAt: now - 60_000,
					lastUsed: now - 60_000,
					enabled: true,
				},
			],
		};
		const accountManager = new AccountManager(undefined, storage);
		expect(accountManager.getAccountByIndex(0)?.accountId).toBeUndefined();
		const saveToDiskDebouncedSpy = vi.spyOn(accountManager, "saveToDiskDebounced");
		const { calls, fetchImpl } = createRecordingFetch(() => textEventStream());
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		await response.text();

		// No upstream request is issued — the account is cooled down before send,
		// exhausting the single-account pool.
		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(0);
		expect(accountManager.getAccountByIndex(0)?.cooldownReason).toBe("auth-failure");
		expect(accountManager.getAccountByIndex(0)?.coolingDownUntil).toBeGreaterThan(now);
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
		// With every account cooling down, the proxy now *attempts* stale-runtime
		// recovery (issue #606): cooling-down is transient and no longer suppresses
		// the reload. Force that reload to fail so this test still exercises the
		// final-exhaustion path and its skip-reason reporting deterministically.
		const loadSpy = vi
			.spyOn(AccountManager, "loadFromDisk")
			.mockRejectedValue(new Error("reload unavailable"));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response("should not be called", { status: HTTP_STATUS.OK }),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		try {
			const response = await postResponses(proxy, { model: "gpt-5-codex" });
			const payload = (await response.json()) as {
				error: {
					code: string;
					reason: string;
					account_skip_reasons: Record<string, string>;
					hint: string;
				};
			};

			expect(loadSpy).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
			expect(payload.error.code).toBe("codex_runtime_rotation_pool_exhausted");
			expect(payload.error.reason).toBe("no-account");
			expect(payload.error.account_skip_reasons).toMatchObject({
				"0": "cooling-down:network-error",
				"1": "cooling-down:server-error",
			});
			expect(payload.error.hint).toContain("rotation reset-runtime");
			expect(calls).toHaveLength(0);
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("recovers from an all-cooling-down pool by reloading and clearing transient state (issue #606)", async () => {
		const now = Date.now();
		// Persisted cooldown/rate-limit state survives a reload, so the reloaded
		// pool carries the same wedged transient state. recoverStaleRuntimeState
		// must clear it before the manager is used, otherwise selection deadlocks
		// against the very recovery meant to escape it.
		const staleStorage = createStorage(now, 2);
		for (const account of staleStorage.accounts) {
			account.coolingDownUntil = now + 60_000;
			account.cooldownReason = "server-error";
			account.rateLimitResetTimes = { codex: now + 60_000 };
		}
		const staleManager = new AccountManager(undefined, staleStorage);
		const reloadedStorage = createStorage(now, 2);
		for (const account of reloadedStorage.accounts) {
			account.coolingDownUntil = now + 60_000;
			account.cooldownReason = "server-error";
			account.rateLimitResetTimes = { codex: now + 60_000 };
		}
		const reloadedManager = new AccountManager(undefined, reloadedStorage);
		const clearSpy = vi.spyOn(reloadedManager, "clearAccountTransientState");
		const flushSpy = vi
			.spyOn(reloadedManager, "flushPendingSave")
			.mockResolvedValue();
		const loadSpy = vi
			.spyOn(AccountManager, "loadFromDisk")
			.mockResolvedValueOnce(reloadedManager);
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
			expect(clearSpy).toHaveBeenCalledTimes(1);
			// The cleared snapshot is flushed to disk synchronously so a restart
			// inside the debounce window cannot reload the wedged state.
			expect(flushSpy).toHaveBeenCalledTimes(1);
			// After clearing, the reloaded accounts are selectable again.
			expect(reloadedManager.getAccountByIndex(0)?.coolingDownUntil).toBeUndefined();
			expect(reloadedManager.getAccountByIndex(0)?.rateLimitResetTimes).toEqual({});
			expect(calls).toHaveLength(1);
		} finally {
			loadSpy.mockRestore();
			resetSpy.mockRestore();
			clearSpy.mockRestore();
			flushSpy.mockRestore();
		}
	});

	it("does not attempt stale-runtime recovery when accounts are policy-blocked (issue #606)", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		// A policy decision is external and will not change across a disk reload,
		// so a policy-blocked pool must continue to suppress stale-runtime
		// recovery. `allowed` stays true so the request proceeds into account
		// selection, where every account is rejected as policy-blocked and
		// selection returns null. Recovery is then gated off by the guard's
		// `blockedAccountIndexes.size === 0` precondition — the path that keeps a
		// policy block from being papered over by a reload.
		const policySpy = vi
			.spyOn(runtimePolicy, "evaluateRuntimePolicy")
			.mockResolvedValue({
				allowed: true,
				statusCode: 200,
				errorCode: null,
				reasons: [],
				projectKey: null,
				blockedAccountIndexes: new Set<number>([0, 1]),
				scoreBoostByAccount: {},
				budgetEvaluations: [],
			});
		const loadSpy = vi.spyOn(AccountManager, "loadFromDisk");
		const { calls, fetchImpl } = createRecordingFetch(() => textEventStream());
		try {
			const proxy = await startProxy({ accountManager, fetchImpl });

			const response = await postResponses(proxy, { model: "gpt-5-codex" });
			const payload = (await response.json()) as {
				error: { code: string; account_skip_reasons: Record<string, string> };
			};

			expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
			expect(payload.error.code).toBe("codex_runtime_rotation_pool_exhausted");
			expect(payload.error.account_skip_reasons).toMatchObject({
				"0": "policy-blocked",
				"1": "policy-blocked",
			});
			// Recovery must be suppressed: loadFromDisk is never called.
			expect(loadSpy).not.toHaveBeenCalled();
			expect(calls).toHaveLength(0);
		} finally {
			policySpy.mockRestore();
			loadSpy.mockRestore();
		}
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
		const recordFailureSpy = vi.spyOn(accountManager, "recordFailure");
		const { calls, fetchImpl } = createRecordingFetch(
			() => new Promise<Response>(() => undefined),
		);
		const proxy = await startProxy({
			accountManager,
			fetchImpl,
			options: { fetchTimeoutMs: 10 },
		});

		const response = await postResponses(proxy, { model: "gpt-5-codex" });
		const payload = (await response.json()) as {
			error: { reason: string; retry_after_ms: number };
		};

		expect(response.status).toBe(503);
		expect(payload.error.reason).toBe("network-error");
		expect(calls).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)?.cooldownReason).toBe(
			"network-error",
		);
		// The cooldown is also what keeps the advisory backoff meaningful:
		// getMinWaitTimeForFamily short-circuits to 0 while any account is still
		// selectable, so a client honoring retry_after_ms would otherwise
		// hot-loop against the dead network path.
		expect(payload.error.retry_after_ms).toBeGreaterThan(0);
		// The hung network path is still not the account's fault (#677).
		expect(recordFailureSpy).not.toHaveBeenCalled();
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
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "token_invalidated",
		});
		// token invalidation applies the long cooldown (~5min), not the generic 30s
		const coolingDownUntil = accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(coolingDownUntil).toBeGreaterThan(now + 250_000);
		expect(coolingDownUntil).toBeLessThan(now + 350_000);
		expect(proxy.getStatus().rotations).toBe(0);
	});

	it("persists a distinct upstream invalidation code from a 401 body", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 2));
		let persistedStorage: AccountStorageV3 | null = null;
		withAccountStorageTransactionMock.mockImplementationOnce(
			async (
				handler: (
					current: AccountStorageV3 | null,
					persist: (storage: AccountStorageV3) => Promise<void>,
				) => Promise<unknown>,
			) => {
				await handler(null, async (storage) => {
					persistedStorage = structuredClone(storage);
				});
			},
		);
		const invalidationBody = JSON.stringify({
			error: {
				code: "oauth_token_revoked",
				message: "The OAuth token has been invalidated by the provider.",
			},
		});
		const { calls, fetchImpl } = createRecordingFetch(
			() =>
				new Response(invalidationBody, {
					status: HTTP_STATUS.UNAUTHORIZED,
					headers: { "content-type": "application/json" },
				}),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex" });

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(calls).toHaveLength(1);
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "oauth_token_revoked",
		});
		expect(persistedStorage).not.toBeNull();
		const reloadedManager = new AccountManager(undefined, persistedStorage);
		expect(reloadedManager.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "oauth_token_revoked",
		});
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
		expect(await response.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
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
		expect(await response.text()).toBe("data: recovered\n\n" + COMPLETED_FRAME);
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
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "token_invalidated",
		});
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

	it("records upstream token usage so the cost and token budget caps can fire", async () => {
		const now = Date.now();
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const recorded: Record<string, unknown>[] = [];
		vi.spyOn(runtimePolicy, "createRuntimeUsageRecorder").mockImplementation(
			() => ({
				hasRecorded: () => recorded.length > 0,
				record: async (input) => {
					recorded.push(input as unknown as Record<string, unknown>);
				},
			}),
		);
		const { fetchImpl } = createRecordingFetch(() =>
			textEventStream(
				'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
					'data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":400},"output_tokens":500,"output_tokens_details":{"reasoning_tokens":200},"total_tokens":1500}}}\n\n',
			),
		);
		const proxy = await startProxy({ accountManager, fetchImpl });

		const response = await postResponses(proxy, { model: "gpt-5-codex", stream: true });
		expect(response.status).toBe(HTTP_STATUS.OK);
		await response.text();

		// Every ledger row used to land with all-zero tokens, so
		// evaluateBudgetGuard compared `0 >= limit` for maxTokens/maxCostUsd and
		// those caps never fired — only --requests was enforced.
		expect(recorded.at(-1)).toMatchObject({
			outcome: "success",
			inputTokens: 1000,
			// reasoning_tokens is a SUBSET of output_tokens upstream, but pricing
			// treats the two buckets as disjoint, so it is subtracted out here.
			outputTokens: 300,
			cachedInputTokens: 400,
			reasoningTokens: 200,
			totalTokens: 1500,
		});
	});
});

describe("native OpenAI catalog routing", () => {
	it("rechecks workspace disablement after catalog I/O before dispatch",async()=>{
		const disk=createStorage(Date.now());disk.accounts=disk.accounts.slice(0,1);
		disk.accounts[0]!.workspaces=[{id:"acc_1",enabled:true}];
		const manager=new AccountManager(undefined,structuredClone(disk));
		const {calls,fetchImpl}=createRecordingFetch(call=>{
			if(call.url.includes("/models")){disk.accounts[0]!.workspaces![0]!.enabled=false;return Response.json({models:[{slug:"shared"}]});}
			return textEventStream();
		});
		const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(disk)}});
		const response=await postResponses(proxy,{model:"shared",input:"hello"});
		expect(response.status).toBe(503);await response.text();
		expect(calls.some(call=>call.url.endsWith("/responses"))).toBe(false);
	});
	it.each(["response.created", "response.failed"])("does not reward an unsuccessful %s stream",async type=>{
		const manager=new AccountManager(undefined,createStorage(Date.now()));const success=vi.spyOn(manager,"recordSuccess");
		const {fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"shared"}]}):new Response(`data: ${JSON.stringify({type,response:{id:"fixture-response"}})}\n\n`,{headers:{"content-type":"text/event-stream"}}));
		const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,forcedAccountIndex:0}});
		const response=await postResponses(proxy,{model:"shared",input:"hello",stream:true});const text=await response.text();
		expect(success).not.toHaveBeenCalled();
		if(type==="response.created")expect(text).toContain("upstream_missing_terminal");
	});
	it("treats an incomplete stream as delivered for account health",async()=>{
		const manager=new AccountManager(undefined,createStorage(Date.now()));const success=vi.spyOn(manager,"recordSuccess");const failure=vi.spyOn(manager,"recordFailure");
		const {fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"shared"}]}):new Response(`data: ${JSON.stringify({type:"response.incomplete",response:{id:"fixture-response",incomplete_details:{reason:"max_output_tokens"}}})}\n\n`,{headers:{"content-type":"text/event-stream"}}));
		const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,forcedAccountIndex:0}});
		const response=await postResponses(proxy,{model:"shared",input:"hello",stream:true});const text=await response.text();
		expect(text).toContain("response.incomplete");expect(text).not.toContain("upstream_response_incomplete");
		expect(success).toHaveBeenCalledTimes(1);expect(failure).not.toHaveBeenCalled();
		expect(proxy.getStatus().lastError).toBeNull();
	});
	it("authenticates managed OAuth and unions account catalogs without returning credentials", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { fetchImpl } = createRecordingFetch(call => Response.json({ models: [{ slug: call.headers.get("chatgpt-account-id") === "acc_1" ? "model-a" : "model-b", visibility: "list" }] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true } });
		const response = await fetch(`${proxy.baseUrl}/models?client_version=0.156.0`, { headers: { authorization: "Bearer access-1" } });
		expect(response.status).toBe(200);
		const text = await response.text(); expect(text).not.toContain("access-");
		expect(JSON.parse(text).models.map((m: { slug: string }) => m.slug)).toEqual(["model-a", "model-b"]);
	});
	it("does not authenticate unknown or disabled OAuth tokens", async () => {
		const storage = createStorage(Date.now()); storage.accounts[0]!.enabled = false;
		const accountManager = new AccountManager(undefined, storage);
		const { calls, fetchImpl } = createRecordingFetch(() => Response.json({ models: [] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true } });
		for (const token of ["unknown", "access-1"]) { const r = await fetch(`${proxy.baseUrl}/models`, { headers: { authorization: `Bearer ${token}` } }); expect(r.status).toBe(401); await r.text(); }
		expect(calls).toHaveLength(0);
	});
	it("honors a pin for catalog discovery and refuses unsupported pinned models", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => Response.json({ models: [{ slug: "supported" }] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, forcedAccountIndex: 0 } });
		const response = await postResponses(proxy, { model: "not-supported", input: "hello" });
		expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("model_not_available_in_account_catalog");
		expect(calls.every(c => c.url.includes("/models"))).toBe(true);
	});
});

describe("reference account catalog", () => {
	it("prioritizes reference metadata but unions all catalogs independently of the inference pin", async () => {
		let now = Date.now(); let models = [{ slug: "model-a", supported_reasoning_levels: [{ effort: "high" }] }];
		const storage = createStorage(now); const reference = storage.accounts[0]!;
		const accountManager = new AccountManager(undefined, storage);
		const { calls, fetchImpl } = createRecordingFetch(call => Response.json({ models: call.headers.get("chatgpt-account-id") === "acc_1" ? models : [{ slug: "model-b" }] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, forcedAccountIndex: 1, now: () => now, catalogAccount: { email: reference.email!, accountId: reference.accountId! } } });
		const read = async (force = false) => { const r = await fetch(`${proxy.baseUrl}/models${force ? "?refresh_capabilities=1" : ""}`, { headers: { authorization: "Bearer access-1" } }); expect(r.status).toBe(200); return r.json(); };
		expect((await read()).models).toEqual([...models, { slug: "model-b" }]);
		models = [...models, { slug: "new-model", supported_reasoning_levels: [] }]; now += 61000;
		expect((await read(true)).models).toEqual([...models, { slug: "model-b" }]);
		const rejected = await postResponses(proxy, { model: "model-a", input: "hello" });
		expect(rejected.status).toBe(403); await rejected.text();
		expect(calls.every(c => c.url.includes("/models"))).toBe(true);
	});
});

describe("native login isolation", () => {
	it.each([undefined, 1])("routes inference with pin %s without replacing the desktop login", async (forcedAccountIndex) => {
		const manager = new AccountManager(undefined, createStorage(Date.now()));
		const sync = vi.spyOn(manager, "syncCodexCliActiveSelectionForIndex").mockResolvedValue();
		const { calls, fetchImpl } = createRecordingFetch(call => call.url.includes("/models") ? Response.json({ models: [{ slug: "model-a" }] }) : textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
		const proxy = await startProxy({ accountManager: manager, fetchImpl, options: { nativeOpenai: true, forcedAccountIndex } });
		const result = await postResponses(proxy, { model: "model-a", input: "hello", stream: true }, "/responses", { authorization: "Bearer access-1" });
		expect(result.status).toBe(200); await result.text();
		expect(calls.some(c => c.url.includes("/responses") && c.headers.get("authorization")?.startsWith("Bearer access-"))).toBe(true);
		if (forcedAccountIndex === 1) {
			const inference = calls.find(c => c.url.includes("/responses"));
			expect(inference?.headers.get("authorization")).toBe("Bearer access-2");
			expect(inference?.headers.get("chatgpt-account-id")).toBe("acc_2");
		}
		expect(sync).not.toHaveBeenCalled();
	});
});

describe("native re-login while router is running", () => {
	it("accepts the newly saved credential and drops the obsolete auth cooldown", async () => {
		const storage = createStorage(Date.now()); const accountManager = new AccountManager(undefined, storage);
		const account = accountManager.getAccountByIndex(0)!; account.cooldownReason = "auth-failure"; account.coolingDownUntil = Date.now() + 300000;
		let disk = structuredClone(storage);
		const { fetchImpl } = createRecordingFetch(() => Response.json({ models: [{ slug: "model-a" }] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, readNativeAccountStorage: async () => disk } });
		Object.assign(disk.accounts[0]!, { accessToken: "new-login-token", refreshToken: "new-refresh", expiresAt: Date.now() + 7200000 });
		const response = await fetch(`${proxy.baseUrl}/models`, { headers: { authorization: "Bearer new-login-token" } });
		expect(response.status).toBe(200); await response.text();
		expect(account.access).toBe("new-login-token"); expect(account.cooldownReason).toBeUndefined();

		disk.accounts[0]!.authInvalidatedAt = Date.now();
		const revoked = await fetch(`${proxy.baseUrl}/models`, {headers: {authorization: "Bearer new-login-token"}});
		expect(revoked.status).toBe(401); await revoked.text();
		disk.accounts[0]!.enabled = false;
		const rejected = await fetch(`${proxy.baseUrl}/models`, { headers: { authorization: "Bearer new-login-token" } });
		expect(rejected.status).toBe(401); await rejected.text();
	});
});

describe("native catalog client version", () => {
	it("recovers discovery when a native client supplies its version after an unversioned request", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now()));
		const { fetchImpl } = createRecordingFetch(call => new URL(call.url).searchParams.get("client_version") === "9.1.0" ? Response.json({ models: [{ slug: "future-model" }] }) : new Response("version required", { status: 400 }));
		const proxy = await startProxy({ accountManager: manager, fetchImpl, options: { nativeOpenai: true } });
		const headers = { authorization: "Bearer access-1" };
		const first = await fetch(`${proxy.baseUrl}/models`, { headers }); expect(first.status).toBe(503); await first.text();
		const next = await fetch(`${proxy.baseUrl}/models?client_version=9.1.0`, { headers }); expect(next.status).toBe(200); expect((await next.json()).models[0].slug).toBe("future-model");
	});
});

describe("Responses WebSocket fallback", () => {
	it("signals the native client to fall back to HTTP after authenticating", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => Response.json({}));
		const proxy = await startProxy({ accountManager: manager, fetchImpl });
		const upgrade = async (token: string) => new Promise<number>((resolve, reject) => {
			const req = request(`${proxy.baseUrl}/responses`, { headers: { authorization: `Bearer ${token}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
			req.on("error", reject); req.end();
		});
		expect(await upgrade("unknown")).toBe(401);
		expect(await upgrade(DEFAULT_CLIENT_API_KEY)).toBe(426);
		expect(calls).toHaveLength(0);
		const ordinary = await fetch(`${proxy.baseUrl}/responses`, { headers: { authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}` } });
		expect(ordinary.status).toBe(404); await ordinary.text();
	});
});

describe("native account storage availability", () => {
 it("rejects stale managed credentials when the live account store disappears", async () => {
  const accountManager = new AccountManager(undefined, createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(()=>Response.json({models:[{slug:"model-a"}]}));
  const proxy=await startProxy({accountManager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>null}});
  const response=await fetch(`${proxy.baseUrl}/models`,{headers:{authorization:"Bearer access-1"}});
  expect(response.status).toBe(401);await response.text();
  expect(calls).toHaveLength(0);
 });
});

describe("native mode authenticates before touching account storage", () => {
	it("never reads storage for a request without credentials", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const readNativeAccountStorage = vi.fn(async () => createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => Response.json({ models: [] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, readNativeAccountStorage } });
		const response = await fetch(`${proxy.baseUrl}/models`);
		expect(response.status).toBe(401); await response.text();
		expect(readNativeAccountStorage).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});
	it("does not adopt stored credentials on behalf of an unauthenticated caller", async () => {
		const storage = createStorage(Date.now()); const accountManager = new AccountManager(undefined, storage);
		const account = accountManager.getAccountByIndex(0)!;
		const disk = structuredClone(storage);
		Object.assign(disk.accounts[0]!, { accessToken: "relogin-token", refreshToken: "relogin-refresh", expiresAt: Date.now() + 7200000 });
		const { calls, fetchImpl } = createRecordingFetch(() => Response.json({ models: [] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, readNativeAccountStorage: async () => disk } });
		const response = await fetch(`${proxy.baseUrl}/models`, { headers: { authorization: "Bearer not-a-known-token" } });
		expect(response.status).toBe(401); await response.text();
		expect(account.access).toBe("access-1");
		expect(account.refreshToken).toBe("refresh-1");
		expect(calls).toHaveLength(0);
	});
	it("answers an authenticated client with 503, not 401, when the account store is missing", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(() => Response.json({ models: [{ slug: "model-a" }] }));
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, readNativeAccountStorage: async () => null } });
		const response = await fetch(`${proxy.baseUrl}/models`, { headers: { authorization: `Bearer ${DEFAULT_CLIENT_API_KEY}` } });
		expect(response.status).toBe(503);
		expect((await response.json()).error.code).toBe("native_account_storage_unavailable");
		expect(calls).toHaveLength(0);
	});
	it("keeps the live pool and its learned limits while the store is missing", async () => {
		const storage = createStorage(Date.now(), 1);
		const accountManager = new AccountManager(undefined, storage);
		let missing = false;
		const { calls, fetchImpl } = createRecordingFetch(call => call.url.includes("/models") ? Response.json({ models: [{ slug: "model-a" }] }) : textEventStream());
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, readNativeAccountStorage: async () => missing ? null : structuredClone(storage) } });
		const until = Date.now() + 10 * 60_000;
		accountManager.getAccountByIndex(0)!.rateLimitResetTimes["codex:model-b"] = until;
		missing = true;
		const gone = await postResponses(proxy, { model: "model-a", input: "hello" });
		expect(gone.status).toBe(503);
		expect((await gone.json()).error.code).toBe("native_account_storage_unavailable");
		expect(calls.filter(c => c.url.endsWith("/responses"))).toHaveLength(0);
		missing = false;
		const back = await postResponses(proxy, { model: "model-a", input: "hello" });
		expect(back.status).toBe(200); await back.text();
		expect(accountManager.getAccountByIndex(0)!.rateLimitResetTimes["codex:model-b"]).toBe(until);
	});
});

describe("native catalog outages", () => {
	it("routes to an account whose catalog is unknown instead of refusing the model", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(call => {
			if (call.url.includes("/models")) {
				return call.headers.get("chatgpt-account-id") === "acc_1"
					? new Response("slow down", { status: 429 })
					: Response.json({ models: [{ slug: "other-model" }] });
			}
			return textEventStream('data: {"type":"response.completed","response":{}}\n\n');
		});
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true } });
		const response = await postResponses(proxy, { model: "model-a", input: "hello", stream: true });
		expect(response.status).toBe(200); await response.text();
		const inference = calls.filter(c => c.url.includes("/responses"));
		expect(inference.length).toBeGreaterThan(0);
		expect(inference.every(c => c.headers.get("chatgpt-account-id") === "acc_1")).toBe(true);
	});
	it("keeps excluding by the last successful catalog after a later refresh fails", async () => {
		let now = Date.now(); let throttled = false;
		const accountManager = new AccountManager(undefined, createStorage(now, 1));
		const { calls, fetchImpl } = createRecordingFetch(call => {
			if (call.url.includes("/models")) return throttled ? new Response("busy", { status: 429 }) : Response.json({ models: [{ slug: "model-a" }] });
			return textEventStream();
		});
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true, now: () => now } });
		const first = await postResponses(proxy, { model: "model-a", input: "hello" });
		expect(first.status).toBe(200); await first.text();
		throttled = true; now += 20 * 60_000;
		const known = await postResponses(proxy, { model: "model-a", input: "hello" });
		expect(known.status).toBe(200); await known.text();
		const absent = await postResponses(proxy, { model: "model-b", input: "hello" });
		expect(absent.status).toBe(403); await absent.text();
		expect(calls.filter(c => c.url.endsWith("/responses"))).toHaveLength(2);
	});
	it("checks every eligible account catalog concurrently", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now(), 3));
		let inFlight = 0; let maxInFlight = 0;
		const { fetchImpl } = createRecordingFetch(async call => {
			if (!call.url.includes("/models")) return textEventStream('data: {"type":"response.completed","response":{}}\n\n');
			inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise(resolve => setTimeout(resolve, 50));
			inFlight--;
			return Response.json({ models: [{ slug: "model-a" }] });
		});
		const proxy = await startProxy({ accountManager, fetchImpl, options: { nativeOpenai: true } });
		const response = await postResponses(proxy, { model: "model-a", input: "hello", stream: true });
		expect(response.status).toBe(200); await response.text();
		expect(maxInFlight).toBe(3);
	});
});

describe("PR review regressions", () => {
 it.each(["removed", "shorter", "expired"])("revokes a persisted managed bearer when %s", async (change) => {
  const now=Date.now(), storage=createStorage(now), manager=new AccountManager(undefined,storage), disk=structuredClone(storage);
  if(change==="removed") delete disk.accounts[0]!.accessToken;
  if(change==="shorter") Object.assign(disk.accounts[0]!,{accessToken:"replacement",expiresAt:now+600_000});
  if(change==="expired") disk.accounts[0]!.expiresAt=now-1;
  const {fetchImpl,calls}=createRecordingFetch(()=>Response.json({models:[]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>disk}});
  const response=await getModels(proxy,undefined,{authorization:"Bearer access-1"});
  expect(response.status).toBe(401);await response.text();expect(calls).toHaveLength(0);
 });
 it("retains routing mutex mode after inventory replacement",async()=>{
  const previous=process.env.CODEX_AUTH_ROUTING_MUTEX;process.env.CODEX_AUTH_ROUTING_MUTEX="enabled";
  try {
  const storage=createStorage(Date.now(),1),manager=new AccountManager(undefined,storage);
  const mode=vi.spyOn(AccountManager.prototype,"setRoutingMutexMode");
  const {fetchImpl}=createRecordingFetch(()=>Response.json({models:[{slug:"model-test"}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>createStorage(Date.now(),2)}});
  mode.mockClear();const response=await getModels(proxy);await response.text();
  expect(mode).toHaveBeenCalledWith("enabled");mode.mockRestore();
  } finally {if(previous===undefined) delete process.env.CODEX_AUTH_ROUTING_MUTEX;else process.env.CODEX_AUTH_ROUTING_MUTEX=previous;}
 });
 it.each(["add","remove","reorder"])("preserves a concurrent inventory %s when an old request completes",async(change)=>{
  const storage=createStorage(Date.now(),2);let disk=structuredClone(storage);
  withAccountStorageTransactionMock.mockImplementation(async(handler)=>handler(structuredClone(disk),async(next:AccountStorageV3)=>{disk=structuredClone(next);}));
  const manager=new AccountManager(undefined,storage);
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});const entered=new Promise<void>(resolve=>{started=resolve;});
  const {fetchImpl}=createRecordingFetch(async(call)=>{
   if(call.url.includes('/models'))return Response.json({models:[{slug:'model-test'}]});
   started();await gate;return textEventStream();
  });
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(disk)}});
  const pending=postResponses(proxy,{model:'model-test',input:'test'});await entered;
  if(change==='add')disk.accounts.push({...createStorage(Date.now(),3).accounts[2]!});
  if(change==='remove')disk.accounts.splice(0,1);
  if(change==='reorder')disk.accounts.reverse();
  disk.activeIndex=0;disk.activeIndexByFamily={codex:0};
  const expected=disk.accounts.map(a=>a.accountId);
  const discovery=await getModels(proxy);await discovery.text();
  release();const response=await pending;await response.text();await manager.flushPendingSave();
  expect(disk.accounts.map(a=>a.accountId)).toEqual(expected);
 });
 it("keeps concurrent client catalogs isolated across a delayed credential refresh",async()=>{
  const now=Date.now(),storage=createStorage(now,1);storage.accounts[0]!.expiresAt=now-1;
  let refreshStarted!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{refreshStarted=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  refreshAccessTokenMock.mockImplementation(async()=>{refreshStarted();await gate;return {type:'success',access:'renewed',refresh:'renewed-refresh',expires:now+3600_000};});
  const manager=new AccountManager(undefined,storage);
  const {fetchImpl,calls}=createRecordingFetch(call=>Response.json({models:[{slug:`model-${new URL(call.url).searchParams.get('client_version')}`}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const refreshCalls=vi.spyOn(tokenRefreshRuntime,"ensureFreshAccessToken");
  const first=getModels(proxy,'/models?client_version=1.0');await started;
  const second=getModels(proxy,'/models?client_version=2.0');
  // Wait until the second request reaches token refresh, without timing a network delay.
  await vi.waitFor(()=>expect(refreshCalls).toHaveBeenCalledTimes(2));release();refreshCalls.mockRestore();
  const [a,b]=await Promise.all([first,second]);
  expect((await a.json()).models.map((m:{slug:string})=>m.slug)).toEqual(['model-1.0']);
  expect((await b.json()).models.map((m:{slug:string})=>m.slug)).toEqual(['model-2.0']);
  expect(calls.map(c=>new URL(c.url).searchParams.get('client_version')).sort()).toEqual(['1.0','2.0']);
 });
 it("routes reasoning and speed only to an account advertising both",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now(),2));
  const {fetchImpl,calls}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:'model-test',supported_reasoning_levels:[{effort:call.headers.get('authorization')==='Bearer access-1'?'low':'high'}],service_tiers:call.headers.get('authorization')==='Bearer access-1'?[]:[{id:'priority',name:'Fast',description:''}]}]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await postResponses(proxy,{model:'model-test',reasoning:{effort:'high'},service_tier:'priority',input:'test'});await response.text();
  expect(response.status).toBe(200);
  expect(calls.filter(c=>c.url.endsWith('/responses')).map(c=>c.headers.get('authorization'))).toEqual(['Bearer access-2']);
 });
});

describe("catalog review concurrency and backoff",()=>{
 it("bounds inference discovery to three in-flight calls for six accounts",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now(),6));let active=0,peak=0;
  const {fetchImpl}=createRecordingFetch(async call=>{
   if(!call.url.includes('/models'))return textEventStream();
   peak=Math.max(peak,++active);await new Promise<void>(r=>setImmediate(r));active--;
   return Response.json({models:[{slug:'model-test'}]});
  });
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await postResponses(proxy,{model:'model-test',input:'test'});await response.text();
  expect(response.status).toBe(200);expect(peak).toBeLessThanOrEqual(3);
 });
 it("honors catalog Retry-After instead of polling every five seconds",async()=>{
  let now=Date.now(),reads=0;
  const manager=new AccountManager(undefined,createStorage(now,1));
  const {fetchImpl}=createRecordingFetch(call=>{
   if(call.url.includes('/models')){reads++;return new Response('busy',{status:429,headers:{'retry-after':'120'}});}
   return textEventStream();
  });
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,now:()=>now}});
  for(const advance of [0,6000,6000]){now+=advance;const response=await postResponses(proxy,{model:'model-test',input:'test'});await response.text();expect(response.status).toBe(200);}
  expect(reads).toBe(1);
  now+=120000;const response=await postResponses(proxy,{model:'model-test',input:'test'});await response.text();expect(reads).toBe(2);
 });
 it.each([["86400"],[new Date(Date.now()+30*24*3600_000).toUTCString()]])("caps a catalog Retry-After of %s at fifteen minutes",async retryAfter=>{
  let now=Date.now(),reads=0;
  const manager=new AccountManager(undefined,createStorage(now,1));
  const {fetchImpl}=createRecordingFetch(call=>{
   if(call.url.includes('/models')){reads++;return new Response('busy',{status:429,headers:{'retry-after':retryAfter}});}
   return textEventStream();
  });
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,now:()=>now}});
  const first=await postResponses(proxy,{model:'model-test',input:'test'});await first.text();expect(first.status).toBe(200);
  expect(reads).toBe(1);
  now+=15*60_000+1;
  const later=await postResponses(proxy,{model:'model-test',input:'test'});await later.text();expect(later.status).toBe(200);
  expect(reads).toBe(2);
 });
 it("lets an explicit capability refresh bypass an earlier catalog backoff",async()=>{
  let now=Date.now(),reads=0;
  const manager=new AccountManager(undefined,createStorage(now,1));
  const {fetchImpl}=createRecordingFetch(call=>{
   if(call.url.includes('/models')){reads++;return reads===1?new Response('busy',{status:429,headers:{'retry-after':'600'}}):Response.json({models:[{slug:'model-test'}]});}
   return textEventStream();
  });
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,now:()=>now}});
  const first=await postResponses(proxy,{model:'model-test',input:'test'});await first.text();expect(reads).toBe(1);
  const refreshed=await getModels(proxy,"/models?refresh_capabilities=1");
  expect(refreshed.status).toBe(200);expect((await refreshed.json()).models.map((m:{slug:string})=>m.slug)).toEqual(['model-test']);
  expect(reads).toBe(2);
 });
 it("still recovers stale state when another account lacks the model",async()=>{
  const storage=createStorage(Date.now(),2),manager=new AccountManager(undefined,storage);
  manager.markAccountCoolingDown(manager.getAccountByIndex(1)!,60000,'network-error');
  const reload=vi.spyOn(AccountManager,'loadFromDisk').mockResolvedValue(new AccountManager(undefined,storage));
  const {fetchImpl,calls}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:call.headers.get('authorization')==='Bearer access-1'?'other':'model-test'}]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await postResponses(proxy,{model:'model-test',input:'test'});await response.text();
  expect(response.status).toBe(200);expect(reload).toHaveBeenCalled();
  expect(calls.filter(c=>c.url.endsWith('/responses')).map(c=>c.headers.get('authorization'))).toEqual(['Bearer access-2']);
 });
});

describe("native inventory read resilience",()=>{
 it.each(["EBUSY","EPERM","EACCES"])("preserves live routing after a delayed %s without trusting managed bearers",async code=>{
  let clock=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>clock);
  const storage=createStorage(clock,1),manager=new AccountManager(undefined,storage);
  const read=vi.fn().mockResolvedValue(storage);
  const {fetchImpl,calls}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:'model-test'}]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:read}});
  expect((await getModels(proxy)).status).toBe(200);
  clock+=3000;read.mockRejectedValue(Object.assign(Error("locked"),{code}));
  const response=await postResponses(proxy,{model:"model-test",input:"test"});await response.text();expect(response.status).toBe(200);
  expect((await getModels(proxy,undefined,{authorization:"Bearer access-1"})).status).toBe(401);
  expect(calls.filter(c=>c.url.endsWith('/responses'))).toHaveLength(1);
  clock+=30000;
  const expired=await postResponses(proxy,{model:"model-test",input:"test"});
  expect(expired.status).toBe(503);await expired.text();
  expect(calls.filter(c=>c.url.endsWith('/responses'))).toHaveLength(1);
  read.mockResolvedValue(storage);
  const recovered=await postResponses(proxy,{model:"model-test",input:"test"});
  expect(recovered.status).toBe(200);await recovered.text();

 });

 it.each(['EBUSY','EPERM'])("keeps independently authenticated inference available through one %s read",async code=>{
  const storage=createStorage(Date.now(),1),manager=new AccountManager(undefined,storage);
  const read=vi.fn().mockResolvedValueOnce(storage).mockResolvedValueOnce(storage).mockRejectedValueOnce(Object.assign(Error('busy'),{code})).mockResolvedValue(storage);
  const {fetchImpl,calls}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:'model-test'}]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:read}});
  for(let i=0;i<3;i++){const response=await postResponses(proxy,{model:'model-test',input:'test'});await response.text();expect(response.status).toBe(200);}
  expect(read).toHaveBeenCalledTimes(6);expect(calls.filter(c=>c.url.endsWith('/responses'))).toHaveLength(3);
 });
 it("never authenticates a managed bearer with a stale snapshot",async()=>{
  const storage=createStorage(Date.now(),1),manager=new AccountManager(undefined,storage);
  const read=vi.fn().mockResolvedValueOnce(storage).mockRejectedValueOnce(Object.assign(Error('busy'),{code:'EBUSY'})).mockResolvedValue({...storage,accounts:[{...storage.accounts[0]!,accessToken:undefined}]});
  const {fetchImpl,calls}=createRecordingFetch(()=>Response.json({models:[{slug:'model-test'}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:read}});
  expect((await getModels(proxy)).status).toBe(200);
  for(let i=0;i<2;i++){const response=await getModels(proxy,undefined,{authorization:'Bearer access-1'});await response.text();expect(response.status).toBe(401);}
  expect(calls).toHaveLength(1);
 });
 it("coalesces concurrent inventory reads and replaces the manager only once",async()=>{
  const storage=createStorage(Date.now(),1),manager=new AccountManager(undefined,storage);
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
  const read=vi.fn(async()=>{started();await gate;return createStorage(Date.now(),2);});
  const original=nativeStorageReader.createNativeAccountStorageReader;
  const readerCalls=vi.fn();
  vi.spyOn(nativeStorageReader,'createNativeAccountStorageReader').mockImplementation((...args)=>{
   const reader=original(...args);return ()=>{readerCalls();return reader();};
  });
  const mode=vi.spyOn(AccountManager.prototype,'setRoutingMutexMode');
  const {fetchImpl}=createRecordingFetch(()=>Response.json({models:[{slug:'model-test'}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:read}});mode.mockClear();
  const first=getModels(proxy);await entered;const second=getModels(proxy);
  await vi.waitFor(()=>expect(readerCalls).toHaveBeenCalledTimes(2));
  release();await Promise.all([first.then(r=>r.text()),second.then(r=>r.text())]);
  expect(read).toHaveBeenCalledTimes(1);expect(mode).toHaveBeenCalledTimes(1);
 });
 it("preserves unexpired 429 state across inventory changes",async()=>{
  const now=Date.now(),manager=new AccountManager(undefined,createStorage(now,1));
  manager.getAccountByIndex(0)!.rateLimitResetTimes={codex:now+60000};
  const mode=vi.spyOn(AccountManager.prototype,'setRoutingMutexMode');
  const {fetchImpl}=createRecordingFetch(()=>Response.json({models:[{slug:'model-test'}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>createStorage(now,2)}});mode.mockClear();
  const response=await getModels(proxy);await response.text();
  const replacement=mode.mock.contexts[0] as AccountManager;
  expect(replacement.getAccountByIndex(0)?.rateLimitResetTimes.codex).toBe(now+60000);
 });
});

it("clamps a reference catalog's context to the serving pool",async()=>{
 const storage=createStorage(Date.now(),2),manager=new AccountManager(undefined,storage);
 const {fetchImpl}=createRecordingFetch(call=>Response.json({models:[{slug:'model-test',context_window:call.headers.get('authorization')==='Bearer access-1'?200000:100000}]}));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,catalogAccount:{email:storage.accounts[0]!.email!,accountId:'acc_1'}}});
 const response=await getModels(proxy);expect((await response.json()).models[0].context_window).toBe(100000);
});

describe("explicit API model routes",()=>{
 it.each([
  ["gzip",gzipSync(Buffer.from('{"model":"zdr/exclusive","input":"test","stream":true}'))],
  ["deflate",deflateSync(Buffer.from('{"model":"zdr/exclusive","input":"test","stream":true}'))],
  ["br",brotliCompressSync(Buffer.from('{"model":"zdr/exclusive","input":"test","stream":true}'))],
  ["zstd",Buffer.from("KLUv/SA2sQEAeyJtb2RlbCI6Inpkci9leGNsdXNpdmUiLCJpbnB1dCI6InRlc3QiLCJzdHJlYW0iOnRydWV9","base64")],
 ])("decodes compressed aliases before choosing credentials and removes wire encoding: %s",async(encoding,body)=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.endsWith("/models")?Response.json({data:[{id:"exclusive"}]}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>[{id:"fixture",label:"Fixture",kind:"zdr",apiKey:"fixture-api-key",enabled:true,priority:0,visibleModels:["exclusive"]}]}});
  const response=await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`,"content-type":"application/json","content-encoding":encoding},body});
  if(encoding==="zstd"&&!("zstdDecompress" in zlib)){expect(response.status).toBe(415);await response.text();expect(calls).toHaveLength(0);return;}
  expect(response.status).toBe(200);await response.text();
  const inference=calls.filter(c=>c.url.endsWith("/responses"));
  expect(inference).toHaveLength(1);
  expect(inference[0]?.url).toBe("https://api.openai.com/v1/responses");
  expect(inference[0]?.headers.get("authorization")).toBe("Bearer fixture-api-key");
  expect(inference[0]?.headers.has("content-encoding")).toBe(false);
  expect(JSON.parse(inference[0]!.bodyText).model).toBe("exclusive");
 });
 it.each([
  ["gzip",Buffer.from("broken"),400],
  ["unknown",Buffer.from("{}"),415],
  ["identity",Buffer.from("broken"),400],
  ["identity",Buffer.from('{"model":42}'),400],
  ["gzip",gzipSync(JSON.stringify({model:"zdr/exclusive",input:"x".repeat(4096)})),413],
 ])("rejects unreadable or expanded requests before any upstream: %s",async(encoding,body,status)=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(()=>Response.json({}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{maxRequestBodyBytes:512}});
  const response=await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`,"content-type":"application/json","content-encoding":encoding},body});
  expect(response.status).toBe(status);await response.text();expect(calls).toHaveLength(0);
 });

 it("advertises selected API-only models and never sends a ZDR alias to OAuth",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const routes=[{id:"fixture-api",label:"Fixture API",kind:"zdr" as const,apiKey:"fixture-api-key",enabled:true,priority:0,visibleModels:["api-exclusive"]}];
  const {calls,fetchImpl}=createRecordingFetch(call=>{
   if(call.url==="https://api.openai.com/v1/models")return Response.json({data:[{id:"api-exclusive"},{id:"hidden"}]});
   if(call.url==="https://api.openai.com/v1/responses")return textEventStream('data: {"type":"response.completed","response":{}}\n\n');
   return Response.json({models:[{slug:"oauth-only"}]});
  });
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>routes}});
  const list=await fetch(`${proxy.baseUrl}/models`,{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`}});
  expect((await list.json()).models.map((m:{slug:string})=>m.slug)).toEqual(["oauth-only","zdr/api-exclusive"]);
  const response=await postResponses(proxy,{model:"zdr/api-exclusive",input:"test",stream:true});
  expect(response.status).toBe(200);await response.text();
  const inference=calls.filter(c=>c.url.endsWith("/responses"));
  expect(inference).toHaveLength(1);
  expect(inference[0]?.url).toBe("https://api.openai.com/v1/responses");
  expect(inference[0]?.headers.get("authorization")).toBe("Bearer fixture-api-key");
  expect(inference[0]?.headers.has("chatgpt-account-id")).toBe(false);
  expect(proxy.getStatus()).toMatchObject({lastAccountIndex:null,lastAccountLabel:"ZDR credential 1",upstreamRequests:1});
 });
 it("fails closed on an unconfigured ZDR alias instead of forwarding it normally",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(()=>Response.json({models:[{slug:"shared"}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>[]}});
  const response=await postResponses(proxy,{model:"zdr/shared",input:"test"});
  expect(response.status).toBe(503);await response.text();
  expect(calls).toHaveLength(0);
 });
});

describe("model pool capability boundaries",()=>{
 it.each(["speed/accelerated/common","common"])("routes a speed selection only to a matching credential: %s",async(model)=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common",service_tiers:call.headers.get("chatgpt-account-id")==="acc_2"?[{id:"accelerated",name:"Accelerated",description:"Fixture speed"}]:[]}]}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await postResponses(proxy,{model,service_tier:"accelerated",input:"test",stream:true});
  expect(response.status).toBe(200);await response.text();
  const sent=calls.filter(c=>c.url.includes("/responses"));
  expect(sent.map(c=>c.headers.get("chatgpt-account-id"))).toEqual(["acc_2"]);
  expect(JSON.parse(sent[0]!.bodyText)).toMatchObject({model:"common",service_tier:"accelerated"});
 });

 it("keeps a stored switch pin strict and never serves an exclusive model from another account",async()=>{
  vi.spyOn(storageMetaModule,"readStorageMetaFromDisk").mockReturnValue({pinnedAccountIndex:0,affinityGeneration:1});
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:call.headers.get("chatgpt-account-id")==="acc_2"?"exclusive":"common"}]}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await postResponses(proxy,{model:"exclusive",input:"test",stream:true});
  expect(response.status).toBe(403);expect((await response.json()).error.code).toBe("model_not_available_in_account_catalog");
  expect(calls.filter(c=>c.url.includes("/responses"))).toHaveLength(0);
 });
 it("fails a stored native pin with codex_pinned_account_unavailable instead of rotating",async()=>{
  vi.spyOn(storageMetaModule,"readStorageMetaFromDisk").mockReturnValue({pinnedAccountIndex:0,affinityGeneration:1});
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  manager.markAccountCoolingDown(manager.getAccountByIndex(0)!,10*60_000,"network-error");
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await postResponses(proxy,{model:"common",input:"test",stream:true});
  expect(response.status).toBe(503);expect((await response.json()).error.code).toBe("codex_pinned_account_unavailable");
  expect(calls.filter(c=>c.url.includes("/responses"))).toHaveLength(0);
 });

 it("advertises an exclusive OAuth model and sends it only to its eligible account",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?
   Response.json({models:[{slug:call.headers.get("chatgpt-account-id")==="acc_2"?"exclusive":"common"}]}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const result=await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`,"content-type":"application/json","content-encoding":"gzip"},body:gzipSync(JSON.stringify({model:"exclusive",input:"test",stream:true}))});
  expect(result.status).toBe(200);await result.text();
  const inference=calls.filter(c=>c.url.includes("/responses"));
  expect(inference).toHaveLength(1);expect(inference[0]?.headers.get("chatgpt-account-id")).toBe("acc_2");
  expect(inference[0]?.headers.has("content-encoding")).toBe(false);
  expect(JSON.parse(inference[0]!.bodyText).model).toBe("exclusive");
 });
 it("does not route a requested reasoning setting to an account that lacks it",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?
   Response.json({models:[{slug:"common",supported_reasoning_levels:[{effort:call.headers.get("chatgpt-account-id")==="acc_2"?"high":"low"}]}]}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,forcedAccountIndex:0}});
  const result=await postResponses(proxy,{model:"common",reasoning:{effort:"high"},input:"test",stream:true});
  expect(result.status).toBe(403);await result.text();
  expect(calls.some(c=>c.url.includes("/responses"))).toBe(false);
 });
});

describe("native picker refresh",()=>{
 it("caches picker reads and refreshes all credentials only on explicit check",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));let revision=1;
  const routes=[{id:"api-fixture",label:"API fixture",kind:"api" as const,apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["api-new"]}];
  const {fetchImpl}=createRecordingFetch(call=>call.url==="https://api.openai.com/v1/models"?
   Response.json({data:revision===1?[]:[{id:"api-new"}]}):Response.json({models:[{slug:`account-${call.headers.get("chatgpt-account-id")}-${revision}`}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>routes}});
  const read=async(force=false)=>{const response=await fetch(`${proxy.baseUrl}/models${force?"?refresh_capabilities=1":""}`,{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`}});return (await response.json()).models.map((m:{slug:string})=>m.slug);};
  expect(await read()).toHaveLength(2);revision=2;
  expect(await read()).toEqual(["account-acc_1-1","account-acc_2-1"]);
  expect(await read(true)).toEqual(["account-acc_1-2","account-acc_2-2","api/api-new"]);
 });
});

describe("API-only credential inventory",()=>{
 it("serves explicit API models with local authentication when no OAuth pool is stored",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now()));
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.endsWith("/models")?Response.json({data:[{id:"exclusive"}]}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>null,readApiRoutes:async()=>[{id:"fixture",label:"API fixture",kind:"api",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["exclusive"]}]}});
  const result=await postResponses(proxy,{model:"api/exclusive",input:"test"});
  expect(result.status).toBe(200);await result.text();
  expect(calls.every(c=>c.url.startsWith("https://api.openai.com/"))).toBe(true);
  const stale=await postResponses(proxy,{model:"api/exclusive",input:"test"},"/responses",{authorization:"Bearer access-1"});
  expect(stale.status).toBe(401);await stale.text();
 });
});

it("changes the union catalog ETag on refresh and signals it on OAuth and API responses",async()=>{
 const manager=new AccountManager(undefined,createStorage(Date.now()));
 let models=[{slug:"model-a"}];
 const {fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json(call.url.includes("api.openai.com")?{data:[{id:"exclusive"}]}:{models}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>[{id:"fixture",label:"Fixture",kind:"zdr",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["exclusive"]}]}});
 const read=async(force=false)=>{const r=await fetch(`${proxy.baseUrl}/models${force?"?refresh_capabilities=1":""}`,{headers:{authorization:"Bearer access-1"}});await r.text();return r.headers.get("etag");};
 const first=await read();expect(first).toBeTruthy();expect(await read()).toBe(first);
 models.push({slug:"model-new"});const second=await read(true);expect(second).not.toBe(first);
 for(const model of ["model-new","zdr/exclusive"]){const r=await postResponses(proxy,{model,input:"hello",stream:true});expect(r.status).toBe(200);expect(r.headers.get("x-models-etag")).toBe(second);await r.text();}
});

it("routes native WebSocket model requests through capability-aware account priority", async () => {
 const {createServer}=await import("node:http");const {once}=await import("node:events");const {default:WebSocket,WebSocketServer}=await import("ws");
 const upstream=createServer();const wss=new WebSocketServer({server:upstream});const accounts:string[]=[];
 wss.on("connection",(ws,req)=>{accounts.push(String(req.headers["chatgpt-account-id"]));ws.on("message",raw=>{const body=JSON.parse(raw.toString());expect(body.model).toBe("exclusive");ws.send(JSON.stringify({type:"response.created",response:{id:"fixture-response"}}));ws.send(JSON.stringify({type:"response.completed",response:{id:"fixture-response",output:[],usage:{input_tokens:1,output_tokens:1}}}));});});
 upstream.listen(0,"127.0.0.1");await once(upstream,"listening");const address=upstream.address();if(!address||typeof address==="string")throw Error("fixture listen");
 let client:InstanceType<typeof WebSocket>|undefined;
 try{
 const manager=new AccountManager(undefined,createStorage(Date.now()));
 const proxy=await startProxy({accountManager:manager,fetchImpl:async(_url,init)=>Response.json({models:[{slug:new Headers(init?.headers).get("chatgpt-account-id")==="acc_2"?"exclusive":"shared"}]}),options:{nativeOpenai:true,upstreamBaseUrl:`http://127.0.0.1:${address.port}`}});
 client=new WebSocket(proxy.baseUrl.replace("http:","ws:")+"/responses",{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`}});await once(client,"open");
 const done=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("WebSocket turn timeout")),3000);client?.on("message",raw=>{if(JSON.parse(raw.toString()).type==="response.completed"){clearTimeout(timer);resolve();}});});
 client.send(JSON.stringify({type:"response.create",model:"exclusive",input:[{role:"user",content:"test"}]}));await done;expect(accounts).toEqual(["acc_2"]);
 }finally{client?.terminate();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});

it("learns a stale subscription model entitlement and retries another eligible account",async()=>{
 const manager=new AccountManager(undefined,createStorage(Date.now()));
 const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"shared"}]}):call.headers.get("chatgpt-account-id")==="acc_1"?Response.json({error:{code:"model_not_found",param:"model"}},{status:404}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
 for(let i=0;i<2;i++){const r=await postResponses(proxy,{model:"shared",input:"hello",stream:true});expect(r.status).toBe(200);await r.text();}
 expect(calls.filter(c=>c.url.endsWith("/responses")).map(c=>c.headers.get("chatgpt-account-id"))).toEqual(["acc_1","acc_2","acc_2"]);
});


it('does not record a pinned model rejection as successful inference',async()=>{
 const manager=new AccountManager(undefined,createStorage(Date.now()));const success=vi.spyOn(manager,'recordSuccess');
 const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:'shared'}]}):Response.json({error:{code:'model_not_found',param:'model'}},{status:404}));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,forcedAccountIndex:0}});
 const response=await postResponses(proxy,{model:'shared',input:'hello',stream:true});expect(response.status).toBe(404);await response.text();expect(success).not.toHaveBeenCalled();expect(calls.filter(c=>c.url.endsWith('/responses'))).toHaveLength(1);
});

it.each(["1.0.0", "2.0.0"])("preserves completed discovery snapshots during overlapping discovery (%s)", async secondVersion => {
 const now = Date.now();
 const manager = new AccountManager(undefined, createStorage(now, 8));
 let releaseFirst!: () => void, firstReady!: () => void;
 let releaseSecond!: () => void, secondReady!: () => void;
 const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
 const firstStarted = new Promise<void>(resolve => { firstReady = resolve; });
 const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
 const secondStarted = new Promise<void>(resolve => { secondReady = resolve; });
 let routeReads = 0, catalogReads = 0;
 const proxy = await startProxy({accountManager: manager,
  fetchImpl: async (input) => {
   const version = new URL(String(input)).searchParams.get("client_version");
   if (++catalogReads > 8) { secondReady(); await secondGate; }
   return Response.json({models: [{slug: `fixture-${version}`} ]});
  }, options: {nativeOpenai: true, readApiRoutes: async () => {
   if (++routeReads === 1) { firstReady(); await firstGate; }
   return [];
  }}});
 const first = getModels(proxy, "/models?refresh_capabilities=1&client_version=1.0.0");
 await firstStarted;
 const second = getModels(proxy, `/models?refresh_capabilities=1&client_version=${secondVersion}`);
 await secondStarted;
 try {
  releaseFirst();
  const response = await first;
  expect(response.status).toBe(200);
  await response.text();
  const {loadModelInventory} = await import("../lib/runtime/model-discovery-status.js");
  const inventory = await loadModelInventory();
  expect(inventory?.clientVersion).toBe("1.0.0");
  expect(inventory?.entries).toHaveLength(8);
  expect(inventory?.entries.every(e => e.checkedAt > 0 && !e.error && e.models.includes("fixture-1.0.0"))).toBe(true);
 } finally {
  releaseFirst(); releaseSecond();
  await (await second).text();
 }
});

it("checks and advertises enabled workspaces through the proxy", async () => {
 const now=Date.now(), storage=createStorage(now,1);
 storage.accounts[0]!.workspaces=[{id:"acc_1",enabled:true},{id:"alternate",enabled:true},{id:"disabled",enabled:false}];
 storage.accounts[0]!.currentWorkspaceIndex=1;
 const accountManager=new AccountManager(undefined,storage);
 const seen:string[]=[];
 const fetchImpl=vi.fn(async (_url: string | URL | Request, init?:RequestInit)=>{
  const id=new Headers(init?.headers).get(OPENAI_HEADERS.ACCOUNT_ID)!; seen.push(id);
  return Response.json({models:[{slug:id==="alternate"?"alternate-model":"bound-model"}]});
 });
 const proxy=await startProxy({accountManager,fetchImpl,options:{nativeOpenai:true,now:()=>now}});
 const response=await fetch(`${proxy.baseUrl}/models?refresh_capabilities=1`,{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`}});
 expect(response.status).toBe(200);
 expect((await response.json()).models.map((m:{slug:string})=>m.slug)).toEqual(["bound-model", "alternate-model"]);
 expect(seen.sort()).toEqual(["acc_1","alternate"]);
 const {loadModelInventory}=await import("../lib/runtime/model-discovery-status.js");
 const inventory=await loadModelInventory();
 expect(inventory?.entries.find(e=>e.models.includes("alternate-model"))).toMatchObject({routable:true,selected:true});
 expect(accountManager.getAccountByIndex(0)?.accountId).toBe("acc_1");
});

it("routes by workspace capabilities and learns a rejection without excluding sibling workspaces", async () => {
 const now=Date.now(), storage=createStorage(now,1);
 storage.accounts[0]!.workspaces=[{id:"acc_1",enabled:true},{id:"alternate",enabled:true}];
 const accountManager=new AccountManager(undefined,storage);
 const requests:string[]=[];
 const {fetchImpl}=createRecordingFetch(call=>{
  const id=call.headers.get(OPENAI_HEADERS.ACCOUNT_ID)!;
  if(call.url.includes("/models")) return Response.json({models:[{slug:"workspace-model", supported_reasoning_levels:[{effort:"high"}]}]});
  requests.push(id);
  if(id==="acc_1") return Response.json({error:{code:"model_not_supported"}},{status:403});
  return new Response('data: {"type":"response.completed"}\n\n',{headers:{"content-type":"text/event-stream"}});
 });
 const proxy=await startProxy({accountManager,fetchImpl,options:{nativeOpenai:true,now:()=>now}});
 for(let i=0;i<2;i++){
  const result=await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({model:"workspace-model",reasoning:{effort:"high"},input:"fixture"})});
  expect(result.status).toBe(200); await result.text();
 }
 expect(requests).toEqual(["acc_1","alternate","alternate"]);
 expect(proxy.getStatus()).toMatchObject({lastAccountId:"acc_1",lastRequestedWorkspaceId:"alternate"});
 expect(accountManager.getAccountByIndex(0)?.accountId).toBe("acc_1");
 expect(accountManager.getAccountByIndex(0)?.currentWorkspaceIndex??0).toBe(0);
});

it("uses different workspace headers for concurrent model requests without changing selection", async () => {
 const storage=createStorage(Date.now(),1);
 storage.accounts[0]!.workspaces=[{id:"acc_1",enabled:true},{id:"alternate",enabled:true},{id:"disabled",enabled:false}];
 const accountManager=new AccountManager(undefined,storage);
 const requests:string[]=[];
 const {fetchImpl}=createRecordingFetch(call=>{
  const id=call.headers.get(OPENAI_HEADERS.ACCOUNT_ID)!;
  if(call.url.includes("/models")) return Response.json({models:[{slug:`model-${id}`,supported_reasoning_levels:[{effort:"ultra"}],service_tiers:[{id:"priority",name:"Fast",description:"Fixture tier"}]}]});
  expect(JSON.parse(call.bodyText).model).toBe(`model-${id}`);
  requests.push(id);
  return new Response('data: {"type":"response.completed"}\n\n',{headers:{"content-type":"text/event-stream"}});
 });
 const proxy=await startProxy({accountManager,fetchImpl,options:{nativeOpenai:true}});
 const results=await Promise.all(["acc_1","alternate"].map(id=>fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({model:`model-${id}`,reasoning:{effort:"ultra"},service_tier:"priority",input:"fixture"})})));
 for(const result of results){expect(result.status).toBe(200);await result.text();}
 expect(requests.sort()).toEqual(["acc_1","alternate"]);
 expect(accountManager.getAccountByIndex(0)?.accountId).toBe("acc_1");
});

it("disables only the rejected workspace and preserves the credential and sibling access", async () => {
 const storage=createStorage(Date.now(),1);
 storage.accounts[0]!.workspaces=[{id:"acc_1",enabled:true},{id:"alternate",enabled:true}];
 const accountManager=new AccountManager(undefined,storage);
 const requests:string[]=[];
 const {fetchImpl}=createRecordingFetch(call=>{
  if(call.url.includes("/models")) return Response.json({models:[{slug:"workspace-model"}]});
  const id=call.headers.get(OPENAI_HEADERS.ACCOUNT_ID)!;requests.push(id);
  return id==="acc_1" ? Response.json({error:{code:"workspace_disabled"}},{status:403}) : new Response('data: {"type":"response.completed"}\n\n',{headers:{"content-type":"text/event-stream"}});
 });
 const proxy=await startProxy({accountManager,fetchImpl,options:{nativeOpenai:true}});
 const response=await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({model:"workspace-model",input:"fixture"})});
 expect(response.status).toBe(200);await response.text();
 expect(requests).toEqual(["acc_1","alternate"]);
 expect(accountManager.getAccountByIndex(0)?.enabled).not.toBe(false);
 expect(accountManager.getAccountByIndex(0)?.workspaces?.map(w=>w.enabled)).toEqual([false,true]);
});

it("records actual inference dispatch separately from selection and catalog checks",async()=>{
 const {getRuntimeObservabilitySnapshot,mutateRuntimeObservabilitySnapshot}=await import("../lib/runtime/runtime-observability.js");
 const {inferenceAccountKey}=await import("../lib/runtime/inference-activity.js");
 mutateRuntimeObservabilitySnapshot(s=>{s.lastInferenceRequestAtByAccount={};});
 let now=Date.now();const storage=createStorage(now,1);const manager=new AccountManager(undefined,storage);
 const {fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"fixture"}]}):new Response('data: {"type":"response.completed"}\n\n',{headers:{"content-type":"text/event-stream"}}));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,now:()=>now}});
 const headers={authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`,"content-type":"application/json"};
 await (await fetch(`${proxy.baseUrl}/models`,{headers})).text();
 expect(getRuntimeObservabilitySnapshot().lastInferenceRequestAtByAccount).toEqual({});
 await (await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers,body:JSON.stringify({model:"fixture",input:"fixture"})})).text();
 const key=inferenceAccountKey(storage.accounts[0]!);
 expect(getRuntimeObservabilitySnapshot().lastInferenceRequestAtByAccount?.[key]).toBe(now);
 const used=now;now+=1000;
 await (await fetch(`${proxy.baseUrl}/models`,{headers})).text();
 expect(getRuntimeObservabilitySnapshot().lastInferenceRequestAtByAccount?.[key]).toBe(used);
});

it("keeps the native desktop pin strict across tiers and after a capability rejection", async () => {
 vi.spyOn(storageMetaModule,"readStorageMetaFromDisk").mockReturnValue({pinnedAccountIndex:0,affinityGeneration:1});
 vi.spyOn(runtimePolicy,"evaluateRuntimePolicy").mockResolvedValue({allowed:true,statusCode:200,errorCode:null,reasons:[],projectKey:null,blockedAccountIndexes:new Set(),scoreBoostByAccount:{},priorityByAccount:{0:8,1:1},budgetEvaluations:[]});
 const manager=new AccountManager(undefined,createStorage(Date.now()));
 const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):call.headers.get("chatgpt-account-id")==="acc_1"?Response.json({error:{code:"model_not_found",message:"Model not supported"}},{status:404}):textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
 const response=await postResponses(proxy,{model:"common",input:"test",stream:true});
 expect(response.status).not.toBe(200);await response.text();
 expect(calls.filter(c=>c.url.includes("/responses")).map(c=>c.headers.get("chatgpt-account-id"))).toEqual(["acc_1"]);
});

it("uses reset urgency, preserves the subscription reserve, and spends that reserve only after other subscriptions drain",async()=>{
 const now=Date.now();const manager=new AccountManager(undefined,createStorage(now));
 const entry=(used:number,hours:number)=>({status:200,updatedAt:now,planType:"pro",model:"common",primary:{},secondary:{usedPercent:used,resetAtMs:now+hours*3600000}});
 const cache={byAccountId:{acc_1:entry(80,24),acc_2:entry(60,2)},byEmail:{}};
 let secondAccountCalls=0;
 const {calls,fetchImpl}=createRecordingFetch(call=>{
  if(call.url.includes("/models"))return Response.json({models:[{slug:"common"}]});
  const id=call.headers.get("chatgpt-account-id");
  if(id==="acc_2")secondAccountCalls++;
  return new Response('data: {"type":"response.completed","response":{}}\n\n',{headers:{"content-type":"text/event-stream","x-codex-secondary-used-percent":id==="acc_2"?"95":"100","x-codex-secondary-reset-after-seconds":id==="acc_2"?"7200":"86400","x-codex-plan-type":"pro"}});
 });
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,now:()=>now,quotaRemainingPercentThreshold:undefined,readSubscriptionQuota:async()=>cache,readApiRoutes:async()=>[{id:"fixture-paid",label:"API",kind:"api",apiKey:"fixture-paid-key",enabled:true,priority:0,visibleModels:["common"]}]}});
 for(let i=0;i<3;i++){const response=await postResponses(proxy,{model:"common",input:"fixture",stream:true});expect(response.status).toBe(200);await response.text();}
 const dispatched=calls.filter(c=>c.url.includes("/responses"));
 expect(dispatched.map(c=>c.headers.get("chatgpt-account-id"))).toEqual(["acc_2","acc_1","acc_2"]);
 expect(dispatched.some(c=>c.headers.get("authorization")==="Bearer fixture-paid-key")).toBe(false);
 expect(secondAccountCalls).toBe(2);
});

it("keeps unused subscriptions behind a native pin and established reset ordering",async()=>{
 const now=Date.now();const manager=new AccountManager(undefined,createStorage(now,3));
 const entry=(left:number,hours:number)=>({status:200,updatedAt:now,planType:"pro",model:"common",primary:{},secondary:{usedPercent:100-left,resetAtMs:now+hours*3600000}});
 const cache={byAccountId:{acc_1:entry(90,3),acc_2:entry(7,2),acc_3:{...entry(100,24),secondary:{usedPercent:0}}},byEmail:{}};
 let pin:number|null=0;
 vi.spyOn(storageMetaModule,"readStorageMetaFromDisk").mockImplementation(()=>({pinnedAccountIndex:pin,affinityGeneration:1}));
 const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):new Response('data: {"type":"response.completed","response":{}}\n\n',{headers:{"content-type":"text/event-stream",...(call.headers.get("chatgpt-account-id")==="acc_3"?{"x-codex-secondary-used-percent":"0","x-codex-secondary-reset-after-seconds":"86400"}:{})}}));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,now:()=>now,readSubscriptionQuota:async()=>cache,quotaRemainingPercentThreshold:undefined}});
 const first=await postResponses(proxy,{model:"common",input:"fixture",stream:true});expect(first.status).toBe(200);await first.text();
 pin=null;
 const second=await postResponses(proxy,{model:"common",input:"fixture",stream:true});expect(second.status).toBe(200);await second.text();
 expect(calls.filter(c=>c.url.includes("/responses")).map(c=>c.headers.get("chatgpt-account-id"))).toEqual(["acc_1","acc_2"]);
});

it("switches subscriptions at five percent from quota events on a reused WebSocket", async () => {
 const {createServer}=await import("node:http");
 const {once}=await import("node:events");
 const {default:WebSocket,WebSocketServer}=await import("ws");
 const now=Date.now();
 const upstream=createServer();
 const wss=new WebSocketServer({server:upstream});
 const dispatched:string[]=[];
 let connections=0;
 wss.on("connection",(socket,request)=>{
  connections++;
  const account=String(request.headers["chatgpt-account-id"]);
  socket.on("message",()=>{
   dispatched.push(account);
   const id=`response_${dispatched.length}`;
   socket.send(JSON.stringify({type:"response.created",response:{id}}));
   socket.send(JSON.stringify({type:"codex.rate_limits",plan_type:"pro",rate_limits:{secondary:{used_percent:dispatched.length===1?80:95,reset_at:Math.floor(now/1000)+7200}}}));
   socket.send(JSON.stringify({type:"response.completed",response:{id,output:[]}}));
  });
 });
 upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
 const address=upstream.address();if(!address||typeof address==="string")throw Error("No address");
 const entry=(used:number,hours:number)=>({status:200,updatedAt:now,planType:"pro",model:"common",primary:{},secondary:{usedPercent:used,resetAtMs:now+hours*3600000}});
 const manager=new AccountManager(undefined,createStorage(now));
 const proxy=await startProxy({accountManager:manager,fetchImpl:async()=>Response.json({models:[{slug:"common"}]}),options:{nativeOpenai:true,now:()=>now,quotaRemainingPercentThreshold:undefined,upstreamBaseUrl:`http://127.0.0.1:${address.port}`,readSubscriptionQuota:async()=>({byAccountId:{acc_1:entry(50,24),acc_2:entry(60,2)},byEmail:{}}),readApiRoutes:async()=>[{id:"paid",label:"API",kind:"api",apiKey:"fixture-paid",enabled:true,priority:0,visibleModels:["common"]}]}});
 const client=new WebSocket(proxy.baseUrl.replace("http:","ws:")+"/responses",{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`}});
 try {
  await once(client,"open");
  for(let i=0;i<3;i++){
   await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{client.off("message",onMessage);reject(Error("Response timeout"));},5000);
    const onMessage=(raw:import("ws").RawData)=>{const event=JSON.parse(raw.toString());if(event.type==="response.completed"||event.type==="error"){clearTimeout(timer);client.off("message",onMessage);event.type==="error"?reject(Error("Unexpected error")):resolve();}};
    client.on("message",onMessage);
    client.send(JSON.stringify({type:"response.create",model:"common",input:[]}));
   });
  }
  expect(dispatched).toEqual(["acc_2","acc_2","acc_1"]);
  expect(connections).toBe(2);
  expect(proxy.getStatus()).toMatchObject({streamQuotaUpdates:3,lastStreamQuotaUpdateAt:now});
 } finally {
  client.terminate();await proxy.close();
  for(const socket of wss.clients)socket.terminate();
  wss.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
 }
});

it("serves native picker models within its deadline while a slow workspace finishes in the background", async () => {
 const manager=new AccountManager(undefined,createStorage(Date.now()));
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const reads:string[]=[];
 const proxy=await startProxy({accountManager:manager,fetchImpl:async(input,init)=>{
  if(String(input).includes("api.openai.com"))return Response.json({data:[{id:"api-fixture"}]});
  const id=new Headers(init?.headers).get("chatgpt-account-id")!;reads.push(id);
  if(id==="acc_2")await gate;
  return Response.json({models:[{slug:id==="acc_1"?"specialized-fixture":"late-model"}]});
 },options:{nativeOpenai:true,readApiRoutes:async()=>[{id:"fixture",label:"ZDR",kind:"zdr",apiKey:"fixture-key",enabled:true,priority:9,visibleModels:["api-fixture"]}]}});
 try{
  const response=await fetch(`${proxy.baseUrl}/models?client_version=1.0.0`,{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`},signal:AbortSignal.timeout(4000)});
  expect(response.status).toBe(200);
  expect((await response.json()).models.map((m:{slug:string})=>m.slug)).toEqual(["specialized-fixture","zdr/api-fixture"]);
  release();
  const full=await getModels(proxy,"/models?client_version=1.0.0");
  expect((await full.json()).models.map((m:{slug:string})=>m.slug)).toEqual(["specialized-fixture","late-model","zdr/api-fixture"]);
  expect(reads).toEqual(["acc_1","acc_2"]);
 }finally{release();}
});

it("keeps independent warm catalogs for desktop and CLI versions",async()=>{
 const manager=new AccountManager(undefined,createStorage(Date.now()));const versions:string[]=[];
 const proxy=await startProxy({accountManager:manager,fetchImpl:async input=>{const version=new URL(String(input)).searchParams.get("client_version")!;versions.push(version);return Response.json({models:[{slug:`model-${version}`}]});},options:{nativeOpenai:true}});
 for(const version of ["1.0","2.0","1.0"]){const r=await getModels(proxy,`/models?client_version=${version}`);expect((await r.json()).models.map((m:{slug:string})=>m.slug)).toEqual([`model-${version}`]);}
 expect(versions).toEqual(["1.0","1.0","2.0","2.0"]);
});

it("returns a warm picker cache immediately while expired workspace data refreshes",async()=>{
 let now=Date.now(),slow=false,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});let reads=0;
 const proxy=await startProxy({accountManager:new AccountManager(undefined,createStorage(now)),fetchImpl:async()=>{reads++;if(slow)await gate;return Response.json({models:[{slug:slow?"new-model":"old-model"}]});},options:{nativeOpenai:true,now:()=>now}});
 await (await getModels(proxy, "/models")).text();slow=true;now+=6*60_000;
 try{
  const r=await fetch(`${proxy.baseUrl}/models`,{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`},signal:AbortSignal.timeout(10000)});
  expect((await r.json()).models.map((m:{slug:string})=>m.slug)).toEqual(["old-model"]);
  expect(reads).toBe(4);
 }finally{release();}
});

it("keeps the live manager and its catalogs when stored emails differ only in case",async()=>{
 const disk=createStorage(Date.now(),1);disk.accounts[0]!.email="Account-1@Example.com";
 const manager=new AccountManager(undefined,disk);let catalogReads=0;
 const {fetchImpl}=createRecordingFetch(call=>{if(call.url.includes("/models")){catalogReads++;return Response.json({models:[{slug:"common"}]});}return textEventStream();});
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(disk)}});
 for(let i=0;i<2;i++){const response=await postResponses(proxy,{model:"common",input:"fixture"});expect(response.status).toBe(200);await response.text();}
 expect(catalogReads).toBe(1);
});

it("reads the subscription quota cache at most once per second across native requests",async()=>{
 const manager=new AccountManager(undefined,createStorage(Date.now()));
 const readSubscriptionQuota=vi.fn(async()=>null);
 const {fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):textEventStream());
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readSubscriptionQuota}});
 for(let i=0;i<3;i++){const response=await postResponses(proxy,{model:"common",input:"fixture"});expect(response.status).toBe(200);await response.text();}
 expect(readSubscriptionQuota).toHaveBeenCalledTimes(1);
});

it("keeps session affinity when the client disconnects mid-stream",async()=>{
 const forget=vi.spyOn(SessionAffinityStore.prototype,"forgetSession");
 const manager=new AccountManager(undefined,createStorage(Date.now(),2));
 const failure=vi.spyOn(manager,"recordFailure");
 let cancelled=false;
 const {fetchImpl}=createRecordingFetch(()=>new Response(new ReadableStream<Uint8Array>({
  start(controller){controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"r"}}\n\n'));},
  cancel(){cancelled=true;},
 }),{headers:{"content-type":"text/event-stream"}}));
 const proxy=await startProxy({accountManager:manager,fetchImpl});
 const response=await postResponses(proxy,{model:"gpt-5-codex",input:"fixture",stream:true},"/responses",{session_id:"affinity-session"});
 const reader=response.body!.getReader();await reader.read();await reader.cancel();
 await vi.waitFor(()=>expect(cancelled).toBe(true));
 await new Promise(resolve=>setTimeout(resolve,50));
 expect(forget).not.toHaveBeenCalled();
 expect(failure).not.toHaveBeenCalled();
 forget.mockRestore();
});

describe("learned limits across a native inventory rebuild",()=>{
 const tokenFor=(workspace:string)=>{
  const part=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({alg:"none"})}.${part({"https://api.openai.com/auth":{chatgpt_account_id:workspace}})}.sig`;
 };
 it("keeps a 429 window on the account that earned it when identity-less rows are reordered",async()=>{
  const storage=createStorage(Date.now(),2);
  storage.accounts.forEach((account,index)=>{delete account.accountId;delete account.email;account.accessToken=tokenFor(`ws_${index+1}`);});
  const manager=new AccountManager(undefined,structuredClone(storage));
  manager.markRateLimited(manager.getAccountByIndex(0)!,10*60_000,getModelFamily("common"),"common");
  const disk=structuredClone(storage);disk.accounts.reverse();
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(disk)}});
  const response=await postResponses(proxy,{model:"common",input:"fixture"});
  expect(response.status).toBe(200);await response.text();
  expect(calls.filter(c=>c.url.endsWith("/responses")).map(c=>c.headers.get("chatgpt-account-id"))).toEqual(["ws_2"]);
 });
 it("carries a 429 window by stored record id when the email changes",async()=>{
  const storage=createStorage(Date.now(),2);storage.accounts.forEach((account,index)=>{account.recordId=`record-${index+1}`;});
  const manager=new AccountManager(undefined,structuredClone(storage));
  manager.markRateLimited(manager.getAccountByIndex(0)!,10*60_000,getModelFamily("common"),"common");
  // Renamed in place plus a new login appended: the inventory changes, the record does not.
  const disk=structuredClone(storage);disk.accounts[0]!.email="renamed@example.com";
  disk.accounts.push({...structuredClone(storage.accounts[1]!),recordId:"record-3",accountId:"acc_3",email:"account-3@example.com",refreshToken:"refresh-3",accessToken:"access-3"});
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(disk)}});
  for(let i=0;i<4;i++){const response=await postResponses(proxy,{model:"common",input:"fixture"});expect(response.status).toBe(200);await response.text();}
  expect(calls.filter(c=>c.url.endsWith("/responses")).map(c=>c.headers.get("chatgpt-account-id"))).not.toContain("acc_1");
 });
 it("carries a 429 window across a re-login that changes the refresh token",async()=>{
  const storage=createStorage(Date.now(),2);
  const manager=new AccountManager(undefined,structuredClone(storage));
  manager.markRateLimited(manager.getAccountByIndex(0)!,10*60_000,getModelFamily("common"),"common");
  const disk=structuredClone(storage);
  disk.accounts[0]!.refreshToken="refresh-after-relogin";disk.accounts[0]!.accessToken="access-after-relogin";
  disk.accounts.reverse();
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(disk)}});
  const response=await postResponses(proxy,{model:"common",input:"fixture"});
  expect(response.status).toBe(200);await response.text();
  expect(calls.filter(c=>c.url.endsWith("/responses")).map(c=>c.headers.get("chatgpt-account-id"))).toEqual(["acc_2"]);
 });
});

describe("pre-dispatch eligibility re-read",()=>{
 const tokenFor=(workspace:string)=>{
  const part=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({alg:"none"})}.${part({"https://api.openai.com/auth":{chatgpt_account_id:workspace}})}.sig`;
 };
 it.each([["no stored account id",undefined],["a padded account id"," acc_token "]])("routes an account with %s through Responses and images",async(_label,stored)=>{
  const storage=createStorage(Date.now(),1);const account=storage.accounts[0]!;
  account.accessToken=tokenFor("acc_token");
  if(stored===undefined)delete account.accountId;else account.accountId=stored;
  const manager=new AccountManager(undefined,structuredClone(storage));
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"common"}]}):call.url.includes("/images/")?Response.json({data:[]}):textEventStream());
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(storage)}});
  const responses=await postResponses(proxy,{model:"common",input:"fixture"});
  expect(responses.status).toBe(200);await responses.text();
  const image=await postResponses(proxy,{model:"gpt-image-2",prompt:"fixture"},"/images/generations");
  expect(image.status).toBe(200);await image.text();
  const dispatched=calls.filter(c=>!c.url.includes("/models"));
  expect(dispatched).toHaveLength(2);
  expect(dispatched.every(c=>c.headers.get("chatgpt-account-id")==="acc_token")).toBe(true);
 });
});

describe("request-level capability rejections",()=>{
 const reject=()=>Response.json({error:{code:"invalid_value",param:"reasoning.effort",message:"Unsupported effort fixture"}},{status:400});
 const catalog=()=>Response.json({models:[{slug:"common",supported_reasoning_levels:[{effort:"ultra"}]}]});
 const rejectNumbered=(n:number)=>Response.json({error:{code:"invalid_value",param:"reasoning.effort",message:`Unsupported effort fixture ${n}`}},{status:400});
 const run=async(storage:AccountStorageV3,respond:(n:number)=>Response)=>{
  const manager=new AccountManager(undefined,storage);let n=0;
  const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?catalog():respond(++n));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await postResponses(proxy,{model:"common",reasoning:{effort:"ultra"},input:"fixture"});
  return {response,inference:calls.filter(c=>c.url.endsWith("/responses"))};
 };
 it("keeps trying distinct workspaces and succeeds on the third",async()=>{
  const {response,inference}=await run(createStorage(Date.now(),3),n=>n<3?rejectNumbered(n):textEventStream());
  expect(response.status).toBe(200);await response.text();
  expect(inference).toHaveLength(3);
  expect(new Set(inference.map(c=>c.headers.get("chatgpt-account-id"))).size).toBe(3);
 });
 it("tries a workspace shared by two accounts only once",async()=>{
  const storage=createStorage(Date.now(),2);for(const account of storage.accounts)account.accountId="shared_workspace";
  const {response,inference}=await run(storage,n=>rejectNumbered(n));
  expect(response.status).toBe(400);await response.text();
  expect(inference).toHaveLength(1);
 });
 it("reports a 429 that follows a capability rejection instead of the stale 400",async()=>{
  const {response,inference}=await run(createStorage(Date.now(),2),n=>n===1?rejectNumbered(n):new Response(JSON.stringify({error:{code:"rate_limit_exceeded"}}),{status:429,headers:{"content-type":"application/json","retry-after":"30"}}));
  expect(response.status).not.toBe(400);
  const body=await response.json();
  expect(body.error.code).toBe("codex_runtime_rotation_pool_exhausted");
  expect(body.error.reason).toBe("rate-limit");
  expect(inference).toHaveLength(2);
 });
 it("forwards the last upstream 400 when every workspace rejects the setting",async()=>{
  const {response,inference}=await run(createStorage(Date.now(),3),n=>rejectNumbered(n));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatchObject({code:"invalid_value",param:"reasoning.effort",message:"Unsupported effort fixture 3"});
  expect(inference).toHaveLength(3);
 });
 it("forwards a capability 400 unchanged on a non-native proxy without rotating",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now(),3));
  const {calls,fetchImpl}=createRecordingFetch(()=>reject());
  const proxy=await startProxy({accountManager:manager,fetchImpl});
  const response=await postResponses(proxy,{model:"gpt-5-codex",reasoning:{effort:"ultra"},input:"fixture"});
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_value");
  expect(calls.filter(c=>c.url.endsWith("/responses"))).toHaveLength(1);
 });
});

describe('earned reset last-resort integration',()=>{
 it('never redeems or moves traffic off a stored native pin',async()=>{
  vi.spyOn(storageMetaModule,"readStorageMetaFromDisk").mockReturnValue({pinnedAccountIndex:0,affinityGeneration:1});
  const {createResetCreditService}=await import('../lib/runtime/account-reset-credits.js');
  const native=await import('../lib/runtime/native-rate-limits.js');
  let consumptions=0;
  const rpc=vi.spyOn(native,'nativeRateLimitsRpc').mockImplementation(async(auth,method)=>{
   if(method==='account/rateLimitResetCredit/consume'){consumptions++;return {outcome:'reset'};}
   const allowed=auth.accountId==='acc_2';
   return {accountId:auth.accountId,ordinaryUsageAllowed:allowed,rateLimitResetCredits:{availableCount:1},rateLimits:{planType:'pro',primary:{usedPercent:allowed?0:100,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:0}}};
  });
  const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const originalDir=process.env.CODEX_MULTI_AUTH_DIR;const testDir=await fs.mkdtemp(path.join(os.tmpdir(),'reset-route-pin-'));process.env.CODEX_MULTI_AUTH_DIR=testDir;
  const service=createResetCreditService();await service.setPolicy('last-resort');
  try{
   const manager=new AccountManager(undefined,createStorage(Date.now()));
   const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:'chat-fixture'}]}):textEventStream());
   const quota={updatedAt:Date.now(),status:200,model:'chat-fixture',planType:'pro',primary:{usedPercent:100},secondary:{usedPercent:0}};
   const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readSubscriptionQuota:async()=>({byAccountId:{acc_1:quota,acc_2:quota},byEmail:{}})}});
   const response=await postResponses(proxy,{model:'chat-fixture',input:'hello'});await response.text();
   expect(consumptions).toBe(0);
   expect(calls.filter(c=>c.url.endsWith('/responses')).every(c=>c.headers.get('chatgpt-account-id')==='acc_1')).toBe(true);
  }finally{await service.setPolicy('manual');rpc.mockRestore();if(originalDir===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=originalDir;await fs.rm(testDir,{recursive:true,force:true,maxRetries:5});}
 });
 it.each([true,false])('refreshes all subscription capacity before spending (other usable=%s)',async otherUsable=>{
  const {createResetCreditService}=await import('../lib/runtime/account-reset-credits.js');
  const native=await import('../lib/runtime/native-rate-limits.js');
  let redeemed=false;let consumptions=0;
  const rpc=vi.spyOn(native,'nativeRateLimitsRpc').mockImplementation(async(auth,method)=>{
   if(method==='account/rateLimitResetCredit/consume'){redeemed=true;consumptions++;return {outcome:'reset'};}
   const allowed=(otherUsable&&auth.accountId==='acc_2')||(redeemed&&auth.accountId==='acc_1');
   return {accountId:auth.accountId,ordinaryUsageAllowed:allowed,rateLimitResetCredits:{availableCount:redeemed?0:1},rateLimits:{planType:'pro',primary:{usedPercent:allowed?0:100,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:0}}};
  });
  const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const originalDir=process.env.CODEX_MULTI_AUTH_DIR;const testDir=await fs.mkdtemp(path.join(os.tmpdir(),'reset-route-integration-'));process.env.CODEX_MULTI_AUTH_DIR=testDir;
  const service=createResetCreditService();await service.setPolicy('last-resort');
  try{
   const disk=createStorage(Date.now());const stored=await import("../lib/storage.js");const diskSpy=vi.spyOn(stored,"loadAccounts").mockResolvedValue(disk);
   const manager=new AccountManager(undefined,disk);
   const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:'chat-fixture'}]}):textEventStream());
   const quota={updatedAt:Date.now(),status:200,model:'chat-fixture',planType:'pro',primary:{usedPercent:100},secondary:{usedPercent:0}};
   const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readSubscriptionQuota:async()=>({byAccountId:{acc_1:quota,acc_2:quota},byEmail:{}})}});
   const response=await postResponses(proxy,{model:'chat-fixture',input:'hello'});expect(response.status).toBe(200);await response.text();
   diskSpy.mockRestore();
   expect(consumptions).toBe(otherUsable?0:1);
   expect(calls.find(c=>c.url.endsWith('/responses'))?.headers.get('chatgpt-account-id')).toBe(otherUsable?'acc_2':'acc_1');
  }finally{await service.setPolicy('manual');rpc.mockRestore();if(originalDir===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=originalDir;await fs.rm(testDir,{recursive:true,force:true,maxRetries:5});}
 });
});

describe("independent transport review",()=>{
 it.each(["cancel-before", "close-before", "cancel-after"])("does not replay or penalize accounts after %s",async mode=>{
  const upstream=createServer(),wss=new WebSocketServer({server:upstream});let count=0,received!:()=>void,closed!:()=>void;
  const requestReceived=new Promise<void>(r=>received=r),upstreamClosed=new Promise<void>(r=>closed=r);
  wss.on('connection',socket=>{socket.once('close',()=>closed());socket.on('message',()=>{count++;if(mode==='cancel-after')socket.send(JSON.stringify({type:'response.created',response:{id:'fixture-response'}}));received();});});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const address=upstream.address();if(!address||typeof address==='string')throw Error('listen');
  const manager=new AccountManager(undefined,createStorage(Date.now(),2));
  const {fetchImpl}=createRecordingFetch(()=>Response.json({models:[{slug:'model-test'}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,upstreamBaseUrl:`http://127.0.0.1:${address.port}`,readApiRoutes:async()=>[]}});
  const models=await getModels(proxy);await models.text();
  const client=new WebSocket(proxy.baseUrl.replace('http:','ws:')+'/responses',{headers:{authorization:`Bearer ${DEFAULT_CLIENT_API_KEY}`}});
  try {
   await once(client,'open');const event=mode==='cancel-after'?once(client,'message'):Promise.resolve();
   client.send(JSON.stringify({type:'response.create',model:'model-test',input:[]}));await requestReceived;await event;
   if(mode==='close-before')client.terminate();else client.send(JSON.stringify({type:'response.cancel'}));
   await upstreamClosed;await new Promise(r=>setTimeout(r,80));
   expect(count).toBe(1);expect(proxy.getStatus().retries).toBe(0);
   expect(manager.getAccountsSnapshot().map(a=>a.cooldownReason)).toEqual([undefined,undefined]);
  } finally {client.terminate();for(const socket of wss.clients)socket.terminate();wss.close();await new Promise<void>(r=>upstream.close(()=>r()));}
 });
 it("keeps OAuth model discovery available when API configuration is invalid",async()=>{
  const manager=new AccountManager(undefined,createStorage(Date.now(),1));const {fetchImpl}=createRecordingFetch(()=>Response.json({models:[{slug:'model-test'}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>{throw Error('fixture invalid config');}}});
  const response=await getModels(proxy);expect(response.status).toBe(200);expect((await response.json()).models.map((m:{slug:string})=>m.slug)).toEqual(['model-test']);
 });
});
it("does not admit an unsupported workspace through a shared missing-binding key",async()=>{
 const stored=createStorage(Date.now(),2);
 stored.accounts.forEach((a,i)=>{delete a.accountId;a.workspaces=[{id:`workspace-${i}`,enabled:true}];a.currentWorkspaceIndex=0;});
 const manager=new AccountManager(undefined,stored);
 const {fetchImpl}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:call.headers.get('chatgpt-account-id')==='workspace-1'?'model-test':'other'}]}):textEventStream());
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>[]}});
 const models=await getModels(proxy);await models.text();
 const refresh=vi.spyOn(tokenRefreshRuntime,'ensureFreshAccessToken');
 try {const response=await postResponses(proxy,{model:'model-test',input:[]});await response.text();expect(response.status).toBe(200);
 expect(refresh.mock.calls.filter(([args])=>args.model==='model-test').map(([args])=>args.account.index)).toEqual([1]);}
 finally{refresh.mockRestore();}
});

describe("independent review catalog regressions",()=>{
 it.each([false,true])("retains catalog cache and backoff across client versions (limited=%s)",async limited=>{
  const manager=new AccountManager(undefined,createStorage(Date.now(),1));
  const {fetchImpl,calls}=createRecordingFetch(call=>limited?new Response("busy",{status:429,headers:{"retry-after":"120"}}):Response.json({models:[{slug:`model-${new URL(call.url).searchParams.get("client_version")}`}]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  for(const version of ["1.0","2.0","1.0","2.0"]){const response=await getModels(proxy,`/models?client_version=${version}`);await response.text();}
  expect(calls).toHaveLength(limited?1:2);
 });
 it("does not refresh an invalidated account for catalog discovery",async()=>{
  const stored=createStorage(Date.now(),1);stored.accounts[0]!.authInvalidatedAt=Date.now();stored.accounts[0]!.expiresAt=0;
  const manager=new AccountManager(undefined,stored);
  const {fetchImpl}=createRecordingFetch(()=>Response.json({models:[]}));
  const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
  const response=await getModels(proxy);await response.text();
  expect(refreshAccessTokenMock).not.toHaveBeenCalled();
 });
});
it("requires fresh eligibility when stale recovery reorders the account inventory",async()=>{
 const disk=createStorage(Date.now(),2),manager=new AccountManager(undefined,disk);
 manager.markAccountCoolingDown(manager.getAccountByIndex(1)!,60000,'network-error');
 const reordered=structuredClone(disk);reordered.accounts.reverse();
 const reload=vi.spyOn(AccountManager,'loadFromDisk').mockResolvedValue(new AccountManager(undefined,reordered));
 const {fetchImpl,calls}=createRecordingFetch(call=>call.url.includes('/models')?Response.json({models:[{slug:call.headers.get('authorization')==='Bearer access-2'?'model-test':'other'}]}):textEventStream());
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readApiRoutes:async()=>[]}});
 try{const response=await postResponses(proxy,{model:'model-test',input:[]});await response.text();expect(response.status).toBe(503);expect(calls.filter(c=>c.url.endsWith('/responses'))).toHaveLength(0);}finally{reload.mockRestore();}
});


describe("native catalog outage with reasoning settings", () => {
	it("routes an effort-bearing request while the catalog is rate limited", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 1));
		const { fetchImpl, calls } = createRecordingFetch(call => call.url.includes("/models")
			? new Response("busy", { status: 429, headers: { "retry-after": "120" } })
			: textEventStream());
		const proxy = await startProxy({ accountManager: manager, fetchImpl, options: { nativeOpenai: true } });
		const response = await postResponses(proxy, { model: "model-test", reasoning: { effort: "high" }, service_tier: "priority", input: "test" });
		await response.text();
		expect(response.status).toBe(200);
		expect(calls.some(c => c.url.endsWith("/responses"))).toBe(true);
	});
});

describe("effort-bearing requests during catalog outages", () => {
 it("forwards unchanged reasoning settings while discovery is throttled", async () => {
  let now = Date.now();
  const manager = new AccountManager(undefined, createStorage(now,1));
  const {fetchImpl,calls} = createRecordingFetch(call => call.url.includes("/models")
   ? new Response("busy",{status:429,headers:{"retry-after":"120"}})
   : textEventStream());
  const proxy = await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,now:()=>now}});
  for (const advance of [0,6000,6000]) {
   now += advance;
   const response = await postResponses(proxy,{model:"model-test",reasoning:{effort:"high"},service_tier:"priority",input:"test"});
   await response.text();expect(response.status).toBe(200);
  }
  expect(calls.filter(call=>call.url.includes("/models"))).toHaveLength(1);
  expect(calls.filter(call=>call.url.endsWith("/responses"))).toHaveLength(3);
  for (const call of calls.filter(call=>call.url.endsWith("/responses"))) expect(JSON.parse(call.bodyText)).toMatchObject({reasoning:{effort:"high"},service_tier:"priority"});
 });
});

describe("unversioned catalog requests", () => {
	it("does not borrow another client's catalog version", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 1));
		const { fetchImpl } = createRecordingFetch(call => {
			if (!call.url.includes("/models")) return textEventStream();
			const version = new URL(call.url).searchParams.get("client_version");
			return Response.json({ models: [{ slug: version === "2.0" ? "model-new" : "model-old" }] });
		});
		const proxy = await startProxy({ accountManager: manager, fetchImpl, options: { nativeOpenai: true } });
		const versioned = await getModels(proxy, "/models?client_version=2.0");
		expect((await versioned.json()).models.map((m: { slug: string }) => m.slug)).toEqual(["model-new"]);
		const unversioned = await postResponses(proxy, { model: "model-old", input: "test" });
		await unversioned.text();
		expect(unversioned.status).toBe(200);
	});
});


it("retains known exclusions when a forced catalog refresh fails",async()=>{
 const manager=new AccountManager(undefined,createStorage(Date.now()));
 let fail=false;
 const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")
  ?fail?new Response("busy",{status:503}):Response.json({models:[{slug:"known"}]})
  :textEventStream('data: {"type":"response.completed","response":{}}\n\n'));
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true}});
 await (await getModels(proxy,"/models?refresh_capabilities=1")).text();
 fail=true;
 await (await getModels(proxy,"/models?refresh_capabilities=1")).text();
 const response=await postResponses(proxy,{model:"unknown",input:"hello"});
 expect(response.status).toBe(403);await response.text();
 expect(calls.filter(c=>c.url.endsWith("/responses"))).toHaveLength(0);
});
it("stops a stored pin after refresh disables its only workspace",async()=>{
 vi.spyOn(storageMetaModule,"readStorageMetaFromDisk").mockReturnValue({pinnedAccountIndex:0,affinityGeneration:1});
 const stored=createStorage(Date.now(),1);stored.pinnedAccountIndex=0;
 stored.accounts[0]!.workspaces=[{id:"acc_1",enabled:true}];
 const manager=new AccountManager(undefined,stored);
 const {calls,fetchImpl}=createRecordingFetch(call=>call.url.includes("/models")?Response.json({models:[{slug:"shared"}]}):textEventStream());
 const proxy=await startProxy({accountManager:manager,fetchImpl,options:{nativeOpenai:true,readNativeAccountStorage:async()=>structuredClone(stored)}});
 await (await getModels(proxy,"/models?refresh_capabilities=1")).text();
 const refresh=vi.spyOn(tokenRefreshRuntime,"ensureFreshAccessToken").mockImplementation(async({account})=>{
  account.workspaces![0]!.enabled=false;
  return {ok:true,accessToken:account.access!,account};
 });
 const response=await postResponses(proxy,{model:"shared",input:"hello"});
 const body=await response.json();
 expect(response.status).toBe(503);expect(body.error.reason).toBe("workspace-disabled");
 expect(refresh).toHaveBeenCalledTimes(1);
 expect(calls.filter(c=>c.url.endsWith("/responses"))).toHaveLength(0);
});
