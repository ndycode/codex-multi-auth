import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import { HTTP_STATUS } from "../lib/constants.js";
import {
	resetPinCacheForTesting,
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import { resetTrackers } from "../lib/rotation.js";
import {
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";

/**
 * End-to-end HTTP integration test for issue #474. Spins up a real
 * `http.Server` via `startRuntimeRotationProxy`, mocks only the upstream
 * fetch, then mutates the on-disk storage file between requests to prove the
 * pin contract and affinity invalidation hold across real network requests.
 */

const {
	saveAccountsMock,
	withAccountStorageTransactionMock,
} = vi.hoisted(() => ({
	saveAccountsMock: vi.fn(),
	withAccountStorageTransactionMock: vi.fn(),
}));

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

const CLIENT_API_KEY = "runtime-secret";
const ACCOUNT_COUNT = 2;

function createStorage(
	now: number,
	overrides: Partial<AccountStorageV3> = {},
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - (ACCOUNT_COUNT - index) * 60_000,
			enabled: true,
		})),
		...overrides,
	};
}

interface ProxyPostResult {
	status: number;
	bodyText: string;
}

function postViaHttp(
	proxy: RuntimeRotationProxyServer,
	body: Record<string, unknown>,
	path: string,
): Promise<ProxyPostResult> {
	const url = new URL(`${proxy.baseUrl}${path}`);
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: url.hostname,
				port: Number(url.port),
				path: url.pathname + url.search,
				method: "POST",
				headers: {
					authorization: `Bearer ${CLIENT_API_KEY}`,
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload).toString(),
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
						bodyText: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

const tmpDirs: string[] = [];
const openServers: RuntimeRotationProxyServer[] = [];
const openManagers: AccountManager[] = [];

function makeTmpStoragePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "issue-474-e2e-"));
	tmpDirs.push(dir);
	return join(dir, "openai-codex-accounts.json");
}

function writeStorageFile(path: string, storage: AccountStorageV3): void {
	writeFileSync(path, JSON.stringify(storage), "utf8");
}

beforeEach(() => {
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	resetPinCacheForTesting();
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
	setStoragePathDirect(null);
	resetPinCacheForTesting();
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("issue #474 — end-to-end pin honored over real HTTP proxy", () => {
	it(
		"honors pin and invalidates affinity across real HTTP requests",
		async () => {
			const storagePath = makeTmpStoragePath();
			const now = Date.now();
			const initialStorage = createStorage(now);
			writeStorageFile(storagePath, initialStorage);
			setStoragePathDirect(storagePath);

			const accountManager = new AccountManager(undefined, initialStorage);
			openManagers.push(accountManager);

			// Map the upstream Authorization header back to the account index that
			// produced it so we can assert which account was selected.
			const tokenToIndex = new Map<string, number>(
				initialStorage.accounts.map((account, index) => [
					account.accessToken,
					index,
				]),
			);

			const upstreamCalls: number[] = [];
			const fetchImpl: typeof fetch = async (_input, init) => {
				const headers = new Headers(init?.headers);
				const auth = headers.get("authorization") ?? "";
				const token = auth.replace(/^Bearer\s+/i, "");
				const index = tokenToIndex.get(token);
				if (typeof index !== "number") {
					throw new Error(`unknown bearer token: ${token}`);
				}
				upstreamCalls.push(index);
				return new Response(JSON.stringify({ ok: true, account: index }), {
					status: HTTP_STATUS.OK,
					headers: { "content-type": "application/json" },
				});
			};

			const proxy = await startRuntimeRotationProxy({
				accountManager,
				fetchImpl,
				upstreamBaseUrl: "https://example.test/backend-api",
				clientApiKey: CLIENT_API_KEY,
			});
			openServers.push(proxy);

			// (c) First HTTP POST — proxy should pick some account and remember
			// affinity for `previous_response_id`.
			const sharedResponseId = "resp_pin_test_session";
			const firstResult = await postViaHttp(
				proxy,
				{
					model: "gpt-5-codex",
					stream: false,
					previous_response_id: sharedResponseId,
				},
				"/v1/responses",
			);
			expect(firstResult.status).toBe(HTTP_STATUS.OK);
			expect(upstreamCalls).toHaveLength(1);
			const firstAccountIndex = upstreamCalls[0];
			expect(firstAccountIndex).not.toBeUndefined();
			if (firstAccountIndex === undefined) {
				throw new Error("unreachable: missing first account index");
			}
			const otherAccountIndex = firstAccountIndex === 0 ? 1 : 0;

			// (d) Pin to the OTHER account and bump affinityGeneration so the
			// previously remembered session affinity is invalidated.
			writeStorageFile(storagePath, {
				...initialStorage,
				pinnedAccountIndex: otherAccountIndex,
				affinityGeneration: 1,
			});
			// (e) Let the FS settle the rename on Windows.
			await delay(50);

			// (f) Same `previous_response_id` — must route to the pinned account.
			const secondResult = await postViaHttp(
				proxy,
				{
					model: "gpt-5-codex",
					stream: false,
					previous_response_id: sharedResponseId,
				},
				"/v1/responses",
			);
			expect(secondResult.status).toBe(HTTP_STATUS.OK);
			expect(upstreamCalls).toHaveLength(2);
			expect(upstreamCalls[1]).toBe(otherAccountIndex);

			// (g) Disable the pinned account in storage *and* in the in-memory
			// pool, then bump generation. The pin cannot be honored, so the proxy
			// must hard-fail with 503 instead of falling through to rotation.
			const disabledStorage = createStorage(now);
			disabledStorage.accounts[otherAccountIndex] = {
				...disabledStorage.accounts[otherAccountIndex],
				enabled: false,
			} as AccountStorageV3["accounts"][number];
			writeStorageFile(storagePath, {
				...disabledStorage,
				pinnedAccountIndex: otherAccountIndex,
				affinityGeneration: 2,
			});
			accountManager.setAccountEnabled(otherAccountIndex, false);
			await delay(50);

			const thirdResult = await postViaHttp(
				proxy,
				{
					model: "gpt-5-codex",
					stream: false,
					previous_response_id: sharedResponseId,
				},
				"/v1/responses",
			);
			expect(thirdResult.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
			expect(thirdResult.bodyText).toContain(
				"codex_pinned_account_unavailable",
			);
			// No additional upstream call — the proxy refused before issuing one.
			expect(upstreamCalls).toHaveLength(2);
		},
	);
});
