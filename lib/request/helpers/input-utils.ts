import type { InputItem } from "../../types.js";

const HOST_PROMPT_SIGNATURES = [
	"you are a coding agent running in the Codex",
	"you are Codex, an agent",
	"you are Codex, an interactive cli agent",
	"you are Codex, an interactive cli tool",
	"you are Codex, the best coding agent on the planet",
].map((signature) => signature.toLowerCase());

const HOST_CONTEXT_MARKERS = [
	"here is some useful information about the environment you are running in:",
	"<env>",
	"instructions from:",
	"<instructions>",
].map((marker) => marker.toLowerCase());

export const getContentText = (item: InputItem): string => {
	if (typeof item.content === "string") {
		return item.content;
	}
	if (Array.isArray(item.content)) {
		return item.content
			.filter((c) => c.type === "input_text" && c.text)
			.map((c) => c.text)
			.join("\n");
	}
	return "";
};

const replaceContentText = (item: InputItem, contentText: string): InputItem => {
	if (typeof item.content === "string") {
		return { ...item, content: contentText };
	}
	if (Array.isArray(item.content)) {
		return {
			...item,
			content: [{ type: "input_text", text: contentText }],
		};
	}
	// istanbul ignore next -- only called after getContentText returns non-empty (string/array content)
	return { ...item, content: contentText };
};

const extractHostContext = (contentText: string): string | null => {
	const lower = contentText.toLowerCase();
	let earliestIndex = -1;

	for (const marker of HOST_CONTEXT_MARKERS) {
		const index = lower.indexOf(marker);
		if (index >= 0 && (earliestIndex === -1 || index < earliestIndex)) {
			earliestIndex = index;
		}
	}

	if (earliestIndex === -1) return null;
	return contentText.slice(earliestIndex).trimStart();
};

interface CachedPromptParts {
	trimmed: string;
	prefix: string;
}

/**
 * Normalizes the cached host prompt once per filter pass so the per-item
 * checks do not re-trim/re-slice the same string.
 */
const prepareCachedPrompt = (
	cachedPrompt: string | null,
): CachedPromptParts | null => {
	if (!cachedPrompt) return null;
	const trimmed = cachedPrompt.trim();
	return { trimmed, prefix: trimmed.substring(0, 200) };
};

const isHostPromptContent = (
	contentText: string,
	cached: CachedPromptParts | null,
): boolean => {
	if (!contentText) return false;

	if (cached) {
		const contentTrimmed = contentText.trim();
		if (contentTrimmed === cached.trimmed) {
			return true;
		}

		if (contentTrimmed.startsWith(cached.trimmed)) {
			return true;
		}

		const contentPrefix = contentTrimmed.substring(0, 200);
		if (contentPrefix === cached.prefix) {
			return true;
		}
	}

	const normalized = contentText.trimStart().toLowerCase();
	return HOST_PROMPT_SIGNATURES.some((signature) =>
		normalized.startsWith(signature),
	);
};

export function isHostSystemPrompt(
	item: InputItem,
	cachedPrompt: string | null,
): boolean {
	const isSystemRole = item.role === "developer" || item.role === "system";
	if (!isSystemRole) return false;

	return isHostPromptContent(
		getContentText(item),
		prepareCachedPrompt(cachedPrompt),
	);
}

export function filterHostSystemPromptsWithCachedPrompt(
	input: InputItem[] | undefined,
	cachedPrompt: string | null,
): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	const cached = prepareCachedPrompt(cachedPrompt);
	// Copy-on-write: most items pass through untouched, so the result array is
	// only materialized once an item is actually dropped or rewritten.
	let filtered: InputItem[] | null = null;
	for (let i = 0; i < input.length; i++) {
		// flatMap skips sparse holes entirely; an explicit `undefined` element
		// still reaches the callback and throws on `.role` — mirrored below.
		if (!(i in input)) {
			if (filtered === null) filtered = input.slice(0, i);
			continue;
		}
		const item = input[i] as InputItem;
		const isSystemRole =
			item.role === "developer" || item.role === "system";

		if (!isSystemRole) {
			if (filtered !== null) filtered.push(item);
			continue;
		}

		const contentText = getContentText(item);
		if (!isHostPromptContent(contentText, cached)) {
			if (filtered !== null) filtered.push(item);
			continue;
		}

		const preservedContext = extractHostContext(contentText);
		if (filtered === null) {
			filtered = input.slice(0, i);
		}
		if (preservedContext) {
			filtered.push(replaceContentText(item, preservedContext));
		}
	}
	return filtered ?? input;
}

