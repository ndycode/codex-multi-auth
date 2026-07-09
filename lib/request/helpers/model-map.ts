/**
 * Model Configuration Map
 *
 * Maps host/runtime model identifiers to the effective model name we send to the
 * OpenAI Responses API. The catalog also carries prompt-family, reasoning, and
 * tool-surface metadata so routing logic stays consistent across the request
 * transformer, prompt selection, and CLI diagnostics.
 */

// The effort union lives in the leaf constants module so the base types layer
// (`lib/types.ts`) can depend on it without importing this file, which would
// close a cycle through `lib/schemas.ts`. Re-exported here for existing callers.
import type {
	ModelReasoningEffort,
	WireReasoningEffort,
} from "../../constants.js";

export type { ModelReasoningEffort, WireReasoningEffort };

export type PromptModelFamily =
	| "gpt-5-codex"
	| "codex-max"
	| "codex"
	| "gpt-5.2"
	| "gpt-5.1";

/**
 * Model family type for prompt selection
 * Maps to different system prompts in the Codex CLI
 */
export type ModelFamily = PromptModelFamily;

/**
 * All supported model families
 * Used for per-family account rotation and rate limit tracking
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
	"gpt-5-codex",
	"codex-max",
	"codex",
	"gpt-5.2",
	"gpt-5.1",
] as const;

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

type GeneralGpt5Variant = "base" | "pro" | "mini" | "nano";
type GeneralGpt5KnownMinor = 1 | 2 | 4 | 5;
type GeneralGpt5VariantCatalog = Partial<
	Record<GeneralGpt5Variant, string>
>;

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

export const CURRENT_CODEX_MODEL = "gpt-5.3-codex";
export const DEFAULT_MODEL = "gpt-5.5";

// Single source of truth for the live/quota probe fallback chain. Both the
// manager probe (lib/quota-probe.ts) and the runtime probe (lib/runtime/quota-probe.ts)
// import this so the ordered candidate list cannot drift between them.
export const QUOTA_PROBE_MODEL_CHAIN = [
	DEFAULT_MODEL,
	"gpt-5.4",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5-codex",
] as const;

const LEGACY_CODEX_MODEL = "gpt-5-codex";

/**
 * GPT-5.6 tiers, per the upstream Codex catalog
 * (openai/codex `codex-rs/models-manager/models.json`).
 *
 * Sol and Terra expose `ultra`; Luna stops at `max`. No tier accepts `none` or
 * `minimal`, so those aliases are deliberately never generated for them.
 */
const GPT_5_6_SOL_MODEL = "gpt-5.6-sol";
const GPT_5_6_TERRA_MODEL = "gpt-5.6-terra";
const GPT_5_6_LUNA_MODEL = "gpt-5.6-luna";

/** Bare `gpt-5.6` is OpenAI's documented alias for the flagship (Sol) tier. */
const GPT_5_6_FLAGSHIP_ALIAS = "gpt-5.6";

const GPT_5_6_SOL_TERRA_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const satisfies readonly ModelReasoningEffort[];

const GPT_5_6_LUNA_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelReasoningEffort[];

const GPT_5_5_CANONICAL_MODEL = "gpt-5.5";
const GPT_5_5_PRO_CANONICAL_MODEL = "gpt-5.5-pro";
const GPT_5_5_RELEASE_MODEL = "gpt-5.5-2026-04-23";
const GPT_5_5_PRO_RELEASE_MODEL = "gpt-5.5-pro-2026-04-23";
const GPT_5_5_RELEASE_COMPAT_MODEL = "gpt-5.5-20260423";
const GPT_5_5_PRO_RELEASE_COMPAT_MODEL = "gpt-5.5-pro-20260423";

const GENERAL_GPT5_VERSION_CATALOG: Record<
	GeneralGpt5KnownMinor,
	GeneralGpt5VariantCatalog
> = {
	1: {
		base: "gpt-5.1",
	},
	2: {
		base: "gpt-5.2",
		pro: "gpt-5.2-pro",
	},
	4: {
		base: DEFAULT_MODEL,
		pro: "gpt-5.4-pro",
		mini: "gpt-5.4-mini",
		nano: "gpt-5.4-nano",
	},
	5: {
		base: GPT_5_5_CANONICAL_MODEL,
		pro: GPT_5_5_PRO_CANONICAL_MODEL,
		mini: "gpt-5-mini",
		nano: "gpt-5-nano",
	},
};

