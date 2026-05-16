import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInitialRootTuiState,
	handleAddAccountModalInput,
	handleRootScreenInput,
} from "../lib/codex-manager/commands/root-tui-state.js";

describe("root TUI Ink state", () => {
	it("keeps the root cursor inactive when no accounts exist", () => {
		expect(createInitialRootTuiState([])).toEqual({
			mode: "root",
			rootCursor: -1,
			addCursor: 0,
			pendingG: false,
		});
	});

	it("moves, jumps, and switches using the saved source index", () => {
		const accounts = [
			{ index: 0, sourceIndex: 4, email: "one@example.com", quickSwitchNumber: 1 },
			{ index: 1, sourceIndex: 8, email: "two@example.com", quickSwitchNumber: 2 },
			{ index: 2, sourceIndex: 9, email: "three@example.com", quickSwitchNumber: 3 },
		];
		let state = createInitialRootTuiState(accounts);

		state = handleRootScreenInput(state, { input: "j", key: {} }, accounts).state;
		expect(state.rootCursor).toBe(1);

		state = handleRootScreenInput(state, { input: "G", key: {} }, accounts).state;
		expect(state.rootCursor).toBe(2);

		state = handleRootScreenInput(state, { input: "g", key: {} }, accounts).state;
		expect(state.pendingG).toBe(true);

		state = handleRootScreenInput(state, { input: "g", key: {} }, accounts).state;
		expect(state.rootCursor).toBe(0);
		expect(state.pendingG).toBe(false);

		const quickSwitch = handleRootScreenInput(
			state,
			{ input: "2", key: {} },
			accounts,
		);
		expect(quickSwitch.action).toEqual({ type: "switch", accountIndex: 8 });

		const spaceSwitch = handleRootScreenInput(
			state,
			{ input: " ", key: {} },
			accounts,
		);
		expect(spaceSwitch.action).toEqual({ type: "switch", accountIndex: 4 });
	});

	it("opens and closes the add modal without losing the root cursor", () => {
		const accounts = [
			{ index: 0, sourceIndex: 0, email: "one@example.com", quickSwitchNumber: 1 },
			{ index: 1, sourceIndex: 1, email: "two@example.com", quickSwitchNumber: 2 },
		];
		let state = createInitialRootTuiState(accounts);
		state = handleRootScreenInput(state, { input: "j", key: {} }, accounts).state;
		expect(state.rootCursor).toBe(1);

		state = handleRootScreenInput(state, { input: "a", key: {} }, accounts).state;
		expect(state.mode).toBe("add");
		expect(state.rootCursor).toBe(1);

		state = handleAddAccountModalInput(state, { input: "q", key: {} }).state;
		expect(state.mode).toBe("root");
		expect(state.rootCursor).toBe(1);
	});

	it("dispatches the existing add-account payloads from modal shortcuts and enter", () => {
		let state = createInitialRootTuiState([{ index: 0, email: "one@example.com" }]);
		state = handleRootScreenInput(state, { input: "a", key: {} }, []).state;

		const browser = handleAddAccountModalInput(state, { input: "1", key: {} });
		expect(browser.action).toEqual({ type: "add", signInMode: "browser" });

		state = handleRootScreenInput(
			createInitialRootTuiState([{ index: 0, email: "one@example.com" }]),
			{ input: "a", key: {} },
			[],
		).state;
		state = handleAddAccountModalInput(state, { input: "j", key: {} }).state;
		const manual = handleAddAccountModalInput(state, {
			input: "",
			key: { return: true },
		});
		expect(manual.action).toEqual({ type: "add", signInMode: "manual" });
	});
});

describe("root TUI Ink renderer", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("ink");
		vi.restoreAllMocks();
	});

	it("uses Ink alternate-screen rendering by default", async () => {
		const renderMock = vi.fn(() => ({
			waitUntilExit: () => Promise.resolve(),
		}));

		vi.doMock("ink", async () => {
			const actual = await vi.importActual<typeof import("ink")>("ink");
			return {
				...actual,
				render: renderMock,
			};
		});

		const { promptRootCommandInkTui } = await import(
			"../lib/codex-manager/commands/root-tui-ink.js"
		);
		const result = await promptRootCommandInkTui([]);

		expect(result).toEqual({ type: "cancel" });
		expect(renderMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ alternateScreen: true }),
		);
	});
});
