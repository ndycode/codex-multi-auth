import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("idempotency store", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-idempotency-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("records first key use and replays duplicates", async () => {
		const { checkAndRecordIdempotencyKey, getIdempotencyStorePath } =
			await import("../lib/idempotency.js");

		expect(
			await checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-1"),
		).toEqual({ replayed: false });
		expect(
			await checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-1"),
		).toEqual({ replayed: true });

		const content = await fs.readFile(getIdempotencyStorePath(), "utf8");
		expect(content).toContain("codex.auth.rotate-secrets");
	});

	it("expires entries based on ttl", async () => {
		const { checkAndRecordIdempotencyKey } = await import("../lib/idempotency.js");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-03-05T00:00:00.000Z"));
			expect(
				await checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-2", 5),
			).toEqual({ replayed: false });
			vi.advanceTimersByTime(10);
			expect(
				await checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-2", 5),
			).toEqual({ replayed: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it("serializes concurrent duplicate key checks", async () => {
		const { checkAndRecordIdempotencyKey } = await import("../lib/idempotency.js");
		const [first, second] = await Promise.all([
			checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "shared-key"),
			checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "shared-key"),
		]);
		const results = [first, second];
		expect(results.filter((result) => result.replayed)).toHaveLength(1);
		expect(results.filter((result) => !result.replayed)).toHaveLength(1);
	});

	it("recovers from malformed persisted store content", async () => {
		const { checkAndRecordIdempotencyKey, getIdempotencyStorePath } = await import(
			"../lib/idempotency.js"
		);
		await fs.writeFile(getIdempotencyStorePath(), "{ malformed json", "utf8");
		await expect(
			checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-malformed"),
		).resolves.toEqual({ replayed: false });
	});

	it("retries transient rename failures while saving store", async () => {
		const { checkAndRecordIdempotencyKey } = await import("../lib/idempotency.js");
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(async () => {
			const error = new Error("busy") as NodeJS.ErrnoException;
			error.code = "EBUSY";
			throw error;
		});
		try {
			await expect(
				checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-retry"),
			).resolves.toEqual({ replayed: false });
			expect(renameSpy).toHaveBeenCalledTimes(2);
		} finally {
			renameSpy.mockRestore();
		}
	});

	it("normalizes non-finite ttl values to a safe minimum", async () => {
		const { checkAndRecordIdempotencyKey } = await import("../lib/idempotency.js");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-03-05T00:00:00.000Z"));
			await expect(
				checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-non-finite", Number.NaN),
			).resolves.toEqual({ replayed: false });
			await expect(
				checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-non-finite", Number.NaN),
			).resolves.toEqual({ replayed: true });
		} finally {
			vi.useRealTimers();
		}
	});
});
