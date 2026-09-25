import { describe, expect, it } from "vitest";
import {
	createUsageStreamScanner,
	extractResponsesUsage,
	extractUsageTokenCounts,
} from "../lib/usage/usage-extraction.js";
import { estimateUsageCostUsd } from "../lib/usage/pricing.js";

const encoder = new TextEncoder();

function sseEvent(type: string, payload: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const COMPLETED_USAGE = {
	input_tokens: 1_000,
	input_tokens_details: { cached_tokens: 400 },
	output_tokens: 500,
	output_tokens_details: { reasoning_tokens: 200 },
	total_tokens: 1_500,
};

describe("extractUsageTokenCounts", () => {
	it("subtracts reasoning tokens out of the output bucket", () => {
		const counts = extractUsageTokenCounts(COMPLETED_USAGE);

		// OpenAI reports output_tokens INCLUSIVE of reasoning_tokens, but
		// estimateUsageCostUsd prices the two as disjoint buckets and sums them.
		// Passing output_tokens through raw would bill the 200 reasoning tokens
		// twice.
		expect(counts).toEqual({
			inputTokens: 1_000,
			outputTokens: 300,
			cachedInputTokens: 400,
			reasoningTokens: 200,
			totalTokens: 1_500,
		});
	});

	it("prices the split buckets back to the upstream output total", () => {
		const counts = extractUsageTokenCounts(COMPLETED_USAGE);
		if (!counts) throw new Error("expected counts");
		const split = estimateUsageCostUsd("gpt-5-codex", counts);
		const doubleCounted = estimateUsageCostUsd("gpt-5-codex", {
			...counts,
			outputTokens: 500,
		});

		expect(split).not.toBeNull();
		// The regression this guards: the naive mapping is strictly more
		// expensive, so a cost cap would trip early on every reasoning request.
		expect(doubleCounted).toBeGreaterThan(split as number);
	});

	it("keeps cached tokens inside the input bucket", () => {
		// estimateUsageCostUsd computes billableInput = input - cached, so a
		// cached count larger than input would make the input bucket negative.
		const counts = extractUsageTokenCounts({
			input_tokens: 10,
			input_tokens_details: { cached_tokens: 99 },
			output_tokens: 0,
		});

		expect(counts?.inputTokens).toBe(10);
		expect(counts?.cachedInputTokens).toBe(10);
	});

	it("derives a missing total from input plus the full output", () => {
		const counts = extractUsageTokenCounts({
			input_tokens: 7,
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 2 },
		});

		expect(counts?.totalTokens).toBe(12);
	});

	it("returns null for payloads that carry no counts at all", () => {
		expect(extractUsageTokenCounts(null)).toBeNull();
		expect(extractUsageTokenCounts({})).toBeNull();
		expect(extractUsageTokenCounts({ input_tokens: "12" })).toBeNull();
	});

	it("reads usage from either a bare response or a stream envelope", () => {
		expect(extractResponsesUsage({ usage: { input_tokens: 3 } })?.inputTokens).toBe(3);
		expect(
			extractResponsesUsage({ response: { usage: { input_tokens: 4 } } })?.inputTokens,
		).toBe(4);
		expect(extractResponsesUsage({ response: {} })).toBeNull();
	});
});

