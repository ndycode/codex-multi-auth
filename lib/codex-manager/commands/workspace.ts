import {
	formatAccountLabel,
	formatWorkspaceLines,
} from "../../accounts.js";
import type { AccountStorageV3 } from "../../storage.js";
import { saveAccountsWithRetry } from "../forecast-report-shared.js";

type LoadedStorage = AccountStorageV3 | null;

export interface WorkspaceCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<LoadedStorage>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	logError?: (message: string) => void;
	logInfo?: (message: string) => void;
}

/**
 * `codex-multi-auth workspace <account> [workspace]`
 *
 * With only an account index, lists the workspaces that account can rotate
 * between (personal Plus vs business/team under one email, issue #491). With a
 * workspace index too, sets it as the active workspace for that account.
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

	const parsedAccount = Number.parseInt(accountArg, 10);
	if (!Number.isFinite(parsedAccount) || parsedAccount < 1) {
		logError(`Invalid account index: ${accountArg}`);
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

	const idSuffix =
		target.id.length > 6 ? target.id.slice(-6) : target.id;
	logInfo(
		`Account ${parsedAccount} now using workspace ${parsedWorkspace}: [${targetName}]${idSuffix ? ` (id:${idSuffix})` : ""}.`,
	);
	return 0;
}
