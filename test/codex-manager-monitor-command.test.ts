import { describe, expect, it, vi } from "vitest";
import { runMonitorCommand } from "../lib/codex-manager/commands/monitor.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const storage: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	activeIndexByFamily: { codex: 0 },
	accounts: [
		{
			email: "owner@example.com",
			accountId: "acct_1",
			refreshToken: "refresh",
			addedAt: 1,
			lastUsed: 1,
		},
	],
};

describe("monitor command", () => {
	it("prints json aggregate output without raw account labels", async () => {
		const logInfo = vi.fn();
		const exitCode = await runMonitorCommand(["--json"], {
			setStoragePath: vi.fn(),
			loadAccounts: async () => storage,
			loadRuntimeObservabilitySnapshot: async () => null,
			loadQuotaCache: async () => ({ byAccountId: {}, byEmail: {} }),
			loadAccountPolicyStore: async () => ({
				version: 1,
				accounts: {},
			}),
			loadBudgetGuardStore: async () => ({ version: 1, limits: {} }),
			resolveProjectRoutingProfile: async () => ({
				startDir: "/repo",
				projectRoot: "/repo",
				identityRoot: "/repo",
				projectKey: "project-a",
				profile: null,
			}),
			summarizeUsageLedger: async () => ({
				since: null,
				until: null,
				by: "outcome",
				totals: {
					key: "total",
					requests: 2,
					successes: 1,
					failures: 1,
					blocked: 0,
					cancelled: 0,
					inputTokens: 10,
					outputTokens: 20,
					cachedInputTokens: 0,
					reasoningTokens: 0,
					totalTokens: 30,
					costUsd: 0.001,
				},
				buckets: [],
			}),
			logInfo,
			logError: vi.fn(),
			getNow: () => 123,
		});

		expect(exitCode).toBe(0);
		const output = String(logInfo.mock.calls[0]?.[0]);
		const payload = JSON.parse(output) as {
			project: { projectKey: string };
			accounts: { count: number };
			modelMatrix: { entries: number };
		};
		expect(payload.project.projectKey).toBe("project-a");
		expect(payload.accounts.count).toBe(1);
		expect(payload.modelMatrix.entries).toBeGreaterThan(0);
		expect(output).not.toContain("owner@example.com");
	});

	it("rejects unknown options", async () => {
		const logError = vi.fn();
		const exitCode = await runMonitorCommand(["--bad"], {
			setStoragePath: vi.fn(),
			loadAccounts: async () => storage,
			logInfo: vi.fn(),
			logError,
		});
		expect(exitCode).toBe(1);
		expect(String(logError.mock.calls[0]?.[0])).toContain("Unknown monitor option");
	});
});
