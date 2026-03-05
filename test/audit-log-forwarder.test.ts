import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, utimesSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const scriptPath = path.resolve(process.cwd(), "scripts", "audit-log-forwarder.js");

function runForwarder(
	args: string[],
	env: NodeJS.ProcessEnv = {},
	timeoutMs = 10_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath, ...args], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			stderr += `${stderr ? "\n" : ""}runForwarder timed out after ${timeoutMs}ms`;
			child.kill();
		}, timeoutMs);
		const finish = (status: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({ status, stdout, stderr });
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			if (timedOut) {
				finish(null);
				return;
			}
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (status) => {
			finish(timedOut ? null : status);
		});
	});
}

function parseJsonStdout(output: string): Record<string, unknown> {
	return JSON.parse(output) as Record<string, unknown>;
}

async function withServer(
	handler: Parameters<typeof createServer>[0],
	run: (url: string) => Promise<void>,
): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("failed to resolve server address");
	}
	const endpoint = `http://127.0.0.1:${address.port}/ingest`;
	try {
		await run(endpoint);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("audit-log-forwarder script", () => {
	const fixtures: string[] = [];

	afterEach(async () => {
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await removeWithRetry(fixture);
		}
	});

	it("retries transient 429 responses and writes checkpoint", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "audit-forwarder-retry-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const checkpointPath = path.join(root, "checkpoint.json");
		await fs.mkdir(logDir, { recursive: true });
		await fs.writeFile(
			path.join(logDir, "audit.log"),
			'{"timestamp":"2026-03-01T00:00:00Z","action":"request.start"}\n{"timestamp":"2026-03-01T00:01:00Z","action":"request.success"}\n',
			"utf8",
		);

		let requestCount = 0;
		await withServer(async (_req, res) => {
			requestCount += 1;
			if (requestCount === 1) {
				res.statusCode = 429;
				res.end("rate limited");
				return;
			}
			res.statusCode = 200;
			res.end("ok");
		}, async (endpoint) => {
			const result = await runForwarder(
				[
					`--endpoint=${endpoint}`,
					`--log-dir=${logDir}`,
					`--checkpoint=${checkpointPath}`,
					"--batch-size=25",
				],
				{
					CODEX_AUDIT_FORWARDER_MAX_ATTEMPTS: "3",
					CODEX_AUDIT_FORWARDER_TIMEOUT_MS: "500",
				},
			);

			expect(result.status).toBe(0);
			const payload = parseJsonStdout(result.stdout);
			expect(payload.status).toBe("sent");
			expect(payload.sent).toBe(2);
			expect(requestCount).toBe(2);
		});

		const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as {
			file?: string;
			line?: number;
		};
		expect(checkpoint.file).toBe("audit.log");
		expect(checkpoint.line).toBe(2);
	});

	it("replays rotated tail when checkpoint line exceeds new active log length", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "audit-forwarder-rotation-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const checkpointPath = path.join(root, "checkpoint.json");
		await fs.mkdir(logDir, { recursive: true });
		await fs.writeFile(
			path.join(logDir, "audit.1.log"),
			'{"timestamp":"2026-03-01T00:00:00Z","id":"old-1"}\n{"timestamp":"2026-03-01T00:01:00Z","id":"old-2"}\n{"timestamp":"2026-03-01T00:02:00Z","id":"old-3"}\n',
			"utf8",
		);
		await fs.writeFile(
			path.join(logDir, "audit.log"),
			'{"timestamp":"2026-03-01T00:03:00Z","id":"new-1"}\n',
			"utf8",
		);
		await fs.writeFile(
			checkpointPath,
			JSON.stringify({ file: "audit.log", line: 2, updatedAt: "2026-03-01T00:02:00Z" }),
			"utf8",
		);

		const result = await runForwarder([
			"--dry-run",
			`--log-dir=${logDir}`,
			`--checkpoint=${checkpointPath}`,
			"--batch-size=25",
		]);
		expect(result.status).toBe(0);
		const payload = parseJsonStdout(result.stdout);
		expect(payload.status).toBe("dry-run");
		expect(payload.sent).toBe(2);
	});

	it("times out hanging endpoint requests and exits non-zero", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "audit-forwarder-timeout-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const checkpointPath = path.join(root, "checkpoint.json");
		await fs.mkdir(logDir, { recursive: true });
		await fs.writeFile(
			path.join(logDir, "audit.log"),
			'{"timestamp":"2026-03-01T00:00:00Z","action":"request.start"}\n',
			"utf8",
		);

		await withServer((_req, _res) => {
			// Intentionally never respond.
		}, async (endpoint) => {
			const result = await runForwarder(
				[
					`--endpoint=${endpoint}`,
					`--log-dir=${logDir}`,
					`--checkpoint=${checkpointPath}`,
				],
				{
					CODEX_AUDIT_FORWARDER_MAX_ATTEMPTS: "2",
					CODEX_AUDIT_FORWARDER_TIMEOUT_MS: "50",
				},
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("audit-log-forwarder failed");
		});

		await expect(fs.stat(checkpointPath)).rejects.toThrow();
	});

	it("waits for checkpoint lock release and then completes", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "audit-forwarder-lock-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const checkpointPath = path.join(root, "checkpoint.json");
		const checkpointLockPath = `${checkpointPath}.lock`;
		await fs.mkdir(logDir, { recursive: true });
		await fs.writeFile(
			path.join(logDir, "audit.log"),
			'{"timestamp":"2026-03-01T00:00:00Z","action":"request.start"}\n',
			"utf8",
		);
		await fs.writeFile(checkpointLockPath, "locked", "utf8");

		await withServer((_req, res) => {
			res.statusCode = 200;
			res.end("ok");
		}, async (endpoint) => {
			const releaseTimer = setTimeout(async () => {
				await fs.unlink(checkpointLockPath).catch(() => {});
			}, 50);
			try {
				const result = await runForwarder(
					[
						`--endpoint=${endpoint}`,
						`--log-dir=${logDir}`,
						`--checkpoint=${checkpointPath}`,
					],
					{
						CODEX_AUDIT_FORWARDER_MAX_ATTEMPTS: "2",
						CODEX_AUDIT_FORWARDER_TIMEOUT_MS: "2000",
						CODEX_AUDIT_FORWARDER_MAX_WAIT_MS: "2000",
						CODEX_AUDIT_FORWARDER_LOCK_MAX_ATTEMPTS: "200",
					},
				);
				expect(result.status).toBe(0);
			} finally {
				clearTimeout(releaseTimer);
			}
		});

		const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as {
			file?: string;
			line?: number;
		};
		expect(checkpoint.file).toBe("audit.log");
		expect(checkpoint.line).toBe(1);
	});

	it("clears stale checkpoint locks and proceeds", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "audit-forwarder-stale-lock-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const checkpointPath = path.join(root, "checkpoint.json");
		const checkpointLockPath = `${checkpointPath}.lock`;
		await fs.mkdir(logDir, { recursive: true });
		await fs.writeFile(
			path.join(logDir, "audit.log"),
			'{"timestamp":"2026-03-01T00:00:00Z","action":"request.start"}\n',
			"utf8",
		);
		await fs.writeFile(checkpointLockPath, "999999\n", "utf8");
		const staleDate = new Date(Date.now() - 60 * 1000);
		utimesSync(checkpointLockPath, staleDate, staleDate);

		await withServer((_req, res) => {
			res.statusCode = 200;
			res.end("ok");
		}, async (endpoint) => {
			const result = await runForwarder(
				[
					`--endpoint=${endpoint}`,
					`--log-dir=${logDir}`,
					`--checkpoint=${checkpointPath}`,
				],
				{
					CODEX_AUDIT_FORWARDER_STALE_LOCK_MS: "50",
					CODEX_AUDIT_FORWARDER_MAX_WAIT_MS: "500",
				},
			);
			expect(result.status).toBe(0);
			const payload = parseJsonStdout(result.stdout);
			expect(payload.status).toBe("sent");
			expect(payload.sent).toBe(1);
		});

		const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as {
			file?: string;
			line?: number;
		};
		expect(checkpoint.file).toBe("audit.log");
		expect(checkpoint.line).toBe(1);
	});

	it("fails with a clear timeout when checkpoint lock contention persists", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "audit-forwarder-lock-timeout-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const checkpointPath = path.join(root, "checkpoint.json");
		const checkpointLockPath = `${checkpointPath}.lock`;
		await fs.mkdir(logDir, { recursive: true });
		await fs.writeFile(
			path.join(logDir, "audit.log"),
			'{"timestamp":"2026-03-01T00:00:00Z","action":"request.start"}\n',
			"utf8",
		);
		await fs.writeFile(checkpointLockPath, `${process.pid}\n`, "utf8");

		await withServer((_req, res) => {
			res.statusCode = 200;
			res.end("ok");
		}, async (endpoint) => {
			const result = await runForwarder(
				[
					`--endpoint=${endpoint}`,
					`--log-dir=${logDir}`,
					`--checkpoint=${checkpointPath}`,
				],
				{
					CODEX_AUDIT_FORWARDER_MAX_WAIT_MS: "80",
					CODEX_AUDIT_FORWARDER_LOCK_MAX_ATTEMPTS: "10",
				},
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Timed out acquiring checkpoint lock");
		});
	});

	it("continues when newest log disappears before final mtime stat", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "audit-forwarder-newest-race-"));
		fixtures.push(root);
		const logDir = path.join(root, "logs");
		const checkpointPath = path.join(root, "checkpoint.json");
		const newestLogPath = path.join(logDir, "audit.log");
		await fs.mkdir(logDir, { recursive: true });
		await fs.writeFile(
			newestLogPath,
			'{"timestamp":"2026-03-01T00:00:00Z","action":"request.start"}\n',
			"utf8",
		);

		await withServer(async (_req, res) => {
			await fs.unlink(newestLogPath).catch(() => {});
			res.statusCode = 200;
			res.end("ok");
		}, async (endpoint) => {
			const result = await runForwarder([
				`--endpoint=${endpoint}`,
				`--log-dir=${logDir}`,
				`--checkpoint=${checkpointPath}`,
			]);
			expect(result.status).toBe(0);
			const payload = parseJsonStdout(result.stdout);
			expect(payload.status).toBe("sent");
			expect(payload.newestLogMtimeMs).toBeNull();
		});

		const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as {
			file?: string;
			line?: number;
		};
		expect(checkpoint.file).toBe("audit.log");
		expect(checkpoint.line).toBe(1);
	});
});
