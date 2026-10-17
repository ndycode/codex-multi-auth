import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import { HTTP_STATUS, MAX_RATE_LIMIT_DELAY_MS, OPENAI_HEADERS } from "../lib/constants.js";
import * as runtimePolicy from "../lib/policy/runtime-policy.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import * as tokenRefreshRuntime from "../lib/runtime/rotation-token-refresh.js";
import { resetTrackers } from "../lib/rotation.js";
import {
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const CLIENT_KEY = "runtime-secret";
const openServers: RuntimeRotationProxyServer[] = [];
const openManagers: AccountManager[] = [];

interface FetchCall {
	url: string;
	headers: Headers;
	bodyBytes: Buffer;
}

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

function bodyBytes(init: RequestInit | undefined): Buffer {
	const body = init?.body;
	if (typeof body === "string") return Buffer.from(body);
	if (body instanceof Uint8Array) return Buffer.from(body);
	return Buffer.alloc(0);
}

function createRecordingFetch(
	handler: (call: FetchCall, attempt: number) => Response | Promise<Response>,
): { calls: FetchCall[]; fetchImpl: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const call = {
			url: String(input),
			headers: new Headers(init?.headers),
			bodyBytes: bodyBytes(init),
		};
		calls.push(call);
		return handler(call, calls.length);
	};
	return { calls, fetchImpl };
}

async function startProxy(
	accountManager: AccountManager,
	fetchImpl: typeof fetch,
	options: { forcedAccountIndex?: number } = {},
): Promise<RuntimeRotationProxyServer> {
	openManagers.push(accountManager);
	const proxy = await startRuntimeRotationProxy({
		accountManager,
		fetchImpl,
		upstreamBaseUrl: "https://example.test/backend-api",
		clientApiKey: CLIENT_KEY,
		quotaRemainingPercentThreshold: 10,
		...options,
	});
	openServers.push(proxy);
	return proxy;
}

async function postTranscribe(
	proxy: RuntimeRotationProxyServer,
	body: Buffer,
	contentType = "multipart/form-data; boundary=x",
): Promise<Response> {
	return fetch(`${proxy.baseUrl}/transcribe`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${CLIENT_KEY}`,
			"content-type": contentType,
			"x-api-key": "caller-key",
			cookie: "session=caller-cookie",
		},
		body,
	});
}

async function postResponses(
	proxy: RuntimeRotationProxyServer,
	sessionId: string,
): Promise<Response> {
	return fetch(`${proxy.baseUrl}/codex/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${CLIENT_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "gpt-5-codex",
			stream: true,
			input: [{ type: "message", role: "user", content: "hi" }],
			metadata: { session_id: sessionId },
		}),
	});
}

beforeEach(() => {
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	tokenRefreshRuntime.resetRuntimeRefreshStateForTests();
});

afterEach(async () => {
	for (const proxy of openServers.splice(0)) await proxy.close();
	for (const manager of openManagers.splice(0)) await manager.flushPendingSave();
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	tokenRefreshRuntime.resetRuntimeRefreshStateForTests();
	vi.restoreAllMocks();
});

