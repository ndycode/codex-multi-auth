import { createInterface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(),
}));

const mockRl = {
	question: vi.fn(),
	close: vi.fn(),
};

describe("CLI Module", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.FORCE_INTERACTIVE_MODE = "1";
		mockRl.question.mockReset();
		mockRl.close.mockReset();
		vi.mocked(createInterface).mockReturnValue(mockRl as any);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		delete process.env.FORCE_INTERACTIVE_MODE;
		vi.restoreAllMocks();
	});

	describe("promptAddAnotherAccount", () => {
		it("returns true for 'y' input", async () => {
			mockRl.question.mockResolvedValueOnce("y");

			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			const result = await promptAddAnotherAccount(1);

			expect(result).toBe(true);
			expect(mockRl.close).toHaveBeenCalled();
		});

		it("returns true for 'yes' input", async () => {
			mockRl.question.mockResolvedValueOnce("yes");

			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			const result = await promptAddAnotherAccount(2);

			expect(result).toBe(true);
		});

		it("returns true for 'Y' input (case insensitive)", async () => {
			mockRl.question.mockResolvedValueOnce("Y");

			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			const result = await promptAddAnotherAccount(1);

			expect(result).toBe(true);
		});

		it("returns false for 'n' input", async () => {
			mockRl.question.mockResolvedValueOnce("n");

			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			const result = await promptAddAnotherAccount(1);

			expect(result).toBe(false);
		});

		it("returns false for empty input", async () => {
			mockRl.question.mockResolvedValueOnce("");

			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			const result = await promptAddAnotherAccount(1);

			expect(result).toBe(false);
		});

		it("returns false for random input", async () => {
			mockRl.question.mockResolvedValueOnce("maybe");

			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			const result = await promptAddAnotherAccount(1);

			expect(result).toBe(false);
		});

		it("includes current count in prompt", async () => {
			mockRl.question.mockResolvedValueOnce("n");

			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			await promptAddAnotherAccount(5);

			expect(mockRl.question).toHaveBeenCalledWith(
				expect.stringContaining("5 added"),
			);
		});

		it("always closes readline interface", async () => {
			mockRl.question.mockRejectedValueOnce(new Error("test error"));

			const { promptAddAnotherAccount } = await import("../lib/cli.js");

			await expect(promptAddAnotherAccount(1)).rejects.toThrow("test error");
			expect(mockRl.close).toHaveBeenCalled();
		});
	});

	describe("promptLoginMode", () => {
		it("returns 'add' for 'a' input", async () => {
			mockRl.question.mockResolvedValueOnce("a");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([
				{ index: 0, email: "test@example.com" },
			]);

			expect(result).toEqual({ mode: "add" });
			expect(mockRl.close).toHaveBeenCalled();
		});

		it("returns 'add' for 'add' input", async () => {
			mockRl.question.mockResolvedValueOnce("add");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "add" });
		});

		it("returns 'forecast' for 'p' input", async () => {
			mockRl.question.mockResolvedValueOnce("p");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "forecast" });
		});

		it("returns 'fix' for 'x' input", async () => {
			mockRl.question.mockResolvedValueOnce("x");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "fix" });
		});

		it("returns 'settings' for 's' input", async () => {
			mockRl.question.mockResolvedValueOnce("s");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "settings" });
		});

		it("returns 'fresh' for 'f' input", async () => {
			mockRl.question
				.mockResolvedValueOnce("f")
				.mockResolvedValueOnce("DELETE");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "fresh", deleteAll: true });
		});

		it("returns 'fresh' for 'fresh' input", async () => {
			mockRl.question
				.mockResolvedValueOnce("fresh")
				.mockResolvedValueOnce("DELETE");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "fresh", deleteAll: true });
		});

		it("returns 'reset' for fallback reset confirmation", async () => {
			mockRl.question
				.mockResolvedValueOnce("reset")
				.mockResolvedValueOnce("RESET");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "reset" });
		});

		it("cancels fallback delete-all when typed confirmation does not match", async () => {
			mockRl.question
				.mockResolvedValueOnce("fresh")
				.mockResolvedValueOnce("nope")
				.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "add" });
			expect(consoleSpy).toHaveBeenCalledWith(
				"\nDelete saved accounts cancelled.\n",
			);
		});

		it("cancels fallback reset when typed confirmation does not match", async () => {
			mockRl.question
				.mockResolvedValueOnce("reset")
				.mockResolvedValueOnce("nope")
				.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "add" });
			expect(consoleSpy).toHaveBeenCalledWith(
				"\nReset local state cancelled.\n",
			);
		});

		it("returns reset for TTY reset-all confirmation", async () => {
			const { stdin, stdout } = await import("node:process");
			const origInputTTY = stdin.isTTY;
			const origOutputTTY = stdout.isTTY;
			const showAuthMenuMock = vi.fn().mockResolvedValue({ type: "reset-all" });

			Object.defineProperty(stdin, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(stdout, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});

			try {
				vi.resetModules();
				vi.doMock("../lib/ui/auth-menu.js", async () => {
					const actual = await vi.importActual("../lib/ui/auth-menu.js");
					return {
						...(actual as Record<string, unknown>),
						isTTY: vi.fn(() => true),
						showAuthMenu: showAuthMenuMock,
					};
				});
				mockRl.question.mockResolvedValueOnce("RESET");

				const { promptLoginMode } = await import("../lib/cli.js");
				const result = await promptLoginMode([{ index: 0 }]);

				expect(result).toEqual({ mode: "reset" });
				expect(showAuthMenuMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.doUnmock("../lib/ui/auth-menu.js");
				Object.defineProperty(stdin, "isTTY", {
					value: origInputTTY,
					writable: true,
					configurable: true,
				});
				Object.defineProperty(stdout, "isTTY", {
					value: origOutputTTY,
					writable: true,
					configurable: true,
				});
			}
		});

		it("uses reset local state cancellation copy in TTY reset-all flow", async () => {
			const { stdin, stdout } = await import("node:process");
			const origInputTTY = stdin.isTTY;
			const origOutputTTY = stdout.isTTY;
			const showAuthMenuMock = vi
				.fn()
				.mockResolvedValueOnce({ type: "reset-all" })
				.mockResolvedValueOnce({ type: "add" });
			const consoleSpy = vi.spyOn(console, "log");

			Object.defineProperty(stdin, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(stdout, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});

			try {
				vi.resetModules();
				vi.doMock("../lib/ui/auth-menu.js", async () => {
					const actual = await vi.importActual("../lib/ui/auth-menu.js");
					return {
						...(actual as Record<string, unknown>),
						isTTY: vi.fn(() => true),
						showAuthMenu: showAuthMenuMock,
					};
				});
				mockRl.question.mockResolvedValueOnce("nope");

				const { promptLoginMode } = await import("../lib/cli.js");
				const result = await promptLoginMode([{ index: 0 }]);

				expect(result).toEqual({ mode: "add" });
				expect(consoleSpy).toHaveBeenCalledWith(
					"\nReset local state cancelled.\n",
				);
			} finally {
				vi.doUnmock("../lib/ui/auth-menu.js");
				Object.defineProperty(stdin, "isTTY", {
					value: origInputTTY,
					writable: true,
					configurable: true,
				});
				Object.defineProperty(stdout, "isTTY", {
					value: origOutputTTY,
					writable: true,
					configurable: true,
				});
			}
		});

		it("returns 'verify-flagged' for 'g' input", async () => {
			mockRl.question.mockResolvedValueOnce("g");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "verify-flagged" });
		});

		it("accepts uppercase quick shortcuts for advanced actions", async () => {
			const { promptLoginMode } = await import("../lib/cli.js");

			mockRl.question.mockResolvedValueOnce("P");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "forecast",
			});

			mockRl.question.mockResolvedValueOnce("X");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "fix",
			});

			mockRl.question.mockResolvedValueOnce("S");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "settings",
			});

			mockRl.question.mockResolvedValueOnce("G");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "verify-flagged",
			});
		});

		it("is case insensitive", async () => {
			mockRl.question.mockResolvedValueOnce("A");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "add" });
		});

		it("re-prompts on invalid input then accepts valid", async () => {
			mockRl.question
				.mockResolvedValueOnce("invalid")
				.mockResolvedValueOnce("zzz")
				.mockResolvedValueOnce("a");

			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);

			expect(result).toEqual({ mode: "add" });
			expect(mockRl.question).toHaveBeenCalledTimes(3);
		});

		it("displays account list with email", async () => {
			mockRl.question.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([
				{ index: 0, email: "user1@example.com" },
				{ index: 1, email: "user2@example.com" },
			]);

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining("2 account(s)"),
			);
		});

		it("displays account with accountId suffix when no email", async () => {
			mockRl.question.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([{ index: 0, accountId: "acc_1234567890" }]);

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringMatching(/1\.\s*567890/),
			);
		});

		it("displays plain Account N when no email or accountId", async () => {
			mockRl.question.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([{ index: 0 }]);

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining("1. Account"),
			);
		});

		it("displays label with email when both present", async () => {
			mockRl.question.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([
				{ index: 0, accountLabel: "Work", email: "work@example.com" },
			]);

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringMatching(/Work.*work@example\.com/),
			);
		});

		it("displays only label when no email", async () => {
			mockRl.question.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([{ index: 0, accountLabel: "Personal" }]);

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining("1. Personal"),
			);
		});
	});

	describe("isNonInteractiveMode", () => {
		it("returns false when FORCE_INTERACTIVE_MODE is set", async () => {
			process.env.FORCE_INTERACTIVE_MODE = "1";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(false);
		});

		it("returns true when CODEX_TUI is set", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.CODEX_TUI = "1";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(true);
			delete process.env.CODEX_TUI;
		});

		it("returns true when CODEX_DESKTOP is set", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.CODEX_DESKTOP = "1";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(true);
			delete process.env.CODEX_DESKTOP;
		});

		it("returns true when TERM_PROGRAM is Codex", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.TERM_PROGRAM = "Codex";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(true);
			delete process.env.TERM_PROGRAM;
		});

		it("returns true when ELECTRON_RUN_AS_NODE is set", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.ELECTRON_RUN_AS_NODE = "1";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(true);
			delete process.env.ELECTRON_RUN_AS_NODE;
		});

		it("returns false when TTY is true and no env vars are set", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			delete process.env.CODEX_TUI;
			delete process.env.CODEX_DESKTOP;
			delete process.env.TERM_PROGRAM;
			delete process.env.ELECTRON_RUN_AS_NODE;

			const { stdin, stdout } = await import("node:process");
			const origInputTTY = stdin.isTTY;
			const origOutputTTY = stdout.isTTY;

			Object.defineProperty(stdin, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(stdout, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});

			try {
				const { isNonInteractiveMode } = await import("../lib/cli.js");
				expect(isNonInteractiveMode()).toBe(false);
			} finally {
				Object.defineProperty(stdin, "isTTY", {
					value: origInputTTY,
					writable: true,
					configurable: true,
				});
				Object.defineProperty(stdout, "isTTY", {
					value: origOutputTTY,
					writable: true,
					configurable: true,
				});
			}
		});
	});

	describe("promptAccountSelection", () => {
		it("returns null for empty candidates", async () => {
			const { promptAccountSelection } = await import("../lib/cli.js");
			const result = await promptAccountSelection([]);
			expect(result).toBeNull();
		});

		it("returns first candidate by selection", async () => {
			mockRl.question.mockResolvedValueOnce("1");

			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates);

			expect(result).toEqual(candidates[0]);
			expect(mockRl.close).toHaveBeenCalled();
		});

		it("returns second candidate by selection", async () => {
			mockRl.question.mockResolvedValueOnce("2");

			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates);

			expect(result).toEqual(candidates[1]);
		});

		it("returns default on empty input", async () => {
			mockRl.question.mockResolvedValueOnce("");

			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates, {
				defaultIndex: 1,
			});

			expect(result).toEqual(candidates[1]);
		});

		it("returns default on quit input", async () => {
			mockRl.question.mockResolvedValueOnce("q");

			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [{ accountId: "acc1", label: "Account 1" }];
			const result = await promptAccountSelection(candidates);

			expect(result).toEqual(candidates[0]);
		});

		it("re-prompts on invalid selection", async () => {
			mockRl.question.mockResolvedValueOnce("99").mockResolvedValueOnce("1");

			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [{ accountId: "acc1", label: "Account 1" }];
			const result = await promptAccountSelection(candidates);

			expect(result).toEqual(candidates[0]);
			expect(mockRl.question).toHaveBeenCalledTimes(2);
		});

		it("displays custom title", async () => {
			mockRl.question.mockResolvedValueOnce("1");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptAccountSelection } = await import("../lib/cli.js");
			await promptAccountSelection(
				[{ accountId: "acc1", label: "Account 1" }],
				{ title: "Custom Title" },
			);

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining("Custom Title"),
			);
		});

		it("shows default marker for default candidates", async () => {
			mockRl.question.mockResolvedValueOnce("1");
			const consoleSpy = vi.spyOn(console, "log");

			const { promptAccountSelection } = await import("../lib/cli.js");
			await promptAccountSelection([
				{ accountId: "acc1", label: "Account 1", isDefault: true },
			]);

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining("(default)"),
			);
		});

		it("clamps defaultIndex to valid range", async () => {
			mockRl.question.mockResolvedValueOnce("");

			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates, {
				defaultIndex: 999,
			});

			expect(result).toEqual(candidates[1]);
		});

		it("handles negative defaultIndex", async () => {
			mockRl.question.mockResolvedValueOnce("");

			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates, {
				defaultIndex: -5,
			});

			expect(result).toEqual(candidates[0]);
		});
	});

	describe("non-interactive mode behavior", () => {
		beforeEach(() => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.CODEX_TUI = "1";
		});

		afterEach(() => {
			delete process.env.CODEX_TUI;
		});

		it("promptAddAnotherAccount returns false in non-interactive mode", async () => {
			const { promptAddAnotherAccount } = await import("../lib/cli.js");
			const result = await promptAddAnotherAccount(1);
			expect(result).toBe(false);
		});

		it("promptLoginMode returns add in non-interactive mode", async () => {
			const { promptLoginMode } = await import("../lib/cli.js");
			const result = await promptLoginMode([{ index: 0 }]);
			expect(result).toEqual({ mode: "add" });
		});

		it("promptAccountSelection returns default in non-interactive mode", async () => {
			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates, {
				defaultIndex: 1,
			});
			expect(result).toEqual(candidates[1]);
		});
	});
	describe("additional fallback and env branches", () => {
		it("returns check/deep-check/cancel for fallback aliases", async () => {
			const { promptLoginMode } = await import("../lib/cli.js");

			mockRl.question.mockResolvedValueOnce("check");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "check",
			});

			mockRl.question.mockResolvedValueOnce("deep");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "deep-check",
			});

			mockRl.question.mockResolvedValueOnce("quit");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "cancel",
			});
		});

		it("returns restore-backup for fallback restore aliases", async () => {
			const { promptLoginMode } = await import("../lib/cli.js");

			mockRl.question.mockResolvedValueOnce("u");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "restore-backup",
			});

			mockRl.question.mockResolvedValueOnce("restore");
			await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({
				mode: "restore-backup",
			});
		});

		it("evaluates CODEX_TUI/CODEX_DESKTOP/TERM_PROGRAM/ELECTRON branches when TTY is true", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			const { stdin, stdout } = await import("node:process");
			const origInputTTY = stdin.isTTY;
			const origOutputTTY = stdout.isTTY;
			Object.defineProperty(stdin, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(stdout, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});

			try {
				process.env.CODEX_TUI = "1";
				let mod = await import("../lib/cli.js");
				expect(mod.isNonInteractiveMode()).toBe(true);
				delete process.env.CODEX_TUI;

				process.env.CODEX_DESKTOP = "1";
				mod = await import("../lib/cli.js");
				expect(mod.isNonInteractiveMode()).toBe(true);
				delete process.env.CODEX_DESKTOP;

				process.env.TERM_PROGRAM = " codex ";
				mod = await import("../lib/cli.js");
				expect(mod.isNonInteractiveMode()).toBe(true);
				delete process.env.TERM_PROGRAM;

				process.env.ELECTRON_RUN_AS_NODE = "1";
				mod = await import("../lib/cli.js");
				expect(mod.isNonInteractiveMode()).toBe(true);
				delete process.env.ELECTRON_RUN_AS_NODE;
			} finally {
				delete process.env.CODEX_TUI;
				delete process.env.CODEX_DESKTOP;
				delete process.env.TERM_PROGRAM;
				delete process.env.ELECTRON_RUN_AS_NODE;
				Object.defineProperty(stdin, "isTTY", {
					value: origInputTTY,
					writable: true,
					configurable: true,
				});
				Object.defineProperty(stdout, "isTTY", {
					value: origOutputTTY,
					writable: true,
					configurable: true,
				});
			}
		});
	});
});
