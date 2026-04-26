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
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			jsonResponse({
				device_auth_id: "device-auth-1",
				user_code: "ABCD-1234",
				interval: "7",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestDeviceAuthorization();

		expect(result).toEqual({
			type: "success",
			deviceCode: {
				verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
				userCode: "ABCD-1234",
				deviceAuthId: "device-auth-1",
				intervalMs: 7_000,
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
			reason: "unknown",
			message: "Device auth timed out after 15 minutes",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(sleepMock).toHaveBeenCalledTimes(2);
	});

	it("fails polling on hard non-pending responses", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("server unavailable", { status: 503 }));
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
			statusCode: 503,
			message: "server unavailable",
		});
	});

	it("exchanges the authorization code with the device redirect URI", async () => {
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

		const result = await runDeviceAuthFlow({ log: logMock });

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
		const tokenExchangeCall = fetchMock.mock.calls[2];
		expect(tokenExchangeCall?.[0]).toBe("https://auth.openai.com/oauth/token");
		const tokenExchangeBody = tokenExchangeCall?.[1]?.body;
		expect(tokenExchangeBody).toBeInstanceOf(URLSearchParams);
		const params = tokenExchangeBody as URLSearchParams;
		expect(params.get("code")).toBe("authorization-code");
		expect(params.get("code_verifier")).toBe("code-verifier");
		expect(params.get("redirect_uri")).toBe(DEVICE_AUTH_REDIRECT_URI);
	});
});
