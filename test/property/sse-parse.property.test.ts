import { describe, expect, it } from "vitest";
import { fc } from "./setup.js";
import {
	attachResponseIdCapture,
	convertSseToJson,
} from "../../lib/request/response-handler.js";
import type { UsageTokenCounts } from "../../lib/usage/types.js";

// parseSseStream is intentionally not exported; these properties observe it
// through the two public consumers: convertSseToJson (buffered SSE → JSON
// decision) and attachResponseIdCapture (byte-faithful passthrough with
// response-id/usage capture). The oracle below mirrors the parser's own
// control flow so assertions encode the documented contract, not a guess.

const TERMINAL_TYPES = new Set([
	"response.done",
	"response.completed",
	"response.incomplete",
]);
const ERROR_TYPES = new Set(["error", "response.failed"]);

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

type SseLine =
	| { kind: "event"; event: Record<string, unknown> }
	| { kind: "primitive"; value: unknown }
	| { kind: "done"; spaced: boolean }
	| { kind: "malformed"; text: string }
	| { kind: "comment"; text: string }
	| { kind: "garbage"; text: string }
	| { kind: "blank" };

const arbSmallIndex = fc.option(fc.integer({ min: 0, max: 300 }), {
	nil: undefined,
});

const arbUsage = fc.option(
	fc.record(
		{
			input_tokens: fc.option(fc.integer({ min: 0, max: 100000 }), {
				nil: undefined,
			}),
			output_tokens: fc.option(fc.integer({ min: 0, max: 100000 }), {
				nil: undefined,
			}),
			total_tokens: fc.option(fc.integer({ min: 0, max: 200000 }), {
				nil: undefined,
			}),
		},
		{ requiredKeys: [] },
	),
	{ nil: undefined },
);

const arbTerminalResponse = fc.record(
	{
		id: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
		status: fc.option(
			fc.constantFrom("completed", "incomplete", "failed", "queued"),
			{ nil: undefined },
		),
		model: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
		output: fc.option(
			fc.array(
				fc.record({
					type: fc.constantFrom("message", "reasoning"),
					role: fc.constantFrom("assistant", "system"),
					content: fc.option(
						fc.array(
							fc.record({
								type: fc.constant("output_text"),
								text: fc.string({ maxLength: 60 }),
							}),
							{ maxLength: 3 },
						),
						{ nil: undefined },
					),
				}),
				{ maxLength: 3 },
			),
			{ nil: undefined },
		),
		usage: arbUsage,
	},
	{ requiredKeys: [] },
);

const arbEventType = fc.constantFrom(
	"response.done",
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
	"response.created",
	"response.in_progress",
	"response.output_text.delta",
	"response.output_text.done",
	"response.output_item.added",
	"response.output_item.done",
	"response.content_part.added",
	"response.content_part.done",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_summary_part.added",
	"response.mystery.future_event",
);

const arbEvent: fc.Arbitrary<Record<string, unknown>> = fc.record(
	{
		type: arbEventType,
		output_index: arbSmallIndex,
		content_index: arbSmallIndex,
		summary_index: arbSmallIndex,
		item_index: arbSmallIndex,
		delta: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
		text: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
		phase: fc.option(
			fc.constantFrom("commentary", "final_answer", "planning"),
			{ nil: undefined },
		),
		item: fc.option(
			fc.record(
				{
					type: fc.constantFrom("message", "reasoning", "function_call"),
					role: fc.constantFrom("assistant", "user"),
					content: fc.option(
						fc.array(
							fc.record({
								type: fc.constant("output_text"),
								text: fc.string({ maxLength: 40 }),
							}),
							{ maxLength: 2 },
						),
						{ nil: undefined },
					),
				},
				{ requiredKeys: [] },
			),
			{ nil: undefined },
		),
		part: fc.option(
			fc.record(
				{
					type: fc.constantFrom("output_text", "refusal"),
					text: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
					phase: fc.option(
						fc.constantFrom("commentary", "final_answer"),
						{ nil: undefined },
					),
				},
				{ requiredKeys: [] },
			),
			{ nil: undefined },
		),
		response: fc.option(arbTerminalResponse, { nil: undefined }),
		usage: arbUsage,
	},
	{ requiredKeys: ["type"] },
);

