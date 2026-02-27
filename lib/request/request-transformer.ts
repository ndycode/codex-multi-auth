import { logDebug, logWarn } from "../logger.js";
import { TOOL_REMAP_MESSAGE } from "../prompts/codex.js";
import { CODEX_OPENCODE_BRIDGE } from "../prompts/codex-opencode-bridge.js";
import { getOpenCodeCodexPrompt } from "../prompts/opencode-codex.js";
import { getNormalizedModel } from "./helpers/model-map.js";
import {
	filterOpenCodeSystemPromptsWithCachedPrompt,
	normalizeOrphanedToolOutputs,
	injectMissingToolOutputs,
} from "./helpers/input-utils.js";
import { cleanupToolDefinitions } from "./helpers/tool-utils.js";
import type {
	ConfigOptions,
	InputItem,
	ReasoningConfig,
	RequestBody,
	UserConfig,
} from "../types.js";

type CollaborationMode = "plan" | "default" | "unknown";
type FastSessionStrategy = "hybrid" | "always";
type SupportedReasoningSummary = "auto" | "concise" | "detailed";

const PLAN_MODE_ONLY_TOOLS = new Set(["request_user_input"]);

export {
	isOpenCodeSystemPrompt,
	filterOpenCodeSystemPromptsWithCachedPrompt,
} from "./helpers/input-utils.js";

/**
 * Normalize model name to Codex-supported variants
 *
 * Uses explicit model map for known models, with fallback pattern matching
 * for unknown/custom model names.
 *
 * @param model - Original model name (e.g., "gpt-5-codex-low", "openai/gpt-5-codex")
 * @returns Normalized model name (e.g., "gpt-5-codex", "gpt-5.1-codex-max")
 */
export function normalizeModel(model: string | undefined): string {
	if (!model) return "gpt-5.1";

	// Strip provider prefix if present (e.g., "openai/gpt-5-codex" → "gpt-5-codex")
	const modelId = model.includes("/") ? model.split("/").pop() ?? model : model;

	// Try explicit model map first (handles all known model variants)
	const mappedModel = getNormalizedModel(modelId);
	if (mappedModel) {
		return mappedModel;
	}

	// Fallback: Pattern-based matching for unknown/custom model names
	// This preserves backwards compatibility with old verbose names
	// like "GPT 5 Codex Low (ChatGPT Subscription)"
	const normalized = modelId.toLowerCase();

	// Priority order for pattern matching (most specific first):
	// 1. GPT-5.3 Codex Spark (legacy alias -> canonical gpt-5-codex)
	if (
		normalized.includes("gpt-5.3-codex-spark") ||
		normalized.includes("gpt 5.3 codex spark")
	) {
		return "gpt-5-codex";
	}

	// 2. GPT-5.3 Codex (legacy alias -> canonical gpt-5-codex)
	if (
		normalized.includes("gpt-5.3-codex") ||
		normalized.includes("gpt 5.3 codex")
	) {
		return "gpt-5-codex";
	}

	// 3. GPT-5.2 Codex (legacy alias -> canonical gpt-5-codex)
	if (
		normalized.includes("gpt-5.2-codex") ||
		normalized.includes("gpt 5.2 codex")
	) {
		return "gpt-5-codex";
	}

	// 4. GPT-5.2 (general purpose)
	if (normalized.includes("gpt-5.2") || normalized.includes("gpt 5.2")) {
		return "gpt-5.2";
	}

	// 5. GPT-5.1 Codex Max
	if (
		normalized.includes("gpt-5.1-codex-max") ||
		normalized.includes("gpt 5.1 codex max")
	) {
		return "gpt-5.1-codex-max";
	}

	// 6. GPT-5.1 Codex Mini
	if (
		normalized.includes("gpt-5.1-codex-mini") ||
		normalized.includes("gpt 5.1 codex mini")
	) {
		return "gpt-5.1-codex-mini";
	}

	// 7. Legacy Codex Mini
	if (
		normalized.includes("codex-mini-latest") ||
		normalized.includes("gpt-5-codex-mini") ||
		normalized.includes("gpt 5 codex mini")
	) {
		return "gpt-5.1-codex-mini";
	}

	// 8. GPT-5 Codex canonical + GPT-5.1 Codex legacy alias
	if (
		normalized.includes("gpt-5-codex") ||
		normalized.includes("gpt 5 codex")
	) {
		return "gpt-5-codex";
	}

	// 9. GPT-5.1 Codex (legacy alias)
	if (
		normalized.includes("gpt-5.1-codex") ||
		normalized.includes("gpt 5.1 codex")
	) {
		return "gpt-5-codex";
	}

	// 10. GPT-5.1 (general-purpose)
	if (normalized.includes("gpt-5.1") || normalized.includes("gpt 5.1")) {
		return "gpt-5.1";
	}

	// 11. GPT-5 Codex family (any other variant with "codex")
	if (normalized.includes("codex")) {
		return "gpt-5-codex";
	}

	// 12. GPT-5 family (any variant) - default to 5.1
	if (normalized.includes("gpt-5") || normalized.includes("gpt 5")) {
		return "gpt-5.1";
	}

	// Default fallback
	return "gpt-5.1";
}

