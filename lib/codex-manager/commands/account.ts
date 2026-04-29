import {
	getAccountPolicyKey,
	loadAccountPolicyStore,
	normalizeAccountPolicyTag,
	saveAccountPolicyStore,
	upsertAccountPolicy,
	type AccountPolicyStore,
} from "../../account-policy.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../../storage.js";

export interface AccountCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadPolicyStore?: typeof loadAccountPolicyStore;
	savePolicyStore?: typeof saveAccountPolicyStore;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

function printAccountUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth account tag <index> <tag>",
			"  codex auth account untag <index> <tag>",
			"  codex auth account weight <index> <0..10>",
			"  codex auth account pause|unpause|drain|undrain <index>",
			"  codex auth account note <index> <text>",
			"  codex auth account policy list [--json]",
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
	const saveStore = deps.savePolicyStore ?? saveAccountPolicyStore;
	const store = await loadStore();

	if (command === "policy") {
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
		const policy = upsertAccountPolicy(
			store,
			accountKey,
			(next) => {
				if (command === "tag" && !next.tags.includes(tag)) next.tags.push(tag);
				if (command === "untag") {
					next.tags = next.tags.filter((existing) => existing !== tag);
				}
			},
			now,
		);
		await saveStore(store);
		logInfo(
			`${command === "tag" ? "Tagged" : "Removed tag from"} account ${resolved.index + 1}: ${policy.tags.join(",") || "none"}`,
		);
		return 0;
	}

	if (command === "weight") {
		const weight = rest[1] === undefined ? Number.NaN : Number.parseFloat(rest[1]);
		if (!Number.isFinite(weight) || weight < 0 || weight > 10) {
			logError("weight requires a number from 0 to 10.");
			return 1;
		}
		upsertAccountPolicy(store, accountKey, (next) => {
			next.weight = weight;
		}, now);
		await saveStore(store);
		logInfo(`Set account ${resolved.index + 1} weight to ${weight}.`);
		return 0;
	}

	if (["pause", "unpause", "drain", "undrain"].includes(command)) {
		upsertAccountPolicy(store, accountKey, (next) => {
			if (command === "pause") next.paused = true;
			if (command === "unpause") next.paused = false;
			if (command === "drain") next.drained = true;
			if (command === "undrain") next.drained = false;
		}, now);
		await saveStore(store);
		logInfo(`Updated account ${resolved.index + 1}: ${command}.`);
		return 0;
	}

	if (command === "note") {
		const note = rest.slice(1).join(" ").trim();
		upsertAccountPolicy(store, accountKey, (next) => {
			next.note = note.length > 0 ? note.slice(0, 500) : null;
		}, now);
		await saveStore(store);
		logInfo(`Updated account ${resolved.index + 1} note.`);
		return 0;
	}

	logError(`Unknown account command: ${command}`);
	printAccountUsage(logInfo);
	return 1;
}
