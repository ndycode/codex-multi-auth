import { describe, expect, it, vi } from "vitest";
import {
	normalizeRequestInit,
	parseRequestBodyFromInit,
} from "../lib/request/request-init.js";

describe("request init helpers", () => {
	it("normalizes a Request when no init is provided", async () => {
		const request = new Request("https://example.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ hello: "world" }),
		});

		const normalized = await normalizeRequestInit(request, undefined);
		expect(normalized?.method).toBe("POST");
		expect(normalized?.body).toBe(JSON.stringify({ hello: "world" }));
	});

	it("returns provided init unchanged", async () => {
		const init = { method: "GET" };
		await expect(
			normalizeRequestInit("https://example.com", init),
		).resolves.toBe(init);
	});

	it("parses multiple body shapes and warns on invalid payloads", async () => {
		const logWarn = vi.fn();
		expect(await parseRequestBodyFromInit('{"a":1}', logWarn)).toEqual({
			a: 1,
		});
		expect(
			await parseRequestBodyFromInit(
				new TextEncoder().encode('{"b":2}'),
				logWarn,
			),
		).toEqual({ b: 2 });
		expect(await parseRequestBodyFromInit("not json", logWarn)).toEqual({});
		expect(logWarn).toHaveBeenCalled();
	});
});
