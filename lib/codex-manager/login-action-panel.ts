import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { DashboardDisplaySettings } from "../dashboard-settings.js";
import { ANSI } from "../ui/ansi.js";
import { UI_COPY } from "../ui/ui-copy.js";
import {
	stringifyLogArgs,
	stylePromptText,
} from "./formatters/index.js";
import { isAbortError } from "./login-oauth.js";

/**
 * Full-screen action panel used by the login dashboard to run a menu action
 * with captured console output, plus the return-to-menu wait prompt. Moved
 * verbatim out of lib/codex-manager.ts (audit roadmap §4.1.1 phase 4).
 */

interface WaitForReturnOptions {
	promptText?: string;
	autoReturnMs?: number;
	pauseOnAnyKey?: boolean;
}

async function waitForMenuReturn(
	options: WaitForReturnOptions = {},
): Promise<void> {
	if (!input.isTTY || !output.isTTY) {
		return;
	}

	const promptText = options.promptText ?? UI_COPY.returnFlow.continuePrompt;
	const autoReturnMs = options.autoReturnMs ?? 0;
	const pauseOnAnyKey = options.pauseOnAnyKey ?? true;

	try {
		let chunk: Buffer | string | null;
		do {
			chunk = input.read();
		} while (chunk !== null);
	} catch {
		// best effort buffer drain
	}

	const writeInlineStatus = (message: string): void => {
		output.write(`\r${ANSI.clearLine}${stylePromptText(message, "muted")}`);
	};

	const clearInlineStatus = (): void => {
		output.write(`\r${ANSI.clearLine}`);
	};

	if (autoReturnMs > 0) {
		if (!pauseOnAnyKey) {
			await new Promise<void>((resolve) => setTimeout(resolve, autoReturnMs));
			return;
		}
		const wasRaw = input.isRaw ?? false;
		const endAt = Date.now() + autoReturnMs;
		let lastShownSeconds: number | null = null;
		const renderCountdown = () => {
			const remainingMs = Math.max(0, endAt - Date.now());
			const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
			if (lastShownSeconds === remainingSeconds) return;
			lastShownSeconds = remainingSeconds;
			writeInlineStatus(UI_COPY.returnFlow.autoReturn(remainingSeconds));
		};
		renderCountdown();
		const pinned = await new Promise<boolean>((resolve) => {
			let done = false;
			const interval = setInterval(renderCountdown, 80);
			let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
				timeout = null;
				if (!done) {
					done = true;
					cleanup();
					resolve(false);
				}
			}, autoReturnMs);
			const onData = () => {
				if (done) return;
				done = true;
				cleanup();
				resolve(true);
			};
			const cleanup = () => {
				clearInterval(interval);
				if (timeout) {
					clearTimeout(timeout);
					timeout = null;
				}
				input.removeListener("data", onData);
				try {
					input.setRawMode(wasRaw);
				} catch {
					// best effort restore
				}
			};
			try {
				input.setRawMode(true);
			} catch {
				// if raw mode fails, keep countdown behavior
			}
			input.on("data", onData);
			input.resume();
		});
		clearInlineStatus();
		if (!pinned) {
			return;
		}
		const paused = stylePromptText(UI_COPY.returnFlow.paused, "muted");
		writeInlineStatus(paused);
		await new Promise<void>((resolve) => {
			const wasRaw = input.isRaw ?? false;
			const onData = () => {
				cleanup();
				resolve();
			};
			const cleanup = () => {
				input.removeListener("data", onData);
				try {
					input.setRawMode(wasRaw);
				} catch {
					// best effort restore
				}
			};
			try {
				input.setRawMode(true);
			} catch {
				// best effort fallback
			}
			input.on("data", onData);
			input.resume();
		});
		clearInlineStatus();
		return;
	}

	const rl = createInterface({ input, output });
	try {
		const question =
			promptText.length > 0 ? `${stylePromptText(promptText, "muted")} ` : "";
		output.write(`\r${ANSI.clearLine}`);
		await rl.question(question);
	} catch (error) {
		if (!isAbortError(error)) {
			throw error;
		}
	} finally {
		rl.close();
		clearInlineStatus();
	}
}

/** @internal */
export async function runActionPanel(
	title: string,
	stage: string,
	action: () => Promise<void> | void,
	settings?: DashboardDisplaySettings,
): Promise<void> {
	if (!input.isTTY || !output.isTTY) {
		await action();
		return;
	}

	const spinnerFrames = ["-", "\\", "|", "/"];
	let frame = 0;
	let running = true;
	let failed: unknown = null;
	const captured: string[] = [];
	const maxVisibleLines = Math.max(8, (output.rows ?? 24) - 8);
	const previousLog = console.log;
	const previousWarn = console.warn;
	const previousError = console.error;

	const capture = (prefix: string, args: unknown[]): void => {
		const line = stringifyLogArgs(args).trim();
		if (!line) return;
		captured.push(prefix ? `${prefix}${line}` : line);
		if (captured.length > 400) {
			captured.splice(0, captured.length - 400);
		}
	};

	const render = () => {
		output.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		const spinner = running
			? `${spinnerFrames[frame % spinnerFrames.length] ?? "-"} `
			: failed
				? "x "
				: "+ ";
		const stageText = running
			? `${spinner}${stage}`
			: failed
				? UI_COPY.returnFlow.failed
				: UI_COPY.returnFlow.done;
		previousLog(stylePromptText(title, "accent"));
		previousLog(
			stylePromptText(
				stageText,
				failed ? "danger" : running ? "accent" : "success",
			),
		);
		previousLog("");

		const lines = captured.slice(-maxVisibleLines);
		for (const line of lines) {
			previousLog(line);
		}

		const remainingLines = Math.max(0, maxVisibleLines - lines.length);
		for (let i = 0; i < remainingLines; i += 1) {
			previousLog("");
		}
		previousLog("");
		if (running)
			previousLog(stylePromptText(UI_COPY.returnFlow.working, "muted"));
		frame += 1;
	};

	console.log = (...args: unknown[]) => {
		capture("", args);
	};
	console.warn = (...args: unknown[]) => {
		capture("! ", args);
	};
	console.error = (...args: unknown[]) => {
		capture("x ", args);
	};

	output.write(ANSI.altScreenOn + ANSI.hide);
	let timer: ReturnType<typeof setInterval> | null = null;
	try {
		render();
		timer = setInterval(() => {
			if (!running) return;
			render();
		}, 120);

		await action();
	} catch (error) {
		failed = error;
		capture("x ", [error instanceof Error ? error.message : String(error)]);
	} finally {
		running = false;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		render();
		console.log = previousLog;
		console.warn = previousWarn;
		console.error = previousError;
	}

	if (failed) {
		await waitForMenuReturn({
			promptText: UI_COPY.returnFlow.actionFailedPrompt,
		});
	} else {
		await waitForMenuReturn({
			autoReturnMs: settings?.actionAutoReturnMs ?? 2_000,
			pauseOnAnyKey: settings?.actionPauseOnKey ?? true,
		});
	}
	output.write(
		ANSI.altScreenOff + ANSI.show + ANSI.clearScreen + ANSI.moveTo(1, 1),
	);
	if (failed) {
		throw failed;
	}
}
