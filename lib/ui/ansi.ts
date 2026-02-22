/**
 * ANSI escape helpers and keyboard parsing for interactive TUI menus.
 */

export const ANSI = {
	// Cursor control
	hide: "\x1b[?25l",
	show: "\x1b[?25h",
	up: (lines = 1) => `\x1b[${lines}A`,
	clearLine: "\x1b[2K",
	clearScreen: "\x1b[2J",
	moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,

	// Styling
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	reset: "\x1b[0m",
} as const;

export type KeyAction = "up" | "down" | "enter" | "escape" | "escape-start" | null;

export function parseKey(data: Buffer): KeyAction {
	const input = data.toString();

	if (input === "\x1b[A" || input === "\x1bOA") return "up";
	if (input === "\x1b[B" || input === "\x1bOB") return "down";
	if (input === "\r" || input === "\n") return "enter";
	if (input === "\x03") return "escape";
	if (input === "\x1b") return "escape-start";

	return null;
}

export function isTTY(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
