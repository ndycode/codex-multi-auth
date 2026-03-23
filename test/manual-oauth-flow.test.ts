import { describe, expect, it, vi } from "vitest";
import { buildManualOAuthFlow } from "../lib/runtime/manual-oauth-flow.js";

describe("manual OAuth flow helper", () => {
	it("validates missing code, missing state, and state mismatch", () => {
		const flow = buildManualOAuthFlow({
			pkce: { verifier: "verifier" },
			url: "https://example.com/oauth",
			expectedState: "expected",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			parseAuthorizationInput: (input) =>
				JSON.parse(input) as { code?: string; state?: string },
			exchangeAuthorizationCode: vi.fn(),
			resolveTokenSuccess: (tokens) => tokens,
			instructions: "manual",
		});

		expect(flow.validate(JSON.stringify({ state: "expected" }))).toContain(
			"No authorization code found",
		);
		expect(flow.validate(JSON.stringify({ code: "abc" }))).toContain(
			"Missing OAuth state",
		);
		expect(
			flow.validate(JSON.stringify({ code: "abc", state: "wrong" })),
		).toContain("OAuth state mismatch");
	});

	it("returns failed result for invalid callback payloads", async () => {
		const flow = buildManualOAuthFlow({
			pkce: { verifier: "verifier" },
			url: "https://example.com/oauth",
			expectedState: "expected",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			parseAuthorizationInput: (input) =>
				JSON.parse(input) as { code?: string; state?: string },
			exchangeAuthorizationCode: vi.fn(),
			resolveTokenSuccess: (tokens) => tokens,
			instructions: "manual",
		});

		await expect(
			flow.callback(JSON.stringify({ code: "abc" })),
		).resolves.toEqual({
			type: "failed",
			reason: "invalid_response",
			message: "Missing authorization code or OAuth state",
		});
	});

	it("exchanges code and resolves successful tokens", async () => {
		const onSuccess = vi.fn(async () => undefined);
		const flow = buildManualOAuthFlow({
			pkce: { verifier: "verifier" },
			url: "https://example.com/oauth",
			expectedState: "expected",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			parseAuthorizationInput: (input) =>
				JSON.parse(input) as { code?: string; state?: string },
			exchangeAuthorizationCode: vi.fn(async () => ({
				type: "success" as const,
				access: "access",
				refresh: "refresh",
				expires: 1,
			})),
			resolveTokenSuccess: (tokens) => ({
				...tokens,
				accountLabel: "Resolved",
			}),
			onSuccess,
			instructions: "manual",
		});

		const result = await flow.callback(
			JSON.stringify({ code: "abc", state: "expected" }),
		);

		expect(result).toEqual({
			type: "success",
			access: "access",
			refresh: "refresh",
			expires: 1,
			accountLabel: "Resolved",
		});
		expect(onSuccess).toHaveBeenCalled();
	});
});
