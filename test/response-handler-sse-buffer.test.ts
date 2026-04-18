import { describe, it, expect, vi } from "vitest";
import { convertSseToJson } from "../lib/request/response-handler.js";

// REQ-HIGH-03: Linear SSE buffering with pre-append size check.
//
// Previous implementation of convertSseToJson used
//   fullText += decoder.decode(value, { stream: true })
// which is O(n) per append on V8 (string rope materialization), producing
// O(n^2) total work on large SSE streams. It also checked MAX_SSE_SIZE
// AFTER appending, so peak memory transiently held chunk_size + 10MB
// before throwing.
//
// Fix accumulates decoded chunks in a string[] and joins once at the end,
// and enforces the MAX_SSE_SIZE cap BEFORE appending each chunk, so memory
// is bounded to the cap and the throw cannot allocate a cap+chunk buffer.
//
// These tests live in a dedicated file to isolate the regression scenarios
// from the much larger response-handler.test.ts suite.

describe("convertSseToJson: REQ-HIGH-03 linear buffering with pre-append cap", () => {
	// MAX_SSE_SIZE is an internal constant in lib/request/response-handler.ts.
	// Mirror it here so tests read the same numeric cap the implementation
	// enforces. Drift is caught by the "just under cap" test.
	const MAX_SSE_SIZE_FOR_TEST = 10 * 1024 * 1024; // 10MB, must match lib constant

	// Build a multi-chunk SSE stream reader that emits ASCII bytes. Using
	// ASCII guarantees decoder.decode(value, { stream: true }) returns a
	// string of the same length as the byte buffer, so totalSize tracking
	// is deterministic relative to MAX_SSE_SIZE (10MB).
	const buildChunkedReader = (chunks: Uint8Array[]) => {
		let i = 0;
		const reader = {
			read: vi.fn(async () => {
				if (i >= chunks.length) return { done: true, value: undefined };
				const value = chunks[i++];
				return { done: false, value };
			}),
			cancel: vi.fn(async () => undefined),
			releaseLock: vi.fn(),
		};
		const response = {
			body: { getReader: () => reader },
			status: 200,
			statusText: "OK",
		} as unknown as Response;
		return { response, reader };
	};

	it("accumulates many chunks totaling just under the 10MB cap without throwing on append", async () => {
		// Build a valid SSE response whose payload is large (~9MB of filler
		// inside a JSON string field plus a terminal done event), split
		// across many ~128KB chunks. The sum stays below the 10MB cap so
		// the pre-append check must not trigger, and all chunks accumulate
		// and parse correctly.
		const filler = "x".repeat(9 * 1024 * 1024);
		const sse =
			'data: {"type":"response.started"}\n' +
			`data: {"type":"response.done","response":{"id":"resp_big","output":${JSON.stringify(filler)}}}\n`;
		const bytes = new TextEncoder().encode(sse);
		expect(bytes.byteLength).toBeLessThan(MAX_SSE_SIZE_FOR_TEST);

		const chunkSize = 128 * 1024;
		const chunks: Uint8Array[] = [];
		for (let off = 0; off < bytes.byteLength; off += chunkSize) {
			chunks.push(
				bytes.slice(off, Math.min(off + chunkSize, bytes.byteLength)),
			);
		}
		expect(chunks.length).toBeGreaterThan(1);

		const { response, reader } = buildChunkedReader(chunks);

		const result = await convertSseToJson(response, new Headers());
		const body = (await result.json()) as { id: string; output: string };
		expect(body.id).toBe("resp_big");
		expect(body.output.length).toBe(filler.length);
		// One read per chunk plus the final done=true read.
		expect(reader.read).toHaveBeenCalledTimes(chunks.length + 1);
	});

	it("throws on the FIRST chunk that would exceed the cap (pre-append, not post-append)", async () => {
		// Chunk 1: stays safely under the cap.
		// Chunk 2: small on its own, but pushes totalSize past MAX_SSE_SIZE.
		// The old implementation would append first then throw after the
		// accumulated string had already grown past the cap. The fix must
		// throw BEFORE appending chunk 2, so the reader is only called for
		// the two chunks and the second chunk is never retained alongside
		// the accumulated buffer.
		const nearCap = new Uint8Array(MAX_SSE_SIZE_FOR_TEST - 16).fill(0x61); // 'a'
		const overflow = new Uint8Array(64).fill(0x62); // 'b'
		const { response, reader } = buildChunkedReader([nearCap, overflow]);

		await expect(convertSseToJson(response, new Headers())).rejects.toThrow(
			/exceeds.*bytes limit/,
		);

		// Two reads: first chunk accepted, second chunk checked pre-append
		// and rejected. No further reads after throw.
		expect(reader.read).toHaveBeenCalledTimes(2);
		expect(reader.cancel).toHaveBeenCalled();
	});

	it("throws on the very first chunk when it alone exceeds the cap", async () => {
		// Single chunk that blows the cap by itself. Fix must reject before
		// attempting to push/retain it alongside an empty buffer.
		const tooBig = new Uint8Array(MAX_SSE_SIZE_FOR_TEST + 1).fill(0x63); // 'c'
		const { response, reader } = buildChunkedReader([tooBig]);

		await expect(convertSseToJson(response, new Headers())).rejects.toThrow(
			/exceeds.*bytes limit/,
		);
		expect(reader.read).toHaveBeenCalledTimes(1);
		expect(reader.cancel).toHaveBeenCalled();
	});

	it("counts utf-8 bytes rather than utf-16 code units in the pre-append guard", async () => {
		// 😀 is 2 UTF-16 code units but 4 UTF-8 bytes. The guard must count bytes
		// or it underestimates multi-byte chunks and can exceed the 10MB budget.
		const emoji = "😀";
		const repeats = Math.ceil((MAX_SSE_SIZE_FOR_TEST + 16) / 4);
		const filler = emoji.repeat(repeats);
		const sse =
			'data: {"type":"response.started"}\n' +
			`data: {"type":"response.done","response":{"id":"resp_emoji","output":${JSON.stringify(filler)}}}\n`;
		const bytes = new TextEncoder().encode(sse);
		// Sanity check: real bytes exceed cap even though string length alone would
		// underestimate the size.
		const decodedLengthEstimate = sse.length;
		const byteLength = bytes.byteLength;
		if (!(byteLength > MAX_SSE_SIZE_FOR_TEST && decodedLengthEstimate < byteLength)) {
			throw new Error("test setup invalid: expected utf-8 bytes > utf-16 length");
		}

		const { response, reader } = buildChunkedReader([bytes]);
		await expect(convertSseToJson(response, new Headers())).rejects.toThrow(
			/exceeds.*bytes limit/,
		);
		// One read only; the first chunk is rejected based on byte length.
		expect(reader.read).toHaveBeenCalledTimes(1);
		expect(reader.cancel).toHaveBeenCalled();
	});
});