const arbSseLine: fc.Arbitrary<SseLine> = fc.oneof(
	fc.record({ kind: fc.constant("event" as const), event: arbEvent }),
	fc.record({
		kind: fc.constant("primitive" as const),
		value: fc.oneof(
			fc.integer(),
			fc.boolean(),
			fc.constant(null),
			fc.array(fc.integer(), { maxLength: 4 }),
			fc.constant("[DONE]"),
		),
	}),
	fc.record({
		kind: fc.constant("done" as const),
		spaced: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant("malformed" as const),
		text: fc
			.string({ maxLength: 60 })
			.filter((s) => {
				try {
					JSON.parse(s);
					return false;
				} catch {
					return true;
				}
			}),
	}),
	fc.record({
		kind: fc.constant("comment" as const),
		text: fc.string({ maxLength: 30 }),
	}),
	fc.record({
		kind: fc.constant("garbage" as const),
		text: fc.oneof(
			fc.string({ maxLength: 40 }),
			fc.constantFrom("event: message", "id: 42", "retry: 3000", "datax: y"),
		),
	}),
	fc.constant({ kind: "blank" as const }),
);

const arbStream = fc.record({
	lines: fc.array(arbSseLine, { maxLength: 40 }),
	eol: fc.constantFrom("\n", "\r\n"),
	// Cut points for chunk splitting; same text, different framings.
	chunkCutsA: fc.array(fc.integer({ min: 0, max: 512 }), { maxLength: 8 }),
	chunkCutsB: fc.array(fc.integer({ min: 0, max: 512 }), { maxLength: 8 }),
});

// ---------------------------------------------------------------------------
// Serialization + oracle mirroring parseSseStream control flow
// ---------------------------------------------------------------------------

function serializeLines(lines: SseLine[], eol: string): string {
	const rendered = lines.map((line) => {
		switch (line.kind) {
			case "event":
				return `data: ${JSON.stringify(line.event)}`;
			case "primitive":
				return `data:${JSON.stringify(line.value)}`;
			case "done":
				return line.spaced ? "data: [DONE]" : "data:[DONE]";
			case "malformed":
				return `data: ${line.text}`;
			case "comment":
				return `: ${line.text}`;
			case "garbage":
				return line.text;
			case "blank":
				return "";
		}
	});
	// SSE streams conventionally end with a blank line; keep the trailing EOL
	// so the final line is never left dangling mid-frame.
	return rendered.join(eol) + eol;
}

interface Oracle {
	encounteredError: boolean;
	terminalResponse: Record<string, unknown> | null;
	notifiedIds: string[];
}

