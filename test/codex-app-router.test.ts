import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withFileOperationRetry } from "../lib/fs-retry.js";

const tempRoots: string[] = [];
const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, "..");

async function createTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function createRouterFixture(root: string, options: { withProxyModule?: boolean } = {}): string {
	const scriptsDir = join(root, "scripts");
	mkdirSync(scriptsDir, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ type: "module" }, null, 2)}\n`,
		"utf8",
	);
	const scriptPath = join(scriptsDir, "codex-app-router.js");
	copyFileSync(join(repoRoot, "scripts", "codex-app-router.js"), scriptPath);
	if (options.withProxyModule !== false) {
		const distDir = join(root, "dist", "lib");
		mkdirSync(distDir, { recursive: true });
		writeFileSync(
			join(distDir, "runtime-rotation-proxy.js"),
			[
				'import { appendFileSync, mkdirSync } from "node:fs";',
				'import { dirname } from "node:path";',
				"function marker(line) {",
				"  const path = process.env.CODEX_APP_ROUTER_TEST_MARKER ?? '';",
				"  if (!path) return;",
				"  mkdirSync(dirname(path), { recursive: true });",
				"  appendFileSync(path, `${line}\\n`, 'utf8');",
				"}",
				"export async function startRuntimeRotationProxy(options) {",
				"  if (process.env.CODEX_APP_ROUTER_TEST_FAIL_PROXY === '1') throw new Error('proxy boom');",
				"  marker(`start:${options.host}:${options.port}:${options.clientApiKey}${options.upstreamBaseUrl ? `:upstream=${options.upstreamBaseUrl}` : ''}`);",
				"  return {",
				"    baseUrl: `http://${options.host}:${options.port || 4567}`,",
				"    close: async () => marker('close'),",
				"    getStatus: () => ({",
				"      schedulingStrategy: 'sequential',",
				"      totalRequests: 2,",
				"      upstreamRequests: 1,",
				"      websocketConnections: 3,",
				"      websocketUpstreamRequests: 7,",
				'      ...JSON.parse(process.env.CODEX_APP_ROUTER_TEST_ADMISSION ?? "{}"),',
				'      lastWebsocketDisconnect: process.env.CODEX_APP_ROUTER_TEST_DISCONNECT === undefined ? { at: 123, cause: "close", stage: "streaming", closeCode: 1011 } : JSON.parse(process.env.CODEX_APP_ROUTER_TEST_DISCONNECT),',
				"      retries: 0,",
				"      rotations: 1,",
				"      lastAccountIndex: 1,",
				"      lastAccountLabel: 'Account 2 (hidden@example.com)',",
				"      lastAccountId: 'acc_2',",
				"      lastAccountUpdatedAt: 123,",
				"      lastError: null,",
				"    }),",
				"  };",
				"}",
			].join("\n"),
			"utf8",
		);
	}
	return scriptPath;
}

