import type { CapabilityPolicyStore } from "../capability-policy.js";
import { logDebug } from "../logger.js";
import { resolveEntitlementAccountKey } from "../entitlement-cache.js";
import {
	getAccountPolicyKey,
	type AccountPolicyStore,
} from "../account-policy.js";
import {
	evaluateBudgetGuard,
	getBudgetWindowStart,
	normalizeBudgetKey,
	type BudgetGuardEvaluation,
	type BudgetGuardStore,
	type BudgetLimit,
	type BudgetWindow,
} from "../budget-guard.js";
import type { ProjectRoutingProfileContext } from "../routing-profiles.js";
import {
	loadAccountPolicyStoreCached,
	loadBudgetGuardStoreCached,
	resolveProjectRoutingProfileCached,
} from "./runtime-policy-cache.js";
import {
	appendUsageLedgerRow,
	readUsageLedgerRows,
	summarizeUsageRows,
	type UsageLedgerAppendInput,
	type UsageLedgerOperation,
	type UsageLedgerOutcome,
	type UsageLedgerSource,
	type UsageServiceTier,
	type UsageSummary,
} from "../usage/index.js";

export interface RuntimePolicyAccount {
	index: number;
	accountId?: string | null;
	email?: string | null;
	/**
	 * Only used to key account policy for an account with no accountId and no
	 * email. Without it the runtime would key such an account as "unknown"
	 * while the CLI keys it by refresh-token digest, and pause/drain/tag state
	 * written by one would be invisible to the other.
	 */
	refreshToken?: string | null;
}

export interface RuntimePolicyDecision {
	allowed: boolean;
	statusCode: number;
	errorCode: string | null;
	reasons: string[];
	projectKey: string | null;
	blockedAccountIndexes: Set<number>;
	blockedAccountReasons?: Record<number, string>;
	scoreBoostByAccount: Record<number, number>;
	priorityByAccount?: Record<number, number>;
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
	/**
	 * Billed service tier, when upstream reported one. Carried explicitly
	 * because the row below is rebuilt field by field: a spread from the
	 * usage deferral reaches this input, but anything not named here is
	 * dropped before the ledger, which would price a Fast response at the
	 * standard rate.
	 */
	serviceTier?: UsageServiceTier;
}

