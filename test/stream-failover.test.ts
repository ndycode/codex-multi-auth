import { afterEach, describe, expect, it, vi } from "vitest";
import { withStreamingFailover } from "../lib/request/stream-failover.js";

const encoder = new TextEncoder();

function makeStallingResponse(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: first\n\n"));
			},
		}),
		{
			headers: {
				"content-type": "text/event-stream",
			},
		},
	);
}

function makeIdleResponse(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start() {
				// Intentionally idle until timeout.
			},
		}),
		{
			headers: {
				"content-type": "text/event-stream",
			},
		},
	);
}

function makeSseResponse(payload: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(payload));
				controller.close();
			},
		}),
		{
			headers: {
				"content-type": "text/event-stream",
			},
		},
	);
}

describe("stream failover", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns original response when max failovers disabled", async () => {
		const response = withStreamingFailover(
			makeSseResponse("data: ok\n\n"),
			async () => makeSseResponse("data: fallback\n\n"),
			{ maxFailovers: 0, stallTimeoutMs: 10 },
		);

		await expect(response.text()).resolves.toContain("data: ok");
	});

	it("switches to fallback stream when primary stalls", async () => {
		vi.useFakeTimers();
		const fallback = vi.fn(async () => makeSseResponse("data: second\n\n"));
		const response = withStreamingFailover(makeIdleResponse(), fallback, {
			maxFailovers: 1,
			stallTimeoutMs: 10,
		});

		const textPromise = response.text();
		await vi.advanceTimersByTimeAsync(1_200);
		const text = await textPromise;
		expect(text).toContain("codex-multi-auth failover 1");
		expect(text).toContain("data: second");
		expect(fallback).toHaveBeenCalledTimes(1);
	});

	it("includes request id marker when provided", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeIdleResponse(),
			async () => makeSseResponse("data: fallback\n\n"),
			{
				maxFailovers: 1,
				stallTimeoutMs: 10,
				requestInstanceId: "req-123",
			},
		);

		const textPromise = response.text();
		await vi.advanceTimersByTimeAsync(1_200);
		const text = await textPromise;
		expect(text).toContain("codex-multi-auth failover 1 req:req-123");
	});

	it("errors when fallback is unavailable", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeIdleResponse(),
			async () => null,
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("SSE stream stalled");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;
	});

	it("propagates fallback provider exceptions deterministically", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeIdleResponse(),
			async () => {
				throw new Error("fallback exploded");
			},
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("fallback exploded");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;
	});

	it("does not trigger fallback when read-error and timeout race after bytes emitted", async () => {
		vi.useFakeTimers();
		const raceResponse = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode("data: first\n\n"));
					setTimeout(() => {
						controller.error(new Error("primary read failure"));
					}, 20);
				},
			}),
			{
				headers: {
					"content-type": "text/event-stream",
				},
			},
		);
		const fallback = vi.fn(async () => makeSseResponse("data: fallback\n\n"));
		const response = withStreamingFailover(raceResponse, fallback, {
			maxFailovers: 1,
			softTimeoutMs: 10,
			hardTimeoutMs: 20,
		});

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("primary read failure");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;

		expect(fallback).not.toHaveBeenCalled();
	});

	it("does not replay after bytes have already been emitted", async () => {
		vi.useFakeTimers();
		const fallback = vi.fn(async () => makeSseResponse("data: fallback\n\n"));
		const response = withStreamingFailover(makeStallingResponse(), fallback, {
			maxFailovers: 1,
			stallTimeoutMs: 10,
		});

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("SSE stream stalled");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;

		expect(fallback).not.toHaveBeenCalled();
	});

	it("releases underlying reader when wrapped stream is cancelled", async () => {
		let sourceCancelled = 0;
		const response = withStreamingFailover(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("data: first\n\n"));
					},
					cancel() {
						sourceCancelled += 1;
					},
				}),
				{
					headers: {
						"content-type": "text/event-stream",
					},
				},
			),
			async () => null,
			{ maxFailovers: 1, stallTimeoutMs: 10_000 },
		);

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.read();
		await reader?.cancel();

		expect(sourceCancelled).toBeGreaterThan(0);
	});

	it("absorbs a hostile upstream releaseLock without leaking an unhandled rejection", async () => {
		// Coverage for the `releaseCurrentReader` swallow at
		// lib/request/stream-failover.ts:153-166: the upstream reader's
		// releaseLock throws synchronously, which would normally bubble out
		// of cleanup and become an unhandled promise rejection. The wrapper
		// must swallow it (best-effort cancel + best-effort releaseLock) so
		// the consumer still sees the primary error and no rejection escapes.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const upstream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("primary boom"));
				},
			});
			// Patch getReader so the returned reader.releaseLock throws.
			const realGetReader = upstream.getReader.bind(upstream);
			(upstream as unknown as {
				getReader: () => ReadableStreamDefaultReader<Uint8Array>;
			}).getReader = () => {
				const reader = realGetReader();
				const realReleaseLock = reader.releaseLock.bind(reader);
				reader.releaseLock = () => {
					realReleaseLock();
					throw new Error("releaseLock blew up");
				};
				return reader;
			};

			const response = withStreamingFailover(
				new Response(upstream, {
					headers: { "content-type": "text/event-stream" },
				}),
				async () => null,
				{ maxFailovers: 0 },
			);

			// Consumer observes the upstream error, not a hang.
			await expect(response.text()).rejects.toThrow("primary boom");

			// Yield once so any deferred microtasks settle, then assert no
			// unhandled rejection escaped (releaseLock's secondary throw was
			// swallowed by the inner try/catch in releaseCurrentReader).
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("forwards a pump rejection to the consumer via the outer .catch safety net", async () => {
		// Coverage for the `pump().catch((err) => controller.error(err))` safety
		// net at lib/request/stream-failover.ts:230. We force pump's inner
		// catch arm to itself throw by making controller.error a no-op
		// (no behavior to mock) — that's not feasible from the outside, so we
		// reach the safety net through a different door: make
		// readChunkWithSoftHardTimeout reject AFTER the controller has been
		// error'd by the consumer cancelling. The outer .catch must absorb
		// the secondary throw and the consumer must not see an unhandled
		// rejection.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			let sourceCancelled = 0;
			const upstream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode("data: first\n\n"));
				},
				cancel() {
					sourceCancelled += 1;
				},
			});

			const response = withStreamingFailover(
				new Response(upstream, {
					headers: { "content-type": "text/event-stream" },
				}),
				async () => null,
				{ maxFailovers: 1, stallTimeoutMs: 10_000 },
			);

			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			// Drain one chunk then cancel: pump is parked awaiting the next
			// read. Cancellation triggers releaseCurrentReader and pump's
			// next iteration sees `closed` true; nothing should escape.
			await reader?.read();
			await reader?.cancel();

			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(sourceCancelled).toBeGreaterThan(0);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("stops pulling from upstream while the consumer is not reading", async () => {
		const TOTAL_CHUNKS = 50;
		let produced = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced >= TOTAL_CHUNKS) {
					controller.close();
					return;
				}
				produced += 1;
				controller.enqueue(encoder.encode(`data: chunk-${produced}\n\n`));
			},
		});
		const response = withStreamingFailover(
			new Response(source, { headers: { "content-type": "text/event-stream" } }),
			async () => null,
			{ maxFailovers: 1, stallTimeoutMs: 10_000 },
		);

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toBe("data: chunk-1\n\n");

		// Let every pending microtask and timer turn settle without reading
		// again. A pump that ignores controller.desiredSize drains the whole
		// upstream into the controller queue here, buffering it in memory for a
		// consumer that asked for exactly one chunk.
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(produced).toBeLessThan(TOTAL_CHUNKS);
		// A small constant of read-ahead is expected (the source stream and the
		// wrapper each hold one queued chunk); the point is that it is bounded and
		// does not grow with the length of the stream.
		expect(produced).toBeLessThanOrEqual(6);

		// Demand resumes the pump rather than wedging it.
		const second = await reader?.read();
		expect(new TextDecoder().decode(second?.value)).toBe("data: chunk-2\n\n");
		await reader?.cancel();
	});

	it("normalizes non-finite maxFailovers instead of churning forever", async () => {
		vi.useFakeTimers();
		// NaN used to survive Math.max(0, Math.floor(NaN)) and bypass the
		// failoverAttempt >= maxFailovers guard, producing unbounded churn.
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const fallback = vi.fn(async () => makeIdleResponse());
			const response = withStreamingFailover(
				makeIdleResponse(),
				fallback,
				{ maxFailovers: bad, stallTimeoutMs: 10 },
			);
			const textPromise = response.text().catch(() => "failed");
			await vi.advanceTimersByTimeAsync(60_000);
			await textPromise;
			// Default is 1 failover: one attempt, then the stream errors.
			expect(fallback).toHaveBeenCalledTimes(1);
		}
	});

	it("caps absurdly large maxFailovers at the hard bound", async () => {
		vi.useFakeTimers();
		const fallback = vi.fn(async () => makeIdleResponse());
		const response = withStreamingFailover(makeIdleResponse(), fallback, {
			maxFailovers: 1e9,
			stallTimeoutMs: 10,
		});
		// The idle fixture never produces a chunk, so every failover attempt
		// stalls and retries until the hard bound (32) is hit, then the stream
		// rejects with the final stall error.
		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("SSE stream stalled");
		await vi.advanceTimersByTimeAsync(300_000);
		await assertion;
		expect(fallback).toHaveBeenCalledTimes(32);
	});

	it("normalizes non-finite timeout options to their defaults", async () => {
		vi.useFakeTimers();
		// stallTimeoutMs=NaN used to flow through `??` and Math.floor into
		// setTimeout(NaN) — a ~0ms delay that stalled instantly.
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const fallback = vi.fn(async () => makeSseResponse("data: fallback\n\n"));
			const response = withStreamingFailover(makeIdleResponse(), fallback, {
				maxFailovers: 1,
				stallTimeoutMs: bad,
			});
			const textPromise = response.text();
			// Defaults: soft = min(45_000, 15_000) = 15_000ms, and the same read
			// then gets the remaining 30_000ms of the 45_000ms hard window, so a
			// stall can only fail over after ~45_000ms.
			await vi.advanceTimersByTimeAsync(14_000);
			expect(fallback).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(32_000);
			await expect(textPromise).resolves.toContain("data: fallback");
			expect(fallback).toHaveBeenCalledTimes(1);
		}
	});

	it("caps oversized finite timeouts at the supported timer maximum", async () => {
		vi.useFakeTimers();
		// Node treats setTimeout delays above 2^31-1 (~24.8 days) as ~1ms, so an
		// oversized-but-finite timeout would otherwise stall almost instantly
		// and churn fallovers. The cap pins the delay to the supported maximum.
		const fallback = vi.fn(async () => makeSseResponse("data: fallback\n\n"));
		const response = withStreamingFailover(makeIdleResponse(), fallback, {
			maxFailovers: 1,
			softTimeoutMs: 3_000_000_000,
			hardTimeoutMs: 4_000_000_000,
		});
		const textPromise = response.text();
		// Well under the capped window: nothing may fire yet.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fallback).not.toHaveBeenCalled();
		// Advancing past 2_147_483_647ms fires the soft window once and the
		// fallback stream takes over.
		await vi.advanceTimersByTimeAsync(2_147_483_647);
		await expect(textPromise).resolves.toContain("data: fallback");
		expect(fallback).toHaveBeenCalledTimes(1);
	});
});
