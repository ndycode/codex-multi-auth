import type { Key } from "ink";
import { paintUiText } from "./format.js";
import { getUiRuntimeOptions } from "./runtime.js";
import { UI_COPY } from "./copy.js";

export interface TextPromptOptions {
	message: string;
	subtitle?: string;
	headerNote?: string;
	help?: string;
	promptLabel?: string;
	placeholder?: string;
	initialValue?: string;
	clearScreen?: boolean;
	allowEscape?: boolean;
}

function formatPromptLines(options: TextPromptOptions, value: string): string[] {
	const ui = getUiRuntimeOptions();
	const border = `${ui.theme.colors.border}+${ui.theme.colors.reset}`;
	const lines = [
		`${border} ${paintUiText(ui, options.message, "heading")}`,
	];

	if (options.headerNote) {
		lines.push(` ${paintUiText(ui, options.headerNote, "muted")}`);
	}
	if (options.subtitle) {
		lines.push(` ${paintUiText(ui, options.subtitle, "muted")}`);
	}

	lines.push("");
	lines.push(` ${paintUiText(ui, options.promptLabel ?? "Input", "muted")}`);

	const visibleValue = value.length > 0
		? value
		: paintUiText(ui, options.placeholder ?? "", "muted");
	lines.push(` ${paintUiText(ui, ">", "accent")} ${visibleValue}`);
	lines.push("");
	lines.push(` ${paintUiText(ui, options.help ?? "Enter Submit | Esc Back", "muted")}`);
	lines.push(border);
	return lines;
}

function trimLastCodePoint(value: string): string {
	const chars = Array.from(value);
	chars.pop();
	return chars.join("");
}

function isIgnoredPromptKey(input: string, key: Key): boolean {
	return key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab;
}

export async function promptTextInput(options: TextPromptOptions): Promise<string | null> {
	let value = options.initialValue ?? "";
	const { runInkLineApp } = await import("./ink-host.js");

	return runInkLineApp<string>({
		clearScreen: options.clearScreen ?? true,
		initialGuardMs: 120,
		renderLines: () => formatPromptLines(options, value),
		onInput: (input, key, controller) => {
			if (key.ctrl && input.toLowerCase() === "c") {
				controller.finish(null);
				return;
			}
			if (key.escape) {
				if (options.allowEscape !== false) {
					controller.finish(null);
				}
				return;
			}
			if (key.return) {
				controller.finish(value);
				return;
			}
			if (key.backspace || key.delete) {
				value = trimLastCodePoint(value);
				controller.rerender();
				return;
			}
			if (isIgnoredPromptKey(input, key) || input.length === 0) {
				return;
			}
			value += input;
			controller.rerender();
		},
	});
}

export interface WaitForReturnOptions {
	message?: string;
	subtitle?: string;
	help?: string;
	autoReturnMs?: number;
	pauseOnAnyKey?: boolean;
	clearScreen?: boolean;
}

function formatWaitLines(
	message: string,
	subtitle: string | undefined,
	help: string | undefined,
): string[] {
	const ui = getUiRuntimeOptions();
	const border = `${ui.theme.colors.border}+${ui.theme.colors.reset}`;
	const lines = [
		`${border} ${paintUiText(ui, message, "heading")}`,
	];
	if (subtitle) {
		lines.push(` ${paintUiText(ui, subtitle, "muted")}`);
	}
	lines.push("");
	lines.push(` ${paintUiText(ui, help ?? UI_COPY.returnFlow.continuePrompt, "muted")}`);
	lines.push(border);
	return lines;
}

export async function waitForReturnPrompt(options: WaitForReturnOptions = {}): Promise<void> {
	const pauseOnAnyKey = options.pauseOnAnyKey ?? true;
	const autoReturnMs = options.autoReturnMs ?? 0;
	const baseMessage = options.message ?? UI_COPY.returnFlow.continuePrompt;
	let paused = false;
	let remainingSeconds = autoReturnMs > 0 ? Math.max(1, Math.ceil(autoReturnMs / 1000)) : 0;
	const { runInkLineApp } = await import("./ink-host.js");

	await runInkLineApp<void>({
		clearScreen: options.clearScreen ?? false,
		initialGuardMs: 120,
		renderLines: () => {
			const subtitle = autoReturnMs > 0 && !paused
				? UI_COPY.returnFlow.autoReturn(remainingSeconds)
				: options.subtitle;
			const help = paused
				? UI_COPY.returnFlow.paused
				: (options.help ?? (autoReturnMs > 0 ? "Any key pauses | Auto return enabled" : baseMessage));
			return formatWaitLines(baseMessage, subtitle, help);
		},
		onMount: (controller) => {
			if (autoReturnMs <= 0) {
				return undefined;
			}

			const endAt = Date.now() + autoReturnMs;
			const tick = setInterval(() => {
				if (paused) return;
				const remainingMs = Math.max(0, endAt - Date.now());
				const nextSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
				if (nextSeconds !== remainingSeconds) {
					remainingSeconds = nextSeconds;
					controller.rerender();
				}
				if (remainingMs <= 0) {
					clearInterval(tick);
					controller.finish(null);
				}
			}, 80);

			return () => {
				clearInterval(tick);
			};
		},
		onInput: (input, key, controller) => {
			if (key.ctrl && input.toLowerCase() === "c") {
				controller.finish(null);
				return;
			}
			if (autoReturnMs > 0 && pauseOnAnyKey && !paused) {
				paused = true;
				controller.rerender();
				return;
			}
			controller.finish(null);
		},
	});
}