/**
 * Extract configuration for a specific model
 * Merges global options with model-specific options (model-specific takes precedence)
 * @param modelName - Model name (e.g., "gpt-5-codex")
 * @param userConfig - Full user configuration object
 * @returns Merged configuration for this model
 */
export function getModelConfig(
	modelName: string,
	userConfig: UserConfig = { global: {}, models: {} },
): ConfigOptions {
	const globalOptions = userConfig.global ?? {};
	const modelMap = userConfig.models ?? {};

	const stripProviderPrefix = (name: string): string =>
		name.includes("/") ? (name.split("/").pop() ?? name) : name;

	const getVariantFromModelName = (
		name: string,
	): ConfigOptions["reasoningEffort"] | undefined => {
		const stripped = stripProviderPrefix(name).toLowerCase();
		const match = stripped.match(/-(none|minimal|low|medium|high|xhigh)$/);
		if (!match) return undefined;
		const variant = match[1];
		if (
			variant === "none" ||
			variant === "minimal" ||
			variant === "low" ||
			variant === "medium" ||
			variant === "high" ||
			variant === "xhigh"
		) {
			return variant;
		}
		return undefined;
	};

	const removeVariantSuffix = (name: string): string =>
		stripProviderPrefix(name).replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");

	const findModelEntry = (
		candidates: string[],
	):
		| {
				key: string;
				entry: UserConfig["models"][string];
		  }
		| undefined => {
		for (const key of candidates) {
			const entry = modelMap[key];
			if (entry) return { key, entry };
		}
		return undefined;
	};

	const strippedModelName = stripProviderPrefix(modelName);
	const normalizedModelName = normalizeModel(strippedModelName);
	const normalizedBaseModelName = normalizeModel(removeVariantSuffix(strippedModelName));
	const baseModelName = removeVariantSuffix(strippedModelName);
	const requestedVariant = getVariantFromModelName(strippedModelName);

	// 1) Honor exact per-model keys first (including variant-specific keys)
	const directMatch = findModelEntry([modelName, strippedModelName]);
	if (directMatch?.entry?.options) {
		return { ...globalOptions, ...directMatch.entry.options };
	}

	// 2) Resolve to base model config (supports provider-prefixed names + aliases)
	const baseMatch = findModelEntry([
		baseModelName,
		normalizedBaseModelName,
		normalizedModelName,
	]);
	const baseOptions = baseMatch?.entry?.options ?? {};

	// 3) If model requested a variant, merge variant options from base model config
	const variantConfig =
		requestedVariant && baseMatch?.entry?.variants
			? baseMatch.entry.variants[requestedVariant]
			: undefined;
	let variantOptions: ConfigOptions = {};
	if (variantConfig) {
		const { disabled: _disabled, ...rest } = variantConfig;
		void _disabled;
		variantOptions = rest;
	}

	// Model-specific options override global options
	return { ...globalOptions, ...baseOptions, ...variantOptions };
}

/**
 * Apply fast-session defaults to reduce latency/cost for interactive sessions.
 * Explicit user/model overrides still take precedence.
 */
