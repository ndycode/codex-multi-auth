import { describe, it, expect } from "vitest";
import {
	isContextOverflowError,
	createContextOverflowResponse,
	handleContextOverflow,
} from "../lib/context-overflow.js";

describe("Context Overflow Handler", () => {
	describe("isContextOverflowError", () => {
		it("returns false for non-400 status", () => {
			expect(isContextOverflowError(200, "prompt is too long")).toBe(false);
			expect(isContextOverflowError(429, "prompt is too long")).toBe(false);
			expect(isContextOverflowError(500, "prompt is too long")).toBe(false);
		});

		it("returns false for empty body", () => {
			expect(isContextOverflowError(400, "")).toBe(false);
		});

		it("detects prompt_too_long pattern", () => {
			expect(isContextOverflowError(400, '{"error": {"code": "prompt_too_long"}}')).toBe(true);
		});

		it("detects 'prompt is too long' pattern", () => {
			expect(isContextOverflowError(400, "Error: prompt is too long for this model")).toBe(true);
		});

		it("detects context_length_exceeded pattern", () => {
			expect(isContextOverflowError(400, '{"error": {"code": "context_length_exceeded"}}')).toBe(true);
		});

		it("detects 'context length exceeded' pattern", () => {
			expect(isContextOverflowError(400, "The context length exceeded the maximum")).toBe(true);
		});

		it("detects 'maximum context length' pattern", () => {
			expect(isContextOverflowError(400, "This request exceeds maximum context length")).toBe(true);
		});

		it("detects 'token limit exceeded' pattern", () => {
			expect(isContextOverflowError(400, "Token limit exceeded for this model")).toBe(true);
		});

		it("detects 'too many tokens' pattern", () => {
			expect(isContextOverflowError(400, "Request has too many tokens")).toBe(true);
		});

		it("is case insensitive", () => {
			expect(isContextOverflowError(400, "PROMPT IS TOO LONG")).toBe(true);
			expect(isContextOverflowError(400, "CONTEXT_LENGTH_EXCEEDED")).toBe(true);
		});

		it("returns false for unrelated 400 errors", () => {
			expect(isContextOverflowError(400, '{"error": {"code": "invalid_api_key"}}')).toBe(false);
			expect(isContextOverflowError(400, "Bad request: missing model parameter")).toBe(false);
		});
	});

	describe("createContextOverflowResponse", () => {
		it("returns a 200 OK response", () => {
			const response = createContextOverflowResponse("gpt-5.1-codex");
			expect(response.status).toBe(200);
		});

		it("has text/event-stream content type", () => {
			const response = createContextOverflowResponse("gpt-5.1-codex");
			expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		});

		it("has synthetic response marker header", () => {
			const response = createContextOverflowResponse("gpt-5.1-codex");
			expect(response.headers.get("X-Codex-Plugin-Synthetic")).toBe("true");
			expect(response.headers.get("X-Codex-Plugin-Error-Type")).toBe("context_overflow");
		});

		it("includes SSE events with helpful message", async () => {
			const response = createContextOverflowResponse("gpt-5.1-codex");
			const text = await response.text();
			
			expect(text).toContain("event: message_start");
			expect(text).toContain("event: content_block_start");
			expect(text).toContain("event: content_block_delta");
			expect(text).toContain("event: content_block_stop");
			expect(text).toContain("event: message_delta");
			expect(text).toContain("event: message_stop");
			expect(text).toContain("/compact");
			expect(text).toContain("/clear");
			expect(text).toContain("/undo");
		});

		it("includes model in response", async () => {
			const response = createContextOverflowResponse("gpt-5.1-codex");
			const text = await response.text();
			expect(text).toContain('"model":"gpt-5.1-codex"');
		});

		it("uses 'unknown' as default model", async () => {
			const response = createContextOverflowResponse();
			const text = await response.text();
			expect(text).toContain('"model":"unknown"');
		});
	});

	describe("handleContextOverflow", () => {
		it("returns handled: false for non-400 responses", async () => {
			const response = new Response("OK", { status: 200 });
			const result = await handleContextOverflow(response, "gpt-5.1-codex");
			expect(result.handled).toBe(false);
		});

		it("returns handled: false for 400 without overflow pattern", async () => {
			const response = new Response('{"error": {"code": "invalid_request"}}', { status: 400 });
			const result = await handleContextOverflow(response, "gpt-5.1-codex");
			expect(result.handled).toBe(false);
		});

		it("returns handled: true with synthetic response for overflow error", async () => {
			const response = new Response('{"error": {"code": "prompt_too_long"}}', { status: 400 });
			const result = await handleContextOverflow(response, "gpt-5.1-codex");
			
			expect(result.handled).toBe(true);
			if (result.handled) {
				expect(result.response.status).toBe(200);
				expect(result.response.headers.get("X-Codex-Plugin-Synthetic")).toBe("true");
			}
		});

		it("handles response read errors gracefully", async () => {
			const response = new Response(null, { status: 400 });
			Object.defineProperty(response, "clone", {
				value: () => {
					throw new Error("Clone failed");
				},
			});
			const result = await handleContextOverflow(response, "gpt-5.1-codex");
			expect(result.handled).toBe(false);
		});
	});
});
