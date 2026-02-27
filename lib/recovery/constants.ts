/**
 * Constants for session recovery storage paths.
 *
 * Adapted from prior recovery module patterns.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Determine the base XDG-style data directory used for Codex storage.
 *
 * This function is pure and side-effect free; it is safe to call concurrently from multiple processes.
 * On Windows it prefers the APPDATA environment variable and falls back to the user's AppData/Roaming directory.
 * On other platforms it prefers XDG_DATA_HOME and falls back to ~/.local/share.
 * Returned paths may include the user's home directory; callers should redact or avoid logging any sensitive tokens contained in file names or paths.
 *
 * @returns The filesystem path to use as the base data directory for Codex storage.
 */
function getXdgData(): string {
  const platform = process.platform;

  if (platform === "win32") {
    return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  }

  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export const CODEX_STORAGE = join(getXdgData(), "codex", "storage");
export const MESSAGE_STORAGE = join(CODEX_STORAGE, "message");
export const PART_STORAGE = join(CODEX_STORAGE, "part");

export const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
export const META_TYPES = new Set(["step-start", "step-finish"]);
export const CONTENT_TYPES = new Set(["text", "tool", "tool_use", "tool_result"]);
