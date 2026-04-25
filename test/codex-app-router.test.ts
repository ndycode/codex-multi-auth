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
				"  marker(`start:${options.host}:${options.port}:${options.clientApiKey}`);",
				"  return {",
				"    baseUrl: `http://${options.host}:${options.port || 4567}`,",
				"    close: async () => marker('close'),",
				"    getStatus: () => ({",
				"      totalRequests: 2,",
				"      upstreamRequests: 1,",
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
			expect(running.baseUrl).toBe("http://127.0.0.1:4567");
			expect(running.lastAccountLabel).toBe("Account 2");
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
