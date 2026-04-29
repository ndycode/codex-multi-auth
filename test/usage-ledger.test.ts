import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("usage ledger core", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-usage-ledger-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("appends normalized JSONL rows without raw email or account identifiers", async () => {
		const {
			appendUsageLedgerRow,
			getUsageLedgerPaths,
			readUsageLedgerRows,
		} = await import("../lib/usage/index.js");

		const row = await appendUsageLedgerRow({
			id: "row-1",
			createdAt: 1_700_000_000_000,
			source: "runtime-proxy",
			operation: "responses",
			outcome: "success",
			model: " gpt-5.3-codex ",
			accountId: "acct_sensitive_123",
			email: "Owner@Example.com",
			accountIndex: 2,
			requestId: "req_123",
			statusCode: 200,
			durationMs: 123.9,
			inputTokens: 1_000,
			outputTokens: 200,
			cachedInputTokens: 50,
			reasoningTokens: 25,
		});

		expect(row.model).toBe("gpt-5.3-codex");
		expect(row.account?.accountHash).toMatch(/^sha256:/);
		expect(row.account?.emailHash).toMatch(/^sha256:/);
		expect(row.account?.index).toBe(2);
		expect(row.tokens.totalTokens).toBe(1_225);
		expect(row.tokens.cachedInputTokens).toBe(50);
		expect(row.costUsd).toBeGreaterThan(0);

		const raw = await fs.readFile(getUsageLedgerPaths().current, "utf8");
		expect(raw).toContain('"version":1');
		expect(raw).not.toContain("acct_sensitive_123");
		expect(raw).not.toContain("Owner@Example.com");
		expect(raw).not.toContain("owner@example.com");

		await expect(readUsageLedgerRows()).resolves.toEqual([row]);
	});

	it("summarizes usage by model and applies date filters", async () => {
		const { appendUsageLedgerRow, summarizeUsageLedger } = await import(
			"../lib/usage/index.js"
		);

		await appendUsageLedgerRow({
			id: "old",
			createdAt: 100,
			outcome: "success",
			model: "gpt-5.3-codex",
			inputTokens: 100,
			outputTokens: 10,
		});
		await appendUsageLedgerRow({
			id: "new-success",
			createdAt: 200,
			outcome: "success",
			model: "gpt-5.3-codex",
			inputTokens: 200,
			outputTokens: 20,
		});
		await appendUsageLedgerRow({
			id: "new-failure",
			createdAt: 300,
			outcome: "failure",
			model: "gpt-5.5",
			inputTokens: 50,
			outputTokens: 5,
		});

		const summary = await summarizeUsageLedger({ since: 150, by: "model" });

		expect(summary.totals.requests).toBe(2);
		expect(summary.totals.successes).toBe(1);
		expect(summary.totals.failures).toBe(1);
		expect(summary.totals.inputTokens).toBe(250);
		expect(summary.buckets.map((bucket) => bucket.key)).toEqual([
			"gpt-5.3-codex",
			"gpt-5.5",
		]);
		expect(summary.buckets[0]?.requests).toBe(1);
	});

	it("rotates the current ledger and can include archived rows", async () => {
		const {
			appendUsageLedgerRow,
			getUsageLedgerPaths,
			readUsageLedgerRows,
			rotateUsageLedger,
		} = await import("../lib/usage/index.js");

		await appendUsageLedgerRow({
			id: "before-rotate",
			createdAt: 100,
			outcome: "success",
			model: "gpt-5.3-codex",
		});
		const lockPath = `${getUsageLedgerPaths().current}.lock`;
		await fs.writeFile(lockPath, "stale\n", "utf8");
		const staleDate = new Date(Date.now() - 60_000);
		await fs.utimes(lockPath, staleDate, staleDate);

		const rotated = await rotateUsageLedger({
			now: Date.UTC(2026, 0, 2, 3, 4, 5, 6),
		});

		expect(rotated).toContain("usage-ledger.20260102T030405006Z.jsonl");
		await expect(fs.stat(lockPath)).rejects.toThrow();
		await expect(fs.stat(getUsageLedgerPaths().current)).rejects.toThrow();

		await appendUsageLedgerRow({
			id: "after-rotate",
			createdAt: 200,
			outcome: "success",
			model: "gpt-5.5",
		});

		expect((await readUsageLedgerRows()).map((row) => row.id)).toEqual([
			"after-rotate",
		]);
		expect(
			(await readUsageLedgerRows({ includeArchives: true })).map(
				(row) => row.id,
			),
		).toEqual(["before-rotate", "after-rotate"]);
	});

	it("skips rotation when below the configured byte threshold", async () => {
		const { appendUsageLedgerRow, rotateUsageLedger } = await import(
			"../lib/usage/index.js"
		);

		await appendUsageLedgerRow({
			id: "small",
			createdAt: 100,
			outcome: "success",
		});

		await expect(
			rotateUsageLedger({ ifLargerThanBytes: 1_000_000 }),
		).resolves.toBeNull();
	});

	it("retries transient lock close failures before removing the lock", async () => {
		const realOpen = fs.open.bind(fs);
		const openSpy = vi.spyOn(fs, "open");
		openSpy.mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
			const handle = await realOpen(...args);
			let closeAttempts = 0;
			return new Proxy(handle, {
				get(target, property, receiver) {
					if (property === "close") {
						return async () => {
							closeAttempts += 1;
							if (closeAttempts === 1) {
								throw Object.assign(new Error("close busy"), { code: "EBUSY" });
							}
							return target.close();
						};
					}
					return Reflect.get(target, property, receiver);
				},
			}) as Awaited<ReturnType<typeof fs.open>>;
		});
		const { appendUsageLedgerRow, getUsageLedgerPaths } = await import(
			"../lib/usage/index.js"
		);

		await appendUsageLedgerRow({ id: "close-retry", outcome: "success" });

		const paths = getUsageLedgerPaths();
		await expect(fs.access(`${paths.current}.lock`)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("exports pricing helpers with deterministic estimates", async () => {
		const { estimateUsageCostUsd, listUsageModelPricing } = await import(
			"../lib/usage/index.js"
		);

		expect(Object.keys(listUsageModelPricing())).toContain("gpt-5.3-codex");
		expect(
			estimateUsageCostUsd("gpt-5.3-codex", {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cachedInputTokens: 1_000_000,
				reasoningTokens: 1_000_000,
				totalTokens: 4_000_000,
			}),
		).toBe(20.125);
		expect(
			estimateUsageCostUsd("gpt-5.3-codex", {
				inputTokens: 1_000,
				outputTokens: 200,
				cachedInputTokens: 50,
				reasoningTokens: 25,
				totalTokens: 1_225,
			}),
		).toBe(0.00344375);
		expect(
			estimateUsageCostUsd(null, {
				inputTokens: 1,
				outputTokens: 1,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 2,
			}),
		).toBeNull();
		expect(
			estimateUsageCostUsd("unknown-model", {
				inputTokens: 1,
				outputTokens: 1,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 2,
			}),
		).toBeNull();
	});

	it("retries transient append failures", async () => {
		const { appendUsageLedgerRow } = await import("../lib/usage/index.js");
		const realAppend = fs.appendFile.bind(fs);
		const appendSpy = vi.spyOn(fs, "appendFile");
		let attempts = 0;
		appendSpy.mockImplementation(async (...args) => {
			attempts += 1;
			if (attempts === 1) {
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			return realAppend(...args);
		});

		try {
			await appendUsageLedgerRow({
				id: "retry",
				outcome: "success",
			});
			expect(attempts).toBe(2);
		} finally {
			appendSpy.mockRestore();
		}
	});

	it("removes stale append locks before writing", async () => {
		const {
			appendUsageLedgerRow,
			getUsageLedgerPaths,
			readUsageLedgerRows,
		} = await import("../lib/usage/index.js");
		const { dir, current } = getUsageLedgerPaths();
		const lockPath = `${current}.lock`;
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(lockPath, "stale\n", "utf8");
		const staleDate = new Date(Date.now() - 60_000);
		await fs.utimes(lockPath, staleDate, staleDate);

		await appendUsageLedgerRow({
			id: "after-stale-lock",
			outcome: "success",
		});

		await expect(fs.stat(lockPath)).rejects.toThrow();
		expect((await readUsageLedgerRows()).map((row) => row.id)).toEqual([
			"after-stale-lock",
		]);
	});
});