export function applyFastSessionDefaults(
	userConfig: UserConfig = { global: {}, models: {} },
): UserConfig {
	const global = userConfig.global ?? {};
	return {
		...userConfig,
		global: {
			...global,
			reasoningEffort: global.reasoningEffort ?? "low",
			textVerbosity: global.textVerbosity ?? "low",
		},
	};
}

function resolveReasoningConfig(
	modelName: string,
	modelConfig: ConfigOptions,
	body: RequestBody,
): ReasoningConfig {
	const providerOpenAI = body.providerOptions?.openai;
	const existingEffort =
		body.reasoning?.effort ?? providerOpenAI?.reasoningEffort;
	const existingSummary =
		body.reasoning?.summary ?? providerOpenAI?.reasoningSummary;

	const mergedConfig: ConfigOptions = {
		...modelConfig,
		...(existingEffort ? { reasoningEffort: existingEffort } : {}),
		...(existingSummary ? { reasoningSummary: existingSummary } : {}),
	};

	return getReasoningConfig(modelName, mergedConfig);
}

function resolveTextVerbosity(
	modelConfig: ConfigOptions,
	body: RequestBody,
): "low" | "medium" | "high" {
	const providerOpenAI = body.providerOptions?.openai;
	return (
		body.text?.verbosity ??
		providerOpenAI?.textVerbosity ??
		modelConfig.textVerbosity ??
		"medium"
	);
}

function resolveInclude(modelConfig: ConfigOptions, body: RequestBody): string[] {
	const providerOpenAI = body.providerOptions?.openai;
	const base =
		body.include ??
		providerOpenAI?.include ??
		modelConfig.include ??
		["reasoning.encrypted_content"];
	const include = Array.from(new Set(base.filter(Boolean)));
	if (!include.includes("reasoning.encrypted_content")) {
		include.push("reasoning.encrypted_content");
	}
	return include;
}

function parseCollaborationMode(value: string | undefined): CollaborationMode | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "plan") return "plan";
	if (normalized === "default") return "default";
	return undefined;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return "";
			const typedItem = item as { text?: unknown };
			return typeof typedItem.text === "string" ? typedItem.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function detectCollaborationMode(body: RequestBody): CollaborationMode {
	const envMode =
		parseCollaborationMode(process.env.CODEX_COLLABORATION_MODE) ??
		parseCollaborationMode(process.env.OPENCODE_COLLABORATION_MODE);
	if (envMode) return envMode;
	if (!Array.isArray(body.input)) return "unknown";

	let sawPlan = false;
	let sawDefault = false;

	for (const item of body.input) {
		if (!item || typeof item !== "object") continue;
		const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
		if (role !== "developer" && role !== "system") continue;

		const text = extractMessageText(item.content);
		if (!text) continue;
		if (/collaboration mode:\s*plan/i.test(text) || /in Plan mode/i.test(text)) {
			sawPlan = true;
		}
		if (/collaboration mode:\s*default/i.test(text) || /in Default mode/i.test(text)) {
			sawDefault = true;
		}
	}

	if (sawPlan && !sawDefault) return "plan";
	if (sawDefault) return "default";
	return "unknown";
}

function sanitizePlanOnlyTools(tools: unknown, mode: CollaborationMode): unknown {
	if (!Array.isArray(tools) || mode === "plan") return tools;

	let removed = 0;
	const filtered = tools.filter((entry) => {
		if (!entry || typeof entry !== "object") return true;
		const functionDef = (entry as { function?: unknown }).function;
		if (!functionDef || typeof functionDef !== "object") return true;
		const name = (functionDef as { name?: unknown }).name;
		if (typeof name !== "string") return true;
		if (!PLAN_MODE_ONLY_TOOLS.has(name)) return true;
		removed++;
		return false;
	});

	if (removed > 0) {
		logWarn(
			`Removed ${removed} plan-mode-only tool definition(s) because collaboration mode is ${mode}`,
		);
	}
	return filtered;
}

/**
 * Configure reasoning parameters based on model variant and user config
 *
 * NOTE: This plugin follows Codex CLI defaults instead of host defaults because:
 * - We're accessing the ChatGPT backend API (not OpenAI Platform API)
 * - opencode explicitly excludes gpt-5-codex from automatic reasoning configuration
 * - Codex CLI has been thoroughly tested against this backend
 *
 * @param originalModel - Original model name before normalization
 * @param userConfig - User configuration object
 * @returns Reasoning configuration
 */
