import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const promptRootCommandInkTuiMock = vi.fn();

vi.mock("../lib/codex-manager/commands/root-tui-ink.js", () => ({
	promptRootCommandInkTui: promptRootCommandInkTuiMock,
}));

describe("promptRootCommandTui", () => {
	beforeEach(() => {
		vi.resetModules();
		promptRootCommandInkTuiMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the Ink action contract unchanged", async () => {
		promptRootCommandInkTuiMock.mockResolvedValueOnce({
			type: "switch",
			accountIndex: 4,
		});

		const { promptRootCommandTui } = await import(
			"../lib/codex-manager/commands/root-tui.js"
		);
		const result = await promptRootCommandTui([
			{
				index: 0,
				sourceIndex: 4,
				email: "sorted@example.com",
				quickSwitchNumber: 1,
			},
		]);

		expect(result).toEqual({ type: "switch", accountIndex: 4 });
		expect(promptRootCommandInkTuiMock).toHaveBeenCalledWith([
			expect.objectContaining({
				sourceIndex: 4,
				email: "sorted@example.com",
			}),
		], undefined);
	});

	it("returns add-account actions from the Ink prompt unchanged", async () => {
		promptRootCommandInkTuiMock.mockResolvedValueOnce({
			type: "add",
			signInMode: "manual",
		});

		const { promptRootCommandTui } = await import(
			"../lib/codex-manager/commands/root-tui.js"
		);
		const result = await promptRootCommandTui([
			{
				index: 0,
				sourceIndex: 0,
				email: "one@example.com",
				quickSwitchNumber: 1,
			},
		]);

		expect(result).toEqual({ type: "add", signInMode: "manual" });
	});

	it("keeps the empty-state adapter path available", async () => {
		promptRootCommandInkTuiMock.mockResolvedValueOnce({
			type: "add",
			signInMode: "browser",
		});

		const { promptRootCommandTui } = await import(
			"../lib/codex-manager/commands/root-tui.js"
		);
		const result = await promptRootCommandTui([]);

		expect(result).toEqual({ type: "add", signInMode: "browser" });
		expect(promptRootCommandInkTuiMock).toHaveBeenCalledWith([], undefined);
	});
});
