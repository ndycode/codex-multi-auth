/**
 * ANSI escape helpers and keyboard parsing for interactive TUI menus.
 */

export const ANSI = {
	// Cursor control
	hide: "\x1b[?25l",
	show: "\x1b[?25h",
	altScreenOn: "\x1b[?1049h",
	altScreenOff: "\x1b[?1049l",
	up: (lines = 1) => `\x1b[${lines}A`,
	clearLine: "\x1b[2K",
	clearScreen: "\x1b[2J",
	moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,

	// Styling
	black: "\x1b[30m",
	white: "\x1b[97m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	bgBlue: "\x1b[44m",
	bgBrightBlue: "\x1b[104m",
	bgGreen: "\x1b[42m",
	bgYellow: "\x1b[43m",
	bgRed: "\x1b[41m",
	inverse: "\x1b[7m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	reset: "\x1b[0m",
} as const;

export type KeyAction =
	| "up"
	| "down"
	| "home"
	| "end"
	| "enter"
	| "escape"
	| "escape-start"
	| null;

export function parseKey(data: Buffer): KeyAction {
	const input = data.toString();

	if (input === "\x1b[A" || input === "\x1bOA") return "up";
	if (input === "\x1b[B" || input === "\x1bOB") return "down";
	if (input === "\x1b[H" || input === "\x1bOH") return "home";
	if (input === "\x1b[F" || input === "\x1bOF") return "end";
	if (input === "\r" || input === "\n") return "enter";
	if (input === "\x03") return "escape";
	if (input === "\x1b") return "escape-start";

	return null;
}

export function isTTY(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
