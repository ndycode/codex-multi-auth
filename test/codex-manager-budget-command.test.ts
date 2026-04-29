import { describe, expect, it, vi } from "vitest";
import { runBudgetCommand } from "../lib/codex-manager/commands/budget.js";
import type { BudgetGuardStore } from "../lib/budget-guard.js";
import type { UsageSummary } from "../lib/usage/index.js";

const summary: UsageSummary = {
	since: null,
	until: null,
	by: "model",
	totals: {
		key: "total",
		requests: 2,
		successes: 2,
		failures: 0,
		blocked: 0,
		cancelled: 0,
		inputTokens: 200,
		outputTokens: 0,
		cachedInputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 200,
		costUsd: 0.5,
	},
	buckets: [],
};

describe("budget command", () => {
	it("creates limits", async () => {
		const store: BudgetGuardStore = { version: 1, limits: {} };
		const deps = {
			loadStore: vi.fn(async () => store),
			saveStore: vi.fn(async () => undefined),
			logInfo: vi.fn(),
			logError: vi.fn(),
			getNow: () => 123,
		};
		const exitCode = await runBudgetCommand(
			["limit", "Project A", "--window", "day", "--requests", "5", "--tokens", "1000"],
			deps,
		);
		expect(exitCode).toBe(0);
		expect(store.limits["project-a"]).toMatchObject({
			window: "day",
			maxRequests: 5,
			maxTokens: 1000,
			updatedAt: 123,
		});
		expect(deps.saveStore).toHaveBeenCalledOnce();
	});

	it("checks limits with json output", async () => {
		const store: BudgetGuardStore = {
			version: 1,
			limits: {
				project: {
					key: "project",
					window: "day",
					maxRequests: 2,
					updatedAt: 1,
				},
			},
		};
		const logInfo = vi.fn();
		const exitCode = await runBudgetCommand(["check", "project", "--json"], {
			loadStore: async () => store,
			summarizeUsage: async () => summary,
			logInfo,
			logError: vi.fn(),
			getNow: () => Date.UTC(2026, 3, 29, 12),
		});
		expect(exitCode).toBe(1);
		const payload = JSON.parse(String(logInfo.mock.calls[0]?.[0])) as {
			evaluation: { allowed: boolean; reasons: string[] };
		};
		expect(payload.evaluation.allowed).toBe(false);
		expect(payload.evaluation.reasons[0]).toContain("request limit reached");
	});

	it("lists limits", async () => {
		const logInfo = vi.fn();
		const exitCode = await runBudgetCommand(["list"], {
			loadStore: async () => ({
				version: 1,
				limits: {
					project: {
						key: "project",
						window: "week",
						maxCostUsd: 3,
						updatedAt: 1,
					},
				},
			}),
			logInfo,
			logError: vi.fn(),
		});
		expect(exitCode).toBe(0);
		expect(String(logInfo.mock.calls[0]?.[0])).toContain("project: window=week");
	});
});