function extractId(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

// Mirrors parseSseStream: events processed in order; error/failed short-
// circuits; the LAST terminal event's record `response` is the envelope the
// finalizer builds on; onResponseId is only notified (deduped) from terminal
// events. Events after the first error are never processed.
function simulateParse(lines: SseLine[]): Oracle {
	const notified: string[] = [];
	const seen = new Set<string>();
	let terminal: Record<string, unknown> | null = null;
	for (const line of lines) {
		if (line.kind !== "event") continue;
		const data = line.event;
		const type = data.type;
		if (typeof type === "string" && ERROR_TYPES.has(type)) {
			return { encounteredError: true, terminalResponse: null, notifiedIds: notified };
		}
		if (typeof type === "string" && TERMINAL_TYPES.has(type)) {
			const response = data.response;
			if (
				response &&
				typeof response === "object" &&
				!Array.isArray(response)
			) {
				terminal = response as Record<string, unknown>;
			}
			const id = extractId(response);
			if (id && !seen.has(id)) {
				seen.add(id);
				notified.push(id);
			}
		}
	}
	return { encounteredError: false, terminalResponse: terminal, notifiedIds: notified };
}

function splitAt(text: string, cuts: number[]): string[] {
	const points = [
		0,
		...cuts
			.map((c) => Math.max(0, Math.min(text.length, c)))
			.sort((a, b) => a - b),
		text.length,
	];
	const chunks: string[] = [];
	for (let i = 0; i + 1 < points.length; i++) {
		chunks.push(text.slice(points[i], points[i + 1]));
	}
	return chunks;
}

function streamResponse(text: string, cuts: number[], status = 200): Response {
	const chunks = splitAt(text, cuts);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(stream, {
		status,
		statusText: status >= 400 ? "Upstream Error" : "OK",
	});
}

async function readAll(response: Response): Promise<string> {
	return response.text();
}

// Keys the finalizer may synthesize/merge; every other key on the terminal
// response envelope must pass through verbatim.
const FINALIZER_TOUCHED_KEYS = new Set([
	"output",
	"output_text",
	"reasoning_summary_text",
	"phase",
	"phase_text",
	"commentary_text",
	"final_answer_text",
]);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("SSE parsing properties", () => {
	it("convertSseToJson: terminal events drive the documented three-way decision", async () => {
		await fc.assert(
			fc.asyncProperty(
				arbStream,
				fc.constantFrom(200, 500),
				async ({ lines, eol, chunkCutsA }, inputStatus) => {
					const text = serializeLines(lines, eol);
					const oracle = simulateParse(lines);
					const notified: string[] = [];
					const usageCalls: UsageTokenCounts[] = [];

					const result = await convertSseToJson(
						streamResponse(text, chunkCutsA, inputStatus),
						new Headers({ "content-type": "text/event-stream" }),
						{
							onResponseId: (id) => notified.push(id),
							onUsage: (usage) => usageCalls.push(usage),
						},
					);

					expect(notified).toEqual(oracle.notifiedIds);

					if (oracle.encounteredError) {
						// Terminal failure → non-2xx with the typed error envelope.
						expect(result.status).toBe(
							inputStatus >= 400 ? inputStatus : 502,
						);
						const body = (await result.json()) as {
							error?: { code?: string; type?: string };
						};
						expect(body.error?.code).toBe("sse_terminal_error");
						expect(body.error?.type).toBe("upstream_stream_error");
						expect(usageCalls.length).toBe(0);
						return;
					}

					if (oracle.terminalResponse === null) {
						// No terminal envelope → byte-faithful passthrough of the
						// original stream at the original status.
						expect(result.status).toBe(inputStatus);
						expect(await result.text()).toBe(text);
						expect(usageCalls.length).toBe(0);
						return;
					}

					// Terminal envelope → JSON response carrying the envelope's
					// non-synthesized fields verbatim.
					expect(result.status).toBe(inputStatus);
					expect(result.headers.get("content-type")).toContain(
						"application/json",
					);
					const parsed = (await result.json()) as Record<string, unknown>;
					for (const [key, value] of Object.entries(
						oracle.terminalResponse,
					)) {
						if (FINALIZER_TOUCHED_KEYS.has(key)) continue;
						expect(parsed[key]).toEqual(value);
					}
					// Usage is reported only when the envelope carries token counts.
					const usage = oracle.terminalResponse.usage as
						| Record<string, unknown>
						| undefined;
					const hasCounts =
						usage !== undefined &&
						(typeof usage.input_tokens === "number" ||
							typeof usage.output_tokens === "number" ||
							typeof usage.total_tokens === "number");
					if (hasCounts) {
						expect(usageCalls.length).toBe(1);
						expect(usageCalls[0]?.inputTokens).toBe(
							Math.max(
								0,
								Math.trunc(
									typeof usage?.input_tokens === "number"
										? usage.input_tokens
										: 0,
								),
							),
						);
					} else {
						expect(usageCalls.length).toBe(0);
					}
				},
			),
		);
	});

	it("convertSseToJson: chunk boundaries never change the parse outcome", async () => {
		await fc.assert(
			fc.asyncProperty(arbStream, async ({ lines, eol, chunkCutsA, chunkCutsB }) => {
				const text = serializeLines(lines, eol);
				const [a, b] = await Promise.all([
					convertSseToJson(
						streamResponse(text, chunkCutsA),
						new Headers(),
					),
					convertSseToJson(
						streamResponse(text, chunkCutsB),
						new Headers(),
					),
				]);
				expect(b.status).toBe(a.status);
				expect(await b.text()).toBe(await a.text());
			}),
		);
	});

	it("convertSseToJson: arbitrary garbage never throws and yields a coherent decision", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(arbSseLine, { maxLength: 60 }),
				fc.constantFrom("\n", "\r\n"),
				async (lines, eol) => {
					const text = serializeLines(lines, eol);
					let result: Response;
					try {
						result = await convertSseToJson(
							streamResponse(text, [1, 7, 23]),
							new Headers(),
						);
					} catch (error) {
						// The only documented throws are the size cap and stream
						// stalls — unreachable at these sizes/durations.
						throw new Error(
							`unexpected throw for ${text.length}-byte stream: ${String(error)}`,
						);
					}
					expect(result).toBeInstanceOf(Response);
					const oracle = simulateParse(lines);
					if (oracle.encounteredError) {
						expect(result.status).toBe(502);
						expect(
							(result.headers.get("content-type") ?? "").includes(
								"application/json",
							),
						).toBe(true);
					}
				},
			),
		);
	});

	it("convertSseToJson enforces the bounded buffer at MAX_SSE_SIZE", async () => {
		const MAX_SSE_SIZE = 10 * 1024 * 1024;
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: MAX_SSE_SIZE + 1, max: MAX_SSE_SIZE + 4096 }),
				fc.integer({ min: 1, max: 16 }),
				async (payloadSize, chunkCount) => {
					// One oversized data line split into several chunks — the cap is
					// enforced on accumulated bytes, not per chunk.
					const chunkSize = Math.ceil(payloadSize / chunkCount);
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							const encoder = new TextEncoder();
							let remaining = payloadSize;
							controller.enqueue(encoder.encode("data: "));
							remaining -= 6;
							while (remaining > 0) {
								const n = Math.min(remaining, chunkSize);
								controller.enqueue(encoder.encode("x".repeat(n)));
								remaining -= n;
							}
							controller.close();
						},
					});
					await expect(
						convertSseToJson(
							new Response(stream, { status: 200 }),
							new Headers(),
							{ streamStallTimeoutMs: 5000 },
						),
					).rejects.toThrow(/exceeds .* bytes limit/);
				},
			),
		);
	});

	it("attachResponseIdCapture: byte-faithful passthrough with chunk-invariant capture", async () => {
		await fc.assert(
			fc.asyncProperty(arbStream, async ({ lines, eol, chunkCutsA, chunkCutsB }) => {
				const text = serializeLines(lines, eol);
				const oracle = simulateParse(lines);

				const notifiedA: string[] = [];
				const notifiedB: string[] = [];
				const passthroughA = attachResponseIdCapture(
					streamResponse(text, chunkCutsA),
					new Headers({ "content-type": "text/event-stream" }),
					(id) => notifiedA.push(id),
				);
				const passthroughB = attachResponseIdCapture(
					streamResponse(text, chunkCutsB),
					new Headers({ "content-type": "text/event-stream" }),
					(id) => notifiedB.push(id),
				);

				// Passthrough must deliver the raw bytes untouched, regardless of
				// how the upstream framed them.
				expect(await readAll(passthroughA)).toBe(text);
				expect(await readAll(passthroughB)).toBe(text);

				// Response-id capture is invariant across chunk boundaries — a
				// `data:` line split mid-frame is still recovered.
				expect(notifiedA).toEqual(oracle.notifiedIds);
				expect(notifiedB).toEqual(oracle.notifiedIds);
			}),
		);
	});

	it("serialized event frames round-trip through JSON.parse (recoverability)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(arbEvent, { minLength: 1, maxLength: 20 }),
				async (events) => {
					for (const event of events) {
						const frame = `data: ${JSON.stringify(event)}`;
						const payload = frame.slice(5).trim();
						expect(JSON.parse(payload)).toEqual(event);
					}
				},
			),
		);
	});
});
