import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_LIMITS } from "../lib/constants.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";

const {
	loadAccountsMock,
	getNamedBackupsMock,
	promptAddAnotherAccountMock,
	promptLoginModeMock,
	isBrowserLaunchSuppressedMock,
	runSignInFlowMock,
	resolveAccountSelectionMock,
	persistAccountPoolMock,
	syncSelectionToCodexMock,
} = vi.hoisted(() => ({
	loadAccountsMock: vi.fn(),
	getNamedBackupsMock: vi.fn(),
	promptAddAnotherAccountMock: vi.fn(),
	promptLoginModeMock: vi.fn(),
	isBrowserLaunchSuppressedMock: vi.fn(),
	runSignInFlowMock: vi.fn(),
	resolveAccountSelectionMock: vi.fn(),
	persistAccountPoolMock: vi.fn(),
	syncSelectionToCodexMock: vi.fn(),
}));

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		loadAccounts: loadAccountsMock,
		getNamedBackups: getNamedBackupsMock,
		setStoragePath: vi.fn(),
	};
});

vi.mock("../lib/cli.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/cli.js")>();
	return {
		...actual,
		promptLoginMode: promptLoginModeMock,
		promptAddAnotherAccount: promptAddAnotherAccountMock,
	};
});

vi.mock("../lib/auth/browser.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/browser.js")>();
	return {
		...actual,
		isBrowserLaunchSuppressed: isBrowserLaunchSuppressedMock,
	};
});

// Keep the real isOAuthCancellation (the predicate steering the cancel
// branches under test); fake only the effectful flow functions.
vi.mock("../lib/codex-manager/login-oauth.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../lib/codex-manager/login-oauth.js")
	>();
	return {
		...actual,
		runSignInFlow: runSignInFlowMock,
		resolveAccountSelection: resolveAccountSelectionMock,
		persistAccountPool: persistAccountPoolMock,
		syncSelectionToCodex: syncSelectionToCodexMock,
	};
});

const { runAuthLogin } = await import("../lib/codex-manager/login-flow.js");

const NOW = 1_700_000_000_000;

function account(id: string): AccountMetadataV3 {
	return {
		email: `${id}@example.com`,
		accountId: `acc_${id}`,
		refreshToken: `refresh-${id}`,
		accessToken: `access-${id}`,
		expiresAt: NOW + 3_600_000,
		addedAt: NOW - 60_000,
		lastUsed: NOW - 60_000,
	};
}

function storageWith(count: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: {},
		accounts: Array.from({ length: count }, (_, i) => account(`a${i}`)),
	};
}

function deps() {
	return {
		runForecast: vi.fn(),
		createRepairCommandDeps: vi.fn(),
	};
}

const CANCELLED = { type: "failed" as const, message: "User cancelled login" };
const TOKEN_SUCCESS = { type: "success" as const };
const RESOLVED = { type: "success" as const, accountIdOverride: "acc_x" };

// What loadAccounts "sees on disk"; persistAccountPool grows it.
let accountsOnDisk: AccountStorageV3 | null = null;

const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	accountsOnDisk = null;
	loadAccountsMock.mockImplementation(async () => accountsOnDisk);
	getNamedBackupsMock.mockResolvedValue([]);
	isBrowserLaunchSuppressedMock.mockReturnValue(false);
	// Inert default so a test that forgets to set the sign-in result exits
	// through the cancellation branch instead of crashing on undefined.
	runSignInFlowMock.mockResolvedValue(CANCELLED);
	resolveAccountSelectionMock.mockReturnValue(RESOLVED);
	// Default persist simulates the insertion-only path: accountsOnDisk grows
	// by one and the outcome is "inserted". Tests asserting the same-email
	// "rebound"/"updated" semantics override this with a non-growing impl.
	persistAccountPoolMock.mockImplementation(async () => {
		accountsOnDisk = storageWith((accountsOnDisk?.accounts.length ?? 0) + 1);
		return "inserted";
	});
	syncSelectionToCodexMock.mockResolvedValue(undefined);
	promptAddAnotherAccountMock.mockResolvedValue(false);
	// Keep every prompt on its deterministic non-TTY fallback.
	process.stdin.isTTY = false;
	process.stdout.isTTY = false;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	process.stdin.isTTY = originalStdinIsTTY;
	process.stdout.isTTY = originalStdoutIsTTY;
	logSpy.mockRestore();
	errorSpy.mockRestore();
	warnSpy.mockRestore();
});

function loggedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
	return spy.mock.calls.map((call) => call.map(String).join(" "));
}

describe("runAuthLogin argument handling", () => {
	it("rejects --org without a value and prints usage", async () => {
		expect(await runAuthLogin(["--org"], deps())).toBe(1);
		expect(loggedLines(errorSpy).join("\n")).toContain(
			"Missing value for --org",
		);
		expect(loadAccountsMock).not.toHaveBeenCalled();
	});

	it("returns 0 for --help without starting the flow", async () => {
		expect(await runAuthLogin(["--help"], deps())).toBe(0);
		expect(loadAccountsMock).not.toHaveBeenCalled();
		expect(runSignInFlowMock).not.toHaveBeenCalled();
	});

	it("rejects combining --device-auth with a manual-mode flag", async () => {
		expect(await runAuthLogin(["--device-auth", "--no-browser"], deps())).toBe(
			1,
		);
		expect(loggedLines(errorSpy).join("\n")).toContain(
			"Cannot combine --device-auth with --no-browser",
		);
		expect(runSignInFlowMock).not.toHaveBeenCalled();
	});
});

