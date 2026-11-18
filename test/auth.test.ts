import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
	createState,
	parseAuthorizationInput,
	decodeJWT,
	createAuthorizationFlow,
	redactOAuthUrlForLog,
	refreshAccessToken,
	exchangeAuthorizationCode,
	sanitizeOAuthResponseBodyForLog,
	CLIENT_ID,
	AUTHORIZE_URL,
	REDIRECT_URI,
	SCOPE,
} from "../lib/auth/auth.js";
import * as loggerModule from "../lib/logger.js";

describe("Auth Module", () => {
	describe("createState", () => {
		it("should generate a random 32-character hex string", () => {
			const state = createState();
			expect(state).toMatch(/^[a-f0-9]{32}$/);
		});

		it("should generate unique states", () => {
			const state1 = createState();
			const state2 = createState();
			expect(state1).not.toBe(state2);
		});
	});

	describe("parseAuthorizationInput", () => {
		it("should parse full OAuth callback URL", () => {
			const input =
				"http://127.0.0.1:1455/auth/callback?code=abc123&state=xyz789";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: "xyz789" });
		});

		it("should parse localhost callback URL for backward compatibility", () => {
			const input =
				"http://localhost:1455/auth/callback?code=abc123&state=xyz789";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: "xyz789" });
		});

		it("should parse code#state format", () => {
			const input = "abc123#xyz789";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: "xyz789" });
		});

		it("should parse query string format", () => {
			const input = "code=abc123&state=xyz789";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: "xyz789" });
		});

		it("should parse query string with code= only (no state param)", () => {
			const input = "code=abc123";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: undefined });
		});

		it("should parse URL with fragment parameters (#code=...)", () => {
			const input =
				"http://127.0.0.1:1455/auth/callback#code=abc123&state=xyz789";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: "xyz789" });
		});

		it("should prefer query params over hash params when both exist", () => {
			const input =
				"http://127.0.0.1:1455/auth/callback?code=querycode&state=querystate#code=hashcode&state=hashstate";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "querycode", state: "querystate" });
		});

		it("should fallback to hash for missing state in query", () => {
			const input =
				"http://127.0.0.1:1455/auth/callback?code=querycode#state=hashstate";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "querycode", state: "hashstate" });
		});

		it("should fallback to hash for missing code in query", () => {
			const input =
				"http://127.0.0.1:1455/auth/callback?state=querystate#code=hashcode";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "hashcode", state: "querystate" });
		});

		it("should handle URL with hash but without # prefix", () => {
			const input = "http://127.0.0.1:1455/auth/callback#code=abc123";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: undefined });
		});

		it("should return code and state when only state is in hash (line 44 coverage)", () => {
			const input =
				"http://127.0.0.1:1455/auth/callback?code=querycode#state=hashstate";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "querycode", state: "hashstate" });
		});

		it("should return state only when only state is in hash and no code (line 44 coverage)", () => {
			const input = "http://127.0.0.1:1455/auth/callback#state=hashstate";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: undefined, state: "hashstate" });
		});

		it("should parse code only", () => {
			const input = "abc123";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123" });
		});

		it("should parse code= query string without state (line 58 state undefined branch)", () => {
			const input = "code=abc123";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: "abc123", state: undefined });
		});

		it("should return empty object for empty input", () => {
			const result = parseAuthorizationInput("");
			expect(result).toEqual({});
		});

		it("should handle whitespace", () => {
			const result = parseAuthorizationInput("  ");
			expect(result).toEqual({});
		});

		it("should fall through to # split when valid URL has hash with no code/state params (line 44 false branch)", () => {
			// URL parses successfully but hash contains no code= or state= params
			// Line 44's false branch is hit (code && state both undefined)
			// Falls through to line 51 which splits on #
			const input = "http://127.0.0.1:1455/auth/callback#invalid";
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({
				code: "http://127.0.0.1:1455/auth/callback",
				state: "invalid",
			});
		});
	});

	describe("decodeJWT", () => {
		it("should decode valid JWT token", () => {
			// Create a simple JWT token: header.payload.signature
			const header = Buffer.from(
				JSON.stringify({ alg: "HS256", typ: "JWT" }),
			).toString("base64");
			const payload = Buffer.from(
				JSON.stringify({ sub: "1234567890", name: "Test User" }),
			).toString("base64");
			const signature = "fake-signature";
			const token = `${header}.${payload}.${signature}`;

			const decoded = decodeJWT(token);
			expect(decoded).toEqual({ sub: "1234567890", name: "Test User" });
		});

		it("should decode JWT with ChatGPT account info", () => {
			const payload = Buffer.from(
				JSON.stringify({
					"https://api.openai.com/auth": {
						chatgpt_account_id: "account-123",
					},
				}),
			).toString("base64");
			const token = `header.${payload}.signature`;

			const decoded = decodeJWT(token);
			expect(decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id).toBe(
				"account-123",
			);
		});

		it("should decode base64url JWT payloads", () => {
			const payload = Buffer.from(
				JSON.stringify({ sub: "1234567890", name: "Test User" }),
				"utf8",
			).toString("base64url");
			const token = `header.${payload}.signature`;

			const decoded = decodeJWT(token);
			expect(decoded).toEqual({ sub: "1234567890", name: "Test User" });
		});

		it("should return null for invalid JWT", () => {
			const result = decodeJWT("invalid-token");
			expect(result).toBeNull();
		});

		it("should return null for malformed JWT", () => {
			const result = decodeJWT("header.payload");
			expect(result).toBeNull();
		});

		it("should return null for non-JSON payload", () => {
			const token = "header.not-json.signature";
			const result = decodeJWT(token);
			expect(result).toBeNull();
		});
	});

	describe("createAuthorizationFlow", () => {
		it("should create authorization flow with PKCE", async () => {
			const flow = await createAuthorizationFlow();

			expect(flow).toHaveProperty("pkce");
			expect(flow).toHaveProperty("state");
			expect(flow).toHaveProperty("url");

			expect(flow.pkce).toHaveProperty("challenge");
			expect(flow.pkce).toHaveProperty("verifier");
			expect(flow.pkce.verifier.length).toBeGreaterThanOrEqual(43);
			expect(flow.pkce.verifier.length).toBeLessThanOrEqual(128);
			expect(flow.pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(flow.pkce.challenge).toBe(
				createHash("sha256")
					.update(flow.pkce.verifier)
					.digest("base64url"),
			);
			expect(flow.state).toMatch(/^[a-f0-9]{32}$/);
		});

		it("should generate URL with correct parameters", async () => {
			const flow = await createAuthorizationFlow();
			const url = new URL(flow.url);

			expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
			expect(url.searchParams.get("response_type")).toBe("code");
			expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
			expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
			expect(url.searchParams.get("scope")).toBe(SCOPE);
			expect(url.searchParams.get("code_challenge_method")).toBe("S256");
			expect(url.searchParams.get("code_challenge")).toBe(flow.pkce.challenge);
			expect(url.searchParams.get("state")).toBe(flow.state);
			expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
			expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
			expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
			expect(url.searchParams.has("prompt")).toBe(false);
		});

		it("should include prompt=login when forceNewLogin is true", async () => {
			const flow = await createAuthorizationFlow({ forceNewLogin: true });
			const url = new URL(flow.url);
			expect(url.searchParams.get("prompt")).toBe("login");
		});

		it("should generate unique flows", async () => {
			const flow1 = await createAuthorizationFlow();
			const flow2 = await createAuthorizationFlow();

			expect(flow1.state).not.toBe(flow2.state);
			expect(flow1.pkce.verifier).not.toBe(flow2.pkce.verifier);
			expect(flow1.url).not.toBe(flow2.url);
		});
	});

	describe("AUTH_REDIRECT", () => {
		it("derives its fields from REDIRECT_URI without drift", async () => {
			const { AUTH_REDIRECT } = await import("../lib/auth/auth.js");
			const parsed = new URL(REDIRECT_URI);
			expect(AUTH_REDIRECT.host).toBe(parsed.hostname);
			expect(AUTH_REDIRECT.path).toBe(parsed.pathname);
			expect(AUTH_REDIRECT.url).toBe(REDIRECT_URI);
			expect(AUTH_REDIRECT.port).toBe(
				parsed.port.length > 0 ? Number(parsed.port) : 1455,
			);
			expect(AUTH_REDIRECT.origin).toBe(`${parsed.protocol}//${parsed.host}`);
		});

		it("is frozen and cannot be mutated", async () => {
			const { AUTH_REDIRECT } = await import("../lib/auth/auth.js");
			expect(Object.isFrozen(AUTH_REDIRECT)).toBe(true);
		});

		it("locks the callback port at 1455 so REDIRECT_URI and the bound port never diverge", async () => {
			const { AUTH_REDIRECT } = await import("../lib/auth/auth.js");
			// The OpenAI app registration pins this exact callback. If anyone
			// changes REDIRECT_URI without updating the registration, login breaks;
			// this assertion fails loudly before that ships.
			expect(AUTH_REDIRECT.port).toBe(1455);
			expect(AUTH_REDIRECT.path).toBe("/auth/callback");
		});
	});

	describe("redactOAuthUrlForLog", () => {
		it("redacts sensitive oauth params in URLs", () => {
			const raw =
				"https://auth.openai.com/oauth/authorize?state=abc123&code=xyz&code_challenge=foo&response_type=code";
			const redacted = redactOAuthUrlForLog(raw);
			expect(redacted).not.toContain("abc123");
			expect(redacted).not.toContain("xyz");
			expect(redacted).not.toContain("foo");
			expect(redacted).toContain("state=%3Credacted%3E");
			expect(redacted).toContain("code=%3Credacted%3E");
			expect(redacted).toContain("code_challenge=%3Credacted%3E");
			expect(redacted).toContain("response_type=code");
		});

		it("collapses unparseable input to a placeholder so raw text never logs", () => {
			const raw = "not-a-url code=secretvalue123&state=abc";
			expect(redactOAuthUrlForLog(raw)).toBe("<unparseable-url>");
		});

		it("redacts query keys case-insensitively", () => {
			const raw = "https://x/cb?CODE=SecretCode123&State=St8Val&ok=1";
			const out = redactOAuthUrlForLog(raw);
			expect(out).not.toContain("SecretCode123");
			expect(out).not.toContain("St8Val");
			expect(out).toContain("ok=1");
		});

		it("redacts sensitive params in the fragment", () => {
			const raw =
				"https://x/cb#access_token=AT_ch_abcdefghijklmnopqrstuvwx&state=s9&ok=1";
			const out = redactOAuthUrlForLog(raw);
			expect(out).not.toContain("AT_ch_abcdefghijklmnopqrstuvwx");
			expect(out).not.toContain("state=s9");
			expect(out).toContain("ok=1");
		});

		it("redacts params in nested URL values", () => {
			const inner = "https://inner/cb?code=InnerSecret99&ok=1";
			const raw = `https://x/cb?redirect_uri=${encodeURIComponent(inner)}&state=outer`;
			const out = redactOAuthUrlForLog(raw);
			expect(out).not.toContain("InnerSecret99");
			expect(out).not.toContain("state=outer");
		});

		it("masks userinfo credentials", () => {
			const out = redactOAuthUrlForLog(
				"https://user:p%40ssw0rd@auth.example.com/oauth?x=1",
			);
			expect(out).not.toContain("p%40ssw0rd");
			expect(out).not.toContain("user:");
		});

		it("scrubs token-shaped values in the path", () => {
			const out = redactOAuthUrlForLog(
				"https://x/cb/RT_ch_abcdefghijklmnopqrstuvwxyz0123456789/end",
			);
			expect(out).not.toContain("RT_ch_abcdefghijklmnopqrstuvwxyz0123456789");
		});

		it("scrubs a sensitive key=value prefix inside a route-style fragment", () => {
			// The fragment "route" prefix sits before the `?` and is not part of
			// the parsed frag params — `code` must still be scrubbed there.
			const out = redactOAuthUrlForLog("https://x/cb#code=secret99?ok=1");
			expect(out).not.toContain("secret99");
			expect(out).toContain("ok=1");
		});

		it("scrubs token-shaped values in fragment route paths", () => {
			const token = "RT_ch_abcdefghijklmnopqrstuvwxyz0123";
			const out = redactOAuthUrlForLog(`https://x/cb#/r/${token}/x?ok=1`);
			expect(out).not.toContain(token);
			expect(out).toContain("ok=1");
		});

		it("scrubs embedded secrets in non-sensitive top-level query values", () => {
			const out = redactOAuthUrlForLog(
				"https://x/cb?msg=refresh_token%3Dsekret12345&ok=1",
			);
			expect(out).not.toContain("sekret12345");
			expect(out).toContain("ok=1");
		});

		it("scrubs bearer tokens inside non-sensitive query values", () => {
			const out = redactOAuthUrlForLog(
				"https://x/cb?error_description=Bearer%20abc123def456&ok=1",
			);
			expect(out).not.toContain("abc123def456");
			expect(out).toContain("Bearer+***REDACTED***");
		});

		it("scrubs non-sensitive values inside nested URLs at depth 0", () => {
			const inner = "https://inner/cb?msg=code%3Dsecval99&ok=1";
			const raw = `https://x/cb?redirect_uri=${encodeURIComponent(inner)}`;
			const out = redactOAuthUrlForLog(raw);
			expect(out).not.toContain("secval99");
		});

		it("does not over-redact non-sensitive query values", () => {
			const raw =
				"https://x/cb?ok=1&error_code=E429&device_code=E429x&client_id=app_EMoamEEZ73f0CkXaXp7hrann&response_type=code";
			const out = redactOAuthUrlForLog(raw);
			expect(out).toContain("error_code=E429");
			expect(out).toContain("device_code=E429x");
			expect(out).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
			expect(out).toContain("response_type=code");
		});

		it("masks token-shaped hostname labels", () => {
			const out = redactOAuthUrlForLog(
				"https://RT_ch_abcdefghijklmnopqrstuvwxyz0123456789.evil.com/cb?ok=1",
			);
			expect(out.toLowerCase()).not.toContain(
				"rt_ch_abcdefghijklmnopqrstuvwxyz0123456789",
			);
		});

		it("redacts credential-like and compound-suffix query keys", () => {
			const out = redactOAuthUrlForLog(
				"https://x/cb?api_key=keyval99&authorization=authz99&assertion=assert99&client_assertion=cass99&id_token_hint=hint99&secret=secval99&x-api-key=xkey99&x-refresh-token=xrt99&x-client-secret=xcs99&ok=1",
			);
			for (const leaked of [
				"keyval99",
				"authz99",
				"assert99",
				"cass99",
				"hint99",
				"secval99",
				"xkey99",
				"xrt99",
				"xcs99",
			]) {
				expect(out).not.toContain(leaked);
			}
			expect(out).toContain("ok=1");
		});

		it("keeps lookalike query keys unredacted", () => {
			const out = redactOAuthUrlForLog(
				"https://x/cb?token_type=Bearer&session_state=sess99&csrf_token=csrftok99&nonce=nonce99&api_keys=aks99&secret_hint=shint99&x-session-state=xss99&error_code=E429&ok=1",
			);
			for (const kept of [
				"token_type=Bearer",
				"session_state=sess99",
				"csrf_token=csrftok99",
				"nonce=nonce99",
				"api_keys=aks99",
				"secret_hint=shint99",
				"x-session-state=xss99",
				"error_code=E429",
				"ok=1",
			]) {
				expect(out).toContain(kept);
			}
		});

		it("scrubs secrets hidden in a fully percent-encoded fragment", () => {
			// #code%3D... encodes the `=` so the raw hash hides the param shape.
			const out = redactOAuthUrlForLog("https://x/cb#code%3Dsecval99&ok=1");
			expect(out).not.toContain("secval99");
			expect(out).toContain("ok=1");
		});

		it("scrubs double-encoded secrets inside non-sensitive query values", () => {
			const out = redactOAuthUrlForLog(
				"https://x/cb?msg=code%253Dsecval99&ok=1",
			);
			expect(out).not.toContain("secval99");
			expect(out).toContain("ok=1");
		});
	});

	describe("exchangeAuthorizationCode", () => {
		it("returns success with tokens on valid response", async () => {
			vi.spyOn(Date, "now").mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "access-123",
							refresh_token: "refresh-456",
							expires_in: 3600,
							id_token: "id-token-789",
						}),
						{ status: 200 },
					),
			) as never;

			try {
				const result = await exchangeAuthorizationCode(
					"auth-code",
					"verifier-123",
				);
				expect(result).toEqual({
					type: "success",
					access: "access-123",
					refresh: "refresh-456",
					expires: 3_601_000,
					idToken: "id-token-789",
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it("returns failed when refresh token is missing", async () => {
			vi.spyOn(Date, "now").mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "access-123",
							expires_in: 3600,
						}),
						{ status: 200 },
					),
			) as never;

			try {
				const result = await exchangeAuthorizationCode(
					"auth-code",
					"verifier-123",
				);
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("invalid_response");
					expect(result.message).toContain("Missing refresh token");
				}
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it("returns failed when refresh token is whitespace only", async () => {
			vi.spyOn(Date, "now").mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "access-123",
							refresh_token: "   ",
							expires_in: 3600,
						}),
						{ status: 200 },
					),
			) as never;

			try {
				const result = await exchangeAuthorizationCode(
					"auth-code",
					"verifier-123",
				);
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("invalid_response");
					expect(result.message).toContain("Missing refresh token");
				}
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it("returns failed for HTTP error response", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () => new Response("Bad Request", { status: 400 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode("bad-code", "verifier");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("http_error");
					expect(result.statusCode).toBe(400);
					expect(result.message).toBe("Bad Request");
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns failed with undefined message when text read fails", async () => {
			const originalFetch = globalThis.fetch;
			const mockResponse = {
				ok: false,
				status: 500,
				text: vi.fn().mockRejectedValue(new Error("Read failed")),
			};
			globalThis.fetch = vi.fn(async () => mockResponse) as never;

			try {
				const result = await exchangeAuthorizationCode("code", "verifier");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("http_error");
					expect(result.statusCode).toBe(500);
					expect(result.message).toBeUndefined();
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns failed for invalid response schema", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ wrong: "schema" }), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode("code", "verifier");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("invalid_response");
					expect(result.message).toBe("Response failed schema validation");
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("uses custom redirect URI when provided", async () => {
			const originalFetch = globalThis.fetch;
			let capturedBody: URLSearchParams | undefined;
			globalThis.fetch = vi.fn(async (_url, init) => {
				capturedBody = init?.body as URLSearchParams;
				return new Response(
					JSON.stringify({
						access_token: "access",
						expires_in: 3600,
					}),
					{ status: 200 },
				);
			}) as never;

			try {
				await exchangeAuthorizationCode(
					"code",
					"verifier",
					"http://custom:8080/callback",
				);
				expect(capturedBody?.get("redirect_uri")).toBe(
					"http://custom:8080/callback",
				);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe("refreshAccessToken", () => {
		it("keeps existing refresh token when missing in response", async () => {
			vi.spyOn(Date, "now").mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({ access_token: "new-access", expires_in: 60 }),
						{
							status: 200,
						},
					),
			) as never;

			try {
				const result = await refreshAccessToken("existing-refresh");
				expect(result).toEqual({
					type: "success",
					access: "new-access",
					refresh: "existing-refresh",
					expires: 61_000,
					idToken: undefined,
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it("returns failed for HTTP 400 invalid_grant", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "invalid_grant" }), {
						status: 400,
					}),
			) as never;

			try {
				const result = await refreshAccessToken("bad-token");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("http_error");
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns failed for invalid response schema", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ wrong: "schema" }), { status: 200 }),
			) as never;

			try {
				const result = await refreshAccessToken("some-token");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("invalid_response");
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns failed for network errors", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () => {
				throw new Error("Network failed");
			}) as never;

			try {
				const result = await refreshAccessToken("some-token");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("network_error");
					expect(result.message).toBe("Network failed");
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns non-network failure for aborted refresh requests", async () => {
			const originalFetch = globalThis.fetch;
			const abortError = Object.assign(new Error("Request aborted"), {
				name: "AbortError",
			});
			globalThis.fetch = vi.fn(async () => {
				throw abortError;
			}) as never;

			try {
				const controller = new AbortController();
				controller.abort(abortError);
				const result = await refreshAccessToken("some-token", {
					signal: controller.signal,
				});
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("unknown");
					expect(result.message).toBe("Request aborted");
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns failed when response refresh token is whitespace only", async () => {
			const originalFetch = globalThis.fetch;
			const logErrorSpy = vi
				.spyOn(loggerModule, "logError")
				.mockImplementation(() => {});
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "new-access",
							refresh_token: "   ",
							expires_in: 60,
						}),
						{ status: 200 },
					),
			) as never;

			try {
				const result = await refreshAccessToken("existing-refresh");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("missing_refresh");
					expect(result.message).toBe("No refresh token in response or input");
				}
				expect(logErrorSpy).toHaveBeenCalledWith(
					"Token refresh missing refresh token",
				);
				expect(logErrorSpy.mock.calls[0]).toEqual([
					"Token refresh missing refresh token",
				]);
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it("returns failed when input refresh token is whitespace only and response omits refresh token", async () => {
			const originalFetch = globalThis.fetch;
			const logErrorSpy = vi
				.spyOn(loggerModule, "logError")
				.mockImplementation(() => {});
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "new-access",
							expires_in: 60,
						}),
						{ status: 200 },
					),
			) as never;

			try {
				const result = await refreshAccessToken("   ");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("missing_refresh");
					expect(result.message).toBe("No refresh token in response or input");
				}
				expect(logErrorSpy).toHaveBeenCalledWith(
					"Token refresh missing refresh token",
				);
				expect(logErrorSpy.mock.calls[0]).toEqual([
					"Token refresh missing refresh token",
				]);
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it("returns failed when both response and input have no refresh token", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "new-access",
							expires_in: 60,
							// no refresh_token in response
						}),
						{ status: 200 },
					),
			) as never;

			try {
				// Pass empty string as refresh token to trigger missing_refresh branch
				const result = await refreshAccessToken("");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("missing_refresh");
					expect(result.message).toBe("No refresh token in response or input");
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns http_error with undefined message when response text is empty", async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () => new Response("", { status: 500 }),
			) as never;

			try {
				const result = await refreshAccessToken("some-token");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.reason).toBe("http_error");
					expect(result.statusCode).toBe(500);
					expect(result.message).toBeUndefined();
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("returns success with new refresh token from response", async () => {
			vi.spyOn(Date, "now").mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "new-access",
							refresh_token: "new-refresh",
							expires_in: 60,
							id_token: "new-id-token",
						}),
						{ status: 200 },
					),
			) as never;

			try {
				const result = await refreshAccessToken("old-refresh");
				expect(result).toEqual({
					type: "success",
					access: "new-access",
					refresh: "new-refresh",
					expires: 61_000,
					idToken: "new-id-token",
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});
	});

	describe("sanitizeOAuthResponseBodyForLog (LIB-HIGH-001 regression)", () => {
		const OPAQUE_REFRESH =
			"RT_ch_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789";
		const OPAQUE_ACCESS =
			"AT_ch_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

		it("masks refresh_token and access_token in JSON error body", () => {
			const body = JSON.stringify({
				error: "invalid_grant",
				error_description: "bad refresh",
				refresh_token: OPAQUE_REFRESH,
				access_token: OPAQUE_ACCESS,
				id_token: "some.id.token",
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).not.toContain(OPAQUE_ACCESS);
			expect(out).toContain("***REDACTED***");
			expect(out).toContain("invalid_grant");
		});

		it("masks nested sensitive fields in JSON body", () => {
			const body = JSON.stringify({
				error: "invalid_grant",
				debug: { refresh_token: OPAQUE_REFRESH, reason: "x" },
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).toContain("invalid_grant");
			expect(out).toContain("x");
		});

		it("masks urlencoded refresh_token=value form", () => {
			const body = `error=invalid_grant&refresh_token=${OPAQUE_REFRESH}&other=safe`;
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).toContain("refresh_token=***REDACTED***");
			expect(out).toContain("other=safe");
		});

		it("does not over-redact longer parameter names ending in _code", () => {
			const body = `error=invalid_grant&device_code=device-safe&refresh_token=${OPAQUE_REFRESH}&other=safe`;
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).toContain("device_code=device-safe");
			expect(out).toContain("refresh_token=***REDACTED***");
			expect(out).toContain("other=safe");
		});

		it("masks refresh_token in malformed JSON via regex fallback", () => {
			const body = `{"error":"invalid_grant","refresh_token":"${OPAQUE_REFRESH}",`;
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).toContain('"refresh_token":"***REDACTED***"');
		});

		it("returns non-token plain text unchanged", () => {
			expect(sanitizeOAuthResponseBodyForLog("Bad Request")).toBe(
				"Bad Request",
			);
			expect(sanitizeOAuthResponseBodyForLog("")).toBe("");
		});

		it("preserves structure and non-sensitive JSON fields", () => {
			const body = JSON.stringify({
				error: "invalid_grant",
				status: 400,
				refresh_token: OPAQUE_REFRESH,
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			const parsed = JSON.parse(out) as Record<string, unknown>;
			expect(parsed.error).toBe("invalid_grant");
			expect(parsed.status).toBe(400);
			expect(parsed.refresh_token).toBe("***REDACTED***");
		});

		it("masks camelCase variants (refreshToken / accessToken)", () => {
			const body = JSON.stringify({
				refreshToken: OPAQUE_REFRESH,
				accessToken: OPAQUE_ACCESS,
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).not.toContain(OPAQUE_ACCESS);
		});

		it("masks codeVerifier camelCase variant", () => {
			const body = JSON.stringify({
				codeVerifier: OPAQUE_REFRESH,
				status: 400,
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).toContain("***REDACTED***");
			expect(out).toContain("400");
		});

		it("scrubs token-like substrings inside parsed JSON string values", () => {
			const body = JSON.stringify({
				error_description: `refresh failed for token ${OPAQUE_REFRESH}`,
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).toContain("***REDACTED***");
		});

		it("masks keys case-insensitively in JSON bodies", () => {
			const body = JSON.stringify({
				REFRESH_TOKEN: OPAQUE_REFRESH,
				State: "statevalue123",
				CODE: "authcode456",
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain(OPAQUE_REFRESH);
			expect(out).not.toContain("statevalue123");
			expect(out).not.toContain("authcode456");
		});

		it("masks device-flow secrets (device_auth_id, user_code, authorization_code)", () => {
			const body = JSON.stringify({
				device_auth_id: "dvid_secret_123456",
				user_code: "ABCD-EFGH",
				authorization_code: "authz_code_secret",
				interval: 5,
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain("dvid_secret_123456");
			expect(out).not.toContain("ABCD-EFGH");
			expect(out).not.toContain("authz_code_secret");
			expect(out).toContain('"interval":5');
		});

		it("masks code_challenge and client_secret", () => {
			const body = JSON.stringify({
				code_challenge: "challenge_value_xyz",
				client_secret: "clientsec12345",
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain("challenge_value_xyz");
			expect(out).not.toContain("clientsec12345");
		});

		it("scrubs secrets embedded in error_description free text", () => {
			const body = JSON.stringify({
				error: "invalid_grant",
				error_description:
					"failed: code=emb3dd3dc0de and state=emb3dd3dst4te retry",
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain("emb3dd3dc0de");
			expect(out).not.toContain("emb3dd3dst4te");
			expect(out).toContain("invalid_grant");
		});

		it("scrubs Bearer tokens embedded in string fields", () => {
			const body = JSON.stringify({
				error_description:
					"use Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef here",
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
			expect(out).toContain("Bearer ***REDACTED***");
		});

		it("scrubs device-flow secrets in urlencoded fallback text", () => {
			const body =
				"error=slow_down&device_auth_id=dvid777&user_code=WXYZ-1234&next=ok";
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain("dvid777");
			expect(out).not.toContain("WXYZ-1234");
			expect(out).toContain("next=ok");
		});

		it("does not over-redact error_code or csrf_token in urlencoded text", () => {
			const body = "error_code=E429&csrf_token=csrfval123&state=stval456";
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).toContain("error_code=E429");
			expect(out).toContain("csrf_token=csrfval123");
			expect(out).not.toContain("stval456");
		});

		it("masks separator-varied sensitive keys in malformed JSON", () => {
			// The fallback used to match literal key spellings only, so a
			// `client-secret`/`client secret` spelling slipped through.
			for (const body of [
				`{"client-secret":"short123"`,
				`{"client secret":"short123"`,
				`{"CLIENT-SECRET":"short123"`,
				`{'client-secret':'short123'}`,
				`{"ACCESS TOKEN":"tok12345"`,
			]) {
				const out = sanitizeOAuthResponseBodyForLog(body);
				expect(out).not.toContain("short123");
				expect(out).not.toContain("tok12345");
				expect(out).toContain("***REDACTED***");
			}
		});

		it("masks short values on separator-varied keys in malformed JSON", () => {
			const out = sanitizeOAuthResponseBodyForLog(`{"client-secret":"ab"`);
			expect(out).not.toContain('"ab"');
			expect(out).toContain("***REDACTED***");
		});

		it("scrubs percent-encoded separators in fallback text", () => {
			for (const [body, secret] of [
				["state%3Dst8val123", "st8val123"],
				["access%20token=tok12345", "tok12345"],
				["msg=refresh_token%3Dsekret12345", "sekret12345"],
			] as const) {
				const out = sanitizeOAuthResponseBodyForLog(body);
				expect(out).not.toContain(secret);
				expect(out).toContain("***REDACTED***");
			}
		});

		it("does not leave a bearer token stranded behind a key=value prefix", () => {
			// The key-shaped pass consumed the literal word "Bearer" as its
			// value, leaving the JWT behind it intact; Bearer must run first.
			const body =
				"access-token: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart";
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
			expect(out).not.toContain("sigpart");
		});

		it("does not over-redact lookalike keys in malformed JSON", () => {
			const out = sanitizeOAuthResponseBodyForLog(
				`{"error_code":"E500","opcode":"x9"`,
			);
			expect(out).toContain('"error_code":"E500"');
			expect(out).toContain('"opcode":"x9"');
		});

		it("survives a 10 MB token-charset body without leaking a raw run", () => {
			// Regression: an uncapped value quantifier overflowed the regex
			// backtrack stack (RangeError) on megabyte-scale homogeneous input.
			const body = "a".repeat(10_000_000);
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).not.toMatch(/[A-Za-z0-9_-]{32}/);
		});

		it("survives a 10 MB token-charset value inside a JSON field", () => {
			const body = JSON.stringify({
				error: "server_error",
				payload: "a".repeat(10_000_000),
			});
			const out = sanitizeOAuthResponseBodyForLog(body);
			expect(out).toContain("server_error");
			expect(out).not.toMatch(/[A-Za-z0-9_-]{32}/);
		});

		it("masks credential-like keys in parsed JSON bodies", () => {
			const out = sanitizeOAuthResponseBodyForLog(
				JSON.stringify({
					api_key: "keyval9999",
					authorization: "authz9999",
					assertion: "assert9999",
					client_assertion: "cass9999",
					secret: "secval9999",
					id_token_hint: "hint9999",
					error_code: "E500",
				}),
			);
			for (const leaked of [
				"keyval9999",
				"authz9999",
				"assert9999",
				"cass9999",
				"secval9999",
				"hint9999",
			]) {
				expect(out).not.toContain(leaked);
			}
			expect(out).toContain("E500");
		});

		it("masks compound credential keys and a token smuggled as a key name", () => {
			const smuggledToken = "RT_ch_abcdefghijklmnopqrstuvwxyz0123456789";
			const out = sanitizeOAuthResponseBodyForLog(
				JSON.stringify({
					"x-api-key": "xkey99999",
					"x-refresh-token": "xrt99999",
					"x-client-secret": "xcs99999",
					[smuggledToken]: "value",
					token_type: "Bearer",
					session_state: "sess9999",
				}),
			);
			expect(out).not.toContain("xkey99999");
			expect(out).not.toContain("xrt99999");
			expect(out).not.toContain("xcs99999");
			expect(out).not.toContain(smuggledToken);
			expect(out).toContain('"token_type":"Bearer"');
			expect(out).toContain("sess9999");
		});

		it("keeps __proto__ as ordinary data in parsed JSON", () => {
			const out = sanitizeOAuthResponseBodyForLog(
				`{"__proto__":{"token":"tokval999"},"ok":"v"}`,
			);
			expect(out).toContain("__proto__");
			expect(out).not.toContain("tokval999");
			expect(out).toContain('"ok":"v"');
		});

		it("masks credential-like keys and double-encoded separators in fallback text", () => {
			for (const [body, leaked] of [
				["api-key: kval99999", "kval99999"],
				["credentials=cred99999", "cred99999"],
				["assertion: assert99999", "assert99999"],
				[`{"CODE":"upper99999"`, "upper99999"],
				["code%253Dsecval999", "secval999"],
			] as const) {
				const out = sanitizeOAuthResponseBodyForLog(body);
				expect(out).not.toContain(leaked);
				expect(out).toContain("***REDACTED***");
			}
		});
	});

	describe("refreshAccessToken does not leak tokens into log message (LIB-HIGH-001)", () => {
		const OPAQUE_REFRESH =
			"RT_ch_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789";
		const OPAQUE_NEW_REFRESH =
			"RT_ch_NEW_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn";

		it("scrubs refresh_token from logError when refresh fails with JSON body", async () => {
			const logErrorSpy = vi
				.spyOn(loggerModule, "logError")
				.mockImplementation(() => {});
			const originalFetch = globalThis.fetch;
			const errorBody = JSON.stringify({
				error: "invalid_grant",
				error_description: "refresh_token expired",
				refresh_token: OPAQUE_NEW_REFRESH,
			});
			globalThis.fetch = vi.fn(
				async () =>
					new Response(errorBody, {
						status: 400,
					}),
			) as never;

			try {
				const result = await refreshAccessToken(OPAQUE_REFRESH);
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.statusCode).toBe(400);
					expect(result.message).toBeDefined();
					expect(result.message).not.toContain(OPAQUE_NEW_REFRESH);
				}
				const loggedArgs = logErrorSpy.mock.calls.flat().map(String);
				for (const entry of loggedArgs) {
					expect(entry).not.toContain(OPAQUE_NEW_REFRESH);
				}
			} finally {
				globalThis.fetch = originalFetch;
				logErrorSpy.mockRestore();
			}
		});

		it("scrubs access_token from logError when code->token exchange fails with JSON body", async () => {
			const logErrorSpy = vi
				.spyOn(loggerModule, "logError")
				.mockImplementation(() => {});
			const OPAQUE_ACCESS =
				"AT_ch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
			const originalFetch = globalThis.fetch;
			const errorBody = JSON.stringify({
				error: "server_error",
				access_token: OPAQUE_ACCESS,
			});
			globalThis.fetch = vi.fn(
				async () =>
					new Response(errorBody, {
						status: 500,
					}),
			) as never;

			try {
				const result = await exchangeAuthorizationCode("code", "verifier");
				expect(result.type).toBe("failed");
				if (result.type === "failed") {
					expect(result.statusCode).toBe(500);
					expect(result.message).toBeDefined();
					expect(result.message).not.toContain(OPAQUE_ACCESS);
				}
				const loggedArgs = logErrorSpy.mock.calls.flat().map(String);
				for (const entry of loggedArgs) {
					expect(entry).not.toContain(OPAQUE_ACCESS);
				}
			} finally {
				globalThis.fetch = originalFetch;
				logErrorSpy.mockRestore();
			}
		});

		it("preserves non-sensitive body content in log message", async () => {
			const logErrorSpy = vi
				.spyOn(loggerModule, "logError")
				.mockImplementation(() => {});
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: "invalid_grant",
							error_description: "token expired",
						}),
						{ status: 400 },
					),
			) as never;

			try {
				await refreshAccessToken("some-token");
				const loggedArgs = logErrorSpy.mock.calls.flat().map(String);
				const joined = loggedArgs.join(" ");
				expect(joined).toContain("invalid_grant");
				expect(joined).toContain("token expired");
			} finally {
				globalThis.fetch = originalFetch;
				logErrorSpy.mockRestore();
			}
		});
	});
});