describe("createUsageStreamScanner", () => {
	it("observes multiline terminal frames split across CRLF chunks exactly once", () => {
		const events: unknown[] = [];
		const scanner = createUsageStreamScanner({contentType: "text/event-stream", onEvent: event => events.push(event)});
		const raw = 'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"usage":{"input_tokens":7}}}\r\n\r\n';
		for (const byte of encoder.encode(raw)) scanner.push(Uint8Array.of(byte));
		expect(scanner.result()?.inputTokens).toBe(7);
		expect(scanner.result()?.inputTokens).toBe(7);
		expect(events).toEqual([{type:"response.completed",response:{usage:{input_tokens:7}}}]);
	});
	it("recovers the terminal usage from an SSE body", () => {
		const scanner = createUsageStreamScanner({
			contentType: "text/event-stream; charset=utf-8",
		});
		scanner.push(encoder.encode(sseEvent("response.output_text.delta", { delta: "hi" })));
		scanner.push(
			encoder.encode(
				sseEvent("response.completed", { response: { usage: COMPLETED_USAGE } }),
			),
		);

		expect(scanner.result()).toMatchObject({ inputTokens: 1_000, outputTokens: 300 });
	});

	it("survives an event split across chunk boundaries", () => {
		const raw = sseEvent("response.completed", {
			response: { usage: COMPLETED_USAGE },
		});
		const bytes = encoder.encode(raw);
		const scanner = createUsageStreamScanner({ contentType: "text/event-stream" });
		// Feed one byte at a time: the scanner must not lose the event to a
		// mid-line or mid-UTF-8-sequence split.
		for (const byte of bytes) {
			scanner.push(Uint8Array.of(byte));
		}

		expect(scanner.result()).toMatchObject({ totalTokens: 1_500 });
	});

	it("prefers the terminal event over an earlier partial usage report", () => {
		const scanner = createUsageStreamScanner({ contentType: "text/event-stream" });
		scanner.push(
			encoder.encode(
				sseEvent("response.in_progress", {
					response: { usage: { input_tokens: 1, output_tokens: 1 } },
				}),
			),
		);
		scanner.push(
			encoder.encode(
				sseEvent("response.completed", { response: { usage: COMPLETED_USAGE } }),
			),
		);

		expect(scanner.result()?.totalTokens).toBe(1_500);
	});

	it("ignores the [DONE] sentinel and unparseable data lines", () => {
		const scanner = createUsageStreamScanner({ contentType: "text/event-stream" });
		scanner.push(encoder.encode("data: {not json\n\ndata: [DONE]\n\n"));

		expect(scanner.result()).toBeNull();
	});

	it("parses a non-streaming JSON body at the end", () => {
		const scanner = createUsageStreamScanner({ contentType: "application/json" });
		const body = JSON.stringify({ id: "resp_1", usage: COMPLETED_USAGE });
		scanner.push(encoder.encode(body.slice(0, 20)));
		scanner.push(encoder.encode(body.slice(20)));

		expect(scanner.result()).toMatchObject({ reasoningTokens: 200 });
	});

	it("gives up rather than buffer an oversized non-streaming body", () => {
		const scanner = createUsageStreamScanner({ contentType: "application/json" });
		// 2 MiB of payload, over the 1 MiB retention cap.
		const chunk = new Uint8Array(512 * 1024);
		chunk.fill(0x20);
		for (let i = 0; i < 4; i += 1) scanner.push(chunk);

		expect(scanner.result()).toBeNull();
	});

	it("never throws out of push, whatever the bytes are", () => {
		const scanner = createUsageStreamScanner({ contentType: null });
		expect(() => scanner.push(Uint8Array.of(0xff, 0xfe, 0x00))).not.toThrow();
		expect(() => scanner.result()).not.toThrow();
	});
});

it.each([false,true])("observes terminal events after an oversized SSE event (split=%s)",split=>{
 const events:unknown[]=[];const scanner=createUsageStreamScanner({contentType:"text/event-stream",onEvent:event=>events.push(event)});
 const encoder=new TextEncoder();const large='data: '+JSON.stringify({type:'response.output_item.done',data:'x'.repeat(2*1024*1024)})+'\n\n';
 if(split){for(let i=0;i<large.length;i+=8192)scanner.push(encoder.encode(large.slice(i,i+8192)));}else scanner.push(encoder.encode(large));
 const completed={type:'response.completed',response:{usage:{input_tokens:7,output_tokens:2}}};
 scanner.push(encoder.encode('data: '+JSON.stringify(completed)+'\n\n'));
 expect(scanner.result()?.inputTokens).toBe(7);expect(events).toEqual([completed]);
});
it.each(['\n','\r\n'])("keeps the terminal event when an oversized line ends at a %j chunk boundary",newline=>{
 const events:unknown[]=[];const scanner=createUsageStreamScanner({contentType:'text/event-stream',onEvent:e=>events.push(e)});const encoder=new TextEncoder();
 scanner.push(encoder.encode('data: '+JSON.stringify({type:'response.output_item.done',data:'x'.repeat(2*1024*1024)})+newline));
 scanner.push(encoder.encode(newline+'data: '+JSON.stringify({type:'response.completed'})+newline+newline));
 scanner.result();expect(events).toEqual([{type:'response.completed'}]);
});
