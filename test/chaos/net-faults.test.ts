import { afterEach, describe, expect, it } from "vitest";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../../lib/accounts.js";
import {
	startRuntimeRotationProxy,
	type RuntimeRotationProxyServer,
} from "../../lib/runtime-rotation-proxy.js";
import { setStoragePathDirect, type AccountStorageV3 } from "../../lib/storage.js";
import { resetTrackers } from "../../lib/rotation.js";
import { clearCircuitBreakers } from "../../lib/circuit-breaker.js";
import { resetRefreshQueue } from "../../lib/refresh-queue.js";
import { __resetRoutingMutexForTests } from "../../lib/routing-mutex.js";
import { withRetry } from "../../lib/fs-retry.js";

/**
 * REAL network fault injection: a live loopback HTTP stub plays the upstream
 * and applies transport-level faults (socket destroy, hang, byte trickle,
 * mid-stream teardown) while the real runtime rotation proxy forwards a client
 * request through it. Assertions follow lib/request/failure-policy.ts and the
 * proxy's own contract:
 *   - pre-header transport error  -> short network-error cooldown + rotate
 *   - post-header stream break    -> recordFailure + cooldown, NO replay
 *   - hung upstream               -> fetchTimeoutMs bound, then rotate
 *   - all accounts exhausted      -> codex_runtime_rotation_pool_exhausted 503
 *
 * No OAuth port is bound; every server listens on port 0.
 */

const CLIENT_KEY = "net-faults-client-key";
const FETCH_TIMEOUT_MS = 400;
const STALL_TIMEOUT_MS = 350;

const dirs: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const proxies: RuntimeRotationProxyServer[] = [];
const managers: AccountManager[] = [];

