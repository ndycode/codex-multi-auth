import { applyResponseCompaction } from "../lib/request/response-compaction.js";
import type { RequestBody } from "../lib/types.js";

function buildInput(length: number) {
	return Array.from({ length }, (_value, index) => ({
		type: "message",
		role: index === 0 ? "developer" : "user",
		content: index === 0 ? "system prompt" : `message-${index}`,
	}));
}

describe("response compaction", () => {
	it("returns unchanged when the fast-session trim would be a no-op", async () => {
		const body: RequestBody = {
			model: "gpt-5.4",
			input: buildInput(2),
		};
		const fetchImpl = vi.fn<typeof fetch>();

		const result = await applyResponseCompaction({
			body,
			requestUrl: "https://chatgpt.com/backend-api/codex/responses",
			headers: new Headers(),
			trim: { maxItems: 8, preferLatestUserOnly: false },
			fetchImpl,
		});

		expect(result.mode).toBe("unchanged");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.body.input).toEqual(body.input);
	});

	it("falls back to local trimming when the model does not support compaction", async () => {
		const body: RequestBody = {
			model: "gpt-5-codex",
			input: buildInput(10),
		};
		const fetchImpl = vi.fn<typeof fetch>();

		const result = await applyResponseCompaction({
			body,
			requestUrl: "https://chatgpt.com/backend-api/codex/responses",
			headers: new Headers(),
			trim: { maxItems: 8, preferLatestUserOnly: false },
			fetchImpl,
		});

		expect(result.mode).toBe("trimmed");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.body.input).toHaveLength(8);
	});

	it("replaces request input with server-compacted output when available", async () => {
		const compactedOutput = [
			{
				type: "message",
				role: "assistant",
				content: "compacted summary",
			},
		];
		const body: RequestBody = {
			model: "gpt-5-mini",
			input: buildInput(12),
		};
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ output: compactedOutput }), { status: 200 }),
		);

		const result = await applyResponseCompaction({
			body,
			requestUrl: "https://chatgpt.com/backend-api/codex/responses",
			headers: new Headers({ accept: "text/event-stream" }),
			trim: { maxItems: 8, preferLatestUserOnly: false },
			fetchImpl,
		});

		expect(result.mode).toBe("compacted");
		expect(result.body.input).toEqual(compactedOutput);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/responses/compact",
			expect.objectContaining({
				method: "POST",
				headers: expect.any(Headers),
			}),
		);

		const requestInit = vi.mocked(fetchImpl).mock.calls[0]?.[1];
		const headers = new Headers(requestInit?.headers);
		expect(headers.get("accept")).toBe("application/json");
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("inserts /compact before query params in the compaction request URL", async () => {
		const body: RequestBody = {
			model: "gpt-5-mini",
			input: buildInput(12),
		};
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ output: buildInput(8) }), { status: 200 }),
		);

		await applyResponseCompaction({
			body,
			requestUrl: "https://chatgpt.com/backend-api/codex/responses?stream=true",
			headers: new Headers(),
			trim: { maxItems: 8, preferLatestUserOnly: false },
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/responses/compact?stream=true",
			expect.any(Object),
		);
	});

	it("falls back to local trimming when the compaction request fails", async () => {
		const body: RequestBody = {
			model: "gpt-5.4",
			input: buildInput(12),
		};
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "nope" } }), { status: 404 }),
		);

		const result = await applyResponseCompaction({
			body,
			requestUrl: "https://chatgpt.com/backend-api/codex/responses",
			headers: new Headers(),
			trim: { maxItems: 8, preferLatestUserOnly: false },
			fetchImpl,
		});

		expect(result.mode).toBe("trimmed");
		expect(result.body.input).toHaveLength(8);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
