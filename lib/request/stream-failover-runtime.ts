import type { ServerResponse } from "node:http";
import type { RuntimeRotationProxyStatus } from "../runtime/rotation-server-types.js";

export const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"content-length",
	"expect",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
// Any header under this prefix carries account-identifying rotation metadata
// (index/label/email/id today) and must never reach the client; matching by
// prefix means a future header added under it is blocked by default instead
// of leaking until someone remembers to extend an allowlist.
const PRIVATE_CLIENT_RESPONSE_HEADER_PREFIX = "x-codex-multi-auth-account-";
const DECODED_UPSTREAM_RESPONSE_HEADERS = new Set([
	// Node fetch returns decoded bytes while preserving the upstream encoding header.
	"content-encoding",
]);

export function responseHeadersForClient(upstreamHeaders: Headers): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of upstreamHeaders.entries()) {
		const normalizedKey = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(normalizedKey)) continue;
		if (normalizedKey.startsWith(PRIVATE_CLIENT_RESPONSE_HEADER_PREFIX)) continue;
		if (DECODED_UPSTREAM_RESPONSE_HEADERS.has(normalizedKey)) continue;
		headers[key] = value;
	}
	return headers;
}

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void,
	message: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => {
					// Reject BEFORE onTimeout: onTimeout side effects (e.g. cancelling a
					// stream reader) can settle `promise` with a clean value, and a
					// settlement enqueued ahead of this rejection would win the race —
					// turning a stall into a silent success.
					reject(new Error(message));
					onTimeout();
				}, Math.max(1, timeoutMs));
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function readErrorBody(
	response: Response,
	timeoutMs: number,
	maxBytes = 1024 * 1024,
): Promise<string> {
	// The outbound fetch's abort timer is cleared once headers arrive, so a
	// stalled error body would otherwise hang this handler forever (the success
	// path is per-chunk stall-bounded; the error path was not). Read the body via
	// a reader, bound it by an idle timeout AND a size cap, and cancel the stream
	// on timeout/overflow so the socket is released.
	const body = response.body;
	if (!body || typeof body.getReader !== "function") {
		// Fallback for impls without a streamable body: race text() against a timer.
		try {
			return await withTimeout(
				response.text(),
				timeoutMs,
				() => undefined,
				"error body stalled",
			);
		} catch {
			return "";
		}
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<never>((_resolve, reject) => {
				idleTimer = setTimeout(
					() => reject(new Error("error body stalled")),
					Math.max(1, timeoutMs),
				);
			});
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await Promise.race([reader.read(), idle]);
			} finally {
				if (idleTimer) clearTimeout(idleTimer);
			}
			if (result.done) break;
			if (result.value) {
				total += result.value.byteLength;
				if (total > maxBytes) break; // cap: enough for diagnostics, no OOM
				chunks.push(result.value);
			}
		}
	} catch {
		// stalled or errored — fall through with whatever we have
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	try {
		return Buffer.concat(chunks).toString("utf8");
	} catch {
		return "";
	}
}

// Resolve once the client response can accept more data again. Also resolves
// on close/error so a client that disconnects mid-backpressure cannot park the
// forwarder forever — the next reader.read() then observes the cancellation
// installed by the close handler.
function waitForDrain(res: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const settle = () => {
			res.off("drain", settle);
			res.off("close", settle);
			res.off("error", settle);
			resolve();
		};
		res.once("drain", settle);
		res.once("close", settle);
		res.once("error", settle);
	});
}

export async function forwardStreamingResponse(
	upstream: Response,
	res: ServerResponse,
	status: RuntimeRotationProxyStatus,
	onStreamError: () => void,
	streamStallTimeoutMs: number,
): Promise<boolean> {
	status.streamsStarted += 1;
	res.writeHead(
		upstream.status,
		responseHeadersForClient(upstream.headers),
	);
	if (!upstream.body) {
		res.end();
		return true;
	}

	const reader = upstream.body.getReader();
	res.on("close", () => {
		if (!res.writableEnded) {
			void reader.cancel().catch(() => undefined);
		}
	});
	try {
		while (true) {
			const { done, value } = await withTimeout(
				reader.read(),
				streamStallTimeoutMs,
				() => {
					void reader.cancel().catch(() => undefined);
				},
				`upstream stream stalled after ${streamStallTimeoutMs}ms`,
			);
			if (done) break;
			if (value && value.byteLength > 0) {
				// If the response is already finished (clean end by a concurrent
				// close-then-reader-cancel path), stop writing. Do NOT guard on
				// res.destroyed here: a socket-error-during-backpressure scenario sets
				// destroyed=true and then lets the next res.write() throw so the catch
				// block can record the error and fire onStreamError correctly.
				if (res.writableEnded) break;
				// Respect backpressure: when the client's socket buffer is full,
				// pause upstream reads until it drains instead of buffering the
				// whole stream in memory for a slow consumer.
				if (!res.write(Buffer.from(value)) && !res.destroyed) {
					await waitForDrain(res);
				}
			}
		}
		res.end();
		return true;
	} catch (error) {
		status.lastError = error instanceof Error ? error.message : String(error);
		onStreamError();
		if (!res.destroyed) {
			res.destroy(error instanceof Error ? error : undefined);
		}
		return false;
	}
}
