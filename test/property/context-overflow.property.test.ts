import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	createContextOverflowResponse,
	handleContextOverflow,
	isContextOverflowError,
} from "../../lib/context-overflow.js";

// The documented overflow phrase contract (recovery path for "prompt too
// long" 400s). Pinned verbatim: removing a phrase from the SUT fails here.
const OVERFLOW_PATTERNS = [
	"prompt is too long",
	"prompt_too_long",
	"context length exceeded",
	"context_length_exceeded",
	"maximum context length",
	"token limit exceeded",
	"too many tokens",
] as const;

// Surrounding noise that cannot accidentally contain a pattern: hex plus
// JSON-ish punctuation only.
const arbNoise = fc
	.array(fc.constantFrom(..."0123456789abcdef{}\":,[] ".split("")), {
		minLength: 0,
		maxLength: 40,
	})
	.map((chars) => chars.join(""));

const arbCasing = fc.constantFrom(
	(text: string) => text,
	(text: string) => text.toUpperCase(),
	(text: string) =>
		[...text]
			.map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char))
			.join(""),
);

describe("context overflow property invariants", () => {
	it("only a 400 with a known phrase classifies as overflow, in any casing or position", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...OVERFLOW_PATTERNS),
				arbCasing,
				arbNoise,
				arbNoise,
				fc.constantFrom(200, 400, 401, 403, 429, 500, 529),
				(pattern, casing, before, after, status) => {
					const body = `${before}${casing(pattern)}${after}`;
					// The phrase matches case-insensitively at any position, but only
					// behind the 400 status gate.
					expect(isContextOverflowError(status, body)).toBe(status === 400);
				},
			),
		);
	});

	it("noise-only bodies never classify, nor do empty bodies at any status", () => {
		fc.assert(
			fc.property(
				arbNoise,
				fc.integer({ min: 100, max: 599 }),
				(body, status) => {
					expect(isContextOverflowError(status, body)).toBe(false);
					expect(isContextOverflowError(status, "")).toBe(false);
				},
			),
		);
	});

	it("the synthetic response round-trips: parseable SSE carrying the notice, never re-classified", () => {
		fc.assert(
			fc.asyncProperty(
				fc.constantFrom("gpt-5.5", "gpt-5.3-codex", "unknown", "x/y"),
				async (model) => {
					const synthetic = createContextOverflowResponse(model);
					expect(synthetic.status).toBe(200);
					expect(synthetic.headers.get("X-Codex-Plugin-Synthetic")).toBe("true");
					expect(synthetic.headers.get("X-Codex-Plugin-Error-Type")).toBe(
						"context_overflow",
					);

					const body = await synthetic.text();
					const dataLines = body
						.split("\n")
						.filter((line) => line.startsWith("data: "));
					expect(dataLines.length).toBeGreaterThan(0);
					const payloads = dataLines.map(
						(line) => JSON.parse(line.slice("data: ".length)) as {
							type: string;
							response?: { model?: string; status?: string; output?: Array<{
								content?: Array<{ text?: string }>;
							}> };
						},
					);
					// Responses-API dialect (recovery-01): created first, completed
					// last, with the notice text in the terminal output payload.
					expect(payloads[0]?.type).toBe("response.created");
					const terminal = payloads[payloads.length - 1];
					expect(terminal?.type).toBe("response.completed");
					expect(terminal?.response?.model).toBe(model);
					expect(terminal?.response?.status).toBe("completed");
					expect(
						terminal?.response?.output?.[0]?.content?.[0]?.text,
					).toContain("/compact");

					// The synthetic 200 must never re-classify as overflow, so the
					// recovery path cannot recurse on its own output.
					expect(isContextOverflowError(synthetic.status, body)).toBe(false);
					const reHandled = await handleContextOverflow(synthetic, model);
					expect(reHandled.handled).toBe(false);
				},
			),
		);
	});

	it("handleContextOverflow intercepts exactly the classifier-positive 400s", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...OVERFLOW_PATTERNS),
				arbNoise,
				fc.boolean(),
				fc.constantFrom(400, 401, 429, 500),
				async (pattern, noise, includePattern, status) => {
					const body = includePattern ? `${noise}${pattern}` : noise;
					const upstream = new Response(body, { status });
					const outcome = await handleContextOverflow(upstream, "gpt-5.5");
					const shouldHandle = status === 400 && includePattern;
					expect(outcome.handled).toBe(shouldHandle);
					if (outcome.handled) {
						expect(outcome.response.status).toBe(200);
						expect(
							outcome.response.headers.get("X-Codex-Plugin-Synthetic"),
						).toBe("true");
					}
					// The original response body stays readable for callers when the
					// overflow path declines (handleContextOverflow reads a clone).
					if (!shouldHandle) {
						await expect(upstream.text()).resolves.toBe(body);
					}
				},
			),
		);
	});
});
