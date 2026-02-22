import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectErrorType,
  isRecoverableError,
  getRecoveryToastContent,
  getRecoverySuccessToast,
  getRecoveryFailureToast,
  createSessionRecoveryHook,
} from "../lib/recovery";

vi.mock("../lib/recovery/storage.js", () => ({
  readParts: vi.fn(() => []),
  findMessagesWithThinkingBlocks: vi.fn(() => []),
  findMessagesWithOrphanThinking: vi.fn(() => []),
  findMessageByIndexNeedingThinking: vi.fn(() => null),
  prependThinkingPart: vi.fn(() => false),
  stripThinkingParts: vi.fn(() => false),
}));

import {
  readParts,
  findMessagesWithThinkingBlocks,
  findMessagesWithOrphanThinking,
  findMessageByIndexNeedingThinking,
  prependThinkingPart,
  stripThinkingParts,
} from "../lib/recovery/storage.js";

const mockedReadParts = vi.mocked(readParts);
const mockedFindMessagesWithThinkingBlocks = vi.mocked(findMessagesWithThinkingBlocks);
const mockedFindMessagesWithOrphanThinking = vi.mocked(findMessagesWithOrphanThinking);
const mockedFindMessageByIndexNeedingThinking = vi.mocked(findMessageByIndexNeedingThinking);
const mockedPrependThinkingPart = vi.mocked(prependThinkingPart);
const mockedStripThinkingParts = vi.mocked(stripThinkingParts);

