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

// Model used for diagnostic live/quota probes (`check`, `report`, `best`).
// Deliberately distinct from DEFAULT_MODEL: GPT-5.6 is the latest general family
// (issue #627), so the probe leads with it, while DEFAULT_MODEL stays on 5.5 so
// actual request routing and the legacy `gpt-5` alias remain opt-in per 2.5.0.
// Bare `gpt-5.6` aliases to Sol; we pin the canonical id so the probe display
// and report `modelSelection` read `gpt-5.6-sol` without a remap arrow.
//
// GPT-6 Astra deliberately does NOT lead the probe as of its 2026-09-03 launch.
// A probe only needs a response's quota headers, and Astra is still rolling out
// org by org, so leading with it would spend one failed request per probe for
// every account without entitlement yet and buy nothing. Move DEFAULT_PROBE_MODEL
// to `gpt-6-astra` once it is broadly available, and put `gpt-5.6-sol` directly
// behind it in QUOTA_PROBE_MODEL_CHAIN.
export const DEFAULT_PROBE_MODEL = "gpt-5.6-sol";

// Single source of truth for the live/quota probe fallback chain. Both the
// manager probe (lib/quota-probe.ts) and the runtime probe (lib/runtime/quota-probe.ts)
// import this so the ordered candidate list cannot drift between them. It leads
// with GPT-5.6 and steps down so accounts without 5.6 entitlement still resolve
// a working probe model.
export const QUOTA_PROBE_MODEL_CHAIN = [
	DEFAULT_PROBE_MODEL,
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

/**
 * GPT-6 Astra, OpenAI's 2026-09-03 frontier release.
 *
 * There is no Sol/Terra/Luna split this generation: the announced lineup is the
 * flagship plus `aeon`, a long-horizon variant built for runs measured in days.
 * `gpt-6-astra` is the API model name OpenAI published at launch;
 * `gpt-6-astra-aeon` is the second slug that shipped beside it in the Codex
 * model list. "Astra Pro" is a plan tier, not a separate slug we have seen, so
 * it is deliberately not registered as its own canonical model — the GPT-6
 * resolver below claims `gpt-6-astra-pro` and every other unrecognised GPT-6 id
 * for the flagship rather than letting it fall through to GPT-5.5.
 */
const GPT_6_ASTRA_MODEL = "gpt-6-astra";
const GPT_6_ASTRA_AEON_MODEL = "gpt-6-astra-aeon";

/** Bare `gpt-6` resolves to the flagship, mirroring bare `gpt-5.6` -> Sol. */
const GPT_6_FLAGSHIP_ALIAS = "gpt-6";

/**
 * Astra inherits the GPT-5.6 frontier effort ladder: no `none`/`minimal`, and
 * `ultra` at the top. OpenAI has published no default effort for Astra, so the
 * flagship follows the tier it succeeds (Sol, `low`) and the long-horizon
 * variant follows the catalog's other long-running models (`medium`).
 */
const GPT_6_ASTRA_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const satisfies readonly ModelReasoningEffort[];

/**
 * Cyber-specialty models from the upstream Codex catalog
 * (openai/codex `codex-rs/models-manager/models.json`).
 *
 * They are hidden in the Codex picker and gated behind the Daybreak program,
 * but the catalog marks them `supported_in_api`, so a client can and does name
 * them. Until now every `gpt-daybreak-*` id missed the codex resolver (no
 * `codex` token) and the general GPT-5 resolver (no `gpt 5` tokens) and landed
 * on `DEFAULT_MODEL` — asking for the cyber-permissive model silently ran
 * GPT-5.5. Reasoning ladders and defaults below are the catalog's own values.
 */
const DAYBREAK_BLUE_MODEL = "gpt-daybreak-blue-latest";
const DAYBREAK_RED_MODEL = "gpt-daybreak-red-latest";

const DAYBREAK_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
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
	// Like GPT-5.6, GPT-6 Astra ships its base instructions inline in the
	// upstream model catalog rather than as a `gpt_6_prompt.md`, so it stays on
	// the GPT-5.2 prompt family with every other post-5.2 general model. Adding
	// a `gpt-6` prompt family here would also widen MODEL_FAMILIES, which is a
	// persisted key space (`activeIndexByFamily`) and would need a storage
	// migration to grow.
	[GPT_6_ASTRA_MODEL]: {
		normalizedModel: GPT_6_ASTRA_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "low",
		supportedReasoningEfforts: GPT_6_ASTRA_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[GPT_6_ASTRA_AEON_MODEL]: {
		normalizedModel: GPT_6_ASTRA_AEON_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: GPT_6_ASTRA_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[DAYBREAK_BLUE_MODEL]: {
		normalizedModel: DAYBREAK_BLUE_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "low",
		supportedReasoningEfforts: DAYBREAK_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[DAYBREAK_RED_MODEL]: {
		normalizedModel: DAYBREAK_RED_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: DAYBREAK_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
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

function addGpt6Aliases(): void {
	addEffortAliases(GPT_6_ASTRA_MODEL, GPT_6_ASTRA_MODEL, GPT_6_ASTRA_EFFORTS);
	addEffortAliases(
		GPT_6_ASTRA_AEON_MODEL,
		GPT_6_ASTRA_AEON_MODEL,
		GPT_6_ASTRA_EFFORTS,
	);
	addEffortAliases(
		GPT_6_FLAGSHIP_ALIAS,
		GPT_6_ASTRA_MODEL,
		GPT_6_ASTRA_EFFORTS,
	);
	// `astra` on its own is how the model is spoken about everywhere; accept it
	// rather than letting it fall through to GPT-5.5.
	addEffortAliases("astra", GPT_6_ASTRA_MODEL, GPT_6_ASTRA_EFFORTS);
	addEffortAliases("astra-aeon", GPT_6_ASTRA_AEON_MODEL, GPT_6_ASTRA_EFFORTS);
}

function addDaybreakAliases(): void {
	addEffortAliases(DAYBREAK_BLUE_MODEL, DAYBREAK_BLUE_MODEL, DAYBREAK_EFFORTS);
	addEffortAliases(DAYBREAK_RED_MODEL, DAYBREAK_RED_MODEL, DAYBREAK_EFFORTS);
	addEffortAliases("daybreak-blue", DAYBREAK_BLUE_MODEL, DAYBREAK_EFFORTS);
	addEffortAliases("daybreak-red", DAYBREAK_RED_MODEL, DAYBREAK_EFFORTS);
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
addGpt6Aliases();
addDaybreakAliases();

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
/**
 * Resolve GPT-6 identifiers that are not exact aliases — a dated snapshot id
 * (`gpt-6-astra-2026-09-03`), the "Astra Pro" plan tier (`gpt-6-astra-pro`), or
 * any tier name OpenAI adds after this file was written.
 *
 * This is the same guard the 5.6 resolver exists for, one major version up:
 * without it, `resolveGeneralGpt5CatalogModel` never matches (it requires a
 * `gpt 5` token pair) and every unrecognised GPT-6 id lands on `DEFAULT_MODEL`,
 * running GPT-5.5 for a caller who asked for the frontier model. `aeon` keeps
 * its own canonical id because it is a behaviourally different model (long
 * horizon), not a rename of the flagship; everything else resolves to the
 * flagship, matching OpenAI's bare `gpt-6` alias.
 *
 * Ids carrying a `codex` token are left to `resolveCodexCatalogModel`, exactly
 * as the 5.6 resolver defers them.
 */
function resolveGpt6CatalogModel(modelId: string): string | undefined {
	const tokens = tokenizeModelId(modelId);
	const gptIndex = tokens.indexOf("gpt");
	const isGpt6 = gptIndex !== -1 && tokens[gptIndex + 1] === "6";
	// A bare `astra` token counts too. OpenAI's own launch material and every
	// picker label say "Astra" without the `gpt-6` prefix, so `Astra Pro` and
	// `astra-fast` reach this resolver with no version tokens at all; without
	// this clause they miss every branch and land on GPT-5.5.
	if ((!isGpt6 && !tokens.includes("astra")) || tokens.includes("codex")) {
		return undefined;
	}

	if (tokens.includes("aeon")) return GPT_6_ASTRA_AEON_MODEL;
	return GPT_6_ASTRA_MODEL;
}

/**
 * Resolve the Daybreak cyber models, including ids that are not exact aliases
 * (a pinned `gpt-daybreak-red-2026-08-14`, say).
 *
 * `red` is the cyber-permissive variant and `blue` the defensive one; an
 * unrecognised Daybreak id resolves to `blue`, the more restricted of the two,
 * so a typo cannot silently upgrade a caller into the permissive model.
 */
function resolveDaybreakCatalogModel(modelId: string): string | undefined {
	const tokens = tokenizeModelId(modelId);
	if (!tokens.includes("daybreak")) {
		return undefined;
	}

	if (tokens.includes("red")) return DAYBREAK_RED_MODEL;
	return DAYBREAK_BLUE_MODEL;
}

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

	// Daybreak first: its slugs carry neither a `codex` nor a `gpt 5` token, so
	// every other resolver declines them and they would reach DEFAULT_MODEL.
	const daybreakCatalogModel = resolveDaybreakCatalogModel(modelId);
	if (daybreakCatalogModel) {
		return daybreakCatalogModel;
	}

	const codexCatalogModel = resolveCodexCatalogModel(modelId);
	if (codexCatalogModel) {
		return codexCatalogModel;
	}

	const gpt6CatalogModel = resolveGpt6CatalogModel(modelId);
	if (gpt6CatalogModel) {
		return gpt6CatalogModel;
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

// Cheapest-first ordering used to pick a quota-probe reasoning effort. `ultra`
// is intentionally absent: it never reaches the wire (upstream rewrites it to
// `max`) and would only ever be a more expensive choice than `max` anyway.
const PROBE_REASONING_EFFORT_PREFERENCE = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly WireReasoningEffort[];

/**
 * Resolve the cheapest reasoning effort a probe model actually supports.
 *
 * A quota probe only needs the response's quota headers, so it wants the
 * lowest-cost effort. Rather than hardcoding `none`, it sends the cheapest
 * effort the probe model actually declares support for, mirroring how
 * `getReasoningConfig` coerces a real request: the GPT-5.6 tiers and the codex
 * models do not list `none`/`minimal` in the upstream catalog, so the probe
 * sends `low` for them and `none` for the pre-5.6 general models that do
 * (issue #627). Keeps the probe's effort consistent with normal routing and
 * within each model's declared range. Never returns `ultra`.
 */
export function resolveProbeReasoningEffort(
	model: string | undefined,
): WireReasoningEffort {
	const profile = getModelProfile(model);
	for (const effort of PROBE_REASONING_EFFORT_PREFERENCE) {
		if (profile.supportedReasoningEfforts.includes(effort)) {
			return effort;
		}
	}
	const fallback = profile.defaultReasoningEffort;
	return fallback === "ultra" ? "max" : fallback;
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
