import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager, getRuntimeTrackerKey } from "../lib/accounts.js";
import { getModelFamily } from "../lib/prompts/codex.js";
import {
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../lib/runtime-rotation-proxy.js";
import { setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";
import { getTokenTracker, resetTrackers } from "../lib/rotation.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import { __resetRoutingMutexForTests } from "../lib/routing-mutex.js";
import { withRetry } from "../lib/fs-retry.js";

/**
 * Live-concurrency coverage for the runtime rotation proxy: a REAL
 * startRuntimeRotationProxy() on port 0 fronting a REAL loopback upstream,
 * with ~25 requests in flight at once.
 *
 * The contract under test is the routing-mutex "enabled" mode
 * (CODEX_AUTH_ROUTING_MUTEX): chooseAccount's cursor mutation plus the proxy's
 * markSwitchedLocked re-commit must run inside ONE mutex acquisition so a
 * selection slot is committed exactly once — and persistRuntimeActiveAccount
 * must NOT re-advance the cursor after the upstream response. A regression
 * there is a "double-commit" that spends two rotation slots for one request.
 *
 * Account identity is observed at the upstream (the Authorization bearer the
 * proxy forwards) — client responses deliberately carry no account identity.
 */

const CLIENT_KEY = "live-parallel-client-key";
const MODEL = "gpt-5.6-sol";
const FAMILY = getModelFamily(MODEL);
const QUOTA_KEY = `${FAMILY}:${MODEL}`;
const ACCOUNT_COUNT = 3;

const dirs: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const proxies: RuntimeRotationProxyServer[] = [];
const managers: AccountManager[] = [];
const savedMutexEnv = process.env.CODEX_AUTH_ROUTING_MUTEX;

afterEach(async () => {
	vi.restoreAllMocks();
	if (savedMutexEnv === undefined) {
		delete process.env.CODEX_AUTH_ROUTING_MUTEX;
	} else {
		process.env.CODEX_AUTH_ROUTING_MUTEX = savedMutexEnv;
	}
	setStoragePathDirect(null);
	for (const proxy of proxies.splice(0)) {
		await proxy.close().catch(() => undefined);
	}
	for (const manager of managers.splice(0)) {
		await manager.flushPendingSave().catch(() => undefined);
	}
	for (const socket of sockets) socket.destroy();
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of dirs.splice(0)) {
		await withRetry(() => rm(dir, { recursive: true, force: true }), {
			maxAttempts: 6,
			backoffMs: 25,
		});
	}
	resetTrackers();
	clearCircuitBreakers();
	resetRefreshQueue();
	__resetRoutingMutexForTests();
});

function createStorage(now: number, count = ACCOUNT_COUNT): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: count }, (_unused, index) => ({
			recordId: `rec-live-${index + 1}`,
			email: `operator${index + 1}@corp.example`,
			accountId: `acct-live-${index + 1}`,
			refreshToken: `rt-live-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - (count - index) * 60_000,
			enabled: true,
		})),
	};
}

interface UpstreamHit {
	bearer: string | null;
	accountIndex: number | null;
	body: string;
}

function accountIndexOf(bearer: string | null): number | null {
	const match = /^Bearer access-(\d+)$/.exec(bearer ?? "");
	return match?.[1] ? Number(match[1]) - 1 : null;
}

/**
 * Upstream stub with an optional release barrier: when `barrierCount` is set,
 * every response is parked until that many requests have arrived, proving the
 * requests were genuinely in flight at the same time and that every selection
 * committed before the first success could feed back into scoring.
 */
async function startUpstream(options: {
	barrierCount?: number;
	failBearer?: string;
}): Promise<{ port: number; hits: UpstreamHit[] }> {
	const hits: UpstreamHit[] = [];
	const parked: Array<{ res: ServerResponse; hit: UpstreamHit }> = [];
	const respond = (res: ServerResponse, hit: UpstreamHit): void => {
		let key: string | null = null;
		try {
			const parsed = JSON.parse(hit.body) as { prompt_cache_key?: string };
			key = typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key : null;
		} catch {
			key = null;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ served: hit.accountIndex, key }));
	};
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		// Parked responses may be written after teardown destroyed their socket;
		// an 'error' on the ServerResponse without a listener is an unhandled
		// error that can crash the whole vitest fork.
		res.on("error", () => undefined);
		const bearer = req.headers.authorization ?? null;
		const hit: UpstreamHit = {
			bearer,
			accountIndex: accountIndexOf(bearer),
			body: "",
		};
		hits.push(hit);
		req.on("data", (chunk: Buffer) => {
			hit.body += chunk.toString("utf8");
		});
		req.on("end", () => {
			if (options.failBearer && bearer === options.failBearer) {
				req.socket.destroy();
				return;
			}
			if (options.barrierCount === undefined) {
				respond(res, hit);
				return;
			}
			parked.push({ res, hit });
			if (parked.length === options.barrierCount) {
				for (const entry of parked.splice(0)) {
					respond(entry.res, entry.hit);
				}
			}
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	servers.push(server);
	return { port: (server.address() as AddressInfo).port, hits };
}

async function startProxyStack(upstreamPort: number): Promise<{
	proxy: RuntimeRotationProxyServer;
	manager: AccountManager;
}> {
	const dir = await mkdtemp(join(tmpdir(), "cma-live-parallel-"));
	dirs.push(dir);
	const storagePath = join(dir, "openai-codex-accounts.json");
	const storage = createStorage(Date.now());
	await writeFile(storagePath, JSON.stringify(storage, null, 2));
	setStoragePathDirect(storagePath);
	const manager = new AccountManager(undefined, storage);
	managers.push(manager);
	process.env.CODEX_AUTH_ROUTING_MUTEX = "enabled";
	const proxy = await startRuntimeRotationProxy({
		accountManager: manager,
		fetchImpl: fetch,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
		clientApiKey: CLIENT_KEY,
		fetchTimeoutMs: 8_000,
		streamStallTimeoutMs: 8_000,
		quotaRemainingPercentThreshold: 10,
	});
	proxies.push(proxy);
	return { proxy, manager };
}

function postResponses(
	proxy: RuntimeRotationProxyServer,
	key: string,
): Promise<Response> {
	return fetch(`${proxy.baseUrl}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${CLIENT_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: MODEL,
			prompt_cache_key: key,
			input: [],
			store: false,
		}),
	});
}

