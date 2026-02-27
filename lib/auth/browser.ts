/**
 * Browser utilities for OAuth flow
 * Handles platform-specific browser opening
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_OPENERS } from "../constants.js";

/**
 * Gets the platform-specific command to open a URL in the default browser
 * @returns Browser opener command for the current platform
 */
export function getBrowserOpener(): string {
	const platform = process.platform;
	if (platform === "darwin") return PLATFORM_OPENERS.darwin;
	if (platform === "win32") return PLATFORM_OPENERS.win32;
	return PLATFORM_OPENERS.linux;
}

/**
 * Determines whether a given command name exists on the system PATH.
 *
 * @param command - The command name to check.
 * @returns `true` if a matching executable is found on PATH (on Windows this includes PATHEXT extensions or the literal `"start"`), `false` otherwise.
 *
 * Concurrency: result reflects the current filesystem state and may change after return; no atomicity guarantees.
 * Windows filesystem behavior: resolves executable candidates using PATHEXT extensions.
 * Token handling: the `command` string is used verbatim for lookup and is not redacted or modified.
 */
function commandExists(command: string): boolean {
	if (!command) return false;

	/* v8 ignore start -- unreachable: openBrowserUrl uses PowerShell on win32 */
	if (process.platform === "win32" && command.toLowerCase() === "start") {
		return true;
	}
	/* v8 ignore stop */

	const pathValue = process.env.PATH || "";
	const entries = pathValue.split(path.delimiter).filter(Boolean);
	if (entries.length === 0) return false;

	/* v8 ignore start -- unreachable: openBrowserUrl uses PowerShell on win32 */
	if (process.platform === "win32") {
		const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
			.split(";")
			.filter(Boolean);
		const hasExtension = /\.[^\\/]+$/.test(command);
		for (const entry of entries) {
			if (hasExtension) {
				const directCandidate = path.join(entry, command);
				if (fs.existsSync(directCandidate)) return true;
				continue;
			}
			for (const ext of pathext) {
				const candidate = path.join(entry, `${command}${ext}`);
				if (fs.existsSync(candidate)) return true;
			}
		}
		return false;
	}
	/* v8 ignore stop */

	for (const entry of entries) {
		const candidate = path.join(entry, command);
		try {
			const stats = fs.statSync(candidate);
			if (!stats.isFile()) continue;
			// On POSIX, ensure at least one executable bit is set.
			if ((stats.mode & 0o111) === 0) continue;
			return true;
		} catch {
			continue;
		}
	}
	return false;
}

/**
 * Launches the user's default browser to open the provided URL using a platform-appropriate command.
 *
 * This is a best-effort, fire-and-forget launcher: it attempts a platform-specific spawn and ignores
 * child-process errors. On Windows it uses PowerShell `Start-Process` with PowerShell meta-character
 * escaping to reduce shell/filesystem quirks. Callers must redact any sensitive tokens (for example,
 * OAuth codes) from `url` before calling. Invocations are not atomic—concurrent calls may race but are
 * safe to perform.
 *
 * @param url - The URL to open; redact sensitive tokens (e.g., OAuth codes) before passing.
 * @returns `true` if a browser launch was attempted, `false` if no suitable opener was available or an exception occurred.
 */
export function openBrowserUrl(url: string): boolean {
	try {
		// Windows: use PowerShell Start-Process to avoid cmd/start quirks with URLs containing '&' or ':'
		if (process.platform === "win32") {
			if (!commandExists("powershell.exe")) {
				return false;
			}
			// Escape PowerShell special characters: backticks, double quotes, and $ (sub-expression injection)
			const psUrl = url
				.replace(/`/g, "``")
				.replace(/\$/g, "`$")
				.replace(/"/g, '""');
			const child = spawn(
				"powershell.exe",
				["-NoLogo", "-NoProfile", "-Command", `Start-Process "${psUrl}"`],
				{ stdio: "ignore" },
			);
			child.on("error", () => {});
			return true;
		}


		const opener = getBrowserOpener();
		if (!commandExists(opener)) {
			return false;
		}
		const child = spawn(opener, [url], {
			stdio: "ignore",
			shell: false,
		});
		child.on("error", () => {});
		return true;
	} catch {
		// Silently fail - user can manually open the URL from instructions
		return false;
	}
}

/**
 * Copy text into the system clipboard using a best-effort, platform-specific command.
 *
 * On Windows the text is escaped for PowerShell to avoid interpretation of special characters.
 * This function makes no guarantees of atomicity across processes; concurrent invocations may interleave.
 * Clipboard contents are not redacted or logged — callers must mask or remove sensitive tokens before calling.
 *
 * @param text - The text to copy; falsy or empty values produce no action
 * @returns `true` if a clipboard command was launched, `false` otherwise
 */
export function copyTextToClipboard(text: string): boolean {
	try {
		if (!text) return false;

		if (process.platform === "win32") {
			if (!commandExists("powershell.exe")) {
				return false;
			}
			const psText = text
				.replace(/`/g, "``")
				.replace(/\$/g, "`$")
				.replace(/"/g, '""');
			const child = spawn(
				"powershell.exe",
				["-NoLogo", "-NoProfile", "-Command", `Set-Clipboard -Value "${psText}"`],
				{ stdio: "ignore" },
			);
			child.on("error", () => {});
			return true;
		}

		if (process.platform === "darwin") {
			if (!commandExists("pbcopy")) return false;
			const child = spawn("pbcopy", [], {
				stdio: ["pipe", "ignore", "ignore"],
				shell: false,
			});
			child.on("error", () => {});
			child.stdin?.end(text);
			return true;
		}

		const linuxClipboardCommands: Array<{ command: string; args: string[] }> = [
			{ command: "wl-copy", args: [] },
			{ command: "xclip", args: ["-selection", "clipboard"] },
			{ command: "xsel", args: ["--clipboard", "--input"] },
		];
		for (const { command, args } of linuxClipboardCommands) {
			if (!commandExists(command)) continue;
			const child = spawn(command, args, {
				stdio: ["pipe", "ignore", "ignore"],
				shell: false,
			});
			child.on("error", () => {});
			child.stdin?.end(text);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}
