/**
 * Context Overflow Handler
 * 
 * Handles "Prompt too long" / context length exceeded errors by returning
 * a synthetic SSE response that advises the user to use /compact or /clear.
 * This prevents the OpenCode session from getting locked on 400 errors.
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
 * This returns a 200 OK with the error message as assistant text,
 * preventing the session from getting locked.
 */
export function createContextOverflowResponse(model: string = "unknown"): Response {
  const messageId = `msg_synthetic_overflow_${Date.now()}`;
  const events: string[] = [];

  // message_start
  events.push(`event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`);

  // content_block_start
  events.push(`event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })}\n\n`);

  // content_block_delta (the actual message)
  events.push(`event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: CONTEXT_OVERFLOW_MESSAGE },
  })}\n\n`);

  // content_block_stop
  events.push(`event: content_block_stop\ndata: ${JSON.stringify({
    type: "content_block_stop",
    index: 0,
  })}\n\n`);

  // message_delta (end_turn)
  events.push(`event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 0 },
  })}\n\n`);

  // message_stop
  events.push(`event: message_stop\ndata: ${JSON.stringify({
    type: "message_stop",
  })}\n\n`);

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
