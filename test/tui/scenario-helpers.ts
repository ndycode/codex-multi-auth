import { applyShellKey, createInitialShellState, type ShellState } from "../../runtime/opentui/shell";
import {
	ADD_ACCOUNT_SECTION_INDEX,
	AUTH_CHOICE_SECTION_INDEX,
} from "../../runtime/opentui/sections";


function moveToDashboardAction(state: ShellState, targetActionIndex: number): ShellState {
	let nextState = state;
	while (nextState.actionIndex !== targetActionIndex) {
		nextState = applyShellKey(nextState, "down");
	}
	return nextState;
}

export function openAddAccountState(state: ShellState = createInitialShellState()): ShellState {
	return applyShellKey(state, "return");
}

export function openAuthChoiceState(state: ShellState = createInitialShellState()): ShellState {
	const addAccountState = openAddAccountState(state);
	if (addAccountState.sectionIndex !== ADD_ACCOUNT_SECTION_INDEX) {
		throw new Error("Add account section did not open as expected.");
	}
	const nextState = applyShellKey(addAccountState, "return");
	if (nextState.sectionIndex !== AUTH_CHOICE_SECTION_INDEX) {
		throw new Error("Auth choice section did not open as expected.");
	}
	return nextState;
}

export function openWorkspaceState(state: ShellState = createInitialShellState()): ShellState {
	return applyShellKey(moveToDashboardAction(state, 1), "return");
}

export function openHealthState(state: ShellState = createInitialShellState()): ShellState {
	let workspaceState = openWorkspaceState(state);
	workspaceState = applyShellKey(workspaceState, "down");
	workspaceState = applyShellKey(workspaceState, "down");
	workspaceState = applyShellKey(workspaceState, "down");
	return applyShellKey(workspaceState, "return");
}

export function openSettingsState(state: ShellState = createInitialShellState()): ShellState {
	return applyShellKey(moveToDashboardAction(state, 3), "return");
}

export function openSettingsContentState(state: ShellState = createInitialShellState()): ShellState {
	return applyShellKey(openSettingsState(state), "return");
}