export function getReasoningConfig(
	modelName: string | undefined,
	userConfig: ConfigOptions = {},
): ReasoningConfig {
	const normalizedName = modelName?.toLowerCase() ?? "";

	// Canonical GPT-5 Codex (stable) defaults to high and does not support "none".
	const isGpt5Codex =
		normalizedName.includes("gpt-5-codex") ||
		normalizedName.includes("gpt 5 codex");

	// Legacy GPT-5.3 Codex alias behavior (supports xhigh, but not "none")
	const isGpt53Codex =
		normalizedName.includes("gpt-5.3-codex") ||
		normalizedName.includes("gpt 5.3 codex");

	// Legacy GPT-5.2 Codex alias behavior (supports xhigh, but not "none")
	const isGpt52Codex =
		normalizedName.includes("gpt-5.2-codex") ||
		normalizedName.includes("gpt 5.2 codex");

	// GPT-5.2 general purpose (not codex variant)
	const isGpt52General =
		(normalizedName.includes("gpt-5.2") || normalizedName.includes("gpt 5.2")) &&
		!isGpt52Codex;
	const isCodexMax =
		normalizedName.includes("codex-max") ||
		normalizedName.includes("codex max");
	const isCodexMini =
		normalizedName.includes("codex-mini") ||
		normalizedName.includes("codex mini") ||
		normalizedName.includes("codex_mini") ||
		normalizedName.includes("codex-mini-latest");
	const isCodex = normalizedName.includes("codex") && !isCodexMini;
	const isLightweight =
		!isCodexMini &&
		(normalizedName.includes("nano") ||
			normalizedName.includes("mini"));

	// GPT-5.1 general purpose (not codex variants) - supports "none" per OpenAI API docs
	const isGpt51General =
		(
			normalizedName.includes("gpt-5.1") ||
			normalizedName.includes("gpt 5.1") ||
			normalizedName === "gpt-5" ||
			normalizedName.startsWith("gpt-5-")
		) &&
		!isCodex &&
		!isGpt52General &&
		!isCodexMax &&
		!isCodexMini;

	// GPT-5.2 general, legacy GPT-5.2/5.3 Codex aliases, and Codex Max support xhigh reasoning
	const supportsXhigh =
		isGpt52General || isGpt53Codex || isGpt52Codex || isCodexMax;

	// GPT 5.1 general and GPT 5.2 general support "none" reasoning per:
	// - OpenAI API docs: "gpt-5.1 defaults to none, supports: none, low, medium, high"
	// - Codex CLI: ReasoningEffort enum includes None variant (codex-rs/protocol/src/openai_models.rs)
	// - Codex CLI: docs/config.md lists "none" as valid for model_reasoning_effort
	// - gpt-5.2 (being newer) also supports: none, low, medium, high, xhigh
	// - Codex models (including GPT-5 Codex and legacy GPT-5.3/5.2 Codex aliases) do NOT support "none"
	const supportsNone = isGpt52General || isGpt51General;

	// Default based on model type (Codex CLI defaults + plugin opinionated tuning)
	// Note: OpenAI docs say gpt-5.1 defaults to "none", but we default to "medium"
	// for better coding assistance unless user explicitly requests "none".
	// - Canonical GPT-5 Codex defaults to high in stable Codex.
	// - Legacy GPT-5.3/5.2 Codex aliases default to xhigh for backward compatibility.
	const defaultEffort: ReasoningConfig["effort"] = isCodexMini
		? "medium"
		: isGpt5Codex
			? "high"
			: isGpt53Codex || isGpt52Codex
				? "xhigh"
			: supportsXhigh
			? "high"
			: isLightweight
				? "minimal"
				: "medium";

	// Get user-requested effort
	let effort = userConfig.reasoningEffort || defaultEffort;

	if (isCodexMini) {
		if (effort === "minimal" || effort === "low" || effort === "none") {
			effort = "medium";
		}
		if (effort === "xhigh") {
			effort = "high";
		}
		if (effort !== "high" && effort !== "medium") {
			effort = "medium";
		}
	}

	// For models that don't support xhigh, downgrade to high
	if (!supportsXhigh && effort === "xhigh") {
		effort = "high";
	}

	// For models that don't support "none", upgrade to "low"
	// (Codex models don't support "none" - only GPT-5.1 and GPT-5.2 general purpose do)
	if (!supportsNone && effort === "none") {
		effort = "low";
	}

	// Normalize "minimal" to "low" for Codex families
		// Codex CLI presets are low/medium/high (or xhigh for Codex Max / GPT-5.3/5.2 Codex)
	if (isCodex && effort === "minimal") {
		effort = "low";
	}

	const summary = sanitizeReasoningSummary(userConfig.reasoningSummary);

	return {
		effort,
		summary,
	};
}