describe("runtime transcription proxy", () => {
	it("forwards multipart bytes unchanged with managed OAuth", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 1));
		const boundary = "----codex-dictation-boundary";
		const contentType = `multipart/form-data; boundary=${boundary}`;
		const body = Buffer.concat([
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
				"utf8",
			),
			Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x7f, 0x80]),
			Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
		]);
		const record = vi.fn(async () => undefined);
		const recorder = vi.spyOn(runtimePolicy, "createRuntimeUsageRecorder")
			.mockReturnValue({ hasRecorded: () => record.mock.calls.length > 0, record });
		const recordSuccess = vi.spyOn(manager, "recordSuccess");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "hello from dictation" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, body, contentType);

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(await response.json()).toEqual({ text: "hello from dictation" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://example.test/backend-api/transcribe");
		expect(calls[0]?.bodyBytes.equals(body)).toBe(true);
		expect(calls[0]?.headers.get("content-type")).toBe(contentType);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
		expect(calls[0]?.headers.has("x-api-key")).toBe(false);
		expect(calls[0]?.headers.has("cookie")).toBe(false);
		expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
			operation: "transcribe",
			model: null,
		}));
		expect(record).toHaveBeenCalledWith(expect.objectContaining({
			outcome: "success",
			statusCode: HTTP_STATUS.OK,
		}));
		expect(recordSuccess).not.toHaveBeenCalled();
	});

	it("requires local proxy authentication", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 1));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "unexpected" })),
		);
		const proxy = await startProxy(manager, fetchImpl);
		const response = await fetch(`${proxy.baseUrl}/transcribe`, {
			method: "POST",
			headers: { "content-type": "multipart/form-data; boundary=x" },
			body: Buffer.from("--x--\r\n"),
		});

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		await response.text();
		expect(calls).toHaveLength(0);
	});

	it("forwards 429 once without poisoning inference quota", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const recordRateLimit = vi.spyOn(manager, "recordRateLimit");
		const markRateLimited = vi.spyOn(manager, "markRateLimitedWithReason");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(
				JSON.stringify({ error: { code: "usage_limit_reached", message: "transcription limit" } }),
				{
					status: HTTP_STATUS.TOO_MANY_REQUESTS,
					headers: { "content-type": "application/json", "retry-after": "60" },
				},
			),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		expect(calls).toHaveLength(1);
		expect(recordRateLimit).not.toHaveBeenCalled();
		expect(markRateLimited).not.toHaveBeenCalled();
		expect(manager.getAccountsSnapshot().every((account) =>
			Object.keys(account.rateLimitResetTimes).length === 0,
		)).toBe(true);
		expect(proxy.getStatus().lunaReserveFallbacks ?? 0).toBe(0);
	});

	it("skips a transcription-rate-limited credential on the next request", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			attempt === 1
				? new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
					status: HTTP_STATUS.TOO_MANY_REQUESTS,
					headers: { "content-type": "application/json", "retry-after": "60" },
				})
				: new Response(JSON.stringify({ text: "second credential" }), {
					status: HTTP_STATUS.OK,
					headers: { "content-type": "application/json" },
				}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const first = await postTranscribe(proxy, Buffer.from("--first--\r\n"));
		const second = await postTranscribe(proxy, Buffer.from("--second--\r\n"));

		expect(first.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		expect(second.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-2");
		expect(proxy.getStatus().rotations).toBe(0);
	});

	it("reports a transcription backoff for a pinned credential", async () => {
		const baseNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(baseNow);
		const manager = new AccountManager(undefined, createStorage(baseNow, 1));
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
				status: HTTP_STATUS.TOO_MANY_REQUESTS,
				headers: { "content-type": "application/json", "retry-after": "60" },
			}),
		);
		openManagers.push(manager);
		const proxy = await startRuntimeRotationProxy({
			accountManager: manager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_KEY,
			quotaRemainingPercentThreshold: 10,
			forcedAccountIndex: 0,
		});
		openServers.push(proxy);

		expect((await postTranscribe(proxy, Buffer.from("--first--\r\n"))).status)
			.toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		const pinned = await postTranscribe(proxy, Buffer.from("--second--\r\n"));
		const payload = (await pinned.json()) as {
			error: { reason: string | null; retry_after_ms: number | null; reset_at: string | null };
		};

		expect(pinned.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error).toMatchObject({ reason: "transcription-rate-limited", retry_after_ms: 60_000 });
		expect(payload.error.retry_after_ms).toBe(60_000);
		expect(payload.error.reset_at).toBe(new Date(baseNow + 60_000).toISOString());
		expect(calls).toHaveLength(1);
	});

	it("reports the next transcription backoff when every credential is waiting", async () => {
		const baseNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(baseNow);
		const manager = new AccountManager(undefined, createStorage(baseNow, 2));
		const reloadSpy = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
				status: HTTP_STATUS.TOO_MANY_REQUESTS,
				headers: {
					"content-type": "application/json",
					"retry-after": attempt === 1 ? "60" : "30",
				},
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		expect((await postTranscribe(proxy, Buffer.from("--first--\r\n"))).status)
			.toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		expect((await postTranscribe(proxy, Buffer.from("--second--\r\n"))).status)
			.toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		const exhausted = await postTranscribe(proxy, Buffer.from("--third--\r\n"));
		const payload = (await exhausted.json()) as { error: { retry_after_ms: number } };

		expect(exhausted.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error.retry_after_ms).toBe(30_000);
		expect(calls).toHaveLength(2);
		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it("discovers a newly logged-in credential while resident credentials are transcription-rate-limited", async () => {
		const baseNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(baseNow);
		const manager = new AccountManager(undefined, createStorage(baseNow, 1));
		const refreshed = new AccountManager(undefined, createStorage(baseNow, 2));
		const loadFromDisk = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(refreshed);
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) =>
			attempt === 1
				? new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
					status: HTTP_STATUS.TOO_MANY_REQUESTS,
					headers: { "content-type": "application/json", "retry-after": "60" },
				})
				: new Response(JSON.stringify({ text: "new login" }), {
					status: HTTP_STATUS.OK,
					headers: { "content-type": "application/json" },
				}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		expect((await postTranscribe(proxy, Buffer.from("--limited--\r\n"))).status)
			.toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		const recovered = await postTranscribe(proxy, Buffer.from("--after-login--\r\n"));

		expect(recovered.status).toBe(HTTP_STATUS.OK);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-2");
	});

	it("waits for the latest auth and transcription deadline on one credential", async () => {
		const baseNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(baseNow);
		const manager = new AccountManager(undefined, createStorage(baseNow, 1));
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
				status: HTTP_STATUS.TOO_MANY_REQUESTS,
				headers: { "content-type": "application/json", "retry-after": "60" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		expect((await postTranscribe(proxy, Buffer.from("--first--\r\n"))).status)
			.toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		const account = manager.getAccountByIndex(0);
		if (!account) throw new Error("missing test account");
		manager.markAccountCoolingDown(account, 30_000, "auth-failure");
		const blocked = await postTranscribe(proxy, Buffer.from("--blocked--\r\n"));
		const payload = (await blocked.json()) as { error: { retry_after_ms: number } };

		expect(blocked.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error.retry_after_ms).toBe(60_000);
		expect(calls).toHaveLength(1);
	});

	it("clamps a huge transcription Retry-After to the shared maximum", async () => {
		const baseNow = Date.now();
		let clock = baseNow;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const storage = createStorage(baseNow, 2);
		for (const account of storage.accounts) {
			account.expiresAt = baseNow + MAX_RATE_LIMIT_DELAY_MS + 86_400_000;
		}
		const manager = new AccountManager(undefined, storage);
		const { calls, fetchImpl } = createRecordingFetch((_call, attempt) => {
			if (attempt === 1) {
				return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
					status: HTTP_STATUS.TOO_MANY_REQUESTS,
					headers: { "content-type": "application/json", "retry-after": "999999999" },
				});
			}
			return new Response(JSON.stringify({ text: "ok" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			});
		});
		const proxy = await startProxy(manager, fetchImpl);

		const first = await postTranscribe(proxy, Buffer.from("--first--\r\n"));
		expect(first.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		const second = await postTranscribe(proxy, Buffer.from("--second--\r\n"));
		expect(second.status).toBe(HTTP_STATUS.OK);
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-2");

		clock = baseNow + MAX_RATE_LIMIT_DELAY_MS + 1;
		const third = await postTranscribe(proxy, Buffer.from("--third--\r\n"));
		expect(third.status).toBe(HTTP_STATUS.OK);
		expect(calls[2]?.headers.get("authorization")).toBe("Bearer access-1");
	});

	it("keeps a newer transcription backoff when an older request succeeds later", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 1));
		const loadFromDisk = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const { calls, fetchImpl } = createRecordingFetch(async (_call, attempt) => {
			if (attempt === 1) {
				markFirstStarted();
				await firstGate;
				return new Response(JSON.stringify({ text: "older success" }), {
					status: HTTP_STATUS.OK,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
				status: HTTP_STATUS.TOO_MANY_REQUESTS,
				headers: { "content-type": "application/json", "retry-after": "60" },
			});
		});
		const proxy = await startProxy(manager, fetchImpl);

		const older = postTranscribe(proxy, Buffer.from("--older--\r\n"));
		await firstStarted;
		const newer = await postTranscribe(proxy, Buffer.from("--newer--\r\n"));
		expect(newer.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		releaseFirst();
		expect((await older).status).toBe(HTTP_STATUS.OK);

		const after = await postTranscribe(proxy, Buffer.from("--after--\r\n"));
		expect(after.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(2);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
	});

	it("keeps the longest overlapping transcription backoff window", async () => {
		const baseNow = Date.now();
		let clock = baseNow;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const manager = new AccountManager(undefined, createStorage(baseNow, 1));
		const loadFromDisk = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
		let markLongStarted!: () => void;
		const longStarted = new Promise<void>((resolve) => { markLongStarted = resolve; });
		let releaseLong!: () => void;
		const longGate = new Promise<void>((resolve) => { releaseLong = resolve; });
		const { calls, fetchImpl } = createRecordingFetch(async (_call, attempt) => {
			if (attempt === 1) {
				markLongStarted();
				await longGate;
				return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
					status: HTTP_STATUS.TOO_MANY_REQUESTS,
					headers: { "content-type": "application/json", "retry-after": "120" },
				});
			}
			return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
				status: HTTP_STATUS.TOO_MANY_REQUESTS,
				headers: { "content-type": "application/json", "retry-after": "60" },
			});
		});
		const proxy = await startProxy(manager, fetchImpl);

		const longer = postTranscribe(proxy, Buffer.from("--long--\r\n"));
		await longStarted;
		const shorter = await postTranscribe(proxy, Buffer.from("--short--\r\n"));
		expect(shorter.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
		releaseLong();
		expect((await longer).status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);

		clock = baseNow + 61_000;
		const afterShortWindow = await postTranscribe(proxy, Buffer.from("--after-short--\r\n"));
		expect(afterShortWindow.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(2);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
	});

	it("forwards Cloudflare 403 once without rotating or disabling accounts", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(
				JSON.stringify({ error: { code: "cloudflare_challenge", message: "challenge" } }),
				{
					status: HTTP_STATUS.FORBIDDEN,
					headers: { "content-type": "application/json", "cf-mitigated": "challenge" },
				},
			),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
		expect(calls).toHaveLength(1);
		expect(proxy.getStatus().rotations).toBe(0);
		expect(manager.getAccountsSnapshot().every((account) => account.enabled !== false)).toBe(true);
	});

	it("forwards 5xx once without inference health cooldown", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const recordFailure = vi.spyOn(manager, "recordFailure");
		const markCooldown = vi.spyOn(manager, "markAccountCoolingDown");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response("upstream unavailable", { status: HTTP_STATUS.SERVICE_UNAVAILABLE }),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(await response.text()).toBe("upstream unavailable");
		expect(calls).toHaveLength(1);
		expect(recordFailure).not.toHaveBeenCalled();
		expect(markCooldown).not.toHaveBeenCalled();
		expect(proxy.getStatus().rotations).toBe(0);
	});

	it("does not replay after an ambiguous transport failure", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const recordFailure = vi.spyOn(manager, "recordFailure");
		const markCooldown = vi.spyOn(manager, "markAccountCoolingDown");
		const { calls, fetchImpl } = createRecordingFetch(() => {
			throw new Error("socket closed after upload");
		});
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));
		const payload = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(HTTP_STATUS.BAD_GATEWAY);
		expect(payload.error.code).toBe("transcribe_upstream_transport_error");
		expect(calls).toHaveLength(1);
		expect(recordFailure).not.toHaveBeenCalled();
		expect(markCooldown).not.toHaveBeenCalled();
		expect(proxy.getStatus().rotations).toBe(0);
	});

	it("refuses a disabled selected transcription workspace without using a sibling", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 1));
		const account = manager.getAccountByIndex(0);
		if (!account) throw new Error("missing test account");
		account.accountId = "workspace-bound";
		account.workspaces = [
			{ id: "workspace-bound", name: "Bound", enabled: true },
			{ id: "workspace-selected", name: "Selected", enabled: true },
		];
		account.currentWorkspaceIndex = 1;
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "workspace" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const selected = await postTranscribe(proxy, Buffer.from("--selected--\r\n"));
		expect(selected.status).toBe(HTTP_STATUS.OK);
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("workspace-selected");
		expect(account.currentWorkspaceIndex).toBe(1);

		account.workspaces[1]!.enabled = false;
		const fallback = await postTranscribe(proxy, Buffer.from("--fallback--\r\n"));
		expect(fallback.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(calls).toHaveLength(1);
		expect(account.currentWorkspaceIndex).toBe(1);
	});

	it("round-robins unpinned transcription credentials without moving inference state", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "ok" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const first = await postTranscribe(proxy, Buffer.from("--one--\r\n"));
		const second = await postTranscribe(proxy, Buffer.from("--two--\r\n"));

		expect(first.status).toBe(HTTP_STATUS.OK);
		expect(second.status).toBe(HTTP_STATUS.OK);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-2");
		expect(manager.getCurrentAccountForFamily("codex")?.index).toBe(0);
	});

	it("round-robins native transcription independently of the inference preference", async () => {
		const now = Date.now();
		const storage = createStorage(now, 2);
		const manager = new AccountManager(undefined, structuredClone(storage));
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "ok" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		openManagers.push(manager);
		const proxy = await startRuntimeRotationProxy({
			nativeOpenai: true,
			readNativeAccountStorage: async () => structuredClone(storage),
			accountManager: manager,
			fetchImpl,
			upstreamBaseUrl: "https://example.test/backend-api",
			clientApiKey: CLIENT_KEY,
			quotaRemainingPercentThreshold: 10,
		});
		openServers.push(proxy);

		expect((await postTranscribe(proxy, Buffer.from("--native-one--\r\n"))).status)
			.toBe(HTTP_STATUS.OK);
		expect((await postTranscribe(proxy, Buffer.from("--native-two--\r\n"))).status)
			.toBe(HTTP_STATUS.OK);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-2");
		expect(manager.getCurrentAccountForFamily("codex")?.index).toBe(0);
	});

	it("discovers the first login when the resident transcription pool starts empty", async () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, createStorage(now, 0));
		const repaired = new AccountManager(undefined, createStorage(now, 1));
		const loadFromDisk = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(repaired);
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "first login" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--first-login--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
	});

	it("reports an auth cooldown created by the final refresh failure", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const storage = createStorage(now, 1);
		const row = storage.accounts[0];
		if (!row) throw new Error("missing refresh-failure row");
		row.expiresAt = now - 60_000;
		const manager = new AccountManager(undefined, storage);
		const refresh = vi.spyOn(tokenRefreshRuntime, "ensureFreshAccessToken").mockImplementation(async ({ accountManager, account }) => {
			accountManager.markAccountCoolingDown(account, 30_000, "auth-failure");
			return { ok: false, retryable: true, account, accountManager };
		});
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "must not run" }), { status: HTTP_STATUS.OK }),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--refresh-failure--\r\n"));
		const payload = (await response.json()) as { error?: { retry_after_ms?: number } };

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(0);
		expect(payload.error?.retry_after_ms).toBe(30_000);
	});

	it("honors auth-failure cooldowns while selecting a transcription credential", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const first = manager.getAccountByIndex(0);
		if (!first) throw new Error("missing first test account");
		manager.markAccountCoolingDown(first, 60_000, "auth-failure");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "healthy credential" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-2");
		expect(first.cooldownReason).toBe("auth-failure");
	});

	it("reloads repaired credentials without clearing inference limits", async () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, createStorage(now, 1));
		const stale = manager.getAccountByIndex(0);
		if (!stale) throw new Error("missing stale test account");
		manager.markRateLimitedWithReason(stale, 60_000, "codex", "quota", null);
		manager.markAuthInvalidated(stale, "test_invalidated");
		const expectedRateLimit = stale.rateLimitResetTimes.codex;

		const repairedStorage = createStorage(now, 1);
		const repairedRow = repairedStorage.accounts[0];
		if (!repairedRow) throw new Error("missing repaired storage row");
		repairedRow.accessToken = "repaired-access";
		const repaired = new AccountManager(undefined, repairedStorage);
		const loadFromDisk = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(repaired);
		const resetVolatile = vi.spyOn(AccountManager, "resetVolatileRuntimeState");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "repaired" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
		expect(resetVolatile).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer repaired-access");
		expect(repaired.getAccountByIndex(0)?.rateLimitResetTimes.codex).toBe(expectedRateLimit);
	});

	it("keeps a hard pin on a repaired legacy login whose derived record id changes", async () => {
		const now = Date.now();
		const legacyStorage = createStorage(now, 1);
		const legacyRow = legacyStorage.accounts[0];
		if (!legacyRow) throw new Error("missing legacy row");
		delete legacyRow.recordId;
		const manager = new AccountManager(undefined, legacyStorage);
		const stale = manager.getAccountByIndex(0);
		if (!stale) throw new Error("missing stale legacy account");
		manager.markAuthInvalidated(stale, "test_invalidated");

		const repairedStorage = createStorage(now, 1);
		const repairedRow = repairedStorage.accounts[0];
		if (!repairedRow) throw new Error("missing repaired row");
		delete repairedRow.recordId;
		repairedRow.refreshToken = "refresh-relogin";
		repairedRow.accessToken = "access-relogin";
		repairedRow.expiresAt = now + 7_200_000;
		const repaired = new AccountManager(undefined, repairedStorage);
		expect(repaired.getAccountByIndex(0)?.recordId).not.toBe(stale.recordId);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(repaired);
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "repaired pinned login" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl, { forcedAccountIndex: 0 });

		const response = await postTranscribe(proxy, Buffer.from("--legacy-relogin--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-relogin");
		expect(calls[0]?.headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("acc_1");
	});

	it("fails closed when a removed pinned legacy login has a different-email accountId sibling", async () => {
		const now = Date.now();
		const legacyStorage = createStorage(now, 1);
		const legacyRow = legacyStorage.accounts[0];
		if (!legacyRow) throw new Error("missing legacy row");
		delete legacyRow.recordId;
		const manager = new AccountManager(undefined, legacyStorage);
		const stale = manager.getAccountByIndex(0);
		if (!stale) throw new Error("missing stale legacy account");
		manager.markAuthInvalidated(stale, "test_invalidated");

		const replacementStorage = createStorage(now, 1);
		const siblingRow = replacementStorage.accounts[0];
		if (!siblingRow) throw new Error("missing sibling row");
		delete siblingRow.recordId;
		siblingRow.accountId = legacyRow.accountId;
		siblingRow.email = "different-member@example.com";
		siblingRow.refreshToken = "different-refresh";
		siblingRow.accessToken = "different-access";
		const replacement = new AccountManager(undefined, replacementStorage);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(replacement);
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "wrong login" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl, { forcedAccountIndex: 0 });

		const response = await postTranscribe(proxy, Buffer.from("--removed-legacy-pin--\r\n"));
		const payload = (await response.json()) as { error: { code: string; reason: string | null } };

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(payload.error).toMatchObject({
			code: "codex_pinned_account_unavailable",
			reason: "missing",
		});
		expect(calls).toHaveLength(0);
	});

	it("preserves inference updates that arrive while credential reload is pending", async () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, createStorage(now, 1));
		const stale = manager.getAccountByIndex(0);
		if (!stale) throw new Error("missing stale test account");
		manager.markAuthInvalidated(stale, "test_invalidated");

		const repairedStorage = createStorage(now, 1);
		const repairedRow = repairedStorage.accounts[0];
		if (!repairedRow) throw new Error("missing repaired storage row");
		repairedRow.accessToken = "repaired-access";
		const repaired = new AccountManager(undefined, repairedStorage);
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		vi.spyOn(AccountManager, "loadFromDisk").mockImplementation(async () => {
			signalLoadStarted();
			await loadGate;
			return repaired;
		});
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "repaired" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const pending = postTranscribe(proxy, Buffer.from("--x--\r\n"));
		await loadStarted;
		manager.markRateLimitedWithReason(stale, 90_000, "codex", "quota", null);
		const concurrentRateLimit = stale.rateLimitResetTimes.codex;
		releaseLoad();
		const response = await pending;

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(repaired.getAccountByIndex(0)?.rateLimitResetTimes.codex).toBe(concurrentRateLimit);
	});

	it("does not treat a deduped credential reload as a fresh selection pass", async () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, createStorage(now, 1));
		const stale = manager.getAccountByIndex(0);
		if (!stale) throw new Error("missing stale test account");
		manager.markAuthInvalidated(stale, "test_invalidated");

		const stillInvalid = new AccountManager(undefined, createStorage(now, 1));
		const reloadedAccount = stillInvalid.getAccountByIndex(0);
		if (!reloadedAccount) throw new Error("missing reloaded test account");
		stillInvalid.markAuthInvalidated(reloadedAccount, "still_invalid");
		const loadFromDisk = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(stillInvalid);
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "must not run" }), { status: HTTP_STATUS.OK }),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const first = await postTranscribe(proxy, Buffer.from("--first--\r\n"));
		const second = await postTranscribe(proxy, Buffer.from("--second--\r\n"));

		expect(first.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(second.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(0);
	});

	it("re-evaluates runtime policy after credential reload before routing audio", async () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, createStorage(now, 1));
		const stale = manager.getAccountByIndex(0);
		if (!stale) throw new Error("missing stale test account");
		manager.markAuthInvalidated(stale, "test_invalidated");

		const repaired = new AccountManager(undefined, createStorage(now, 1));
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(repaired);
		const baseDecision = {
			allowed: true,
			statusCode: 200,
			errorCode: null,
			reasons: [],
			projectKey: null,
			scoreBoostByAccount: {},
			budgetEvaluations: [],
		};
		const policySpy = vi.spyOn(runtimePolicy, "evaluateRuntimePolicy")
			.mockResolvedValueOnce({ ...baseDecision, blockedAccountIndexes: new Set<number>() })
			.mockResolvedValue({ ...baseDecision, blockedAccountIndexes: new Set<number>([0]) });
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "should not run" }), { status: HTTP_STATUS.OK }),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--policy--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(policySpy).toHaveBeenCalledTimes(2);
		expect(calls).toHaveLength(0);
	});

	it("reloads a new healthy credential even when the old inventory is policy-blocked", async () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, createStorage(now, 1));
		const repaired = new AccountManager(undefined, createStorage(now, 2));
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(repaired);
		const baseDecision = {
			allowed: true,
			statusCode: 200,
			errorCode: null,
			reasons: [],
			projectKey: null,
			scoreBoostByAccount: {},
			budgetEvaluations: [],
		};
		const policySpy = vi.spyOn(runtimePolicy, "evaluateRuntimePolicy")
			.mockResolvedValue({ ...baseDecision, blockedAccountIndexes: new Set<number>([0]) });
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "new healthy account" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--policy-reload--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(policySpy).toHaveBeenCalledTimes(2);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-2");
	});

	it("ignores inference rate limits and preserves them after transcription", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 1));
		const account = manager.getAccountByIndex(0);
		if (!account) throw new Error("missing test account");
		manager.markRateLimitedWithReason(account, 60_000, "codex", "quota", null);
		expect(manager.getAccountRuntimeSkipReason(0, "codex", null)).toBe("rate-limited");
		const consumeToken = vi.spyOn(manager, "consumeTokenWithReason");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "still works" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(consumeToken).not.toHaveBeenCalled();
		expect(manager.getAccountRuntimeSkipReason(0, "codex", null)).toBe("rate-limited");
	});

	it("does not claim the half-open inference recovery probe", async () => {
		const now = Date.now();
		let clock = now;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const manager = new AccountManager(undefined, createStorage(now, 1));
		const account = manager.getAccountByIndex(0);
		if (!account) throw new Error("missing test account");
		manager.recordFailure(account, "codex", null);
		manager.recordFailure(account, "codex", null);
		manager.recordFailure(account, "codex", null);
		clock += 30_001;
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "probe untouched" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(manager.consumeTokenWithReason(account, "codex", null, { bypassTokenBucket: true })).toEqual({ ok: true });
	});

	it("does not advance the inference cursor when transcription selects another credential", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const first = manager.getAccountByIndex(0);
		if (!first) throw new Error("missing first test account");
		manager.markAuthInvalidated(first, "test_invalidated");
		const markSwitched = vi.spyOn(manager, "markSwitched");
		const markSwitchedLocked = vi.spyOn(manager, "markSwitchedLocked");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ text: "second account" }), {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		expect(manager.getCurrentAccountForFamily("codex")?.index).toBe(0);
		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-2");
		expect(manager.getCurrentAccountForFamily("codex")?.index).toBe(0);
		expect(markSwitched).not.toHaveBeenCalled();
		expect(markSwitchedLocked).not.toHaveBeenCalled();
	});

	it("does not change concurrent inference selection with the routing mutex enabled", async () => {
		const previousMutex = process.env.CODEX_AUTH_ROUTING_MUTEX;
		process.env.CODEX_AUTH_ROUTING_MUTEX = "enabled";
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		let releaseTranscription: (() => void) | undefined;
		const transcriptionGate = new Promise<void>((resolve) => { releaseTranscription = resolve; });
		let markTranscriptionStarted: (() => void) | undefined;
		const transcriptionStarted = new Promise<void>((resolve) => { markTranscriptionStarted = resolve; });
		const { calls, fetchImpl } = createRecordingFetch(async (call) => {
			if (call.url.endsWith("/transcribe")) {
				markTranscriptionStarted?.();
				await transcriptionGate;
				return new Response(JSON.stringify({ text: "voice" }), {
					status: HTTP_STATUS.OK,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("data: forwarded\n\n", {
				status: HTTP_STATUS.OK,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const proxy = await startProxy(manager, fetchImpl);
		if (previousMutex === undefined) delete process.env.CODEX_AUTH_ROUTING_MUTEX;
		else process.env.CODEX_AUTH_ROUTING_MUTEX = previousMutex;
		expect(manager.getRoutingMutexMode()).toBe("enabled");

		const transcription = postTranscribe(proxy, Buffer.from("--voice--\r\n"));
		await transcriptionStarted;
		const inference = await postResponses(proxy, "concurrent-inference");
		expect(inference.status).toBe(HTTP_STATUS.OK);
		await inference.text();
		releaseTranscription?.();
		const transcriptionResponse = await transcription;
		expect(transcriptionResponse.status).toBe(HTTP_STATUS.OK);

		const transcriptionCall = calls.find((call) => call.url.endsWith("/transcribe"));
		const inferenceCall = calls.find((call) => call.url.endsWith("/codex/responses"));
		expect(transcriptionCall?.headers.get("authorization")).toBe("Bearer access-1");
		expect(inferenceCall?.headers.get("authorization")).toBe("Bearer access-1");
		expect(manager.getCurrentAccountForFamily("codex")?.index).toBe(0);
	});

	it("forwards an ordinary transcription 401 once without inference failure or rotation", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const recordFailure = vi.spyOn(manager, "recordFailure");
		const markCooldown = vi.spyOn(manager, "markAccountCoolingDown");
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(JSON.stringify({ error: { code: "unauthorized", message: "not authorized" } }), {
				status: HTTP_STATUS.UNAUTHORIZED,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));
		const payload = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(payload.error.code).toBe("unauthorized");
		expect(calls).toHaveLength(1);
		expect(recordFailure).not.toHaveBeenCalled();
		expect(markCooldown).not.toHaveBeenCalled();
		expect(proxy.getStatus().rotations).toBe(0);
	});

	it("does not invalidate repaired credentials when an older transcription 401 arrives late", async () => {
		const now = Date.now();
		const originalStorage = createStorage(now, 1);
		const originalRow = originalStorage.accounts[0];
		if (!originalRow) throw new Error("missing original row");
		originalRow.recordId = "row-1";
		const manager = new AccountManager(undefined, originalStorage);

		const repairedStorage = createStorage(now, 1);
		const repairedRow = repairedStorage.accounts[0];
		if (!repairedRow) throw new Error("missing repaired row");
		repairedRow.recordId = "row-1";
		repairedRow.refreshToken = "refresh-relogin";
		repairedRow.accessToken = "access-relogin";
		const repaired = new AccountManager(undefined, repairedStorage);

		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const invalidationBody = JSON.stringify({
			error: { message: "Encountered invalidated oauth token for user, failing request" },
		});
		const { calls, fetchImpl } = createRecordingFetch(async () => {
			markStarted();
			await gate;
			return new Response(invalidationBody, {
				status: HTTP_STATUS.UNAUTHORIZED,
				headers: { "content-type": "application/json" },
			});
		});
		const proxy = await startProxy(manager, fetchImpl);

		const pending = postTranscribe(proxy, Buffer.from("--late-invalidation--\r\n"));
		await started;
		tokenRefreshRuntime.redirectRuntimeRefreshCommits(manager, repaired);
		release();
		const response = await pending;
		const payload = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(payload.error.code).toBe("token_invalidated");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(repaired.getAccountByIndex(0)).toMatchObject({
			access: "access-relogin",
			refreshToken: "refresh-relogin",
		});
		expect(repaired.getAccountByIndex(0)?.authInvalidatedAt).toBeUndefined();
		expect(repaired.getAccountByIndex(0)?.coolingDownUntil).toBeUndefined();
	});

	it("keeps explicit token invalidation semantics for 401", async () => {
		const manager = new AccountManager(undefined, createStorage(Date.now(), 2));
		const invalidationBody = JSON.stringify({
			error: { message: "Encountered invalidated oauth token for user, failing request" },
		});
		const { calls, fetchImpl } = createRecordingFetch(() =>
			new Response(invalidationBody, {
				status: HTTP_STATUS.UNAUTHORIZED,
				headers: { "content-type": "application/json" },
			}),
		);
		const proxy = await startProxy(manager, fetchImpl);

		const response = await postTranscribe(proxy, Buffer.from("--x--\r\n"));
		const payload = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
		expect(payload.error.code).toBe("token_invalidated");
		expect(calls).toHaveLength(1);
		expect(manager.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
		});
		expect(proxy.getStatus().rotations).toBe(0);
	});
});
