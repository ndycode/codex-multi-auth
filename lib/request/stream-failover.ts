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

/**
 * Reads a single chunk from the given stream reader and rejects if no chunk is received within the specified timeout.
 *
 * This must not be called concurrently for the same `reader` (only one active read operation per reader).
 * The function performs no filesystem I/O and is unaffected by Windows filesystem behavior.
 * Error messages do not expose or log request tokens or sensitive payloads.
 *
 * @param reader - The ReadableStreamDefaultReader to read a chunk from.
 * @param timeoutMs - Maximum time in milliseconds to wait for a chunk before rejecting.
 * @returns The result of `reader.read()`: an object with `done: boolean` and `value: Uint8Array | undefined`
 */
async function readChunkWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`SSE stream stalled for ${timeoutMs}ms`));
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
 * Detects whether an error represents the SSE stall-timeout condition.
 *
 * @param error - The value to inspect; typically an Error instance from a stream read.
 * @returns `true` if the error message contains "SSE stream stalled for", `false` otherwise.
 *
 * Concurrency: safe to call concurrently; no shared state is accessed or mutated.
 * Windows filesystem: not applicable (no filesystem I/O).
 * Token redaction: this function does not log or expose token contents.
 */
function isStallTimeoutError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.includes("SSE stream stalled for");
}

/**
 * Normalize an optional request instance identifier by trimming whitespace and enforcing a maximum length.
 *
 * This function is pure and safe for concurrent use; it does not access the filesystem and has no Windows-specific behavior.
 * It also truncates overly long values to avoid retaining or emitting excessively long tokens (basic redaction via length limit).
 *
 * @param value - The input identifier which may be undefined or contain surrounding whitespace
 * @returns The trimmed identifier if non-empty, truncated to at most MAX_REQUEST_INSTANCE_ID_LENGTH characters; otherwise `null`
 */
function normalizeRequestInstanceId(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length <= MAX_REQUEST_INSTANCE_ID_LENGTH) return trimmed;
	return trimmed.slice(0, MAX_REQUEST_INSTANCE_ID_LENGTH);
}

/**
 * Wraps a streaming Response to automatically switch to fallback responses when the stream stalls or errors, preserving client sessions without requiring a manual restart.
 *
 * This proxy stream reads from the initial response and, on repeated stalls or errors, invokes the provided fallback callback to obtain an alternate streaming Response. When a failover occurs a textual marker is injected into the stream to delineate the switch. Concurrency: the stream pumps reads serially from a single active reader; callers should not assume concurrent reads. Windows filesystem behavior: none (no file I/O performed). Token redaction: any requestInstanceId included in failover markers is normalized and truncated per configuration to avoid leaking overly long identifiers.
 *
 * @param initialResponse - The original Response whose streaming body will be proxied. If it has no body or failovers are disabled, it is returned unchanged.
 * @param getFallbackResponse - Async callback invoked with (attempt, emittedBytes) to obtain a fallback Response; return `null` to indicate no fallback available.
 * @param options - Failover configuration (max failovers, timeouts, requestInstanceId); requestInstanceId is normalized and truncated if present.
 * @returns A new Response whose body proxies the original stream and transparently switches to fallbacks on stall/error, preserving the original status, statusText, and adjusted headers.
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
						const result = await readChunkWithTimeout(currentReader, softTimeoutMs);
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
						if (isStallTimeoutError(error) && hardTimeoutMs > softTimeoutMs) {
							try {
								const result = await readChunkWithTimeout(currentReader, hardTimeoutMs);
								if (result.done) {
									closed = true;
									controller.close();
									await releaseCurrentReader();
									return;
								}
								if (result.value && result.value.byteLength > 0) {
									emittedBytes += result.value.byteLength;
									controller.enqueue(result.value);
									continue;
								}
							} catch {
								// Fall through to failover path.
							}
						}
						const switched = await tryFailover();
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
		},
	});

	return new Response(body, {
		status: initialResponse.status,
		statusText: initialResponse.statusText,
		headers,
	});
}