export async function loadRuntimePolicyState(
	startDir = process.cwd(),
): Promise<RuntimePolicyState> {
	// Cached loaders: each proxied request costs a few statSync calls instead of
	// three file reads + JSON parses + the project-root ancestor walk. Stores
	// re-read whenever their file's mtime/size changes (or within the mtime
	// settle window, or past the cache TTL), and the project context
	// re-resolves when the startDir context or `.git` entry changes — so
	// CLI-side writes are honored without per-request reparsing. See
	// lib/policy/runtime-policy-cache.ts.
	const [accountPolicies, budgets, project] = await Promise.all([
		loadAccountPolicyStoreCached(),
		loadBudgetGuardStoreCached(),
		resolveProjectRoutingProfileCached(startDir),
	]);
	// The caches share store objects across calls. Every caller previously
	// received a private parse, so hand out a private clone: a caller mutating
	// its state must not poison the cache for the next request.
	return structuredClone({ accountPolicies, budgets, project });
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
	// `global` is already normalize-clean. Project/profile keys can carry uppercase
	// or spaces, but budget-guard STORES limits only under normalizeBudgetKey (see
	// upsertBudgetLimit and load-time normalizeStore). Look them up the same way, or
	// a key like `project:MyApp` never matches its stored `project:myapp` and the
	// budget is silently unenforced.
	keys.add("global");
	if (input.state.project.projectKey) {
		const projectKey = normalizeBudgetKey(`project:${input.state.project.projectKey}`);
		if (projectKey) keys.add(projectKey);
	}
	if (input.state.project.profile?.budgetKey) {
		const budgetKey = normalizeBudgetKey(input.state.project.profile.budgetKey);
		if (budgetKey) keys.add(budgetKey);
	}
	const matchingLimits: BudgetLimit[] = [];
	for (const key of keys) {
		const limit = input.state.budgets.limits[key];
		if (limit) matchingLimits.push(limit);
	}
	if (matchingLimits.length === 0) return [];
	// Read + parse the ledger ONCE per evaluation, not once per matching key —
	// each summarizeUsageLedger call used to reparse every usage-ledger*.jsonl
	// line, making the request path O(ledger rows x budget keys). Budget
	// windows (e.g. monthly) can span a ledger rotation, so archives are
	// included; without them rotated-out rows are dropped from the sum,
	// under-counting spend and letting usage exceed the limit within the
	// active window (quota-forecast-03). Distinct windows still need distinct
	// `since` filters, so rows are summarized per window in memory — the same
	// summarizeUsageRows that summarizeUsageLedger applied to the same rows
	// and query produces an identical UsageSummary.
	const rows = await readUsageLedgerRows({ includeArchives: true });
	const summariesByWindow = new Map<BudgetWindow, UsageSummary>();
	const evaluations: BudgetGuardEvaluation[] = [];
	for (const limit of matchingLimits) {
		let summary = summariesByWindow.get(limit.window);
		if (!summary) {
			summary = summarizeUsageRows(rows, {
				since: getBudgetWindowStart(limit.window, input.now),
				until: input.now,
			});
			summariesByWindow.set(limit.window, summary);
		}
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
	const blockedAccountReasons: Record<number, string> = {};
	const scoreBoostByAccount: Record<number, number> = {};
	const priorityByAccount: Record<number, number> = {};
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

	// NOTE (audit L10): Budget enforcement is soft / eventually-consistent under
	// concurrency. Each evaluation reads a pre-request ledger snapshot, while
	// consumption is only recorded at request completion (see
	// createRuntimeUsageRecorder below). N requests racing in the same window can
	// therefore all observe sub-limit usage and pass before any of them records,
	// allowing transient overshoot of e.g. maxRequests. This is intentional: a
	// hard cap would require a cross-process reservation/locking system that is
	// out of scope here. Budgets are a best-effort guard, not a strict quota.
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
				refreshToken: account.refreshToken ?? undefined,
			},
			account.index,
		);
		const accountPolicy = input.state.accountPolicies.accounts[accountKey];
		priorityByAccount[account.index] = accountPolicy?.priority ?? 1;
		let boost = 0;
		if (accountPolicy?.paused) {
			blockedAccountIndexes.add(account.index);
			blockedAccountReasons[account.index] = "policy: paused";
		}
		if (accountPolicy?.drained) {
			blockedAccountIndexes.add(account.index);
			blockedAccountReasons[account.index] = accountPolicy.paused
				? "policy: paused, drained"
				: "policy: drained";
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
		// quota-forecast-01: the capability store is WRITTEN under the entitlement
		// key (resolveEntitlementAccountKey) at the recordUnsupported sites, so the
		// read must use the same key. Previously this used getAccountPolicyKey, a
		// different format, so getSnapshot never matched and suppression was dead.
		const capabilityKey = resolveEntitlementAccountKey({
			accountId: account.accountId ?? undefined,
			email: account.email ?? undefined,
			index: account.index,
		});
		const capabilitySnapshot = input.capabilityPolicy?.getSnapshot(
			capabilityKey,
			input.model ?? "unknown",
		);
		if (capabilitySnapshot && capabilitySnapshot.unsupported > 0) {
			blockedAccountIndexes.add(account.index);
			blockedAccountReasons[account.index] = "policy: unsupported model";
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
		blockedAccountReasons,
		scoreBoostByAccount,
		priorityByAccount,
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
			if (input.operation === "responses" && recordInput.outcome === "success" && ![
				recordInput.inputTokens,
				recordInput.outputTokens,
				recordInput.cachedInputTokens,
				recordInput.reasoningTokens,
				recordInput.totalTokens,
			].some(count => typeof count === "number" && count > 0)) {
				// Keep diagnostics free of account identities, credentials and body data.
				logDebug("Successful Responses request has zero or missing token usage", {
					source: input.source,
					operation: input.operation,
				});
			}
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
				serviceTier: recordInput.serviceTier,
			};
			await append(row).catch(() => undefined);
		},
	};
}
