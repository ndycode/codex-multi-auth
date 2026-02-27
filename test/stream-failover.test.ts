import { describe, expect, it, vi } from "vitest";
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
	it("returns original response when max failovers disabled", async () => {
		const response = withStreamingFailover(
			makeSseResponse("data: ok\n\n"),
			async () => makeSseResponse("data: fallback\n\n"),
			{ maxFailovers: 0, stallTimeoutMs: 10 },
		);

		await expect(response.text()).resolves.toContain("data: ok");
	});

	it("switches to fallback stream when primary stalls", async () => {
		const fallback = vi.fn(async () => makeSseResponse("data: second\n\n"));
		const response = withStreamingFailover(makeStallingResponse(), fallback, {
			maxFailovers: 1,
			stallTimeoutMs: 10,
		});

		const text = await response.text();
		expect(text).toContain("data: first");
		expect(text).toContain("codex-multi-auth failover 1");
		expect(text).toContain("data: second");
		expect(fallback).toHaveBeenCalledTimes(1);
	});

	it("includes request id marker when provided", async () => {
		const response = withStreamingFailover(
			makeStallingResponse(),
			async () => makeSseResponse("data: fallback\n\n"),
			{
				maxFailovers: 1,
				stallTimeoutMs: 10,
				requestInstanceId: "req-123",
			},
		);

		const text = await response.text();
		expect(text).toContain("codex-multi-auth failover 1 req:req-123");
	});

	it("errors when fallback is unavailable", async () => {
		const response = withStreamingFailover(
			makeStallingResponse(),
			async () => null,
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		await expect(response.text()).rejects.toThrow("SSE stream stalled");
	});

	it("propagates fallback provider exceptions deterministically", async () => {
		const response = withStreamingFailover(
			makeStallingResponse(),
			async () => {
				throw new Error("fallback exploded");
			},
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		await expect(response.text()).rejects.toThrow("fallback exploded");
	});
});
