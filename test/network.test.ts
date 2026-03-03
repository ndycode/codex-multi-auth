import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeoutAndRetry } from "../lib/network.js";

describe("fetchWithTimeoutAndRetry", () => {
	const originalFetch = globalThis.fetch;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns response on first successful attempt", async () => {
		fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		const promise = fetchWithTimeoutAndRetry("https://example.com", undefined, {
			timeoutMs: 2_000,
		});
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result.attempts).toBe(1);
		expect(result.response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries once after network error and recovers", async () => {
		const onRetry = vi.fn();
		fetchMock
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		const promise = fetchWithTimeoutAndRetry("https://example.com", undefined, {
			timeoutMs: 2_000,
			retries: 1,
			baseDelayMs: 25,
			jitterMs: 0,
			onRetry,
		});
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result.attempts).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "error", attempt: 1, maxAttempts: 2 }),
		);
	});

	it("retries on configured HTTP status codes", async () => {
		const onRetry = vi.fn();
		fetchMock
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		const promise = fetchWithTimeoutAndRetry("https://example.com", undefined, {
			timeoutMs: 2_000,
			retries: 1,
			baseDelayMs: 25,
			jitterMs: 0,
			retryOnStatuses: [503],
			onRetry,
		});
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result.attempts).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "status",
				status: 503,
				attempt: 1,
				maxAttempts: 2,
			}),
		);
	});

	it("does not retry caller-aborted requests", async () => {
		const controller = new AbortController();
		const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
		controller.abort();
		fetchMock.mockImplementationOnce(async () => {
			throw abortError;
		});

		const promise = fetchWithTimeoutAndRetry("https://example.com", undefined, {
			timeoutMs: 2_000,
			retries: 3,
			baseDelayMs: 25,
			jitterMs: 0,
			signal: controller.signal,
		});
		const rejection = expect(promise).rejects.toThrow("aborted");
		await vi.runAllTimersAsync();
		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
