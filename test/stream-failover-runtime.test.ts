import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeRotationProxyStatus } from "../lib/runtime/rotation-server-types.js";
import {
	forwardStreamingResponse,
	HOP_BY_HOP_HEADERS,
	readErrorBody,
	responseHeadersForClient,
	withTimeout,
} from "../lib/request/stream-failover-runtime.js";

function createStatus(): RuntimeRotationProxyStatus {
	return {
		startedAt: 0,
		totalRequests: 0,
		upstreamRequests: 0,
		retries: 0,
		rotations: 0,
		streamsStarted: 0,
		lastError: null,
		lastAccountIndex: null,
		lastAccountLabel: null,
		lastAccountId: null,
		lastAccountUpdatedAt: null,
	};
}

class FakeServerResponse extends EventEmitter {
	statusCode: number | null = null;
	headers: Record<string, string> = {};
	chunks: Buffer[] = [];
	ended = false;
	destroyed = false;
	destroyError: Error | undefined;

	get writableEnded(): boolean {
		return this.ended;
	}

	writeHead(status: number, headers: Record<string, string>): this {
		this.statusCode = status;
		this.headers = headers;
		return this;
	}

	write(chunk: Buffer): boolean {
		this.chunks.push(chunk);
		return true;
	}

	end(): this {
		this.ended = true;
		return this;
	}

	destroy(error?: Error): this {
		this.destroyed = true;
		this.destroyError = error;
		return this;
	}

	asServerResponse(): ServerResponse {
		return this as unknown as ServerResponse;
	}
}

function streamOf(...chunks: (Uint8Array | (() => Promise<Uint8Array>))[]): ReadableStream<Uint8Array> {
	const queue = [...chunks];
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = queue.shift();
			if (next === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(typeof next === "function" ? await next() : next);
		},
	});
}

describe("responseHeadersForClient", () => {
	it("drops hop-by-hop, private rotation, and content-encoding headers", () => {
		const upstream = new Headers({
			"content-type": "application/json",
			"x-request-id": "req_1",
			connection: "keep-alive",
			"transfer-encoding": "chunked",
			"content-encoding": "gzip",
			"x-codex-multi-auth-account-email": "user@example.com",
			"x-codex-multi-auth-account-id": "acc_1",
		});
		expect(responseHeadersForClient(upstream)).toEqual({
			"content-type": "application/json",
			"x-request-id": "req_1",
		});
	});

	it("covers every hop-by-hop header in the exported set", () => {
		const upstream = new Headers();
		for (const name of HOP_BY_HOP_HEADERS) {
			// `expect` and `content-length` are restricted by Headers in some impls;
			// set defensively via append on a plain record instead.
			try {
				upstream.set(name, "1");
			} catch {
				// Skip names the Headers impl refuses; the lowercase-set membership
				// check in responseHeadersForClient is the same code path regardless.
			}
		}
		expect(responseHeadersForClient(upstream)).toEqual({});
	});
});

