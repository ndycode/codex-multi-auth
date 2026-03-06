import { isAbortError, sleep } from "./utils.js";

export interface RetryAttemptInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	reason: "error" | "status" | "timeout";
	status?: number;
	errorType?: string;
}

export interface ResilientFetchOptions {
	timeoutMs: number;
	retries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterMs?: number;
	retryOnErrors?: boolean;
	retryOnTimeout?: boolean;
	retryOnStatuses?: readonly number[];
	signal?: AbortSignal;
	onRetry?: (info: RetryAttemptInfo) => void;
}

export interface ResilientFetchResult {
	response: Response;
	attempts: number;
	durationMs: number;
}

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_JITTER_MS = 100;

function createAbortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function isCallerAbort(error: unknown, callerSignal: AbortSignal | undefined): boolean {
	if (!callerSignal?.aborted) return false;
	if (isAbortError(error)) return true;
	if (callerSignal.reason !== undefined) {
		return error === callerSignal.reason;
	}
	return false;
}

function getRetryErrorType(error: unknown): string {
	if (isAbortError(error)) return "AbortError";
	if (error instanceof Error && error.name) return error.name;
	return typeof error;
}

function getAbortReason(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) {
		return signal.reason;
	}
	return createAbortError("Request aborted by caller");
}

function computeDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	jitterMs: number,
): number {
	const cappedBase = Math.max(0, Math.floor(baseDelayMs));
	const cappedMax = Math.max(0, Math.floor(maxDelayMs));
	const cappedJitter = Math.max(0, Math.floor(jitterMs));
	const exponential = Math.min(cappedMax, cappedBase * 2 ** Math.max(0, attempt - 1));
	const jitter = cappedJitter > 0 ? Math.floor(Math.random() * (cappedJitter + 1)) : 0;
	return exponential + jitter;
}

function shouldRetryStatus(status: number, retryOnStatuses: ReadonlySet<number>): boolean {
	return retryOnStatuses.has(status);
}

function bindCallerAbortSignal(
	callerSignal: AbortSignal | undefined,
	controller: AbortController,
): (() => void) | null {
	if (!callerSignal) return null;
	if (callerSignal.aborted) {
		controller.abort(callerSignal.reason);
		return null;
	}
	const onAbort = () => controller.abort(callerSignal.reason);
	callerSignal.addEventListener("abort", onAbort, { once: true });
	return () => callerSignal.removeEventListener("abort", onAbort);
}

async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
	const normalizedDelayMs = Math.max(0, Math.floor(delayMs));
	if (normalizedDelayMs === 0) return;
	if (!signal) {
		await sleep(normalizedDelayMs);
		return;
	}
	if (signal.aborted) {
		throw getAbortReason(signal);
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, normalizedDelayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(getAbortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
	});
}

/**
 * Execute a fetch request with a per-attempt timeout and bounded retry/backoff.
 * Caller-provided abort signals are always honored and never retried.
 */
export async function fetchWithTimeoutAndRetry(
	input: URL | string | Request,
	init: RequestInit = {},
	options: ResilientFetchOptions,
): Promise<ResilientFetchResult> {
	const timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs));
	const maxAttempts = Math.max(1, Math.floor((options.retries ?? 0) + 1));
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
	const retryOnErrors = options.retryOnErrors ?? true;
	const retryOnTimeout = options.retryOnTimeout ?? true;
	const retryOnStatuses = new Set(options.retryOnStatuses ?? []);
	const startedAt = Date.now();
	let lastError: unknown = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const controller = new AbortController();
		const removeAbortListener = bindCallerAbortSignal(options.signal, controller);
		const timeout = setTimeout(() => {
			controller.abort(createAbortError(`Request timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		try {
			const response = await fetch(input, { ...init, signal: controller.signal });
			if (attempt < maxAttempts && shouldRetryStatus(response.status, retryOnStatuses)) {
				const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs, jitterMs);
				options.onRetry?.({
					attempt,
					maxAttempts,
					reason: "status",
					status: response.status,
					delayMs,
				});
				await response.body?.cancel().catch(() => {});
				await sleepWithAbort(delayMs, options.signal);
				continue;
			}
			return {
				response,
				attempts: attempt,
				durationMs: Date.now() - startedAt,
			};
		} catch (error) {
			lastError = error;
			if (isCallerAbort(error, options.signal)) {
				throw error;
			}
			if (attempt >= maxAttempts) {
				throw error;
			}
			const retryReason: RetryAttemptInfo["reason"] = isAbortError(error)
				? "timeout"
				: "error";
			if (
				(retryReason === "timeout" && !retryOnTimeout) ||
				(retryReason === "error" && !retryOnErrors)
			) {
				throw error;
			}
			const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs, jitterMs);
			options.onRetry?.({
				attempt,
				maxAttempts,
				reason: retryReason,
				errorType: getRetryErrorType(error),
				delayMs,
			});
			await sleepWithAbort(delayMs, options.signal);
		} finally {
			clearTimeout(timeout);
			removeAbortListener?.();
		}
	}

	throw (lastError instanceof Error
		? lastError
		: new Error("Request failed after all retry attempts"));
}