function tokensRemaining(manager: AccountManager, index: number): number {
	const account = manager.getAccountByIndex(index);
	if (!account) return Number.NaN;
	return getTokenTracker().getTokens(getRuntimeTrackerKey(account), QUOTA_KEY);
}

describe("live proxy concurrency (routing-mutex enabled)", () => {
	it("25 concurrent requests: one selection commit each, no double-spend, fair spread", async () => {
		const TOTAL = 25;
		const upstream = await startUpstream({ barrierCount: TOTAL });
		const { proxy, manager } = await startProxyStack(upstream.port);
		expect(manager.getRoutingMutexMode()).toBe("enabled");
		const commitSpy = vi.spyOn(manager, "markSwitchedLocked");

		const responses = await Promise.all(
			Array.from({ length: TOTAL }, (_unused, i) =>
				postResponses(proxy, `req-${i}`),
			),
		);

		for (const response of responses) {
			expect(response.status).toBe(200);
		}
		// Exactly one upstream attempt per client request — no re-sends.
		expect(upstream.hits).toHaveLength(TOTAL);
		expect(proxy.getStatus().upstreamRequests).toBe(TOTAL);

		const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
			served: number;
			key: string;
		}>;
		// Each client received the body of ITS OWN proxied request: the echoed
		// prompt_cache_key must round-trip 1:1 or responses were cross-wired.
		for (const [i, body] of bodies.entries()) {
			expect(body.key).toBe(`req-${i}`);
			expect(body.served).toBeGreaterThanOrEqual(0);
			expect(body.served).toBeLessThan(ACCOUNT_COUNT);
		}

		// Spread across the healthy pool. Selection is fully deterministic here
		// (all 25 selections commit before the barrier releases any response);
		// token drain + lastUsed refresh penalize re-picks, so the distribution
		// must stay near even — a stampede onto one account is the bug being
		// guarded against.
		const counts = new Map<number, number>();
		for (const hit of upstream.hits) {
			expect(hit.accountIndex).not.toBeNull();
			counts.set(hit.accountIndex!, (counts.get(hit.accountIndex!) ?? 0) + 1);
		}
		expect(counts.size).toBe(ACCOUNT_COUNT);
		for (const [index, count] of counts) {
			expect(count).toBeGreaterThanOrEqual(4);
			expect(count).toBeLessThanOrEqual(16);
			// No double-spend: tokens debited for this account equal its real
			// upstream hit count (bucket starts at 50, small refill over the run).
			const consumed = 50 - tokensRemaining(manager, index);
			expect(consumed).toBeGreaterThanOrEqual(count - 1);
			expect(consumed).toBeLessThanOrEqual(count + 0.01);
		}

		// L4 contract: exactly one mutex-held cursor commit per selection. The
		// post-response persist path must not re-commit — that would spend two
		// rotation slots for one request (the double-commit regression).
		expect(commitSpy).toHaveBeenCalledTimes(TOTAL);
	}, 20_000);

	it("the last healthy account is not double-spent under 12 concurrent requests", async () => {
		const TOTAL = 12;
		const upstream = await startUpstream({});
		const { proxy, manager } = await startProxyStack(upstream.port);
		// Cool two of three accounts for a minute — only index 2 is selectable.
		for (const index of [0, 1]) {
			const account = manager.getAccountByIndex(index)!;
			manager.markAccountCoolingDown(account, 60_000, "network-error");
		}
		const commitSpy = vi.spyOn(manager, "markSwitchedLocked");

		const responses = await Promise.all(
			Array.from({ length: TOTAL }, (_unused, i) =>
				postResponses(proxy, `req-last-${i}`),
			),
		);
		for (const response of responses) {
			expect(response.status).toBe(200);
		}
		expect(upstream.hits).toHaveLength(TOTAL);
		for (const hit of upstream.hits) {
			expect(hit.accountIndex).toBe(2);
		}
		// Twelve debits, twelve real requests — no extra slot was spent.
		const consumed = 50 - tokensRemaining(manager, 2);
		expect(consumed).toBeGreaterThanOrEqual(TOTAL - 1);
		expect(consumed).toBeLessThanOrEqual(TOTAL + 0.01);
		expect(50 - tokensRemaining(manager, 0)).toBeLessThanOrEqual(0.01);
		expect(50 - tokensRemaining(manager, 1)).toBeLessThanOrEqual(0.01);
		expect(commitSpy).toHaveBeenCalledTimes(TOTAL);
	}, 20_000);

	it("an account whose upstream dies is cooled once and live traffic rotates off it", async () => {
		const TOTAL = 12;
		const upstream = await startUpstream({
			failBearer: "Bearer access-1",
		});
		const { proxy, manager } = await startProxyStack(upstream.port);

		const responses = await Promise.all(
			Array.from({ length: TOTAL }, (_unused, i) =>
				postResponses(proxy, `req-fail-${i}`),
			),
		);
		for (const response of responses) {
			expect(response.status).toBe(200);
		}

		const attemptsOnVictim = upstream.hits.filter(
			(hit) => hit.accountIndex === 0,
		).length;
		const served = upstream.hits.filter((hit) => hit.accountIndex !== 0);
		// Every request was served by a healthy account; the victim saw at least
		// one real attempt (it is the freshest pick) and never served a response.
		expect(served).toHaveLength(TOTAL);
		expect(attemptsOnVictim).toBeGreaterThanOrEqual(1);
		expect(attemptsOnVictim).toBeLessThanOrEqual(TOTAL);
		expect(upstream.hits).toHaveLength(TOTAL + attemptsOnVictim);
		expect(
			manager.getManagedAccountRuntimeSkipReason(
				manager.getAccountByIndex(0)!,
				FAMILY,
				MODEL,
			),
		).toBe("cooling-down:network-error");
	}, 20_000);
});
