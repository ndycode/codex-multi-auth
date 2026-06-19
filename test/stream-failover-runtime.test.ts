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

	/** Indices (0-based write order) for which write() reports a full buffer. */
	backpressureWrites = new Set<number>();
	events: string[] = [];

	write(chunk: Buffer): boolean {
		// Production-faithful: writing to a destroyed ServerResponse throws
		// ERR_STREAM_DESTROYED instead of returning false.
		if (this.destroyed) {
			throw new Error("ERR_STREAM_DESTROYED: write after destroy");
		}
		const index = this.chunks.length;
		this.chunks.push(chunk);
		this.events.push(`write:${index}`);
		return !this.backpressureWrites.has(index);
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

	it("blocks any header under the private account prefix, not just known names", () => {
		// Regression: the filter used to be an exact-name allowlist, so a future
		// x-codex-multi-auth-account-* header would have leaked by default.
		const upstream = new Headers({
			"content-type": "application/json",
			"x-codex-multi-auth-account-plan": "pro",
			"X-Codex-Multi-Auth-Account-Future-Field": "secret",
		});
		expect(responseHeadersForClient(upstream)).toEqual({
			"content-type": "application/json",
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

	it("pauses writes while the client buffer is full and resumes on drain", async () => {
		const res = new FakeServerResponse();
		res.backpressureWrites.add(0); // first write reports a full socket buffer
		const status = createStatus();
		// Note: the assertion is on WRITE order, not on the source's pull order —
		// ReadableStream prefetches into its internal queue independently of the
		// forwarder's pacing, so pull timing is not observable backpressure.
		const upstream = new Response(streamOf(
			new TextEncoder().encode("data: a\n\n"),
			new TextEncoder().encode("data: b\n\n"),
		), { status: 200 });

		setTimeout(() => {
			res.events.push("drain");
			res.emit("drain");
		}, 20);

		await expect(
			forwardStreamingResponse(upstream, res.asServerResponse(), status, vi.fn(), 5_000),
		).resolves.toBe(true);

		expect(Buffer.concat(res.chunks).toString("utf8")).toBe("data: a\n\ndata: b\n\n");
		expect(res.events.indexOf("drain")).toBeGreaterThan(res.events.indexOf("write:0"));
		expect(res.events.indexOf("write:1")).toBeGreaterThan(res.events.indexOf("drain"));
		expect(res.ended).toBe(true);
	});

	it("waits for a drain per backpressured write across multiple chunks", async () => {
		const res = new FakeServerResponse();
		res.backpressureWrites.add(0);
		res.backpressureWrites.add(2);
		const status = createStatus();
		const upstream = new Response(streamOf(
			new TextEncoder().encode("a"),
			new TextEncoder().encode("b"),
			new TextEncoder().encode("c"),
		), { status: 200 });

		// Each backpressured write gets its own drain; emit one per pause.
		const drainTimer = setInterval(() => {
			res.events.push("drain");
			res.emit("drain");
		}, 15);
		try {
			await expect(
				forwardStreamingResponse(upstream, res.asServerResponse(), status, vi.fn(), 5_000),
			).resolves.toBe(true);
		} finally {
			clearInterval(drainTimer);
		}

		expect(Buffer.concat(res.chunks).toString("utf8")).toBe("abc");
		const order = res.events;
		// write:0 pauses until the first drain; write:2 pauses until another.
		expect(order.indexOf("drain")).toBeGreaterThan(order.indexOf("write:0"));
		expect(order.indexOf("write:1")).toBeGreaterThan(order.indexOf("drain"));
		expect(order.lastIndexOf("drain")).toBeGreaterThan(order.indexOf("write:2"));
		expect(res.ended).toBe(true);
	});

	it("does not park forever when the client closes during backpressure", async () => {
		const res = new FakeServerResponse();
		res.backpressureWrites.add(0);
		const status = createStatus();
		const upstream = new Response(streamOf(
			new TextEncoder().encode("data: a\n\n"),
			new TextEncoder().encode("data: b\n\n"),
		), { status: 200 });

		// The client disconnects instead of draining: the close handler cancels
		// the upstream reader, so the next read observes done and the forwarder
		// finishes via the existing client-close path.
		setTimeout(() => {
			res.emit("close");
		}, 20);

		await expect(
			forwardStreamingResponse(upstream, res.asServerResponse(), status, vi.fn(), 5_000),
		).resolves.toBe(true);
		expect(Buffer.concat(res.chunks).toString("utf8")).toBe("data: a\n\n");
	});

	it("fails the stream when the socket errors during backpressure", async () => {
		// The error event settles waitForDrain silently; the failure must then
		// surface through the next write throwing on the destroyed response and
		// the catch block recording it.
		const res = new FakeServerResponse();
		res.backpressureWrites.add(0);
		const status = createStatus();
		const upstream = new Response(streamOf(
			new TextEncoder().encode("data: a\n\n"),
			new TextEncoder().encode("data: b\n\n"),
		), { status: 200 });

		setTimeout(() => {
			// Node destroys the response on a socket error; mirror that before
			// the emit so the forwarder's next write hits the destroyed stream.
			res.destroyed = true;
			res.emit("error", new Error("socket reset"));
		}, 20);

		const onStreamError = vi.fn();
		await expect(
			forwardStreamingResponse(upstream, res.asServerResponse(), status, onStreamError, 5_000),
		).resolves.toBe(false);

		expect(onStreamError).toHaveBeenCalledTimes(1);
		expect(status.lastError).toContain("write after destroy");
		expect(Buffer.concat(res.chunks).toString("utf8")).toBe("data: a\n\n");
		expect(res.ended).toBe(false);
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

	it("records the stall error, destroys the response, and reports failure on timeout", async () => {
		// Regression: withTimeout used to invoke onTimeout (which cancels the
		// reader and thereby settles the pending read() with {done: true})
		// before rejecting, so the race resolved and a stalled upstream was
		// forwarded as a clean end-of-stream — truncated body, res.end(), no
		// lastError, and onStreamError (the failover hook) never fired.
		const res = new FakeServerResponse();
		const status = createStatus();
		const upstream = new Response(streamOf(
			new TextEncoder().encode("data: a\n\n"),
			() => new Promise<Uint8Array>(() => undefined), // stalls forever
		), { status: 200 });

		const onStreamError = vi.fn();
		await expect(
			forwardStreamingResponse(upstream, res.asServerResponse(), status, onStreamError, 25),
		).resolves.toBe(false);

		expect(onStreamError).toHaveBeenCalledTimes(1);
		expect(status.lastError).toBe("upstream stream stalled after 25ms");
		expect(res.destroyed).toBe(true);
		expect(res.destroyError).toBeInstanceOf(Error);
		expect(Buffer.concat(res.chunks).toString("utf8")).toBe("data: a\n\n");
		expect(res.ended).toBe(false);
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
