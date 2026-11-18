/**
 * Pins the wiring between the OAuth callback server and the failure guidance
 * (issue #630). `describeCallbackFailure` and `startLocalOAuthServer` are each
 * covered on their own; this asserts the seam in `runOAuthFlow` that picks the
 * failure reason and forwards the bind error, which is what actually makes the
 * Windows/WSL conflict legible to the user.
 *
 * The manual/incognito regression below supplies a fake readline prompt so it
 * can exercise the same callback validation and exchange seam without a TTY.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { hooks } = vi.hoisted(() => ({
		hooks: {
			serverInfo: null as unknown,
			guidanceLines: [] as string[],
			manualInput: "",
			exchangeAuthorizationCode: vi.fn(),
			openBrowserUrl: true,
			copyTextToClipboard: true,
		},
	}));

vi.mock("node:process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:process")>();
	return {
		...actual,
		stdin: {
			isTTY: false,
			readableEnded: false,
			destroyed: false,
			once: vi.fn(),
			off: vi.fn(),
		},
		stdout: { isTTY: false },
	};
});

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: vi.fn(async () => hooks.manualInput),
		close: vi.fn(),
	})),
}));

vi.mock("../lib/auth/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/auth.js")>();
	return {
		...actual,
		createAuthorizationFlow: vi.fn(async () => ({
			pkce: { challenge: "challenge", verifier: "verifier" },
			state: "test-state",
			url:
				"https://auth.openai.com/oauth/authorize?state=test-state&code_challenge=challenge",
		})),
		exchangeAuthorizationCode: hooks.exchangeAuthorizationCode,
	};
});

vi.mock("../lib/auth/server.js", () => ({
	startLocalOAuthServer: vi.fn(async () => hooks.serverInfo),
}));

vi.mock("../lib/auth/browser.js", () => ({
	openBrowserUrl: vi.fn(() => hooks.openBrowserUrl),
	copyTextToClipboard: vi.fn(() => hooks.copyTextToClipboard),
	isBrowserLaunchSuppressed: vi.fn(() => false),
	getBrowserOpener: vi.fn(() => "xdg-open"),
}));

vi.mock("../lib/auth/callback-guidance.js", () => ({
	describeCallbackFailure: vi.fn(() => hooks.guidanceLines),
}));

const { describeCallbackFailure } = await import(
	"../lib/auth/callback-guidance.js"
);
const { runOAuthFlow } = await import("../lib/codex-manager/login-oauth.js");

const mockedGuidance = vi.mocked(describeCallbackFailure);

/** A callback server that bound cleanly but never received a redirect. */
function serverThatTimesOut() {
	return {
		port: 1455,
		ready: true,
		close: vi.fn(),
		waitForCode: vi.fn(async () => null),
	};
}

/** A callback server that could not take the port at all. */
function serverThatFailedToBind(bindErrorCode?: string) {
	return {
		port: 1455,
		ready: false,
		bindErrorCode,
		close: vi.fn(),
		waitForCode: vi.fn(async () => null),
	};
}

describe("runOAuthFlow callback-failure guidance", () => {
	let logged: string[];

	beforeEach(() => {
		vi.clearAllMocks();
		logged = [];
		hooks.guidanceLines = ["GUIDANCE LINE ONE", "", "GUIDANCE LINE TWO"];
		hooks.manualInput = "";
		hooks.exchangeAuthorizationCode.mockReset();
		hooks.openBrowserUrl = true;
		hooks.copyTextToClipboard = true;
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
	});

	it("reports bind-failed with the bind error when the port could not be taken", async () => {
		hooks.serverInfo = serverThatFailedToBind("EADDRINUSE");

		await runOAuthFlow(false, "browser");

		expect(mockedGuidance).toHaveBeenCalledWith("bind-failed", {
			bindErrorCode: "EADDRINUSE",
		});
	});

	it("reports callback-timeout when the server bound but no redirect arrived", async () => {
		// The Windows/WSL hijack: a clean bind, and nothing ever comes back.
		hooks.serverInfo = serverThatTimesOut();

		await runOAuthFlow(false, "browser");

		expect(mockedGuidance).toHaveBeenCalledWith("callback-timeout", {
			bindErrorCode: undefined,
		});
	});

	it("prints every guidance line, preserving blank separators", async () => {
		hooks.serverInfo = serverThatTimesOut();

		await runOAuthFlow(false, "browser");

		expect(logged).toEqual(
			expect.arrayContaining([
				expect.stringContaining("GUIDANCE LINE ONE"),
				expect.stringContaining("GUIDANCE LINE TWO"),
			]),
		);
		// Blank separators are emitted unstyled rather than dropped.
		expect(logged).toContain("");
	});

	it("prints the complete authorization URL for manual/incognito login", async () => {
		const authorizationUrl =
			"https://auth.openai.com/oauth/authorize?state=test-state&code_challenge=challenge";
		hooks.manualInput =
			"http://localhost:1455/auth/callback?code=callback-code&state=test-state";
		hooks.exchangeAuthorizationCode.mockResolvedValue({
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		await expect(runOAuthFlow(false, "manual")).resolves.toMatchObject({
			type: "success",
		});

		expect(logged.join("\n")).toContain(authorizationUrl);
		expect(logged.join("\n")).not.toContain("%3Credacted%3E");
		expect(hooks.exchangeAuthorizationCode).toHaveBeenCalledWith(
			"callback-code",
			"verifier",
			"http://localhost:1455/auth/callback",
		);
	});

	it("prints a usable URL when browser and clipboard fallbacks both fail", async () => {
		hooks.serverInfo = serverThatTimesOut();
		hooks.openBrowserUrl = false;
		hooks.copyTextToClipboard = false;

		await runOAuthFlow(false, "browser");

		expect(logged.join("\n")).toContain(
			"https://auth.openai.com/oauth/authorize?state=test-state&code_challenge=challenge",
		);
	});
});
