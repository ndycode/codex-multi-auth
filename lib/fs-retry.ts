export const FILE_RETRY_CODES = new Set([
	"EBUSY",
	"EPERM",
	"EAGAIN",
	"ENOTEMPTY",
	"EACCES",
]);
export const FILE_RETRY_MAX_ATTEMPTS = 6;
export const FILE_RETRY_BASE_DELAY_MS = 25;
export const FILE_RETRY_JITTER_MS = 20;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryFileOperation(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		FILE_RETRY_CODES.has(error.code)
	);
}

/**
 * Options for {@link withRetry} / {@link withRetrySync}.
 *
 * The shape is deliberately wide enough to express every hand-rolled
 * file-retry loop in the codebase without changing any call site's behavior:
 * per-site attempt counts, exponential/linear backoff schedules, optional
 * jitter, and per-site retryable code sets are all preserved exactly.
 */
export interface RetryOptions {
	/** Total number of attempts (including the first one). Must be >= 1. */
	maxAttempts: number;
	/**
	 * Delay before the next attempt, either a fixed number of milliseconds or
	 * a function of the 1-based index of the attempt that just failed (so the
	 * delay after the first failure is `backoffMs(1)`). A computed delay <= 0
	 * retries immediately without scheduling a timer.
	 */
	backoffMs: number | ((attempt: number) => number);
	/**
	 * Optional jitter: adds `Math.floor(Math.random() * jitterMs)` to each
	 * computed backoff delay.
	 */
	jitterMs?: number;
	/**
	 * Error codes considered transient. Defaults to {@link FILE_RETRY_CODES}.
	 * An error retries only when it carries a string `code` in this set;
	 * everything else is rethrown immediately.
	 */
	retryableCodes?: ReadonlySet<string> | readonly string[];
	/** Invoked after each retryable failure, before the backoff delay. */
	onRetry?: (error: unknown, attempt: number) => void;
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isRetryableError(
	error: unknown,
	retryableCodes: ReadonlySet<string> | readonly string[] | undefined,
): boolean {
	const code = getErrorCode(error);
	if (code === undefined) return false;
	if (retryableCodes === undefined) return FILE_RETRY_CODES.has(code);
	return Array.isArray(retryableCodes)
		? retryableCodes.includes(code)
		: (retryableCodes as ReadonlySet<string>).has(code);
}

function computeDelayMs(options: RetryOptions, attempt: number): number {
	const base =
		typeof options.backoffMs === "function"
			? options.backoffMs(attempt)
			: options.backoffMs;
	const jitter =
		options.jitterMs !== undefined && options.jitterMs > 0
			? Math.floor(Math.random() * options.jitterMs)
			: 0;
	return base + jitter;
}

/**
 * Run `operation`, retrying on transient filesystem error codes with a
 * per-call backoff schedule. Non-retryable errors are rethrown immediately;
 * once `maxAttempts` is exhausted the error from the final attempt is
 * rethrown unchanged. No delay is scheduled after the final attempt.
 */
export async function withRetry<T>(
	operation: () => Promise<T> | T,
	options: RetryOptions,
): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (
				!isRetryableError(error, options.retryableCodes) ||
				attempt >= options.maxAttempts
			) {
				throw error;
			}
			options.onRetry?.(error, attempt);
			const delayMs = computeDelayMs(options, attempt);
			if (delayMs > 0) {
				await sleep(delayMs);
			}
		}
	}
}

/**
 * Synchronous variant of {@link withRetry} for callers that cannot await
 * (e.g. the synchronous recovery storage paths). Delays use a bounded
 * busy-wait, so keep per-site schedules short; a computed delay <= 0 retries
 * immediately without spinning.
 */
export function withRetrySync<T>(operation: () => T, options: RetryOptions): T {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return operation();
		} catch (error) {
			if (
				!isRetryableError(error, options.retryableCodes) ||
				attempt >= options.maxAttempts
			) {
				throw error;
			}
			options.onRetry?.(error, attempt);
			const delayMs = computeDelayMs(options, attempt);
			if (delayMs > 0) {
				const waitUntil = Date.now() + delayMs;
				while (Date.now() < waitUntil) {
					// Busy-wait within the bounded per-attempt budget.
				}
			}
		}
	}
}

export function withFileOperationRetry<T>(
	operation: () => Promise<T>,
): Promise<T> {
	return withRetry(operation, {
		maxAttempts: FILE_RETRY_MAX_ATTEMPTS,
		backoffMs: (attempt) => FILE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
		jitterMs: FILE_RETRY_JITTER_MS,
		retryableCodes: FILE_RETRY_CODES,
	});
}
