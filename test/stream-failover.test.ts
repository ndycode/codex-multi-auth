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
		const response = withStreamingFailover(makeStallingResponse(), fallback, {
			maxFailovers: 1,
			stallTimeoutMs: 10,
		});

		const textPromise = response.text();
		await vi.advanceTimersByTimeAsync(1_200);
		const text = await textPromise;
		expect(text).toContain("data: first");
		expect(text).toContain("codex-multi-auth failover 1");
		expect(text).toContain("data: second");
		expect(fallback).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("includes request id marker when provided", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeStallingResponse(),
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
		vi.useRealTimers();
	});

	it("errors when fallback is unavailable", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeStallingResponse(),
			async () => null,
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("SSE stream stalled");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;
		vi.useRealTimers();
	});

	it("propagates fallback provider exceptions deterministically", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeStallingResponse(),
			async () => {
				throw new Error("fallback exploded");
			},
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("fallback exploded");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;
		vi.useRealTimers();
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
});
