import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { isModelAtCapacityError } from "../lib/request/error-classification.js";
import {
	normalizeModelCapacityRetryMs,
	resetPinCacheForTesting,
	resolveModelCapacityRetryMs,
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";

const { saveAccountsMock, withAccountStorageTransactionMock } = vi.hoisted(
	() => ({
		saveAccountsMock: vi.fn(),
		withAccountStorageTransactionMock: vi.fn(),
	}),
);

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

const CLIENT_API_KEY = "runtime-secret";
const openServers: RuntimeRotationProxyServer[] = [];
const tmpDirs: string[] = [];

function createStorage(count: number): AccountStorageV3 {
	const now = Date.now();
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
			addedAt: now - 60_000 - index,
			lastUsed: now - 60_000,
			enabled: true,
		})),
	};
}

function storagePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "issue-689-"));
	tmpDirs.push(dir);
	return join(dir, "openai-codex-accounts.json");
}

const CAPACITY_BODY = JSON.stringify({
	error: {
		message: "The selected model is at capacity. Please try again later.",
		type: "server_error",
	},
});

function capacityResponse(status: number): Response {
	return new Response(CAPACITY_BODY, {
		status,
		headers: { "content-type": "application/json" },
	});
}

function streamResponse(): Response {
	return new Response("data: {}\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** fetch stub that returns each scripted response once, then the last forever. */
function scriptedFetch(responses: (() => Response)[]): {
	fetchImpl: typeof fetch;
	calls: () => number;
	authHeaders: () => string[];
} {
	let index = 0;
	const seenAuth: string[] = [];
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		const headers = new Headers(init?.headers ?? {});
		seenAuth.push(headers.get("authorization") ?? "");
		const make = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (!make) throw new Error("no scripted response");
		return make();
	}) as unknown as typeof fetch;
	return { fetchImpl, calls: () => index, authHeaders: () => [...seenAuth] };
}

