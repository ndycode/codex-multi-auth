import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEVICE_AUTH_REDIRECT_URI,
	DEVICE_AUTH_VERIFICATION_URL,
	pollDeviceAuthorization,
	requestDeviceAuthorization,
	runDeviceAuthFlow,
} from "../lib/auth/device-auth.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("device auth flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("requests a user code and parses user_code plus string interval", async () => {
		const nowMs = Date.parse("2026-04-26T00:00:00Z");
		const expiresAtMs = nowMs + 15 * 60 * 1000;
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			jsonResponse({
				device_auth_id: "device-auth-1",
				user_code: "ABCD-1234",
				interval: "7.5",
				expires_at: new Date(expiresAtMs).toISOString(),
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization({ now: () => nowMs });

		expect(result).toEqual({
			type: "success",
			deviceCode: {
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 7_500,
				expiresAtMs,
			},
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://auth.openai.com/api/accounts/deviceauth/usercode",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
				}),
			}),
		);
	});

	it("accepts the usercode alias and numeric interval", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			jsonResponse({
				device_auth_id: "device-auth-2",
				usercode: "WXYZ-9876",
				interval: 3,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization();

		expect(result).toEqual({
			type: "success",
			deviceCode: {
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "WXYZ-9876",
				deviceAuthId: "device-auth-2",
				intervalMs: 3_000,
			},
		});
	});

	it("returns a clear failure when the user-code endpoint is disabled", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("not found", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization();

		expect(result).toEqual({
			type: "failed",
			reason: "http_error",
			statusCode: 404,
			message:
				"Device auth login is not enabled for this Codex server. Use browser login or --manual.",
		});
	});

	it("returns a network failure when the user-code request rejects", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("connection reset"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization();

		expect(result).toEqual({
			type: "failed",
			reason: "network_error",
			message: "connection reset",
		});
	});

	it("does not request a user code when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization({
			signal: controller.signal,
		});

		expect(result).toEqual({
			type: "failed",
			reason: "network_error",
			message: "aborted",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails user-code requests on invalid success payloads", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			jsonResponse({
				user_code: "ABCD-1234",
				interval: "5",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization();

		expect(result).toEqual({
			type: "failed",
			reason: "invalid_response",
			message: "Device code request response failed schema validation",
		});
	});

	it("returns sanitized user-code request failures", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("server unavailable", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization();

		expect(result).toEqual({
			type: "failed",
			reason: "http_error",
			statusCode: 500,
			message: "server unavailable",
		});
	});

	it("treats 403 and 404 poll responses as pending before success", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("", { status: 403 }))
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(
				jsonResponse({
					authorization_code: "authorization-code",
					code_verifier: "code-verifier",
					code_challenge: "code-challenge",
				}),
			);
		const sleepMock = vi.fn(async () => undefined);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization(
			{
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 2_000,
			},
			{ sleep: sleepMock },
		);

		expect(result).toEqual({
			type: "success",
			completion: {
				authorizationCode: "authorization-code",
				codeVerifier: "code-verifier",
			},
		});
		expect(sleepMock).toHaveBeenCalledTimes(2);
		expect(sleepMock).toHaveBeenNthCalledWith(1, 2_000);
		expect(sleepMock).toHaveBeenNthCalledWith(2, 2_000);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://auth.openai.com/api/accounts/deviceauth/token",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					device_auth_id: "device-auth-1",
					user_code: "ABCD-1234",
				}),
			}),
		);
	});

	it("honors Retry-After seconds for 429 poll responses", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response("", {
					status: 429,
					headers: { "Retry-After": "7" },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					authorization_code: "authorization-code",
					code_verifier: "code-verifier",
				}),
			);
		const sleepMock = vi.fn(async () => undefined);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization(
			{
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 2_000,
			},
			{ sleep: sleepMock },
		);

		expect(result.type).toBe("success");
		expect(sleepMock).toHaveBeenCalledWith(7_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("honors Retry-After HTTP dates for transient poll responses", async () => {
		const nowMs = Date.parse("2026-04-26T00:00:00Z");
		const retryAt = new Date(nowMs + 4_000).toUTCString();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response("", {
					status: 503,
					headers: { "Retry-After": retryAt },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					authorization_code: "authorization-code",
					code_verifier: "code-verifier",
				}),
			);
		const sleepMock = vi.fn(async () => undefined);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization(
			{
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 2_000,
			},
			{ now: () => nowMs, sleep: sleepMock },
		);

		expect(result.type).toBe("success");
		expect(sleepMock).toHaveBeenCalledWith(4_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("falls back to jittered interval polling for 429 without Retry-After", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("", { status: 429 }))
			.mockResolvedValueOnce(
				jsonResponse({
					authorization_code: "authorization-code",
					code_verifier: "code-verifier",
				}),
			);
		const sleepMock = vi.fn(async () => undefined);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization(
			{
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 3_000,
			},
			{ random: () => 0.5, sleep: sleepMock },
		);

		expect(result.type).toBe("success");
		expect(sleepMock).toHaveBeenCalledWith(3_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("aborts polling without issuing another token request", async () => {
		const controller = new AbortController();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("", { status: 403 }));
		const sleepMock = vi.fn(() => new Promise<void>(() => {}));
		vi.stubGlobal("fetch", fetchMock);

		const resultPromise = pollDeviceAuthorization(
			{
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 5_000,
			},
			{
				signal: controller.signal,
				sleep: sleepMock,
				timeoutMs: 10_000,
			},
		);

		await vi.waitFor(() => expect(sleepMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		controller.abort();
		await expect(resultPromise).resolves.toEqual({
			type: "failed",
			reason: "network_error",
			message: "aborted",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses the server expiration as the polling deadline", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("", { status: 403 }));
		let nowMs = 0;
		const sleepMock = vi.fn(async (ms: number) => {
			nowMs += ms;
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization(
			{
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 5_000,
				expiresAtMs: 6_000,
			},
			{
				now: () => nowMs,
				sleep: sleepMock,
				timeoutMs: 15_000,
			},
		);

		expect(result).toEqual({
			type: "failed",
			reason: "timeout",
			message: "Device auth timed out after 6 seconds",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(sleepMock).toHaveBeenNthCalledWith(1, 5_000);
		expect(sleepMock).toHaveBeenNthCalledWith(2, 1_000);
	});

	it("times out polling after the configured wait budget", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("", { status: 403 }));
		let nowMs = 0;
		const sleepMock = vi.fn(async (ms: number) => {
			nowMs += ms;
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization(
			{
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 5_000,
			},
			{
				now: () => nowMs,
				sleep: sleepMock,
				timeoutMs: 10_000,
			},
		);

		expect(result).toEqual({
			type: "failed",
			reason: "timeout",
			message: "Device auth timed out after 10 seconds",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(sleepMock).toHaveBeenCalledTimes(2);
	});

	it("fails polling on hard non-pending responses", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization({
			verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
			userCode: "ABCD-1234",
			deviceAuthId: "device-auth-1",
			intervalMs: 5_000,
		});

		expect(result).toEqual({
			type: "failed",
			reason: "http_error",
			statusCode: 400,
			message: "bad request",
		});
	});

	it("fails polling on invalid completion payloads", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ authorization_code: "missing-verifier" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollDeviceAuthorization({
			verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
			userCode: "ABCD-1234",
			deviceAuthId: "device-auth-1",
			intervalMs: 5_000,
		});

		expect(result).toEqual({
			type: "failed",
			reason: "invalid_response",
			message: "Device auth token response failed schema validation",
		});
	});

	it("exchanges the authorization code with the device redirect URI", async () => {
		const nowMs = Date.parse("2026-04-26T00:00:00Z");
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					device_auth_id: "device-auth-1",
					user_code: "ABCD-1234",
					interval: "1",
					expires_in: "600",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					authorization_code: "authorization-code",
					code_verifier: "code-verifier",
					code_challenge: "code-challenge",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					id_token: "id-token",
				}),
			);
		const logMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await runDeviceAuthFlow({
			log: logMock,
			now: () => nowMs,
		});

		expect(result).toEqual({
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: expect.any(Number),
			idToken: "id-token",
			multiAccount: true,
		});
		expect(logMock).toHaveBeenCalledWith("Device auth login");
		expect(logMock).toHaveBeenCalledWith(`Open: ${DEVICE_AUTH_VERIFICATION_URL}`);
		expect(logMock).toHaveBeenCalledWith("Code: ABCD-1234");
		expect(logMock).toHaveBeenCalledWith(
			"This code expires in 10 minutes. Never share it.",
		);
		const renderedLogs = logMock.mock.calls.flat().map((entry) => String(entry));
		expect(renderedLogs.join("\n")).not.toMatch(
			/access-token|refresh-token|id-token|code-verifier|code_verifier|user@example\.com/,
		);
		const tokenExchangeCall = fetchMock.mock.calls[2];
		expect(tokenExchangeCall?.[0]).toBe("https://auth.openai.com/oauth/token");
		const tokenExchangeBody = tokenExchangeCall?.[1]?.body;
		expect(tokenExchangeBody).toBeInstanceOf(URLSearchParams);
		const params = tokenExchangeBody as URLSearchParams;
		expect(params.get("grant_type")).toBe("authorization_code");
		expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(params.get("code")).toBe("authorization-code");
		expect(params.get("code_verifier")).toBe("code-verifier");
		expect(params.get("redirect_uri")).toBe(DEVICE_AUTH_REDIRECT_URI);
	});

	it("does not print or poll when aborted after the user-code response", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
			controller.abort();
			return jsonResponse({
				device_auth_id: "device-auth-1",
				user_code: "ABCD-1234",
				interval: "1",
			});
		});
		const logMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await runDeviceAuthFlow({
			log: logMock,
			signal: controller.signal,
		});

		expect(result).toEqual({
			type: "failed",
			reason: "network_error",
			message: "aborted",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(logMock).not.toHaveBeenCalled();
	});

	it("does not leak tokens or email strings through device auth logs on timeout", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					device_auth_id: "device-auth-1",
					user_code: "ABCD-1234",
					interval: "1",
				}),
			)
			.mockResolvedValue(new Response("", { status: 403 }));
		let nowMs = 0;
		const sleepMock = vi.fn(async (ms: number) => {
			nowMs += ms;
		});
		const logMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await runDeviceAuthFlow({
			log: logMock,
			now: () => nowMs,
			sleep: sleepMock,
			timeoutMs: 2_000,
		});

		expect(result).toEqual({
			type: "failed",
			reason: "timeout",
			message: "Device auth timed out after 2 seconds",
		});
		const renderedLogs = logMock.mock.calls.flat().map((entry) => String(entry));
		expect(renderedLogs.join("\n")).not.toMatch(
			/access-token|refresh-token|id-token|code-verifier|code_verifier|user@example\.com/,
		);
	});

	it("returns token exchange failures from the device auth flow", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					device_auth_id: "device-auth-1",
					user_code: "ABCD-1234",
					interval: "1",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					authorization_code: "authorization-code",
					code_verifier: "code-verifier",
				}),
			)
			.mockResolvedValueOnce(new Response("bad token", { status: 400 }));
		const logMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await runDeviceAuthFlow({ log: logMock });

		expect(result).toEqual({
			type: "failed",
			reason: "http_error",
			statusCode: 400,
			message: "bad token",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const renderedLogs = logMock.mock.calls.flat().map((entry) => String(entry));
		expect(renderedLogs.join("\n")).not.toMatch(
			/access-token|refresh-token|id-token|code-verifier|code_verifier|user@example\.com/,
		);
	});
});
