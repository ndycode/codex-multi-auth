import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeWithRetry } from "./helpers/fs-retry.js";

const acquireFileLockMock = vi.fn();

vi.mock("../lib/file-lock.js", () => ({
	acquireFileLock: acquireFileLockMock,
}));

describe("telemetry lock coordination", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-telemetry-lock-"));
		vi.resetModules();
		acquireFileLockMock.mockReset();
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetry(tempDir, { recursive: true, force: true });
		}
	});

	it("acquires and releases a file lock for telemetry writes", async () => {
		const release = vi.fn(async () => {});
		acquireFileLockMock.mockResolvedValue({
			path: join(tempDir, "product-telemetry.jsonl.lock"),
			release,
		});

		const telemetry = await import("../lib/telemetry.js");
		telemetry.configureTelemetry({
			enabled: true,
			logDir: tempDir,
			fileName: "product-telemetry.jsonl",
			maxFileSizeBytes: 1_000_000,
			maxFiles: 4,
		});

		await telemetry.recordTelemetryEvent({
			source: "plugin",
			event: "request.locked_write",
			outcome: "info",
			details: { token: "sk-live-lock-test-token" },
		});

		expect(acquireFileLockMock).toHaveBeenCalledWith(
			expect.stringContaining("product-telemetry.jsonl.lock"),
		);
		expect(release).toHaveBeenCalledTimes(1);

		const events = await telemetry.queryTelemetryEvents({ limit: 10 });
		expect(events.some((event) => event.event === "request.locked_write")).toBe(true);
	});
});
