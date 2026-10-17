import {
	getAccountPolicyKey,
	loadAccountPolicyStore,
	normalizeAccountPolicyTag,
	updateAccountPolicyStore,
	upsertAccountPolicy,
	type AccountPolicyStore,
} from "../../account-policy.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../../storage.js";

export interface AccountCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadPolicyStore?: typeof loadAccountPolicyStore;
	/**
	 * Mutation seam: each mutation re-applies under the cross-process lock
	 * against the freshest store, so concurrent commands editing different
	 * fields of the same policy both land. Defaults to the real
	 * updateAccountPolicyStore.
	 */
	updatePolicyStore?: typeof updateAccountPolicyStore;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

function printAccountUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex-multi-auth account tag <index> <tag>",
			"  codex-multi-auth account untag <index> <tag>",
			"  codex-multi-auth account weight <index> <0..10>",
			"  codex-multi-auth account priority <index> <0..9>",
			"  codex-multi-auth account auto-prime <index> on|off",
			"  codex-multi-auth account emergency-only <index> on|off",
			"  codex-multi-auth account pause|unpause|drain|undrain <index>",
			"  codex-multi-auth account note <index> <text>",
			"  codex-multi-auth account policy list [--json]",
		].join("\n"),
	);
}

function parseAccountIndex(value: string | undefined): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed - 1 : null;
}

function resolveAccount(
	storage: AccountStorageV3 | null,
	index: number | null,
): { account: AccountMetadataV3; index: number } | null {
	if (!storage || index === null || index < 0 || index >= storage.accounts.length) {
		return null;
	}
	const account = storage.accounts[index];
	return account ? { account, index } : null;
}

function policySummary(store: AccountPolicyStore, storage: AccountStorageV3 | null) {
	return (storage?.accounts ?? []).map((account, index) => {
		const accountKey = getAccountPolicyKey(account, index);
		const policy = store.accounts[accountKey];
		return {
			index: index + 1,
			label: `Account ${index + 1}`,
			accountKey,
			tags: policy?.tags ?? [],
			weight: policy?.weight ?? 1,
			priority: policy?.priority ?? 1,
			autoPrime: policy?.autoPrime ?? false,
			emergencyOnly: policy?.emergencyOnly ?? false,
			paused: policy?.paused ?? false,
			drained: policy?.drained ?? false,
			note: policy?.note ?? null,
		};
	});
}