describe("withTimeout", () => {
	it("resolves with the underlying promise before the deadline", async () => {
		await expect(
			withTimeout(Promise.resolve("ok"), 1_000, () => undefined, "stalled"),
		).resolves.toBe("ok");
	});

	it("rejects with the supplied message and fires onTimeout when the promise stalls", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			const pending = withTimeout(
				new Promise<never>(() => undefined),
				500,
				onTimeout,
				"upstream stalled",
			);
			const assertion = expect(pending).rejects.toThrow("upstream stalled");
			await vi.advanceTimersByTimeAsync(500);
			await assertion;
			expect(onTimeout).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("enforces a minimum 1ms timer for non-positive timeouts", async () => {
		vi.useFakeTimers();
		try {
			const pending = withTimeout(
				new Promise<never>(() => undefined),
				0,
				() => undefined,
				"stalled",
			);
			const assertion = expect(pending).rejects.toThrow("stalled");
			await vi.advanceTimersByTimeAsync(1);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("readErrorBody", () => {
	it("reads a streamed body to completion", async () => {
		const response = new Response(streamOf(
			new TextEncoder().encode('{"error":'),
			new TextEncoder().encode('"nope"}'),
		));
		await expect(readErrorBody(response, 1_000)).resolves.toBe('{"error":"nope"}');
	});

	it("caps the body at maxBytes and returns the bytes read so far", async () => {
		const big = new Uint8Array(64).fill(120); // 'x'
		const response = new Response(streamOf(big, big, big));
		// Cap below the second chunk's cumulative size: the overflowing chunk is
		// dropped, so only the first 64 bytes survive.
		await expect(readErrorBody(response, 1_000, 100)).resolves.toBe("x".repeat(64));
	});

	it("returns the partial body when a later chunk stalls past the idle timeout", async () => {
		const response = new Response(streamOf(
			new TextEncoder().encode("partial"),
			() => new Promise<Uint8Array>(() => undefined), // never resolves
		));
		await expect(readErrorBody(response, 25)).resolves.toBe("partial");
	});

	it("falls back to text() when the response has no streamable body", async () => {
		await expect(readErrorBody(new Response(null), 50)).resolves.toBe("");
	});
});

describe("forwardStreamingResponse", () => {
	it("forwards status, filtered headers, and chunks, then ends the response", async () => {
		const res = new FakeServerResponse();
		const status = createStatus();
		const upstream = new Response(streamOf(
			new TextEncoder().encode("data: a\n\n"),
			new TextEncoder().encode("data: b\n\n"),
		), {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				connection: "keep-alive",
				"x-codex-multi-auth-account-id": "acc_1",
			},
		});

		const onStreamError = vi.fn();
		await expect(
			forwardStreamingResponse(upstream, res.asServerResponse(), status, onStreamError, 1_000),
		).resolves.toBe(true);

		expect(status.streamsStarted).toBe(1);
		expect(res.statusCode).toBe(200);
		expect(res.headers).toEqual({ "content-type": "text/event-stream" });
		expect(Buffer.concat(res.chunks).toString("utf8")).toBe("data: a\n\ndata: b\n\n");
		expect(res.ended).toBe(true);
		expect(onStreamError).not.toHaveBeenCalled();
	});

	it("ends immediately when the upstream has no body", async () => {
		const res = new FakeServerResponse();
		const status = createStatus();
		await expect(
			forwardStreamingResponse(
				new Response(null, { status: 204 }),
				res.asServerResponse(),
				status,
				() => undefined,
				1_000,
			),
		).resolves.toBe(true);
		expect(res.statusCode).toBe(204);
		expect(res.ended).toBe(true);
		expect(res.chunks).toEqual([]);
	});

	it("currently ends a stalled stream cleanly instead of failing it", async () => {
		// Pins a BUG (not the intended design): on a stall, withTimeout's
		// onTimeout cancels the reader, which settles the pending read() with
		// {done: true} BEFORE the rejection lands, so Promise.race resolves.
		// The stall is reported as a clean end: truncated body, res.end(), no
		// lastError, and onStreamError (the failover hook) never fires. The
		// stall branch of the catch block is unreachable today. Fixed in the
		// stacked follow-up PR, which flips these expectations.
		const res = new FakeServerResponse();
		const status = createStatus();
		const upstream = new Response(streamOf(
			new TextEncoder().encode("data: a\n\n"),
			() => new Promise<Uint8Array>(() => undefined), // stalls forever
		), { status: 200 });

		const onStreamError = vi.fn();
		await expect(
			forwardStreamingResponse(upstream, res.asServerResponse(), status, onStreamError, 25),
		).resolves.toBe(true);

		expect(onStreamError).not.toHaveBeenCalled();
		expect(status.lastError).toBeNull();
		expect(res.destroyed).toBe(false);
		expect(Buffer.concat(res.chunks).toString("utf8")).toBe("data: a\n\n");
		expect(res.ended).toBe(true);
	});

	it("fails the stream when the upstream read rejects mid-stream", async () => {
		const res = new FakeServerResponse();
		const status = createStatus();
		const upstream = new Response(streamOf(
			new TextEncoder().encode("data: a\n\n"),
			() => Promise.reject(new Error("socket reset")),
		), { status: 200 });

		const onStreamError = vi.fn();
		await expect(
			forwardStreamingResponse(upstream, res.asServerResponse(), status, onStreamError, 1_000),
		).resolves.toBe(false);

		expect(onStreamError).toHaveBeenCalledTimes(1);
		expect(status.lastError).toBe("socket reset");
		expect(res.destroyed).toBe(true);
		expect(res.destroyError).toBeInstanceOf(Error);
		expect(res.ended).toBe(false);
	});
});
