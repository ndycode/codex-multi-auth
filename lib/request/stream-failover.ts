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

function isStallTimeoutError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.includes("SSE stream stalled for");
}

function normalizeRequestInstanceId(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length <= MAX_REQUEST_INSTANCE_ID_LENGTH) return trimmed;
	return trimmed.slice(0, MAX_REQUEST_INSTANCE_ID_LENGTH);
}

/**
 * Wrap a streaming SSE response and retry with a fallback response source when
 * the stream stalls/errors. This keeps client sessions alive without forcing
 * manual restart.
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
