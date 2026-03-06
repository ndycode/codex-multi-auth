import { describe, expect, it, vi } from "vitest";

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
	it("does not log full stream content for successful SSE conversion", async () => {
		logRequestMock.mockClear();
		const { convertSseToJson } = await import("../lib/request/response-handler.js");
		const response = new Response(
			'data: {"type":"response.done","response":{"id":"resp_logging"}}\n',
		);

		const result = await convertSseToJson(response, new Headers());
		expect(result.status).toBe(200);
		expect(result.headers.get("content-type")).toContain("application/json");
		expect(logRequestMock).not.toHaveBeenCalled();
	});

	it("logs only fixed parse error details without raw stream content", async () => {
		logRequestMock.mockClear();
		const { convertSseToJson } = await import("../lib/request/response-handler.js");
		const response = new Response(
			'data: {"type":"chunk","delta":"email=user@example.com token=sk-secret-value"}\n',
		);

		const result = await convertSseToJson(response, new Headers());
		expect(result.status).toBe(502);
		expect(logRequestMock).toHaveBeenCalledWith("stream-error", {
			error: "No response.done event found",
		});

		const serializedCalls = JSON.stringify(logRequestMock.mock.calls);
		expect(serializedCalls).not.toContain("user@example.com");
		expect(serializedCalls).not.toContain("sk-secret-value");
	});
});
