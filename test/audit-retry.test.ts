import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createBusyError(): NodeJS.ErrnoException {
	const error = new Error("resource busy") as NodeJS.ErrnoException;
	error.code = "EBUSY";
	return error;
}

describe("audit purge retry handling", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("node:fs");
		vi.doUnmock("../lib/runtime-paths.js");
		vi.restoreAllMocks();
	});

	it("retries stale audit log deletion on EBUSY and eventually purges", async () => {
		const writeFileSync = vi.fn();
		const mkdirSync = vi.fn();
		const existsSync = vi.fn((target: string) => !target.endsWith("audit.log"));
		const statSync = vi.fn(() => ({
			mtimeMs: 0,
			size: 0,
		}));
		const renameSync = vi.fn();
		const readdirSync = vi.fn(() => ["audit.1.log"]);

		let unlinkAttempts = 0;
		const unlinkSync = vi.fn(() => {
			unlinkAttempts += 1;
			if (unlinkAttempts < 3) {
				throw createBusyError();
			}
		});

		vi.doMock("node:fs", () => ({
			writeFileSync,
			mkdirSync,
			existsSync,
			statSync,
			renameSync,
			readdirSync,
			unlinkSync,
		}));
		vi.doMock("../lib/runtime-paths.js", () => ({
			getCodexLogDir: () => "/tmp/codex-logs",
		}));

		const audit = await import("../lib/audit.js");
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(3_000_000_000);

		try {
			audit.configureAudit({
				enabled: true,
				logDir: "/tmp/codex-logs",
				retentionDays: 1,
				maxFileSizeBytes: 1024,
				maxFiles: 3,
			});
			audit.auditLog(
				audit.AuditAction.REQUEST_START,
				"actor@example.com",
				"resource",
				audit.AuditOutcome.SUCCESS,
			);
		} finally {
			nowSpy.mockRestore();
		}

		expect(unlinkSync).toHaveBeenCalledTimes(3);
		expect(writeFileSync).toHaveBeenCalledTimes(1);
	});
});
