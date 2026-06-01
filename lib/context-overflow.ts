/**
 * Context Overflow Handler
 * 
 * Handles "Prompt too long" / context length exceeded errors by returning
 * a synthetic SSE response that advises the user to use /compact or /clear.
 * This prevents the host session from getting locked on 400 errors.
 */

import { logDebug } from "./logger.js";

/**
 * Error patterns that indicate context overflow
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  "prompt is too long",
  "prompt_too_long",
  "context length exceeded",
  "context_length_exceeded",
  "maximum context length",
  "token limit exceeded",
  "too many tokens",
];

/**
 * Check if an error body indicates context overflow
 */
export function isContextOverflowError(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  if (!bodyText) return false;
  
  const lowerBody = bodyText.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some(pattern => lowerBody.includes(pattern));
}

/**
 * The message shown to users when context overflow occurs
 */
const CONTEXT_OVERFLOW_MESSAGE = `[Plugin Notice] Context is too long for this model.

Please use one of these commands to reduce context size:

• **/compact** - Compress conversation history (recommended)
• **/clear** - Start fresh with empty context
• **/undo** - Remove recent messages

Then retry your request.

Alternatively, you can switch to a model with a larger context window.`;

/**
 * Creates a synthetic SSE response for context overflow errors.
 *
 * Emits OpenAI **Responses API** SSE (`response.*` events) — the dialect the
 * Codex CLI client and this package's own `convertSseToJson` parser speak. The
 * previous implementation emitted Anthropic Messages API events
 * (`message_start`/`content_block_delta`/`message_stop`), which the Responses
 * client could not parse, so the helpful overflow notice never reached the user
 * (recovery-01). Returns 200 OK so the host session does not lock on the 400.
 */
export function createContextOverflowResponse(model: string = "unknown"): Response {
  const messageId = `msg_synthetic_overflow_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const responseId = `resp_synthetic_overflow_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const events: string[] = [];

  const push = (type: string, payload: Record<string, unknown>): void => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  const baseResponse = {
    id: responseId,
    object: "response",
    model,
  };

  // response.created
  push("response.created", { response: { ...baseResponse, status: "in_progress" } });

  // output item (assistant message) added
  push("response.output_item.added", {
    output_index: 0,
    item: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
    },
  });

  // streamed text + its terminal "done" carrying the final canonical text
  push("response.output_text.delta", {
    output_index: 0,
    content_index: 0,
    delta: CONTEXT_OVERFLOW_MESSAGE,
  });
  push("response.output_text.done", {
    output_index: 0,
    content_index: 0,
    text: CONTEXT_OVERFLOW_MESSAGE,
  });

  // terminal response.completed with the full output array
  push("response.completed", {
    response: {
      ...baseResponse,
      status: "completed",
      output: [
        {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: CONTEXT_OVERFLOW_MESSAGE }],
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
      "X-Codex-Plugin-Error-Type": "context_overflow",
    },
  });
}

/**
 * Check response for context overflow and return synthetic response if needed
 */
export async function handleContextOverflow(
  response: Response,
  model?: string,
): Promise<{ handled: true; response: Response } | { handled: false }> {
  if (response.status !== 400) {
    return { handled: false };
  }

  try {
    const bodyText = await response.clone().text();
    if (isContextOverflowError(response.status, bodyText)) {
		logDebug("Context overflow detected, returning synthetic response");
      return {
        handled: true,
        response: createContextOverflowResponse(model),
      };
    }
  } catch {
    // Ignore read errors
  }

  return { handled: false };
}