describe("runAuthLogin explicit transports", () => {
	it("bypasses the dashboard with --device-auth and exits cleanly on cancel", async () => {
		// With saved accounts a plain `login` would open the dashboard; an
		// explicit transport must skip it, and cancelling must NOT fall back to
		// the dashboard (that would trap scripts in a sign-in loop).
		accountsOnDisk = storageWith(2);
		runSignInFlowMock.mockResolvedValue(CANCELLED);

		expect(await runAuthLogin(["--device-auth"], deps())).toBe(0);

		expect(promptLoginModeMock).not.toHaveBeenCalled();
		expect(runSignInFlowMock).toHaveBeenCalledExactlyOnceWith(true, "device");
		expect(loggedLines(logSpy)).toContain("Cancelled.");
	});

	it("exits 1 with the failure message on a non-cancellation failure", async () => {
		runSignInFlowMock.mockResolvedValue({
			type: "failed",
			message: "token exchange exploded",
		});

		expect(await runAuthLogin(["--manual"], deps())).toBe(1);
		expect(loggedLines(errorSpy)).toContain(
			"Login failed: token exchange exploded",
		);
		expect(persistAccountPoolMock).not.toHaveBeenCalled();
	});

	it("threads --org into resolveAccountSelection and persists the account", async () => {
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		const envOverrideBefore = process.env.CODEX_AUTH_ACCOUNT_ID;

		expect(await runAuthLogin(["--manual", "--org", "org_team"], deps())).toBe(
			0,
		);

		// Issue #491: the org binding travels as an explicit argument, not via
		// process.env mutation.
		expect(process.env.CODEX_AUTH_ACCOUNT_ID).toBe(envOverrideBefore);
		expect(resolveAccountSelectionMock).toHaveBeenCalledExactlyOnceWith(
			TOKEN_SUCCESS,
			"org_team",
		);
		expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith(
			[RESOLVED],
			false,
		);
		expect(syncSelectionToCodexMock).toHaveBeenCalledExactlyOnceWith(RESOLVED);
		// Empty pool at start: this was not a forced re-login.
		expect(runSignInFlowMock).toHaveBeenCalledExactlyOnceWith(false, "manual");
		expect(loggedLines(logSpy)).toContain("Added account. Total: 1");
	});

	it.each([
		["rebound", "Rebound workspace for existing account. Total: 1"],
		["updated", "Updated existing account. Total: 1"],
	] as const)(
		"reports a %s persist outcome without claiming a new slot",
		async (outcome, message) => {
			// Issue #512: same-email logins update or rebind instead of growing
			// the pool, and the summary line must say so.
			runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
			persistAccountPoolMock.mockImplementation(async () => {
				accountsOnDisk = storageWith(1);
				return outcome;
			});

			expect(await runAuthLogin(["--manual"], deps())).toBe(0);
			expect(loggedLines(logSpy)).toContain(message);
		},
	);

	it("stops at the account cap without offering another sign-in", async () => {
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		persistAccountPoolMock.mockImplementation(async () => {
			accountsOnDisk = storageWith(ACCOUNT_LIMITS.MAX_ACCOUNTS);
			return "inserted";
		});

		expect(await runAuthLogin(["--manual"], deps())).toBe(0);

		expect(promptAddAnotherAccountMock).not.toHaveBeenCalled();
		expect(loggedLines(logSpy)).toContain(
			`Reached maximum account limit (${ACCOUNT_LIMITS.MAX_ACCOUNTS}).`,
		);
	});

	it("runs a second sign-in as a forced re-login when adding another account", async () => {
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		promptAddAnotherAccountMock
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		expect(await runAuthLogin(["--manual"], deps())).toBe(0);

		expect(runSignInFlowMock).toHaveBeenCalledTimes(2);
		expect(runSignInFlowMock).toHaveBeenNthCalledWith(1, false, "manual");
		// The second login must force a fresh browser session so it cannot
		// silently reuse the first account's cookies.
		expect(runSignInFlowMock).toHaveBeenNthCalledWith(2, true, "manual");
		expect(loggedLines(logSpy)).toContain("Added account. Total: 2");
	});
});

// These tests run through the REAL promptOAuthSignInMode in
// login-menu-actions.ts: with the TTY flags forced false it takes its
// documented non-interactive fast path and returns "browser" (unless browser
// launch is suppressed). The runSignInFlow transport assertions below pin
// exactly that fallback on purpose — do not mock the prompt here.
describe("runAuthLogin onboarding without explicit flags", () => {
	it("prefers manual transport when browser launch is suppressed", async () => {
		isBrowserLaunchSuppressedMock.mockReturnValue(true);
		runSignInFlowMock.mockResolvedValue(CANCELLED);

		expect(await runAuthLogin([], deps())).toBe(0);

		expect(runSignInFlowMock).toHaveBeenCalledExactlyOnceWith(false, "manual");
		expect(loggedLines(logSpy)).toContain("Cancelled.");
	});

	it("warns and continues when named-backup discovery fails hard", async () => {
		getNamedBackupsMock.mockRejectedValue(
			Object.assign(new Error("permission denied"), { code: "EACCES" }),
		);
		runSignInFlowMock.mockResolvedValue(CANCELLED);

		expect(await runAuthLogin([], deps())).toBe(0);

		expect(loggedLines(warnSpy).join("\n")).toContain(
			"Named backup discovery failed",
		);
		// Sign-in still proceeded on the non-TTY default transport.
		expect(runSignInFlowMock).toHaveBeenCalledExactlyOnceWith(false, "browser");
	});

	it("treats a missing backup directory as normal, without warning", async () => {
		getNamedBackupsMock.mockRejectedValue(
			Object.assign(new Error("no such file"), { code: "ENOENT" }),
		);
		runSignInFlowMock.mockResolvedValue(CANCELLED);

		expect(await runAuthLogin([], deps())).toBe(0);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
