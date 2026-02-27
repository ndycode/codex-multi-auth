import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showAuthMenu = vi.fn();
const showAccountDetails = vi.fn();
const isTTY = vi.fn();

vi.mock("../lib/ui/auth-menu.js", () => ({
	showAuthMenu,
	showAccountDetails,
	isTTY,
}));

describe("CLI auth menu shortcuts", () => {
	beforeEach(() => {
		vi.resetModules();
		showAuthMenu.mockReset();
		showAccountDetails.mockReset();
		isTTY.mockReset();
		isTTY.mockReturnValue(true);
		process.env.FORCE_INTERACTIVE_MODE = "1";
	});

	afterEach(() => {
		delete process.env.FORCE_INTERACTIVE_MODE;
		vi.restoreAllMocks();
	});

	it("returns switch action when auth menu requests set current", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "set-current-account",
			account: { index: 1 },
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }, { index: 1 }]);

		expect(result).toEqual({ mode: "manage", switchAccountIndex: 1 });
	});

	it("uses source index for set current when sorted view provides source mapping", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "set-current-account",
			account: { index: 0, sourceIndex: 4 },
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0, sourceIndex: 4 }]);

		expect(result).toEqual({ mode: "manage", switchAccountIndex: 4 });
	});

	it("returns switch action when account details picks set current", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "select-account",
			account: { index: 2 },
		});
		showAccountDetails.mockResolvedValueOnce("set-current");

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }, { index: 1 }, { index: 2 }]);

		expect(result).toEqual({ mode: "manage", switchAccountIndex: 2 });
	});

	it("returns refresh action when auth menu requests refresh", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "refresh-account",
			account: { index: 0 },
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "manage", refreshAccountIndex: 0 });
	});

	it("returns toggle action when auth menu requests toggle", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "toggle-account",
			account: { index: 1 },
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }, { index: 1 }]);

		expect(result).toEqual({ mode: "manage", toggleAccountIndex: 1 });
	});

	it("uses source index for account-details actions when sorted view provides source mapping", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "select-account",
			account: { index: 0, sourceIndex: 3 },
		});
		showAccountDetails.mockResolvedValueOnce("refresh");

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0, sourceIndex: 3 }]);

		expect(result).toEqual({ mode: "manage", refreshAccountIndex: 3 });
	});

	it("returns forecast mode when auth menu requests forecast", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "forecast",
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "forecast" });
	});

	it("returns fix mode when auth menu requests fix", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "fix",
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "fix" });
	});

	it("returns settings mode when auth menu requests settings", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "settings",
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "settings" });
	});

	it("returns delete action when auth menu requests delete", async () => {
		showAuthMenu.mockResolvedValueOnce({
			type: "delete-account",
			account: { index: 0 },
		});

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "manage", deleteAccountIndex: 0 });
	});

	it("returns deep-check mode when auth menu requests deep-check", async () => {
		showAuthMenu.mockResolvedValueOnce({ type: "deep-check" });

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "deep-check" });
	});

	it("returns verify-flagged mode when auth menu requests verify-flagged", async () => {
		showAuthMenu.mockResolvedValueOnce({ type: "verify-flagged" });

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "verify-flagged" });
	});

	it("returns cancel mode when auth menu requests cancel", async () => {
		showAuthMenu.mockResolvedValueOnce({ type: "cancel" });

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "cancel" });
	});

	it("shows feedback when account action cannot resolve a valid source index", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		showAuthMenu
			.mockResolvedValueOnce({
				type: "set-current-account",
				account: { index: Number.NaN, email: "broken@example.com" },
			})
			.mockResolvedValueOnce({ type: "cancel" });

		const { promptLoginMode } = await import("../lib/cli.js");
		const result = await promptLoginMode([{ index: 0 }]);

		expect(result).toEqual({ mode: "cancel" });
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Unable to resolve saved account for action"),
		);
		consoleSpy.mockRestore();
	});
});
