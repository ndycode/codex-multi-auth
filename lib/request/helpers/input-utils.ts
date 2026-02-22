import type { InputItem } from "../../types.js";

const OPENCODE_PROMPT_SIGNATURES = [
	"you are a coding agent running in the opencode",
	"you are opencode, an agent",
	"you are opencode, an interactive cli agent",
	"you are opencode, an interactive cli tool",
	"you are opencode, the best coding agent on the planet",
].map((signature) => signature.toLowerCase());

const OPENCODE_CONTEXT_MARKERS = [
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

const extractOpenCodeContext = (contentText: string): string | null => {
	const lower = contentText.toLowerCase();
	let earliestIndex = -1;

	for (const marker of OPENCODE_CONTEXT_MARKERS) {
		const index = lower.indexOf(marker);
		if (index >= 0 && (earliestIndex === -1 || index < earliestIndex)) {
			earliestIndex = index;
		}
	}

	if (earliestIndex === -1) return null;
	return contentText.slice(earliestIndex).trimStart();
};

export function isOpenCodeSystemPrompt(
	item: InputItem,
	cachedPrompt: string | null,
): boolean {
	const isSystemRole = item.role === "developer" || item.role === "system";
	if (!isSystemRole) return false;

	const contentText = getContentText(item);
	if (!contentText) return false;

	if (cachedPrompt) {
		const contentTrimmed = contentText.trim();
		const cachedTrimmed = cachedPrompt.trim();
		if (contentTrimmed === cachedTrimmed) {
			return true;
		}

		if (contentTrimmed.startsWith(cachedTrimmed)) {
			return true;
		}

		const contentPrefix = contentTrimmed.substring(0, 200);
		const cachedPrefix = cachedTrimmed.substring(0, 200);
		if (contentPrefix === cachedPrefix) {
			return true;
		}
	}

	const normalized = contentText.trimStart().toLowerCase();
	return OPENCODE_PROMPT_SIGNATURES.some((signature) =>
		normalized.startsWith(signature),
	);
}

export function filterOpenCodeSystemPromptsWithCachedPrompt(
	input: InputItem[] | undefined,
	cachedPrompt: string | null,
): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input.flatMap((item) => {
		if (item.role === "user") return [item];

		if (!isOpenCodeSystemPrompt(item, cachedPrompt)) {
			return [item];
		}

		const contentText = getContentText(item);
		const preservedContext = extractOpenCodeContext(contentText);
		if (preservedContext) {
			return [replaceContentText(item, preservedContext)];
		}

		return [];
	});
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
	let text: string;
	try {
		const out = (item as { output?: unknown }).output;
		text = typeof out === "string" ? out : JSON.stringify(out);
	} catch {
		text = String((item as { output?: unknown }).output ?? "");
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

	return input.map((item) => {
		if (item.type === "function_call_output") {
			const callId = getCallId(item);
			const hasMatch =
				!!callId &&
				(functionCallIds.has(callId) || localShellCallIds.has(callId));
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		if (item.type === "custom_tool_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && customToolCallIds.has(callId);
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		if (item.type === "local_shell_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && localShellCallIds.has(callId);
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		return item;
	});
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
	const result: InputItem[] = [];

	for (const item of input) {
		result.push(item);

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

				result.push({
					type: outputType,
					call_id: callId,
					output: CANCELLED_TOOL_OUTPUT,
				} as unknown as InputItem);
			}
		}
	}

	return result;
};
