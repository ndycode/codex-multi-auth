import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { HTTP_STATUS, OPENAI_HEADERS } from "../lib/constants.js";
import {
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
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
				},
			)
		).text();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("accept")).toBe("application/json");
		expect(calls[0]?.headers.get("x-custom-trace")).toBe("trace-1");
		expect(calls[0]?.headers.get("connection")).toBeNull();
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[0]?.headers.get("x-api-key")).toBeNull();
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
			hint: "Run `codex auth rotation status` to inspect account state.",
		});
		expect(payload.error.retry_after_ms).toBeGreaterThan(0);
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
});