function createMockClient() {
  return {
    session: {
      prompt: vi.fn().mockResolvedValue({}),
      abort: vi.fn().mockResolvedValue({}),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("detectErrorType", () => {
  describe("tool_result_missing detection", () => {
    it("detects tool_use without tool_result error", () => {
      const error = {
        type: "invalid_request_error",
        message: "messages.105: `tool_use` ids were found without `tool_result` blocks immediately after: tool-call-59"
      };
      expect(detectErrorType(error)).toBe("tool_result_missing");
    });

    it("detects tool_use/tool_result mismatch error", () => {
      const error = "Each `tool_use` block must have a corresponding `tool_result` block in the next message.";
      expect(detectErrorType(error)).toBe("tool_result_missing");
    });

    it("detects error from string message", () => {
      const error = "tool_use without matching tool_result";
      expect(detectErrorType(error)).toBe("tool_result_missing");
    });
  });

  describe("thinking_block_order detection", () => {
    it("detects thinking first block error", () => {
      const error = "thinking must be the first block in the message";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });

    it("detects thinking must start with error", () => {
      const error = "Response must start with thinking block";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });

    it("detects thinking preceeding error", () => {
      const error = "thinking block preceeding tool use is required";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });

    it("detects thinking expected/found error", () => {
      const error = "Expected thinking block but found text";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });
  });

  describe("thinking_disabled_violation detection", () => {
    it("detects thinking disabled error", () => {
      const error = "thinking is disabled for this model and cannot contain thinking blocks";
      expect(detectErrorType(error)).toBe("thinking_disabled_violation");
    });
  });

  describe("non-recoverable errors", () => {
    it("returns null for prompt too long error", () => {
      const error = { message: "Prompt is too long" };
      expect(detectErrorType(error)).toBeNull();
    });

    it("returns null for context length exceeded error", () => {
      const error = "context length exceeded";
      expect(detectErrorType(error)).toBeNull();
    });

    it("returns null for generic errors", () => {
      expect(detectErrorType("Something went wrong")).toBeNull();
      expect(detectErrorType({ message: "Unknown error" })).toBeNull();
      expect(detectErrorType(null)).toBeNull();
      expect(detectErrorType(undefined)).toBeNull();
    });

    it("returns null for rate limit errors", () => {
      const error = { message: "Rate limit exceeded. Retry after 5s" };
      expect(detectErrorType(error)).toBeNull();
    });

    it("handles error with circular reference gracefully (line 50 coverage)", () => {
      const circularError: Record<string, unknown> = { name: "CircularError" };
      circularError.self = circularError;
      expect(detectErrorType(circularError)).toBeNull();
    });
  });
});

describe("isRecoverableError", () => {
  it("returns true for tool_result_missing", () => {
    const error = "tool_use without tool_result";
    expect(isRecoverableError(error)).toBe(true);
  });

  it("returns true for thinking_block_order", () => {
    const error = "thinking must be the first block";
    expect(isRecoverableError(error)).toBe(true);
  });

  it("returns true for thinking_disabled_violation", () => {
    const error = "thinking is disabled and cannot contain thinking";
    expect(isRecoverableError(error)).toBe(true);
  });

  it("returns false for non-recoverable errors", () => {
    expect(isRecoverableError("Prompt is too long")).toBe(false);
    expect(isRecoverableError("context length exceeded")).toBe(false);
    expect(isRecoverableError("Generic error")).toBe(false);
    expect(isRecoverableError(null)).toBe(false);
  });
});

describe("context error message patterns", () => {
  describe("prompt too long patterns", () => {
    const promptTooLongPatterns = [
      "Prompt is too long",
      "prompt is too long for this model",
      "The prompt is too long",
    ];

    it.each(promptTooLongPatterns)("'%s' is not a recoverable error", (msg) => {
      expect(isRecoverableError(msg)).toBe(false);
      expect(detectErrorType(msg)).toBeNull();
    });
  });

  describe("context length exceeded patterns", () => {
    const contextLengthPatterns = [
      "context length exceeded",
      "context_length_exceeded",
      "maximum context length",
      "exceeds the maximum context window",
    ];

    it.each(contextLengthPatterns)("'%s' is not a recoverable error", (msg) => {
      expect(isRecoverableError(msg)).toBe(false);
      expect(detectErrorType(msg)).toBeNull();
    });
  });

  describe("tool pairing error patterns", () => {
    const toolPairingPatterns = [
      "tool_use ids were found without tool_result blocks immediately after",
      "Each tool_use block must have a corresponding tool_result",
      "tool_use without matching tool_result",
    ];

    it.each(toolPairingPatterns)("'%s' is detected as tool_result_missing", (msg) => {
      expect(detectErrorType(msg)).toBe("tool_result_missing");
      expect(isRecoverableError(msg)).toBe(true);
    });
  });
});

describe("getRecoveryToastContent", () => {
  it("returns tool crash recovery for tool_result_missing", () => {
    const content = getRecoveryToastContent("tool_result_missing");
    expect(content.title).toBe("Tool Crash Recovery");
    expect(content.message).toBe("Injecting cancelled tool results...");
  });

  it("returns thinking block recovery for thinking_block_order", () => {
    const content = getRecoveryToastContent("thinking_block_order");
    expect(content.title).toBe("Thinking Block Recovery");
    expect(content.message).toBe("Fixing message structure...");
  });

  it("returns thinking strip recovery for thinking_disabled_violation", () => {
    const content = getRecoveryToastContent("thinking_disabled_violation");
    expect(content.title).toBe("Thinking Strip Recovery");
    expect(content.message).toBe("Stripping thinking blocks...");
  });

  it("returns generic recovery for null error type", () => {
    const content = getRecoveryToastContent(null);
    expect(content.title).toBe("Session Recovery");
    expect(content.message).toBe("Attempting to recover session...");
  });
});

describe("getRecoverySuccessToast", () => {
  it("returns success toast content", () => {
    const content = getRecoverySuccessToast();
    expect(content.title).toBe("Session Recovered");
    expect(content.message).toBe("Continuing where you left off...");
  });
});

describe("getRecoveryFailureToast", () => {
  it("returns failure toast content", () => {
    const content = getRecoveryFailureToast();
    expect(content.title).toBe("Recovery Failed");
    expect(content.message).toBe("Please retry or start a new session.");
  });
});

describe("createSessionRecoveryHook", () => {
  it("returns null when sessionRecovery is disabled", () => {
    const ctx = { client: {} as never, directory: "/test" };
    const config = { sessionRecovery: false, autoResume: false };
    const hook = createSessionRecoveryHook(ctx, config);
    expect(hook).toBeNull();
  });

  it("returns hook object when sessionRecovery is enabled", () => {
    const ctx = { client: {} as never, directory: "/test" };
    const config = { sessionRecovery: true, autoResume: false };
    const hook = createSessionRecoveryHook(ctx, config);
    expect(hook).not.toBeNull();
    expect(hook?.handleSessionRecovery).toBeTypeOf("function");
    expect(hook?.isRecoverableError).toBeTypeOf("function");
    expect(hook?.setOnAbortCallback).toBeTypeOf("function");
    expect(hook?.setOnRecoveryCompleteCallback).toBeTypeOf("function");
  });

  it("hook.isRecoverableError delegates to module function", () => {
    const ctx = { client: {} as never, directory: "/test" };
    const config = { sessionRecovery: true, autoResume: false };
    const hook = createSessionRecoveryHook(ctx, config);
    expect(hook?.isRecoverableError("tool_use without tool_result")).toBe(true);
    expect(hook?.isRecoverableError("generic error")).toBe(false);
  });
});

describe("error message extraction edge cases", () => {
  it("handles nested error.data.error structure", () => {
    const error = {
      data: {
        error: {
          message: "tool_use without tool_result found"
        }
      }
    };
    expect(detectErrorType(error)).toBe("tool_result_missing");
  });

  it("handles error.data.message structure", () => {
    const error = {
      data: {
        message: "thinking must be the first block"
      }
    };
    expect(detectErrorType(error)).toBe("thinking_block_order");
  });

  it("handles deeply nested error objects", () => {
    const error = {
      error: {
        message: "thinking is disabled and cannot contain thinking blocks"
      }
    };
    expect(detectErrorType(error)).toBe("thinking_disabled_violation");
  });

  it("falls back to JSON stringify for non-standard errors", () => {
    const error = { custom: "tool_use without tool_result" };
    expect(detectErrorType(error)).toBe("tool_result_missing");
  });

  it("handles empty object", () => {
    expect(detectErrorType({})).toBeNull();
  });

  it("handles number input", () => {
    expect(detectErrorType(42)).toBeNull();
  });

  it("handles array input", () => {
    expect(detectErrorType(["tool_use", "tool_result"])).toBe("tool_result_missing");
  });
});

describe("handleSessionRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when info is null", async () => {
    const client = createMockClient();
    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );
    const result = await hook?.handleSessionRecovery(null as never);
    expect(result).toBe(false);
  });

  it("returns false when role is not assistant", async () => {
    const client = createMockClient();
    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );
    const result = await hook?.handleSessionRecovery({
      role: "user",
      error: "tool_use without tool_result",
      sessionID: "session-1",
    } as never);
    expect(result).toBe(false);
  });

  it("returns false when no error property", async () => {
    const client = createMockClient();
    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );
    const result = await hook?.handleSessionRecovery({
      role: "assistant",
      sessionID: "session-1",
    } as never);
    expect(result).toBe(false);
  });

  it("returns false when error is not recoverable", async () => {
    const client = createMockClient();
    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );
    const result = await hook?.handleSessionRecovery({
      role: "assistant",
      error: "generic error that is not recoverable",
      sessionID: "session-1",
    } as never);
    expect(result).toBe(false);
  });

  it("returns false when sessionID is missing", async () => {
    const client = createMockClient();
    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );
    const result = await hook?.handleSessionRecovery({
      role: "assistant",
      error: "tool_use without tool_result",
    } as never);
    expect(result).toBe(false);
  });

  it("calls onAbortCallback when set", async () => {
    const client = createMockClient();
    client.session.messages.mockResolvedValue({
      data: [{
        info: { id: "msg-1", role: "assistant" },
        parts: [],
      }],
    });

    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );

    const abortCallback = vi.fn();
    hook?.setOnAbortCallback(abortCallback);

    await hook?.handleSessionRecovery({
      role: "assistant",
      error: "tool_use without tool_result",
      sessionID: "session-1",
      id: "msg-1",
    } as never);

    expect(abortCallback).toHaveBeenCalledWith("session-1");
  });

  it("calls session.abort on recovery", async () => {
    const client = createMockClient();
    client.session.messages.mockResolvedValue({
      data: [{
        info: { id: "msg-1", role: "assistant" },
        parts: [],
      }],
    });

    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );

    await hook?.handleSessionRecovery({
      role: "assistant",
      error: "tool_use without tool_result",
      sessionID: "session-1",
      id: "msg-1",
    } as never);

    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "session-1" } });
  });

  it("shows toast notification on recovery attempt", async () => {
    const client = createMockClient();
    client.session.messages.mockResolvedValue({
      data: [{
        info: { id: "msg-1", role: "assistant" },
        parts: [],
      }],
    });

    const hook = createSessionRecoveryHook(
      { client: client as never, directory: "/test" },
      { sessionRecovery: true, autoResume: false }
    );

    await hook?.handleSessionRecovery({
      role: "assistant",
      error: "tool_use without tool_result",
      sessionID: "session-1",
      id: "msg-1",
    } as never);

    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: {
        title: "Tool Crash Recovery",
        message: "Injecting cancelled tool results...",
        variant: "warning",
      },
    });
  });

  describe("tool_result_missing recovery", () => {
    it("injects tool_result parts for tool_use parts in message", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [
            { type: "tool_use", id: "tool-1", name: "read" },
            { type: "tool_use", id: "tool-2", name: "write" },
          ],
        }],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(true);
      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: "session-1" },
        body: {
          parts: [
            { type: "tool_result", tool_use_id: "tool-1", content: "Operation cancelled by user (ESC pressed)" },
            { type: "tool_result", tool_use_id: "tool-2", content: "Operation cancelled by user (ESC pressed)" },
          ],
        },
      });
    });

    it("reads parts from storage when parts array is empty", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [],
        }],
      });

      mockedReadParts.mockReturnValue([
        { type: "tool", callID: "tool-1", tool: "read" },
        { type: "tool", callID: "tool-2", tool: "write" },
      ] as never);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(mockedReadParts).toHaveBeenCalledWith("msg-1");
      expect(result).toBe(true);
    });

    it("returns false when no tool_use parts found", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [{ type: "text", text: "Hello" }],
        }],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(false);
    });

    it("returns false when prompt injection fails", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [{ type: "tool_use", id: "tool-1", name: "read" }],
        }],
      });
      client.session.prompt.mockRejectedValue(new Error("Prompt failed"));

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(false);
    });
  });

  describe("thinking_block_order recovery", () => {
    it("uses message index from error to find target message", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [],
        }],
      });

      mockedFindMessageByIndexNeedingThinking.mockReturnValue("msg-target");
      mockedPrependThinkingPart.mockReturnValue(true);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "messages.5: thinking must be the first block",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(mockedFindMessageByIndexNeedingThinking).toHaveBeenCalledWith("session-1", 5);
      expect(mockedPrependThinkingPart).toHaveBeenCalledWith("session-1", "msg-target");
      expect(result).toBe(true);
    });

    it("falls back to findMessagesWithOrphanThinking when no index", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [],
        }],
      });

      mockedFindMessageByIndexNeedingThinking.mockReturnValue(null);
      mockedFindMessagesWithOrphanThinking.mockReturnValue(["orphan-1", "orphan-2"]);
      mockedPrependThinkingPart.mockReturnValue(true);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "thinking must be the first block",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(mockedFindMessagesWithOrphanThinking).toHaveBeenCalledWith("session-1");
      expect(mockedPrependThinkingPart).toHaveBeenCalledTimes(2);
      expect(result).toBe(true);
    });

    it("returns false when no orphan messages found", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [],
        }],
      });

      mockedFindMessageByIndexNeedingThinking.mockReturnValue(null);
      mockedFindMessagesWithOrphanThinking.mockReturnValue([]);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "thinking must be the first block",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(false);
    });

    it("resumes session when autoResume is enabled", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [
          { info: { id: "msg-0", role: "user", agent: "build", model: "gpt-5" } },
          { info: { id: "msg-1", role: "assistant" }, parts: [] },
        ],
      });

      mockedFindMessageByIndexNeedingThinking.mockReturnValue("msg-target");
      mockedPrependThinkingPart.mockReturnValue(true);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: true }
      );

      await hook?.handleSessionRecovery({
        role: "assistant",
        error: "messages.1: thinking must be the first block",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: "session-1" },
        body: {
          parts: [{ type: "text", text: "[session recovered - continuing previous task]" }],
          agent: "build",
          model: "gpt-5",
        },
        query: { directory: "/test" },
      });
    });
  });

  describe("thinking_disabled_violation recovery", () => {
    it("strips thinking blocks from messages", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [],
        }],
      });

      mockedFindMessagesWithThinkingBlocks.mockReturnValue(["msg-with-thinking-1", "msg-with-thinking-2"]);
      mockedStripThinkingParts.mockReturnValue(true);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "thinking is disabled and cannot contain thinking blocks",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(mockedFindMessagesWithThinkingBlocks).toHaveBeenCalledWith("session-1");
      expect(mockedStripThinkingParts).toHaveBeenCalledTimes(2);
      expect(result).toBe(true);
    });

    it("returns false when no messages with thinking blocks found", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [],
        }],
      });

      mockedFindMessagesWithThinkingBlocks.mockReturnValue([]);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "thinking is disabled and cannot contain thinking blocks",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(false);
    });

    it("resumes session when autoResume is enabled", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [
          { info: { id: "msg-0", role: "user", agent: "explore", model: "gpt-5.1" } },
          { info: { id: "msg-1", role: "assistant" }, parts: [] },
        ],
      });

      mockedFindMessagesWithThinkingBlocks.mockReturnValue(["msg-1"]);
      mockedStripThinkingParts.mockReturnValue(true);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: true }
      );

      await hook?.handleSessionRecovery({
        role: "assistant",
        error: "thinking is disabled and cannot contain thinking blocks",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: "session-1" },
        body: {
          parts: [{ type: "text", text: "[session recovered - continuing previous task]" }],
          agent: "explore",
          model: "gpt-5.1",
        },
        query: { directory: "/test" },
      });
    });
  });

  describe("callback handling", () => {
    it("calls onRecoveryCompleteCallback on success", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [{ type: "tool_use", id: "tool-1", name: "read" }],
        }],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const completeCallback = vi.fn();
      hook?.setOnRecoveryCompleteCallback(completeCallback);

      await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(completeCallback).toHaveBeenCalledWith("session-1");
    });

    it("calls onRecoveryCompleteCallback on failure", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [],
        }],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const completeCallback = vi.fn();
      hook?.setOnRecoveryCompleteCallback(completeCallback);

      await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(completeCallback).toHaveBeenCalledWith("session-1");
    });
  });

  describe("deduplication", () => {
    it("prevents duplicate processing of same message ID", async () => {
      const client = createMockClient();
      
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
      
      client.session.messages.mockImplementation(async () => {
        await firstPromise;
        return {
          data: [{
            info: { id: "msg-1", role: "assistant" },
            parts: [{ type: "tool_use", id: "tool-1", name: "read" }],
          }],
        };
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const info = {
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never;

      const first = hook?.handleSessionRecovery(info);
      const second = hook?.handleSessionRecovery(info);

      resolveFirst!();

      const [result1, result2] = await Promise.all([first, second]);

      expect(result1).toBe(true);
      expect(result2).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns false when failed message not found in session", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "different-msg", role: "assistant" },
          parts: [],
        }],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(false);
    });

    it("finds assistant message ID from session when not provided", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [
          { info: { id: "msg-user", role: "user" }, parts: [] },
          { info: { id: "msg-assistant", role: "assistant" }, parts: [{ type: "tool_use", id: "tool-1" }] },
        ],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
      } as never);

      expect(result).toBe(true);
    });

    it("returns false when no assistant message found and none in session", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [
          { info: { id: "msg-user", role: "user" }, parts: [] },
        ],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
      } as never);

      expect(result).toBe(false);
    });

    it("handles exception in recovery logic gracefully", async () => {
      const client = createMockClient();
      client.session.abort.mockResolvedValue({});
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [{ type: "tool_use", id: "tool-1", name: "read" }],
        }],
      });
      client.tui.showToast.mockRejectedValue(new Error("Toast error"));
      client.session.prompt.mockRejectedValue(new Error("Prompt error"));

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(false);
    });

    it("filters out tool_use parts with falsy id (line 98 coverage)", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{
          info: { id: "msg-1", role: "assistant" },
          parts: [
            { type: "tool_use", id: "", name: "read" },
            { type: "tool_use", name: "write" },
            { type: "tool_use", id: null, name: "delete" },
            { type: "tool_use", id: "valid-id", name: "exec" },
          ],
        }],
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "tool_use without tool_result",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(true);
      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: "session-1" },
        body: {
          parts: [
            { type: "tool_result", tool_use_id: "valid-id", content: "Operation cancelled by user (ESC pressed)" },
          ],
        },
      });
    });

    it("continues recovery when resumeSession fails (line 226 coverage)", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [
          { info: { id: "msg-0", role: "user", agent: "build", model: "gpt-5" } },
          { info: { id: "msg-1", role: "assistant" }, parts: [] },
        ],
      });

      mockedFindMessageByIndexNeedingThinking.mockReturnValue("msg-target");
      mockedPrependThinkingPart.mockReturnValue(true);
      client.session.prompt.mockRejectedValue(new Error("Resume prompt failed"));

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: true }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "messages.1: thinking must be the first block",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(mockedPrependThinkingPart).toHaveBeenCalled();
      expect(client.session.prompt).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("handles session with no user messages (line 198 coverage)", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [
          { info: { id: "msg-0", role: "assistant" }, parts: [] },
          { info: { id: "msg-1", role: "assistant" }, parts: [] },
        ],
      });

      mockedFindMessageByIndexNeedingThinking.mockReturnValue("msg-target");
      mockedPrependThinkingPart.mockReturnValue(true);

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: true }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "messages.1: thinking must be the first block",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(true);
      const promptCall = client.session.prompt.mock.calls[0];
      expect(promptCall[0].body.agent).toBeUndefined();
      expect(promptCall[0].body.model).toBeUndefined();
    });

    it("returns false when thinking_disabled_violation recovery throws (lines 401-402 coverage)", async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [
          { info: { id: "msg-1", role: "assistant" }, parts: [] },
        ],
      });

      mockedFindMessagesWithThinkingBlocks.mockImplementation(() => {
        throw new Error("Storage access error");
      });

      const hook = createSessionRecoveryHook(
        { client: client as never, directory: "/test" },
        { sessionRecovery: true, autoResume: false }
      );

      const result = await hook?.handleSessionRecovery({
        role: "assistant",
        error: "thinking is disabled and cannot contain thinking blocks",
        sessionID: "session-1",
        id: "msg-1",
      } as never);

      expect(result).toBe(false);
      mockedFindMessagesWithThinkingBlocks.mockReturnValue([]);
    });
  });
});
