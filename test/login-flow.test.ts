import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_LIMITS } from "../lib/constants.js";
import { CodexValidationError } from "../lib/errors.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";

const {
	chooseLoginWorkspaceMock,
	loadAccountsMock,
	getNamedBackupsMock,
	promptAddAnotherAccountMock,
	promptLoginModeMock,
	isBrowserLaunchSuppressedMock,
	runSignInFlowMock,
	resolveAccountSelectionMock,
	persistAccountPoolMock,
	syncSelectionToCodexMock,
	fetchAuthorizedAccountsMock,
	clearAccountsMock,
	clearCredentialSidecarsMock,
} = vi.hoisted(() => ({
	clearAccountsMock: vi.fn(),
	clearCredentialSidecarsMock: vi.fn(),
	chooseLoginWorkspaceMock: vi.fn(),
	loadAccountsMock: vi.fn(),
	getNamedBackupsMock: vi.fn(),
	promptAddAnotherAccountMock: vi.fn(),
	promptLoginModeMock: vi.fn(),
	isBrowserLaunchSuppressedMock: vi.fn(),
	runSignInFlowMock: vi.fn(),
	resolveAccountSelectionMock: vi.fn(),
	persistAccountPoolMock: vi.fn(),
	syncSelectionToCodexMock: vi.fn(),
	fetchAuthorizedAccountsMock: vi.fn(),
}));

vi.mock("../lib/codex-manager/login-workspace-choice.js", () => ({chooseLoginWorkspace:chooseLoginWorkspaceMock}));

vi.mock("../lib/auth/account-access.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../lib/auth/account-access.js")>();
	return { ...actual, fetchAuthorizedAccounts: fetchAuthorizedAccountsMock };
});

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		loadAccounts: loadAccountsMock,
		getNamedBackups: getNamedBackupsMock,
		setStoragePath: vi.fn(),
		clearAccounts: clearAccountsMock,
	};
});

vi.mock("../lib/storage/credential-sidecars.js", () => ({
	clearCredentialSidecars: clearCredentialSidecarsMock,
	clearAccountsAndCredentialSidecars: async (clearPool: () => Promise<void>) => {
		await clearPool();
		await clearCredentialSidecarsMock();
	},
}));

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

type PersistOutcome = "inserted" | "updated" | "rebound";

// persistAccountPool reports which row it wrote and whether that row owns the
// native ~/.codex/auth.json selection; the flow gates its sync on that.
function persistResult(
	overrides: Partial<{
		outcome: PersistOutcome;
		accountIndex: number;
		activeIndex: number;
		isActiveAccount: boolean;
		accountEnabled: boolean;
	}> = {},
) {
	return {
		outcome: "inserted" as PersistOutcome,
		accountIndex: 0,
		activeIndex: 0,
		isActiveAccount: true,
		accountEnabled: true,
		...overrides,
	};
}

