/**
 * Model Configuration Map
 *
 * Maps host/runtime model identifiers to the effective model name we send to the
 * OpenAI Responses API. The catalog also carries prompt-family, reasoning, and
 * tool-surface metadata so routing logic stays consistent across the request
 * transformer, prompt selection, and CLI diagnostics.
 */

export type ModelReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export type PromptModelFamily =
	| "gpt-5-codex"
	| "codex-max"
	| "codex"
	| "gpt-5.2"
	| "gpt-5.1";

export interface ModelCapabilities {
	toolSearch: boolean;
	computerUse: boolean;
	compaction: boolean;
}

export interface ModelProfile {
	normalizedModel: string;
	promptFamily: PromptModelFamily;
	defaultReasoningEffort: ModelReasoningEffort;
	supportedReasoningEfforts: readonly ModelReasoningEffort[];
	capabilities: ModelCapabilities;
}

const REASONING_VARIANTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ModelReasoningEffort[];

const TOOL_CAPABILITIES = {
	full: {
		toolSearch: true,
		computerUse: true,
		compaction: true,
	},
	computerOnly: {
		toolSearch: false,
		computerUse: true,
		compaction: false,
	},
	computerAndCompact: {
		toolSearch: false,
		computerUse: true,
		compaction: true,
	},
	compactOnly: {
		toolSearch: false,
		computerUse: false,
		compaction: true,
	},
	basic: {
		toolSearch: false,
		computerUse: false,
		compaction: false,
	},
} as const satisfies Record<string, ModelCapabilities>;

export const DEFAULT_MODEL = "gpt-5.4";

/**
 * Effective model profiles keyed by canonical model name.
 *
 * Prompt families intentionally stay on the latest prompt files currently
 * shipped by upstream Codex CLI. GPT-5.4 era general-purpose models still use
 * the GPT-5.2 prompt family because `gpt_5_4_prompt.md` is not present in the
 * latest upstream release.
 */
