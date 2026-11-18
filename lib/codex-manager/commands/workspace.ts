import {
	formatAccountLabel,
	formatWorkspaceLines,
	resolveAccountRecordId,
} from "../../accounts.js";
import type { AccountStorageV3, withAccountStorageTransaction } from "../../storage.js";
import { saveAccountsWithRetry } from "../forecast-report-shared.js";

type LoadedStorage = AccountStorageV3 | null;

export interface WorkspaceCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<LoadedStorage>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	withAccountStorageTransaction: typeof withAccountStorageTransaction;
	logError?: (message: string) => void;
	logInfo?: (message: string) => void;
}

/**
 * `codex-multi-auth workspace <account> [workspace]`
 *
 * With only an account index, lists the workspaces that account can select
 * between (personal Plus vs business/team under one email, issue #491). With a
 * workspace index too, sets it as the active workspace for that account.
 * A final enable/disable action changes availability without changing selection.
 */
export async function runWorkspaceCommand(
	args: string[],
	deps: WorkspaceCommandDeps,
): Promise<number> {
	deps.setStoragePath(null);
	const logError = deps.logError ?? console.error;
	const logInfo = deps.logInfo ?? console.log;

	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		logError("No accounts configured.");
		return 1;
	}

	const accountArg = args[0];
	if (!accountArg) {
		logError(
			"Missing account index. Usage: codex-multi-auth workspace <account> [workspace]",
		);
		return 1;
	}

	// Require a plain positive integer (matches `switch`): Number.parseInt would
	// silently truncate "1.9" -> 1 or "2abc" -> 2 and operate on the wrong
	// account, so reject anything that isn't all digits.
	if (!/^\d+$/.test(accountArg.trim())) {
		logError(`Invalid account index (must be a positive integer): ${accountArg}`);
		return 1;
	}
	const parsedAccount = Number.parseInt(accountArg, 10);
	if (!Number.isFinite(parsedAccount) || parsedAccount < 1) {
		logError(`Invalid account index (must be a positive integer): ${accountArg}`);
		return 1;
	}

	const accountIndex = parsedAccount - 1;
	if (accountIndex >= storage.accounts.length) {
		logError(
			`Account index out of range. Valid range: 1-${storage.accounts.length}`,
		);
		return 1;
	}

	const account = storage.accounts[accountIndex];
	if (!account) {
		logError(`Account ${parsedAccount} not found.`);
		return 1;
	}

	const workspaces = account.workspaces ?? [];
	if (workspaces.length === 0) {
		logInfo(
			`Account ${parsedAccount} (${formatAccountLabel(account, accountIndex)}) has no tracked workspaces.`,
		);
		return 0;
	}

	const workspaceArg = args[1];
	if (!workspaceArg) {
		logInfo(`Account ${parsedAccount}: ${formatAccountLabel(account, accountIndex)}`);
		for (const line of formatWorkspaceLines(account, "  ")) {
			logInfo(line);
		}
		logInfo("");
		logInfo(
			`Switch with: codex-multi-auth workspace ${parsedAccount} <workspace-number>`,
		);
		return 0;
	}

	if (!/^\d+$/.test(workspaceArg.trim())) {
		logError(
			`Invalid workspace index (must be a positive integer). Valid range: 1-${workspaces.length}`,
		);
		return 1;
	}
	const parsedWorkspace = Number.parseInt(workspaceArg, 10);
	if (
		!Number.isFinite(parsedWorkspace) ||
		parsedWorkspace < 1 ||
		parsedWorkspace > workspaces.length
	) {
		logError(
			`Invalid workspace index. Valid range: 1-${workspaces.length}`,
		);
		return 1;
	}

	const workspaceIndex = parsedWorkspace - 1;
	const target = workspaces[workspaceIndex];
	if (!target) {
		logError(`Workspace ${parsedWorkspace} not found.`);
		return 1;
	}

	const targetName = target.name?.trim() || "(unnamed)";
 const action=args[2];
 if (args.length > 3 || (action && action !== "enable" && action !== "disable")) {
  logError("Invalid workspace action. Use enable or disable.");
  return 1;
 }
 if (action) {
  const recordId = resolveAccountRecordId(account);
  const workspaceId = target.id;
  return deps.withAccountStorageTransaction(async (current, persist) => {
   // An explicit command is an operation, even if its initial snapshot already
   // had that value. Apply it to the latest row under the storage lock.
   const matches = current?.accounts.filter(row => resolveAccountRecordId(row) === recordId) ?? [];
   const latest = matches.length === 1 ? matches[0] : undefined;
   const latestWorkspaces = latest?.workspaces ?? [];
   const workspaceMatches = latestWorkspaces.filter(row => row.id === workspaceId);
   const workspace = workspaceMatches.length === 1 ? workspaceMatches[0] : undefined;
   if (!current || !latest || !workspace) {
    logError("Account or workspace changed concurrently; reload before changing workspace availability.");
    return 1;
   }
   workspace.enabled = action === "enable";
   // Absence of disabledAt distinguishes an operator exclusion from runtime health.
   delete workspace.disabledAt;
   await saveAccountsWithRetry(current, persist);
   const currentIndex = latestWorkspaces.indexOf(workspace) + 1;
   const currentName = workspace.name?.trim() || "(unnamed)";
   logInfo(`Workspace ${currentIndex} [${currentName}] ${workspace.enabled ? "enabled" : "disabled"}. Selected workspace unchanged.`);
   return 0;
  });
 }

	if (target.enabled === false) {
		logError(
			`Workspace ${parsedWorkspace} ([${targetName}]) is disabled and cannot be selected.`,
		);
		return 1;
	}

	if (account.currentWorkspaceIndex === workspaceIndex) {
		logInfo(
			`Account ${parsedAccount} is already using workspace ${parsedWorkspace}: [${targetName}].`,
		);
		return 0;
	}

	account.currentWorkspaceIndex = workspaceIndex;
	await saveAccountsWithRetry(storage, deps.saveAccounts);

	// Guard a possibly-undefined id the same way formatWorkspaceLines does, in
	// case on-disk data does not conform to the Workspace interface.
	const id = target.id?.trim() ?? "";
	const idSuffix = id.length > 6 ? id.slice(-6) : id;
	logInfo(
		`Account ${parsedAccount} now using workspace ${parsedWorkspace}: [${targetName}]${idSuffix ? ` (id:${idSuffix})` : ""}.`,
	);
	return 0;
}
