import { ANSI, isTTY, parseKey } from "./ansi.js";
import type { UiTheme } from "./theme.js";

export interface MenuItem<T = string> {
	label: string;
	value: T;
	hint?: string;
	disabled?: boolean;
	separator?: boolean;
	kind?: "heading";
	color?: "red" | "green" | "yellow" | "cyan";
}

export interface SelectOptions {
	message: string;
	subtitle?: string;
	help?: string;
	clearScreen?: boolean;
	variant?: "legacy" | "codex";
	theme?: UiTheme;
}

const ESCAPE_TIMEOUT_MS = 50;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const ANSI_LEADING_REGEX = /^\x1b\[[0-9;]*m/;

function stripAnsi(input: string): string {
	return input.replace(ANSI_REGEX, "");
}

function truncateAnsi(input: string, maxVisibleChars: number): string {
	if (maxVisibleChars <= 0) return "";
	const visible = stripAnsi(input);
	if (visible.length <= maxVisibleChars) return input;

	const suffix = maxVisibleChars >= 3 ? "..." : ".".repeat(maxVisibleChars);
	const keep = Math.max(0, maxVisibleChars - suffix.length);
	let kept = 0;
	let index = 0;
	let output = "";

	while (index < input.length && kept < keep) {
		if (input[index] === "\x1b") {
			const match = input.slice(index).match(ANSI_LEADING_REGEX);
			if (match) {
				output += match[0];
				index += match[0].length;
				continue;
			}
		}
		output += input[index];
		index += 1;
		kept += 1;
	}

	return output + suffix;
}

function colorCode(color: MenuItem["color"]): string {
	switch (color) {
		case "red":
			return ANSI.red;
		case "green":
			return ANSI.green;
		case "yellow":
			return ANSI.yellow;
		case "cyan":
			return ANSI.cyan;
		default:
			return "";
	}
}

function codexColorCode(theme: UiTheme, color: MenuItem["color"]): string {
	switch (color) {
		case "red":
			return theme.colors.danger;
		case "green":
			return theme.colors.success;
		case "yellow":
			return theme.colors.warning;
		case "cyan":
			return theme.colors.accent;
		default:
			return theme.colors.heading;
	}
}

export async function select<T>(items: MenuItem<T>[], options: SelectOptions): Promise<T | null> {
	if (!isTTY()) {
		throw new Error("Interactive select requires a TTY terminal");
	}
	if (items.length === 0) {
		throw new Error("No menu items provided");
	}

	const isSelectable = (item: MenuItem<T>) =>
		!item.disabled && !item.separator && item.kind !== "heading";
	const selectable = items.filter(isSelectable);
	if (selectable.length === 0) {
		throw new Error("All menu items are disabled");
	}
	if (selectable.length === 1) {
		return selectable[0]?.value ?? null;
	}

	const { stdin, stdout } = process;
	let cursor = items.findIndex(isSelectable);
	if (cursor < 0) cursor = 0;
	let escapeTimeout: ReturnType<typeof setTimeout> | null = null;
	let cleanedUp = false;
	let renderedLines = 0;

	const renderLegacy = () => {
		const columns = stdout.columns ?? 80;
		const rows = stdout.rows ?? 24;
		const previousRenderedLines = renderedLines;

		if (options.clearScreen) {
			stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		} else if (previousRenderedLines > 0) {
			stdout.write(ANSI.up(previousRenderedLines));
		}

		let linesWritten = 0;
		const writeLine = (line: string) => {
			stdout.write(`${ANSI.clearLine}${line}\n`);
			linesWritten += 1;
		};

		const subtitleLines = options.subtitle ? 3 : 0;
		const fixedLines = 1 + subtitleLines + 2;
		const maxVisibleItems = Math.max(1, Math.min(items.length, rows - fixedLines - 1));

		let windowStart = 0;
		let windowEnd = items.length;
		if (items.length > maxVisibleItems) {
			windowStart = cursor - Math.floor(maxVisibleItems / 2);
			windowStart = Math.max(0, Math.min(windowStart, items.length - maxVisibleItems));
			windowEnd = windowStart + maxVisibleItems;
		}

		const visibleItems = items.slice(windowStart, windowEnd);
		writeLine(`${ANSI.dim}+ ${ANSI.reset}${truncateAnsi(options.message, Math.max(1, columns - 4))}`);

		if (options.subtitle) {
			writeLine("|");
			writeLine(`${ANSI.cyan}>${ANSI.reset} ${truncateAnsi(options.subtitle, Math.max(1, columns - 4))}`);
			writeLine("");
		}

		for (let i = 0; i < visibleItems.length; i += 1) {
			const itemIndex = windowStart + i;
			const item = visibleItems[i];
			if (!item) continue;

			if (item.separator) {
				writeLine("|");
				continue;
			}

			if (item.kind === "heading") {
				const heading = truncateAnsi(
					`${ANSI.dim}${ANSI.bold}${item.label}${ANSI.reset}`,
					Math.max(1, columns - 6),
				);
				writeLine(`${ANSI.cyan}|${ANSI.reset}  ${heading}`);
				continue;
			}

			const selected = itemIndex === cursor;
			let labelText: string;
			if (item.disabled) {
				labelText = `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`;
			} else if (selected) {
				const color = colorCode(item.color);
				labelText = color ? `${color}${item.label}${ANSI.reset}` : item.label;
				if (item.hint) {
					labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
				}
			} else {
				const color = colorCode(item.color);
				labelText = color
					? `${ANSI.dim}${color}${item.label}${ANSI.reset}`
					: `${ANSI.dim}${item.label}${ANSI.reset}`;
				if (item.hint) {
					labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
				}
			}

			labelText = truncateAnsi(labelText, Math.max(1, columns - 8));
			if (selected) {
				writeLine(`${ANSI.cyan}|${ANSI.reset}  ${ANSI.green}*${ANSI.reset} ${labelText}`);
			} else {
				writeLine(`${ANSI.cyan}|${ANSI.reset}  ${ANSI.dim}o${ANSI.reset} ${labelText}`);
			}
		}

		const windowHint =
			items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : "";
		const helpText = options.help ?? `Up/Down select | Enter confirm | Esc back${windowHint}`;
		writeLine(
			`${ANSI.cyan}|${ANSI.reset}  ${ANSI.dim}${truncateAnsi(helpText, Math.max(1, columns - 6))}${ANSI.reset}`,
		);
		writeLine(`${ANSI.cyan}+${ANSI.reset}`);

		if (!options.clearScreen && previousRenderedLines > linesWritten) {
			const extra = previousRenderedLines - linesWritten;
			for (let i = 0; i < extra; i += 1) {
				writeLine("");
			}
		}

		renderedLines = linesWritten;
	};

	const renderCodex = (theme: UiTheme) => {
		const columns = stdout.columns ?? 80;
		const rows = stdout.rows ?? 24;
		const previousRenderedLines = renderedLines;

		if (options.clearScreen) {
			stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		} else if (previousRenderedLines > 0) {
			stdout.write(ANSI.up(previousRenderedLines));
		}

		let linesWritten = 0;
		const writeLine = (line: string) => {
			stdout.write(`${ANSI.clearLine}${line}\n`);
			linesWritten += 1;
		};

		const subtitleLines = options.subtitle ? 2 : 0;
		const fixedLines = 2 + subtitleLines + 2;
		const maxVisibleItems = Math.max(1, Math.min(items.length, rows - fixedLines - 1));

		let windowStart = 0;
		let windowEnd = items.length;
		if (items.length > maxVisibleItems) {
			windowStart = cursor - Math.floor(maxVisibleItems / 2);
			windowStart = Math.max(0, Math.min(windowStart, items.length - maxVisibleItems));
			windowEnd = windowStart + maxVisibleItems;
		}

		const visibleItems = items.slice(windowStart, windowEnd);
		const border = theme.colors.border;
		const muted = theme.colors.muted;
		const heading = theme.colors.heading;
		const accent = theme.colors.accent;
		const reset = theme.colors.reset;
		const selectedGlyph = theme.glyphs.selected;
		const unselectedGlyph = theme.glyphs.unselected;

		writeLine(`${border}+${reset} ${heading}${truncateAnsi(options.message, Math.max(1, columns - 4))}${reset}`);
		if (options.subtitle) {
			writeLine(
				`${border}|${reset} ${muted}${truncateAnsi(options.subtitle, Math.max(1, columns - 4))}${reset}`,
			);
		}
		writeLine(`${border}|${reset}`);

		for (let i = 0; i < visibleItems.length; i += 1) {
			const itemIndex = windowStart + i;
			const item = visibleItems[i];
			if (!item) continue;

			if (item.separator) {
				writeLine(`${border}|${reset}`);
				continue;
			}

			if (item.kind === "heading") {
				const headingText = truncateAnsi(
					`${theme.colors.dim}${heading}${item.label}${reset}`,
					Math.max(1, columns - 6),
				);
				writeLine(`${border}|${reset} ${headingText}`);
				continue;
			}

			const selected = itemIndex === cursor;
			const prefix = selected
				? `${accent}${selectedGlyph}${reset}`
				: `${muted}${unselectedGlyph}${reset}`;
			const itemColor = codexColorCode(theme, item.color);
			let labelText: string;
			if (item.disabled) {
				labelText = `${muted}${item.label} (unavailable)${reset}`;
			} else if (selected) {
				labelText = `${itemColor}${item.label}${reset}`;
			} else {
				labelText = `${muted}${item.label}${reset}`;
			}
			if (item.hint) {
				labelText += ` ${muted}${item.hint}${reset}`;
			}

			labelText = truncateAnsi(labelText, Math.max(1, columns - 8));
			writeLine(`${border}|${reset} ${prefix} ${labelText}`);
		}

		const windowHint =
			items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : "";
		const helpText = options.help ?? `Up/Down select | Enter confirm | Esc back${windowHint}`;
		writeLine(`${border}|${reset} ${muted}${truncateAnsi(helpText, Math.max(1, columns - 4))}${reset}`);
		writeLine(`${border}+${reset}`);

		if (!options.clearScreen && previousRenderedLines > linesWritten) {
			const extra = previousRenderedLines - linesWritten;
			for (let i = 0; i < extra; i += 1) {
				writeLine("");
			}
		}

		renderedLines = linesWritten;
	};

	const render = () => {
		if (options.variant === "codex" && options.theme) {
			renderCodex(options.theme);
			return;
		}
		renderLegacy();
	};

	return new Promise((resolve) => {
		const wasRaw = stdin.isRaw ?? false;

		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;

			if (escapeTimeout) {
				clearTimeout(escapeTimeout);
				escapeTimeout = null;
			}

			try {
				stdin.removeListener("data", onKey);
				stdin.setRawMode(wasRaw);
				stdin.pause();
				stdout.write(ANSI.show);
			} catch {
				// best effort cleanup
			}

			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
		};

		const finish = (value: T | null) => {
			cleanup();
			resolve(value);
		};

		const onSignal = () => finish(null);

		const findNextSelectable = (from: number, direction: 1 | -1): number => {
			if (items.length === 0) return from;
			let next = from;
			do {
				next = (next + direction + items.length) % items.length;
			} while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === "heading");
			return next;
		};

		const onKey = (data: Buffer) => {
			if (escapeTimeout) {
				clearTimeout(escapeTimeout);
				escapeTimeout = null;
			}

			const action = parseKey(data);
			switch (action) {
				case "up":
					cursor = findNextSelectable(cursor, -1);
					render();
					return;
				case "down":
					cursor = findNextSelectable(cursor, 1);
					render();
					return;
				case "enter":
					finish(items[cursor]?.value ?? null);
					return;
				case "escape":
					finish(null);
					return;
				case "escape-start":
					escapeTimeout = setTimeout(() => finish(null), ESCAPE_TIMEOUT_MS);
					return;
				default:
					return;
			}
		};

		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);

		try {
			stdin.setRawMode(true);
		} catch {
			cleanup();
			resolve(null);
			return;
		}

		stdin.resume();
		stdout.write(ANSI.hide);
		render();
		stdin.on("data", onKey);
	});
}