async function writeState(path: string, state: Record<string, unknown>): Promise<void> {
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readJsonWhen(
	path: string,
	predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	let latest: Record<string, unknown> | null = null;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (existsSync(path)) {
			latest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (predicate(latest)) return latest;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`status did not reach expected state; latest=${JSON.stringify(latest)}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		child.once("close", () => resolve());
		setTimeout(resolve, 2_000);
	});
}

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0).map((root) =>
			withFileOperationRetry(() => rm(root, { recursive: true, force: true })),
		),
	);
});

describe("codex app router daemon", () => {
	it("starts, serializes redacted running status, and cleans up on SIGTERM", async () => {
		const root = await createTempRoot("codex-app-router-ok-");
		const scriptPath = createRouterFixture(root);
		const statePath = join(root, "state.json");
		const statusPath = join(root, "status.json");
		const markerPath = join(root, "marker.log");
		await writeState(statePath, {
			clientApiKey: "router-secret",
			host: "127.0.0.1",
			port: 0,
			baseUrl: "http://127.0.0.1:0",
			statusPath,
		});
		const child = spawn(
			process.execPath,
			[scriptPath, "--status", statusPath, "--state", statePath],
			{
				env: { ...process.env, CODEX_APP_ROUTER_TEST_MARKER: markerPath },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		try {
			const running = await readJsonWhen(
				statusPath,
				(status) => status.state === "running",
			);
			expect(running.kind).toBe("codex-app-runtime-rotation-router");
			expect(running.startedAt).toBeTypeOf("number");
			expect(running.baseUrl).toBe("http://127.0.0.1:4567");
			expect(running.schedulingStrategy).toBe("sequential");
			expect(running.lastAccountLabel).toBe("Account 2");
			expect(running.websocketConnections).toBe(3);
			expect(running.websocketUpstreamRequests).toBe(7);
			expect(running.websocketActiveConnections).toBe(0);
			expect(running.websocketCapacityReclaims).toBe(0);
			expect(running.lastWebsocketUpgradeRejection).toBeNull();
			expect(running.lastWebsocketDisconnect).toEqual({at:123,cause:"close",stage:"streaming",closeCode:1011});
			expect(running).not.toHaveProperty("clientApiKey");
			if (process.platform !== "win32") {
				expect(statSync(statusPath).mode & 0o777).toBe(0o600);
			}
			child.kill("SIGTERM");
			if (process.platform !== "win32") {
				await readJsonWhen(statusPath, (status) => status.state === "stopped");
				expect(readFileSync(markerPath, "utf8")).toContain("close\n");
			}
		} finally {
			await stopChild(child);
		}
	}, 10_000);

	it("chains the upstream proxy recorded by bind-app (#753)", async () => {
		const root = await createTempRoot("codex-app-router-upstream-");
		const scriptPath = createRouterFixture(root);
		const statePath = join(root, "state.json");
		const statusPath = join(root, "status.json");
		const markerPath = join(root, "marker.log");
		await writeState(statePath, {
			clientApiKey: "router-secret",
			host: "127.0.0.1",
			port: 0,
			statusPath,
			upstreamBaseUrl: "http://127.0.0.1:8787",
		});
		const child = spawn(process.execPath, [scriptPath, "--status", statusPath, "--state", statePath], {
			env: { ...process.env, CODEX_APP_ROUTER_TEST_MARKER: markerPath },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		try {
			await readJsonWhen(statusPath, (status) => status.state === "running");
			expect(readFileSync(markerPath, "utf8")).toContain(
				"start:127.0.0.1:0:router-secret:upstream=http://127.0.0.1:8787\n",
			);
		} finally {
			await stopChild(child);
		}
	}, 10_000);

	it("rejects non-loopback hosts before starting the proxy", async () => {
		const root = await createTempRoot("codex-app-router-host-");
		const scriptPath = createRouterFixture(root);
		const statePath = join(root, "state.json");
		const statusPath = join(root, "status.json");
		await writeState(statePath, {
			clientApiKey: "router-secret",
			host: "0.0.0.0",
			port: 1234,
			statusPath,
		});

		const result = spawnSync(
			process.execPath,
			[scriptPath, "--status", statusPath, "--state", statePath],
			{ encoding: "utf8", windowsHide: true },
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("loopback-only");
		expect(existsSync(statusPath)).toBe(false);
	});

	it("rejects state without a client token before starting the proxy", async () => {
		const root = await createTempRoot("codex-app-router-token-");
		const scriptPath = createRouterFixture(root);
		const statePath = join(root, "state.json");
		const statusPath = join(root, "status.json");
		await writeState(statePath, {
			host: "127.0.0.1",
			port: 1234,
			statusPath,
		});

		const result = spawnSync(
			process.execPath,
			[scriptPath, "--status", statusPath, "--state", statePath],
			{ encoding: "utf8", windowsHide: true },
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("missing its client token");
		expect(existsSync(statusPath)).toBe(false);
	});

	it("writes an error status when proxy startup fails", async () => {
		const root = await createTempRoot("codex-app-router-fail-");
		const scriptPath = createRouterFixture(root);
		const statePath = join(root, "state.json");
		const statusPath = join(root, "status.json");
		await writeState(statePath, {
			clientApiKey: "router-secret",
			host: "127.0.0.1",
			port: 1234,
			statusPath,
		});

		const result = spawnSync(
			process.execPath,
			[scriptPath, "--status", statusPath, "--state", statePath],
			{
				encoding: "utf8",
				env: { ...process.env, CODEX_APP_ROUTER_TEST_FAIL_PROXY: "1" },
				windowsHide: true,
			},
		);

		expect(result.status).not.toBe(0);
		const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
			state: string;
			lastError: string;
		};
		expect(status.state).toBe("error");
		expect(status.lastError).toBe("proxy boom");
	});

	it("writes an error status when the proxy module is missing", async () => {
		const root = await createTempRoot("codex-app-router-missing-dist-");
		const scriptPath = createRouterFixture(root, { withProxyModule: false });
		const statePath = join(root, "state.json");
		const statusPath = join(root, "status.json");
		await writeState(statePath, {
			clientApiKey: "router-secret",
			host: "127.0.0.1",
			port: 1234,
			statusPath,
		});

		const result = spawnSync(
			process.execPath,
			[scriptPath, "--status", statusPath, "--state", statePath],
			{ encoding: "utf8", windowsHide: true },
		);

		expect(result.status).not.toBe(0);
		const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
			state: string;
			lastError: string;
		};
		expect(status.state).toBe("error");
		expect(status.lastError).toContain("runtime-rotation-proxy.js");
	});
});


it("preserves sanitized disconnect history across daemon restarts and replaces it with current-process evidence after clock rollback", { timeout: 20_000 }, async () => {
	const root = await createTempRoot("router-history-");
	const scriptPath = createRouterFixture(root);
	const statePath = join(root, "state.json");
	const statusPath = join(root, "status.json");
	await writeState(statePath, { clientApiKey: "fixture-token", host: "127.0.0.1", port: 0, statusPath });
	const prior = { at: 123, cause: "close", stage: "streaming", closeCode: 1011, routeKind: "zdr", eventCount: 4, connectionAgeMs: 100, requestBytes: 1234, inputItemCount: 2, isPrewarm: false, hasPreviousResponse: true, reusedConnection: true, sendCompleted: true, compressionNegotiated: false, transportErrorCode: "ECONNRESET", tcpEndReceived: false, tcpCloseHadError: true };
	writeFileSync(statusPath, JSON.stringify({
		state: "stopped",
		lastWebsocketDisconnect: { ...prior, reason: "private-reason", authorization: "private-token" },
	}));
	for (const [live, expected] of [
		[null, prior],
		[{ ...prior, at: 100 }, { ...prior, at: 100 }],
		[{ ...prior, at: 456 }, { ...prior, at: 456 }],
	] as const) {
		const child = spawn(process.execPath, [scriptPath, "--status", statusPath, "--state", statePath], {
			env: { ...process.env, CODEX_APP_ROUTER_TEST_DISCONNECT: JSON.stringify(live) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			const running = await readJsonWhen(statusPath, status => status.state === "running" && status.pid === child.pid);
			expect(running.lastWebsocketDisconnect).toEqual(expected);
			expect(JSON.stringify(running)).not.toMatch(/private-reason|private-token/);
		} finally {
			await stopChild(child);
		}
	}
	writeFileSync(statusPath, JSON.stringify({ lastWebsocketDisconnect: { ...prior, cause: "private-cause" } }));
	const child = spawn(process.execPath, [scriptPath, "--status", statusPath, "--state", statePath], {
		env: { ...process.env, CODEX_APP_ROUTER_TEST_DISCONNECT: "null" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const status = await readJsonWhen(statusPath, value => value.state === "running" && value.pid === child.pid);
		expect(status.lastWebsocketDisconnect).toBeNull();
	} finally {
		await stopChild(child);
	}
});


it.each([
	{ reason: "origin", status: 403 },
	{ reason: "capacity", status: 426 },
	{ reason: "repeated_disconnect", status: 426 },
])("persists sanitized WebSocket admission diagnostics for $reason", async ({ reason, status }) => {
	const root = await createTempRoot("router-admission-");
	const scriptPath = createRouterFixture(root);
	const statePath = join(root, "state.json");
	const statusPath = join(root, "status.json");
	await writeState(statePath, { clientApiKey: "fixture-token", host: "127.0.0.1", port: 0, statusPath });
	const expected = { at: 123, reason, status, activeConnections: 64 };
	const child = spawn(process.execPath, [scriptPath, "--status", statusPath, "--state", statePath], {
		env: { ...process.env, CODEX_APP_ROUTER_TEST_ADMISSION: JSON.stringify({
			websocketActiveConnections: 64,
			websocketCapacityReclaims: 2,
			lastWebsocketUpgradeRejection: { ...expected, authorization: "private-token", thread: "private-thread", headers: { origin: "private-origin" } },
		}) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const running = await readJsonWhen(statusPath, value => value.state === "running");
		expect(running.websocketActiveConnections).toBe(64);
		expect(running.websocketCapacityReclaims).toBe(2);
		expect(running.lastWebsocketUpgradeRejection).toEqual(expected);
		expect(JSON.stringify(running)).not.toMatch(/private-token|private-thread|private-origin/);
	} finally {
		await stopChild(child);
	}
});

it.each([
	{ reason: "capacity", status: 403, activeConnections: 64 },
	{ reason: "origin", status: 426, activeConnections: 64 },
	{ reason: "repeated_disconnect", status: 403, activeConnections: 64 },
	{ reason: "private-reason", status: 426, activeConnections: 64 },
	{ reason: "capacity", status: 426, activeConnections: 65 },
	{ reason: "capacity", status: 426, activeConnections: -1 },
	{ reason: "capacity", status: 426, activeConnections: 1.5 },
	{ reason: "capacity", status: 426, activeConnections: "1" },
	{ reason: "capacity", status: 426, activeConnections: 1, at: 8.64e15 + 1 },
])("drops invalid WebSocket admission history: %j", async stored => {
	const root = await createTempRoot("router-invalid-admission-");
	const scriptPath = createRouterFixture(root);
	const statePath = join(root, "state.json");
	const statusPath = join(root, "status.json");
	await writeState(statePath, { clientApiKey: "fixture-token", host: "127.0.0.1", port: 0, statusPath });
	await writeState(statusPath, { lastWebsocketUpgradeRejection: { at: 123, ...stored } });
	const child = spawn(process.execPath, [scriptPath, "--status", statusPath, "--state", statePath], {
		env: { ...process.env, CODEX_APP_ROUTER_TEST_ADMISSION: JSON.stringify({
			websocketActiveConnections: stored.activeConnections,
			websocketCapacityReclaims: -1,
			lastWebsocketUpgradeRejection: { at: 123, ...stored },
		}) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const running = await readJsonWhen(statusPath, value => value.state === "running");
		expect(running.lastWebsocketUpgradeRejection).toBeNull();
		expect(running.websocketCapacityReclaims).toBe(0);
		if (typeof stored.activeConnections !== "number" || !Number.isSafeInteger(stored.activeConnections) || stored.activeConnections < 0 || stored.activeConnections > 64) {
			expect(running.websocketActiveConnections).toBe(0);
		}
	} finally {
		await stopChild(child);
	}
});

it("preserves WebSocket admission history across restarts and replaces it after clock rollback", async () => {
	const root = await createTempRoot("router-admission-history-");
	const scriptPath = createRouterFixture(root);
	const statePath = join(root, "state.json");
	const statusPath = join(root, "status.json");
	await writeState(statePath, { clientApiKey: "fixture-token", host: "127.0.0.1", port: 0, statusPath });
	const prior = { at: 123, reason: "capacity", status: 426, activeConnections: 64 };
	await writeState(statusPath, { lastWebsocketUpgradeRejection: { ...prior, authorization: "private-token" } });
	for (const [live, expected] of [[null, prior], [{ ...prior, at: 100 }, { ...prior, at: 100 }]] as const) {
		const child = spawn(process.execPath, [scriptPath, "--status", statusPath, "--state", statePath], {
			env: { ...process.env, CODEX_APP_ROUTER_TEST_ADMISSION: JSON.stringify({ lastWebsocketUpgradeRejection: live }) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			const running = await readJsonWhen(statusPath, value => value.state === "running" && value.pid === child.pid);
			expect(running.lastWebsocketUpgradeRejection).toEqual(expected);
			expect(JSON.stringify(running)).not.toContain("private-token");
		} finally {
			await stopChild(child);
		}
	}
});


it.each([{ requestBytes: -1 }, { tcpEndReceived: "false" }, { transportErrorCode: "private-code" }])("rejects invalid persisted or current WebSocket transport evidence: %j", async invalid => {
	const root = await createTempRoot("router-invalid-transport-");
	const scriptPath = createRouterFixture(root);
	const statePath = join(root, "state.json");
	const statusPath = join(root, "status.json");
	const diagnostic = { at: 123, cause: "close", stage: "awaiting_first_event", closeCode: 1006, ...invalid };
	await writeState(statePath, { clientApiKey: "fixture-token", host: "127.0.0.1", port: 0, statusPath });
	await writeState(statusPath, { lastWebsocketDisconnect: diagnostic });
	const child = spawn(process.execPath, [scriptPath, "--status", statusPath, "--state", statePath], {
		env: { ...process.env, CODEX_APP_ROUTER_TEST_DISCONNECT: JSON.stringify(diagnostic) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const running = await readJsonWhen(statusPath, value => value.state === "running");
		expect(running.lastWebsocketDisconnect).toBeNull();
		expect(JSON.stringify(running)).not.toContain("private-code");
	} finally {
		await stopChild(child);
	}
});
