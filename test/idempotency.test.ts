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
		expect(
			await checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-2", 5),
		).toEqual({ replayed: false });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			await checkAndRecordIdempotencyKey("codex.auth.rotate-secrets", "key-2", 5),
		).toEqual({ replayed: false });
	});
});