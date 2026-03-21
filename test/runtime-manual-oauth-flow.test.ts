import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	exchangeAuthorizationCode: vi.fn(),
	resolveAccountSelection: vi.fn(),
}));

vi.mock("../lib/auth/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth/auth.js")>(
		"../lib/auth/auth.js",
	);
	return {
		...actual,
		exchangeAuthorizationCode: mocks.exchangeAuthorizationCode,
	};
});

vi.mock("../lib/runtime/account-selection.js", async () => {
	const actual = await vi.importActual<
		typeof import("../lib/runtime/account-selection.js")
	>("../lib/runtime/account-selection.js");
	return {
		...actual,
		resolveAccountSelection: mocks.resolveAccountSelection,
	};
});

import { REDIRECT_URI } from "../lib/auth/auth.js";
import { buildManualOAuthFlow } from "../lib/runtime/manual-oauth-flow.js";
import type { TokenSuccessWithAccount } from "../lib/runtime/account-selection.js";
import type { TokenResult } from "../lib/types.js";

describe("runtime manual oauth flow", () => {
	const pkce = { verifier: "pkce-verifier" };
	const expectedState = "state-123";

	beforeEach(() => {
		mocks.exchangeAuthorizationCode.mockReset();
		mocks.resolveAccountSelection.mockReset();
	});

	function createFlow(
		overrides: {
			onSuccess?: (tokens: TokenSuccessWithAccount) => Promise<void>;
			logInfo?: (message: string) => void;
		} = {},
	) {
		return buildManualOAuthFlow(pkce, "https://example.com/auth", expectedState, {
			instructions: "Paste the callback URL",
			logInfo: overrides.logInfo ?? vi.fn(),
			onSuccess: overrides.onSuccess,
		});
	}

	it("validates missing code, missing state, mismatched state, and query-string pastes", () => {
		const flow = createFlow();

		expect(
			flow.validate(
				`http://127.0.0.1:1455/auth/callback?state=${expectedState}`,
			),
		).toContain(
			"No authorization code found.",
		);
		expect(flow.validate("?code=abc123")).toBe(
			"Missing OAuth state. Paste the full callback URL including both code and state parameters.",
		);
		expect(flow.validate("?code=abc123&state=wrong-state")).toBe(
			"OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt.",
		);
		expect(flow.validate(`?code=abc123&state=${expectedState}`)).toBeUndefined();
	});

	it("returns invalid_response failures when callback input is malformed or mismatched", async () => {
		const flow = createFlow();

		await expect(flow.callback("?code=missing-state")).resolves.toEqual({
			type: "failed",
			reason: "invalid_response",
			message: "Missing authorization code or OAuth state",
		});
		await expect(flow.callback("?code=abc123&state=wrong-state")).resolves.toEqual(
			{
				type: "failed",
				reason: "invalid_response",
				message: "OAuth state mismatch. Restart login and try again.",
			},
		);
		expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
		expect(mocks.resolveAccountSelection).not.toHaveBeenCalled();
	});

	it("exchanges tokens, resolves account selection, and awaits onSuccess", async () => {
		const tokenResult: TokenResult = {
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		};
		const resolvedTokens: TokenSuccessWithAccount = {
			...tokenResult,
			accountIdOverride: "acct-123",
			accountIdSource: "token",
			accountLabel: "Primary workspace",
		};
		const order: string[] = [];

		mocks.exchangeAuthorizationCode.mockResolvedValue(tokenResult);
		mocks.resolveAccountSelection.mockImplementation((tokens: TokenResult) => {
			order.push("resolve");
			expect(tokens).toEqual(tokenResult);
			return resolvedTokens;
		});

		const flow = createFlow({
			onSuccess: async (tokens) => {
				order.push("onSuccess:start");
				expect(tokens).toEqual(resolvedTokens);
				await Promise.resolve();
				order.push("onSuccess:end");
			},
		});

		await expect(
			flow.callback(`?code=callback-code&state=${expectedState}`),
		).resolves.toEqual(resolvedTokens);
		expect(mocks.exchangeAuthorizationCode).toHaveBeenCalledWith(
			"callback-code",
			pkce.verifier,
			REDIRECT_URI,
		);
		expect(order).toEqual(["resolve", "onSuccess:start", "onSuccess:end"]);
	});

	it("returns explicit failed results from token exchange and falls back when it returns nothing", async () => {
		const failedResult: TokenResult = {
			type: "failed",
			reason: "http_error",
			message: "bad request",
			statusCode: 400,
		};
		const flow = createFlow();

		mocks.exchangeAuthorizationCode.mockResolvedValueOnce(failedResult);
		await expect(
			flow.callback(`?code=callback-code&state=${expectedState}`),
		).resolves.toEqual(failedResult);

		mocks.exchangeAuthorizationCode.mockResolvedValueOnce(undefined);
		await expect(
			flow.callback(`http://127.0.0.1:1455/auth/callback?code=callback-code&state=${expectedState}`),
		).resolves.toEqual({ type: "failed" });

		expect(mocks.resolveAccountSelection).not.toHaveBeenCalled();
	});
});
