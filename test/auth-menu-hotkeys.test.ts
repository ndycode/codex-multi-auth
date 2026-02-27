import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "../lib/ui/auth-menu.js";

const selectMock = vi.fn();
const confirmMock = vi.fn(async () => true);

vi.mock("../lib/ui/select.js", () => ({
	select: selectMock,
}));

vi.mock("../lib/ui/confirm.js", () => ({
	confirm: confirmMock,
}));

function createAccounts(): AccountInfo[] {
	const baseTime = 1_700_000_000_000;
	return [
		{ index: 0, email: "first@example.com", status: "ok", lastUsed: baseTime - 1_000 },
		{ index: 1, email: "second@example.com", status: "ok", lastUsed: baseTime },
	];
}

describe("auth-menu hotkeys", () => {
	beforeEach(() => {
		vi.resetModules();
		selectMock.mockReset();
		confirmMock.mockReset();
		confirmMock.mockResolvedValue(true);
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("supports numeric quick-switch hotkey (1-9)", async () => {
		selectMock.mockImplementationOnce(async (items: unknown[], options: { onInput?: (...args: unknown[]) => unknown }) => {
			if (!options.onInput) return null;
			return options.onInput("2", {
				cursor: 0,
				items,
				requestRerender: () => undefined,
			});
		});

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		const result = await showAuthMenu(createAccounts());

		expect(result.type).toBe("set-current-account");
		if (result.type === "set-current-account") {
			expect(result.account.index).toBe(1);
		}
	});

	it("ignores out-of-range numeric hotkeys and handles q cancel", async () => {
		selectMock.mockImplementationOnce(
			async (items: unknown[], options: { onInput?: (...args: unknown[]) => unknown }) => {
				if (!options.onInput) return null;
				expect(
					options.onInput("0", {
						cursor: 0,
						items,
						requestRerender: () => undefined,
					}),
				).toBeUndefined();
				expect(
					options.onInput("10", {
						cursor: 0,
						items,
						requestRerender: () => undefined,
					}),
				).toBeUndefined();
				return options.onInput("q", {
					cursor: 0,
					items,
					requestRerender: () => undefined,
				});
			},
		);

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		const result = await showAuthMenu(createAccounts());

		expect(result).toEqual({ type: "cancel" });
	});

	it("does not quick-switch when quick-switch numbers collide", async () => {
		selectMock
			.mockImplementationOnce(
				async (items: unknown[], options: { onInput?: (...args: unknown[]) => unknown }) => {
					if (!options.onInput) return null;
					expect(
						options.onInput("2", {
							cursor: 0,
							items,
							requestRerender: () => undefined,
						}),
					).toBeUndefined();
					return { type: "cancel" };
				},
			);

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		const result = await showAuthMenu([
			{ ...createAccounts()[0], quickSwitchNumber: 2 },
			{ ...createAccounts()[1], quickSwitchNumber: 2 },
		]);

		expect(result).toEqual({ type: "cancel" });
	});

	it("supports search hotkey (/)", async () => {
		selectMock
			.mockImplementationOnce(async (items: unknown[], options: { onInput?: (...args: unknown[]) => unknown }) => {
				if (!options.onInput) return null;
				return options.onInput("/", {
					cursor: 0,
					items,
					requestRerender: () => undefined,
				});
			})
			.mockResolvedValueOnce({ type: "cancel" });

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		const result = await showAuthMenu(createAccounts());

		expect(result).toEqual({ type: "cancel" });
		expect(selectMock).toHaveBeenCalledTimes(2);
	});

	it("supports help toggle hotkey (?) and requests rerender", async () => {
		let rerenderCalls = 0;
		selectMock.mockImplementationOnce(async (items: unknown[], options: { onInput?: (...args: unknown[]) => unknown }) => {
			if (options.onInput) {
				const outcome = options.onInput("?", {
					cursor: 0,
					items,
					requestRerender: () => {
						rerenderCalls += 1;
					},
				});
				expect(outcome).toBeUndefined();
			}
			return { type: "cancel" };
		});

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		const result = await showAuthMenu(createAccounts());

		expect(result).toEqual({ type: "cancel" });
		expect(rerenderCalls).toBe(1);
	});

	it("renders compact account list by showing hints only for selected row", async () => {
		selectMock.mockResolvedValueOnce({ type: "cancel" });

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		const result = await showAuthMenu(createAccounts());

		expect(result).toEqual({ type: "cancel" });
		const options = selectMock.mock.calls[0]?.[1] as { showHintsForUnselected?: boolean };
		expect(options?.showHintsForUnselected).toBe(false);
	});

	it("shows details for unselected rows when account-list setting enables expanded rows", async () => {
		selectMock.mockResolvedValueOnce({ type: "cancel" });

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		const accounts = createAccounts().map((account) => ({
			...account,
			showHintsForUnselectedRows: true,
		}));
		const result = await showAuthMenu(accounts);

		expect(result).toEqual({ type: "cancel" });
		const options = selectMock.mock.calls[0]?.[1] as { showHintsForUnselected?: boolean };
		expect(options?.showHintsForUnselected).toBe(true);
	});
});
