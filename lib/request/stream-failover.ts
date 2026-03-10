import { ensureContentType } from "./response-handler.js";

export interface StreamFailoverOptions {
	maxFailovers?: number;
	stallTimeoutMs?: number;
	softTimeoutMs?: number;
	hardTimeoutMs?: number;
	requestInstanceId?: string;
}

const DEFAULT_MAX_FAILOVERS = 1;
const DEFAULT_STALL_TIMEOUT_MS = 45_000;
const DEFAULT_SOFT_TIMEOUT_MS = 15_000;
const MAX_REQUEST_INSTANCE_ID_LENGTH = 64;

type StreamReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">;
type StreamReadResult = Awaited<ReturnType<StreamReader["read"]>>;

class StallTimeoutError extends Error {
	readonly isStallTimeout = true;

	constructor(timeoutMs: number) {
		super(`SSE stream stalled for ${timeoutMs}ms`);
		this.name = "StallTimeoutError";
	}
}

/**
 * Read a single chunk from `reader`, rejecting if no chunk is produced within `timeoutMs`.
 *
 * Assumes the provided reader is not read concurrently by other callers. This function performs no filesystem I/O (behavior is unaffected by Windows filesystem semantics) and does not perform token redaction or logging of stream contents.
 *
 * @param reader - The ReadableStreamDefaultReader to read from.
 * @param timeoutMs - Maximum time in milliseconds to wait for a chunk before rejecting.
 * @returns The result of `reader.read()`: an object with `done` and `value` (`Uint8Array | undefined`).
 */
async function readChunkWithTimeout(
	readPromise: Promise<StreamReadResult>,
	timeoutMs: number,
): Promise<StreamReadResult> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			readPromise,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new StallTimeoutError(timeoutMs));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Determines whether an error indicates an SSE stream stall timeout.
 *
 * Concurrency: safe to call from multiple async contexts. Windows filesystem: not applicable. Token redaction: this function only inspects the error message and does not log or expose sensitive tokens.
 *
 * @param error - The value to inspect for a stall-timeout error
 * @returns `true` if `error` is an `Error` whose message contains "SSE stream stalled for", `false` otherwise.
 */
function isStallTimeoutError(error: unknown): boolean {
	if (error instanceof StallTimeoutError) return true;
	if (!error || typeof error !== "object") return false;
	const candidate = error as { isStallTimeout?: unknown };
	if (candidate.isStallTimeout === true) return true;
	return false;
}

/**
 * Normalize a request instance identifier by trimming whitespace and enforcing a maximum length.
 *
 * This function is pure and safe for concurrent use; it performs no I/O or filesystem operations (behavior is OS-independent, including Windows). It truncates long identifiers to MAX_REQUEST_INSTANCE_ID_LENGTH but does not mask or redact content — callers should apply any token-redaction or masking required for logs or telemetry.
 *
 * @param value - The raw identifier value which may be undefined or contain surrounding whitespace
 * @returns The trimmed identifier if non-empty and within the length limit, a truncated identifier if longer than the limit, or `null` if the input is undefined or empty after trimming
 */
function normalizeRequestInstanceId(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length <= MAX_REQUEST_INSTANCE_ID_LENGTH) return trimmed;
	return trimmed.slice(0, MAX_REQUEST_INSTANCE_ID_LENGTH);
}

async function readChunkWithSoftHardTimeout(
	reader: StreamReader,
	softTimeoutMs: number,
	hardTimeoutMs: number,

): Promise<StreamReadResult> {
	const readPromise = reader.read();
	try {
		return await readChunkWithTimeout(readPromise, softTimeoutMs);
	} catch (error) {
		if (!isStallTimeoutError(error) || hardTimeoutMs <= softTimeoutMs) {
			throw error;
		}
		return readChunkWithTimeout(readPromise, hardTimeoutMs - softTimeoutMs);
	}
}

