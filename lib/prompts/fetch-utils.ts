/**
 * Shared, hardened fetch helpers for the GitHub-backed prompt fetchers.
 *
 * Both prompt sources (lib/prompts/codex.ts and lib/prompts/host-codex-prompt.ts)
 * pull text over the network on a request-blocking path. These helpers add the
 * guards that were missing (prompts-02/04/05/08):
 *   - a bounded fetch timeout via AbortSignal so a hung GitHub connection cannot
 *     stall the request pipeline indefinitely (prompts-02)
 *   - a maximum response size, checked against Content-Length and enforced while
 *     reading, so a pathological body cannot exhaust memory (prompts-04)
 *   - rejection of empty / whitespace-only 200 bodies so a bad response is not
 *     cached and served as "instructions" (prompts-05)
 *   - a User-Agent (api.github.com rejects requests without one) plus a sensible
 *     Accept, applied to every request (prompts-08)
 */

export const PROMPT_FETCH_TIMEOUT_MS = 10_000;
export const PROMPT_FETCH_MAX_BYTES = 1_000_000; // 1 MB ceiling for a prompt body
export const PROMPT_FETCH_USER_AGENT = "codex-multi-auth";

export interface PromptFetchOptions {
	headers?: Record<string, string>;
	timeoutMs?: number;
	maxBytes?: number;
	/** When true, also request GitHub's JSON API content type. */
	json?: boolean;
}

/** Merge caller headers with the mandatory User-Agent / Accept defaults. */
export function withPromptFetchHeaders(
	headers: Record<string, string> = {},
	json = false,
): Record<string, string> {
	return {
		"User-Agent": PROMPT_FETCH_USER_AGENT,
		Accept: json ? "application/vnd.github+json" : "text/plain, */*",
		...headers,
	};
}

/**
 * fetch() with a bounded timeout. Returns the Response (caller inspects status).
 * Throws on timeout/network error, matching native fetch rejection semantics.
 */
export async function fetchWithTimeout(
	url: string,
	options: PromptFetchOptions = {},
	fetchImpl: typeof fetch = fetch,
): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? PROMPT_FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, {
			headers: withPromptFetchHeaders(options.headers, options.json === true),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}
// PLACEHOLDER_READ_BODY

/**
 * Read a response body as text with a size ceiling, rejecting empty bodies.
 *
 * Checks Content-Length first (fast reject), then enforces the cap while
 * streaming so a server that omits/understates the header still cannot exceed
 * the limit. Throws on oversize or empty/whitespace-only content so the caller
 * treats it as a fetch failure and falls back to disk/bundled content.
 */
export async function readBodyTextGuarded(
	response: Response,
	maxBytes: number = PROMPT_FETCH_MAX_BYTES,
): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(
			`prompt body too large: Content-Length ${declared} exceeds ${maxBytes}`,
		);
	}

	let text: string;
	const body = response.body;
	if (body && typeof body.getReader === "function") {
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > maxBytes) {
					await reader.cancel().catch(() => undefined);
					throw new Error(`prompt body too large: exceeded ${maxBytes} bytes`);
				}
				chunks.push(value);
			}
		}
		text = Buffer.concat(chunks).toString("utf8");
	} else {
		// Fallback for fetch impls without a streamable body (e.g. some mocks).
		text = await response.text();
		if (Buffer.byteLength(text, "utf8") > maxBytes) {
			throw new Error(`prompt body too large: exceeded ${maxBytes} bytes`);
		}
	}

	if (text.trim().length === 0) {
		throw new Error("prompt body was empty");
	}
	return text;
}

