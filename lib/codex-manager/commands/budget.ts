import {
	evaluateBudgetGuard,
	getBudgetWindowStart,
	loadBudgetGuardStore,
	normalizeBudgetKey,
	saveBudgetGuardStore,
	upsertBudgetLimit,
	type BudgetWindow,
} from "../../budget-guard.js";
import { summarizeUsageLedger } from "../../usage/index.js";

export interface BudgetCommandDeps {
	loadStore?: typeof loadBudgetGuardStore;
	saveStore?: typeof saveBudgetGuardStore;
	summarizeUsage?: typeof summarizeUsageLedger;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

const VALID_WINDOWS = new Set<BudgetWindow>(["hour", "day", "week", "month"]);

function printBudgetUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth budget limit <key> --window <hour|day|week|month> [--requests N] [--tokens N] [--cost USD]",
			"  codex auth budget check <key> [--json]",
			"  codex auth budget list [--json]",
		].join("\n"),
	);
}

function parsePositiveNumber(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function runBudgetCommand(
	args: string[],
	deps: BudgetCommandDeps = {},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const [command, ...rest] = args;
	if (!command || command === "--help" || command === "-h") {
		printBudgetUsage(logInfo);
		return 0;
	}
	const loadStore = deps.loadStore ?? loadBudgetGuardStore;
	const saveStore = deps.saveStore ?? saveBudgetGuardStore;
	const store = await loadStore();
	const now = deps.getNow?.() ?? Date.now();

	if (command === "list") {
		const json = rest.includes("--json") || rest.includes("-j");
		const limits = Object.values(store.limits).sort((a, b) =>
			a.key.localeCompare(b.key),
		);
		if (json) {
			logInfo(JSON.stringify({ command: "budget list", limits }, null, 2));
			return 0;
		}
		if (limits.length === 0) {
			logInfo("No budget limits configured.");
			return 0;
		}
		for (const limit of limits) {
			logInfo(
				`${limit.key}: window=${limit.window}, requests=${limit.maxRequests ?? "none"}, tokens=${limit.maxTokens ?? "none"}, cost=${limit.maxCostUsd ?? "none"}`,
			);
		}
		return 0;
	}

	const key = normalizeBudgetKey(rest[0] ?? "");
	if (!key) {
		logError("Budget key is required.");
		return 1;
	}

	if (command === "limit") {
		let window: BudgetWindow | null = null;
		let maxRequests: number | undefined;
		let maxTokens: number | undefined;
		let maxCostUsd: number | undefined;
		for (let i = 1; i < rest.length; i += 1) {
			const arg = rest[i];
			const value = rest[i + 1];
			if (arg === "--window") {
				if (!value || !VALID_WINDOWS.has(value as BudgetWindow)) {
					logError("--window must be hour, day, week, or month.");
					return 1;
				}
				window = value as BudgetWindow;
				i += 1;
				continue;
			}
			if (arg === "--requests" || arg === "--tokens" || arg === "--cost") {
				const parsed = parsePositiveNumber(value);
				if (parsed === null) {
					logError(`${arg} requires a positive number.`);
					return 1;
				}
				if (arg === "--requests") maxRequests = parsed;
				if (arg === "--tokens") maxTokens = parsed;
				if (arg === "--cost") maxCostUsd = parsed;
				i += 1;
				continue;
			}
			logError(`Unknown budget limit option: ${arg ?? "(missing)"}`);
			return 1;
		}
		if (!window) {
			logError("--window is required.");
			return 1;
		}
		if (!maxRequests && !maxTokens && !maxCostUsd) {
			logError("At least one of --requests, --tokens, or --cost is required.");
			return 1;
		}
		const limit = upsertBudgetLimit(
			store,
			{ key, window, maxRequests, maxTokens, maxCostUsd },
			now,
		);
		await saveStore(store);
		logInfo(`Saved budget limit ${limit.key} (${limit.window}).`);
		return 0;
	}

	if (command === "check") {
		const limit = store.limits[key];
		if (!limit) {
			logError(`Budget limit not found: ${key}`);
			return 1;
		}
		const summary = await (deps.summarizeUsage ?? summarizeUsageLedger)({
			since: getBudgetWindowStart(limit.window, now),
			by: "model",
		});
		const evaluation = evaluateBudgetGuard(limit, summary);
		if (rest.includes("--json") || rest.includes("-j")) {
			logInfo(JSON.stringify({ command: "budget check", evaluation }, null, 2));
			return evaluation.allowed ? 0 : 1;
		}
		logInfo(
			evaluation.allowed
				? `Budget ${key} allows usage.`
				: `Budget ${key} blocked: ${evaluation.reasons.join("; ")}`,
		);
		return evaluation.allowed ? 0 : 1;
	}

	logError(`Unknown budget command: ${command}`);
	printBudgetUsage(logInfo);
	return 1;
}

