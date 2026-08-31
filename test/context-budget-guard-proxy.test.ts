import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { HTTP_STATUS } from "../lib/constants.js";
import {
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import { __resetRoutingMutexForTests } from "../lib/routing-mutex.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import { resetTrackers } from "../lib/rotation.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const { refreshAccessTokenMock, saveAccountsMock, withAccountStorageTransactionMock } =
	vi.hoisted(() => ({
		refreshAccessTokenMock: vi.fn(),
		saveAccountsMock: vi.fn(),
		withAccountStorageTransactionMock: vi.fn(),
	}));

vi.mock("../lib/auth/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/auth.js")>();
	return { ...actual, refreshAccessToken: refreshAccessTokenMock };
});

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
const openManagers: AccountManager[] = [];

/**
 * 205k of carried context (input + non-reasoning output) against the 260k
 * estimate for the codex family: 78.8%, comfortably past the 69% default hard
 * threshold. The 60k of `reasoning_tokens` is deliberately large — it is in
 * `total_tokens` but is NOT resent as context next turn, so a guard that read
 * `total_tokens` would score this turn at 102% and a guard that reads
 * input+output scores it at 78.8%.
 */
const HEAVY_USAGE_STREAM =
	'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
	'data: {"type":"response.completed","response":{"usage":' +
	'{"input_tokens":200000,"input_tokens_details":{"cached_tokens":0},' +
	'"output_tokens":65000,"output_tokens_details":{"reasoning_tokens":60000},' +
	'"total_tokens":265000}}}\n\n';

function createStorage(now: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "account-1@example.com",
				accountId: "acc_1",
				refreshToken: "refresh-1",
				accessToken: "access-1",
				expiresAt: now + 3_600_000,
				addedAt: now - 60_000,
				lastUsed: now - 60_000,
				enabled: true,
			},
		],
	};
}

function createRecordingFetch(body: string): {
	calls: string[];
	fetchImpl: typeof fetch;
} {
	const calls: string[] = [];
	const fetchImpl: typeof fetch = async (input) => {
		calls.push(String(input));
		return new Response(body, {
			status: HTTP_STATUS.OK,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { calls, fetchImpl };
}

async function startProxy(
	accountManager: AccountManager,
	fetchImpl: typeof fetch,
): Promise<RuntimeRotationProxyServer> {
	openManagers.push(accountManager);
	const proxy = await startRuntimeRotationProxy({
		accountManager,
		fetchImpl,
		upstreamBaseUrl: "https://example.test/backend-api",
		clientApiKey: CLIENT_API_KEY,
		quotaRemainingPercentThreshold: 10,
	});
	openServers.push(proxy);
	return proxy;
}

async function postResponses(
	proxy: RuntimeRotationProxyServer,
	body: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
	const response = await fetch(`${proxy.baseUrl}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${CLIENT_API_KEY}`,
			"content-type": "application/json",
			"x-api-key": "caller-key",
		},
		body: JSON.stringify(body),
	});
	return { status: response.status, text: await response.text() };
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
	process.env.CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED = "true";
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
	delete process.env.CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED;
	delete process.env.CODEX_AUTH_CONTEXT_BUDGET_HARD_PCT;
});

describe("context budget guard on the rotation proxy path", () => {
	it("pauses the turn after a heavy one, then lets the turn after that through", async () => {
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(HEAVY_USAGE_STREAM);
		const proxy = await startProxy(accountManager, fetchImpl);
		const turn = { model: "gpt-5-codex", stream: true, prompt_cache_key: "sess-1" };

		const first = await postResponses(proxy, turn);
		expect(first.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);

		const paused = await postResponses(proxy, turn);
		expect(paused.status).toBe(HTTP_STATUS.OK);
		expect(paused.text).toContain("Context budget guard paused");
		// The whole point: no upstream round-trip was spent on it.
		expect(calls).toHaveLength(1);

		// The pause cannot forward its own request, so it can never observe a
		// lower number by itself. Before the snapshot was dropped on emit, this
		// third turn — and every turn after it, `/compact` included — was paused
		// too, and the session was dead until the proxy restarted.
		const third = await postResponses(proxy, turn);
		expect(third.status).toBe(HTTP_STATUS.OK);
		expect(third.text).not.toContain("Context budget guard paused");
		expect(calls).toHaveLength(2);
	});

	it("scores a turn on carried context, not on total_tokens", async () => {
		// 265k total_tokens against a 260k window is 102%; the 205k actually
		// resent next turn is 78.8%. Both cross the 69% default, so pin the
		// threshold between them: only the total_tokens reading would pause.
		process.env.CODEX_AUTH_CONTEXT_BUDGET_HARD_PCT = "90";
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(HEAVY_USAGE_STREAM);
		const proxy = await startProxy(accountManager, fetchImpl);
		const turn = { model: "gpt-5-codex", stream: true, prompt_cache_key: "sess-2" };

		await postResponses(proxy, turn);
		const second = await postResponses(proxy, turn);
		expect(second.text).not.toContain("Context budget guard paused");
		expect(calls).toHaveLength(2);
	});

	it("stays inert for a client identified only by previous_response_id", async () => {
		// That id changes every turn, so a guard keyed on it could never
		// accumulate — and would leak one map entry per request trying.
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(HEAVY_USAGE_STREAM);
		const proxy = await startProxy(accountManager, fetchImpl);

		await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			previous_response_id: "resp_a",
		});
		const second = await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			previous_response_id: "resp_a",
		});
		expect(second.text).not.toContain("Context budget guard paused");
		expect(calls).toHaveLength(2);
	});

	it("does not pause when the session switches to an unestimated model", async () => {
		// The window belongs to the model this request will use. Evaluating the
		// carried tokens against the PREVIOUS turn's model paused a request for a
		// model the guard deliberately has no estimate for, and named that stale
		// model in the notice.
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(HEAVY_USAGE_STREAM);
		const proxy = await startProxy(accountManager, fetchImpl);

		await postResponses(proxy, {
			model: "gpt-5-codex",
			stream: true,
			prompt_cache_key: "sess-switch",
		});
		const switched = await postResponses(proxy, {
			model: "gpt-5.6-sol",
			stream: true,
			prompt_cache_key: "sess-switch",
		});
		expect(switched.text).not.toContain("Context budget guard paused");
		expect(calls).toHaveLength(2);
	});

	it("never pauses while the guard is disabled", async () => {
		delete process.env.CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED;
		const accountManager = new AccountManager(undefined, createStorage(Date.now()));
		const { calls, fetchImpl } = createRecordingFetch(HEAVY_USAGE_STREAM);
		const proxy = await startProxy(accountManager, fetchImpl);
		const turn = { model: "gpt-5-codex", stream: true, prompt_cache_key: "sess-3" };

		await postResponses(proxy, turn);
		const second = await postResponses(proxy, turn);
		expect(second.text).not.toContain("Context budget guard paused");
		expect(calls).toHaveLength(2);
	});
});
