import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
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
import { accountStorageV3Fixture } from "./helpers/cli-test-fixtures.js";

/**
 * End-to-end HTTP integration test for issue #474. Spins up a real
 * `http.Server` via `startRuntimeRotationProxy`, mocks only the upstream
 * fetch, then mutates the on-disk storage file between requests to prove the
 * pin contract and affinity invalidation hold across real network requests.
 */

// Shared mock group (test/helpers/cli-test-fixtures.ts), narrowed to the exact
// set this suite used to override so every other storage export (including
// loadAccounts, which the proxy reads from the real tmp file) stays the actual
// implementation. This suite imports the mocked storage module statically, so
// the group must be created inside vi.hoisted (which also resolves the helper
// itself) rather than in a module-level const.
const { storageMocks } = await vi.hoisted(async () => {
	const fixtures = await import("./helpers/cli-test-fixtures.js");
	return {
		storageMocks: fixtures.pickMocks(fixtures.createStorageMocks(), [
			"saveAccounts",
			"withAccountStorageTransaction",
		]),
	};
});

vi.mock("../lib/storage.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).storageModuleMock(
		storageMocks,
	),
);

const CLIENT_API_KEY = "runtime-secret";
const ACCOUNT_COUNT = 2;

function createStorage(
	now: number,
	overrides: Partial<AccountStorageV3> = {},
): AccountStorageV3 {
	return accountStorageV3Fixture(
		Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - (ACCOUNT_COUNT - index) * 60_000,
			enabled: true,
		})),
		overrides,
	);
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
	storageMocks.saveAccounts.mockReset();
	storageMocks.saveAccounts.mockResolvedValue(undefined);
	storageMocks.withAccountStorageTransaction.mockReset();
	storageMocks.withAccountStorageTransaction.mockImplementation(async (handler) =>
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
			// removeWithRetry per test/AGENTS.md: handles transient Windows
			// EBUSY/EPERM/ENOTEMPTY locks on the proxy's storage tmp dirs.
			await removeWithRetry(dir, { recursive: true, force: true });
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
			// Issue #486: the 503 body must surface the runtime skip reason so
			// users can diagnose why the pin cannot be honored without scraping
			// `codex-multi-auth status` logs out-of-band.
			const thirdBody = JSON.parse(thirdResult.bodyText) as {
				error: {
					code: string;
					pinnedAccountIndex: number | null;
					reason: string | null;
					account_skip_reasons: Record<string, string>;
					message: string;
				};
			};
			expect(thirdBody.error.reason).toBe("disabled");
			expect(thirdBody.error.message).toContain("(disabled)");
			expect(thirdBody.error.pinnedAccountIndex).toBe(otherAccountIndex);
			expect(
				thirdBody.error.account_skip_reasons[String(otherAccountIndex)],
			).toBe("disabled");
			// No additional upstream call — the proxy refused before issuing one.
			expect(upstreamCalls).toHaveLength(2);
		},
	);

	it(
		"surfaces 'rate-limited' skip reason in pinned 503 body (issue #486)",
		async () => {
			const storagePath = makeTmpStoragePath();
			const now = Date.now();
			const initialStorage = createStorage(now);
			const pinnedIndex = 1;
			writeStorageFile(storagePath, {
				...initialStorage,
				pinnedAccountIndex: pinnedIndex,
				affinityGeneration: 1,
			});
			setStoragePathDirect(storagePath);

			const accountManager = new AccountManager(undefined, initialStorage);
			openManagers.push(accountManager);

			const pinned = accountManager.getAccountByIndex(pinnedIndex);
			expect(pinned).not.toBeNull();
			if (!pinned) throw new Error("setup failed");
			// Match the family the proxy will resolve from `model: "gpt-5-codex"`.
			// `getModelFamily("gpt-5-codex")` returns "gpt-5-codex", not "codex",
			// so the rate-limit must be keyed under that family for the runtime
			// skip-reason check to detect it.
			accountManager.markRateLimitedWithReason(
				pinned,
				60_000,
				"gpt-5-codex",
				"quota",
			);

			const upstreamCalls: number[] = [];
			const fetchImpl: typeof fetch = async (_input, init) => {
				const headers = new Headers(init?.headers);
				const auth = headers.get("authorization") ?? "";
				const token = auth.replace(/^Bearer\s+/i, "");
				const index = initialStorage.accounts.findIndex(
					(a) => a.accessToken === token,
				);
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

			const result = await postViaHttp(
				proxy,
				{ model: "gpt-5-codex", stream: false },
				"/v1/responses",
			);
			expect(result.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
			const body = JSON.parse(result.bodyText) as {
				error: {
					code: string;
					reason: string | null;
					account_skip_reasons: Record<string, string>;
					message: string;
				};
			};
			expect(body.error.code).toBe("codex_pinned_account_unavailable");
			expect(body.error.reason).toBe("rate-limited");
			expect(body.error.message).toContain("(rate-limited)");
			expect(body.error.account_skip_reasons[String(pinnedIndex)]).toBe(
				"rate-limited",
			);
			expect(upstreamCalls).toHaveLength(0);
		},
	);

	it(
		"surfaces a cooling-down skip reason in pinned 503 body (issue #486)",
		async () => {
			const storagePath = makeTmpStoragePath();
			const now = Date.now();
			const initialStorage = createStorage(now);
			const pinnedIndex = 0;
			writeStorageFile(storagePath, {
				...initialStorage,
				pinnedAccountIndex: pinnedIndex,
				affinityGeneration: 1,
			});
			setStoragePathDirect(storagePath);

			const accountManager = new AccountManager(undefined, initialStorage);
			openManagers.push(accountManager);

			const pinned = accountManager.getAccountByIndex(pinnedIndex);
			if (!pinned) throw new Error("setup failed");
			accountManager.markAccountCoolingDown(pinned, 60_000, "auth-failure");

			const upstreamCalls: number[] = [];
			const fetchImpl: typeof fetch = async () => {
				upstreamCalls.push(-1);
				return new Response("{}", { status: HTTP_STATUS.OK });
			};

			const proxy = await startRuntimeRotationProxy({
				accountManager,
				fetchImpl,
				upstreamBaseUrl: "https://example.test/backend-api",
				clientApiKey: CLIENT_API_KEY,
			});
			openServers.push(proxy);

			const result = await postViaHttp(
				proxy,
				{ model: "gpt-5-codex", stream: false },
				"/v1/responses",
			);
			expect(result.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
			const body = JSON.parse(result.bodyText) as {
				error: {
					code: string;
					reason: string | null;
					account_skip_reasons: Record<string, string>;
					message: string;
				};
			};
			expect(body.error.code).toBe("codex_pinned_account_unavailable");
			expect(body.error.reason).toBe("cooling-down:auth-failure");
			expect(body.error.message).toContain("(cooling-down:auth-failure)");
			expect(body.error.account_skip_reasons[String(pinnedIndex)]).toBe(
				"cooling-down:auth-failure",
			);
			expect(upstreamCalls).toHaveLength(0);
		},
	);
});
