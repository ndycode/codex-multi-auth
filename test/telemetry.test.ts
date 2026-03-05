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
				accessToken: "test_access_token_redaction_fixture",
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

	it("ignores malformed telemetry entries with unknown source or outcome", async () => {
		const filePath = getTelemetryLogPath();
		await fs.writeFile(
			filePath,
			[
				JSON.stringify({
					timestamp: "2026-03-01T00:00:00.000Z",
					source: "plugin",
					event: "request.ok",
					outcome: "success",
					correlationId: null,
				}),
				JSON.stringify({
					timestamp: "2026-03-01T00:00:01.000Z",
					source: "unknown-source",
					event: "request.bad_source",
					outcome: "failure",
					correlationId: null,
				}),
				JSON.stringify({
					timestamp: "2026-03-01T00:00:02.000Z",
					source: "cli",
					event: "request.bad_outcome",
					outcome: "unknown-outcome",
					correlationId: null,
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const events = await queryTelemetryEvents({ limit: 10 });
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe("request.ok");

		const summary = summarizeTelemetryEvents(events);
		expect(summary.total).toBe(1);
		expect(summary.bySource).toEqual({ cli: 0, plugin: 1 });
		expect(summary.byOutcome).toEqual({
			start: 0,
			success: 1,
			failure: 0,
			recovery: 0,
			info: 0,
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

	it("serializes concurrent appends without dropping events", async () => {
		configureTelemetry({ maxFileSizeBytes: 1_000_000, maxFiles: 12 });
		const eventCount = 50;
		await Promise.all(
			Array.from({ length: eventCount }, (_, index) =>
				recordTelemetryEvent({
					source: "plugin",
					event: `request.concurrent.${index}`,
					outcome: "info",
					details: { index },
				}),
			),
		);

		const events = await queryTelemetryEvents({ limit: 200 });
		const concurrentEvents = events.filter((entry) => entry.event.startsWith("request.concurrent."));
		expect(concurrentEvents).toHaveLength(eventCount);
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

	it("retries transient fs.rm errors during cleanup helper", async () => {
		const lockedError = Object.assign(new Error("busy"), { code: "EPERM" }) as NodeJS.ErrnoException;
		const fsMutable = fs as unknown as { rm: typeof fs.rm };
		const originalRm = fsMutable.rm.bind(fs);
		let attempts = 0;
		fsMutable.rm = (async (
			path: Parameters<typeof fs.rm>[0],
			options?: Parameters<typeof fs.rm>[1],
		) => {
			attempts += 1;
			if (attempts === 1) {
				throw lockedError;
			}
			return originalRm(path, options);
		}) as typeof fs.rm;

		const target = join(tempDir, "cleanup-target");
		await fs.mkdir(target, { recursive: true });

		try {
			await removeWithRetry(target, { recursive: true, force: true });
		} finally {
			fsMutable.rm = originalRm;
		}

		expect(attempts).toBe(2);
	});
});