// A plain login opts into none of the targeted-re-auth behaviour.
const PLAIN_PERSIST_OPTIONS = {
	preserveSelection: undefined,
	expectedAccount: undefined,
	expectedAccountIndex: undefined,
};

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
	chooseLoginWorkspaceMock.mockResolvedValue(undefined);
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
		return persistResult({
			accountIndex: (accountsOnDisk?.accounts.length ?? 1) - 1,
			activeIndex: (accountsOnDisk?.accounts.length ?? 1) - 1,
		});
	});
	syncSelectionToCodexMock.mockResolvedValue(undefined);
	fetchAuthorizedAccountsMock.mockResolvedValue(null);
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
	it("targeted re-auth of a non-active row preserves selection and skips the Codex sync", async () => {
		accountsOnDisk = storageWith(2);
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		persistAccountPoolMock.mockResolvedValue(
			persistResult({
				outcome: "updated",
				accountIndex: 1,
				activeIndex: 0,
				isActiveAccount: false,
			}),
		);

		expect(
			await runAuthLogin(
				["--account", "acc_a1", "--preserve-selection"],
				deps(),
			),
		).toBe(0);

		expect(promptLoginModeMock).not.toHaveBeenCalled();
		expect(runSignInFlowMock).toHaveBeenCalledExactlyOnceWith(true, "browser");
		expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith(
			[RESOLVED],
			false,
			{
				preserveSelection: true,
				expectedAccount: expect.objectContaining({ accountId: "acc_a1" }),
				// The position the target occupied when the flow resolved it, so
				// the transaction can stay deterministic across duplicate rows.
				expectedAccountIndex: 1,
			},
		);
		expect(syncSelectionToCodexMock).not.toHaveBeenCalled();
		expect(promptAddAnotherAccountMock).not.toHaveBeenCalled();
	});

	it("syncs Codex auth when the refreshed row is the active account", async () => {
		// Regression: gating the sync on --preserve-selection alone stranded the
		// native CLI on the expired tokens of the account just refreshed, and the
		// drift check never repaired it (it compares identity, not tokens).
		accountsOnDisk = storageWith(2);
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		persistAccountPoolMock.mockResolvedValue(
			persistResult({
				outcome: "updated",
				accountIndex: 0,
				activeIndex: 0,
				isActiveAccount: true,
			}),
		);

		expect(
			await runAuthLogin(["--account", "1", "--preserve-selection"], deps()),
		).toBe(0);

		expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith(
			[RESOLVED],
			false,
			{
				preserveSelection: true,
				expectedAccount: expect.objectContaining({ accountId: "acc_a0" }),
				expectedAccountIndex: 0,
			},
		);
		expect(syncSelectionToCodexMock).toHaveBeenCalledExactlyOnceWith(RESOLVED);
	});

	it("tells the user a refreshed account is still disabled", async () => {
		accountsOnDisk = storageWith(2);
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		persistAccountPoolMock.mockResolvedValue(
			persistResult({
				outcome: "updated",
				accountIndex: 1,
				activeIndex: 0,
				isActiveAccount: false,
				accountEnabled: false,
			}),
		);

		expect(await runAuthLogin(["--account", "2"], deps())).toBe(0);

		expect(loggedLines(logSpy).join("\n")).toContain(
			"Account 2 is still disabled",
		);
	});

	it("rejects --account combined with --org before starting a login", async () => {
		expect(
			await runAuthLogin(["--account", "2", "--org", "org_team"], deps()),
		).toBe(1);

		expect(loadAccountsMock).not.toHaveBeenCalled();
		expect(runSignInFlowMock).not.toHaveBeenCalled();
		expect(loggedLines(errorSpy).join("\n")).toContain(
			"Cannot combine --account with --org",
		);
	});

	it("refuses a missing targeted account before starting OAuth", async () => {
		accountsOnDisk = storageWith(1);

		expect(await runAuthLogin(["--account", "acc_missing"], deps())).toBe(1);

		expect(runSignInFlowMock).not.toHaveBeenCalled();
		expect(persistAccountPoolMock).not.toHaveBeenCalled();
		expect(loggedLines(errorSpy).join("\n")).toContain("missing or ambiguous");
	});

	it("reports a targeted identity mismatch without syncing selection", async () => {
		accountsOnDisk = storageWith(1);
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		persistAccountPoolMock.mockRejectedValue(
			new CodexValidationError("authenticated identity does not match"),
		);

		expect(await runAuthLogin(["--account", "acc_a0"], deps())).toBe(1);

		expect(syncSelectionToCodexMock).not.toHaveBeenCalled();
		expect(loggedLines(errorSpy).join("\n")).toContain(
			"Re-authentication failed",
		);
	});

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
		expect(chooseLoginWorkspaceMock).not.toHaveBeenCalled();
		expect(resolveAccountSelectionMock).toHaveBeenCalledExactlyOnceWith(
			TOKEN_SUCCESS,
			"org_team",
			undefined,
		);
		expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith(
			[RESOLVED],
			false,
			PLAIN_PERSIST_OPTIONS,
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
				return persistResult({ outcome });
			});

			expect(await runAuthLogin(["--manual"], deps())).toBe(0);
			expect(loggedLines(logSpy)).toContain(message);
		},
	);

	it("stops at the account cap without offering another sign-in", async () => {
		runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
		persistAccountPoolMock.mockImplementation(async () => {
			accountsOnDisk = storageWith(ACCOUNT_LIMITS.MAX_ACCOUNTS);
			return persistResult();
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


describe("workspace choice before account persistence",()=>{
 it("cancels without saving credentials or changing desktop auth",async()=>{
  runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
  chooseLoginWorkspaceMock.mockResolvedValue(null);
  expect(await runAuthLogin(["--manual"],deps())).toBe(0);
  expect(persistAccountPoolMock).not.toHaveBeenCalled();
  expect(syncSelectionToCodexMock).not.toHaveBeenCalled();
 });
 it("persists the explicitly chosen workspace",async()=>{
  runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
  chooseLoginWorkspaceMock.mockResolvedValue("selected-workspace");
  expect(await runAuthLogin(["--manual"],deps())).toBe(0);
  expect(resolveAccountSelectionMock).toHaveBeenCalledWith(TOKEN_SUCCESS,"selected-workspace",undefined);
  expect(persistAccountPoolMock).toHaveBeenCalledOnce();
 });
 it("rejects an invalid workspace selection before writing",async()=>{
  runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
  chooseLoginWorkspaceMock.mockRejectedValue(new CodexValidationError("Invalid workspace selection. Account was not saved."));
  expect(await runAuthLogin(["--manual"],deps())).toBe(1);
  expect(loggedLines(errorSpy)).toContain("Login failed: Invalid workspace selection. Account was not saved.");
  expect(persistAccountPoolMock).not.toHaveBeenCalled();
  expect(syncSelectionToCodexMock).not.toHaveBeenCalled();
 });
 it("persists the automatic choice when a noninteractive chooser defers",async()=>{
  runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
  // Noninteractive ambiguity warns and resolves undefined instead of throwing.
  chooseLoginWorkspaceMock.mockResolvedValue(undefined);
  expect(await runAuthLogin(["--manual"],deps())).toBe(0);
  expect(chooseLoginWorkspaceMock).toHaveBeenCalledOnce();
  expect(resolveAccountSelectionMock).toHaveBeenCalledWith(TOKEN_SUCCESS,undefined,undefined);
  expect(persistAccountPoolMock).toHaveBeenCalledOnce();
 });
});

// Codex CLI 0.156+ refuses a tokens.account_id missing from
// wham/accounts/check (issue #700), so the login checks the id first.
describe("runAuthLogin workspace authorization guard", () => {
	const AUTHORIZED = {
		accountIds: ["personal-id"],
		defaultAccountId: "personal-id",
	};
	const SIGNED_IN = { type: "success" as const, access: "access-token" };

	it.each([
		["an --org flag", ["--manual", "--org", "ws-team"]],
		["CODEX_AUTH_ACCOUNT_ID", ["--manual"]],
	])(
		"keeps an explicit binding from %s saved and records the authorized id for Codex CLI",
		async (_source, args) => {
			const manual = {
				...SIGNED_IN,
				accountIdOverride: "ws-team",
				accountIdSource: "manual" as const,
			};
			const saved = {
				...manual,
				codexCliMirror: { forAccountId: "ws-team", accountId: "personal-id" },
			};
			runSignInFlowMock.mockResolvedValue(SIGNED_IN);
			resolveAccountSelectionMock.mockReturnValue(manual);
			fetchAuthorizedAccountsMock.mockResolvedValue(AUTHORIZED);

			expect(await runAuthLogin(args, deps())).toBe(0);

			// The explicit id is saved as chosen, with the id every auth.json
			// writer uses in its place.
			expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith(
				[saved],
				false,
				PLAIN_PERSIST_OPTIONS,
			);
			expect(syncSelectionToCodexMock).toHaveBeenCalledExactlyOnceWith(saved);
			expect(loggedLines(warnSpy).join("\n")).toContain("not authorized");
		},
	);

	// A later login whose explicit id is authorized drops the saved mirror.
	it("clears a saved Codex CLI mirror when the explicit id is authorized", async () => {
		const manual = {
			...SIGNED_IN,
			accountIdOverride: "personal-id",
			accountIdSource: "manual" as const,
		};
		runSignInFlowMock.mockResolvedValue(SIGNED_IN);
		resolveAccountSelectionMock.mockReturnValue(manual);
		fetchAuthorizedAccountsMock.mockResolvedValue(AUTHORIZED);

		expect(await runAuthLogin(["--manual", "--org", "personal-id"], deps())).toBe(0);

		expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith(
			[{ ...manual, codexCliMirror: null }],
			false,
			PLAIN_PERSIST_OPTIONS,
		);
	});

	it("replaces an unauthorized automatic selection and says so without debug logging", async () => {
		runSignInFlowMock.mockResolvedValue(SIGNED_IN);
		resolveAccountSelectionMock.mockReturnValue({
			...SIGNED_IN,
			accountIdOverride: "org-team",
			accountIdSource: "org",
		});
		fetchAuthorizedAccountsMock.mockResolvedValue(AUTHORIZED);

		expect(await runAuthLogin(["--manual"], deps())).toBe(0);

		const rewritten = expect.objectContaining({
			accountIdOverride: "personal-id",
			accountIdSource: "token",
		});
		expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith(
			[rewritten],
			false,
			PLAIN_PERSIST_OPTIONS,
		);
		expect(syncSelectionToCodexMock).toHaveBeenCalledExactlyOnceWith(rewritten);
		expect(loggedLines(warnSpy).join("\n")).toContain("not authorized");
	});

	// A targeted re-auth is identity-checked by persistAccountPool, which would
	// reject a rewritten id, so it must skip the authorization check entirely.
	it("does not constrain a targeted re-authentication", async () => {
		accountsOnDisk = storageWith(2);
		runSignInFlowMock.mockResolvedValue(SIGNED_IN);
		const targeted = {
			...SIGNED_IN,
			accountIdOverride: "org-team",
			accountIdSource: "org" as const,
		};
		resolveAccountSelectionMock.mockReturnValue(targeted);
		fetchAuthorizedAccountsMock.mockResolvedValue(AUTHORIZED);
		persistAccountPoolMock.mockResolvedValue(
			persistResult({ outcome: "updated", accountIndex: 0, isActiveAccount: true }),
		);

		expect(await runAuthLogin(["--account", "1"], deps())).toBe(0);

		expect(fetchAuthorizedAccountsMock).not.toHaveBeenCalled();
		expect(persistAccountPoolMock).toHaveBeenCalledWith(
			[targeted],
			false,
			expect.anything(),
		);
		expect(syncSelectionToCodexMock).toHaveBeenCalledExactlyOnceWith(targeted);
	});
});

it("authorizes the chosen workspace after selection and preserves it when native CLI needs a mirror", async () => {
 const events: string[] = [];
 runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
 chooseLoginWorkspaceMock.mockImplementation(async () => {events.push("choose");return "selected-workspace";});
 resolveAccountSelectionMock.mockImplementation((token, override) => ({...token,accountIdOverride:override,accountIdSource:"manual"}));
 fetchAuthorizedAccountsMock.mockImplementation(async () => {events.push("authorize");return {accountIds:["native-default"],defaultAccountId:"native-default"};});
 expect(await runAuthLogin(["--manual"],deps())).toBe(0);
 expect(events).toEqual(["choose","authorize"]);
 const saved=expect.objectContaining({accountIdOverride:"selected-workspace",accountIdSource:"manual",codexCliMirror:{forAccountId:"selected-workspace",accountId:"native-default"}});
 expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith([saved],false,PLAIN_PERSIST_OPTIONS);
 expect(syncSelectionToCodexMock).toHaveBeenCalledExactlyOnceWith(saved);
});

it("does not discover workspace access when the workspace chooser is cancelled", async () => {
 runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
 chooseLoginWorkspaceMock.mockResolvedValue(null);
 expect(await runAuthLogin(["--manual"],deps())).toBe(0);
 expect(fetchAuthorizedAccountsMock).not.toHaveBeenCalled();
 expect(persistAccountPoolMock).not.toHaveBeenCalled();
});

it.each([undefined,"selected-workspace"])("preserves the native mirror when discovery cannot authorize the selected workspace (default=%s)",async defaultAccountId=>{
 const selected={...TOKEN_SUCCESS,accountIdOverride:"selected-workspace",accountIdSource:"manual",codexCliMirror:{forAccountId:"selected-workspace",accountId:"native-default"}};
 runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
 resolveAccountSelectionMock.mockReturnValue(selected);
 fetchAuthorizedAccountsMock.mockResolvedValue({accountIds:["native-default"],defaultAccountId});
 expect(await runAuthLogin(["--manual","--org","selected-workspace"],deps())).toBe(0);
 expect(persistAccountPoolMock).toHaveBeenCalledExactlyOnceWith([selected],false,PLAIN_PERSIST_OPTIONS);
 expect(syncSelectionToCodexMock).toHaveBeenCalledExactlyOnceWith(selected);
});

it("dashboard reset also removes stored API keys and runtime sidecars", async () => {
 accountsOnDisk = storageWith(1);
 clearAccountsMock.mockImplementation(async () => { accountsOnDisk = null; });
 clearCredentialSidecarsMock.mockResolvedValue(undefined);
 promptLoginModeMock.mockResolvedValueOnce({ mode: "fresh", deleteAll: true });
 expect(await runAuthLogin([], deps())).toBe(0);
 expect(clearAccountsMock).toHaveBeenCalledTimes(1);
 expect(clearCredentialSidecarsMock).toHaveBeenCalledTimes(1);
});

it("returns to the dashboard when the workspace picker is cancelled during add-account", async () => {
 accountsOnDisk = storageWith(1);
 promptLoginModeMock.mockResolvedValueOnce({ mode: "add" }).mockResolvedValueOnce({ mode: "cancel" });
 runSignInFlowMock.mockResolvedValue(TOKEN_SUCCESS);
 chooseLoginWorkspaceMock.mockResolvedValue(null);
 expect(await runAuthLogin([], deps())).toBe(0);
 expect(chooseLoginWorkspaceMock).toHaveBeenCalledOnce();
 // Back at the menu instead of leaving the CLI.
 expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
 expect(persistAccountPoolMock).not.toHaveBeenCalled();
});
