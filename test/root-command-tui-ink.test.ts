import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import {
	createInitialRootTuiState,
	handleAddAccountModalInput,
	handleRootScreenInput,
} from "../lib/codex-manager/commands/root-tui-state.js";
import { RootCommandTuiInkApp } from "../lib/codex-manager/commands/root-tui-ink.js";

function stripAnsi(value: string): string {
	return value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function createInkInput(): NodeJS.ReadStream & PassThrough & {
	ref: () => void;
	setRawMode: (mode: boolean) => void;
	unref: () => void;
} {
	const input = new PassThrough() as NodeJS.ReadStream & PassThrough & {
		ref: () => void;
		setRawMode: (mode: boolean) => void;
		unref: () => void;
	};
	Object.defineProperty(input, "isTTY", { value: true, configurable: true });
	input.ref = vi.fn();
	input.setRawMode = vi.fn();
	input.unref = vi.fn();
	vi.spyOn(input, "resume").mockImplementation(() => input);
	vi.spyOn(input, "pause").mockImplementation(() => input);
	return input;
}

function createInkOutput(): NodeJS.WriteStream & PassThrough {
	const output = new PassThrough() as NodeJS.WriteStream & PassThrough;
	Object.defineProperty(output, "isTTY", { value: true, configurable: true });
	Object.defineProperty(output, "columns", { value: 120, configurable: true });
	Object.defineProperty(output, "rows", { value: 40, configurable: true });
	Object.assign(output, {
		ref: vi.fn(),
		unref: vi.fn(),
	});
	return output;
}

function emitInput(stream: PassThrough, input: string): void {
	stream.write(input, "utf8");
}

function waitForOutputTick(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

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

	it("ignores a second switch keypress while the first switch is still running", async () => {
		const stdin = createInkInput();
		const stdout = createInkOutput();
		const stderr = createInkOutput();
		let frame = "";
		stdout.on("data", (chunk) => {
			frame += chunk.toString("utf8");
		});
		let resolveSwitch:
			| ((value: {
					accounts: Array<{ index: number; sourceIndex: number; email: string }>;
					statusMessage: string;
					statusTone: "success";
			  }) => void)
			| undefined;
		const onSwitch = vi.fn(
			() =>
				new Promise<{
					accounts: Array<{ index: number; sourceIndex: number; email: string }>;
					statusMessage: string;
					statusTone: "success";
				}>((resolve) => {
					resolveSwitch = resolve;
				}),
		);
		const app = render(
			React.createElement(RootCommandTuiInkApp, {
				initialAccounts: [
					{ index: 0, sourceIndex: 0, email: "one@example.com", quickSwitchNumber: 1 },
				],
				handlers: { onSwitch },
				onAction: vi.fn(),
			}),
			{
				stdin,
				stdout,
				stderr,
				exitOnCtrlC: false,
				interactive: true,
				patchConsole: false,
			},
		);

		await app.waitUntilRenderFlush();
		emitInput(stdin, "\r");
		await waitForOutputTick();
		emitInput(stdin, "\r");
		await waitForOutputTick();
		await app.waitUntilRenderFlush();

		expect(onSwitch).toHaveBeenCalledTimes(1);
		resolveSwitch?.({
			accounts: [{ index: 0, sourceIndex: 0, email: "one@example.com" }],
			statusMessage: "Switched to one@example.com.",
			statusTone: "success",
		});
		await waitForOutputTick();
		await app.waitUntilRenderFlush();
		expect(stripAnsi(frame)).toContain("Switched to one@example.com.");

		emitInput(stdin, "q");
		await app.waitUntilExit();
	});

	it("renders the switch error message when account switching fails", async () => {
		const stdin = createInkInput();
		const stdout = createInkOutput();
		const stderr = createInkOutput();
		let frame = "";
		stdout.on("data", (chunk) => {
			frame += chunk.toString("utf8");
		});
		const app = render(
			React.createElement(RootCommandTuiInkApp, {
				initialAccounts: [{ index: 0, sourceIndex: 0, email: "one@example.com" }],
				handlers: {
					onSwitch: vi.fn(async () => {
						throw new Error("EBUSY: file is locked");
					}),
				},
				onAction: vi.fn(),
			}),
			{
				stdin,
				stdout,
				stderr,
				exitOnCtrlC: false,
				interactive: true,
				patchConsole: false,
			},
		);

		await app.waitUntilRenderFlush();
		emitInput(stdin, " ");
		await waitForOutputTick();
		await app.waitUntilRenderFlush();
		expect(stripAnsi(frame)).toContain("EBUSY: file is locked");

		emitInput(stdin, "q");
		await app.waitUntilExit();
	});

	it("renders the refresh error message when refreshing accounts fails", async () => {
		const stdin = createInkInput();
		const stdout = createInkOutput();
		const stderr = createInkOutput();
		let frame = "";
		stdout.on("data", (chunk) => {
			frame += chunk.toString("utf8");
		});
		const app = render(
			React.createElement(RootCommandTuiInkApp, {
				initialAccounts: [{ index: 0, sourceIndex: 0, email: "one@example.com" }],
				handlers: {
					onRefresh: vi.fn(async () => {
						throw new Error("EPERM: refresh failed");
					}),
				},
				onAction: vi.fn(),
			}),
			{
				stdin,
				stdout,
				stderr,
				exitOnCtrlC: false,
				interactive: true,
				patchConsole: false,
			},
		);

		await app.waitUntilRenderFlush();
		emitInput(stdin, "r");
		await waitForOutputTick();
		await app.waitUntilRenderFlush();
		expect(stripAnsi(frame)).toContain("EPERM: refresh failed");

		emitInput(stdin, "q");
		await app.waitUntilExit();
	});
});