export const MODEL_PROFILES: Record<string, ModelProfile> = {
	"gpt-5-codex": {
		normalizedModel: "gpt-5-codex",
		promptFamily: "gpt-5-codex",
		defaultReasoningEffort: "high",
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5.1-codex-max": {
		normalizedModel: "gpt-5.1-codex-max",
		promptFamily: "codex-max",
		defaultReasoningEffort: "high",
		supportedReasoningEfforts: ["medium", "high", "xhigh"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5.1-codex-mini": {
		normalizedModel: "gpt-5.1-codex-mini",
		promptFamily: "gpt-5-codex",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: ["medium", "high"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5.4": {
		normalizedModel: "gpt-5.4",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "none",
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
		capabilities: TOOL_CAPABILITIES.full,
	},
	"gpt-5.4-pro": {
		normalizedModel: "gpt-5.4-pro",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "high",
		supportedReasoningEfforts: ["medium", "high", "xhigh"],
		capabilities: TOOL_CAPABILITIES.computerAndCompact,
	},
	"gpt-5.2-pro": {
		normalizedModel: "gpt-5.2-pro",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "high",
		supportedReasoningEfforts: ["medium", "high", "xhigh"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5-pro": {
		normalizedModel: "gpt-5-pro",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "high",
		supportedReasoningEfforts: ["high"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5.2": {
		normalizedModel: "gpt-5.2",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "none",
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5.1": {
		normalizedModel: "gpt-5.1",
		promptFamily: "gpt-5.1",
		defaultReasoningEffort: "none",
		supportedReasoningEfforts: ["none", "low", "medium", "high"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5": {
		normalizedModel: "gpt-5",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
		capabilities: TOOL_CAPABILITIES.basic,
	},
	"gpt-5-mini": {
		normalizedModel: "gpt-5-mini",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: ["medium"],
		capabilities: TOOL_CAPABILITIES.compactOnly,
	},
	"gpt-5-nano": {
		normalizedModel: "gpt-5-nano",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: ["medium"],
		capabilities: TOOL_CAPABILITIES.compactOnly,
	},
} as const;

const MODEL_MAP: Record<string, string> = {};

function addAlias(alias: string, normalizedModel: string): void {
	MODEL_MAP[alias] = normalizedModel;
}

function addReasoningAliases(alias: string, normalizedModel: string): void {
	addAlias(alias, normalizedModel);
	for (const variant of REASONING_VARIANTS) {
		addAlias(`${alias}-${variant}`, normalizedModel);
	}
}

function addGeneralAliases(): void {
	addReasoningAliases("gpt-5.4", "gpt-5.4");
	addReasoningAliases("gpt-5.4-pro", "gpt-5.4-pro");
	addReasoningAliases("gpt-5.2-pro", "gpt-5.2-pro");
	addReasoningAliases("gpt-5-pro", "gpt-5-pro");
	addReasoningAliases("gpt-5.2", "gpt-5.2");
	addReasoningAliases("gpt-5.1", "gpt-5.1");
	addReasoningAliases("gpt-5", "gpt-5");
	addReasoningAliases("gpt-5-mini", "gpt-5-mini");
	addReasoningAliases("gpt-5-nano", "gpt-5-nano");

	addReasoningAliases("gpt-5.1-chat-latest", "gpt-5.1");
	addReasoningAliases("gpt-5-chat-latest", "gpt-5");
	addReasoningAliases("gpt-5.4-mini", "gpt-5-mini");
	addReasoningAliases("gpt-5.4-nano", "gpt-5-nano");
}

function addCodexAliases(): void {
	addReasoningAliases("gpt-5-codex", "gpt-5-codex");
	addReasoningAliases("gpt-5.3-codex-spark", "gpt-5-codex");
	addReasoningAliases("gpt-5.3-codex", "gpt-5-codex");
	addReasoningAliases("gpt-5.2-codex", "gpt-5-codex");
	addReasoningAliases("gpt-5.1-codex", "gpt-5-codex");
	addAlias("gpt_5_codex", "gpt-5-codex");

	addReasoningAliases("gpt-5.1-codex-max", "gpt-5.1-codex-max");
	addAlias("codex-max", "gpt-5.1-codex-max");

	addAlias("codex-mini-latest", "gpt-5.1-codex-mini");
	addReasoningAliases("gpt-5-codex-mini", "gpt-5.1-codex-mini");
	addReasoningAliases("gpt-5.1-codex-mini", "gpt-5.1-codex-mini");
}

addCodexAliases();
addGeneralAliases();

export { MODEL_MAP };

function stripProviderPrefix(modelId: string): string {
	return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
}

function lookupMappedModel(modelId: string): string | undefined {
	if (Object.hasOwn(MODEL_MAP, modelId)) {
		return MODEL_MAP[modelId];
	}

	const lowerModelId = modelId.toLowerCase();
	const match = Object.keys(MODEL_MAP).find(
		(key) => key.toLowerCase() === lowerModelId,
	);

	return match ? MODEL_MAP[match] : undefined;
}

/**
 * Get normalized model name from a known config/runtime identifier.
 *
 * This does exact/alias lookup only. Use `resolveNormalizedModel()` when you
 * want GPT-5 family fallback behavior for unknown-but-similar names.
 */
export function getNormalizedModel(modelId: string): string | undefined {
	try {
		const stripped = stripProviderPrefix(modelId.trim());
		if (!stripped) return undefined;
		return lookupMappedModel(stripped);
	} catch {
		return undefined;
	}
}

/**
 * Resolve a model identifier to the effective API model.
 *
 * This expands exact alias lookup with GPT-5 family fallback rules so the
 * plugin never silently downgrades modern GPT-5 requests to GPT-5.1-era
 * routing.
 */
export function resolveNormalizedModel(model: string | undefined): string {
	if (!model) return DEFAULT_MODEL;

	const modelId = stripProviderPrefix(model).trim();
	if (!modelId) return DEFAULT_MODEL;

	const mappedModel = lookupMappedModel(modelId);
	if (mappedModel) {
		return mappedModel;
	}

	const normalized = modelId.toLowerCase();

	if (
		normalized.includes("gpt-5.3-codex-spark") ||
		normalized.includes("gpt 5.3 codex spark")
	) {
		return "gpt-5-codex";
	}
	if (
		normalized.includes("gpt-5.3-codex") ||
		normalized.includes("gpt 5.3 codex")
	) {
		return "gpt-5-codex";
	}
	if (
		normalized.includes("gpt-5.2-codex") ||
		normalized.includes("gpt 5.2 codex")
	) {
		return "gpt-5-codex";
	}
	if (
		normalized.includes("gpt-5.1-codex-max") ||
		normalized.includes("gpt 5.1 codex max")
	) {
		return "gpt-5.1-codex-max";
	}
	if (
		normalized.includes("gpt-5.1-codex-mini") ||
		normalized.includes("gpt 5.1 codex mini") ||
		normalized.includes("codex-mini-latest") ||
		normalized.includes("gpt-5-codex-mini") ||
		normalized.includes("gpt 5 codex mini")
	) {
		return "gpt-5.1-codex-mini";
	}
	if (
		normalized.includes("gpt-5-codex") ||
		normalized.includes("gpt 5 codex") ||
		normalized.includes("gpt-5.1-codex") ||
		normalized.includes("gpt 5.1 codex") ||
		normalized.includes("codex")
	) {
		return "gpt-5-codex";
	}
	if (
		normalized.includes("gpt-5.4-pro") ||
		normalized.includes("gpt 5.4 pro")
	) {
		return "gpt-5.4-pro";
	}
	if (
		normalized.includes("gpt-5.2-pro") ||
		normalized.includes("gpt 5.2 pro")
	) {
		return "gpt-5.2-pro";
	}
	if (
		normalized.includes("gpt-5-pro") ||
		normalized.includes("gpt 5 pro")
	) {
		return "gpt-5-pro";
	}
	if (
		normalized.includes("gpt-5.4-mini") ||
		normalized.includes("gpt 5.4 mini") ||
		normalized.includes("gpt-5-mini") ||
		normalized.includes("gpt 5 mini")
	) {
		return "gpt-5-mini";
	}
	if (
		normalized.includes("gpt-5.4-nano") ||
		normalized.includes("gpt 5.4 nano") ||
		normalized.includes("gpt-5-nano") ||
		normalized.includes("gpt 5 nano")
	) {
		return "gpt-5-nano";
	}
	if (
		normalized.includes("gpt-5.4") ||
		normalized.includes("gpt 5.4")
	) {
		return "gpt-5.4";
	}
	if (
		normalized.includes("gpt-5.2") ||
		normalized.includes("gpt 5.2")
	) {
		return "gpt-5.2";
	}
	if (
		normalized.includes("gpt-5.1") ||
		normalized.includes("gpt 5.1")
	) {
		return "gpt-5.1";
	}
	if (normalized === "gpt-5" || normalized.includes("gpt-5") || normalized.includes("gpt 5")) {
		return "gpt-5.4";
	}

	return DEFAULT_MODEL;
}

/**
 * Resolve the effective model profile for a requested model string.
 */
export function getModelProfile(model: string | undefined): ModelProfile {
	const normalizedModel = resolveNormalizedModel(model);
	const profile = MODEL_PROFILES[normalizedModel];
	if (profile) {
		return profile;
	}

	const fallbackProfile = MODEL_PROFILES[DEFAULT_MODEL];
	if (fallbackProfile) {
		return fallbackProfile;
	}

	throw new Error(`Default model profile is missing for ${DEFAULT_MODEL}`);
}

/**
 * Expose current tool-surface metadata for diagnostics and capability checks.
 */
export function getModelCapabilities(model: string | undefined): ModelCapabilities {
	return getModelProfile(model).capabilities;
}

/**
 * Check if a model ID is in the explicit model map.
 *
 * This only returns `true` for exact known aliases. Use
 * `resolveNormalizedModel()` if you want the fallback behavior.
 */
export function isKnownModel(modelId: string): boolean {
	return getNormalizedModel(modelId) !== undefined;
}
