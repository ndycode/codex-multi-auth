import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configureTelemetry,
	getTelemetryConfig,
	getTelemetryLogPath,
	queryTelemetryEvents,
	recordTelemetryEvent,
	summarizeTelemetryEvents,
} from "../lib/telemetry.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("telemetry module", () => {
	let tempDir = "";
	const originalConfig = getTelemetryConfig();

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-telemetry-"));
		configureTelemetry({
			enabled: true,
			logDir: tempDir,
			fileName: "product-telemetry.jsonl",
			maxFileSizeBytes: 512,
			maxFiles: 4,
		});
	});

	afterEach(async () => {
		configureTelemetry(originalConfig);
		if (tempDir) {
			await removeWithRetry(tempDir, { recursive: true, force: true });
		}
	});

	it("records telemetry events with redacted sensitive fields", async () => {
		await recordTelemetryEvent({
			source: "cli",
			event: "cli.command.finish",
			outcome: "failure",
			details: {
				email: "user@example.com",
				accessToken: "sk-1234567890abcdefghij",
				nested: {
					authorization: "Bearer secret-value",
				},
			},
		});

		const events = await queryTelemetryEvents({ limit: 10 });
		expect(events).toHaveLength(1);
		expect(events[0]?.details).toEqual({
			email: "us***@***.com",
			accessToken: "***MASKED***",
			nested: {
				authorization: "***MASKED***",
			},
		});
	});

	it("filters telemetry events by since window and limit", async () => {
		const now = Date.now();
		const filePath = getTelemetryLogPath();
		await fs.writeFile(
			filePath,
			[
				JSON.stringify({
					timestamp: new Date(now - 48 * 60 * 60_000).toISOString(),
					source: "plugin",
					event: "request.old",
					outcome: "failure",
					correlationId: null,
				}),
				JSON.stringify({
					timestamp: new Date(now - 90 * 60_000).toISOString(),
					source: "plugin",
					event: "request.mid",
					outcome: "failure",
					correlationId: null,
				}),
				JSON.stringify({
					timestamp: new Date(now - 30 * 60_000).toISOString(),
					source: "cli",
					event: "cli.new",
					outcome: "success",
					correlationId: null,
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const recent = await queryTelemetryEvents({
			sinceMs: now - 2 * 60 * 60_000,
			limit: 10,
		});
		expect(recent.map((event) => event.event)).toEqual(["request.mid", "cli.new"]);

		const limited = await queryTelemetryEvents({
			sinceMs: 0,
			limit: 1,
		});
		expect(limited).toHaveLength(1);
		expect(limited[0]?.event).toBe("cli.new");
	});

	it("summarizes telemetry events by source, outcome, and event key", () => {
		const summary = summarizeTelemetryEvents([
			{
				timestamp: "2026-03-01T00:00:00.000Z",
				source: "cli",
				event: "cli.command.finish",
				outcome: "success",
				correlationId: null,
			},
			{
				timestamp: "2026-03-01T00:00:01.000Z",
				source: "plugin",
				event: "request.server_error",
				outcome: "failure",
				correlationId: null,
			},
			{
				timestamp: "2026-03-01T00:00:02.000Z",
				source: "plugin",
				event: "request.server_error",
				outcome: "failure",
				correlationId: null,
			},
		]);

		expect(summary.total).toBe(3);
		expect(summary.bySource).toEqual({ cli: 1, plugin: 2 });
		expect(summary.byOutcome.failure).toBe(2);
		expect(summary.byEvent[0]).toEqual({ event: "request.server_error", count: 2 });
		expect(summary.firstTimestamp).toBe("2026-03-01T00:00:00.000Z");
		expect(summary.lastTimestamp).toBe("2026-03-01T00:00:02.000Z");
	});

	it("rotates telemetry log files when max size is exceeded", async () => {
		configureTelemetry({ maxFileSizeBytes: 180, maxFiles: 3 });

		for (let i = 0; i < 10; i += 1) {
			await recordTelemetryEvent({
				source: "plugin",
				event: "request.network_error",
				outcome: "failure",
				details: {
					index: i,
					message: "x".repeat(80),
				},
			});
		}

		expect(existsSync(getTelemetryLogPath())).toBe(true);
		expect(existsSync(`${getTelemetryLogPath()}.1`)).toBe(true);
	});

	it("retries transient Windows lock errors during telemetry rotation", async () => {
		configureTelemetry({ maxFileSizeBytes: 64, maxFiles: 3 });
		const logPath = getTelemetryLogPath();
		await fs.writeFile(logPath, `${"x".repeat(256)}\n`, "utf8");

		const originalRename = fs.rename.bind(fs);
		let renameAttempts = 0;
		const renameSpy = vi
			.spyOn(fs, "rename")
			.mockImplementation(async (oldPath, newPath) => {
				if (
					oldPath === logPath &&
					newPath === `${logPath}.1` &&
					renameAttempts === 0
				) {
					renameAttempts += 1;
					const err = new Error("busy") as NodeJS.ErrnoException;
					err.code = "EBUSY";
					throw err;
				}
				renameAttempts += 1;
				await originalRename(oldPath, newPath);
			});

		try {
			await recordTelemetryEvent({
				source: "plugin",
				event: "request.retry_rotation",
				outcome: "failure",
				details: { reason: "simulated lock" },
			});
		} finally {
			renameSpy.mockRestore();
		}

		expect(renameAttempts).toBeGreaterThanOrEqual(2);
		expect(existsSync(`${logPath}.1`)).toBe(true);
		const events = await queryTelemetryEvents({ limit: 20 });
		expect(events.some((event) => event.event === "request.retry_rotation")).toBe(true);
	});

	it("serializes concurrent telemetry writes without dropping events", async () => {
		const total = 30;
		await Promise.all(
			Array.from({ length: total }, (_, index) =>
				recordTelemetryEvent({
					source: "plugin",
					event: "request.concurrent",
					outcome: "info",
					details: {
						index,
						token: `sk-concurrent-token-${String(index).padStart(4, "0")}`,
					},
				}),
			),
		);

		const raw = await fs.readFile(getTelemetryLogPath(), "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(total);

		const parsed = lines.map((line) => JSON.parse(line) as { details?: Record<string, unknown> });
		expect(parsed.every((entry) => entry.details?.token === "***MASKED***")).toBe(true);
	});
});
