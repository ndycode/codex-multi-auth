import { ANSI, isTTY, parseKey } from "./ansi.js";
import type { UiTheme } from "./theme.js";

export interface MenuItem<T = string> {
	label: string;
	selectedLabel?: string;
	value: T;
	hint?: string;
	disabled?: boolean;
	hideUnavailableSuffix?: boolean;
	separator?: boolean;
	kind?: "heading";
	color?: "red" | "green" | "yellow" | "cyan";
}

export interface SelectOptions<T = string> {
	message: string;
	subtitle?: string;
	dynamicSubtitle?: () => string | undefined;
	help?: string;
	clearScreen?: boolean;
	theme?: UiTheme;
	selectedEmphasis?: "chip" | "minimal";
	focusStyle?: "row-invert" | "chip";
	showCursor?: boolean;
	showHintsForUnselected?: boolean;
	refreshIntervalMs?: number;
	initialCursor?: number;
	allowEscape?: boolean;
	onCursorChange?: (context: {
		cursor: number;
		items: MenuItem<T>[];
		requestRerender: () => void;
	}) => void;
	onInput?: (
		input: string,
		context: {
			cursor: number;
			items: MenuItem<T>[];
			requestRerender: () => void;
		},
	) => T | null | undefined;
}

const ESCAPE_TIMEOUT_MS = 50;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const ANSI_LEADING_REGEX = /^\x1b\[[0-9;]*m/;

function stripAnsi(input: string): string {
	return input.replace(ANSI_REGEX, "");
}

/**
 * Truncates a string to at most a given number of visible characters while preserving ANSI SGR sequences.
 *
 * Preserves ANSI color/formatting codes in the returned string and appends "..." (or "." / shorter sequences)
 * as a visible truncation suffix when the visible length exceeds `maxVisibleChars`.
 *
 * Concurrency: function is pure and safe for concurrent use. Filesystem: behavior is independent of OS (including Windows).
 * Token handling: this function does not redact or interpret token semantics; it only preserves ANSI escape sequences.
 *
 * @param input - The input string which may contain ANSI SGR escape sequences.
 * @param maxVisibleChars - Maximum number of visible (non-ANSI) characters to keep; values <= 0 yield an empty string.
 * @returns The input string truncated so its visible character count does not exceed `maxVisibleChars`, with ANSI codes preserved and a truncation suffix appended when truncation occurred.
 */
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

/**
 * Map a MenuItem color to its ANSI SGR color code.
 *
 * No concurrency effects; does not access the filesystem on Windows or other platforms; performs no token redaction.
 *
 * @param color - The menu item color ("red", "green", "yellow", "cyan") or undefined/other for no color
 * @returns The ANSI SGR code for `color`, or an empty string if no color is specified
 */
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

/**
 * Decode a raw stdin buffer into a single printable "hotkey" character or `null` when none is available.
 *
 * Recognizes common VT-style numpad/keypad escape sequences and otherwise yields the first printable ASCII character in the input. Safe to call concurrently; it performs no filesystem or external I/O and behaves the same on Windows. This function never returns control or non-printable bytes, reducing the risk of leaking raw control sequences or sensitive tokens.
 *
 * @param data - Raw input buffer from stdin (may contain escape sequences or control bytes)
 * @returns The decoded single-character hotkey (for example, `"0"`, `"a"`, `"+"`) or `null` if no printable character is present
 */
function decodeHotkeyInput(data: Buffer): string | null {
	const input = data.toString("utf8");
	// Common VT-style numpad sequences in raw mode.
	const keypadMap: Record<string, string> = {
		"\x1bOp": "0",
		"\x1bOq": "1",
		"\x1bOr": "2",
		"\x1bOs": "3",
		"\x1bOt": "4",
		"\x1bOu": "5",
		"\x1bOv": "6",
		"\x1bOw": "7",
		"\x1bOx": "8",
		"\x1bOy": "9",
		"\x1bOk": "+",
		"\x1bOm": "-",
		"\x1bOj": "*",
		"\x1bOo": "/",
		"\x1bOn": ".",
	};
	const mapped = keypadMap[input];
	if (mapped) return mapped;

	// Fallback: strip control bytes and keep first printable ASCII char.
	for (const ch of input) {
		const code = ch.charCodeAt(0);
		if (code >= 32 && code <= 126) return ch;
	}
	return null;
}

/**
 * Present an interactive TTY menu, let the user navigate and choose an item.
 *
 * Mutates terminal state (raw mode, cursor visibility) and drives stdin/stdout until the
 * prompt finishes. Emits ANSI control sequences; on Windows the result depends on the
 * host terminal's ANSI support. Callers must not run this concurrently with other code
 * that expects normal terminal stdin/stdout state and must redact any sensitive tokens
 * in item labels/hints before calling.
 *
 * @param items - Menu items to display. Items with `disabled`, `separator`, or `kind === "heading"`
 *                are non-selectable. If exactly one selectable item exists its `value` is returned
 *                immediately.
 * @param options - Configuration for the prompt (message, subtitle or `dynamicSubtitle`, theme,
 *                  `focusStyle`, `initialCursor`, `allowEscape`, `onCursorChange`, `onInput`,
 *                  `refreshIntervalMs`, `help`, `clearScreen`, and related display behavior).
 *                  - `onInput` receives decoded hotkey input and may return a `T` to finish early
 *                    or `undefined` to continue; it may call `requestRerender` via the provided context.
 *                  - `onCursorChange` is invoked when the highlighted cursor changes and may request rerender.
 * @returns The selected item's `value`, or `null` if the prompt was cancelled or could not be started.
 *
 * @throws If not running on a TTY, if `items` is empty, or if all menu items are non-selectable.
 */
export async function select<T>(
	items: MenuItem<T>[],
	options: SelectOptions<T>,
): Promise<T | null> {
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
	if (
		typeof options.initialCursor === "number" &&
		Number.isFinite(options.initialCursor)
	) {
		const bounded = Math.max(
			0,
			Math.min(items.length - 1, Math.trunc(options.initialCursor)),
		);
		cursor = bounded;
	}
	if (cursor < 0 || !isSelectable(items[cursor] as MenuItem<T>)) {
		cursor = items.findIndex(isSelectable);
	}
	if (cursor < 0) cursor = 0;
	let escapeTimeout: ReturnType<typeof setTimeout> | null = null;
	let cleanedUp = false;
	let renderedLines = 0;
	let hasRendered = false;
	let inputGuardUntil = 0;
	const theme = options.theme;
	let rerenderRequested = false;

	const requestRerender = () => {
		rerenderRequested = true;
	};

	const notifyCursorChange = () => {
		if (!options.onCursorChange) return;
		rerenderRequested = false;
		options.onCursorChange({
			cursor,
			items,
			requestRerender,
		});
	};

	const drainStdinBuffer = () => {
		try {
			let chunk: Buffer | string | null;
			do {
				chunk = stdin.read();
			} while (chunk !== null);
		} catch {
			// best effort: ignore non-readable states
		}
	};

	const codexColorCode = (color: MenuItem["color"]): string => {
		if (!theme) {
			return colorCode(color);
		}
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
	};

	const selectedLabelStart = (): string => {
		if (!theme) {
			return `${ANSI.bgGreen}${ANSI.black}${ANSI.bold}`;
		}
		return `${theme.colors.focusBg}${theme.colors.focusText}${ANSI.bold}`;
	};

	const render = () => {
		const columns = stdout.columns ?? 80;
		const rows = stdout.rows ?? 24;
		const previousRenderedLines = renderedLines;
		const subtitleText = options.dynamicSubtitle
			? options.dynamicSubtitle()
			: options.subtitle;
		const focusStyle = options.focusStyle ?? "row-invert";
		let didFullClear = false;

		if (options.clearScreen && !hasRendered) {
			stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
			didFullClear = true;
		} else if (previousRenderedLines > 0) {
			stdout.write(ANSI.up(previousRenderedLines));
		}

		let linesWritten = 0;
		const writeLine = (line: string) => {
			stdout.write(`${ANSI.clearLine}${line}\n`);
			linesWritten += 1;
		};

		const subtitleLines = subtitleText ? 2 : 0;
		const fixedLines = 2 + subtitleLines + 2;
		const maxVisibleItems = Math.max(
			1,
			Math.min(items.length, rows - fixedLines - 1),
		);

		let windowStart = 0;
		let windowEnd = items.length;
		if (items.length > maxVisibleItems) {
			windowStart = cursor - Math.floor(maxVisibleItems / 2);
			windowStart = Math.max(
				0,
				Math.min(windowStart, items.length - maxVisibleItems),
			);
			windowEnd = windowStart + maxVisibleItems;
		}

		const visibleItems = items.slice(windowStart, windowEnd);
		const border = theme?.colors.border ?? ANSI.dim;
		const muted = theme?.colors.muted ?? ANSI.dim;
		const heading = theme?.colors.heading ?? ANSI.reset;
		const reset = theme?.colors.reset ?? ANSI.reset;
		const selectedGlyph = theme?.glyphs.selected ?? ">";
		const unselectedGlyph = theme?.glyphs.unselected ?? "o";
		const selectedGlyphColor = theme?.colors.success ?? ANSI.green;
		const selectedChip = selectedLabelStart();

		writeLine(
			`${border}+${reset} ${heading}${truncateAnsi(options.message, Math.max(1, columns - 4))}${reset}`,
		);
		if (subtitleText) {
			writeLine(
				` ${muted}${truncateAnsi(subtitleText, Math.max(1, columns - 2))}${reset}`,
			);
		}
		writeLine("");

		for (let i = 0; i < visibleItems.length; i += 1) {
			const itemIndex = windowStart + i;
			const item = visibleItems[i];
			if (!item) continue;

			if (item.separator) {
				writeLine("");
				continue;
			}

			if (item.kind === "heading") {
				const heading = truncateAnsi(
					`${muted}${item.label}${reset}`,
					Math.max(1, columns - 2),
				);
				writeLine(` ${heading}`);
				continue;
			}

			const selected = itemIndex === cursor;
			if (selected) {
				const selectedText = item.selectedLabel
					? stripAnsi(item.selectedLabel)
					: item.disabled
						? item.hideUnavailableSuffix
							? stripAnsi(item.label)
							: `${stripAnsi(item.label)} (unavailable)`
						: stripAnsi(item.label);
				if (focusStyle === "row-invert") {
					const rowText = `${selectedGlyph} ${selectedText}`;
					const focusedRow = theme
						? `${theme.colors.focusBg}${theme.colors.focusText}${ANSI.bold}${truncateAnsi(rowText, Math.max(1, columns - 2))}${reset}`
						: `${ANSI.inverse}${truncateAnsi(rowText, Math.max(1, columns - 2))}${ANSI.reset}`;
					writeLine(` ${focusedRow}`);
				} else {
					const selectedLabel = `${selectedChip}${selectedText}${reset}`;
					writeLine(
						` ${selectedGlyphColor}${selectedGlyph}${reset} ${truncateAnsi(selectedLabel, Math.max(1, columns - 4))}`,
					);
				}
				if (item.hint) {
					const detailLines = item.hint.split("\n").slice(0, 3);
					for (const detailLine of detailLines) {
						const detail = truncateAnsi(detailLine, Math.max(1, columns - 8));
						writeLine(`   ${muted}${detail}${reset}`);
					}
				}
			} else {
				const itemColor = codexColorCode(item.color);
				const labelText = item.disabled
					? item.hideUnavailableSuffix
						? `${muted}${item.label}${reset}`
						: `${muted}${item.label} (unavailable)${reset}`
					: `${itemColor}${item.label}${reset}`;
				writeLine(
					` ${muted}${unselectedGlyph}${reset} ${truncateAnsi(labelText, Math.max(1, columns - 4))}`,
				);
				if (item.hint && (options.showHintsForUnselected ?? true)) {
					const detailLines = item.hint.split("\n").slice(0, 2);
					for (const detailLine of detailLines) {
						const detail = truncateAnsi(
							`${muted}${detailLine}${reset}`,
							Math.max(1, columns - 8),
						);
						writeLine(`   ${detail}`);
					}
				}
			}
		}

		const windowHint =
			items.length > visibleItems.length
				? ` (${windowStart + 1}-${windowEnd}/${items.length})`
				: "";
		const backLabel = "Q Back";
		const helpText =
			options.help ?? `↑↓ Move | Enter Select | ${backLabel}${windowHint}`;
		writeLine(
			` ${muted}${truncateAnsi(helpText, Math.max(1, columns - 2))}${reset}`,
		);
		writeLine(`${border}+${reset}`);

		if (!didFullClear && previousRenderedLines > linesWritten) {
			const extra = previousRenderedLines - linesWritten;
			for (let i = 0; i < extra; i += 1) {
				writeLine("");
			}
		}

		renderedLines = linesWritten;
		hasRendered = true;
	};

	return new Promise((resolve) => {
		const wasRaw = stdin.isRaw ?? false;
		let refreshTimer: ReturnType<typeof setInterval> | null = null;

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
				if (refreshTimer) {
					clearInterval(refreshTimer);
					refreshTimer = null;
				}
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
			} while (
				items[next]?.disabled ||
				items[next]?.separator ||
				items[next]?.kind === "heading"
			);
			return next;
		};

		const onKey = (data: Buffer) => {
			if (escapeTimeout) {
				clearTimeout(escapeTimeout);
				escapeTimeout = null;
			}

			if (Date.now() < inputGuardUntil) {
				const action = parseKey(data);
				if (
					action === "enter" ||
					action === "escape" ||
					action === "escape-start"
				) {
					return;
				}
			}

			const action = parseKey(data);
			switch (action) {
				case "up":
					cursor = findNextSelectable(cursor, -1);
					notifyCursorChange();
					render();
					return;
				case "down":
					cursor = findNextSelectable(cursor, 1);
					notifyCursorChange();
					render();
					return;
				case "home":
					cursor = items.findIndex(isSelectable);
					notifyCursorChange();
					render();
					return;
				case "end": {
					for (let i = items.length - 1; i >= 0; i -= 1) {
						const item = items[i];
						if (item && isSelectable(item)) {
							cursor = i;
							break;
						}
					}
					notifyCursorChange();
					render();
					return;
				}
				case "enter":
					finish(items[cursor]?.value ?? null);
					return;
				case "escape":
					if (options.allowEscape !== false) {
						finish(null);
					}
					return;
				case "escape-start":
					if (options.allowEscape !== false) {
						escapeTimeout = setTimeout(() => finish(null), ESCAPE_TIMEOUT_MS);
					}
					return;
				default:
					if (options.onInput) {
						const hotkey = decodeHotkeyInput(data);
						if (hotkey) {
							rerenderRequested = false;
							const result = options.onInput(hotkey, {
								cursor,
								items,
								requestRerender,
							});
							if (result !== undefined) {
								finish(result);
								return;
							}
							if (rerenderRequested) {
								render();
							}
						}
					}
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
		drainStdinBuffer();
		inputGuardUntil = Date.now() + 120;
		stdout.write(ANSI.hide);
		notifyCursorChange();
		render();
		if (options.dynamicSubtitle && (options.refreshIntervalMs ?? 0) > 0) {
			const intervalMs = Math.max(
				80,
				Math.round(options.refreshIntervalMs ?? 0),
			);
			refreshTimer = setInterval(() => {
				render();
			}, intervalMs);
		}
		stdin.on("data", onKey);
	});
}