export async function runAccountCommand(
	args: string[],
	deps: AccountCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const [command, ...rest] = args;
	if (!command || command === "--help" || command === "-h") {
		printAccountUsage(logInfo);
		return 0;
	}

	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	const loadStore = deps.loadPolicyStore ?? loadAccountPolicyStore;
	const updateStore = deps.updatePolicyStore ?? updateAccountPolicyStore;

	if (command === "policy") {
		const store = await loadStore();
		const [subcommand, ...policyArgs] = rest;
		if (subcommand !== "list") {
			logError(`Unknown account policy command: ${subcommand ?? "(missing)"}`);
			return 1;
		}
		const unknown = policyArgs.find((arg) => arg !== "--json" && arg !== "-j");
		if (unknown) {
			logError(`Unknown account policy list option: ${unknown}`);
			return 1;
		}
		const payload = {
			command: "account policy list",
			accounts: policySummary(store, storage),
		};
		if (policyArgs.includes("--json") || policyArgs.includes("-j")) {
			logInfo(JSON.stringify(payload, null, 2));
			return 0;
		}
		if (payload.accounts.length === 0) {
			logInfo("No accounts configured.");
			return 0;
		}
		for (const entry of payload.accounts) {
			const markers = [
				`weight=${entry.weight}`,
				`priority=${entry.priority}`,
				`auto-prime=${entry.autoPrime ? "on" : "off"}`,
				entry.emergencyOnly ? "emergency-only" : null,
				entry.paused ? "paused" : null,
				entry.drained ? "drained" : null,
				entry.tags.length > 0 ? `tags=${entry.tags.join(",")}` : null,
				entry.note ? "note" : null,
			].filter((value): value is string => value !== null);
			logInfo(`${entry.index}. ${entry.label} | ${markers.join(" | ")}`);
		}
		return 0;
	}

	const accountIndex = parseAccountIndex(rest[0]);
	const resolved = resolveAccount(storage, accountIndex);
	if (!resolved) {
		logError("Account index is required and must reference a configured account.");
		return 1;
	}
	const accountKey = getAccountPolicyKey(resolved.account, resolved.index);
	const now = deps.getNow?.() ?? Date.now();

	if (command === "tag" || command === "untag") {
		const tag = normalizeAccountPolicyTag(rest[1] ?? "");
		if (!tag) {
			logError(`${command} requires a tag value.`);
			return 1;
		}
		const policy = await updateStore((store) => ({
			result: upsertAccountPolicy(
				store,
				accountKey,
				(next) => {
					if (command === "tag" && !next.tags.includes(tag)) next.tags.push(tag);
					if (command === "untag") {
						next.tags = next.tags.filter((existing) => existing !== tag);
					}
				},
				now,
			),
			dirty: true,
		}));
		logInfo(
			`${command === "tag" ? "Tagged" : "Removed tag from"} account ${resolved.index + 1}: ${policy.tags.join(",") || "none"}`,
		);
		return 0;
	}

	if (command === "emergency-only") {
        if (rest.length !== 2 || !["on", "off"].includes(rest[1] ?? "")) {
            logError("emergency-only requires on or off."); return 1;
        }
        await updateStore(store => ({
            result: upsertAccountPolicy(store, accountKey, next => { next.emergencyOnly = rest[1] === "on"; }, now),
            dirty: true,
        }));
        logInfo(`Emergency-only ${rest[1]} for account ${resolved.index + 1}.`);
        return 0;
    }
	if (command === "auto-prime") {
        if (rest.length !== 2 || !["on", "off"].includes(rest[1] ?? "")) {
            logError("auto-prime requires on or off."); return 1;
        }
        await updateStore((store) => ({
            result: upsertAccountPolicy(store, accountKey, next => { next.autoPrime = rest[1] === "on"; }, now),
            dirty: true,
        }));
        logInfo(`Automatic priming ${rest[1]} for account ${resolved.index+1}. ${rest[1] === "on" ? "The running router checks every 15 minutes; first-use completion consumes subscription quota." : "Future automatic checks are disabled."}`);
        return 0;
    }
	if (command === "priority") {
		if (!/^[0-9]$/.test(rest[1] ?? "") || rest.length !== 2) {
			logError("priority requires an integer from 0 to 9 (0 first).");
			return 1;
		}
		const priority = Number(rest[1]);
		await updateStore((store) => ({
			result: upsertAccountPolicy(store, accountKey, next => { next.priority = priority; }, now),
			dirty: true,
		}));
		logInfo(`Set account ${resolved.index + 1} priority to ${priority}.`);
		return 0;
	}

	if (command === "weight") {
		const weight = rest[1] === undefined ? Number.NaN : Number.parseFloat(rest[1]);
		if (!Number.isFinite(weight) || weight < 0 || weight > 10) {
			logError("weight requires a number from 0 to 10.");
			return 1;
		}
		await updateStore((store) => ({
			result: upsertAccountPolicy(store, accountKey, (next) => {
				next.weight = weight;
			}, now),
			dirty: true,
		}));
		logInfo(`Set account ${resolved.index + 1} weight to ${weight}.`);
		return 0;
	}

	if (["pause", "unpause", "drain", "undrain"].includes(command)) {
		await updateStore((store) => ({
			result: upsertAccountPolicy(store, accountKey, (next) => {
				if (command === "pause") next.paused = true;
				if (command === "unpause") next.paused = false;
				if (command === "drain") next.drained = true;
				if (command === "undrain") next.drained = false;
			}, now),
			dirty: true,
		}));
		logInfo(`Updated account ${resolved.index + 1}: ${command}.`);
		return 0;
	}

	if (command === "note") {
		const note = rest.slice(1).join(" ").trim();
		await updateStore((store) => ({
			result: upsertAccountPolicy(store, accountKey, (next) => {
				next.note = note.length > 0 ? note.slice(0, 500) : null;
			}, now),
			dirty: true,
		}));
		logInfo(`Updated account ${resolved.index + 1} note.`);
		return 0;
	}

	logError(`Unknown account command: ${command}`);
	printAccountUsage(logInfo);
	return 1;
}