function sanitizeReasoningSummary(
	summary: ConfigOptions["reasoningSummary"],
): SupportedReasoningSummary {
	if (!summary) return "auto";
	const normalized = summary.toLowerCase();
	if (normalized === "concise" || normalized === "detailed" || normalized === "auto") {
		return normalized;
	}
	return "auto";
}

/**
 * Filter input array for stateless Codex API (store: false)
 *
 * Two transformations needed:
 * 1. Remove AI SDK-specific items (not supported by Codex API)
 * 2. Strip IDs from all remaining items (stateless mode)
 *
 * AI SDK constructs to REMOVE (not in OpenAI Responses API spec):
 * - type: "item_reference" - AI SDK uses this for server-side state lookup
 *
 * Items to KEEP (strip IDs):
 * - type: "message" - Conversation messages (provides context to LLM)
 * - type: "function_call" - Tool calls from conversation
 * - type: "function_call_output" - Tool results from conversation
 *
 * Context is maintained through:
 * - Full message history (without IDs)
 * - reasoning.encrypted_content (for reasoning continuity)
 *
 * @param input - Original input array from host/AI SDK
 * @returns Filtered input array compatible with Codex API
 */
export function filterInput(
	input: InputItem[] | undefined,
): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter((item) => {
			// Remove AI SDK constructs not supported by Codex API
			if (item.type === "item_reference") {
				return false; // AI SDK only - references server state
			}
			return true; // Keep all other items
		})
		.map((item) => {
			// Strip IDs from all items (Codex API stateless mode)
			if (item.id) {
				const { id: _omit, ...itemWithoutId } = item;
				void _omit;
				return itemWithoutId as InputItem;
			}
			return item;
		});
}

/**
 * Trim long stateless histories for low-latency sessions.
 * Keeps a small leading developer/system context plus the most recent items.
 */
export function trimInputForFastSession(
	input: InputItem[] | undefined,
	maxItems: number,
	options?: { preferLatestUserOnly?: boolean },
): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;
	const MAX_HEAD_INSTRUCTION_CHARS = 1200;
	const MAX_HEAD_INSTRUCTION_CHARS_TRIVIAL = 400;

	if (options?.preferLatestUserOnly) {
		const keepIndexes = new Set<number>();

		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			if (!item || typeof item !== "object") continue;
			const role = typeof item?.role === "string" ? item.role : "";
			if (role === "developer" || role === "system") {
				const headText = extractMessageText(item.content);
				if (headText.length <= MAX_HEAD_INSTRUCTION_CHARS_TRIVIAL) {
					keepIndexes.add(i);
				}
				break;
			}
		}

		for (let i = input.length - 1; i >= 0; i--) {
			const item = input[i];
			const role = typeof item?.role === "string" ? item.role.toLowerCase() : "";
			if (role === "user") {
				keepIndexes.add(i);
				break;
			}
		}

		const compacted = input.filter((_item, index) => keepIndexes.has(index));
		if (compacted.length > 0) return compacted;
	}

	const safeMax = Math.max(8, Math.floor(maxItems));
	const keepIndexes = new Set<number>();
	const excludedHeadIndexes = new Set<number>();

	let keptHead = 0;
	for (let i = 0; i < input.length && keptHead < 2; i++) {
		const item = input[i];
		if (!item || typeof item !== "object") break;
		const role = typeof item?.role === "string" ? item.role : "";
		if (role === "developer" || role === "system") {
			const headText = extractMessageText(item.content);
			if (headText.length <= MAX_HEAD_INSTRUCTION_CHARS) {
				keepIndexes.add(i);
				keptHead++;
			} else {
				excludedHeadIndexes.add(i);
			}
			continue;
		}
		break;
	}

	for (let i = Math.max(0, input.length - safeMax); i < input.length; i++) {
		if (excludedHeadIndexes.has(i)) continue;
		keepIndexes.add(i);
	}

	const trimmed = input.filter((_item, index) => keepIndexes.has(index));
	if (trimmed.length === 0) return input;
	if (input.length <= maxItems && excludedHeadIndexes.size === 0) return input;
	if (trimmed.length <= safeMax) return trimmed;
	return trimmed.slice(trimmed.length - safeMax);
}

