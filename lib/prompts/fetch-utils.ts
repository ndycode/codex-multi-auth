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

const PROMPT_FETCH_TIMEOUT_MS = 10_000;
export const PROMPT_FETCH_MAX_BYTES = 1_000_000; // 1 MB ceiling for a prompt body
const PROMPT_FETCH_USER_AGENT = "codex-multi-auth";

export interface PromptFetchOptions {
	headers?: Record<string, string>;
	timeoutMs?: number;
	maxBytes?: number;
	/** When true, also request GitHub's JSON API content type. */
	json?: boolean;
}

/**
 * Merge caller headers with the mandatory User-Agent / Accept defaults.
 *
 * The mandatory headers are applied AFTER the caller's so they always win: a
 * caller must not be able to blank or replace `User-Agent` / `Accept` and
 * bypass the hardening this helper guarantees on every prompt fetch (api.github
 * .com rejects requests without a User-Agent). Caller headers are still honored
 * for everything else (e.g. `If-None-Match`).
 */
export function withPromptFetchHeaders(
	headers: Record<string, string> = {},
	json = false,
): Record<string, string> {
	return {
		...headers,
		"User-Agent": PROMPT_FETCH_USER_AGENT,
		Accept: json ? "application/vnd.github+json" : "text/plain, */*",
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

/**
 * Race a response-body read against a bounded timeout, cancelling the underlying
 * stream on timeout (prompts-02).
 *
 * `fetchWithTimeout`'s AbortSignal only covers connect+headers and is cleared
 * once the Response arrives, so a server that sends headers then stalls mid-body
 * makes `response.json()` / `response.text()` hang forever on a request-blocking
 * path. This races the read against a timeout AND, on timeout, calls
 * `response.body.cancel()` so the stalled body stops consuming the connection
 * instead of leaking until GC/socket close. Unlike `readBodyTextGuarded` it adds
 * no size/Content-Length/empty checks, so it is safe for the small
 * release-metadata reads that just need the hang guard. For fetch impls / mocks
 * without a streamable `body`, the cancel is a no-op and the timeout still
 * rejects.
 */
export async function withBodyTimeout<T>(
	response: Pick<Response, "body">,
	read: Promise<T>,
	timeoutMs: number = PROMPT_FETCH_TIMEOUT_MS,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			// Release the underlying stream so a stalled body is torn down rather
			// than left consuming the connection. body may be null (already read or
			// a mock without a stream); cancel may reject — swallow either.
			try {
				const body = response.body as ReadableStream<Uint8Array> | null | undefined;
				void body?.cancel?.().catch(() => undefined);
			} catch {
				// best-effort cancel
			}
			reject(new Error(`response body read timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([read, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Read a response body as text with a size ceiling, rejecting empty bodies.
 *
 * Checks Content-Length first (fast reject), then enforces the cap while
 * streaming so a server that omits/understates the header still cannot exceed
 * the limit. Throws on oversize or empty/whitespace-only content so the caller
 * treats it as a fetch failure and falls back to disk/bundled content.
 *
 * prompts-02: the streaming read also enforces a per-chunk idle timeout. The
 * fetch-level AbortSignal in `fetchWithTimeout` only covers connect+headers and
 * is cleared once the Response arrives, so without this a server that sends
 * headers then stalls mid-body would hang this request-blocking path forever.
 * If no chunk arrives within `timeoutMs`, the read is aborted and rejected.
 */
export async function readBodyTextGuarded(
	response: Response,
	maxBytes: number = PROMPT_FETCH_MAX_BYTES,
	timeoutMs: number = PROMPT_FETCH_TIMEOUT_MS,
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
		try {
			for (;;) {
				// Race each read against an idle-timeout so a mid-body stall cannot
				// hang the request pipeline. A chunk resets the budget (the timer is
				// per-read); a quiet gap longer than timeoutMs aborts.
				let idleTimer: ReturnType<typeof setTimeout> | undefined;
				const idle = new Promise<never>((_resolve, reject) => {
					idleTimer = setTimeout(
						() => reject(new Error(`prompt body read timed out after ${timeoutMs}ms`)),
						timeoutMs,
					);
				});
				let result: Awaited<ReturnType<typeof reader.read>>;
				try {
					result = await Promise.race([reader.read(), idle]);
				} finally {
					if (idleTimer) clearTimeout(idleTimer);
				}
				const { done, value } = result;
				if (done) break;
				if (value) {
					total += value.byteLength;
					if (total > maxBytes) {
						throw new Error(`prompt body too large: exceeded ${maxBytes} bytes`);
					}
					chunks.push(value);
				}
			}
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw error;
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

