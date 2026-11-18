/**
 * Shared builder for locally-answered Responses API replies.
 *
 * Both the reactive context-overflow handler (`lib/context-overflow.ts`) and
 * the proactive context budget guard (`lib/context-budget-response.ts`) need
 * to hand the caller a plugin-authored notice instead of forwarding to
 * upstream, in the exact SSE dialect the Codex CLI / Responses client
 * expects. Extracted here so both answer with one audited SSE shape rather
 * than two independently-maintained copies of it.
 */

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

export interface SyntheticSseResponseOptions {
	/** Model id to echo back in the synthetic response, or "unknown". */
	model: string;
	/** Plain-text notice shown to the user as the assistant's message. */
	message: string;
	/** Distinguishes id prefixes across call sites, e.g. "overflow", "context_budget_pause". */
	idPrefix: string;
	/** Value for the `X-Codex-Plugin-Error-Type` response header. */
	errorType: string;
}

/**
 * Build a synthetic OpenAI Responses API SSE stream carrying a single
 * assistant text message, then a terminal `response.completed`.
 *
 * Emits `response.*` events — the dialect the Codex CLI client and this
 * package's own `convertSseToJson` parser speak, not the Anthropic Messages
 * API dialect. Returns 200 OK so the host session never locks on a 4xx for a
 * notice the plugin itself generated.
 */
export function createSyntheticSseResponse(
	options: SyntheticSseResponseOptions,
): Response {
	const { model, message, idPrefix, errorType } = options;
	const messageId = `msg_${idPrefix}_${Date.now()}_${randomSuffix()}`;
	const responseId = `resp_${idPrefix}_${Date.now()}_${randomSuffix()}`;
	const events: string[] = [];

	const push = (type: string, payload: Record<string, unknown>): void => {
		events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
	};

	const baseResponse = {
		id: responseId,
		object: "response",
		model,
	};

	push("response.created", { response: { ...baseResponse, status: "in_progress" } });

	push("response.output_item.added", {
		output_index: 0,
		item: {
			id: messageId,
			type: "message",
			role: "assistant",
			content: [],
		},
	});

	push("response.output_text.delta", {
		output_index: 0,
		content_index: 0,
		delta: message,
	});
	push("response.output_text.done", {
		output_index: 0,
		content_index: 0,
		text: message,
	});

	push("response.completed", {
		response: {
			...baseResponse,
			status: "completed",
			output: [
				{
					id: messageId,
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: message }],
				},
			],
			usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
		},
	});

	return new Response(events.join(""), {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"X-Codex-Plugin-Synthetic": "true",
			"X-Codex-Plugin-Error-Type": errorType,
		},
	});
}