function isTrivialLatestPrompt(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	if (normalized.length > 220) return false;
	if (normalized.includes("\n")) return false;
	if (normalized.includes("```")) return false;
	if (/(^|\n)\s*(?:[-*]|\d+\.)\s+\S/m.test(normalized)) return false;
	if (/https?:\/\//i.test(normalized)) return false;
	if (/\|.+\|/.test(normalized)) return false;

	return true;
}

function isStructurallyComplexPrompt(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	if (normalized.includes("```")) return true;

	const lineCount = normalized.split(/\r?\n/).filter(Boolean).length;
	if (lineCount >= 3) return true;
	if (/(^|\n)\s*(?:[-*]|\d+\.)\s+\S/m.test(normalized)) return true;
	if (/\|.+\|/.test(normalized)) return true;
	return false;
}

function isComplexFastSessionRequest(
	body: RequestBody,
	maxItems: number,
): boolean {
	const input = Array.isArray(body.input) ? body.input : [];
	const lookbackWindow = Math.max(12, Math.floor(maxItems / 2));
	const recentItems = input.slice(-lookbackWindow);

	const userTexts: string[] = [];
	for (const item of recentItems) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "function_call" || item.type === "function_call_output") {
			return true;
		}
		const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
		if (role !== "user") continue;
		const text = extractMessageText(item.content);
		if (!text) continue;
		userTexts.push(text);
	}

	if (userTexts.length === 0) return false;

	const latestUserText = userTexts[userTexts.length - 1];
	if (latestUserText && isTrivialLatestPrompt(latestUserText)) {
		return false;
	}

	const recentUserTexts = userTexts.slice(-3);
	if (recentUserTexts.some(isStructurallyComplexPrompt)) return true;
	return false;
}

function getLatestUserText(input: InputItem[] | undefined): string | undefined {
	if (!Array.isArray(input)) return undefined;
	for (let i = input.length - 1; i >= 0; i--) {
		const item = input[i];
		if (!item || typeof item !== "object") continue;
		const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
		if (role !== "user") continue;
		const text = extractMessageText(item.content);
		if (text) return text;
	}
	return undefined;
}

function compactInstructionsForFastSession(
	instructions: string,
	isTrivialTurn = false,
): string {
	const normalized = instructions.trim();
	if (!normalized) return instructions;

	const MAX_FAST_INSTRUCTION_CHARS = isTrivialTurn ? 320 : 900;
	if (normalized.length <= MAX_FAST_INSTRUCTION_CHARS) {
		return instructions;
	}

	const splitIndex = normalized.lastIndexOf("\n", MAX_FAST_INSTRUCTION_CHARS);
	const safeCutoff = splitIndex >= 180 ? splitIndex : MAX_FAST_INSTRUCTION_CHARS;
	const compacted = normalized.slice(0, safeCutoff).trimEnd();
	return `${compacted}\n\n[Fast session mode: keep answers concise, direct, and action-oriented. Do not output internal planning labels such as "Thinking:".]`;
}

/**
 * Filter out host system prompts from input
 * Used in CODEX_MODE to replace host prompts with Codex bridge guidance
 * @param input - Input array
 * @returns Input array without host system prompts
 */
export async function filterOpenCodeSystemPrompts(
	input: InputItem[] | undefined,
): Promise<InputItem[] | undefined> {
	if (!Array.isArray(input)) return input;

	// Fetch cached host prompt for verification
	let cachedPrompt: string | null = null;
	try {
		cachedPrompt = await getOpenCodeCodexPrompt();
	} catch {
		// If fetch fails, fallback to text-based detection only
		// This is safe because we still have the "starts with" check
	}

	return filterOpenCodeSystemPromptsWithCachedPrompt(input, cachedPrompt);
}