async function postResponses(
	proxy: RuntimeRotationProxyServer,
): Promise<Response> {
	return fetch(`${proxy.baseUrl}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${CLIENT_API_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: "gpt-5.6", input: "hi" }),
	});
}

beforeEach(() => {
	resetPinCacheForTesting();
	saveAccountsMock.mockReset();
	saveAccountsMock.mockResolvedValue(undefined);
	withAccountStorageTransactionMock.mockReset();
	withAccountStorageTransactionMock.mockImplementation(async (handler) =>
		handler(null, async () => undefined),
	);
	delete process.env.CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS;
});

afterEach(async () => {
	for (const proxy of openServers.splice(0, openServers.length)) {
		await proxy.close();
	}
	resetPinCacheForTesting();
	setStoragePathDirect(null);
	vi.restoreAllMocks();
	delete process.env.CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS;
	for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("isModelAtCapacityError", () => {
	it.each([
		"The selected model is at capacity. Please try again later.",
		'{"error":{"code":"model_capacity_exceeded"}}',
		'{"error":{"code":"capacity_exceeded"}}',
		"This model is currently overloaded, please try again",
		'{"error":{"type":"overloaded_error"}}',
		'{"error":{"code":"slow_down"}}',
	])("matches a capacity response: %s", (body) => {
		expect(isModelAtCapacityError(429, body)).toBe(true);
		expect(isModelAtCapacityError(503, body)).toBe(true);
	});

	it.each([
		'{"error":{"message":"Rate limit reached for requests"}}',
		'{"error":{"code":"usage_limit_reached"}}',
		'{"error":{"code":"model_not_supported_with_chatgpt_account"}}',
		"Internal server error",
		"",
	])("does not match an unrelated response: %s", (body) => {
		expect(isModelAtCapacityError(429, body)).toBe(false);
		expect(isModelAtCapacityError(500, body)).toBe(false);
	});

	it.each([401, 402, 403, 404])(
		"never treats status %i as capacity, whatever the body says",
		(status) => {
			// These are terminal for the request and each has its own branch
			// upstream of the capacity check. Retrying them would spin to the
			// deadline for nothing.
			expect(isModelAtCapacityError(status, CAPACITY_BODY)).toBe(false);
		},
	);
});

describe("resolveModelCapacityRetryMs", () => {
	it("defaults to ten minutes when unset", () => {
		expect(resolveModelCapacityRetryMs({})).toBe(600_000);
	});

	it("treats 0 as disabled", () => {
		expect(
			resolveModelCapacityRetryMs({
				CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS: "0",
			}),
		).toBe(0);
	});

	it("clamps to one hour", () => {
		expect(
			resolveModelCapacityRetryMs({
				CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS: "99999999",
			}),
		).toBe(3_600_000);
	});

	it.each(["abc", "-1", "NaN", " "])(
		"falls back to the default rather than disabling for %s",
		(value) => {
			// A typo must not silently turn the feature off.
			expect(
				resolveModelCapacityRetryMs({
					CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS: value,
				}),
			).toBe(600_000);
		},
	);
});

describe("normalizeModelCapacityRetryMs", () => {
	// An explicit `modelCapacityRetryMs` option would otherwise bypass the cap
	// the env var is held to, letting a caller disable the feature with a
	// negative value or hold a request past the documented one-hour maximum.
	it.each([
		[-1, 600_000],
		[Number.NaN, 600_000],
		[Number.POSITIVE_INFINITY, 600_000],
		["600000" as unknown as number, 600_000],
		[undefined as unknown as number, 600_000],
		[99_999_999, 3_600_000],
		[1_234.9, 1_234],
		[0, 0],
	])("normalizes %s to %i", (input, expected) => {
		expect(normalizeModelCapacityRetryMs(input)).toBe(expected);
	});
});

describe("runtime proxy waits out a model-capacity response", () => {
	it.each([429, 503])(
		"retries after a %i capacity response and succeeds without penalizing the account",
		async (status) => {
			const path = storagePath();
			const storage = createStorage(2);
			writeFileSync(path, JSON.stringify(storage), "utf8");
			setStoragePathDirect(path);

			const accountManager = new AccountManager(undefined, storage);
			const { fetchImpl, calls, authHeaders } = scriptedFetch([
				() => capacityResponse(status),
				() => streamResponse(),
			]);

			const proxy = await startRuntimeRotationProxy({
				accountManager,
				fetchImpl,
				upstreamBaseUrl: "https://example.test/backend-api",
				clientApiKey: CLIENT_API_KEY,
				// Smaller than the first backoff step, so the wait is clamped to
				// the remaining budget and the test spends 50ms, not 2s.
				modelCapacityRetryMs: 50,
			});
			openServers.push(proxy);

			const refundSpy = vi.spyOn(accountManager, "refundToken");
			const response = await postResponses(proxy);

			expect(response.status).toBe(200);
			expect(calls()).toBe(2);
			// Both attempts must carry managed credentials. The retry re-enters
			// normal selection rather than forcing the same account (capacity is
			// model-wide, so no account is a better bet), but it must never go
			// upstream unauthenticated.
			const auth = authHeaders();
			expect(auth).toHaveLength(2);
			for (const header of auth) {
				expect(header).toMatch(/^Bearer .+/i);
			}
			// The account is not at fault, so it must not be left rate limited.
			const account = accountManager.getAccountByIndex(0);
			expect(account?.rateLimitResetTimes ?? {}).toEqual({});
			expect(account?.coolingDownUntil).toBeUndefined();
			// ...and the pool token the attempt debited must come back, or a
			// sustained capacity event drains healthy accounts until later
			// requests are refused admission with `token-exhausted`.
			expect(refundSpy).toHaveBeenCalled();
		},
	);

	it("refunds the pool token for every capacity retry, not just the first", async () => {
		const path = storagePath();
		const storage = createStorage(2);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl, calls } = scriptedFetch([
			() => capacityResponse(429),
			() => capacityResponse(503),
			() => streamResponse(),
		]);
		const refundSpy = vi.spyOn(accountManager, "refundToken");

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 120,
		});
		openServers.push(proxy);

		const response = await postResponses(proxy);

		expect(response.status).toBe(200);
		expect(calls()).toBe(3);
		expect(refundSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("stops waiting when the client disconnects mid-wait", async () => {
		// A capacity wait runs for tens of seconds. Re-sending an authenticated
		// upstream request for a response nobody is reading wastes upstream
		// capacity and keeps the token in flight longer than necessary.
		const path = storagePath();
		const storage = createStorage(1);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl, calls } = scriptedFetch([() => capacityResponse(503)]);

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			// Long enough that the first 2s backoff step is used in full, so the
			// abort below lands inside the wait rather than after it.
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 30_000,
		});
		openServers.push(proxy);

		const controller = new AbortController();
		const pending = fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${CLIENT_API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "gpt-5.6", input: "hi" }),
			signal: controller.signal,
		}).catch(() => undefined);

		await new Promise((resolve) => setTimeout(resolve, 250));
		controller.abort();
		await pending;
		await new Promise((resolve) => setTimeout(resolve, 2_500));

		// The upstream saw exactly the one attempt that produced the capacity
		// response. No second request was sent after the client went away.
		expect(calls()).toBe(1);
	}, 20_000);

	it("uses the backoff table when a capacity 429 carries no retry hint", async () => {
		// Regression: the 429 branch synthesizes a 60s fallback for ordinary rate
		// limits. Passing that synthesized value in as an upstream "hint" made
		// every hint-less capacity 429 wait a full minute and left the
		// 2s/5s/15s/30s backoff table dead on this path. With a 10s budget the
		// correct wait is the 2s first step; the bug would clamp 60s to 10s.
		const path = storagePath();
		const storage = createStorage(1);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl } = scriptedFetch([
			() => capacityResponse(429),
			() => streamResponse(),
		]);

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 10_000,
		});
		openServers.push(proxy);

		const startedAt = Date.now();
		const response = await postResponses(proxy);
		const elapsedMs = Date.now() - startedAt;

		expect(response.status).toBe(200);
		expect(elapsedMs).toBeLessThan(6_000);
	}, 20_000);

	it("honors an upstream retry hint over the backoff table", async () => {
		const path = storagePath();
		const storage = createStorage(1);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl } = scriptedFetch([
			() =>
				new Response(CAPACITY_BODY, {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after-ms": "40",
					},
				}),
			() => streamResponse(),
		]);

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 10_000,
		});
		openServers.push(proxy);

		const startedAt = Date.now();
		const response = await postResponses(proxy);
		const elapsedMs = Date.now() - startedAt;

		expect(response.status).toBe(200);
		// A 40ms hint must beat the 2s first backoff step.
		expect(elapsedMs).toBeLessThan(1_500);
	}, 20_000);

	it("clamps a huge upstream retry hint to the remaining deadline", async () => {
		// An upstream `retry-after` must never hold a request past the documented
		// ceiling. Without the clamp this would sleep for ~16 minutes.
		const path = storagePath();
		const storage = createStorage(1);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl } = scriptedFetch([
			() =>
				new Response(CAPACITY_BODY, {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after-ms": "999999",
					},
				}),
			() => streamResponse(),
		]);

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 300,
		});
		openServers.push(proxy);

		const startedAt = Date.now();
		const response = await postResponses(proxy);
		const elapsedMs = Date.now() - startedAt;

		expect(response.status).toBe(200);
		expect(elapsedMs).toBeLessThan(3_000);
	}, 20_000);

	it("gives up once the wall-clock budget is spent", async () => {
		const path = storagePath();
		const storage = createStorage(1);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl, calls } = scriptedFetch([() => capacityResponse(503)]);

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 50,
		});
		openServers.push(proxy);

		const response = await postResponses(proxy);

		// One capacity wait, then the budget is gone and normal handling ends the
		// request rather than hanging forever.
		expect(response.status).toBeGreaterThanOrEqual(500);
		expect(calls()).toBeGreaterThanOrEqual(2);
	});

	it("restores the pre-#689 behaviour when the budget is 0", async () => {
		const path = storagePath();
		const storage = createStorage(1);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl } = scriptedFetch([() => capacityResponse(429)]);

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 0,
		});
		openServers.push(proxy);

		await postResponses(proxy);

		// Disabled means the 429 is handled exactly as before: the account carries
		// the upstream rate-limit window.
		const account = accountManager.getAccountByIndex(0);
		expect(Object.keys(account?.rateLimitResetTimes ?? {}).length).toBeGreaterThan(
			0,
		);
	});

	it("does not wait on a non-capacity 429", async () => {
		const path = storagePath();
		const storage = createStorage(1);
		writeFileSync(path, JSON.stringify(storage), "utf8");
		setStoragePathDirect(path);

		const accountManager = new AccountManager(undefined, storage);
		const { fetchImpl } = scriptedFetch([
			() =>
				new Response(
					JSON.stringify({ error: { message: "Rate limit reached" } }),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
		]);

		const proxy = await startRuntimeRotationProxy({
			accountManager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_API_KEY,
			modelCapacityRetryMs: 600_000,
		});
		openServers.push(proxy);

		await postResponses(proxy);

		const account = accountManager.getAccountByIndex(0);
		expect(Object.keys(account?.rateLimitResetTimes ?? {}).length).toBeGreaterThan(
			0,
		);
	});
});
