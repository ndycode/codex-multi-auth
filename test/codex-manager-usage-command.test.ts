import { describe, expect, it, vi } from "vitest";
import type { UsageLedgerRow, UsageSummary } from "../lib/usage/index.js";
import { runUsageCommand } from "../lib/codex-manager/commands/usage.js";

function makeSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
	return {
		since: null,
		until: null,
		by: "model",
		totals: {
			key: "total",
			requests: 2,
			successes: 1,
			failures: 1,
			blocked: 0,
			cancelled: 0,
			inputTokens: 100,
			outputTokens: 50,
			cachedInputTokens: 25,
			reasoningTokens: 10,
			totalTokens: 185,
			costUsd: 0.01234567,
		},
		buckets: [
			{
				key: "gpt-5.3-codex",
				requests: 2,
				successes: 1,
				failures: 1,
				blocked: 0,
				cancelled: 0,
				inputTokens: 100,
				outputTokens: 50,
				cachedInputTokens: 25,
				reasoningTokens: 10,
				totalTokens: 185,
				costUsd: 0.01234567,
			},
		],
		...overrides,
	};
}

const rows: UsageLedgerRow[] = [
	{
		version: 1,
		id: "row-1",
		createdAt: 100,
		source: "runtime-proxy",
		operation: "responses",
		outcome: "success",
		model: "gpt-5.3-codex",
		projectKey: null,
		account: null,
		requestId: null,
		statusCode: 200,
		errorCode: null,
		durationMs: 10,
		tokens: {
			inputTokens: 100,
			outputTokens: 50,
			cachedInputTokens: 25,
			reasoningTokens: 10,
			totalTokens: 185,
		},
		costUsd: 0.01234567,
	},
];

describe("usage command", () => {
	it("prints text summaries by default", async () => {
		const logInfo = vi.fn();
		const exitCode = await runUsageCommand([], {
			logInfo,
			summarizeUsage: async () => makeSummary(),
			readRows: async () => rows,
		});

		expect(exitCode).toBe(0);
		expect(String(logInfo.mock.calls[0]?.[0])).toContain(
			"Usage summary by model",
		);
		expect(String(logInfo.mock.calls[0]?.[0])).toContain("gpt-5.3-codex");
	});

	it("prints json payloads with rows", async () => {
		const logInfo = vi.fn();
		const exitCode = await runUsageCommand(["--json"], {
			logInfo,
			summarizeUsage: async () => makeSummary(),
			readRows: async () => rows,
		});

		expect(exitCode).toBe(0);
		const payload = JSON.parse(String(logInfo.mock.calls[0]?.[0])) as {
			command: string;
			rows: UsageLedgerRow[];
			summary: UsageSummary;
		};
		expect(payload.command).toBe("usage");
		expect(payload.rows[0]?.id).toBe("row-1");
		expect(payload.summary.totals.requests).toBe(2);
	});

	it("prints csv output", async () => {
		const logInfo = vi.fn();
		const exitCode = await runUsageCommand(["--csv", "--by", "day"], {
			logInfo,
			summarizeUsage: async (query) => makeSummary({ by: query.by }),
			readRows: async () => rows,
		});

		expect(exitCode).toBe(0);
		const output = String(logInfo.mock.calls[0]?.[0]);
		expect(output).toContain("key,requests,successes");
		expect(output).toContain("gpt-5.3-codex,2,1,1");
	});

	it("writes rendered output to a file", async () => {
		const writeFile = vi.fn(async () => undefined);
		const logInfo = vi.fn();
		const exitCode = await runUsageCommand(["--out", "usage.txt"], {
			logInfo,
			writeFile,
			getCwd: () => "/workspace",
			summarizeUsage: async () => makeSummary(),
			readRows: async () => rows,
		});

		expect(exitCode).toBe(0);
		expect(writeFile).toHaveBeenCalledWith(
			expect.stringContaining("usage.txt"),
			expect.stringContaining("Usage summary by model"),
		);
		expect(String(logInfo.mock.calls[0]?.[0])).toContain("Usage report written");
	});

	it("rotates the ledger", async () => {
		const logInfo = vi.fn();
		const rotateLedger = vi.fn(async () => "/usage/usage-ledger.rotated.jsonl");
		const exitCode = await runUsageCommand(
			["rotate", "--if-larger-than-bytes", "10", "--json"],
			{
				logInfo,
				rotateLedger,
			},
		);

		expect(exitCode).toBe(0);
		expect(rotateLedger).toHaveBeenCalledWith({ ifLargerThanBytes: 10 });
		expect(JSON.parse(String(logInfo.mock.calls[0]?.[0]))).toEqual({
			command: "usage rotate",
			rotated: true,
			path: "/usage/usage-ledger.rotated.jsonl",
		});
	});

	it("rejects invalid options", async () => {
		const logError = vi.fn();
		const exitCode = await runUsageCommand(["--json", "--csv"], {
			logError,
			logInfo: vi.fn(),
		});

		expect(exitCode).toBe(1);
		expect(String(logError.mock.calls[0]?.[0])).toContain(
			"Cannot combine --json and --csv",
		);
	});
});

