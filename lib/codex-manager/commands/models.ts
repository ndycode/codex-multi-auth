import { CapabilityPolicyStore } from "../../capability-policy.js";
import { buildModelCapabilityMatrix } from "../../model-capability-matrix.js";
import { loadQuotaCache } from "../../quota-cache.js";
import type { AccountStorageV3 } from "../../storage.js";

export interface ModelsCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadQuotaCache?: typeof loadQuotaCache;
	capabilityPolicy?: CapabilityPolicyStore;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

function printModelsUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex-multi-auth models [--json] [--model <model>]",
			"",
			"Shows local model/account capability availability from model profiles, quota cache, and capability policy state.",
		].join("\n"),
	);
}

export async function runModelsCommand(
	args: string[],
	deps: ModelsCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		printModelsUsage(logInfo);
		return 0;
	}
	const models: string[] = [];
	let json = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--json" || arg === "-j") {
			json = true;
			continue;
		}
		if (arg === "--model") {
			const value = args[i + 1]?.trim();
			if (!value || value.startsWith("-")) {
				logError("Missing value for --model");
				return 1;
			}
			models.push(value);
			i += 1;
			continue;
		}
		if (arg?.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value || value.startsWith("-")) {
				logError("Missing value for --model");
				return 1;
			}
			models.push(value);
			continue;
		}
		logError(`Unknown models option: ${arg ?? "(missing)"}`);
		return 1;
	}

	deps.setStoragePath(null);
	const [storage, quotaCache] = await Promise.all([
		deps.loadAccounts(),
		(deps.loadQuotaCache ?? loadQuotaCache)().catch(() => null),
	]);
	const matrix = buildModelCapabilityMatrix({
		storage,
		models,
		quotaCache,
		capabilityPolicy: deps.capabilityPolicy ?? new CapabilityPolicyStore(),
		now: deps.getNow?.() ?? Date.now(),
	});
	if (json) {
		logInfo(JSON.stringify({ command: "models", matrix }, null, 2));
		return 0;
	}
	if (matrix.entries.length === 0) {
		logInfo("No accounts configured.");
		return 0;
	}
	for (const entry of matrix.entries) {
		logInfo(
			`${entry.accountLabel} ${entry.normalizedModel}: ${
				entry.available ? "available" : `unavailable (${entry.reasons.join("; ")})`
			}`,
		);
	}
	return 0;
}

