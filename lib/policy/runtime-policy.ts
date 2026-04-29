import type { CapabilityPolicyStore } from "../capability-policy.js";
import {
	getAccountPolicyKey,
	loadAccountPolicyStore,
	type AccountPolicyStore,
} from "../account-policy.js";
import {
	evaluateBudgetGuard,
	getBudgetWindowStart,
	loadBudgetGuardStore,
	type BudgetGuardEvaluation,
	type BudgetGuardStore,
} from "../budget-guard.js";
import {
	resolveProjectRoutingProfile,
	type ProjectRoutingProfileContext,
} from "../routing-profiles.js";
import {
	appendUsageLedgerRow,
	summarizeUsageLedger,
	type UsageLedgerAppendInput,
	type UsageLedgerOperation,
	type UsageLedgerOutcome,
	type UsageLedgerSource,
} from "../usage/index.js";

export interface RuntimePolicyAccount {
	index: number;
	accountId?: string | null;
	email?: string | null;
}

export interface RuntimePolicyDecision {
	allowed: boolean;
	statusCode: number;
	errorCode: string | null;
	reasons: string[];
	projectKey: string | null;
	blockedAccountIndexes: Set<number>;
	scoreBoostByAccount: Record<number, number>;
	budgetEvaluations: BudgetGuardEvaluation[];
}

export interface RuntimePolicyState {
	accountPolicies: AccountPolicyStore;
	budgets: BudgetGuardStore;
	project: ProjectRoutingProfileContext;
}

export interface RuntimeUsageRecorder {
	record: (input: RuntimeUsageRecordInput) => Promise<void>;
	hasRecorded: () => boolean;
}

export interface RuntimeUsageRecordInput {
	outcome: UsageLedgerOutcome;
	statusCode?: number | null;
	errorCode?: string | null;
	durationMs?: number | null;
	account?: RuntimePolicyAccount | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	cachedInputTokens?: number | null;
	reasoningTokens?: number | null;
	totalTokens?: number | null;
}

export async function loadRuntimePolicyState(
	startDir = process.cwd(),
): Promise<RuntimePolicyState> {
	const [accountPolicies, budgets, project] = await Promise.all([
		loadAccountPolicyStore(),
		loadBudgetGuardStore(),
		resolveProjectRoutingProfile(startDir),
	]);
	return { accountPolicies, budgets, project };
}

function normalizeToken(value: string | null | undefined): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function matchesModel(patterns: string[], model: string | null): boolean {
	const normalizedModel = normalizeToken(model);
	if (!normalizedModel) return false;
	return patterns.some((pattern) => {
		const normalizedPattern = normalizeToken(pattern);
		if (!normalizedPattern) return false;
		return (
			normalizedModel === normalizedPattern ||
			normalizedModel.includes(normalizedPattern)
		);
	});
}

function intersects(left: string[], right: string[]): boolean {
	const rightSet = new Set(right);
	return left.some((entry) => rightSet.has(entry));
}

async function evaluateBudgets(input: {
	state: RuntimePolicyState;
	now: number;
}): Promise<BudgetGuardEvaluation[]> {
	const keys = new Set<string>();
	keys.add("global");
	if (input.state.project.projectKey) {
		keys.add(`project:${input.state.project.projectKey}`);
	}
	if (input.state.project.profile?.budgetKey) {
		keys.add(input.state.project.profile.budgetKey);
	}
	const evaluations: BudgetGuardEvaluation[] = [];
	for (const key of keys) {
		const limit = input.state.budgets.limits[key];
		if (!limit) continue;
		const summary = await summarizeUsageLedger({
			since: getBudgetWindowStart(limit.window, input.now),
			until: input.now,
		});
		evaluations.push(evaluateBudgetGuard(limit, summary));
	}
	return evaluations;
}

