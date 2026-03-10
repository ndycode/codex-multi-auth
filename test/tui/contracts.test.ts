import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreTTYDescriptors(): void {
	if (stdinIsTTYDescriptor) {
		Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
	} else {
		delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
	}
	if (stdoutIsTTYDescriptor) {
		Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
	} else {
		delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
	}
}

function setTTY(stdinTTY: boolean, stdoutTTY: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", {
		value: stdinTTY,
		configurable: true,
	});
	Object.defineProperty(process.stdout, "isTTY", {
		value: stdoutTTY,
		configurable: true,
	});
}

describe("tui restart renderer-neutral contracts", () => {
	const envKeys = [
		"FORCE_INTERACTIVE_MODE",
		"CODEX_TUI",
		"CODEX_DESKTOP",
		"TERM_PROGRAM",
		"ELECTRON_RUN_AS_NODE",
		"CODEX_HOME",
		"CODEX_MULTI_AUTH_DIR",
	] as const;

	const originalEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		vi.resetModules();
		for (const key of envKeys) {
			originalEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		restoreTTYDescriptors();
	});

	afterEach(() => {
		for (const key of envKeys) {
			const value = originalEnv.get(key);
			if (typeof value === "string") {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}
		restoreTTYDescriptors();
		vi.restoreAllMocks();
	});

	it("treats non-tty login as add-only and suppresses add-another prompt", async () => {
		setTTY(false, false);
		const { promptAddAnotherAccount, promptLoginMode, isNonInteractiveMode } = await import("../../lib/cli.js");

		expect(isNonInteractiveMode()).toBe(true);
		await expect(promptAddAnotherAccount(3)).resolves.toBe(false);
		await expect(promptLoginMode([{ index: 0 }])).resolves.toEqual({ mode: "add" });
	});

	it("allows interactive mode override to keep renderer-driven flows available", async () => {
		setTTY(true, true);
		process.env.FORCE_INTERACTIVE_MODE = "1";
		process.env.CODEX_TUI = "1";
		const { isNonInteractiveMode } = await import("../../lib/cli.js");

		expect(isNonInteractiveMode()).toBe(false);
	});

	it("honors explicit storage env overrides exactly", async () => {
		process.env.CODEX_HOME = "/tmp/restart-proof/.codex-home";
		process.env.CODEX_MULTI_AUTH_DIR = "/tmp/restart-proof/multi-auth";
		const { getCodexHomeDir, getCodexMultiAuthDir } = await import("../../lib/runtime-paths.js");

		expect(getCodexHomeDir()).toBe("/tmp/restart-proof/.codex-home");
		expect(getCodexMultiAuthDir()).toBe("/tmp/restart-proof/multi-auth");
	});
});