const getCallId = (item: InputItem): string | null => {
	const rawCallId = (item as { call_id?: unknown }).call_id;
	if (typeof rawCallId !== "string") return null;
	const trimmed = rawCallId.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const convertOrphanedOutputToMessage = (
	item: InputItem,
	callId: string | null,
): InputItem => {
	const toolName =
		typeof (item as { name?: unknown }).name === "string"
			? ((item as { name?: string }).name as string)
			: "tool";
	const labelCallId = callId ?? "unknown";
	// Read `.output` once: the catch fallback must use the same value —
	// re-reading a throwing getter inside the catch would just re-throw.
	const out = (item as { output?: unknown }).output;
	let text: string;
	try {
		text =
			typeof out === "string" ? out : (JSON.stringify(out) ?? "");
	} catch {
		text = String(out ?? "");
	}
	if (text.length > 16000) {
		text = text.slice(0, 16000) + "\n...[truncated]";
	}
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${labelCallId}]: ${text}`,
	} as InputItem;
};

const collectCallIds = (input: InputItem[]) => {
	const functionCallIds = new Set<string>();
	const localShellCallIds = new Set<string>();
	const customToolCallIds = new Set<string>();

	for (const item of input) {
		const callId = getCallId(item);
		if (!callId) continue;
		switch (item.type) {
			case "function_call":
				functionCallIds.add(callId);
				break;
			case "local_shell_call":
				localShellCallIds.add(callId);
				break;
			case "custom_tool_call":
				customToolCallIds.add(callId);
				break;
			default:
				break;
		}
	}

	return { functionCallIds, localShellCallIds, customToolCallIds };
};

export const normalizeOrphanedToolOutputs = (
	input: InputItem[],
): InputItem[] => {
	const { functionCallIds, localShellCallIds, customToolCallIds } =
		collectCallIds(input);

	// Copy-on-write: items pass through by reference until an output actually
	// needs converting; an unchanged input returns the original array instead
	// of a per-item `map` copy.
	let mapped: InputItem[] | null = null;
	for (let i = 0; i < input.length; i++) {
		const item = input[i] as InputItem;
		let converted = item;

		if (item.type === "function_call_output") {
			const callId = getCallId(item);
			const hasMatch =
				!!callId &&
				(functionCallIds.has(callId) || localShellCallIds.has(callId));
			if (!hasMatch) {
				converted = convertOrphanedOutputToMessage(item, callId);
			}
		} else if (item.type === "custom_tool_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && customToolCallIds.has(callId);
			if (!hasMatch) {
				converted = convertOrphanedOutputToMessage(item, callId);
			}
		} else if (item.type === "local_shell_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && localShellCallIds.has(callId);
			if (!hasMatch) {
				converted = convertOrphanedOutputToMessage(item, callId);
			}
		}

		if (converted !== item && mapped === null) {
			mapped = input.slice(0, i);
		}
		if (mapped !== null) {
			mapped.push(converted);
		}
	}
	return mapped ?? input;
};

const CANCELLED_TOOL_OUTPUT = "Operation cancelled by user";

const collectOutputCallIds = (input: InputItem[]): Set<string> => {
	const outputCallIds = new Set<string>();
	for (const item of input) {
		if (
			item.type === "function_call_output" ||
			item.type === "local_shell_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			const callId = getCallId(item);
			if (callId) outputCallIds.add(callId);
		}
	}
	return outputCallIds;
};

export const injectMissingToolOutputs = (input: InputItem[]): InputItem[] => {
	const outputCallIds = collectOutputCallIds(input);
	// Copy-on-write: items pass through by reference; the result array is only
	// materialized when a synthetic output is actually injected.
	let result: InputItem[] | null = null;

	for (let i = 0; i < input.length; i++) {
		const item = input[i] as InputItem;
		if (result !== null) {
			result.push(item);
		}

		if (
			item.type === "function_call" ||
			item.type === "local_shell_call" ||
			item.type === "custom_tool_call"
		) {
			const callId = getCallId(item);
			if (callId && !outputCallIds.has(callId)) {
				const outputType =
					item.type === "function_call"
						? "function_call_output"
						: item.type === "local_shell_call"
							? "local_shell_call_output"
							: "custom_tool_call_output";

				if (result === null) {
					result = input.slice(0, i + 1);
				}
				result.push({
					type: outputType,
					call_id: callId,
					output: CANCELLED_TOOL_OUTPUT,
				} as unknown as InputItem);
			}
		}
	}

	return result ?? input;
};