const GENERAL_GPT5_STABLE_VARIANTS = GENERAL_GPT5_VERSION_CATALOG[5];

const GENERAL_GPT5_GENERIC_VARIANTS: Record<GeneralGpt5Variant, string> = {
	base: DEFAULT_MODEL,
	pro: GPT_5_5_PRO_CANONICAL_MODEL,
	mini: "gpt-5-mini",
	nano: "gpt-5-nano",
};

/**
 * Effective model profiles keyed by canonical model name.
 *
 * Prompt families intentionally stay on the latest prompt files currently
 * shipped by upstream Codex CLI. GPT-5.4/5.5-era general-purpose models still
 * use the GPT-5.2 prompt family because no newer general prompt file is
 * present in the latest upstream release.
 */
export const MODEL_PROFILES: Record<string, ModelProfile> = {
	[CURRENT_CODEX_MODEL]: {
		normalizedModel: CURRENT_CODEX_MODEL,
		promptFamily: "gpt-5-codex",
		defaultReasoningEffort: "high",
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
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
	"gpt-5.4-mini": {
		normalizedModel: "gpt-5.4-mini",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: ["medium"],
		capabilities: TOOL_CAPABILITIES.compactOnly,
	},
	"gpt-5.4-nano": {
		normalizedModel: "gpt-5.4-nano",
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: ["medium"],
		capabilities: TOOL_CAPABILITIES.compactOnly,
	},
	// GPT-5.6 ships its base instructions inline in the upstream model catalog
	// rather than as a `gpt_5_6_prompt.md`, so these stay on the GPT-5.2 prompt
	// family alongside the other post-5.2 general models.
	[GPT_5_6_SOL_MODEL]: {
		normalizedModel: GPT_5_6_SOL_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "low",
		supportedReasoningEfforts: GPT_5_6_SOL_TERRA_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[GPT_5_6_TERRA_MODEL]: {
		normalizedModel: GPT_5_6_TERRA_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: GPT_5_6_SOL_TERRA_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[GPT_5_6_LUNA_MODEL]: {
		normalizedModel: GPT_5_6_LUNA_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: GPT_5_6_LUNA_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[GPT_5_5_CANONICAL_MODEL]: {
		normalizedModel: GPT_5_5_CANONICAL_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "none",
		supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
		capabilities: TOOL_CAPABILITIES.full,
	},
	[GPT_5_5_PRO_CANONICAL_MODEL]: {
		normalizedModel: GPT_5_5_PRO_CANONICAL_MODEL,
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

/**
 * Register a model plus one alias per effort it actually supports.
 *
 * Unlike `addReasoningAliases`, this does not assume the global variant list:
 * GPT-5.6 rejects `none`/`minimal` and only Sol/Terra accept `ultra`.
 */
function addEffortAliases(
	alias: string,
	normalizedModel: string,
	efforts: readonly ModelReasoningEffort[],
): void {
	addAlias(alias, normalizedModel);
	for (const effort of efforts) {
		addAlias(`${alias}-${effort}`, normalizedModel);
	}
}

function addGpt56Aliases(): void {
	addEffortAliases(GPT_5_6_SOL_MODEL, GPT_5_6_SOL_MODEL, GPT_5_6_SOL_TERRA_EFFORTS);
	addEffortAliases(
		GPT_5_6_TERRA_MODEL,
		GPT_5_6_TERRA_MODEL,
		GPT_5_6_SOL_TERRA_EFFORTS,
	);
	addEffortAliases(GPT_5_6_LUNA_MODEL, GPT_5_6_LUNA_MODEL, GPT_5_6_LUNA_EFFORTS);
	addEffortAliases(
		GPT_5_6_FLAGSHIP_ALIAS,
		GPT_5_6_SOL_MODEL,
		GPT_5_6_SOL_TERRA_EFFORTS,
	);
}

function addGeneralAliases(): void {
	addReasoningAliases(GPT_5_5_CANONICAL_MODEL, GPT_5_5_CANONICAL_MODEL);
	addReasoningAliases(GPT_5_5_RELEASE_MODEL, GPT_5_5_CANONICAL_MODEL);
	addReasoningAliases(
		GPT_5_5_RELEASE_COMPAT_MODEL,
		GPT_5_5_CANONICAL_MODEL,
	);
	addReasoningAliases(
		GPT_5_5_PRO_CANONICAL_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addReasoningAliases(
		GPT_5_5_PRO_RELEASE_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addReasoningAliases(
		GPT_5_5_PRO_RELEASE_COMPAT_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addReasoningAliases("gpt-5.4", "gpt-5.4");
	addReasoningAliases("gpt-5.4-pro", "gpt-5.4-pro");
	addReasoningAliases("gpt-5.4-mini", "gpt-5.4-mini");
	addReasoningAliases("gpt-5.4-nano", "gpt-5.4-nano");
	addReasoningAliases("gpt-5.2-pro", "gpt-5.2-pro");
	addReasoningAliases("gpt-5-pro", GPT_5_5_PRO_CANONICAL_MODEL);
	addReasoningAliases("gpt-5.2", "gpt-5.2");
	addReasoningAliases("gpt-5.1", "gpt-5.1");
	addReasoningAliases("gpt-5", DEFAULT_MODEL);
	addReasoningAliases("gpt-5-mini", "gpt-5-mini");
	addReasoningAliases("gpt-5-nano", "gpt-5-nano");

	addReasoningAliases("gpt-5.1-chat-latest", "gpt-5.1");
	addReasoningAliases("gpt-5-chat-latest", DEFAULT_MODEL);
}

function addCodexAliases(): void {
	addReasoningAliases(CURRENT_CODEX_MODEL, CURRENT_CODEX_MODEL);
	addReasoningAliases("gpt-5.3-codex-spark", CURRENT_CODEX_MODEL);
	addReasoningAliases(LEGACY_CODEX_MODEL, CURRENT_CODEX_MODEL);
	addReasoningAliases("gpt-5.2-codex", CURRENT_CODEX_MODEL);
	addReasoningAliases("gpt-5.1-codex", CURRENT_CODEX_MODEL);
	addAlias("gpt_5_codex", CURRENT_CODEX_MODEL);

	addReasoningAliases("codex-max", CURRENT_CODEX_MODEL);
	addReasoningAliases("gpt-5.1-codex-max", CURRENT_CODEX_MODEL);
	addAlias("codex-max", CURRENT_CODEX_MODEL);

	addAlias("codex-mini-latest", CURRENT_CODEX_MODEL);
	addReasoningAliases("gpt-5-codex-mini", CURRENT_CODEX_MODEL);
	addReasoningAliases("gpt-5.1-codex-mini", CURRENT_CODEX_MODEL);
}

addCodexAliases();
addGeneralAliases();
addGpt56Aliases();

export { MODEL_MAP };

function stripProviderPrefix(modelId: string): string {
	return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
}

function tokenizeModelId(modelId: string): string[] {
	return modelId
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function getGeneralGpt5CatalogForMinor(
	minor: number,
): GeneralGpt5VariantCatalog | undefined {
	switch (minor) {
		case 1:
		case 2:
		case 4:
		case 5:
			return GENERAL_GPT5_VERSION_CATALOG[minor];
		default:
			return undefined;
	}
}

function resolveGeneralGpt5CatalogVariant(
	catalog: GeneralGpt5VariantCatalog | undefined,
	variant: GeneralGpt5Variant,
): string | undefined {
	return catalog?.[variant] ?? catalog?.base;
}

function resolveStableGeneralGpt5Variant(
	variant: GeneralGpt5Variant,
): string {
	const fallback =
		GENERAL_GPT5_STABLE_VARIANTS[variant] ??
		GENERAL_GPT5_STABLE_VARIANTS.base;
	if (fallback) {
		return fallback;
	}

	throw new Error(`Stable GPT-5 fallback is missing for variant ${variant}`);
}

function resolveCodexCatalogModel(modelId: string): string | undefined {
	const normalized = modelId.toLowerCase();

	if (
		normalized.includes("gpt-5.3-codex-spark") ||
		normalized.includes("gpt 5.3 codex spark")
	) {
		return CURRENT_CODEX_MODEL;
	}
	if (
		normalized.includes("gpt-5.3-codex") ||
		normalized.includes("gpt 5.3 codex")
	) {
		return CURRENT_CODEX_MODEL;
	}
	if (
		normalized.includes("gpt-5.2-codex") ||
		normalized.includes("gpt 5.2 codex")
	) {
		return CURRENT_CODEX_MODEL;
	}
	if (
		normalized.includes("gpt-5.1-codex-max") ||
		normalized.includes("gpt 5.1 codex max")
	) {
		return CURRENT_CODEX_MODEL;
	}
	if (
		normalized.includes("gpt-5.1-codex-mini") ||
		normalized.includes("gpt 5.1 codex mini") ||
		normalized.includes("codex-mini-latest") ||
		normalized.includes("gpt-5-codex-mini") ||
		normalized.includes("gpt 5 codex mini")
	) {
		return CURRENT_CODEX_MODEL;
	}
	if (
		normalized.includes("gpt-5-codex") ||
		normalized.includes("gpt 5 codex") ||
		normalized.includes("gpt-5.1-codex") ||
		normalized.includes("gpt 5.1 codex") ||
		normalized.includes("codex")
	) {
		return CURRENT_CODEX_MODEL;
	}

	return undefined;
}

/**
 * Resolve GPT-5.6 identifiers that are not exact aliases (for example a future
 * `gpt-5.6-terra-fast`).
 *
 * Without this, the general GPT-5 resolver sees minor `6`, finds no catalog
 * entry, and silently falls back to the stable 5.5 model — running a different
 * model than the caller asked for. Unrecognised tiers resolve to Sol, matching
 * OpenAI's bare `gpt-5.6` alias.
 */
function resolveGpt56CatalogModel(modelId: string): string | undefined {
	const tokens = tokenizeModelId(modelId);
	const gptIndex = tokens.indexOf("gpt");
	const isGpt56 =
		gptIndex !== -1 && tokens[gptIndex + 1] === "5" && tokens[gptIndex + 2] === "6";
	if (!isGpt56 || tokens.includes("codex")) {
		return undefined;
	}

	if (tokens.includes("terra")) return GPT_5_6_TERRA_MODEL;
	if (tokens.includes("luna")) return GPT_5_6_LUNA_MODEL;
	return GPT_5_6_SOL_MODEL;
}

function resolveGeneralGpt5CatalogModel(modelId: string): string | undefined {
	const tokens = tokenizeModelId(modelId);
	const gptIndex = tokens.indexOf("gpt");
	const isGpt5 = gptIndex !== -1 && tokens[gptIndex + 1] === "5";
	if (!isGpt5 || tokens.includes("codex")) {
		return undefined;
	}

	const rawMinor = tokens[gptIndex + 2];
	const minor =
		rawMinor && /^\d+$/.test(rawMinor) ? Number(rawMinor) : undefined;
	const variant: GeneralGpt5Variant = tokens.includes("mini")
		? "mini"
		: tokens.includes("nano")
			? "nano"
			: tokens.includes("pro")
				? "pro"
				: "base";

	if (minor === undefined) {
		return GENERAL_GPT5_GENERIC_VARIANTS[variant];
	}

	const exactCatalog = getGeneralGpt5CatalogForMinor(minor);
	const exactMatch = resolveGeneralGpt5CatalogVariant(exactCatalog, variant);
	if (exactMatch) {
		return exactMatch;
	}

	return resolveStableGeneralGpt5Variant(variant);
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

	const codexCatalogModel = resolveCodexCatalogModel(modelId);
	if (codexCatalogModel) {
		return codexCatalogModel;
	}

	const gpt56CatalogModel = resolveGpt56CatalogModel(modelId);
	if (gpt56CatalogModel) {
		return gpt56CatalogModel;
	}

	const generalGpt5CatalogModel = resolveGeneralGpt5CatalogModel(modelId);
	if (generalGpt5CatalogModel) {
		return generalGpt5CatalogModel;
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
