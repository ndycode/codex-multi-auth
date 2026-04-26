import type { TokenResult } from "../types.js";
import {
	CLIENT_ID,
	exchangeAuthorizationCode,
	sanitizeOAuthResponseBodyForLog,
} from "./auth.js";

export const DEVICE_AUTH_BASE_URL = "https://auth.openai.com";
export const DEVICE_AUTH_API_BASE_URL = `${DEVICE_AUTH_BASE_URL}/api/accounts`;
export const DEVICE_AUTH_VERIFICATION_URL = `${DEVICE_AUTH_BASE_URL}/codex/device`;
export const DEVICE_AUTH_REDIRECT_URI = `${DEVICE_AUTH_BASE_URL}/deviceauth/callback`;
export const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
export const DEVICE_AUTH_DEFAULT_INTERVAL_MS = 5_000;

type FetchLike = typeof fetch;

export interface DeviceAuthCode {
	verificationUrl: string;
	userCode: string;
	deviceAuthId: string;
	intervalMs: number;
}

export interface DeviceAuthCompletion {
	authorizationCode: string;
	codeVerifier: string;
}

export type DeviceAuthCodeResult =
	| { type: "success"; deviceCode: DeviceAuthCode }
	| Extract<TokenResult, { type: "failed" }>;

export type DeviceAuthCompletionResult =
	| { type: "success"; completion: DeviceAuthCompletion }
	| Extract<TokenResult, { type: "failed" }>;

export interface DeviceAuthFlowOptions {
	fetchImpl?: FetchLike;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	log?: (message: string) => void;
}

function getFetch(options: DeviceAuthFlowOptions): FetchLike {
	return options.fetchImpl ?? fetch;
}

function getNow(options: DeviceAuthFlowOptions): () => number {
	return options.now ?? Date.now;
}

function getSleep(options: DeviceAuthFlowOptions): (ms: number) => Promise<void> {
	return (
		options.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			}))
	);
}

function failedResult(
	reason: Extract<TokenResult, { type: "failed" }>["reason"],
	message: string,
	statusCode?: number,
): Extract<TokenResult, { type: "failed" }> {
	return {
		type: "failed",
		reason,
		statusCode,
		message,
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown> | null> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return null;
	}
	try {
		return asRecord(JSON.parse(text) as unknown);
	} catch {
		return null;
	}
}

function parseIntervalMs(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.trunc(value * 1000);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed * 1000;
		}
	}
	return DEVICE_AUTH_DEFAULT_INTERVAL_MS;
}

function parseNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseDeviceCodePayload(payload: Record<string, unknown>): DeviceAuthCode | null {
	const deviceAuthId = parseNonEmptyString(payload.device_auth_id);
	const userCode =
		parseNonEmptyString(payload.user_code) ??
		parseNonEmptyString(payload.usercode);
	if (!deviceAuthId || !userCode) {
		return null;
	}
	return {
		verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
		userCode,
		deviceAuthId,
		intervalMs: parseIntervalMs(payload.interval),
	};
}

function parseCompletionPayload(
	payload: Record<string, unknown>,
): DeviceAuthCompletion | null {
	const authorizationCode = parseNonEmptyString(payload.authorization_code);
	const codeVerifier = parseNonEmptyString(payload.code_verifier);
	if (!authorizationCode || !codeVerifier) {
		return null;
	}
	return { authorizationCode, codeVerifier };
}

async function readFailureText(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	return sanitizeOAuthResponseBodyForLog(text);
}

export async function requestDeviceAuthorization(
	options: DeviceAuthFlowOptions = {},
): Promise<DeviceAuthCodeResult> {
	try {
		const response = await getFetch(options)(
			`${DEVICE_AUTH_API_BASE_URL}/deviceauth/usercode`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ client_id: CLIENT_ID }),
			},
		);
		if (!response.ok) {
			const safeText = await readFailureText(response);
			if (response.status === 404) {
				return failedResult(
					"http_error",
					"Device auth login is not enabled for this Codex server. Use browser login or --manual.",
					response.status,
				);
			}
			return failedResult(
				"http_error",
				safeText || `Device code request failed with status ${response.status}`,
				response.status,
			);
		}

		const payload = await readJsonRecord(response);
		const deviceCode = payload ? parseDeviceCodePayload(payload) : null;
		if (!deviceCode) {
			return failedResult(
				"invalid_response",
				"Device code request response failed schema validation",
			);
		}
		return { type: "success", deviceCode };
	} catch (error) {
		return failedResult(
			"network_error",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function printDeviceAuthorizationPrompt(
	deviceCode: DeviceAuthCode,
	log: (message: string) => void = console.log,
): void {
	log("Device auth login");
	log(`Open: ${deviceCode.verificationUrl}`);
	log(`Code: ${deviceCode.userCode}`);
	log("This code expires in 15 minutes. Never share it.");
}

export async function pollDeviceAuthorization(
	deviceCode: DeviceAuthCode,
	options: DeviceAuthFlowOptions = {},
): Promise<DeviceAuthCompletionResult> {
	const now = getNow(options);
	const sleep = getSleep(options);
	const timeoutMs = options.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
	const deadline = now() + timeoutMs;

	try {
		while (true) {
			const response = await getFetch(options)(
				`${DEVICE_AUTH_API_BASE_URL}/deviceauth/token`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						device_auth_id: deviceCode.deviceAuthId,
						user_code: deviceCode.userCode,
					}),
				},
			);

			if (response.ok) {
				const payload = await readJsonRecord(response);
				const completion = payload ? parseCompletionPayload(payload) : null;
				if (!completion) {
					return failedResult(
						"invalid_response",
						"Device auth token response failed schema validation",
					);
				}
				return { type: "success", completion };
			}

			if (response.status === 403 || response.status === 404) {
				const remainingMs = deadline - now();
				if (remainingMs <= 0) {
					return failedResult(
						"unknown",
						"Device auth timed out after 15 minutes",
					);
				}
				await sleep(Math.min(deviceCode.intervalMs, remainingMs));
				continue;
			}

			const safeText = await readFailureText(response);
			return failedResult(
				"http_error",
				safeText || `Device auth failed with status ${response.status}`,
				response.status,
			);
		}
	} catch (error) {
		return failedResult(
			"network_error",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function runDeviceAuthFlow(
	options: DeviceAuthFlowOptions = {},
): Promise<TokenResult> {
	const deviceCodeResult = await requestDeviceAuthorization(options);
	if (deviceCodeResult.type !== "success") {
		return deviceCodeResult;
	}

	printDeviceAuthorizationPrompt(
		deviceCodeResult.deviceCode,
		options.log ?? console.log,
	);

	const completionResult = await pollDeviceAuthorization(
		deviceCodeResult.deviceCode,
		options,
	);
	if (completionResult.type !== "success") {
		return completionResult;
	}

	return exchangeAuthorizationCode(
		completionResult.completion.authorizationCode,
		completionResult.completion.codeVerifier,
		DEVICE_AUTH_REDIRECT_URI,
	);
}