afterEach(async () => {
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

function createStorage(now: number, count = 2): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: count }, (_unused, index) => ({
			recordId: `rec-net-${index + 1}`,
			email: `operator${index + 1}@corp.example`,
			accountId: `acct-net-${index + 1}`,
			refreshToken: `rt-net-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - (count - index) * 60_000,
			enabled: true,
		})),
	};
}

type FaultKind =
	| "ok" // complete 200 JSON response
	| "destroy" // kill the socket without a single response byte
	| "hang" // never respond at all
	| "destroy-mid" // headers + one chunk, then kill the socket
	| "stall-after" // headers + one chunk, then silence forever
	| "trickle"; // one byte every TRICKLE_INTERVAL_MS until done

interface UpstreamHit {
	bearer: string | null;
	accountIndex: number | null; // parsed out of `Bearer access-N`
	url: string;
	body: string;
}

const TRICKLE_INTERVAL_MS = 30;
const TRICKLE_BYTES = 12;

/**
 * Start a loopback-only stub upstream. `plan` receives the 1-based hit count
 * and returns the fault to apply to that request.
 */
async function startUpstream(
	plan: (hit: number, req: IncomingMessage, res: ServerResponse) => FaultKind,
): Promise<{ port: number; hits: UpstreamHit[] }> {
	const hits: UpstreamHit[] = [];
	const server = createServer((req, res) => {
		// Fault paths intentionally destroy/stall sockets; teardown also destroys
		// live sockets between tests. A res.write() landing on an already-dead
		// socket emits 'error' on the ServerResponse — without a listener that
		// becomes an unhandled error and can crash the whole vitest fork.
		res.on("error", () => undefined);
		const bearer = req.headers.authorization ?? null;
		const match = /^Bearer access-(\d+)$/.exec(bearer ?? "");
		const hit: UpstreamHit = {
			bearer,
			accountIndex: match?.[1] ? Number(match[1]) - 1 : null,
			url: req.url ?? "",
			body: "",
		};
		hits.push(hit);
		req.on("data", (chunk: Buffer) => {
			hit.body += chunk.toString("utf8");
		});
		const fault = plan(hits.length, req, res);
		switch (fault) {
			case "ok":
				req.on("end", () => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ served: hit.accountIndex }));
				});
				break;
			case "destroy":
				req.socket.destroy();
				break;
			case "hang":
				// Deliberately never respond; torn down by socket cleanup.
				break;
			case "destroy-mid":
				res.writeHead(200, { "content-type": "text/event-stream" });
				// The RST must arrive after the header+chunk bytes are actually
				// on the wire: destroy() drops the kernel send buffer, so a
				// same-tick kill degenerates into a pre-header close and
				// exercises the wrong code path. A short settle is enough on
				// loopback, and any residual variance only shifts the boundary
				// between "pre-header" and "post-header" assertions — both of
				// which are contract-checked by the caller.
				res.write('data: {"type":"response.created"}\n\n', () => {
					setTimeout(() => req.socket.destroy(), 25).unref();
				});
				break;
			case "stall-after":
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write('data: {"type":"response.created"}\n\n');
				// Then nothing, ever — the stream stall timeout must fire.
				break;
			case "trickle": {
				res.writeHead(200, { "content-type": "text/plain" });
				let sent = 0;
				const timer = setInterval(() => {
					sent += 1;
					res.write("x");
					if (sent >= TRICKLE_BYTES) {
						clearInterval(timer);
						res.end();
					}
				}, TRICKLE_INTERVAL_MS);
				timer.unref();
				res.on("close", () => clearInterval(timer));
				break;
			}
		}
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

async function startProxyStack(
	upstreamPort: number,
	accountCount = 2,
): Promise<{ proxy: RuntimeRotationProxyServer; manager: AccountManager }> {
	const dir = await mkdtemp(join(tmpdir(), "cma-net-faults-"));
	dirs.push(dir);
	const storagePath = join(dir, "openai-codex-accounts.json");
	const storage = createStorage(Date.now(), accountCount);
	await writeFile(storagePath, JSON.stringify(storage, null, 2));
	setStoragePathDirect(storagePath);
	const manager = new AccountManager(undefined, storage);
	managers.push(manager);
	const proxy = await startRuntimeRotationProxy({
		accountManager: manager,
		fetchImpl: fetch,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
		clientApiKey: CLIENT_KEY,
		fetchTimeoutMs: FETCH_TIMEOUT_MS,
		streamStallTimeoutMs: STALL_TIMEOUT_MS,
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
			model: "gpt-5.6-sol",
			prompt_cache_key: key,
			input: [],
			store: false,
		}),
	});
}

function coolingReason(
	manager: AccountManager,
	index: number,
): string | null {
	const account = manager.getAccountByIndex(index);
	return account
		? manager.getManagedAccountRuntimeSkipReason(account, "gpt-5.2", "gpt-5.6-sol")
		: "missing";
}

describe("network fault injection through the runtime proxy", () => {
	it("abrupt socket close before headers cools the account and rotates the request", async () => {
		const upstream = await startUpstream((hit) =>
			hit === 1 ? "destroy" : "ok",
		);
		const { proxy, manager } = await startProxyStack(upstream.port);

		const started = Date.now();
		const response = await postResponses(proxy, "req-destroy");
		expect(response.status).toBe(200);

		expect(upstream.hits).toHaveLength(2);
		expect(upstream.hits[0]!.accountIndex).not.toBeNull();
		expect(upstream.hits[1]!.accountIndex).not.toBe(
			upstream.hits[0]!.accountIndex,
		);
		// Pre-header transport failure => network-error cooldown on the victim.
		expect(coolingReason(manager, upstream.hits[0]!.accountIndex!)).toBe(
			"cooling-down:network-error",
		);
		// The request completed only because the proxy rotated; bound sanity.
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(proxy.getStatus().upstreamRequests).toBe(2);
	});

	it("a hung upstream is bounded by fetchTimeoutMs and then fails over", async () => {
		const upstream = await startUpstream((hit) => (hit === 1 ? "hang" : "ok"));
		const { proxy, manager } = await startProxyStack(upstream.port);

		const started = Date.now();
		const response = await postResponses(proxy, "req-hang");
		expect(response.status).toBe(200);
		const elapsed = Date.now() - started;

		// Without the proxy's 400ms fetch timeout this request would sit on
		// undici's default headers timeout (~5 minutes); a sub-3s completion
		// proves the configured bound actually fired.
		expect(elapsed).toBeLessThan(3_000);
		expect(upstream.hits).toHaveLength(2);
		expect(upstream.hits[1]!.accountIndex).not.toBe(
			upstream.hits[0]!.accountIndex,
		);
		expect(coolingReason(manager, upstream.hits[0]!.accountIndex!)).toBe(
			"cooling-down:network-error",
		);
	});

	it("ECONNRESET mid-body cools the account without an unsafe replay", async () => {
		const upstream = await startUpstream((hit) =>
			hit === 1 ? "destroy-mid" : "ok",
		);
		const { proxy, manager } = await startProxyStack(upstream.port);

		const response = await postResponses(proxy, "req-mid");
		// Headers were already forwarded as a 200; the body then dies.
		expect(response.status).toBe(200);
		await expect(response.text()).rejects.toThrow();

		// Exactly one upstream attempt for this request: a mid-stream failure is
		// never replayed within the same request.
		expect(upstream.hits).toHaveLength(1);
		expect(proxy.getStatus().streamsStarted).toBe(1);
		expect(coolingReason(manager, upstream.hits[0]!.accountIndex!)).toBe(
			"cooling-down:network-error",
		);

		// The next request must land on the surviving account.
		const followUp = await postResponses(proxy, "req-mid-2");
		expect(followUp.status).toBe(200);
		expect(upstream.hits).toHaveLength(2);
		expect(upstream.hits[1]!.accountIndex).not.toBe(
			upstream.hits[0]!.accountIndex,
		);
	});

	it("a stream that stalls after headers is cut by streamStallTimeoutMs", async () => {
		const upstream = await startUpstream((hit) =>
			hit === 1 ? "stall-after" : "ok",
		);
		const { proxy, manager } = await startProxyStack(upstream.port);

		const started = Date.now();
		const response = await postResponses(proxy, "req-stall");
		expect(response.status).toBe(200);
		await expect(response.text()).rejects.toThrow();
		const elapsed = Date.now() - started;

		// The 350ms stall window fired rather than the read hanging forever.
		expect(elapsed).toBeLessThan(3_000);
		expect(upstream.hits).toHaveLength(1);
		expect(coolingReason(manager, upstream.hits[0]!.accountIndex!)).toBe(
			"cooling-down:network-error",
		);
	});

	it("a steady trickle inside the stall budget completes with the full body", async () => {
		const upstream = await startUpstream(() => "trickle");
		const { proxy } = await startProxyStack(upstream.port, 1);

		const started = Date.now();
		const response = await postResponses(proxy, "req-trickle");
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toBe("x".repeat(TRICKLE_BYTES));
		// ~360ms of real trickle time: proves bytes, not a buffered shortcut.
		expect(Date.now() - started).toBeGreaterThanOrEqual(
			TRICKLE_INTERVAL_MS * 5,
		);
		expect(upstream.hits).toHaveLength(1);
	});

	it("exhausting every account returns a typed pool-exhausted 503", async () => {
		const upstream = await startUpstream(() => "destroy");
		const { proxy } = await startProxyStack(upstream.port, 2);

		const response = await postResponses(proxy, "req-dead");
		expect(response.status).toBe(503);
		const body = (await response.json()) as {
			error?: { code?: string; reason?: string };
		};
		expect(body.error?.code).toBe("codex_runtime_rotation_pool_exhausted");
		expect(body.error?.reason).toBe("network-error");
		// Both accounts were genuinely attempted against the dead upstream.
		expect(upstream.hits).toHaveLength(2);
		expect(new Set(upstream.hits.map((hit) => hit.accountIndex)).size).toBe(2);
	});
});
