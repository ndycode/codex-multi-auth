import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAccountPolicyKey } from "../lib/account-policy.js";
import {
	createRuntimeUsageRecorder,
	evaluateRuntimePolicy,
	type RuntimePolicyState,
} from "../lib/policy/runtime-policy.js";
import { appendUsageLedgerRow, rotateUsageLedger } from "../lib/usage/index.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function state(): RuntimePolicyState {
	return {
		accountPolicies: { version: 1, accounts: {} },
		budgets: { version: 1, limits: {} },
		project: {
			startDir: "/repo",
			projectRoot: "/repo",
			identityRoot: "/repo",
			projectKey: "project-a",
			profile: null,
		},
	};
}

describe("runtime policy", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-runtime-policy-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("blocks paused accounts and adds profile score boosts", async () => {
		const policyState = state();
		const accountKey = getAccountPolicyKey({ accountId: "acct_1" }, 0);
		policyState.accountPolicies.accounts[accountKey] = {
			accountKey,
			tags: ["fast"],
			weight: 3,
			paused: true,
			drained: false,
			note: null,
			updatedAt: 1,
		};
		policyState.project.profile = {
			projectKey: "project-a",
			projectName: "Project A",
			identityRoot: "/repo",
			preferredTags: ["fast"],
			avoidTags: [],
			modelAllowlist: ["gpt-5.3-codex"],
			modelDenylist: [],
			accountWeightByKey: { [accountKey]: 2 },
			budgetKey: null,
			updatedAt: 1,
		};

		const decision = await evaluateRuntimePolicy({
			state: policyState,
			accounts: [{ index: 0, accountId: "acct_1", email: "owner@example.com" }],
			model: "gpt-5.3-codex",
			now: 100,
		});

		expect(decision.allowed).toBe(true);
		expect(decision.blockedAccountIndexes.has(0)).toBe(true);
		expect(decision.scoreBoostByAccount[0]).toBe(16);
	});

	// quota-forecast-01: capability suppression reads the store under the SAME key
	// the recordUnsupported sites write (resolveEntitlementAccountKey). A record
	// written under that key must cause evaluateRuntimePolicy to block the account.
	it("blocks an account whose model was recorded unsupported (key alignment)", async () => {
		const { CapabilityPolicyStore } = await import("../lib/capability-policy.js");
		const { resolveEntitlementAccountKey } = await import("../lib/entitlement-cache.js");
		const capabilityPolicy = new CapabilityPolicyStore();

		const account = { index: 0, accountId: "acct_cap", email: "cap@example.com" };
		const model = "gpt-5.3-codex";
		const entitlementKey = resolveEntitlementAccountKey({
			accountId: account.accountId,
			email: account.email,
			index: account.index,
		});
		// Record enough unsupported hits that the snapshot reports unsupported > 0.
		capabilityPolicy.recordUnsupported(entitlementKey, model);

		const decision = await evaluateRuntimePolicy({
			state: state(),
			accounts: [account],
			model,
			now: 100,
			capabilityPolicy,
		});

		expect(decision.blockedAccountIndexes.has(0)).toBe(true);
	});

	it("blocks requests when a matching budget is exhausted", async () => {
		const policyState = state();
		policyState.budgets.limits.global = {
			key: "global",
			window: "day",
			maxRequests: 1,
			updatedAt: 1,
		};
		await appendUsageLedgerRow({
			createdAt: Date.UTC(2026, 3, 29, 1),
			source: "runtime-proxy",
			operation: "responses",
			outcome: "success",
			model: "gpt-5.3-codex",
		});

		const decision = await evaluateRuntimePolicy({
			state: policyState,
			accounts: [],
			model: "gpt-5.3-codex",
			now: Date.UTC(2026, 3, 29, 2),
		});

		expect(decision.allowed).toBe(false);
		expect(decision.statusCode).toBe(429);
		expect(decision.errorCode).toBe("budget_blocked");
	});

	// budget-guard stores limits ONLY under normalizeBudgetKey (lowercased, spaces
	// -> "-"), so a project key that carries uppercase/spaces at runtime must be
	// normalized before lookup or the budget is silently unenforced. The limit here
	// is stored under `project:myapp`, while the runtime state carries the raw
	// `MyApp`; enforcement proves the lookup normalizes to match the stored key.
	it("enforces a project budget stored under a normalized key when the runtime projectKey is un-normalized", async () => {
		const policyState = state();
		policyState.project.projectKey = "MyApp";
		policyState.budgets.limits["project:myapp"] = {
			key: "project:myapp",
			window: "day",
			maxRequests: 1,
			updatedAt: 1,
		};
		await appendUsageLedgerRow({
			createdAt: Date.UTC(2026, 3, 29, 1),
			source: "runtime-proxy",
			operation: "responses",
			outcome: "success",
			model: "gpt-5.3-codex",
		});

		const decision = await evaluateRuntimePolicy({
			state: policyState,
			accounts: [],
			model: "gpt-5.3-codex",
			now: Date.UTC(2026, 3, 29, 2),
		});

		expect(decision.allowed).toBe(false);
		expect(decision.statusCode).toBe(429);
		expect(decision.errorCode).toBe("budget_blocked");
		expect(
			decision.budgetEvaluations.some(
				(evaluation) => evaluation.key === "project:myapp" && !evaluation.allowed,
			),
		).toBe(true);
	});

	// Same normalization gap on the routing profile's budgetKey: stored as
	// `team-alpha`, carried at runtime as `Team Alpha`.
	it("enforces a profile budget stored under a normalized key when the runtime budgetKey is un-normalized", async () => {
		const policyState = state();
		policyState.project.profile = {
			projectKey: "project-a",
			projectName: "Project A",
			identityRoot: "/repo",
			preferredTags: [],
			avoidTags: [],
			modelAllowlist: [],
			modelDenylist: [],
			accountWeightByKey: {},
			budgetKey: "Team Alpha",
			updatedAt: 1,
		};
		policyState.budgets.limits["team-alpha"] = {
			key: "team-alpha",
			window: "day",
			maxRequests: 1,
			updatedAt: 1,
		};
		await appendUsageLedgerRow({
			createdAt: Date.UTC(2026, 3, 29, 1),
			source: "runtime-proxy",
			operation: "responses",
			outcome: "success",
			model: "gpt-5.3-codex",
		});

		const decision = await evaluateRuntimePolicy({
			state: policyState,
			accounts: [],
			model: "gpt-5.3-codex",
			now: Date.UTC(2026, 3, 29, 2),
		});

		expect(decision.allowed).toBe(false);
		expect(decision.errorCode).toBe("budget_blocked");
		expect(
			decision.budgetEvaluations.some(
				(evaluation) => evaluation.key === "team-alpha" && !evaluation.allowed,
			),
		).toBe(true);
	});

	it("records usage at most once", async () => {
		const append = vi.fn<typeof appendUsageLedgerRow>().mockResolvedValue({
			version: 1,
			id: "row-1",
			createdAt: 100,
			source: "plugin-host",
			operation: "responses",
			outcome: "success",
			model: "gpt-5.3-codex",
			projectKey: "project-a",
			account: null,
			requestId: "req-1",
			statusCode: 200,
			errorCode: null,
			durationMs: 0,
			tokens: {
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 0,
			},
			costUsd: 0,
		});
		const recorder = createRuntimeUsageRecorder({
			source: "plugin-host",
			operation: "responses",
			model: "gpt-5.3-codex",
			projectKey: "project-a",
			requestId: "req-1",
			startedAt: 100,
			append,
		});

		await recorder.record({
			outcome: "success",
			statusCode: 200,
			account: { index: 0, accountId: "acct_1", email: "owner@example.com" },
		});
		await recorder.record({ outcome: "failure", statusCode: 500 });

		expect(append).toHaveBeenCalledTimes(1);
		expect(append.mock.calls[0]?.[0]).toMatchObject({
			source: "plugin-host",
			operation: "responses",
			outcome: "success",
			model: "gpt-5.3-codex",
			projectKey: "project-a",
			requestId: "req-1",
			statusCode: 200,
			accountId: "acct_1",
			email: "owner@example.com",
			accountIndex: 0,
		});
		expect(recorder.hasRecorded()).toBe(true);
	});

	it("records thread goal usage as a distinct operation", async () => {
		const append = vi.fn<typeof appendUsageLedgerRow>().mockResolvedValue({
			version: 1,
			id: "row-1",
			createdAt: 100,
			source: "runtime-proxy",
			operation: "thread-goal",
			outcome: "failure",
			model: null,
			projectKey: "project-a",
			account: null,
			requestId: "thread-1",
			statusCode: 403,
			errorCode: "thread_goal_upstream_blocked",
			durationMs: 0,
			tokens: {
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 0,
			},
			costUsd: 0,
		});
		const recorder = createRuntimeUsageRecorder({
			source: "runtime-proxy",
			operation: "thread-goal",
			model: null,
			projectKey: "project-a",
			requestId: "thread-1",
			startedAt: 100,
			append,
		});

		await recorder.record({
			outcome: "failure",
			statusCode: 403,
			errorCode: "thread_goal_upstream_blocked",
		});

		expect(append.mock.calls[0]?.[0]).toMatchObject({
			source: "runtime-proxy",
			operation: "thread-goal",
			outcome: "failure",
			requestId: "thread-1",
			statusCode: 403,
			errorCode: "thread_goal_upstream_blocked",
		});
	});

	// quota-forecast-03: a budget window can span a usage-ledger rotation. runtime
	// policy passes includeArchives:true to summarizeUsageLedger so rotated-out spend
	// is still counted. This integration test writes a row, rotates the ledger, writes
	// a second row, then sets a day-window budget (maxRequests:2) whose window covers
	// both rows. The before-rotate row now lives only in the archives; if archives were
	// dropped the current ledger holds just 1 request (< 2 → allowed), so the fact that
	// evaluateRuntimePolicy BLOCKS proves the archived row is included in the count.
	it("counts archived spend when the budget window spans a ledger rotation", async () => {
		const policyState = state();
		policyState.budgets.limits.global = {
			key: "global",
			window: "day",
			maxRequests: 2,
			updatedAt: 1,
		};

		// First request lands before the rotation.
		await appendUsageLedgerRow({
			id: "before-rotate",
			createdAt: Date.UTC(2026, 3, 29, 1),
			source: "runtime-proxy",
			operation: "responses",
			outcome: "success",
			model: "gpt-5.3-codex",
		});

		// Rotate: the before-rotate row moves into an archive file and the current
		// ledger is reset.
		const rotated = await rotateUsageLedger({
			now: Date.UTC(2026, 3, 29, 2),
		});
		expect(rotated).not.toBeNull();

		// Second request lands after the rotation, in the now-current ledger.
		await appendUsageLedgerRow({
			id: "after-rotate",
			createdAt: Date.UTC(2026, 3, 29, 3),
			source: "runtime-proxy",
			operation: "responses",
			outcome: "success",
			model: "gpt-5.3-codex",
		});

		// Window = the UTC day (start 2026-03-29T00:00:00Z), so it spans both rows and
		// crosses the rotation boundary at hour 2.
		const decision = await evaluateRuntimePolicy({
			state: policyState,
			accounts: [],
			model: "gpt-5.3-codex",
			now: Date.UTC(2026, 3, 29, 4),
		});

		// 2 requests in-window (1 archived + 1 current) >= maxRequests:2 → blocked.
		// This only holds because the archived row is counted.
		expect(decision.allowed).toBe(false);
		expect(decision.statusCode).toBe(429);
		expect(decision.errorCode).toBe("budget_blocked");
		const globalEval = decision.budgetEvaluations.find(
			(evaluation) => evaluation.key === "global",
		);
		expect(globalEval?.usage.requests).toBe(2);
	});
});
