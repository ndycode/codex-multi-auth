import { beforeEach, describe, expect, it, vi } from "vitest";

const logRequestMock = vi.fn();

vi.mock("../lib/logger.js", () => ({
	LOGGING_ENABLED: true,
	logRequest: logRequestMock,
	createLogger: () => ({
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	}),
}));

describe("response handler logging branch", () => {
	beforeEach(() => {
		logRequestMock.mockClear();
	});

	it("logs full stream content when logging is enabled", async () => {
		const { convertSseToJson } = await import("../lib/request/response-handler.js");
		const response = new Response(
			'data: {"type":"response.done","response":{"id":"resp_logging"}}\n',
		);

		const result = await convertSseToJson(response, new Headers());
		expect(result.status).toBe(200);
		expect(result.headers.get("content-type")).toContain("application/json");
		expect(logRequestMock).toHaveBeenCalledTimes(1);
		expect(logRequestMock).toHaveBeenCalledWith(
			"stream-full",
			expect.objectContaining({ fullContent: expect.stringContaining("response.done") }),
		);
	});

	it("logs parsed phase and reasoning summary diagnostics when semantic SSE fields are present", async () => {
		const { convertSseToJson } = await import("../lib/request/response-handler.js");
		const response = new Response(
			[
				'data: {"type":"response.created","response":{"id":"resp_diag_123","object":"response"}}',
				'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"commentary"}}',
				'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Thinking...","phase":"commentary"}',
				'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"final_answer"}}',
				'data: {"type":"response.output_text.done","output_index":0,"content_index":1,"text":"Done.","phase":"final_answer"}',
				'data: {"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"text":"Need more context."}',
				'data: {"type":"response.done","response":{"id":"resp_diag_123","object":"response"}}',
				"",
			].join("\n"),
		);

		const result = await convertSseToJson(response, new Headers());
		expect(result.status).toBe(200);
		expect(logRequestMock).toHaveBeenCalledWith(
			"stream-diagnostics",
			expect.objectContaining({
				responseId: "resp_diag_123",
				phase: "final_answer",
				commentaryText: "Thinking...",
				finalAnswerText: "Done.",
				reasoningSummaryText: "Need more context.",
			}),
		);
	});
});
