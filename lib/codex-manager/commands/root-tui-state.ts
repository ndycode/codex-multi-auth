import type { ExistingAccountInfo } from "../../cli.js";
import type { RootCommandTuiAction } from "./root-tui.js";

export interface RootTuiState {
	mode: "root" | "add";
	rootCursor: number;
	addCursor: number;
	pendingG: boolean;
}

export interface RootTuiKeyEvent {
	input: string;
	key: {
		upArrow?: boolean;
		downArrow?: boolean;
		return?: boolean;
		escape?: boolean;
		ctrl?: boolean;
	};
}

export interface RootTuiTransition {
	state: RootTuiState;
	action?: RootCommandTuiAction;
}

const ADD_ACCOUNT_OPTION_COUNT = 3;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function resolveAccountActionIndex(account: ExistingAccountInfo): number {
	if (typeof account.sourceIndex === "number" && Number.isFinite(account.sourceIndex)) {
		return Math.max(0, Math.trunc(account.sourceIndex));
	}
	return Math.max(0, Math.trunc(account.index));
}

export function resolveQuickSwitchNumber(account: ExistingAccountInfo): number | null {
	const fallback = account.index + 1;
	const value = account.quickSwitchNumber ?? fallback;
	if (!Number.isInteger(value) || value < 1 || value > 9) {
		return null;
	}
	return value;
}

export function createInitialRootTuiState(
	accounts: ExistingAccountInfo[],
): RootTuiState {
	return {
		mode: "root",
		rootCursor: accounts.length > 0 ? 0 : -1,
		addCursor: 0,
		pendingG: false,
	};
}

export function moveRootCursor(
	state: RootTuiState,
	accounts: ExistingAccountInfo[],
	delta: number,
): RootTuiState {
	if (accounts.length === 0) {
		return {
			...state,
			rootCursor: -1,
			pendingG: false,
		};
	}
	const current = state.rootCursor >= 0 ? state.rootCursor : 0;
	return {
		...state,
		rootCursor: clamp(current + delta, 0, accounts.length - 1),
		pendingG: false,
	};
}

export function jumpRootCursor(
	state: RootTuiState,
	accounts: ExistingAccountInfo[],
	target: "first" | "last",
): RootTuiState {
	if (accounts.length === 0) {
		return {
			...state,
			rootCursor: -1,
			pendingG: false,
		};
	}
	return {
		...state,
		rootCursor: target === "first" ? 0 : accounts.length - 1,
		pendingG: false,
	};
}

export function handleRootScreenInput(
	state: RootTuiState,
	event: RootTuiKeyEvent,
	accounts: ExistingAccountInfo[],
): RootTuiTransition {
	if (event.key.ctrl && event.input.toLowerCase() === "c") {
		return { state: { ...state, pendingG: false }, action: { type: "cancel" } };
	}
	if (event.key.upArrow || event.input === "k") {
		return { state: moveRootCursor(state, accounts, -1) };
	}
	if (event.key.downArrow || event.input === "j") {
		return { state: moveRootCursor(state, accounts, 1) };
	}
	if (event.input === "g") {
		if (state.pendingG) {
			return { state: jumpRootCursor(state, accounts, "first") };
		}
		return { state: { ...state, pendingG: true } };
	}
	if (event.input === "G") {
		return { state: jumpRootCursor(state, accounts, "last") };
	}
	if (event.input === "a") {
		return {
			state: {
				...state,
				mode: "add",
				addCursor: 0,
				pendingG: false,
			},
		};
	}
	if (event.input === "r") {
		return { state: { ...state, pendingG: false }, action: { type: "refresh" } };
	}
	if (event.input === "q" || (event.key.escape && !event.input)) {
		return { state: { ...state, pendingG: false }, action: { type: "cancel" } };
	}
	if (/^[1-9]$/.test(event.input)) {
		const quickSwitchNumber = Number.parseInt(event.input, 10);
		const match = accounts.find(
			(account) => resolveQuickSwitchNumber(account) === quickSwitchNumber,
		);
		if (match) {
			return {
				state: { ...state, pendingG: false },
				action: {
					type: "switch",
					accountIndex: resolveAccountActionIndex(match),
				},
			};
		}
	}
	if (
		(event.input === " " || event.input === "Space")
		&& state.rootCursor >= 0
		&& state.rootCursor < accounts.length
	) {
		const account = accounts[state.rootCursor];
		if (account) {
			return {
				state: { ...state, pendingG: false },
				action: {
					type: "switch",
					accountIndex: resolveAccountActionIndex(account),
				},
			};
		}
	}
	if (event.key.return && state.rootCursor >= 0 && state.rootCursor < accounts.length) {
		const account = accounts[state.rootCursor];
		if (account) {
			return {
				state: { ...state, pendingG: false },
				action: {
					type: "switch",
					accountIndex: resolveAccountActionIndex(account),
				},
			};
		}
	}
	return {
		state: {
			...state,
			pendingG: false,
		},
	};
}

export function handleAddAccountModalInput(
	state: RootTuiState,
	event: RootTuiKeyEvent,
): RootTuiTransition {
	if (event.key.ctrl && event.input.toLowerCase() === "c") {
		return { state: { ...state, mode: "root", pendingG: false }, action: { type: "cancel" } };
	}
	if (event.key.upArrow || event.input === "k") {
		return {
			state: {
				...state,
				addCursor: clamp(state.addCursor - 1, 0, ADD_ACCOUNT_OPTION_COUNT - 1),
				pendingG: false,
			},
		};
	}
	if (event.key.downArrow || event.input === "j") {
		return {
			state: {
				...state,
				addCursor: clamp(state.addCursor + 1, 0, ADD_ACCOUNT_OPTION_COUNT - 1),
				pendingG: false,
			},
		};
	}
	if (event.input === "1") {
		return {
			state: { ...state, mode: "root", pendingG: false },
			action: { type: "add", signInMode: "browser" },
		};
	}
	if (event.input === "2") {
		return {
			state: { ...state, mode: "root", pendingG: false },
			action: { type: "add", signInMode: "manual" },
		};
	}
	if (
		event.input === "q" ||
		event.input === "h" ||
		(event.key.escape && !event.input)
	) {
		return {
			state: { ...state, mode: "root", pendingG: false },
		};
	}
	if (event.key.return) {
		if (state.addCursor === 0) {
			return {
				state: { ...state, mode: "root", pendingG: false },
				action: { type: "add", signInMode: "browser" },
			};
		}
		if (state.addCursor === 1) {
			return {
				state: { ...state, mode: "root", pendingG: false },
				action: { type: "add", signInMode: "manual" },
			};
		}
		return {
			state: { ...state, mode: "root", pendingG: false },
		};
	}
	return {
		state: {
			...state,
			pendingG: false,
		},
	};
}
