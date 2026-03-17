import { ANSI, isTTY } from "./ansi.js";
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
	headerNote?: string;
	subtitle?: string;
	dynamicSubtitle?: () => string | undefined;
	help?: string;
	clearScreen?: boolean;
	theme?: UiTheme;
	layout?: "single-column" | "split-pane-auto";
	splitMinWidth?: number;
	selectedEmphasis?: "chip" | "minimal";
	focusStyle?: "row-invert" | "chip";
	showHintsForUnselected?: boolean;
	refreshIntervalMs?: number;
	initialCursor?: number;
	allowEscape?: boolean;
	detailPane?: (context: SelectRenderContext<T>) => SelectDetailPane | null | undefined;
	onCursorChange?: (
		context: {
			cursor: number;
			items: MenuItem<T>[];
			requestRerender: () => void;
		},
	) => void;
	onInput?: (
		input: string,
		context: {
			cursor: number;
			items: MenuItem<T>[];
			requestRerender: () => void;
		},
	) => T | null | undefined;
}

export interface SelectDetailPane {
	title?: string;
	lines: string[];
}

export interface SelectRenderContext<T = string> {
	cursor: number;
	items: MenuItem<T>[];
	selectedItem: MenuItem<T> | undefined;
	columns: number;
	rows: number;
}

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

function padAnsi(input: string, visibleWidth: number): string {
	const truncated = truncateAnsi(input, visibleWidth);
	const padding = Math.max(0, visibleWidth - stripAnsi(truncated).length);
	return `${truncated}${" ".repeat(padding)}`;
}

