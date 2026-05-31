import { describe, it, expect, vi } from "vitest";
import {
	fetchWithTimeout,
	readBodyTextGuarded,
	withPromptFetchHeaders,
	PROMPT_FETCH_MAX_BYTES,
} from "../lib/prompts/fetch-utils.js";

describe("prompt fetch-utils", () => {
	describe("withPromptFetchHeaders (prompts-08)", () => {
		it("adds a User-Agent and Accept, preserving caller headers", () => {
			const h = withPromptFetchHeaders({ "If-None-Match": '"x"' });
			expect(h["User-Agent"]).toBe("codex-multi-auth");
			expect(h.Accept).toContain("text/plain");
			expect(h["If-None-Match"]).toBe('"x"');
		});

		it("uses the GitHub JSON Accept when json=true", () => {
			expect(withPromptFetchHeaders({}, true).Accept).toContain("application/vnd.github+json");
		});

		it("lets caller override the defaults", () => {
			expect(withPromptFetchHeaders({ "User-Agent": "custom" })["User-Agent"]).toBe("custom");
		});
	});

	describe("fetchWithTimeout (prompts-02)", () => {
		it("passes an abort signal and the prompt headers", async () => {
			const fake = vi.fn(async (_url: string, init?: RequestInit) => {
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				expect((init?.headers as Record<string, string>)["User-Agent"]).toBe(
					"codex-multi-auth",
				);
				return new Response("ok");
			});
			await fetchWithTimeout("https://example.com", {}, fake as unknown as typeof fetch);
			expect(fake).toHaveBeenCalledOnce();
		});

		it("aborts when the request exceeds the timeout", async () => {
			const hang = (_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
			await expect(
				fetchWithTimeout(
					"https://example.com",
					{ timeoutMs: 20 },
					hang as unknown as typeof fetch,
				),
			).rejects.toThrow(/abort/i);
		});
	});

	describe("readBodyTextGuarded (prompts-04/05)", () => {
		it("returns body text for a normal response", async () => {
			expect(await readBodyTextGuarded(new Response("hello"))).toBe("hello");
		});

		it("rejects an empty / whitespace-only body", async () => {
			await expect(readBodyTextGuarded(new Response("   \n"))).rejects.toThrow(/empty/i);
		});

		it("rejects when Content-Length exceeds the cap", async () => {
			const res = new Response("data", {
				headers: { "content-length": String(PROMPT_FETCH_MAX_BYTES + 1) },
			});
			await expect(readBodyTextGuarded(res)).rejects.toThrow(/too large/i);
		});

		it("enforces the cap while streaming even without Content-Length", async () => {
			const big = "x".repeat(50);
			await expect(readBodyTextGuarded(new Response(big), 10)).rejects.toThrow(/too large/i);
		});
	});
});
