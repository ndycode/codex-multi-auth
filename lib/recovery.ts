import type { PluginInput } from "@opencode-ai/plugin";
import { createLogger } from "./logger.js";
import type { PluginConfig } from "./types.js";
import {
  readParts,
  findMessagesWithThinkingBlocks,
  findMessagesWithOrphanThinking,
  findMessageByIndexNeedingThinking,
  prependThinkingPart,
  stripThinkingParts,
} from "./recovery/storage.js";
import type {
  MessageInfo,
  MessageData,
  MessagePart,
  RecoveryErrorType,
  ResumeConfig,
  ToolResultPart,
} from "./recovery/types.js";

export type { RecoveryErrorType, MessageInfo, MessageData, ResumeConfig };

type PluginClient = PluginInput["client"];
type SessionPromptArgs = Parameters<PluginClient["session"]["prompt"]>[0];

const RECOVERY_RESUME_TEXT = "[session recovered - continuing previous task]";

function getErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error.toLowerCase();

  const errorObj = error as Record<string, unknown>;
  const paths = [
    errorObj.data,
    errorObj.error,
    errorObj,
    (errorObj.data as Record<string, unknown>)?.error,
  ];

  for (const obj of paths) {
    if (obj && typeof obj === "object") {
      const msg = (obj as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.length > 0) {
        return msg.toLowerCase();
      }
    }
  }

  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return "";
  }
}

function extractMessageIndex(error: unknown): number | null {
  const message = getErrorMessage(error);
  const match = message.match(/messages\.(\d+)/);
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10);
}

export function detectErrorType(error: unknown): RecoveryErrorType {
  const message = getErrorMessage(error);

  if (message.includes("tool_use") && message.includes("tool_result")) {
    return "tool_result_missing";
  }

  if (
    message.includes("thinking") &&
    (message.includes("first block") ||
      message.includes("must start with") ||
      message.includes("preceeding") ||
      (message.includes("expected") && message.includes("found")))
  ) {
    return "thinking_block_order";
  }

  if (message.includes("thinking is disabled") && message.includes("cannot contain")) {
    return "thinking_disabled_violation";
  }

  return null;
}

export function isRecoverableError(error: unknown): boolean {
  return detectErrorType(error) !== null;
}

interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function extractToolUseIds(parts: MessagePart[]): string[] {
  return parts
    .filter((p): p is ToolUsePart & MessagePart => p.type === "tool_use" && !!p.id)
    .map((p) => p.id as string);
}

async function sendToolResultsForRecovery(
  client: PluginClient,
  sessionID: string,
  toolResultParts: ToolResultPart[],
): Promise<void> {
  const bodyWithParts = {
    parts: toolResultParts,
  } as SessionPromptArgs["body"] & { parts: ToolResultPart[] };

  await client.session.prompt({
    path: { id: sessionID },
    body: bodyWithParts as SessionPromptArgs["body"],
  });
}

async function recoverToolResultMissing(
  client: PluginClient,
  sessionID: string,
  failedMsg: MessageData
): Promise<boolean> {
  let parts = failedMsg.parts || [];
  if (parts.length === 0 && failedMsg.info?.id) {
    const storedParts = readParts(failedMsg.info.id);
    parts = storedParts.map((p) => ({
      type: p.type === "tool" ? "tool_use" : p.type,
      id: "callID" in p ? (p as { callID?: string }).callID : p.id,
      name: "tool" in p ? (p as { tool?: string }).tool : undefined,
      input: "state" in p ? (p as { state?: { input?: Record<string, unknown> } }).state?.input : undefined,
    }));
  }

  const toolUseIds = extractToolUseIds(parts);

  if (toolUseIds.length === 0) {
    return false;
  }

  const toolResultParts: ToolResultPart[] = toolUseIds.map((id) => ({
    type: "tool_result" as const,
    tool_use_id: id,
    content: "Operation cancelled by user (ESC pressed)",
  }));

  try {
    await sendToolResultsForRecovery(client, sessionID, toolResultParts);

    return true;
  } catch {
    return false;
  }
}

