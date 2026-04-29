import { loadAccountPolicyStore } from "../../account-policy.js";
import { loadBudgetGuardStore } from "../../budget-guard.js";
import { buildModelCapabilityMatrix } from "../../model-capability-matrix.js";
import { loadQuotaCache } from "../../quota-cache.js";
import { resolveProjectRoutingProfile } from "../../routing-profiles.js";
import { loadPersistedRuntimeObservabilitySnapshot } from "../../runtime/runtime-observability.js";
import type { AccountStorageV3 } from "../../storage.js";
import { summarizeUsageLedger } from "../../usage/index.js";

export interface MonitorCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadRuntimeObservabilitySnapshot?: typeof loadPersistedRuntimeObservabilitySnapshot;
	loadQuotaCache?: typeof loadQuotaCache;
	loadAccountPolicyStore?: typeof loadAccountPolicyStore;
	loadBudgetGuardStore?: typeof loadBudgetGuardStore;
	resolveProjectRoutingProfile?: typeof resolveProjectRoutingProfile;
	summarizeUsageLedger?: typeof summarizeUsageLedger;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

function printMonitorUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth monitor [--json]",
			"",
			"Aggregates local runtime, usage, policy, profile, model, quota, and project context.",
		].join("\n"),
	);
}

export async function runMonitorCommand(
	args: string[],
	deps: MonitorCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		printMonitorUsage(logInfo);
		return 0;
	}
	let json = false;
	for (const arg of args) {
		if (arg === "--json" || arg === "-j") {
			json = true;
			continue;
		}
		logError(`Unknown monitor option: ${arg}`);
		return 1;
	}

	deps.setStoragePath(null);
	const [
		storage,
		runtime,
		quotaCache,
		accountPolicies,
		budgetGuards,
		project,
		usage,
	] = await Promise.all([
		deps.loadAccounts(),
		(deps.loadRuntimeObservabilitySnapshot ??
			loadPersistedRuntimeObservabilitySnapshot)(),
		(deps.loadQuotaCache ?? loadQuotaCache)(),
		(deps.loadAccountPolicyStore ?? loadAccountPolicyStore)(),
		(deps.loadBudgetGuardStore ?? loadBudgetGuardStore)(),
		(deps.resolveProjectRoutingProfile ?? resolveProjectRoutingProfile)(),
		(deps.summarizeUsageLedger ?? summarizeUsageLedger)({ by: "outcome" }),
	]);
	const matrix = buildModelCapabilityMatrix({
		storage,
		quotaCache,
		now: deps.getNow?.() ?? Date.now(),
	});
	const payload = {
		command: "monitor",
		project: {
			projectKey: project.projectKey,
			projectRoot: project.projectRoot,
			hasProfile: project.profile !== null,
			budgetKey: project.profile?.budgetKey ?? null,
		},
		accounts: {
			count: storage?.accounts.length ?? 0,
			policyCount: Object.keys(accountPolicies.accounts).length,
		},
		runtime,
		usage,
		budgetGuardCount: Object.keys(budgetGuards.limits).length,
		routingProfile: project.profile,
		modelMatrix: {
			models: matrix.models,
			entries: matrix.entries.length,
			available: matrix.entries.filter((entry) => entry.available).length,
			unavailable: matrix.entries.filter((entry) => !entry.available).length,
		},
		quotaCache: {
			byAccountId: Object.keys(quotaCache.byAccountId).length,
			byEmail: Object.keys(quotaCache.byEmail).length,
		},
	};

	if (json) {
		logInfo(JSON.stringify(payload, null, 2));
		return 0;
	}

	logInfo("Local governance monitor");
	logInfo(`Project: ${payload.project.projectKey ?? "none"}`);
	logInfo(`Accounts: ${payload.accounts.count} (${payload.accounts.policyCount} policies)`);
	logInfo(
		`Usage: ${usage.totals.requests} requests, ${usage.totals.totalTokens} tokens, $${usage.totals.costUsd.toFixed(6)}`,
	);
	logInfo(`Budgets: ${payload.budgetGuardCount}`);
	logInfo(
		`Models: ${payload.modelMatrix.available}/${payload.modelMatrix.entries} available`,
	);
	logInfo(
		`Quota cache: ${payload.quotaCache.byAccountId} account ids, ${payload.quotaCache.byEmail} emails`,
	);
	if (runtime) {
		logInfo(
			`Runtime: responses=${runtime.responsesRequests}, refresh=${runtime.authRefreshRequests}, failures=${runtime.runtimeMetrics.failedRequests}`,
		);
	} else {
		logInfo("Runtime: no persisted snapshot");
	}
	return 0;
}
