/**
 * Consolidated utility functions for the Codex plugin.
 * Extracted from various modules to eliminate duplication.
 */

/**
 * Type guard for plain objects (not arrays, not null).
 * @param value - The value to check
 * @returns True if value is a plain object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detects AbortError-compatible failures from fetch/abort-controller flows.
 * @param error - Unknown thrown value
 * @returns True when the error should be treated as an abort signal
 */
export function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const maybe = error as Error & { code?: string };
	return maybe.name === "AbortError" || maybe.code === "ABORT_ERR";
}

/**
 * Returns the current timestamp in milliseconds.
 * Wrapper for Date.now() to enable testing with mocked time.
 * @returns Current time in milliseconds since epoch
 */
export function nowMs(): number {
	return Date.now();
}

/**
 * Safely converts any value to a string representation.
 * @param value - The value to convert
 * @returns String representation of the value
 */
export function toStringValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value === null) {
		return "null";
	}
	if (value === undefined) {
		return "undefined";
	}
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

/**
 * Promisified setTimeout for async/await usage.
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the specified time
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run fetch with a hard timeout while preserving caller abort signals.
 * @param input - fetch input
 * @param init - fetch init
 * @param timeoutMs - timeout in milliseconds
 * @returns fetch response
 */
export async function fetchWithTimeout(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1] = {},
	timeoutMs = 60_000,
): Promise<Response> {
	const timeout = Math.max(1_000, Math.floor(timeoutMs));
	const controller = new AbortController();
	const userSignal = init.signal;
	const timeoutError = new Error(`Fetch timeout after ${timeout}ms`) as Error & { code?: string };
	timeoutError.name = "AbortError";
	timeoutError.code = "ABORT_ERR";
	const timeoutId = setTimeout(() => {
		controller.abort(timeoutError);
	}, timeout);

	const normalizeAbortReason = (reason: unknown): Error & { code?: string } => {
		if (reason instanceof Error && isAbortError(reason)) {
			return reason as Error & { code?: string };
		}
		const normalized = new Error(reason instanceof Error ? reason.message : "Aborted") as Error & {
			code?: string;
		};
		normalized.name = "AbortError";
		normalized.code = "ABORT_ERR";
		return normalized;
	};

	const onAbort = () => {
		controller.abort(normalizeAbortReason(userSignal?.reason));
	};

	if (userSignal?.aborted) {
		onAbort();
	} else if (userSignal) {
		userSignal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		return await fetch(input, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
		if (userSignal) {
			userSignal.removeEventListener("abort", onAbort);
		}
	}
}