function recoverThinkingBlockOrder(
  sessionID: string,
  _failedMsg: MessageData,
  error: unknown
): boolean {
  const targetIndex = extractMessageIndex(error);
  if (targetIndex !== null) {
    const targetMessageID = findMessageByIndexNeedingThinking(sessionID, targetIndex);
    if (targetMessageID) {
      return prependThinkingPart(sessionID, targetMessageID);
    }
  }

  const orphanMessages = findMessagesWithOrphanThinking(sessionID);

  if (orphanMessages.length === 0) {
    return false;
  }

  let anySuccess = false;
  for (const messageID of orphanMessages) {
    if (prependThinkingPart(sessionID, messageID)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

function recoverThinkingDisabledViolation(
  sessionID: string,
  _failedMsg: MessageData
): boolean {
  const messagesWithThinking = findMessagesWithThinkingBlocks(sessionID);

  if (messagesWithThinking.length === 0) {
    return false;
  }

  let anySuccess = false;
  for (const messageID of messagesWithThinking) {
    if (stripThinkingParts(messageID)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

function findLastUserMessage(messages: MessageData[]): MessageData | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user") {
      return messages[i];
    }
  }
  return undefined;
}

function extractResumeConfig(userMessage: MessageData | undefined, sessionID: string): ResumeConfig {
  return {
    sessionID,
    agent: userMessage?.info?.agent,
    model: userMessage?.info?.model,
  };
}

async function resumeSession(
  client: PluginClient,
  config: ResumeConfig,
  directory: string
): Promise<boolean> {
  try {
    await client.session.prompt({
      path: { id: config.sessionID },
      body: {
        parts: [{ type: "text", text: RECOVERY_RESUME_TEXT }],
        agent: config.agent,
        model: config.model,
      },
      query: { directory },
    });
    return true;
  } catch {
    return false;
  }
}

const TOAST_TITLES: Record<string, string> = {
  tool_result_missing: "Tool Crash Recovery",
  thinking_block_order: "Thinking Block Recovery",
  thinking_disabled_violation: "Thinking Strip Recovery",
};

const TOAST_MESSAGES: Record<string, string> = {
  tool_result_missing: "Injecting cancelled tool results...",
  thinking_block_order: "Fixing message structure...",
  thinking_disabled_violation: "Stripping thinking blocks...",
};

export function getRecoveryToastContent(errorType: RecoveryErrorType): {
  title: string;
  message: string;
} {
  if (!errorType) {
    return {
      title: "Session Recovery",
      message: "Attempting to recover session...",
    };
  }
  return {
    title: TOAST_TITLES[errorType] || "Session Recovery",
    message: TOAST_MESSAGES[errorType] || "Attempting to recover session...",
  };
}

export function getRecoverySuccessToast(): {
  title: string;
  message: string;
} {
  return {
    title: "Session Recovered",
    message: "Continuing where you left off...",
  };
}

export function getRecoveryFailureToast(): {
  title: string;
  message: string;
} {
  return {
    title: "Recovery Failed",
    message: "Please retry or start a new session.",
  };
}

export interface SessionRecoveryHook {
  handleSessionRecovery: (info: MessageInfo) => Promise<boolean>;
  isRecoverableError: (error: unknown) => boolean;
  setOnAbortCallback: (callback: (sessionID: string) => void) => void;
  setOnRecoveryCompleteCallback: (callback: (sessionID: string) => void) => void;
}

export interface SessionRecoveryContext {
  client: PluginClient;
  directory: string;
}

export function createSessionRecoveryHook(
  ctx: SessionRecoveryContext,
  config: PluginConfig
): SessionRecoveryHook | null {
  if (!config.sessionRecovery) {
    return null;
  }

  const { client, directory } = ctx;
  const processingErrors = new Set<string>();
  let onAbortCallback: ((sessionID: string) => void) | null = null;
  let onRecoveryCompleteCallback: ((sessionID: string) => void) | null = null;

  const setOnAbortCallback = (callback: (sessionID: string) => void): void => {
    onAbortCallback = callback;
  };

  const setOnRecoveryCompleteCallback = (callback: (sessionID: string) => void): void => {
    onRecoveryCompleteCallback = callback;
  };

  const handleSessionRecovery = async (info: MessageInfo): Promise<boolean> => {
    if (!info || info.role !== "assistant" || !info.error) return false;

    const errorType = detectErrorType(info.error);
    if (!errorType) return false;

    const sessionID = info.sessionID;
    if (!sessionID) return false;

    let assistantMsgID = info.id;
    const log = createLogger("session-recovery");

    log.debug("Recovery attempt started", {
      errorType,
      sessionID,
      providedMsgID: assistantMsgID ?? "none",
    });

    if (onAbortCallback) {
      onAbortCallback(sessionID);
    }

    await client.session.abort({ path: { id: sessionID } }).catch(() => {});

    const messagesResp = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    const msgs = (messagesResp as { data?: MessageData[] }).data;

    if (!assistantMsgID && msgs && msgs.length > 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.info?.role === "assistant" && m.info?.id) {
          assistantMsgID = m.info.id;
          log.debug("Found assistant message ID from session messages", {
            msgID: assistantMsgID,
            msgIndex: i,
          });
          break;
        }
      }
    }

    if (!assistantMsgID) {
      log.debug("No assistant message ID found, cannot recover");
      return false;
    }
    if (processingErrors.has(assistantMsgID)) return false;
    processingErrors.add(assistantMsgID);

    try {
      const failedMsg = msgs?.find((m) => m.info?.id === assistantMsgID);
      if (!failedMsg) {
        return false;
      }

      const toastContent = getRecoveryToastContent(errorType);
      await client.tui
        .showToast({
          body: {
            title: toastContent.title,
            message: toastContent.message,
            variant: "warning",
          },
        })
        .catch(() => {});

      let success = false;

      if (errorType === "tool_result_missing") {
        success = await recoverToolResultMissing(client, sessionID, failedMsg);
      } else if (errorType === "thinking_block_order") {
        success = recoverThinkingBlockOrder(sessionID, failedMsg, info.error);
        if (success && config.autoResume) {
          const lastUser = findLastUserMessage(msgs ?? []);
          const resumeConfig = extractResumeConfig(lastUser, sessionID);
          await resumeSession(client, resumeConfig, directory);
        }
      } else if (errorType === "thinking_disabled_violation") {
        success = recoverThinkingDisabledViolation(sessionID, failedMsg);
        if (success && config.autoResume) {
          const lastUser = findLastUserMessage(msgs ?? []);
          const resumeConfig = extractResumeConfig(lastUser, sessionID);
          await resumeSession(client, resumeConfig, directory);
        }
      }

      return success;
    } catch (err) {
      log.error("Recovery failed", { error: String(err) });
      return false;
    } finally {
      processingErrors.delete(assistantMsgID);

      if (sessionID && onRecoveryCompleteCallback) {
        onRecoveryCompleteCallback(sessionID);
      }
    }
  };

  return {
    handleSessionRecovery,
    isRecoverableError,
    setOnAbortCallback,
    setOnRecoveryCompleteCallback,
  };
}