function fitVisibleLines(lines: string[], maxLines: number): string[] {
	if (maxLines <= 0) return [];
	if (lines.length >= maxLines) return lines.slice(0, maxLines);
	return [...lines, ...Array.from({ length: maxLines - lines.length }, () => "")];
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

function renderSelectFrame<T>(
	items: MenuItem<T>[],
	cursor: number,
	options: SelectOptions<T>,
	terminal: { columns: number; rows: number },
): string[] {
	const { columns, rows } = terminal;
	const subtitleText = options.dynamicSubtitle ? options.dynamicSubtitle() : options.subtitle;
	const theme = options.theme;
	const focusStyle = options.focusStyle ?? "row-invert";
	const border = theme?.colors.border ?? ANSI.dim;
	const muted = theme?.colors.muted ?? ANSI.dim;
	const heading = theme?.colors.heading ?? ANSI.reset;
	const reset = theme?.colors.reset ?? ANSI.reset;
	const selectedGlyph = theme?.glyphs.selected ?? ">";
	const unselectedGlyph = theme?.glyphs.unselected ?? "o";
	const selectedGlyphColor = theme?.colors.success ?? ANSI.green;
	const selectedChip = theme
		? `${theme.colors.focusBg}${theme.colors.focusText}${ANSI.bold}`
		: `${ANSI.bgGreen}${ANSI.black}${ANSI.bold}`;
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

	const headerLines: string[] = [
		`${border}+${reset} ${heading}${truncateAnsi(options.message, Math.max(1, columns - 4))}${reset}`,
	];
	if (options.headerNote) {
		headerLines.push(` ${muted}${truncateAnsi(options.headerNote, Math.max(1, columns - 2))}${reset}`);
	}
	if (subtitleText) {
		headerLines.push(` ${muted}${truncateAnsi(subtitleText, Math.max(1, columns - 2))}${reset}`);
	}
	headerLines.push("");

	const renderItemRow = (
		item: MenuItem<T>,
		itemIndex: number,
		width: number,
		showHintsInline: boolean,
	): string[] => {
		if (item.separator) {
			return [""];
		}
		if (item.kind === "heading") {
			return [` ${truncateAnsi(`${muted}${item.label}${reset}`, Math.max(1, width - 1))}`];
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
					? `${theme.colors.focusBg}${theme.colors.focusText}${ANSI.bold}${truncateAnsi(rowText, Math.max(1, width - 1))}${reset}`
					: `${ANSI.inverse}${truncateAnsi(rowText, Math.max(1, width - 1))}${ANSI.reset}`;
				const lines = [` ${focusedRow}`];
				if (showHintsInline && item.hint) {
					const detailLines = item.hint.split("\n").slice(0, 3);
					for (const detailLine of detailLines) {
						const detail = truncateAnsi(detailLine, Math.max(1, width - 4));
						lines.push(`   ${muted}${detail}${reset}`);
					}
				}
				return lines;
			}

			const selectedLabel = `${selectedChip}${selectedText}${reset}`;
			const lines = [
				` ${selectedGlyphColor}${selectedGlyph}${reset} ${truncateAnsi(selectedLabel, Math.max(1, width - 3))}`,
			];
			if (showHintsInline && item.hint) {
				const detailLines = item.hint.split("\n").slice(0, 3);
				for (const detailLine of detailLines) {
					const detail = truncateAnsi(detailLine, Math.max(1, width - 4));
					lines.push(`   ${muted}${detail}${reset}`);
				}
			}
			return lines;
		}

		const itemColor = codexColorCode(item.color);
		const labelText = item.disabled
			? item.hideUnavailableSuffix
				? `${muted}${item.label}${reset}`
				: `${muted}${item.label} (unavailable)${reset}`
			: `${itemColor}${item.label}${reset}`;
		const lines = [
			` ${muted}${unselectedGlyph}${reset} ${truncateAnsi(labelText, Math.max(1, width - 3))}`,
		];
		if (showHintsInline && item.hint && (options.showHintsForUnselected ?? true)) {
			const detailLines = item.hint.split("\n").slice(0, 2);
			for (const detailLine of detailLines) {
				const detail = truncateAnsi(`${muted}${detailLine}${reset}`, Math.max(1, width - 4));
				lines.push(`   ${detail}`);
			}
		}
		return lines;
	};

	const selectableHeight = Math.max(1, rows - headerLines.length - 2 - 1);
	let windowStart = 0;
	let windowEnd = items.length;
	if (items.length > selectableHeight) {
		windowStart = cursor - Math.floor(selectableHeight / 2);
		windowStart = Math.max(0, Math.min(windowStart, items.length - selectableHeight));
		windowEnd = windowStart + selectableHeight;
	}

	const visibleItems = items.slice(windowStart, windowEnd);
	const selectedItem = items[cursor];
	const detailPane = options.detailPane?.({
		cursor,
		items,
		selectedItem,
		columns,
		rows,
	}) ?? null;
	const splitEnabled = options.layout === "split-pane-auto"
		&& detailPane !== null
		&& columns >= (options.splitMinWidth ?? 104);

	const windowHint =
		items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : "";
	const backLabel = "Q Back";
	const helpText = options.help ?? `↑↓ Move | Enter Select | ${backLabel}${windowHint}`;
	const footerLines = [
		` ${muted}${truncateAnsi(helpText, Math.max(1, columns - 2))}${reset}`,
		`${border}+${reset}`,
	];

	if (!splitEnabled) {
		const bodyLines: string[] = [];
		for (let i = 0; i < visibleItems.length; i += 1) {
			const itemIndex = windowStart + i;
			const item = visibleItems[i];
			if (!item) continue;
			bodyLines.push(...renderItemRow(item, itemIndex, columns, true));
		}
		return [...headerLines, ...bodyLines, ...footerLines];
	}

	const bodyHeight = Math.max(4, rows - headerLines.length - footerLines.length);
	let splitWindowStart = 0;
	let splitWindowEnd = items.length;
	if (items.length > bodyHeight) {
		splitWindowStart = cursor - Math.floor(bodyHeight / 2);
		splitWindowStart = Math.max(0, Math.min(splitWindowStart, items.length - bodyHeight));
		splitWindowEnd = splitWindowStart + bodyHeight;
	}
	const splitVisibleItems = items.slice(splitWindowStart, splitWindowEnd);
	const minimumRightWidth = 30;
	const leftWidth = Math.max(34, Math.min(Math.floor(columns * 0.5), columns - minimumRightWidth - 3));
	const rightWidth = Math.max(minimumRightWidth, columns - leftWidth - 3);
	const divider = `${border}|${reset}`;

	const leftLines = fitVisibleLines(
		splitVisibleItems.flatMap((item, index) =>
			renderItemRow(item, splitWindowStart + index, leftWidth, false).slice(0, 1)
		),
		bodyHeight,
	);
	const rightLinesRaw: string[] = [];
	if (detailPane?.title) {
		rightLinesRaw.push(`${heading}${detailPane.title}${reset}`);
		rightLinesRaw.push(`${muted}${"-".repeat(Math.max(6, rightWidth - 2))}${reset}`);
	}
	rightLinesRaw.push(...(detailPane?.lines ?? []));
	const rightLines = fitVisibleLines(rightLinesRaw, bodyHeight);
	const bodyLines = leftLines.map((line, index) => {
		const rightLine = rightLines[index] ?? "";
		return `${padAnsi(line, leftWidth)}${divider}${padAnsi(` ${rightLine}`, rightWidth)}`;
	});
	return [...headerLines, ...bodyLines, ...footerLines];
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
export async function select<T>(items: MenuItem<T>[], options: SelectOptions<T>): Promise<T | null> {
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

	let cursor = items.findIndex(isSelectable);
	if (typeof options.initialCursor === "number" && Number.isFinite(options.initialCursor)) {
		const bounded = Math.max(0, Math.min(items.length - 1, Math.trunc(options.initialCursor)));
		cursor = bounded;
	}
	if (cursor < 0 || !isSelectable(items[cursor] as MenuItem<T>)) {
		cursor = items.findIndex(isSelectable);
	}
	if (cursor < 0) cursor = 0;
	const findNextSelectable = (from: number, direction: 1 | -1): number => {
		if (items.length === 0) return from;
		let next = from;
		do {
			next = (next + direction + items.length) % items.length;
		} while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === "heading");
		return next;
	};

	const moveToStart = (): void => {
		const firstSelectable = items.findIndex(isSelectable);
		if (firstSelectable >= 0) {
			cursor = firstSelectable;
		}
	};

	const moveToEnd = (): void => {
		for (let i = items.length - 1; i >= 0; i -= 1) {
			const item = items[i];
			if (item && isSelectable(item)) {
				cursor = i;
				return;
			}
		}
	};

	const { runInkLineApp } = await import("./ink-host.js");

	return runInkLineApp<T>({
		clearScreen: options.clearScreen,
		initialGuardMs: 120,
		renderLines: (terminal) => renderSelectFrame(items, cursor, options, terminal),
		onMount: (controller) => {
			options.onCursorChange?.({
				cursor,
				items,
				requestRerender: () => controller.rerender(),
			});

			if (!options.dynamicSubtitle || (options.refreshIntervalMs ?? 0) <= 0) {
				return undefined;
			}

			let lastDynamicSubtitle = options.dynamicSubtitle();
			const intervalMs = Math.max(80, Math.round(options.refreshIntervalMs ?? 0));
			const refreshTimer = setInterval(() => {
				const nextSubtitle = options.dynamicSubtitle?.();
				if (nextSubtitle === lastDynamicSubtitle) {
					return;
				}
				lastDynamicSubtitle = nextSubtitle;
				controller.rerender();
			}, intervalMs);

			return () => {
				clearInterval(refreshTimer);
			};
		},
		onInput: (input, key, controller) => {
			if (key.upArrow) {
				cursor = findNextSelectable(cursor, -1);
				options.onCursorChange?.({
					cursor,
					items,
					requestRerender: () => controller.rerender(),
				});
				controller.rerender();
				return;
			}
			if (key.downArrow) {
				cursor = findNextSelectable(cursor, 1);
				options.onCursorChange?.({
					cursor,
					items,
					requestRerender: () => controller.rerender(),
				});
				controller.rerender();
				return;
			}
			if (input === "\u001b[H" || input === "\u001b[1~") {
				moveToStart();
				options.onCursorChange?.({
					cursor,
					items,
					requestRerender: () => controller.rerender(),
				});
				controller.rerender();
				return;
			}
			if (input === "\u001b[F" || input === "\u001b[4~") {
				moveToEnd();
				options.onCursorChange?.({
					cursor,
					items,
					requestRerender: () => controller.rerender(),
				});
				controller.rerender();
				return;
			}
			if (key.return) {
				controller.finish(items[cursor]?.value ?? null);
				return;
			}
			if (key.escape) {
				if (options.allowEscape !== false) {
					controller.finish(null);
				}
				return;
			}
			if (key.ctrl && input.toLowerCase() === "c") {
				controller.finish(null);
				return;
			}
			if (!options.onInput || input.length === 0) {
				return;
			}

			const result = options.onInput(input, {
				cursor,
				items,
				requestRerender: () => controller.rerender(),
			});
			if (result !== undefined) {
				controller.finish(result);
			}
		},
	});
}

export const __testOnly = {
	renderSelectFrame,
};
