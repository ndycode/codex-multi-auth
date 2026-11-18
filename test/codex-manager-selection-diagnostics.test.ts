import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTH_INVALIDATION_MARKER,
	AccountManager,
} from "../lib/accounts.js";
import { buildSelectAccountTraced } from "../lib/codex-manager.js";
import { clearCircuitBreakers } from "../lib/circuit-breaker.js";
import { resetTrackers } from "../lib/rotation.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const { evaluateRuntimePolicyMock, loadRuntimePolicyStateMock } = vi.hoisted(
	() => ({
		evaluateRuntimePolicyMock: vi.fn(),
		loadRuntimePolicyStateMock: vi.fn(),
	}),
);

vi.mock("../lib/policy/runtime-policy.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../lib/policy/runtime-policy.js")
	>();
	return {
		...actual,
		evaluateRuntimePolicy: evaluateRuntimePolicyMock,
		loadRuntimePolicyState: loadRuntimePolicyStateMock,
	};
});

function createStorage(now: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				accountId: "policy-paused",
				email: "paused@example.com",
				refreshToken: "refresh-paused",
				addedAt: now,
				lastUsed: now,
			},
			{
				accountId: "workspace-disabled",
				email: "workspace@example.com",
				refreshToken: "refresh-workspace",
				addedAt: now,
				lastUsed: now,
				workspaces: [
					{ id: "workspace-a", name: "Workspace A", enabled: false },
				],
			},
			{
				accountId: "model-limited",
				email: "model@example.com",
				refreshToken: "refresh-model",
				addedAt: now,
				lastUsed: now,
				rateLimitResetTimes: {
					"codex:gpt-5.6-sol": now + 60_000,
				},
			},
			{
				accountId: "cooling-down",
				email: "cooldown@example.com",
				refreshToken: "refresh-cooldown",
				addedAt: now,
				lastUsed: now,
				coolingDownUntil: now + 60_000,
				cooldownReason: "network-error",
			},
			{
				accountId: "token-invalidated",
				email: "invalid@example.com",
				refreshToken: "refresh-invalid",
				addedAt: now,
				lastUsed: now,
				authInvalidatedAt: now - 1,
				authInvalidationErrorCode: "token_invalidated",
			},
			{
				accountId: "circuit-open",
				email: "circuit@example.com",
				refreshToken: "refresh-circuit",
				addedAt: now,
				lastUsed: now,
			},
			{
				accountId: "healthy",
				email: "healthy@example.com",
				refreshToken: "refresh-healthy",
				addedAt: now,
				lastUsed: now,
			},
		],
	};
}

describe("codex-manager selection diagnostics", () => {
	beforeEach(() => {
		resetTrackers();
		clearCircuitBreakers();
		loadRuntimePolicyStateMock.mockResolvedValue({
			accountPolicies: { version: 1, accounts: {} },
			budgets: { version: 1, limits: {} },
			project: {
				startDir: "/tmp",
				projectRoot: null,
				identityRoot: "/tmp",
				projectKey: null,
				profile: null,
			},
		});
		evaluateRuntimePolicyMock.mockResolvedValue({
			allowed: true,
			statusCode: 200,
			errorCode: null,
			reasons: [],
			projectKey: null,
			blockedAccountIndexes: new Set([0]),
			blockedAccountReasons: { 0: "policy: paused" },
			scoreBoostByAccount: { 6: 25 },
			budgetEvaluations: [],
		});
	});

	it("uses the same runtime gates and policy overlays as production selection", async () => {
		const now = Date.now();
		const storage = createStorage(now);
		const circuitManager = new AccountManager(undefined, storage);
		const circuitAccount = circuitManager.getAccountByIndex(5);
		if (!circuitAccount) throw new Error("circuit fixture account missing");
		circuitManager.recordFailure(circuitAccount, "codex", "gpt-5.6-sol");
		circuitManager.recordFailure(circuitAccount, "codex", "gpt-5.6-sol");
		circuitManager.recordFailure(circuitAccount, "codex", "gpt-5.6-sol");

		const trace = await buildSelectAccountTraced()(storage);
		const candidates = new Map(
			trace.candidates.map((candidate) => [candidate.index, candidate]),
		);

		expect(candidates.get(0)).toMatchObject({
			isAvailable: false,
			reason: "policy: paused",
		});
		expect(candidates.get(1)).toMatchObject({
			isAvailable: false,
			reason: "workspace-disabled",
		});
		expect(candidates.get(2)).toMatchObject({
			isAvailable: false,
			reason: "rate-limited",
		});
		expect(candidates.get(3)).toMatchObject({
			isAvailable: false,
			reason: "cooling-down:network-error",
		});
		expect(candidates.get(4)).toMatchObject({
			isAvailable: false,
			reason: AUTH_INVALIDATION_MARKER,
		});
		expect(candidates.get(5)).toMatchObject({
			isAvailable: false,
			reason: "circuit-open",
		});
		expect(candidates.get(6)).toMatchObject({
			isAvailable: true,
			capabilityBoost: 25,
		});
		expect(trace.availableCount).toBe(1);
		expect(trace.selected?.index).toBe(6);
	});

	it("blocks every candidate when a model policy denies the request globally", async () => {
		evaluateRuntimePolicyMock.mockResolvedValueOnce({
			allowed: false,
			statusCode: 403,
			errorCode: "model_not_allowed",
			reasons: ["model denied"],
			projectKey: null,
			blockedAccountIndexes: new Set(),
			blockedAccountReasons: {},
			scoreBoostByAccount: {},
			budgetEvaluations: [],
		});

		const storage = createStorage(Date.now());
		const trace = await buildSelectAccountTraced()(storage);

		expect(trace.selected).toBeNull();
		expect(trace.availableCount).toBe(0);
		expect(trace.candidates.every((candidate) => candidate.isAvailable === false)).toBe(
			true,
		);
		expect(
			trace.candidates
				.filter((candidate) => candidate.index !== 4)
				.every((candidate) => candidate.reason === "model_not_allowed"),
		).toBe(true);
		expect(trace.candidates.find((candidate) => candidate.index === 4)?.reason).toBe(
			AUTH_INVALIDATION_MARKER,
		);
	});

	it("blocks every candidate when a global budget guard denies the request", async () => {
		evaluateRuntimePolicyMock.mockResolvedValueOnce({
			allowed: false,
			statusCode: 429,
			errorCode: "budget_exceeded",
			reasons: ["global budget exhausted"],
			projectKey: null,
			blockedAccountIndexes: new Set(),
			blockedAccountReasons: {},
			scoreBoostByAccount: {},
			budgetEvaluations: [],
		});

		const storage = createStorage(Date.now());
		const trace = await buildSelectAccountTraced()(storage);

		expect(trace.selected).toBeNull();
		expect(trace.availableCount).toBe(0);
		expect(trace.candidates.every((candidate) => candidate.isAvailable === false)).toBe(
			true,
		);
		expect(
			trace.candidates
				.filter((candidate) => candidate.index !== 4)
				.every((candidate) => candidate.reason === "budget_exceeded"),
		).toBe(true);
		expect(trace.candidates.find((candidate) => candidate.index === 4)?.reason).toBe(
			AUTH_INVALIDATION_MARKER,
		);
	});
});
