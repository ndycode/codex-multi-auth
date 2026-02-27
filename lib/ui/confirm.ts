import { select } from "./select.js";
import { getUiRuntimeOptions } from "./runtime.js";

/**
 * Presents a Yes/No confirmation prompt to the user and returns the chosen option.
 *
 * Note: avoid invoking multiple prompts concurrently to prevent race conditions; Windows console behavior depends on the runtime's terminal support; do not embed secrets in `message` (this function does not perform special token redaction).
 *
 * @param message - Text displayed to the user in the prompt.
 * @param defaultYes - When true, "Yes" is shown first and treated as the default selection.
 * @returns `true` if the user selects Yes, `false` otherwise.
 */
export async function confirm(message: string, defaultYes = false): Promise<boolean> {
	const ui = getUiRuntimeOptions();
	const items = defaultYes
		? [
				{ label: "Yes", value: true },
				{ label: "No", value: false },
			]
		: [
				{ label: "No", value: false },
				{ label: "Yes", value: true },
			];

	const result = await select(items, {
		message,
		theme: ui.theme,
	});
	return result ?? false;
}
