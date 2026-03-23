import { describe, expect, it, vi } from "vitest";
import { runBrowserOAuthFlow } from "../lib/runtime/browser-oauth-flow.js";

describe("browser OAuth flow helper", () => {
	it("returns failed when local server cannot start", async () => {
		const result = await runBrowserOAuthFlow({
			forceNewLogin: true,
			createAuthorizationFlow: async () => ({
				pkce: { verifier: "verifier" },
				state: "state",
				url: "https://example.com/oauth",
			}),
			logInfo: vi.fn(),
			redactOAuthUrlForLog: (url) => url,
			startLocalOAuthServer: async () => {
				throw new Error("no server");
			},
			logDebug: vi.fn(),
			openBrowserUrl: vi.fn(),
			pluginName: "plugin",
			authManualLabel: "manual",
			logWarn: vi.fn(),
			exchangeAuthorizationCode: vi.fn(),
			redirectUri: "http://127.0.0.1:1455/auth/callback",
		});

		expect(result).toEqual({ type: "failed" });
	});

	it("returns timeout-style failure when no auth code is received", async () => {
		const result = await runBrowserOAuthFlow({
			createAuthorizationFlow: async () => ({
				pkce: { verifier: "verifier" },
				state: "state",
				url: "https://example.com/oauth",
			}),
			logInfo: vi.fn(),
			redactOAuthUrlForLog: (url) => url,
			startLocalOAuthServer: async () => ({
				ready: true,
				close: vi.fn(),
				waitForCode: async () => null,
			}),
			logDebug: vi.fn(),
			openBrowserUrl: vi.fn(),
			pluginName: "plugin",
			authManualLabel: "manual",
			logWarn: vi.fn(),
			exchangeAuthorizationCode: vi.fn(),
			redirectUri: "http://127.0.0.1:1455/auth/callback",
		});

		expect(result).toEqual({
			type: "failed",
			reason: "unknown",
			message: "OAuth callback timeout or cancelled",
		});
	});

	it("exchanges authorization code when callback succeeds", async () => {
		const exchangeAuthorizationCode = vi.fn(async () => ({
			type: "success" as const,
			access: "access",
			refresh: "refresh",
			expires: 1,
		}));

		const result = await runBrowserOAuthFlow({
			createAuthorizationFlow: async () => ({
				pkce: { verifier: "verifier" },
				state: "state",
				url: "https://example.com/oauth",
			}),
			logInfo: vi.fn(),
			redactOAuthUrlForLog: (url) => url,
			startLocalOAuthServer: async () => ({
				ready: true,
				close: vi.fn(),
				waitForCode: async () => ({ code: "auth-code" }),
			}),
			logDebug: vi.fn(),
			openBrowserUrl: vi.fn(),
			pluginName: "plugin",
			authManualLabel: "manual",
			logWarn: vi.fn(),
			exchangeAuthorizationCode,
			redirectUri: "http://127.0.0.1:1455/auth/callback",
		});

		expect(exchangeAuthorizationCode).toHaveBeenCalledWith(
			"auth-code",
			"verifier",
			"http://127.0.0.1:1455/auth/callback",
		);
		expect(result).toEqual({
			type: "success",
			access: "access",
			refresh: "refresh",
			expires: 1,
		});
	});
});
