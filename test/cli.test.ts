import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInterface } from "node:readline/promises";

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
        expect.stringContaining("5 added")
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

    it("returns 'fresh' for 'f' input", async () => {
      mockRl.question.mockResolvedValueOnce("f");
      
      const { promptLoginMode } = await import("../lib/cli.js");
      const result = await promptLoginMode([{ index: 0 }]);
      
      expect(result).toEqual({ mode: "fresh", deleteAll: true });
    });

    it("returns 'fresh' for 'fresh' input", async () => {
      mockRl.question.mockResolvedValueOnce("fresh");
      
      const { promptLoginMode } = await import("../lib/cli.js");
      const result = await promptLoginMode([{ index: 0 }]);
      
      expect(result).toEqual({ mode: "fresh", deleteAll: true });
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
        .mockResolvedValueOnce("x")
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
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("2 account(s)"));
    });

    it("displays account with accountId suffix when no email", async () => {
      mockRl.question.mockResolvedValueOnce("f");
      const consoleSpy = vi.spyOn(console, "log");
      
      const { promptLoginMode } = await import("../lib/cli.js");
      await promptLoginMode([
        { index: 0, accountId: "acc_1234567890" },
      ]);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/1\.\s*567890/));
    });

		it("displays plain Account N when no email or accountId", async () => {
			mockRl.question.mockResolvedValueOnce("f");
			const consoleSpy = vi.spyOn(console, "log");
			
			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([{ index: 0 }]);
			
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("1. Account"));
		});

		it("displays label with email when both present", async () => {
			mockRl.question.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");
			
			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([{ index: 0, accountLabel: "Work", email: "work@example.com" }]);
			
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/Work.*work@example\.com/));
		});

		it("displays only label when no email", async () => {
			mockRl.question.mockResolvedValueOnce("a");
			const consoleSpy = vi.spyOn(console, "log");
			
			const { promptLoginMode } = await import("../lib/cli.js");
			await promptLoginMode([{ index: 0, accountLabel: "Personal" }]);
			
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("1. Personal"));
		});
	});

	describe("isNonInteractiveMode", () => {
		it("returns false when FORCE_INTERACTIVE_MODE is set", async () => {
			process.env.FORCE_INTERACTIVE_MODE = "1";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(false);
		});

		it("returns true when OPENCODE_TUI is set", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.OPENCODE_TUI = "1";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(true);
			delete process.env.OPENCODE_TUI;
		});

		it("returns true when OPENCODE_DESKTOP is set", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.OPENCODE_DESKTOP = "1";
			const { isNonInteractiveMode } = await import("../lib/cli.js");
			expect(isNonInteractiveMode()).toBe(true);
			delete process.env.OPENCODE_DESKTOP;
		});

		it("returns true when TERM_PROGRAM is opencode", async () => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.TERM_PROGRAM = "opencode";
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
			delete process.env.OPENCODE_TUI;
			delete process.env.OPENCODE_DESKTOP;
			delete process.env.TERM_PROGRAM;
			delete process.env.ELECTRON_RUN_AS_NODE;

			const { stdin, stdout } = await import("node:process");
			const origInputTTY = stdin.isTTY;
			const origOutputTTY = stdout.isTTY;
			
			Object.defineProperty(stdin, "isTTY", { value: true, writable: true, configurable: true });
			Object.defineProperty(stdout, "isTTY", { value: true, writable: true, configurable: true });
			
			try {
				const { isNonInteractiveMode } = await import("../lib/cli.js");
				expect(isNonInteractiveMode()).toBe(false);
			} finally {
				Object.defineProperty(stdin, "isTTY", { value: origInputTTY, writable: true, configurable: true });
				Object.defineProperty(stdout, "isTTY", { value: origOutputTTY, writable: true, configurable: true });
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
			const result = await promptAccountSelection(candidates, { defaultIndex: 1 });
			
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
			mockRl.question
				.mockResolvedValueOnce("99")
				.mockResolvedValueOnce("1");
			
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
				{ title: "Custom Title" }
			);
			
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Custom Title"));
		});

		it("shows default marker for default candidates", async () => {
			mockRl.question.mockResolvedValueOnce("1");
			const consoleSpy = vi.spyOn(console, "log");
			
			const { promptAccountSelection } = await import("../lib/cli.js");
			await promptAccountSelection([
				{ accountId: "acc1", label: "Account 1", isDefault: true },
			]);
			
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("(default)"));
		});

		it("clamps defaultIndex to valid range", async () => {
			mockRl.question.mockResolvedValueOnce("");
			
			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates, { defaultIndex: 999 });
			
			expect(result).toEqual(candidates[1]);
		});

		it("handles negative defaultIndex", async () => {
			mockRl.question.mockResolvedValueOnce("");
			
			const { promptAccountSelection } = await import("../lib/cli.js");
			const candidates = [
				{ accountId: "acc1", label: "Account 1" },
				{ accountId: "acc2", label: "Account 2" },
			];
			const result = await promptAccountSelection(candidates, { defaultIndex: -5 });
			
			expect(result).toEqual(candidates[0]);
		});
	});

	describe("non-interactive mode behavior", () => {
		beforeEach(() => {
			delete process.env.FORCE_INTERACTIVE_MODE;
			process.env.OPENCODE_TUI = "1";
		});

		afterEach(() => {
			delete process.env.OPENCODE_TUI;
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
			const result = await promptAccountSelection(candidates, { defaultIndex: 1 });
			expect(result).toEqual(candidates[1]);
		});
	});
});
