import type { UsageServiceTier, UsageTokenCounts } from "./types.js";

/**
 * Extracting token counts from upstream Responses API traffic.
 *
 * Without this the usage ledger records every request with all-zero tokens and
 * a zero cost, which silently disables the `maxTokens` / `maxCostUsd` budget
 * caps: `evaluateBudgetGuard` compares `0 >= limit`, which never fires, so
 * `codex-multi-auth budget set --cost 50` allows unlimited spend and only
 * `--requests` actually enforces anything.
 */

/** Cap on retained bytes so a hostile or unterminated body cannot grow forever. */
const MAX_BUFFERED_BYTES = 1_048_576;
/** Terminal Responses stream events that carry the final `usage` object. */
const TERMINAL_EVENT_TYPES = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
	"response.done",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

/**
 * Read an OpenAI Responses `usage` object into the ledger's token shape.
 *
 * Two containment rules drive the mapping, and getting either backwards
 * mis-prices every row:
 *
 * - `input_tokens_details.cached_tokens` is a SUBSET of `input_tokens`, and
 *   `estimateUsageCostUsd` already subtracts it (`billableInputTokens`), so
 *   both are passed through raw.
 * - `output_tokens_details.reasoning_tokens` is likewise a SUBSET of
 *   `output_tokens`, but `estimateUsageCostUsd` prices `outputTokens` and
 *   `reasoningTokens` as DISJOINT buckets and sums them. Passing the raw
 *   `output_tokens` alongside the reasoning count would bill reasoning twice,
 *   so the reasoning share is subtracted out here.
 */
export function extractUsageTokenCounts(
	usage: unknown,
): UsageTokenCounts | null {
	if (!isRecord(usage)) return null;
	const hasAnyCount =
		typeof usage.input_tokens === "number" ||
		typeof usage.output_tokens === "number" ||
		typeof usage.total_tokens === "number";
	if (!hasAnyCount) return null;

	const inputTokens = nonNegativeInteger(usage.input_tokens);
	const rawOutputTokens = nonNegativeInteger(usage.output_tokens);
	const cachedInputTokens = isRecord(usage.input_tokens_details)
		? Math.min(inputTokens, nonNegativeInteger(usage.input_tokens_details.cached_tokens))
		: 0;
	const reasoningTokens = isRecord(usage.output_tokens_details)
		? Math.min(
				rawOutputTokens,
				nonNegativeInteger(usage.output_tokens_details.reasoning_tokens),
			)
		: 0;
	const providedTotal =
		typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
			? Math.max(0, Math.trunc(usage.total_tokens))
			: inputTokens + rawOutputTokens;

	return {
		inputTokens,
		outputTokens: rawOutputTokens - reasoningTokens,
		cachedInputTokens,
		reasoningTokens,
		totalTokens: providedTotal,
	};
}

/**
 * Pull the `usage` object out of a Responses payload, whether it arrived as a
 * bare response object (non-streaming) or wrapped in a stream event envelope.
 */
/**
 * Read the billed service tier off a Responses payload.
 *
 * `service_tier` sits on the response object, not inside `usage`, and a stream
 * event wraps that object one level down. An unrecognised value becomes
 * `unknown` rather than being dropped, because dropping it would price the row
 * at standard rates and under-count a more expensive tier.
 */
function extractServiceTier(payload: Record<string, unknown>): UsageServiceTier | undefined {
	const raw =
		payload.service_tier ??
		(isRecord(payload.response) ? payload.response.service_tier : undefined);
	if (typeof raw !== "string") return undefined;
	const normalized = raw.trim().toLowerCase();
	if (normalized.length === 0) return undefined;
	// `default` is what the API calls the standard tier on the wire.
	if (normalized === "default" || normalized === "standard") return "standard";
	if (
		normalized === "priority" ||
		normalized === "flex" ||
		normalized === "batch" ||
		normalized === "scale"
	) {
		return normalized;
	}
	return "unknown";
}

export function extractResponsesUsage(payload: unknown): UsageTokenCounts | null {
	if (!isRecord(payload)) return null;
	const serviceTier = extractServiceTier(payload);
	const direct = extractUsageTokenCounts(payload.usage);
	if (direct) {
		return serviceTier ? { ...direct, serviceTier } : direct;
	}
	if (isRecord(payload.response)) {
		const nested = extractUsageTokenCounts(payload.response.usage);
		if (!nested) return null;
		return serviceTier ? { ...nested, serviceTier } : nested;
	}
	return null;
}

export interface UsageStreamScanner {
	/** Feed one forwarded chunk. Never throws. */
	push: (chunk: Uint8Array) => void;
	/** Flush any trailing partial data and return the final counts, if any. */
	result: () => UsageTokenCounts | null;
}

/**
 * Observe a forwarded response body and recover its token counts.
 *
 * SSE bodies are scanned line by line so only the current partial line is
 * retained; a full response can be gigabytes of deltas and must never be
 * buffered. Non-SSE JSON bodies have no incremental structure to exploit, so
 * they are accumulated up to `MAX_BUFFERED_BYTES` and parsed at the end —
 * beyond that cap the scanner gives up on usage rather than grow without
 * bound.
 */
export function createUsageStreamScanner(options: {
	contentType?: string | null;
}): UsageStreamScanner {
	const sse = (options.contentType ?? "").toLowerCase().includes("text/event-stream");
	const decoder = new TextDecoder("utf-8");
	let pending = "";
	let bufferedBytes = 0;
	let overflowed = false;
	let latest: UsageTokenCounts | null = null;

	const consumeLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) return;
		const payload = trimmed.slice("data:".length).trim();
		if (payload.length === 0 || payload === "[DONE]") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return;
		}
		// Prefer terminal events, which carry the authoritative totals, but fall
		// back to any event that reports usage so a stream that ends on a
		// non-standard terminal type still records something.
		const type = isRecord(parsed) ? parsed.type : undefined;
		const isTerminal = typeof type === "string" && TERMINAL_EVENT_TYPES.has(type);
		const counts = extractResponsesUsage(parsed);
		if (counts && (isTerminal || latest === null)) {
			latest = counts;
		}
	};

	return {
		push: (chunk) => {
			try {
				if (overflowed || chunk.byteLength === 0) return;
				bufferedBytes += chunk.byteLength;
				pending += decoder.decode(chunk, { stream: true });
				if (!sse) {
					if (bufferedBytes > MAX_BUFFERED_BYTES) {
						overflowed = true;
						pending = "";
					}
					return;
				}
				let newlineAt = pending.indexOf("\n");
				while (newlineAt !== -1) {
					consumeLine(pending.slice(0, newlineAt));
					pending = pending.slice(newlineAt + 1);
					newlineAt = pending.indexOf("\n");
				}
				// A single unterminated line this long is not SSE any more; stop
				// retaining it rather than growing the buffer for the whole body.
				if (pending.length > MAX_BUFFERED_BYTES) {
					overflowed = true;
					pending = "";
				}
			} catch {
				// Usage accounting must never break the forwarded response.
			}
		},
		result: () => {
			try {
				if (overflowed) return latest;
				pending += decoder.decode();
				if (sse) {
					if (pending.length > 0) consumeLine(pending);
					pending = "";
					return latest;
				}
				if (pending.trim().length === 0) return latest;
				const parsed: unknown = JSON.parse(pending);
				pending = "";
				return extractResponsesUsage(parsed) ?? latest;
			} catch {
				return latest;
			}
		},
	};
}
