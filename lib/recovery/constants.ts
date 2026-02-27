/**
 * Constants for session recovery storage paths.
 *
 * Adapted from prior recovery module patterns.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Obtain the base XDG data directory path used for Codex storage.
 *
 * On Windows this prefers the `APPDATA` environment variable and falls back to
 * `%USERPROFILE%\AppData\Roaming`. On other platforms this prefers
 * `XDG_DATA_HOME` and falls back to `~/.local/share`.
 *
 * This function is pure and safe to call concurrently; it reads environment
 * and user home information but does not mutate any state. It does not perform
 * any token redaction or filesystem I/O beyond constructing the path string.
 *
 * @returns The filesystem path to the XDG-style data directory to use for Codex storage
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