export async function evaluateRuntimePolicy(input: {
	state: RuntimePolicyState;
	accounts: RuntimePolicyAccount[];
	model: string | null;
	capabilityPolicy?: CapabilityPolicyStore | null;
	now?: number;
}): Promise<RuntimePolicyDecision> {
	const now = input.now ?? Date.now();
	const reasons: string[] = [];
	const blockedAccountIndexes = new Set<number>();
	const scoreBoostByAccount: Record<number, number> = {};
	const profile = input.state.project.profile;

	if (profile?.modelDenylist.length && matchesModel(profile.modelDenylist, input.model)) {
		reasons.push("routing profile denies requested model");
	}
	if (
		profile?.modelAllowlist.length &&
		!matchesModel(profile.modelAllowlist, input.model)
	) {
		reasons.push("routing profile does not allow requested model");
	}

	const budgetEvaluations = await evaluateBudgets({ state: input.state, now });
	for (const evaluation of budgetEvaluations) {
		if (!evaluation.allowed) {
			reasons.push(
				`budget ${evaluation.key} blocked request: ${evaluation.reasons.join("; ")}`,
			);
		}
	}

	for (const account of input.accounts) {
		const accountKey = getAccountPolicyKey(
			{
				accountId: account.accountId ?? undefined,
				email: account.email ?? undefined,
			},
			account.index,
		);
		const accountPolicy = input.state.accountPolicies.accounts[accountKey];
		let boost = 0;
		if (accountPolicy?.paused) {
			blockedAccountIndexes.add(account.index);
		}
		if (accountPolicy?.drained) {
			blockedAccountIndexes.add(account.index);
		}
		if (accountPolicy) {
			boost += (accountPolicy.weight - 1) * 2;
		}
		if (
			accountPolicy &&
			profile?.preferredTags.length &&
			intersects(accountPolicy.tags, profile.preferredTags)
		) {
			boost += 8;
		}
		if (
			accountPolicy &&
			profile?.avoidTags.length &&
			intersects(accountPolicy.tags, profile.avoidTags)
		) {
			boost -= 8;
		}
		if (profile?.accountWeightByKey[accountKey] !== undefined) {
			boost += (profile.accountWeightByKey[accountKey] ?? 0) * 2;
		}
		const capabilitySnapshot = input.capabilityPolicy?.getSnapshot(
			accountKey,
			input.model ?? "unknown",
		);
		if (capabilitySnapshot && capabilitySnapshot.unsupported > 0) {
			blockedAccountIndexes.add(account.index);
		}
		scoreBoostByAccount[account.index] = boost;
	}

	const blockedByBudget = budgetEvaluations.some((evaluation) => !evaluation.allowed);
	const allowed = reasons.length === 0 && !blockedByBudget;
	return {
		allowed,
		statusCode: blockedByBudget ? 429 : 403,
		errorCode: allowed ? null : blockedByBudget ? "budget_blocked" : "policy_blocked",
		reasons,
		projectKey: input.state.project.projectKey,
		blockedAccountIndexes,
		scoreBoostByAccount,
		budgetEvaluations,
	};
}

export function createRuntimeUsageRecorder(input: {
	source: UsageLedgerSource;
	operation: UsageLedgerOperation;
	model: string | null;
	projectKey: string | null;
	requestId?: string | null;
	startedAt?: number;
	append?: typeof appendUsageLedgerRow;
}): RuntimeUsageRecorder {
	let recorded = false;
	const startedAt = input.startedAt ?? Date.now();
	const append = input.append ?? appendUsageLedgerRow;
	return {
		hasRecorded: () => recorded,
		record: async (recordInput) => {
			if (recorded) return;
			recorded = true;
			const account = recordInput.account;
			const row: UsageLedgerAppendInput = {
				source: input.source,
				operation: input.operation,
				outcome: recordInput.outcome,
				model: input.model,
				projectKey: input.projectKey,
				requestId: input.requestId,
				statusCode: recordInput.statusCode,
				errorCode: recordInput.errorCode,
				durationMs: recordInput.durationMs ?? Date.now() - startedAt,
				accountId: account?.accountId,
				email: account?.email,
				accountIndex: account?.index,
				inputTokens: recordInput.inputTokens,
				outputTokens: recordInput.outputTokens,
				cachedInputTokens: recordInput.cachedInputTokens,
				reasoningTokens: recordInput.reasoningTokens,
				totalTokens: recordInput.totalTokens,
			};
			await append(row).catch(() => undefined);
		},
	};
}
