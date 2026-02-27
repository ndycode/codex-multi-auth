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
		for (const entry of entries) {
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
		if (fs.existsSync(candidate)) return true;
	}
	return false;
}

/**
 * Attempts to open the given URL in the system default browser.
 *
 * Concurrency: this function launches a detached child process and does not wait for completion; calling it concurrently is safe. On Windows the URL is sanitized for PowerShell quoting rules but not redacted. The function does not modify or redact any sensitive tokens that may be present in the URL.
 *
 * @param url - The URL to open; may contain query tokens or sensitive data which will not be redacted by this function.
 * @returns `true` if a browser launch was attempted, `false` otherwise.
 */
export function openBrowserUrl(url: string): boolean {
	try {
		// Windows: use PowerShell Start-Process to avoid cmd/start quirks with URLs containing '&' or ':'
		if (process.platform === "win32") {
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
 * Attempts to copy the provided string to the system clipboard using platform-appropriate utilities.
 *
 * This is a best-effort, fire-and-forget operation: child processes are launched and errors are ignored, so concurrent calls are safe but success is only indicated by whether a clipboard command was started. On Windows the text is escaped for PowerShell before launching Set-Clipboard. This function does not redact secrets; callers must remove or mask tokens/credentials before calling.
 *
 * @param text - The string to copy; empty or falsy values are ignored
 * @returns `true` if a platform clipboard command was launched, `false` otherwise
 */
export function copyTextToClipboard(text: string): boolean {
	try {
		if (!text) return false;

		if (process.platform === "win32") {
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