/**
 * Wraps an SSE-like streaming Response so the stream can switch to fallback sources on stalls or errors to keep the client session alive.
 *
 * The returned Response streams bytes from the initialResponse body and, when the stream stalls or errors, will attempt up to `maxFailovers` failovers by calling `getFallbackResponse(attempt, emittedBytes)`. On each successful failover a textual marker is injected into the stream identifying the failover attempt (and `requestInstanceId` when provided). The function performs best-effort cleanup of underlying readers and enforces soft/hard read timeouts as configured via `options`.
 *
 * Concurrency assumptions: the implementation expects a single consumer reading the returned Response body; callers must not concurrently read the same stream body from multiple consumers. Filesystem/platform note: behavior is platform-agnostic; no filesystem access is performed (Windows-specific filesystem semantics do not apply). Token redaction: any request identifiers embedded in the injected marker are limited to the normalized `requestInstanceId` (trimmed and truncated to 64 chars) to avoid leaking long tokens.
 *
 * @param initialResponse - The original Response whose body will be streamed and monitored for stalls/errors.
 * @param getFallbackResponse - Async function invoked for each failover attempt with the 1-based attempt number and total emitted bytes; should return a Response with a streaming body to switch to, or `null`/a Response without a body to indicate no fallback.
 * @param options - Optional failover configuration (maxFailovers, stall/soft/hard timeout overrides, requestInstanceId). `requestInstanceId` will be normalized and truncated to 64 characters.
 * @returns A new Response that streams data from the initial response but may switch to fallback responses on stall/error, preserving the original status, statusText, and content-type header.
 */
export function withStreamingFailover(
	initialResponse: Response,
	getFallbackResponse: (attempt: number, emittedBytes: number) => Promise<Response | null>,
	options: StreamFailoverOptions = {},
): Response {
	const maxFailovers = Math.max(0, Math.floor(options.maxFailovers ?? DEFAULT_MAX_FAILOVERS));
	const defaultHardTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
	const softTimeoutMs = Math.max(
		1_000,
		Math.floor(options.softTimeoutMs ?? Math.min(defaultHardTimeoutMs, DEFAULT_SOFT_TIMEOUT_MS)),
	);
	const hardTimeoutMs = Math.max(
		softTimeoutMs,
		Math.floor(options.hardTimeoutMs ?? defaultHardTimeoutMs),
	);
	const requestInstanceId = normalizeRequestInstanceId(options.requestInstanceId);
	const headers = ensureContentType(initialResponse.headers);

	if (!initialResponse.body || maxFailovers <= 0) {
		return initialResponse;
	}

	let closed = false;
	let releaseCurrentReaderForCancel: (() => Promise<void>) | null = null;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let currentReader = initialResponse.body?.getReader() ?? null;
			let failoverAttempt = 0;
			let emittedBytes = 0;

			const releaseCurrentReader = async (): Promise<void> => {
				if (!currentReader) return;
				try {
					await currentReader.cancel();
				} catch {
					// Best effort.
				}
				try {
					currentReader.releaseLock();
				} catch {
					// Best effort.
				}
				currentReader = null;
			};
			releaseCurrentReaderForCancel = releaseCurrentReader;

			const tryFailover = async (): Promise<boolean> => {
				if (failoverAttempt >= maxFailovers) {
					return false;
				}
				failoverAttempt += 1;
				const fallback = await getFallbackResponse(failoverAttempt, emittedBytes);
				if (!fallback?.body) {
					return false;
				}
				await releaseCurrentReader();
				const markerLabel = requestInstanceId
					? `: codex-multi-auth failover ${failoverAttempt} req:${requestInstanceId}\n\n`
					: `: codex-multi-auth failover ${failoverAttempt}\n\n`;
				const marker = new TextEncoder().encode(markerLabel);
				controller.enqueue(marker);
				currentReader = fallback.body.getReader();
				return true;
			};

			const pump = async (): Promise<void> => {
				while (!closed && currentReader) {
					try {
						const result = await readChunkWithSoftHardTimeout(
							currentReader,
							softTimeoutMs,
							hardTimeoutMs,
						);
						if (result.done) {
							closed = true;
							controller.close();
							await releaseCurrentReader();
							return;
						}
						if (result.value && result.value.byteLength > 0) {
							emittedBytes += result.value.byteLength;
							controller.enqueue(result.value);
						}
					} catch (error) {
						let switched = false;
						try {
							switched = await tryFailover();
						} catch (failoverError) {
							closed = true;
							await releaseCurrentReader();
							controller.error(failoverError);
							return;
						}
						if (switched) {
							continue;
						}
						closed = true;
						await releaseCurrentReader();
						controller.error(error);
						return;
					}
				}
			};

			void pump();
		},
		cancel() {
			closed = true;
			if (releaseCurrentReaderForCancel) {
				void releaseCurrentReaderForCancel();
			}
		},
	});

	return new Response(body, {
		status: initialResponse.status,
		statusText: initialResponse.statusText,
		headers,
	});
}
