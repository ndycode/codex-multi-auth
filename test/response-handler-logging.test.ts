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
		const { convertSseToJson } = await import("../lib/request/response-handler.js");
		const response = new Response(
			'data: {"type":"response.done","response":{"id":"resp_logging"}}\n',
		);

		const result = await convertSseToJson(response, new Headers());
		expect(result.status).toBe(200);
		expect(result.headers.get("content-type")).toContain("application/json");
		expect(logRequestMock).not.toHaveBeenCalled();
	});
});