/**
 * Add Codex bridge message to input if tools are present
 * @param input - Input array
 * @param hasTools - Whether tools are present in request
 * @returns Input array with bridge message prepended if needed
 */
export function addCodexBridgeMessage(
	input: InputItem[] | undefined,
	hasTools: boolean,
): InputItem[] | undefined {
	if (!hasTools || !Array.isArray(input)) return input;

	const bridgeMessage: InputItem = {
		type: "message",
		role: "developer",
		content: [
			{
				type: "input_text",
				text: CODEX_OPENCODE_BRIDGE,
			},
		],
	};

	return [bridgeMessage, ...input];
}

/**
 * Add tool remapping message to input if tools are present
 * @param input - Input array
 * @param hasTools - Whether tools are present in request
 * @returns Input array with tool remap message prepended if needed
 */
export function addToolRemapMessage(
	input: InputItem[] | undefined,
	hasTools: boolean,
): InputItem[] | undefined {
	if (!hasTools || !Array.isArray(input)) return input;

	const toolRemapMessage: InputItem = {
		type: "message",
		role: "developer",
		content: [
			{
				type: "input_text",
				text: TOOL_REMAP_MESSAGE,
			},
		],
	};

	return [toolRemapMessage, ...input];
}

/**
 * Transform request body for Codex API
 *
 * NOTE: Configuration follows Codex CLI patterns instead of host defaults:
 * - host may set textVerbosity="low" for gpt-5, but Codex CLI uses "medium"
 * - host may exclude gpt-5-codex from reasoning configuration
 * - This plugin uses store=false (stateless), requiring encrypted reasoning content
 *
 * @param body - Original request body
 * @param codexInstructions - Codex system instructions
 * @param userConfig - User configuration from loader
 * @param codexMode - Enable CODEX_MODE (bridge prompt instead of tool remap) - defaults to true
 * @param fastSession - Force low-latency output settings for faster responses
 * @returns Transformed request body
 */
