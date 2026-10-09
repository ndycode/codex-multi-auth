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
import {
	LUNA_RESERVE_MODEL,
	type ModelReasoningEffort,
	type WireReasoningEffort,
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

/**
 * Where every codex-named id routes. No codex model is left: upstream Codex
 * dropped `gpt-5.3-codex` from its catalog on 2026-07-08, and OpenAI's
 * deprecations page names `gpt-5.6-sol` as the replacement for every retired
 * codex id (`gpt-5-codex`, `gpt-5.1-codex*`, `gpt-5.2-codex`). The export
 * keeps its name so callers that mean "the model a codex request runs on"
 * still read naturally.
 */
export const CURRENT_CODEX_MODEL = "gpt-5.6-sol";

/**
 * The retired codex mini ids (`gpt-5.1-codex-mini`, `gpt-5-codex-mini`,
 * `codex-mini-latest`) go to Terra, OpenAI's named replacement for
 * `gpt-5.1-codex-mini`, rather than up to Sol.
 */
const CODEX_MINI_REPLACEMENT_MODEL = "gpt-5.6-terra";

// The default tracks whatever upstream defaults a fresh Codex session to:
// `gpt-6.1-sol` entered the bundled catalog on 2026-09-29 as priority 1
// (openai/codex #49318), above Astra. `gpt-5.5`, the previous default here,
// retires from ChatGPT/Codex on 2026-10-14, so keeping it would have landed
// every unresolvable request — and the legacy `gpt-5` alias — on a dying id.
export const DEFAULT_MODEL = "gpt-6.1-sol";

// Model used for diagnostic live/quota probes (`check`, `report`, `best`).
// Deliberately distinct from DEFAULT_MODEL: GPT-5.6 is the latest general family
// (issue #627) with a year of rollout behind it, so the probe leads with it —
// a probe only needs a response's quota headers, and leading with a fresh
// launch model (Astra on 2026-09-03, 6.1 Sol on 2026-09-29) spends one failed
// request per probe on every account not yet entitled and buys nothing. Move
// DEFAULT_PROBE_MODEL forward once a newer model is broadly available.
// Bare `gpt-5.6` aliases to Sol; we pin the canonical id so the probe display
// and report `modelSelection` read `gpt-5.6-sol` without a remap arrow.
export const DEFAULT_PROBE_MODEL = "gpt-5.6-sol";

// Single source of truth for the live/quota probe fallback chain. Both the
// manager probe (lib/quota-probe.ts) and the runtime probe (lib/runtime/quota-probe.ts)
// import this so the ordered candidate list cannot drift between them.
//
// Every entry must be a model the Codex backend still serves. The chain used to
// end on `gpt-5.4` and three codex models; all four are gone from the upstream
// catalog (`gpt-5.4` carries `retirement_at: 2026-08-31`), so a probe that
// reached them spent requests on guaranteed failures. `gpt-6-luna` closes it
// because it is offered on the most plans of any catalog model (24).
export const QUOTA_PROBE_MODEL_CHAIN = [
	DEFAULT_PROBE_MODEL,
	DEFAULT_MODEL,
	"gpt-6-luna",
] as const;

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
 * Sol and Luna followed on 2026-09-22 (below). `gpt-6-astra` is the API model
 * name OpenAI published at launch. The long-horizon `gpt-6-astra-aeon` slug
 * that leaked beside it never appeared in the bundled catalog or the public
 * model docs and is retired below — its ids now alias the flagship. "Astra
 * Pro" is a plan tier, not a separate slug we have seen, so it is deliberately
 * not registered as its own canonical model — the GPT-6 resolver below claims
 * `gpt-6-astra-pro` and every other unrecognised GPT-6 id for the flagship
 * rather than letting it fall through to the default.
 */
const GPT_6_ASTRA_MODEL = "gpt-6-astra";

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
 * GPT-6 Sol and Luna, added to the upstream Codex catalog on 2026-09-22
 * (openai/codex #47332) beside Astra. Sol is the everyday workhorse and Luna
 * the small, cheap tier; there is no GPT-6 Terra. Upstream migrates `gpt-5.5`,
 * `gpt-5.6-sol` and `gpt-5.6-terra` users to Sol and `gpt-5.6-luna` users to
 * Luna. Ladders and defaults below are the catalog's own values: Sol reaches
 * `ultra`, Luna stops at `max` (same split as 5.6), both default to `medium`.
 */
const GPT_6_SOL_MODEL = "gpt-6-sol";
const GPT_6_LUNA_MODEL = "gpt-6-luna";

const GPT_6_SOL_EFFORTS = GPT_6_ASTRA_EFFORTS;

const GPT_6_LUNA_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelReasoningEffort[];

/**
 * GPT-6.1 Sol, the first 6.1 release: added to the upstream catalog on
 * 2026-09-29 (openai/codex #49318) as the default model — priority 1, above
 * Astra — with "near-Astra performance at a lower cost". The same commit
 * demoted `gpt-6-sol` to "previous generation workhorse". The catalog ships
 * the full low..ultra ladder with a `low` default (the API model page
 * documents `medium` for direct-API callers; the Codex catalog this wrapper
 * mirrors says `low`). Sol is the only 6.1 tier yet, so bare `gpt-6.1` and
 * any unrecognised 6.1 id resolve to it, matching the bare-alias convention.
 */
const GPT_6_1_SOL_MODEL = "gpt-6.1-sol";

/** Bare `gpt-6.1` resolves to Sol — the only tier OpenAI ships at 6.1. */
const GPT_6_1_FLAGSHIP_ALIAS = "gpt-6.1";

const GPT_6_1_SOL_EFFORTS = GPT_6_ASTRA_EFFORTS;

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

/**
 * Where an unrecognised `gpt-5.<minor>` id lands. Every known minor is
 * retired (OpenAI deprecations page, upstream catalog removals, the
 * 2026-10-14 `gpt-5.5` OAuth shutdown), so each maps to the replacement
 * OpenAI names for it rather than to a model that no longer answers:
 * 5.1/5.2 to Sol, 5.4 to GPT-6 Sol/Luna as upstream Codex migrates it,
 * 5.5 to GPT-6 Sol likewise, and every `pro` to the frontier flagship that
 * replaced the API-only `gpt-5.5-pro`.
 */
const GENERAL_GPT5_VERSION_CATALOG: Record<
	GeneralGpt5KnownMinor,
	GeneralGpt5VariantCatalog
> = {
	1: {
		base: GPT_5_6_SOL_MODEL,
		pro: GPT_6_ASTRA_MODEL,
	},
	2: {
		base: GPT_5_6_SOL_MODEL,
		pro: GPT_6_ASTRA_MODEL,
	},
	4: {
		base: GPT_6_SOL_MODEL,
		pro: GPT_6_ASTRA_MODEL,
		mini: GPT_6_LUNA_MODEL,
		nano: GPT_6_LUNA_MODEL,
	},
	5: {
		base: GPT_6_SOL_MODEL,
		pro: GPT_6_ASTRA_MODEL,
		mini: GPT_5_6_TERRA_MODEL,
		nano: GPT_5_6_LUNA_MODEL,
	},
};

/**
 * Landing spot for a `gpt-5.<minor>` whose minor this catalog does not know
 * (a `gpt-5.7` or `gpt-5.9` id, say): the newest generation the 5.x line
 * still serves. Deliberately NOT the migration target `gpt-6-sol` — an id
 * naming a 5.x minor keeps its generation, the same way every known minor
 * above lands on a living 5.x or the replacement OpenAI actually named.
 */
const GENERAL_GPT5_STABLE_VARIANTS: Record<GeneralGpt5Variant, string> = {
	base: GPT_5_6_SOL_MODEL,
	pro: GPT_6_ASTRA_MODEL,
	mini: GPT_5_6_TERRA_MODEL,
	nano: GPT_5_6_LUNA_MODEL,
};

// `gpt-5-mini`/`gpt-5-nano` point at snapshots OpenAI retires on 2026-12-11;
// the deprecations page names Terra and Luna as their replacements.
const GENERAL_GPT5_GENERIC_VARIANTS: Record<GeneralGpt5Variant, string> = {
	base: GPT_5_6_SOL_MODEL,
	pro: GPT_6_ASTRA_MODEL,
	mini: GPT_5_6_TERRA_MODEL,
	nano: GPT_5_6_LUNA_MODEL,
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
	[GPT_6_1_SOL_MODEL]: {
		normalizedModel: GPT_6_1_SOL_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "low",
		supportedReasoningEfforts: GPT_6_1_SOL_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[GPT_6_SOL_MODEL]: {
		normalizedModel: GPT_6_SOL_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: GPT_6_SOL_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[GPT_6_LUNA_MODEL]: {
		normalizedModel: GPT_6_LUNA_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: GPT_6_LUNA_EFFORTS,
		capabilities: TOOL_CAPABILITIES.full,
	},
	[LUNA_RESERVE_MODEL]: {
		normalizedModel: LUNA_RESERVE_MODEL,
		promptFamily: "gpt-5.2",
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: GPT_6_LUNA_EFFORTS,
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
	// 5.5 and older are all retired: `gpt-5.5` leaves ChatGPT/Codex on
	// 2026-10-14, `gpt-5.5-pro` left the bundled Codex catalog earlier (it is
	// API-only now, which this OAuth surface cannot serve), `gpt-5.1`,
	// `gpt-5.2` and the whole 5.4 family left the upstream Codex catalog, the
	// codex models and the chat-latest snapshots are past their shutdown date
	// on OpenAI's deprecations page, and `gpt-5-mini`/`gpt-5-nano` shut down
	// 2026-12-11. Their ids stay accepted as aliases of the named replacement
	// (below) so an old config keeps working, but no request is sent under a
	// dead name.
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
		GPT_6_FLAGSHIP_ALIAS,
		GPT_6_ASTRA_MODEL,
		GPT_6_ASTRA_EFFORTS,
	);
	// `astra` on its own is how the model is spoken about everywhere; accept it
	// rather than letting it fall through to the default.
	addEffortAliases("astra", GPT_6_ASTRA_MODEL, GPT_6_ASTRA_EFFORTS);
	// `astra-aeon` was only ever a leaked slug and is retired now, so the name
	// resolves to the flagship it was a variant of. Its `gpt-6-astra-aeon`
	// form comes from the retired table, not from a dedicated registration.
	addEffortAliases("astra-aeon", GPT_6_ASTRA_MODEL, GPT_6_ASTRA_EFFORTS);
	// No bare `sol`/`luna` aliases: those names already mean the 5.6 tiers to
	// anyone who used them before 2026-09-22, and re-pointing them would swap a
	// user's model generation without asking.
	addEffortAliases(GPT_6_SOL_MODEL, GPT_6_SOL_MODEL, GPT_6_SOL_EFFORTS);
	addEffortAliases(GPT_6_LUNA_MODEL, GPT_6_LUNA_MODEL, GPT_6_LUNA_EFFORTS);
	addEffortAliases(LUNA_RESERVE_MODEL, LUNA_RESERVE_MODEL, GPT_6_LUNA_EFFORTS);
	addEffortAliases(GPT_6_1_SOL_MODEL, GPT_6_1_SOL_MODEL, GPT_6_1_SOL_EFFORTS);
	addEffortAliases(
		GPT_6_1_FLAGSHIP_ALIAS,
		GPT_6_1_SOL_MODEL,
		GPT_6_1_SOL_EFFORTS,
	);
}

function addDaybreakAliases(): void {
	addEffortAliases(DAYBREAK_BLUE_MODEL, DAYBREAK_BLUE_MODEL, DAYBREAK_EFFORTS);
	addEffortAliases(DAYBREAK_RED_MODEL, DAYBREAK_RED_MODEL, DAYBREAK_EFFORTS);
	addEffortAliases("daybreak-blue", DAYBREAK_BLUE_MODEL, DAYBREAK_EFFORTS);
	addEffortAliases("daybreak-red", DAYBREAK_RED_MODEL, DAYBREAK_EFFORTS);
}

function addGeneralAliases(): void {
	// `gpt-5` and `gpt-5-pro` are the last un-versioned ids upstream published.
	// With 5.5 retired, "the gpt-5 line" is Sol 5.6 and "the pro tier" is the
	// Astra flagship that replaced the API-only `gpt-5.5-pro`. The dated and
	// pro-suffixed forms of 5.5 itself come from the retired table below.
	addReasoningAliases("gpt-5-pro", GPT_6_ASTRA_MODEL);
	addReasoningAliases("gpt-5", GPT_5_6_SOL_MODEL);
}

/**
 * Retired general ids, each kept as an alias of the replacement OpenAI names
 * for it: the upstream Codex catalog's migration target where it has one
 * (`gpt-5.4` -> GPT-6 Sol, `gpt-5.4-mini` -> GPT-6 Luna), otherwise the
 * deprecations page's recommended replacement. The effort-suffixed forms
 * (`gpt-5.4-high`, `gpt-5.1-none`, ...) come along so old configs resolve;
 * efforts the replacement does not accept are coerced as for any request.
 */
const RETIRED_GENERAL_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
	// `gpt-6-astra-aeon` never appeared in the bundled Codex catalog or the
	// public model docs — it existed only as a Statsig-flag leak — so the id
	// is dead and goes to the flagship it was a long-horizon variant of.
	"gpt-6-astra-aeon": GPT_6_ASTRA_MODEL,
	// `gpt-5.5` leaves ChatGPT/Codex OAuth on 2026-10-14; the bundled catalog
	// already relabels it "legacy" and names GPT-6 Sol as the migration
	// target. `gpt-5.5-pro` left the bundled catalog earlier — it is API-only
	// now, a surface this OAuth wrapper cannot reach — so its ids go to the
	// frontier flagship. The dated snapshot ids retire with them.
	"gpt-5.5": GPT_6_SOL_MODEL,
	"gpt-5.5-2026-04-23": GPT_6_SOL_MODEL,
	"gpt-5.5-20260423": GPT_6_SOL_MODEL,
	"gpt-5.5-pro": GPT_6_ASTRA_MODEL,
	"gpt-5.5-pro-2026-04-23": GPT_6_ASTRA_MODEL,
	"gpt-5.5-pro-20260423": GPT_6_ASTRA_MODEL,
	"gpt-5.4": GPT_6_SOL_MODEL,
	"gpt-5.4-mini": GPT_6_LUNA_MODEL,
	"gpt-5.4-nano": GPT_6_LUNA_MODEL,
	"gpt-5.4-pro": GPT_6_ASTRA_MODEL,
	"gpt-5.2": GPT_5_6_SOL_MODEL,
	"gpt-5.2-pro": GPT_6_ASTRA_MODEL,
	"gpt-5.1": GPT_5_6_SOL_MODEL,
	"gpt-5-mini": GPT_5_6_TERRA_MODEL,
	"gpt-5-nano": GPT_5_6_LUNA_MODEL,
	"gpt-5-chat-latest": GPT_5_6_SOL_MODEL,
	"gpt-5.1-chat-latest": GPT_5_6_SOL_MODEL,
	"gpt-5.2-chat-latest": GPT_5_6_SOL_MODEL,
	"gpt-5.3-chat-latest": GPT_5_6_SOL_MODEL,
};

/**
 * Retired codex ids. All shut down on OpenAI's deprecations page or left the
 * upstream Codex catalog; OpenAI names `gpt-5.6-sol` as the replacement for
 * the full-size ones and `gpt-5.6-terra` for `gpt-5.1-codex-mini`.
 */
const RETIRED_CODEX_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
	"gpt-5.3-codex": CURRENT_CODEX_MODEL,
	"gpt-5.3-codex-spark": CURRENT_CODEX_MODEL,
	"gpt-5.2-codex": CURRENT_CODEX_MODEL,
	"gpt-5.1-codex": CURRENT_CODEX_MODEL,
	"gpt-5.1-codex-max": CURRENT_CODEX_MODEL,
	"gpt-5-codex": CURRENT_CODEX_MODEL,
	"codex-max": CURRENT_CODEX_MODEL,
	"gpt-5.1-codex-mini": CODEX_MINI_REPLACEMENT_MODEL,
	"gpt-5-codex-mini": CODEX_MINI_REPLACEMENT_MODEL,
	"codex-mini-latest": CODEX_MINI_REPLACEMENT_MODEL,
};

/** Every retired id and its replacement, for diagnostics and tests. */
export const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
	...RETIRED_GENERAL_MODEL_REPLACEMENTS,
	...RETIRED_CODEX_MODEL_REPLACEMENTS,
};

function addRetiredAliases(): void {
	for (const [retired, replacement] of Object.entries(
		RETIRED_MODEL_REPLACEMENTS,
	)) {
		addReasoningAliases(retired, replacement);
	}
	addAlias("gpt_5_codex", CURRENT_CODEX_MODEL);
}

addRetiredAliases();
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

/**
 * Any id carrying a `codex` token. Every codex model is retired, so this only
 * picks the replacement: a `mini` codex id goes to Terra, everything else to
 * Sol (see RETIRED_CODEX_MODEL_REPLACEMENTS).
 */
function resolveCodexCatalogModel(modelId: string): string | undefined {
	const normalized = modelId.toLowerCase();
	if (!normalized.includes("codex")) {
		return undefined;
	}
	// Anchored so `codex-minimal` (an effort suffix) is not read as a mini.
	if (/codex[- ]mini(?!mal)/.test(normalized)) {
		return CODEX_MINI_REPLACEMENT_MODEL;
	}
	return CURRENT_CODEX_MODEL;
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
 * horizon), not a rename of the flagship. A `sol`/`luna` tier token picks that
 * tier; everything else resolves to the flagship, matching OpenAI's bare
 * `gpt-6` alias.
 *
 * Ids carrying a `codex` token are left to `resolveCodexCatalogModel`, exactly
 * as the 5.6 resolver defers them.
 */
function resolveGpt6CatalogModel(modelId: string): string | undefined {
	const tokens = tokenizeModelId(modelId);
	const gptIndex = tokens.indexOf("gpt");
	const versionToken = gptIndex === -1 ? undefined : tokens[gptIndex + 1];
	// `gpt6` with no separator tokenizes as ONE token, so the `gpt` + `6` pair
	// never forms and it used to fall through to GPT-5.5 while still passing
	// capability-policy's catalog gate. Gate and resolver have to agree on the
	// same id or the policy store keys state a request never reads.
	const gpt6Index = tokens.indexOf("gpt6");
	const isGpt6 = versionToken === "6" || gpt6Index !== -1;
	// A 6.1 minor shows up as the token after `6` (`gpt-6.1-sol`) or after
	// `gpt6` (`gpt6.1-sol`); both forms have to land on the 6.1 generation,
	// not on the 6.0 tier the trailing `sol`/`luna` tokens name.
	const isGpt61 =
		(isGpt6 && gptIndex !== -1 && tokens[gptIndex + 2] === "1") ||
		(gpt6Index !== -1 && tokens[gpt6Index + 1] === "1");
	// A bare `astra` token counts too. OpenAI's own launch material and every
	// picker label say "Astra" without the `gpt-6` prefix, so `Astra Pro` and
	// `astra-fast` reach this resolver with no version tokens at all; without
	// this clause they miss every branch and land on the default.
	//
	// It is anchored, not a free-floating substring: an id that names a
	// DIFFERENT GPT major version does not get claimed for the frontier model
	// just because `astra` appears in it, so `gpt-4-astra-x` is declined here
	// rather than silently running GPT-6.
	const namesOtherGptVersion =
		versionToken !== undefined &&
		/^\d+$/.test(versionToken) &&
		versionToken !== "6";
	const isAstra = tokens.includes("astra") && !namesOtherGptVersion;
	if ((!isGpt6 && !isAstra) || tokens.includes("codex")) {
		return undefined;
	}

	// `aeon` was the leaked long-horizon Astra variant; retired, its ids run on
	// the flagship. `astra` keeps its own canonical id because Astra is a
	// behaviourally different model, not a rename of the Sol workhorse.
	if (tokens.includes("aeon")) return GPT_6_ASTRA_MODEL;
	if (isAstra) return GPT_6_ASTRA_MODEL;
	// Every unrecognised 6.1 id resolves to the generation's only tier, Sol —
	// the same in-minor flagship rule the 5.6 resolver applies, kept behind
	// `astra` so `gpt-6.1-astra` names the frontier model it actually means.
	if (isGpt61) return GPT_6_1_SOL_MODEL;
	// Before Sol and Luna existed every non-Astra GPT-6 id fell to the line
	// below, so `gpt-6-luna` silently ran Astra at 100x Luna's price. `terra`
	// goes to Sol because there is no GPT-6 Terra and upstream migrates
	// `gpt-5.6-terra` users to Sol.
	if (tokens.includes("luna")) return GPT_6_LUNA_MODEL;
	if (tokens.includes("sol") || tokens.includes("terra")) return GPT_6_SOL_MODEL;
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

	// `max`/`ultra` are not generated as aliases for the pre-5.6 ids, so
	// `gpt-5.3-chat-latest-max` missed the retired table and the general GPT-5
	// resolver sent it to 5.5 instead of its replacement. Retry the lookup
	// without the suffix before any fuzzy resolver runs.
	const withoutTopEffort = modelId.replace(/-(max|ultra)$/i, "");
	if (withoutTopEffort !== modelId) {
		const mappedWithoutEffort = lookupMappedModel(withoutTopEffort);
		if (mappedWithoutEffort) {
			return mappedWithoutEffort;
		}
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
