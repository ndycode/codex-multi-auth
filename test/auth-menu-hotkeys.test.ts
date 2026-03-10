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
	let previousCliVersion: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		selectMock.mockReset();
		confirmMock.mockReset();
		confirmMock.mockResolvedValue(true);
		previousCliVersion = process.env.CODEX_MULTI_AUTH_CLI_VERSION;
		delete process.env.CODEX_MULTI_AUTH_CLI_VERSION;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
	});

	afterEach(() => {
		if (previousCliVersion === undefined) {
			delete process.env.CODEX_MULTI_AUTH_CLI_VERSION;
		} else {
			process.env.CODEX_MULTI_AUTH_CLI_VERSION = previousCliVersion;
		}
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

	it("shows package version in the dashboard title when version env is present", async () => {
		process.env.CODEX_MULTI_AUTH_CLI_VERSION = "0.1.6";
		selectMock.mockResolvedValueOnce({ type: "cancel" });

		const { showAuthMenu } = await import("../lib/ui/auth-menu.js");
		await showAuthMenu(createAccounts());

		const options = selectMock.mock.calls[0]?.[1] as { message?: string };
		expect(options?.message).toBe("Accounts Dashboard (v0.1.6)");
	});

	it.each([
		{ input: "s", expected: "set-current" },
		{ input: "r", expected: "refresh" },
		{ input: "t", expected: "toggle" },
		{ input: "e", expected: "toggle" },
		{ input: "x", expected: "toggle" },
		{ input: "d", expected: "delete" },
		{ input: "q", expected: "cancel" },
	])("honors account detail hotkey %s", async ({ input, expected }) => {
		selectMock.mockImplementationOnce(async (_items: unknown[], options: { onInput?: (raw: string) => unknown }) => {
			const onInput = options.onInput;
			return onInput ? onInput(input) : null;
		});

		const { showAccountDetails } = await import("../lib/ui/auth-menu.js");
		const result = await showAccountDetails(createAccounts()[0]);

		expect(result).toBe(expected);
	});
});