export async function transformRequestBody(
	body: RequestBody,
	codexInstructions: string,
	userConfig: UserConfig = { global: {}, models: {} },
	codexMode = true,
	fastSession = false,
	fastSessionStrategy: FastSessionStrategy = "hybrid",
	fastSessionMaxInputItems = 30,
): Promise<RequestBody> {
	const originalModel = body.model;
	const normalizedModel = normalizeModel(body.model);

	// Get model-specific configuration using ORIGINAL model name (config key)
	// This allows per-model options like "gpt-5-codex-low" to work correctly
	const lookupModel = originalModel || normalizedModel;
	const modelConfig = getModelConfig(lookupModel, userConfig);

	// Debug: Log which config was resolved
	logDebug(
		`Model config lookup: "${lookupModel}" → normalized to "${normalizedModel}" for API`,
		{
			hasModelSpecificConfig: !!userConfig.models?.[lookupModel],
			resolvedConfig: modelConfig,
		},
	);

	// Normalize model name for API call
	body.model = normalizedModel;
	const shouldUseNormalizedReasoningModel =
		normalizedModel === "gpt-5-codex" &&
		lookupModel.toLowerCase().includes("codex");
	const reasoningModel = shouldUseNormalizedReasoningModel
		? normalizedModel
		: lookupModel;
	const shouldApplyFastSessionTuning =
		fastSession &&
		(fastSessionStrategy === "always" ||
			!isComplexFastSessionRequest(body, fastSessionMaxInputItems));
	const latestUserText = getLatestUserText(body.input);
	const isTrivialTurn = isTrivialLatestPrompt(latestUserText ?? "");
	const shouldDisableToolsForTrivialTurn =
		shouldApplyFastSessionTuning &&
		isTrivialTurn;
	const shouldPreferLatestUserOnly =
		shouldApplyFastSessionTuning && isTrivialTurn;

	// Codex required fields
	// ChatGPT backend REQUIRES store=false (confirmed via testing)
	body.store = false;
	// Always set stream=true for API - response handling detects original intent
	body.stream = true;

	// Clean up tool definitions (implement strict "require" logic)
	// Filters invalid required fields and ensures empty objects have placeholders
	const collaborationMode = detectCollaborationMode(body);
	if (body.tools) {
		if (shouldDisableToolsForTrivialTurn) {
			body.tools = undefined;
		}
	}
	if (body.tools) {
		body.tools = cleanupToolDefinitions(body.tools);
		body.tools = sanitizePlanOnlyTools(body.tools, collaborationMode);
	}

	body.instructions = shouldApplyFastSessionTuning
		? compactInstructionsForFastSession(codexInstructions, isTrivialTurn)
		: codexInstructions;

	// Prompt caching relies on the host providing a stable prompt_cache_key
	// Host passes its session identifier. We no longer synthesize one here.

	// Filter and transform input
	if (body.input && Array.isArray(body.input)) {
		let inputItems: InputItem[] = body.input;

			if (shouldApplyFastSessionTuning) {
				inputItems =
					trimInputForFastSession(inputItems, fastSessionMaxInputItems, {
						preferLatestUserOnly: shouldPreferLatestUserOnly,
					}) ?? inputItems;
			}

		// Debug: Log original input message IDs before filtering
		const originalIds = inputItems
			.filter((item) => item.id)
			.map((item) => item.id);
		if (originalIds.length > 0) {
			logDebug(
				`Filtering ${originalIds.length} message IDs from input:`,
				originalIds,
			);
		}

		inputItems = filterInput(inputItems) ?? inputItems;
		body.input = inputItems;

		// istanbul ignore next -- filterInput always removes IDs; this is defensive debug code
		const remainingIds = (body.input || [])
			.filter((item) => item.id)
			.map((item) => item.id);
		// istanbul ignore if -- filterInput always removes IDs; defensive debug warning
		if (remainingIds.length > 0) {
			logWarn(
				`WARNING: ${remainingIds.length} IDs still present after filtering:`,
				remainingIds,
			);
		} else if (originalIds.length > 0) {
			logDebug(`Successfully removed all ${originalIds.length} message IDs`);
		}

		if (codexMode) {
			// CODEX_MODE: Remove host system prompt, add bridge prompt
			body.input = await filterOpenCodeSystemPrompts(body.input);
			body.input = addCodexBridgeMessage(body.input, !!body.tools);
		} else {
			// DEFAULT MODE: Keep original behavior with tool remap message
			body.input = addToolRemapMessage(body.input, !!body.tools);
		}

		// Handle orphaned function_call_output items (where function_call was an item_reference that got filtered)
		// Instead of removing orphans (which causes infinite loops as LLM loses tool results),
		// convert them to messages to preserve context while avoiding API errors
		if (body.input) {
			body.input = normalizeOrphanedToolOutputs(body.input);
			body.input = injectMissingToolOutputs(body.input);
		}
	}

	// Configure reasoning (prefer existing body/provider options, then config defaults)
	const reasoningConfig = resolveReasoningConfig(
		reasoningModel,
		modelConfig,
		body,
	);
	body.reasoning = {
		...body.reasoning,
		...reasoningConfig,
	};

	// Configure text verbosity (support user config)
	// Default: "medium" (matches Codex CLI default for all GPT-5 models)
	body.text = {
		...body.text,
		verbosity: resolveTextVerbosity(modelConfig, body),
	};

	if (shouldApplyFastSessionTuning) {
		// In fast-session mode, prioritize speed by clamping to minimum reasoning + verbosity.
		// getReasoningConfig normalizes unsupported values per model family.
		const fastReasoning = getReasoningConfig(reasoningModel, {
			reasoningEffort: "none",
			reasoningSummary: "auto",
		});
		body.reasoning = {
			...body.reasoning,
			...fastReasoning,
		};
		body.text = {
			...body.text,
			verbosity: "low",
		};
	}

	// Add include for encrypted reasoning content
	// Default: ["reasoning.encrypted_content"] (required for stateless operation with store=false)
	// This allows reasoning context to persist across turns without server-side storage
	body.include = resolveInclude(modelConfig, body);

	// Remove unsupported parameters
	body.max_output_tokens = undefined;
	body.max_completion_tokens = undefined;

	return body;
}
