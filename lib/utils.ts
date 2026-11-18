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
 * Combines two abort signals into one that aborts when the FIRST input does.
 *
 * This is a thin null-tolerant wrapper over `AbortSignal.any` — available
 * on every Node version the engines floor (`>=22.19`) permits. Using the
 * native composite matters beyond brevity: a manual addEventListener pair
 * stays registered on BOTH inputs until one fires, so a caller that combines
 * a long-lived signal (e.g. a proxy-lifetime abort) once per request would
 * pin one listener + controller closure per completed request. The native
 * composite is tracked as a weak dependency of the sources, so it detaches
 * from a long-lived caller signal as soon as the request drops it.
 *
 * The forwarded signal aborts with the firing signal's `reason` (matching
 * `AbortSignal.any` semantics, including timeout reasons from
 * `AbortSignal.timeout`).
 *
 * Undefined/null inputs are treated as "no constraint": one real signal is
 * returned as-is, and two absent inputs yield a never-aborting signal. An
 * already-aborted input is returned directly so its reason survives.
 */
export function combineSignals(
	first: AbortSignal | null | undefined,
	second: AbortSignal | null | undefined,
): AbortSignal {
	if (first?.aborted) return first;
	if (second?.aborted) return second;
	if (!first) return second ?? new AbortController().signal;
	if (!second) return first;
	return AbortSignal.any([first, second]);
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
