import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it("preserves concurrent events across async log rotation", async () => {
		configureTelemetry({ maxFileSizeBytes: 220, maxFiles: 16 });

		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				recordTelemetryEvent({
					source: index % 2 === 0 ? "plugin" : "cli",
					event: `rotation.concurrent.${index}`,
					outcome: index % 3 === 0 ? "failure" : "success",
					details: {
						index,
						message: "x".repeat(96),
					},
				}),
			),
		);

		const events = await queryTelemetryEvents({ limit: 50 });

		expect(events).toHaveLength(12);
		expect(events.map((event) => event.event).sort()).toEqual(
			Array.from({ length: 12 }, (_, index) => `rotation.concurrent.${index}`).sort(),
		);
		expect(existsSync(`${getTelemetryLogPath()}.1`)).toBe(true);
	});
});
