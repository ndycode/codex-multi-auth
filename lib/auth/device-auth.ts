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
const DEVICE_AUTH_ABORTED_MESSAGE = "aborted";
const DEVICE_AUTH_TRANSIENT_PENDING_STATUSES = new Set([
	408,
	429,
	502,
	503,
	504,
]);

type FetchLike = typeof fetch;

export interface DeviceAuthCode {
	verificationUrl: string;
	userCode: string;
	deviceAuthId: string;
	intervalMs: number;
	expiresAtMs?: number;
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
	signal?: AbortSignal;
	timeoutMs?: number;
	log?: (message: string) => void;
	random?: () => number;
}

function getFetch(options: DeviceAuthFlowOptions): FetchLike {
	return options.fetchImpl ?? fetch;
}

function getNow(options: DeviceAuthFlowOptions): () => number {
	return options.now ?? Date.now;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	(timer as { unref?: () => void }).unref?.();
}

function getSleep(options: DeviceAuthFlowOptions): (ms: number) => Promise<void> {
	return (
		options.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, ms);
				unrefTimer(timeout);
			}))
	);
}

function getRandom(options: DeviceAuthFlowOptions): () => number {
	return options.random ?? Math.random;
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

function createAbortError(): Error {
	const error = new Error(DEVICE_AUTH_ABORTED_MESSAGE);
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortedResult(): Extract<TokenResult, { type: "failed" }> {
	return failedResult("network_error", DEVICE_AUTH_ABORTED_MESSAGE);
}

function sleepWithAbort(
	ms: number,
	options: DeviceAuthFlowOptions,
): Promise<void> {
	const signal = options.signal;
	if (!signal) {
		return getSleep(options)(ms);
	}
	if (signal.aborted) {
		return Promise.reject(createAbortError());
	}

	const customSleep = options.sleep;
	if (customSleep) {
		let removeAbortListener = () => {};
		const abortPromise = new Promise<void>((_resolve, reject) => {
			const onAbort = () => reject(createAbortError());
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		});
		return Promise.race([customSleep(ms), abortPromise]).finally(
			removeAbortListener,
		);
	}

	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(createAbortError());
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		unrefTimer(timeout);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function formatWaitBudget(timeoutMs: number): string {
	const totalSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
	}
	const totalMinutes = Math.ceil(totalSeconds / 60);
	return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
}

function isPendingStatus(status: number): boolean {
	return (
		status === 403 ||
		status === 404 ||
		DEVICE_AUTH_TRANSIENT_PENDING_STATUSES.has(status)
	);
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.ceil(seconds * 1000);
	}

	const dateMs = Date.parse(trimmed);
	if (Number.isFinite(dateMs)) {
		return Math.max(0, dateMs - nowMs);
	}
	return null;
}

function applyLightJitter(
	delayMs: number,
	options: DeviceAuthFlowOptions,
): number {
	const jitterRatio = 1 + (getRandom(options)() - 0.5) * 0.2;
	return Math.max(1_000, Math.round(delayMs * jitterRatio));
}

function resolvePollDelayMs(
	response: Response,
	deviceCode: DeviceAuthCode,
	nowMs: number,
	options: DeviceAuthFlowOptions,
): number {
	const retryAfterMs = parseRetryAfterMs(
		response.headers.get("retry-after"),
		nowMs,
	);
	if (retryAfterMs !== null) {
		return Math.max(1_000, retryAfterMs);
	}
	if (response.status === 403 || response.status === 404) {
		return deviceCode.intervalMs;
	}
	return applyLightJitter(deviceCode.intervalMs, options);
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
		const parsed = Number.parseFloat(value.trim());
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.trunc(parsed * 1000);
		}
	}
	return DEVICE_AUTH_DEFAULT_INTERVAL_MS;
}

function parseAbsoluteExpirationMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		// Unix epoch in seconds if < 10^10, otherwise already in ms
		return value < 10_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
			const n = Number.parseFloat(trimmed);
			return n < 10_000_000_000 ? n * 1000 : n;
		}
		const dateMs = Date.parse(trimmed);
		if (Number.isFinite(dateMs)) return dateMs;
	}
	return null;
}

function parseExpirationMs(value: unknown, nowMs: number): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return nowMs + Math.trunc(value * 1000);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
			const seconds = Number.parseFloat(trimmed);
			return nowMs + Math.trunc(seconds * 1000);
		}
		const dateMs = Date.parse(trimmed);
		if (Number.isFinite(dateMs)) {
			return dateMs;
		}
	}
	return null;
}

function parseNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseDeviceCodePayload(
	payload: Record<string, unknown>,
	nowMs: number,
): DeviceAuthCode | null {
	const deviceAuthId = parseNonEmptyString(payload.device_auth_id);
	const userCode =
		parseNonEmptyString(payload.user_code) ??
		parseNonEmptyString(payload.usercode);
	if (!deviceAuthId || !userCode) {
		return null;
	}
	const expiresAtMs =
		parseAbsoluteExpirationMs(payload.expires_at) ??
		parseExpirationMs(payload.expires_in, nowMs);
	return {
		verificationUrl: DEVICE_AUTH_VERIFICATION_URL,
		userCode,
		deviceAuthId,
		intervalMs: parseIntervalMs(payload.interval),
		...(expiresAtMs === null ? {} : { expiresAtMs }),
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
	// OpenAI Codex's device-code endpoint intentionally returns the PKCE
	// verifier with the issued authorization code. This mirrors the upstream
	// Codex CLI flow. The verifier is never persisted to account storage; keep
	// this poll response out of logs and only hand it directly to the token
	// exchange.
	return { authorizationCode, codeVerifier };
}

async function readFailureText(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	return sanitizeOAuthResponseBodyForLog(text);
}

export async function requestDeviceAuthorization(
	options: DeviceAuthFlowOptions = {},
): Promise<DeviceAuthCodeResult> {
	if (options.signal?.aborted) {
		return abortedResult();
	}
	try {
		const response = await getFetch(options)(
			`${DEVICE_AUTH_API_BASE_URL}/deviceauth/usercode`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: options.signal,
				body: JSON.stringify({ client_id: CLIENT_ID }),
			},
		);
		if (!response.ok) {
			if (response.status === 404) {
				return failedResult(
					"http_error",
					"Device auth login is not enabled for this Codex server. Use browser login or --manual.",
					response.status,
				);
			}
			const safeText = await readFailureText(response);
			return failedResult(
				"http_error",
				safeText || `Device code request failed with status ${response.status}`,
				response.status,
			);
		}

		const payload = await readJsonRecord(response);
		const deviceCode = payload
			? parseDeviceCodePayload(payload, getNow(options)())
			: null;
		if (!deviceCode) {
			return failedResult(
				"invalid_response",
				"Device code request response failed schema validation",
			);
		}
		return { type: "success", deviceCode };
	} catch (error) {
		if (isAbortError(error) || options.signal?.aborted) {
			return abortedResult();
		}
		return failedResult(
			"network_error",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function printDeviceAuthorizationPrompt(
	deviceCode: DeviceAuthCode,
	log: (message: string) => void = console.log,
	timeoutMs = DEVICE_AUTH_TIMEOUT_MS,
	nowMs = Date.now(),
): void {
	const effectiveTimeoutMs =
		deviceCode.expiresAtMs === undefined
			? timeoutMs
			: Math.min(timeoutMs, Math.max(0, deviceCode.expiresAtMs - nowMs));
	log("Device auth login");
	log(`Open: ${deviceCode.verificationUrl}`);
	log(`Code: ${deviceCode.userCode}`);
	log(
		`This code expires in ${formatWaitBudget(effectiveTimeoutMs)}. Never share it.`,
	);
}

export async function pollDeviceAuthorization(
	deviceCode: DeviceAuthCode,
	options: DeviceAuthFlowOptions = {},
): Promise<DeviceAuthCompletionResult> {
	const now = getNow(options);
	const startMs = now();
	const timeoutMs = options.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
	const deadline = Math.min(
		startMs + timeoutMs,
		deviceCode.expiresAtMs ?? Number.POSITIVE_INFINITY,
	);
	const effectiveTimeoutMs = Math.max(0, deadline - startMs);

	try {
		while (true) {
			if (options.signal?.aborted) {
				return abortedResult();
			}
			const response = await getFetch(options)(
				`${DEVICE_AUTH_API_BASE_URL}/deviceauth/token`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					signal: options.signal,
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

			if (isPendingStatus(response.status)) {
				const nowMs = now();
				const remainingMs = deadline - nowMs;
				if (remainingMs <= 0) {
					return failedResult(
						"timeout",
						`Device auth timed out after ${formatWaitBudget(effectiveTimeoutMs)}`,
					);
				}
				const delayMs = resolvePollDelayMs(
					response,
					deviceCode,
					nowMs,
					options,
				);
				await sleepWithAbort(Math.min(delayMs, remainingMs), options);
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
		if (isAbortError(error) || options.signal?.aborted) {
			return abortedResult();
		}
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
	if (options.signal?.aborted) {
		return abortedResult();
	}

	printDeviceAuthorizationPrompt(
		deviceCodeResult.deviceCode,
		options.log ?? console.log,
		options.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS,
		getNow(options)(),
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
