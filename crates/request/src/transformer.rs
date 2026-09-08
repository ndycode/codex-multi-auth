//! Port of `lib/request/request-transformer.ts` — the Responses request-body
//! transformation (spec 06 §2): model normalization, per-model config
//! resolution, background-mode gating, fast-session tuning/trimming, tool
//! sanitization, input surgery, reasoning/verbosity/include resolution.
//!
//! ## Prompt seam (Rust-only shape, documented)
//!
//! The TS transformer imports `CODEX_HOST_BRIDGE`, `TOOL_REMAP_MESSAGE`, and
//! `getHostCodexPrompt()` from `lib/prompts/*` and is `async` solely because
//! of that host-prompt fetch. Here [`TransformPrompts::default`] carries the
//! real bridge/remap constants, [`transform_request_body`] is synchronous
//! over a pre-fetched `cached_host_prompt`, and
//! [`transform_request_body_fetching_host_prompt`] /
//! [`filter_host_system_prompts`] are the async TS-parity wrappers that fetch
//! the cached host prompt (fetch failure → `None`, exactly the TS catch).
//! The TS positional/named dual-call overload collapses into the single
//! [`TransformRequestBodyParams`] struct; its `TypeError("…requires
//! body/codexInstructions")` guards are structurally unrepresentable.

use std::collections::HashSet;
use std::sync::LazyLock;

use cma_core::constants::ModelReasoningEffort;
use cma_core::logger::{log_debug, log_warn};
use cma_core::model_family::ModelFamily;
use cma_core::types::{
    ConfigOptions, InputItem, ModelVariantConfig, ReasoningConfig, ReasoningSummary, RequestBody,
    RequestToolDefinition, UserConfig,
};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::input_utils;
use crate::model_map;
use crate::tool_utils::cleanup_tool_definitions;

// TS re-exports from `helpers/input-utils.js`.
pub use crate::input_utils::{filter_host_system_prompts_with_cached_prompt, is_host_system_prompt};

/// TS `FastSessionStrategy = "hybrid" | "always"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum FastSessionStrategy {
    #[default]
    Hybrid,
    Always,
}

impl FastSessionStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            FastSessionStrategy::Hybrid => "hybrid",
            FastSessionStrategy::Always => "always",
        }
    }

    /// Exact-match parse of the TS literal.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "hybrid" => Some(FastSessionStrategy::Hybrid),
            "always" => Some(FastSessionStrategy::Always),
            _ => None,
        }
    }
}

/// TS `CollaborationMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CollaborationMode {
    Plan,
    Default,
    Unknown,
}

impl CollaborationMode {
    const fn as_str(self) -> &'static str {
        match self {
            CollaborationMode::Plan => "plan",
            CollaborationMode::Default => "default",
            CollaborationMode::Unknown => "unknown",
        }
    }
}

/// Prompt inputs the TS transformer pulled from `lib/prompts/*` internally
/// (see the module docs). [`Default`] carries the real bridge/remap constants
/// and no cached host prompt.
#[derive(Debug, Clone)]
pub struct TransformPrompts<'a> {
    /// TS `CODEX_HOST_BRIDGE` (`lib/prompts/codex-host-bridge.ts`).
    pub codex_host_bridge: &'a str,
    /// TS `TOOL_REMAP_MESSAGE` (`lib/prompts/codex.ts`).
    pub tool_remap_message: &'a str,
    /// TS `await getHostCodexPrompt()` — `None` when the fetch failed (the TS
    /// catch falls back to signature-only detection).
    pub cached_host_prompt: Option<String>,
}

impl Default for TransformPrompts<'_> {
    fn default() -> Self {
        TransformPrompts {
            codex_host_bridge: crate::prompts::host_bridge::CODEX_HOST_BRIDGE,
            tool_remap_message: crate::prompts::codex::TOOL_REMAP_MESSAGE,
            cached_host_prompt: None,
        }
    }
}

/// TS `TransformRequestBodyParams` (+ the positional-overload defaults).
#[derive(Debug, Clone)]
pub struct TransformRequestBodyParams<'a> {
    pub body: RequestBody,
    pub codex_instructions: &'a str,
    /// `None` → `{ global: {}, models: {} }`.
    pub user_config: Option<&'a UserConfig>,
    /// TS default `true`.
    pub codex_mode: bool,
    /// TS default `false`.
    pub fast_session: bool,
    /// TS default `"hybrid"`.
    pub fast_session_strategy: FastSessionStrategy,
    /// TS default `30`.
    pub fast_session_max_input_items: i64,
    /// TS default `false`.
    pub defer_fast_session_input_trimming: bool,
    /// TS default `false`.
    pub allow_background_responses: bool,
    /// Rust-only prompt seam (see module docs).
    pub prompts: TransformPrompts<'a>,
}

impl<'a> TransformRequestBodyParams<'a> {
    /// Params with the exact TS positional-call defaults.
    pub fn new(body: RequestBody, codex_instructions: &'a str) -> Self {
        TransformRequestBodyParams {
            body,
            codex_instructions,
            user_config: None,
            codex_mode: true,
            fast_session: false,
            fast_session_strategy: FastSessionStrategy::Hybrid,
            fast_session_max_input_items: 30,
            defer_fast_session_input_trimming: false,
            allow_background_responses: false,
            prompts: TransformPrompts::default(),
        }
    }
}

/// Background-mode violations. `Display` is the FROZEN TS error message —
/// downstream (`fetch-helpers`) matches on the `"Responses background mode"`
/// prefix to decide rethrow-vs-swallow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransformRequestBodyError {
    BackgroundResponsesDisabled,
    BackgroundRequiresStore,
}

impl std::fmt::Display for TransformRequestBodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransformRequestBodyError::BackgroundResponsesDisabled => f.write_str(
                "Responses background mode is disabled. Enable pluginConfig.backgroundResponses or CODEX_AUTH_BACKGROUND_RESPONSES=1 to opt in.",
            ),
            TransformRequestBodyError::BackgroundRequiresStore => f.write_str(
                "Responses background mode requires store=true and cannot be combined with stateless store=false routing.",
            ),
        }
    }
}

impl std::error::Error for TransformRequestBodyError {}

const PLAN_MODE_ONLY_TOOLS: [&str; 1] = ["request_user_input"];

/// TS `normalizeModel` — thin wrapper over the shared catalog resolver.
pub fn normalize_model(model: Option<&str>) -> &'static str {
    model_map::resolve_normalized_model(model)
}

// ---------------------------------------------------------------------------
// Variant-suffix pattern (TS `VARIANT_SUFFIX_PATTERN`)
// ---------------------------------------------------------------------------

/// TS `REASONING_EFFORTS.filter(e => e !== "max")` — the unguarded suffix
/// alternation (note `ultra` IS here; only `max` needs the codex lookbehind).
const UNGUARDED_VARIANT_SUFFIXES: [ModelReasoningEffort; 7] = [
    ModelReasoningEffort::None,
    ModelReasoningEffort::Minimal,
    ModelReasoningEffort::Low,
    ModelReasoningEffort::Medium,
    ModelReasoningEffort::High,
    ModelReasoningEffort::Xhigh,
    ModelReasoningEffort::Ultra,
];

/// `name` ends with `-{effort}` (ASCII case-insensitive) → the base slice.
fn strip_dashed_suffix_ignore_ascii_case<'a>(name: &'a str, effort: &str) -> Option<&'a str> {
    let dashed_len = effort.len() + 1;
    if name.len() < dashed_len {
        return None;
    }
    let tail = &name.as_bytes()[name.len() - dashed_len..];
    if tail[0] == b'-' && tail[1..].eq_ignore_ascii_case(effort.as_bytes()) {
        // tail starts with ASCII '-', so the cut is a valid char boundary.
        Some(&name[..name.len() - dashed_len])
    } else {
        None
    }
}

fn ends_with_ignore_ascii_case(name: &str, suffix: &str) -> bool {
    name.len() >= suffix.len()
        && name.as_bytes()[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
}

/// TS `VARIANT_SUFFIX_PATTERN` =
/// `/(?:-(none|minimal|low|medium|high|xhigh|ultra)|(?<!codex)-(max))$/i`.
///
/// The `regex` crate lacks lookbehind, so the `(?<!codex)-max` alternative is
/// hand-rolled: `-max` strips ONLY when the preceding text does not end with
/// `codex` (case-insensitive) — `gpt-5.1-codex-max` is a model id, not Codex
/// at `max` effort, while `gpt-5.6-sol-max` still parses `max` and
/// `gpt-5-codex-low` / `gpt-5-codex-ultra` still parse their suffix (no guard
/// on the first alternation).
///
/// Returns `(base_without_suffix, matched_effort)`; at most ONE suffix is
/// stripped (the TS regex is `$`-anchored and non-global).
fn split_variant_suffix(name: &str) -> (&str, Option<ModelReasoningEffort>) {
    for effort in UNGUARDED_VARIANT_SUFFIXES {
        if let Some(base) = strip_dashed_suffix_ignore_ascii_case(name, effort.as_str()) {
            return (base, Some(effort));
        }
    }
    if let Some(base) = strip_dashed_suffix_ignore_ascii_case(name, "max")
        && !ends_with_ignore_ascii_case(base, "codex")
    {
        return (base, Some(ModelReasoningEffort::Max));
    }
    (name, None)
}

// ---------------------------------------------------------------------------
// getModelConfig
// ---------------------------------------------------------------------------

/// JS-spread merge of [`ConfigOptions`] layers — later layers override only
/// the fields they actually carry; `extra` keys merge key-wise.
fn merge_config_options(layers: &[&ConfigOptions]) -> ConfigOptions {
    let mut merged = ConfigOptions::default();
    for layer in layers {
        if layer.reasoning_effort.is_some() {
            merged.reasoning_effort = layer.reasoning_effort.clone();
        }
        if layer.reasoning_summary.is_some() {
            merged.reasoning_summary = layer.reasoning_summary.clone();
        }
        if layer.text_verbosity.is_some() {
            merged.text_verbosity = layer.text_verbosity.clone();
        }
        if layer.prompt_cache_retention.is_some() {
            merged.prompt_cache_retention = layer.prompt_cache_retention.clone();
        }
        if layer.include.is_some() {
            merged.include = layer.include.clone();
        }
        for (key, value) in &layer.extra {
            merged.extra.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// TS variant entry minus its `disabled` key.
fn variant_to_config_options(variant: &ModelVariantConfig) -> ConfigOptions {
    ConfigOptions {
        reasoning_effort: variant.reasoning_effort.clone(),
        reasoning_summary: variant.reasoning_summary.clone(),
        text_verbosity: variant.text_verbosity.clone(),
        prompt_cache_retention: variant.prompt_cache_retention.clone(),
        include: variant.include.clone(),
        extra: variant.extra.clone(),
    }
}

/// TS `getModelConfig` — merges global options with model-specific options
/// (model-specific wins), honoring exact per-model keys first, then base-model
/// keys (with variant merging for `-low`/`-xhigh`/… suffixed requests).
pub fn get_model_config(model_name: &str, user_config: Option<&UserConfig>) -> ConfigOptions {
    let default_config = UserConfig::default();
    let user_config = user_config.unwrap_or(&default_config);
    let global_options = &user_config.global;
    let models = &user_config.models;

    let stripped_model_name = model_map::strip_provider_prefix(model_name);
    let normalized_model_name = normalize_model(Some(stripped_model_name));
    let (base_model_name, requested_variant) = split_variant_suffix(stripped_model_name);
    let normalized_base_model_name = normalize_model(Some(base_model_name));

    // 1) Honor exact per-model keys first (including variant-specific keys).
    let direct_entry = [model_name, stripped_model_name]
        .iter()
        .find_map(|key| models.get(*key));
    if let Some(entry) = direct_entry
        && let Some(options) = &entry.options
    {
        return merge_config_options(&[global_options, options]);
    }

    // 2) Resolve to base model config (provider-prefixed names + aliases).
    let base_entry = [
        base_model_name,
        normalized_base_model_name,
        normalized_model_name,
    ]
    .iter()
    .find_map(|key| models.get(*key));
    let default_options = ConfigOptions::default();
    let base_options = base_entry
        .and_then(|entry| entry.options.as_ref())
        .unwrap_or(&default_options);

    // 3) Variant options from the base entry (minus `disabled`).
    let variant_options = requested_variant
        .and_then(|variant| {
            base_entry?
                .variants
                .as_ref()?
                .get(variant.as_str())?
                .as_ref()
        })
        .map(variant_to_config_options);

    match &variant_options {
        Some(variant) => merge_config_options(&[global_options, base_options, variant]),
        None => merge_config_options(&[global_options, base_options]),
    }
}

/// TS `applyFastSessionDefaults` — `global.reasoningEffort ??= "low"`,
/// `global.textVerbosity ??= "low"` on a copy (explicit user values win).
pub fn apply_fast_session_defaults(user_config: &UserConfig) -> UserConfig {
    let mut result = user_config.clone();
    if result.global.reasoning_effort.is_none() {
        result.global.reasoning_effort = Some("low".to_string());
    }
    if result.global.text_verbosity.is_none() {
        result.global.text_verbosity = Some("low".to_string());
    }
    result
}

// ---------------------------------------------------------------------------
// Reasoning config
// ---------------------------------------------------------------------------

/// TS `REASONING_FALLBACKS`.
fn reasoning_fallbacks(effort: ModelReasoningEffort) -> &'static [ModelReasoningEffort] {
    use ModelReasoningEffort as E;
    match effort {
        E::None => &[E::None, E::Low, E::Minimal, E::Medium, E::High, E::Xhigh],
        E::Minimal => &[E::Minimal, E::Low, E::None, E::Medium, E::High, E::Xhigh],
        E::Low => &[E::Low, E::Minimal, E::None, E::Medium, E::High, E::Xhigh],
        E::Medium => &[E::Medium, E::Low, E::High, E::Minimal, E::None, E::Xhigh],
        E::High => &[E::High, E::Medium, E::Xhigh, E::Low, E::Minimal, E::None],
        E::Xhigh => &[E::Xhigh, E::High, E::Medium, E::Low, E::Minimal, E::None],
        // `max`/`ultra` only exist on GPT-5.6 — step down one rung at a time.
        E::Max => &[E::Max, E::Xhigh, E::High, E::Medium, E::Low, E::Minimal, E::None],
        E::Ultra => &[
            E::Ultra,
            E::Max,
            E::Xhigh,
            E::High,
            E::Medium,
            E::Low,
            E::Minimal,
            E::None,
        ],
    }
}

/// TS `coerceReasoningEffort` — exact fallback-table walk with the two frozen
/// warn messages. `requested_raw = None` means the config carried no effort
/// (→ profile default, which every profile supports); an unparseable string
/// behaves like the TS `REASONING_FALLBACKS[effort] ?? [defaultEffort]` miss.
fn coerce_reasoning_effort(
    model_name: &str,
    requested_raw: Option<&str>,
    supported: &[ModelReasoningEffort],
    default_effort: ModelReasoningEffort,
) -> ModelReasoningEffort {
    let (requested_parsed, requested_label): (Option<ModelReasoningEffort>, &str) =
        match requested_raw {
            None => (Some(default_effort), default_effort.as_str()),
            Some(raw) => (ModelReasoningEffort::parse(raw), raw),
        };

    if let Some(effort) = requested_parsed
        && supported.contains(&effort)
    {
        return effort;
    }

    let default_only = [default_effort];
    let fallback_order: &[ModelReasoningEffort] = match requested_parsed {
        Some(effort) => reasoning_fallbacks(effort),
        None => &default_only,
    };
    for candidate in fallback_order {
        if supported.contains(candidate) {
            log_warn(
                "Coercing unsupported reasoning effort for model",
                Some(&json!({
                    "model": model_name,
                    "requestedEffort": requested_label,
                    "effectiveEffort": candidate.as_str(),
                })),
            );
            return *candidate;
        }
    }

    log_warn(
        "Falling back to default reasoning effort for model",
        Some(&json!({
            "model": model_name,
            "requestedEffort": requested_label,
            "effectiveEffort": default_effort.as_str(),
        })),
    );
    default_effort
}

/// TS `sanitizeReasoningSummary` — lowercased membership in
/// {auto, concise, detailed}, everything else (incl. empty/absent) → `auto`.
fn sanitize_reasoning_summary(summary: Option<&str>) -> ReasoningSummary {
    let Some(summary) = summary.filter(|s| !s.is_empty()) else {
        return ReasoningSummary::Auto;
    };
    match summary.to_lowercase().as_str() {
        "concise" => ReasoningSummary::Concise,
        "detailed" => ReasoningSummary::Detailed,
        _ => ReasoningSummary::Auto,
    }
}

/// TS `getReasoningConfig` — profile default + coercion; `ultra` → `max` on
/// the wire (the API never sees `ultra`).
pub fn get_reasoning_config(
    model_name: Option<&str>,
    user_config: &ConfigOptions,
) -> ReasoningConfig {
    let profile = model_map::get_model_profile(model_name);
    let coerced = coerce_reasoning_effort(
        profile.normalized_model,
        user_config.reasoning_effort.as_deref(),
        profile.supported_reasoning_efforts,
        profile.default_reasoning_effort,
    );
    ReasoningConfig {
        effort: coerced.to_wire(),
        summary: sanitize_reasoning_summary(user_config.reasoning_summary.as_deref()),
    }
}

// ---------------------------------------------------------------------------
// Input filtering & fast-session machinery
// ---------------------------------------------------------------------------

/// TS `filterInput` — drop `item_reference` items (AI-SDK construct) and,
/// when `strip_ids`, remove the `id` from every remaining item. `None` input
/// passes through (TS non-array passthrough).
pub fn filter_input(input: Option<Vec<InputItem>>, strip_ids: bool) -> Option<Vec<InputItem>> {
    let input = input?;
    Some(
        input
            .into_iter()
            .filter_map(|mut item| {
                if item.kind.as_deref() == Some("item_reference") {
                    return None;
                }
                if strip_ids {
                    item.id = None;
                }
                Some(item)
            })
            .collect(),
    )
}

/// TS `extractMessageText` — string content as-is; array content joins the
/// string elements / `text` fields (empties dropped) with `"\n"`.
fn extract_message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let text = match part {
                    Value::String(text) => text.clone(),
                    Value::Object(obj) => obj
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    _ => String::new(),
                };
                if text.is_empty() { None } else { Some(text) }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

static LIST_MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)(?:^|\n)\s*(?:[-*]|[0-9]+\.)\s+\S").expect("static regex"));
static TABLE_ROW_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\|.+\|").expect("static regex"));
static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)https?://").expect("static regex"));

/// TS `isTrivialLatestPrompt`.
fn is_trivial_latest_prompt(text: &str) -> bool {
    let normalized = text.trim();
    if normalized.is_empty() {
        return false;
    }
    if normalized.chars().count() > 220 {
        return false;
    }
    if normalized.contains('\n') {
        return false;
    }
    if normalized.contains("```") {
        return false;
    }
    if LIST_MARKER_RE.is_match(normalized) {
        return false;
    }
    if URL_RE.is_match(normalized) {
        return false;
    }
    if TABLE_ROW_RE.is_match(normalized) {
        return false;
    }
    true
}

/// TS `isStructurallyComplexPrompt`.
fn is_structurally_complex_prompt(text: &str) -> bool {
    let normalized = text.trim();
    if normalized.is_empty() {
        return false;
    }
    if normalized.contains("```") {
        return true;
    }
    let line_count = normalized
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty())
        .count();
    if line_count >= 3 {
        return true;
    }
    if LIST_MARKER_RE.is_match(normalized) {
        return true;
    }
    if TABLE_ROW_RE.is_match(normalized) {
        return true;
    }
    false
}

/// TS `isComplexFastSessionRequest` — lookback window of
/// `max(12, floor(maxItems/2))` recent items; any tool traffic in the window
/// is complex; a trivial LATEST user prompt short-circuits to NOT complex;
/// else complex iff any of the last 3 user texts is structurally complex.
fn is_complex_fast_session_request(body: &RequestBody, max_items: i64) -> bool {
    let empty: [InputItem; 0] = [];
    let input: &[InputItem] = body.input.as_deref().unwrap_or(&empty);
    let lookback = ((max_items as f64) / 2.0).floor().max(12.0) as usize;
    let start = input.len().saturating_sub(lookback);

    let mut user_texts: Vec<String> = Vec::new();
    for item in &input[start..] {
        if matches!(
            item.kind.as_deref(),
            Some("function_call") | Some("function_call_output")
        ) {
            return true;
        }
        let role = item
            .role
            .as_deref()
            .map(str::to_lowercase)
            .unwrap_or_default();
        if role != "user" {
            continue;
        }
        let text = extract_message_text(item.content.as_ref());
        if text.is_empty() {
            continue;
        }
        user_texts.push(text);
    }

    if user_texts.is_empty() {
        return false;
    }
    if let Some(latest) = user_texts.last()
        && is_trivial_latest_prompt(latest)
    {
        return false;
    }
    let recent_start = user_texts.len().saturating_sub(3);
    user_texts[recent_start..]
        .iter()
        .any(|text| is_structurally_complex_prompt(text))
}

/// TS `getLatestUserText`.
fn get_latest_user_text(input: Option<&[InputItem]>) -> Option<String> {
    let input = input?;
    for item in input.iter().rev() {
        let role = item
            .role
            .as_deref()
            .map(str::to_lowercase)
            .unwrap_or_default();
        if role != "user" {
            continue;
        }
        let text = extract_message_text(item.content.as_ref());
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

/// The `trim` half of [`FastSessionInputTrimPlan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FastSessionTrimSettings {
    pub max_items: i64,
    pub prefer_latest_user_only: bool,
}

/// TS `FastSessionInputTrimPlan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FastSessionInputTrimPlan {
    pub should_apply: bool,
    pub is_trivial_turn: bool,
    pub trim: Option<FastSessionTrimSettings>,
}

/// TS `resolveFastSessionInputTrimPlan`.
pub fn resolve_fast_session_input_trim_plan(
    body: &RequestBody,
    fast_session: bool,
    fast_session_strategy: FastSessionStrategy,
    fast_session_max_input_items: i64,
) -> FastSessionInputTrimPlan {
    let should_apply = fast_session
        && (fast_session_strategy == FastSessionStrategy::Always
            || !is_complex_fast_session_request(body, fast_session_max_input_items));
    let latest_user_text = get_latest_user_text(body.input.as_deref());
    let is_trivial_turn = is_trivial_latest_prompt(latest_user_text.as_deref().unwrap_or(""));
    FastSessionInputTrimPlan {
        should_apply,
        is_trivial_turn,
        trim: should_apply.then_some(FastSessionTrimSettings {
            max_items: fast_session_max_input_items,
            prefer_latest_user_only: should_apply && is_trivial_turn,
        }),
    }
}

/// TS `trimInputForFastSession` — keeps a small leading developer/system
/// context plus the most recent items; the `prefer_latest_user_only` path
/// keeps only a short head instruction and the last user item.
pub fn trim_input_for_fast_session(
    input: Option<Vec<InputItem>>,
    max_items: i64,
    prefer_latest_user_only: bool,
) -> Option<Vec<InputItem>> {
    let input = input?;
    const MAX_HEAD_INSTRUCTION_CHARS: usize = 1200;
    const MAX_HEAD_INSTRUCTION_CHARS_TRIVIAL: usize = 400;

    if prefer_latest_user_only {
        let mut keep_indexes: HashSet<usize> = HashSet::new();

        // First developer/system item anywhere (exact-case roles, TS parity);
        // scanning does NOT stop at user/assistant items.
        for (index, item) in input.iter().enumerate() {
            let role = item.role.as_deref().unwrap_or("");
            if role == "developer" || role == "system" {
                let head_text = extract_message_text(item.content.as_ref());
                if head_text.chars().count() <= MAX_HEAD_INSTRUCTION_CHARS_TRIVIAL {
                    keep_indexes.insert(index);
                }
                break;
            }
        }

        // Last user item (lowercased role here — TS parity).
        for (index, item) in input.iter().enumerate().rev() {
            let role = item
                .role
                .as_deref()
                .map(str::to_lowercase)
                .unwrap_or_default();
            if role == "user" {
                keep_indexes.insert(index);
                break;
            }
        }

        let compacted: Vec<InputItem> = input
            .iter()
            .enumerate()
            .filter(|(index, _)| keep_indexes.contains(index))
            .map(|(_, item)| item.clone())
            .collect();
        if !compacted.is_empty() {
            return Some(compacted);
        }
    }

    // General path.
    let safe_max = max_items.max(8) as usize; // Math.max(8, Math.floor(maxItems))
    let mut keep_indexes: HashSet<usize> = HashSet::new();
    let mut excluded_head_indexes: HashSet<usize> = HashSet::new();

    let mut kept_head = 0usize;
    for (index, item) in input.iter().enumerate() {
        if kept_head >= 2 {
            break;
        }
        let role = item.role.as_deref().unwrap_or("");
        if role == "developer" || role == "system" {
            let head_text = extract_message_text(item.content.as_ref());
            if head_text.chars().count() <= MAX_HEAD_INSTRUCTION_CHARS {
                keep_indexes.insert(index);
                kept_head += 1;
            } else {
                excluded_head_indexes.insert(index);
            }
            continue;
        }
        break;
    }

    let tail_start = input.len().saturating_sub(safe_max);
    for index in tail_start..input.len() {
        if excluded_head_indexes.contains(&index) {
            continue;
        }
        keep_indexes.insert(index);
    }

    let trimmed: Vec<InputItem> = input
        .iter()
        .enumerate()
        .filter(|(index, _)| keep_indexes.contains(index))
        .map(|(_, item)| item.clone())
        .collect();
    if trimmed.is_empty() {
        return Some(input);
    }
    if (input.len() as i64) <= max_items && excluded_head_indexes.is_empty() {
        return Some(input);
    }
    if trimmed.len() <= safe_max {
        return Some(trimmed);
    }

    // Kept head items are always the LOWEST kept indexes, so they occupy the
    // first `kept_head` entries of `trimmed`. Reserve budget for exactly that
    // many (recounting kept indexes below tail_start would miss a head
    // instruction that ALSO falls inside the tail window — see the TS
    // in-code comment about the overlap bug).
    let tail_budget = (safe_max - kept_head).max(1);
    let mut result: Vec<InputItem> = trimmed[..kept_head].to_vec();
    result.extend_from_slice(&trimmed[trimmed.len() - tail_budget..]);
    Some(result)
}

/// TS fast-instruction limits + frozen compaction suffix.
const FAST_INSTRUCTION_SUFFIX: &str = "\n\n[Fast session mode: keep answers concise, direct, and action-oriented. Do not output internal planning labels such as \"Thinking:\".]";

/// TS `compactInstructionsForFastSession` — 320-char (trivial) / 900-char
/// budget; prefers cutting at the last newline at/before the limit when that
/// index is ≥ 180, else hard-cuts at the limit; appends the frozen suffix.
fn compact_instructions_for_fast_session(instructions: &str, is_trivial_turn: bool) -> String {
    let normalized = instructions.trim();
    if normalized.is_empty() {
        return instructions.to_string();
    }
    let limit = if is_trivial_turn { 320 } else { 900 };
    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() <= limit {
        return instructions.to_string();
    }
    // JS `lastIndexOf("\n", limit)` — last newline at index ≤ limit.
    let split_index = (0..=limit).rev().find(|&index| chars[index] == '\n');
    let safe_cutoff = match split_index {
        Some(index) if index >= 180 => index,
        _ => limit,
    };
    let compacted: String = chars[..safe_cutoff].iter().collect();
    format!("{}{FAST_INSTRUCTION_SUFFIX}", compacted.trim_end())
}

// ---------------------------------------------------------------------------
// Collaboration mode & tool sanitization
// ---------------------------------------------------------------------------

static COLLAB_PLAN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)collaboration mode:\s*plan").expect("static regex"));
static IN_PLAN_MODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)in plan mode").expect("static regex"));
static COLLAB_DEFAULT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)collaboration mode:\s*default").expect("static regex"));
static IN_DEFAULT_MODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)in default mode").expect("static regex"));

/// TS `parseCollaborationMode` — trimmed/lowercased; only `plan`/`default`.
fn parse_collaboration_mode(value: Option<&str>) -> Option<CollaborationMode> {
    let value = value.filter(|value| !value.is_empty())?;
    match value.trim().to_lowercase().as_str() {
        "plan" => Some(CollaborationMode::Plan),
        "default" => Some(CollaborationMode::Default),
        _ => None,
    }
}

/// TS `detectCollaborationMode` — env `CODEX_COLLABORATION_MODE` wins; else
/// scan developer/system input texts for plan/default markers.
fn detect_collaboration_mode(body: &RequestBody) -> CollaborationMode {
    if let Some(mode) =
        parse_collaboration_mode(std::env::var("CODEX_COLLABORATION_MODE").ok().as_deref())
    {
        return mode;
    }
    let Some(input) = body.input.as_ref() else {
        return CollaborationMode::Unknown;
    };

    let mut saw_plan = false;
    let mut saw_default = false;
    for item in input {
        let role = item
            .role
            .as_deref()
            .map(str::to_lowercase)
            .unwrap_or_default();
        if role != "developer" && role != "system" {
            continue;
        }
        let text = extract_message_text(item.content.as_ref());
        if text.is_empty() {
            continue;
        }
        if COLLAB_PLAN_RE.is_match(&text) || IN_PLAN_MODE_RE.is_match(&text) {
            saw_plan = true;
        }
        if COLLAB_DEFAULT_RE.is_match(&text) || IN_DEFAULT_MODE_RE.is_match(&text) {
            saw_default = true;
        }
    }

    if saw_plan && !saw_default {
        return CollaborationMode::Plan;
    }
    if saw_default {
        return CollaborationMode::Default;
    }
    CollaborationMode::Unknown
}

/// TS `sanitizePlanOnlyToolEntry` — Value-based so any-shaped entries behave
/// like the JS record accesses. Returns `None` when the entry is removed.
fn sanitize_plan_only_tool_entry(value: Value, removed: &mut usize) -> Option<Value> {
    let Some(record) = value.as_object() else {
        return Some(value);
    };

    if record.get("type").and_then(Value::as_str) == Some("namespace")
        && let Some(Value::Array(nested)) = record.get("tools")
    {
        let nested_tools: Vec<Value> = nested
            .iter()
            .cloned()
            .filter_map(|tool| sanitize_plan_only_tool_entry(tool, removed))
            .collect();
        if nested_tools.is_empty() {
            return None;
        }
        let mut new_record = record.clone();
        new_record.insert("tools".to_string(), Value::Array(nested_tools));
        return Some(Value::Object(new_record));
    }

    // ANY object carrying `function.name` in the plan-only set is removed
    // (the TS check does not require `type === "function"`).
    let Some(function_def) = record.get("function").and_then(Value::as_object) else {
        return Some(value);
    };
    match function_def.get("name").and_then(Value::as_str) {
        Some(name) if PLAN_MODE_ONLY_TOOLS.contains(&name) => {
            *removed += 1;
            None
        }
        _ => Some(value),
    }
}

/// TS `sanitizePlanOnlyTools` — removes `request_user_input` whenever mode is
/// NOT `plan` (i.e. also in `unknown`); recurses into namespaces; a namespace
/// whose tools all get removed is itself removed (not counted).
fn sanitize_plan_only_tools(
    tools: Option<Vec<RequestToolDefinition>>,
    mode: CollaborationMode,
) -> Option<Vec<RequestToolDefinition>> {
    let tools = tools?;
    if mode == CollaborationMode::Plan {
        return Some(tools);
    }

    let mut removed = 0usize;
    let filtered: Vec<RequestToolDefinition> = tools
        .into_iter()
        .filter_map(|tool| {
            let raw = serde_json::to_value(&tool).unwrap_or(Value::Null);
            sanitize_plan_only_tool_entry(raw, &mut removed)
                .map(|value| serde_json::from_value(value).unwrap_or(tool))
        })
        .collect();

    if removed > 0 {
        log_warn(
            &format!(
                "Removed {removed} plan-mode-only tool definition(s) because collaboration mode is {}",
                mode.as_str()
            ),
            None,
        );
    }
    Some(filtered)
}

/// TS removal counters for `sanitizeModelIncompatibleTools`.
#[derive(Default)]
struct ToolCapabilityRemovalCounts {
    tool_search: usize,
    computer_use: usize,
}

/// TS `COMPUTER_TOOL_TYPES`.
fn is_computer_tool_type(kind: &str) -> bool {
    kind == "computer" || kind == "computer_use_preview"
}

/// TS `sanitizeModelIncompatibleToolEntry`.
fn sanitize_model_incompatible_tool_entry(
    value: Value,
    capabilities: model_map::ModelCapabilities,
    removed: &mut ToolCapabilityRemovalCounts,
) -> Option<Value> {
    let Some(record) = value.as_object() else {
        return Some(value);
    };
    let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "tool_search" && !capabilities.tool_search {
        removed.tool_search += 1;
        return None;
    }
    if is_computer_tool_type(kind) && !capabilities.computer_use {
        removed.computer_use += 1;
        return None;
    }
    if kind == "namespace"
        && let Some(Value::Array(nested)) = record.get("tools")
    {
        let nested_tools: Vec<Value> = nested
            .iter()
            .cloned()
            .filter_map(|tool| sanitize_model_incompatible_tool_entry(tool, capabilities, removed))
            .collect();
        if nested_tools.is_empty() {
            return None;
        }
        let mut new_record = record.clone();
        new_record.insert("tools".to_string(), Value::Array(nested_tools));
        return Some(Value::Object(new_record));
    }
    Some(value)
}

/// TS `sanitizeModelIncompatibleTools` — drops `tool_search` / computer tools
/// the resolved model does not support (namespace-recursive), with the two
/// frozen warn messages.
fn sanitize_model_incompatible_tools(
    tools: Option<Vec<RequestToolDefinition>>,
    model: Option<&str>,
) -> Option<Vec<RequestToolDefinition>> {
    let tools = tools?;
    let capabilities = model_map::get_model_capabilities(model);
    let mut removed = ToolCapabilityRemovalCounts::default();
    let filtered: Vec<RequestToolDefinition> = tools
        .into_iter()
        .filter_map(|tool| {
            let raw = serde_json::to_value(&tool).unwrap_or(Value::Null);
            sanitize_model_incompatible_tool_entry(raw, capabilities, &mut removed)
                .map(|value| serde_json::from_value(value).unwrap_or(tool))
        })
        .collect();

    let model_label = model.unwrap_or("the selected model");
    if removed.tool_search > 0 {
        log_warn(
            &format!(
                "Removed {} tool_search definition(s) because {model_label} does not support tool search",
                removed.tool_search
            ),
            None,
        );
    }
    if removed.computer_use > 0 {
        log_warn(
            &format!(
                "Removed {} computer tool definition(s) because {model_label} does not support computer use",
                removed.computer_use
            ),
            None,
        );
    }

    Some(filtered)
}

// ---------------------------------------------------------------------------
// Bridge / remap message helpers
// ---------------------------------------------------------------------------

fn prepend_developer_message(
    input: Option<Vec<InputItem>>,
    has_tools: bool,
    text: &str,
) -> Option<Vec<InputItem>> {
    let input = input?;
    if !has_tools {
        return Some(input);
    }
    let message = InputItem {
        id: None,
        kind: Some("message".to_string()),
        role: Some("developer".to_string()),
        content: Some(json!([{ "type": "input_text", "text": text }])),
        extra: Map::new(),
    };
    let mut result = Vec::with_capacity(input.len() + 1);
    result.push(message);
    result.extend(input);
    Some(result)
}

/// TS `addCodexBridgeMessage` — prepends the CODEX_HOST_BRIDGE developer
/// message when tools are present. `bridge_text` is the caller-supplied
/// `crate::prompts::host_bridge::CODEX_HOST_BRIDGE` (see module docs).
pub fn add_codex_bridge_message(
    input: Option<Vec<InputItem>>,
    has_tools: bool,
    bridge_text: &str,
) -> Option<Vec<InputItem>> {
    prepend_developer_message(input, has_tools, bridge_text)
}

/// TS `addToolRemapMessage` — prepends the TOOL_REMAP_MESSAGE developer
/// message when tools are present. `remap_text` is the caller-supplied
/// `crate::prompts::codex::TOOL_REMAP_MESSAGE`.
pub fn add_tool_remap_message(
    input: Option<Vec<InputItem>>,
    has_tools: bool,
    remap_text: &str,
) -> Option<Vec<InputItem>> {
    prepend_developer_message(input, has_tools, remap_text)
}

// ---------------------------------------------------------------------------
// Background mode & resolution helpers
// ---------------------------------------------------------------------------

fn is_background_mode_requested(body: &RequestBody) -> bool {
    body.background == Some(true)
}

/// TS `assertBackgroundModeCompatibility` — `Ok(true)` iff background mode is
/// requested AND allowed AND not combined with `store=false`.
fn assert_background_mode_compatibility(
    body: &RequestBody,
    allow_background_responses: bool,
) -> Result<bool, TransformRequestBodyError> {
    if !is_background_mode_requested(body) {
        return Ok(false);
    }
    if !allow_background_responses {
        return Err(TransformRequestBodyError::BackgroundResponsesDisabled);
    }
    let provider_store = body
        .provider_options
        .as_ref()
        .and_then(|options| options.openai.as_ref())
        .and_then(|openai| openai.store);
    if body.store == Some(false) || provider_store == Some(false) {
        return Err(TransformRequestBodyError::BackgroundRequiresStore);
    }
    Ok(true)
}

/// TS `resolveReasoningConfig` — existing body/provider values override the
/// model config (truthy-gated, so empty strings do NOT override), then
/// [`get_reasoning_config`] coerces per model.
fn resolve_reasoning_config(
    model_name: &str,
    model_config: &ConfigOptions,
    body: &RequestBody,
) -> ReasoningConfig {
    let provider = body
        .provider_options
        .as_ref()
        .and_then(|options| options.openai.as_ref());
    let existing_effort = body
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.effort.clone())
        .or_else(|| provider.and_then(|openai| openai.reasoning_effort.clone()));
    let existing_summary = body
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.summary.clone())
        .or_else(|| provider.and_then(|openai| openai.reasoning_summary.clone()));

    let mut merged = model_config.clone();
    if let Some(effort) = existing_effort.filter(|effort| !effort.is_empty()) {
        merged.reasoning_effort = Some(effort);
    }
    if let Some(summary) = existing_summary.filter(|summary| !summary.is_empty()) {
        merged.reasoning_summary = Some(summary);
    }
    get_reasoning_config(Some(model_name), &merged)
}

/// Spread the strict [`ReasoningConfig`] over the body's permissive
/// `reasoning` slot (TS `body.reasoning = { ...body.reasoning, ...config }`).
fn apply_reasoning(body: &mut RequestBody, config: ReasoningConfig) {
    let mut settings = body.reasoning.take().unwrap_or_default();
    settings.effort = Some(config.effort.as_str().to_string());
    settings.summary = Some(config.summary.as_str().to_string());
    body.reasoning = Some(settings);
}

/// TS `resolveTextVerbosity` — body → providerOptions → modelConfig →
/// `"medium"` (nullish chain: empty strings win through).
fn resolve_text_verbosity(model_config: &ConfigOptions, body: &RequestBody) -> String {
    let provider = body
        .provider_options
        .as_ref()
        .and_then(|options| options.openai.as_ref());
    body.text
        .as_ref()
        .and_then(|text| text.verbosity.clone())
        .or_else(|| provider.and_then(|openai| openai.text_verbosity.clone()))
        .or_else(|| model_config.text_verbosity.clone())
        .unwrap_or_else(|| "medium".to_string())
}

/// TS `resolvePromptCacheRetention` — body → providerOptions → modelConfig.
fn resolve_prompt_cache_retention(
    model_config: &ConfigOptions,
    body: &RequestBody,
) -> Option<String> {
    let provider = body
        .provider_options
        .as_ref()
        .and_then(|options| options.openai.as_ref());
    body.prompt_cache_retention
        .clone()
        .or_else(|| provider.and_then(|openai| openai.prompt_cache_retention.clone()))
        .or_else(|| model_config.prompt_cache_retention.clone())
}

/// Frozen include entry for stateless reasoning continuity.
const REASONING_ENCRYPTED_CONTENT: &str = "reasoning.encrypted_content";

// ---------------------------------------------------------------------------
// transformRequestBody
// ---------------------------------------------------------------------------

/// TS `transformRequestBody` — the exact TS pipeline order (spec 06 §2):
///
/// 1. Model config lookup with the ORIGINAL model name (config keys like
///    `"gpt-5-codex-low"` keep working), then `body.model` normalized.
/// 2. Background-mode gating (two frozen error messages).
/// 3. Fast-session plan; a trivial turn additionally disables tools.
/// 4. `store=false` unless background; **`stream=true` ALWAYS**.
/// 5. Tool cleanup → plan-only sanitize → model-capability sanitize
///    (empty result → `tools` removed).
/// 6. Instructions injection (fast sessions compact them).
/// 7. Input pipeline: fast trim → id filtering (background PRESERVES ids) →
///    host-prompt filter + bridge (codex mode) or tool-remap message →
///    orphaned-output normalization → missing-output injection.
/// 8. Reasoning / text-verbosity / prompt_cache_retention / include
///    resolution; fast-session override clamps reasoning+verbosity.
/// 9. `max_output_tokens` / `max_completion_tokens` removed.
pub fn transform_request_body(
    params: TransformRequestBodyParams<'_>,
) -> Result<RequestBody, TransformRequestBodyError> {
    let TransformRequestBodyParams {
        mut body,
        codex_instructions,
        user_config,
        codex_mode,
        fast_session,
        fast_session_strategy,
        fast_session_max_input_items,
        defer_fast_session_input_trimming,
        allow_background_responses,
        prompts,
    } = params;

    let default_user_config = UserConfig::default();
    let resolved_user_config = user_config.unwrap_or(&default_user_config);

    let original_model = body.model.clone();
    let normalized_model = normalize_model(body.model.as_deref());

    // Config keys use the ORIGINAL model name (`originalModel || normalized`).
    let lookup_model: String = match &original_model {
        Some(model) if !model.is_empty() => model.clone(),
        _ => normalized_model.to_string(),
    };
    let model_config = get_model_config(&lookup_model, Some(resolved_user_config));
    let normalized_profile = model_map::get_model_profile(Some(normalized_model));

    log_debug(
        &format!(
            "Model config lookup: \"{lookup_model}\" \u{2192} normalized to \"{normalized_model}\" for API"
        ),
        Some(&json!({
            "hasModelSpecificConfig": resolved_user_config.models.contains_key(&lookup_model),
            "resolvedConfig": serde_json::to_value(&model_config).unwrap_or(Value::Null),
        })),
    );

    body.model = Some(normalized_model.to_string());
    let should_use_normalized_reasoning_model = normalized_profile.prompt_family
        == ModelFamily::Gpt5Codex
        && lookup_model.to_lowercase().contains("codex");
    let reasoning_model: String = if should_use_normalized_reasoning_model {
        normalized_model.to_string()
    } else {
        lookup_model.clone()
    };

    let background_mode_requested =
        assert_background_mode_compatibility(&body, allow_background_responses)?;
    let plan = resolve_fast_session_input_trim_plan(
        &body,
        fast_session,
        fast_session_strategy,
        fast_session_max_input_items,
    );
    let should_apply_fast_session_tuning = !background_mode_requested && plan.should_apply;
    let is_trivial_turn = plan.is_trivial_turn;
    let should_disable_tools_for_trivial_turn = should_apply_fast_session_tuning && is_trivial_turn;

    // Codex required fields: store=false (stateless) unless background;
    // stream=true ALWAYS — response handling reconstructs JSON later.
    body.store = Some(background_mode_requested);
    body.stream = Some(true);

    let collaboration_mode = detect_collaboration_mode(&body);
    if body.tools.is_some() && should_disable_tools_for_trivial_turn {
        body.tools = None;
    }
    if body.tools.is_some() {
        body.tools = cleanup_tool_definitions(body.tools.take());
        body.tools = sanitize_plan_only_tools(body.tools.take(), collaboration_mode);
        body.tools = sanitize_model_incompatible_tools(body.tools.take(), body.model.as_deref());
        if body.tools.as_ref().is_some_and(Vec::is_empty) {
            body.tools = None;
        }
    }

    body.instructions = Some(if should_apply_fast_session_tuning {
        compact_instructions_for_fast_session(codex_instructions, is_trivial_turn)
    } else {
        codex_instructions.to_string()
    });

    // Filter and transform input.
    if body.input.is_some() {
        let mut input_items = body.input.take();

        if should_apply_fast_session_tuning && !defer_fast_session_input_trimming {
            let prefer_latest_user_only = plan
                .trim
                .map(|trim| trim.prefer_latest_user_only)
                .unwrap_or(false);
            input_items = trim_input_for_fast_session(
                input_items,
                fast_session_max_input_items,
                prefer_latest_user_only,
            );
        }

        let truthy_ids = |items: Option<&[InputItem]>| -> Vec<String> {
            items
                .unwrap_or(&[])
                .iter()
                .filter_map(|item| item.id.clone().filter(|id| !id.is_empty()))
                .collect()
        };
        let original_ids = truthy_ids(input_items.as_deref());
        if !original_ids.is_empty() {
            log_debug(
                &format!("Filtering {} message IDs from input:", original_ids.len()),
                Some(&json!(original_ids)),
            );
        }

        // Background mode PRESERVES ids (stateful path).
        body.input = filter_input(input_items, !background_mode_requested);

        let remaining_ids = truthy_ids(body.input.as_deref());
        if !remaining_ids.is_empty() && !background_mode_requested {
            log_warn(
                &format!(
                    "WARNING: {} IDs still present after filtering:",
                    remaining_ids.len()
                ),
                Some(&json!(remaining_ids)),
            );
        } else if !original_ids.is_empty() {
            log_debug(
                &format!("Successfully removed all {} message IDs", original_ids.len()),
                None,
            );
        }

        if codex_mode {
            // CODEX_MODE: remove host system prompt, add bridge prompt.
            body.input = filter_host_system_prompts_with_cached_prompt(
                body.input.take(),
                prompts.cached_host_prompt.as_deref(),
            );
            body.input = add_codex_bridge_message(
                body.input.take(),
                body.tools.is_some(),
                prompts.codex_host_bridge,
            );
        } else {
            // DEFAULT MODE: keep original behavior with tool remap message.
            body.input = add_tool_remap_message(
                body.input.take(),
                body.tools.is_some(),
                prompts.tool_remap_message,
            );
        }

        // Orphaned tool outputs become messages (context preserved); calls
        // without outputs get a cancelled-output injected.
        if let Some(items) = body.input.take() {
            let items = input_utils::normalize_orphaned_tool_outputs(items);
            body.input = Some(input_utils::inject_missing_tool_outputs(items));
        }
    }

    // Reasoning (existing body/provider options win over config defaults).
    let reasoning_config = resolve_reasoning_config(&reasoning_model, &model_config, &body);
    apply_reasoning(&mut body, reasoning_config);

    // Text verbosity (preserves the host structured-output `text.format`).
    let verbosity = resolve_text_verbosity(&model_config, &body);
    let mut text = body.text.take().unwrap_or_default();
    text.verbosity = Some(verbosity);
    body.text = Some(text);

    if let Some(retention) = resolve_prompt_cache_retention(&model_config, &body) {
        body.prompt_cache_retention = Some(retention);
    }

    if should_apply_fast_session_tuning {
        // Clamp to minimum reasoning + verbosity; getReasoningConfig
        // normalizes unsupported values per model family (codex → "low").
        let fast_reasoning = get_reasoning_config(
            Some(&reasoning_model),
            &ConfigOptions {
                reasoning_effort: Some("none".to_string()),
                reasoning_summary: Some("auto".to_string()),
                ..Default::default()
            },
        );
        apply_reasoning(&mut body, fast_reasoning);
        let mut text = body.text.take().unwrap_or_default();
        text.verbosity = Some("low".to_string());
        body.text = Some(text);
    }

    // Include: background passes the raw chain through (may end absent);
    // stateless defaults to (and always appends) reasoning.encrypted_content.
    let provider_include = body
        .provider_options
        .as_ref()
        .and_then(|options| options.openai.as_ref())
        .and_then(|openai| openai.include.clone());
    if background_mode_requested {
        body.include = body
            .include
            .take()
            .or(provider_include)
            .or_else(|| model_config.include.clone());
    } else {
        let base = body
            .include
            .take()
            .or(provider_include)
            .or_else(|| model_config.include.clone())
            .unwrap_or_else(|| vec![REASONING_ENCRYPTED_CONTENT.to_string()]);
        let mut seen: HashSet<String> = HashSet::new();
        let mut include: Vec<String> = base
            .into_iter()
            .filter(|entry| !entry.is_empty())
            .filter(|entry| seen.insert(entry.clone()))
            .collect();
        if !include.iter().any(|entry| entry == REASONING_ENCRYPTED_CONTENT) {
            include.push(REASONING_ENCRYPTED_CONTENT.to_string());
        }
        body.include = Some(include);
    }

    // Remove unsupported parameters.
    body.max_output_tokens = None;
    body.max_completion_tokens = None;

    Ok(body)
}

/// Async TS-parity wrapper over [`transform_request_body`]: awaits the cached
/// host prompt exactly like the TS `transformRequestBody` does internally
/// (fetch failure → `None` → signature-only host-prompt detection), then runs
/// the synchronous pipeline. An already-populated
/// `params.prompts.cached_host_prompt` is kept as-is.
pub async fn transform_request_body_fetching_host_prompt(
    mut params: TransformRequestBodyParams<'_>,
) -> Result<RequestBody, TransformRequestBodyError> {
    if params.codex_mode && params.prompts.cached_host_prompt.is_none() {
        params.prompts.cached_host_prompt =
            crate::prompts::host_prompt::get_host_codex_prompt().await.ok();
    }
    transform_request_body(params)
}

/// TS `filterHostSystemPrompts` — fetches the cached host prompt for
/// verification (failure → text-based detection only) and filters.
pub async fn filter_host_system_prompts(
    input: Option<Vec<InputItem>>,
) -> Option<Vec<InputItem>> {
    let cached_prompt = crate::prompts::host_prompt::get_host_codex_prompt().await.ok();
    filter_host_system_prompts_with_cached_prompt(input, cached_prompt.as_deref())
}

// ===========================================================================
// Tests — ported from test/request-transformer.test.ts
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::from_value;

    const CODEX_INSTRUCTIONS: &str = "Test Codex Instructions";
    const TEST_BRIDGE: &str = "TEST_CODEX_HOST_BRIDGE_PROMPT";
    const TEST_REMAP: &str = "TEST_TOOL_REMAP apply_patch patch (preferred if available)";

    fn body_of(value: Value) -> RequestBody {
        from_value(value).expect("test body must parse")
    }

    fn base_params(value: Value) -> TransformRequestBodyParams<'static> {
        let mut params = TransformRequestBodyParams::new(body_of(value), CODEX_INSTRUCTIONS);
        params.prompts = TransformPrompts {
            codex_host_bridge: TEST_BRIDGE,
            tool_remap_message: TEST_REMAP,
            cached_host_prompt: None,
        };
        params
    }

    fn transform(value: Value) -> RequestBody {
        transform_request_body(base_params(value)).expect("transform must succeed")
    }

    fn transform_with(
        value: Value,
        adjust: impl FnOnce(&mut TransformRequestBodyParams<'static>),
    ) -> RequestBody {
        let mut params = base_params(value);
        adjust(&mut params);
        transform_request_body(params).expect("transform must succeed")
    }

    fn user_config(value: Value) -> UserConfig {
        from_value(value).expect("test user config must parse")
    }

    fn effort_of(body: &RequestBody) -> &str {
        body.reasoning
            .as_ref()
            .and_then(|r| r.effort.as_deref())
            .unwrap_or("")
    }

    fn summary_of(body: &RequestBody) -> &str {
        body.reasoning
            .as_ref()
            .and_then(|r| r.summary.as_deref())
            .unwrap_or("")
    }

    fn verbosity_of(body: &RequestBody) -> &str {
        body.text
            .as_ref()
            .and_then(|t| t.verbosity.as_deref())
            .unwrap_or("")
    }

    fn tools_json(body: &RequestBody) -> Value {
        serde_json::to_value(&body.tools).unwrap()
    }

    // --- variant-suffix pattern (the (?<!codex) lookbehind) ----------------

    #[test]
    fn variant_suffix_strips_reasoning_and_ultra_suffixes() {
        assert_eq!(
            split_variant_suffix("gpt-5-codex-low"),
            ("gpt-5-codex", Some(ModelReasoningEffort::Low))
        );
        assert_eq!(
            split_variant_suffix("gpt-5.6-sol-ultra"),
            ("gpt-5.6-sol", Some(ModelReasoningEffort::Ultra))
        );
        // `ultra` has NO codex guard — codex-ultra still parses the suffix.
        assert_eq!(
            split_variant_suffix("gpt-5-codex-ultra"),
            ("gpt-5-codex", Some(ModelReasoningEffort::Ultra))
        );
        assert_eq!(
            split_variant_suffix("GPT-5.2-CODEX-XHIGH"),
            ("GPT-5.2-CODEX", Some(ModelReasoningEffort::Xhigh))
        );
    }

    #[test]
    fn variant_suffix_max_is_guarded_by_the_codex_lookbehind() {
        // `-max` after codex is part of the MODEL ID, not an effort.
        assert_eq!(split_variant_suffix("gpt-5.1-codex-max"), ("gpt-5.1-codex-max", None));
        assert_eq!(split_variant_suffix("codex-max"), ("codex-max", None));
        assert_eq!(split_variant_suffix("GPT-5.1-CODEX-MAX"), ("GPT-5.1-CODEX-MAX", None));
        // `-max` NOT preceded by codex is an effort suffix.
        assert_eq!(
            split_variant_suffix("gpt-5.6-sol-max"),
            ("gpt-5.6-sol", Some(ModelReasoningEffort::Max))
        );
        // Only ONE suffix strips ($-anchored, non-global).
        assert_eq!(
            split_variant_suffix("gpt-5-high-low"),
            ("gpt-5-high", Some(ModelReasoningEffort::Low))
        );
        // No suffix at all.
        assert_eq!(split_variant_suffix("gpt-5.5"), ("gpt-5.5", None));
    }

    // --- normalizeModel -----------------------------------------------------

    #[test]
    fn normalize_model_handles_case_and_formatting_variations() {
        assert_eq!(normalize_model(Some("GPT-5.4")), "gpt-5.4");
        assert_eq!(normalize_model(Some("GPT-5-HIGH")), "gpt-5.5");
        assert_eq!(normalize_model(Some("Gpt-5.4-Pro")), "gpt-5.4-pro");
        assert_eq!(
            normalize_model(Some("GPT 5 High (ChatGPT Subscription)")),
            "gpt-5.5"
        );
        assert_eq!(
            normalize_model(Some("GPT 5 Codex Low (ChatGPT Subscription)")),
            "gpt-5.3-codex"
        );
        assert_eq!(normalize_model(None), "gpt-5.5");
        assert_eq!(normalize_model(Some("")), "gpt-5.5");
    }

    // --- getModelConfig -----------------------------------------------------

    #[test]
    fn model_config_finds_per_model_options_using_config_key() {
        let config = user_config(json!({
            "global": { "reasoningEffort": "medium" },
            "models": {
                "gpt-5-codex-low": { "options": { "reasoningEffort": "low", "textVerbosity": "low" } }
            }
        }));
        let result = get_model_config("gpt-5-codex-low", Some(&config));
        assert_eq!(result.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(result.text_verbosity.as_deref(), Some("low"));
    }

    #[test]
    fn model_config_resolves_provider_prefixed_ids_to_base_model_config() {
        let config = user_config(json!({
            "global": { "reasoningEffort": "medium" },
            "models": {
                "gpt-5.2-codex": { "options": { "reasoningEffort": "xhigh", "reasoningSummary": "detailed" } }
            }
        }));
        let result = get_model_config("openai/gpt-5.2-codex", Some(&config));
        assert_eq!(result.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(result.reasoning_summary.as_deref(), Some("detailed"));
    }

    #[test]
    fn model_config_applies_variants_from_base_model_config() {
        let config = user_config(json!({
            "global": { "reasoningEffort": "medium", "reasoningSummary": "auto" },
            "models": {
                "gpt-5.2-codex": {
                    "options": { "reasoningSummary": "auto" },
                    "variants": { "xhigh": { "reasoningEffort": "xhigh", "reasoningSummary": "detailed" } }
                }
            }
        }));
        let result = get_model_config("openai/gpt-5.2-codex-xhigh", Some(&config));
        assert_eq!(result.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(result.reasoning_summary.as_deref(), Some("detailed"));
    }

    #[test]
    fn model_config_merges_global_and_per_model_options_per_model_wins() {
        let config = user_config(json!({
            "global": {
                "reasoningEffort": "medium",
                "textVerbosity": "medium",
                "include": ["reasoning.encrypted_content"]
            },
            "models": {
                "gpt-5-codex-high": { "options": { "reasoningEffort": "high" } }
            }
        }));
        let result = get_model_config("gpt-5-codex-high", Some(&config));
        assert_eq!(result.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(result.text_verbosity.as_deref(), Some("medium"));
        assert_eq!(
            result.include,
            Some(vec!["reasoning.encrypted_content".to_string()])
        );
    }

    #[test]
    fn model_config_returns_global_options_when_model_not_in_config() {
        let config = user_config(json!({
            "global": { "reasoningEffort": "medium" },
            "models": {
                "gpt-5-codex-low": { "options": { "reasoningEffort": "low" } }
            }
        }));
        let result = get_model_config("gpt-5-codex", Some(&config));
        assert_eq!(result.reasoning_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn model_config_handles_empty_and_absent_configs() {
        assert_eq!(
            get_model_config("gpt-5-codex", Some(&UserConfig::default())),
            ConfigOptions::default()
        );
        assert_eq!(get_model_config("gpt-5", None), ConfigOptions::default());
    }

    #[test]
    fn model_config_works_with_old_verbose_keys_and_extra_id_field() {
        let config = user_config(json!({
            "global": {},
            "models": {
                "GPT 5 Codex Low (ChatGPT Subscription)": { "options": { "reasoningEffort": "low" } }
            }
        }));
        let result = get_model_config("GPT 5 Codex Low (ChatGPT Subscription)", Some(&config));
        assert_eq!(result.reasoning_effort.as_deref(), Some("low"));

        // Unknown `id` key on the entry is tolerated (extra map).
        let config = user_config(json!({
            "global": {},
            "models": {
                "gpt-5-codex-low": { "id": "gpt-5-codex", "options": { "reasoningEffort": "low" } }
            }
        }));
        let result = get_model_config("gpt-5-codex-low", Some(&config));
        assert_eq!(result.reasoning_effort.as_deref(), Some("low"));
    }

    // --- applyFastSessionDefaults -------------------------------------------

    #[test]
    fn fast_session_defaults_fill_only_missing_values() {
        let config = user_config(json!({
            "global": { "reasoningEffort": "high" },
            "models": {}
        }));
        let result = apply_fast_session_defaults(&config);
        assert_eq!(result.global.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(result.global.text_verbosity.as_deref(), Some("low"));

        let result = apply_fast_session_defaults(&UserConfig::default());
        assert_eq!(result.global.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(result.global.text_verbosity.as_deref(), Some("low"));
    }

    // --- filterInput --------------------------------------------------------

    #[test]
    fn filter_input_strips_all_ids_and_keeps_items() {
        let input: Vec<InputItem> = from_value(json!([
            { "id": "rs_123", "type": "message", "role": "assistant", "content": "hello" },
            { "id": "msg_456", "type": "message", "role": "user", "content": "world" },
            { "id": "assistant_789", "type": "message", "role": "assistant", "content": "test" },
        ]))
        .unwrap();
        let result = filter_input(Some(input), true).unwrap();
        assert_eq!(result.len(), 3);
        assert!(result.iter().all(|item| item.id.is_none()));
        assert_eq!(
            result[0].content.as_ref().and_then(Value::as_str),
            Some("hello")
        );
    }

    #[test]
    fn filter_input_preserves_other_properties_and_handles_edges() {
        let input: Vec<InputItem> = from_value(json!([
            { "id": "msg_123", "type": "message", "role": "user", "content": "test", "metadata": { "some": "data" } },
            { "id": "", "type": "message", "role": "user", "content": "hello" },
        ]))
        .unwrap();
        let result = filter_input(Some(input), true).unwrap();
        assert_eq!(result.len(), 2);
        assert!(result[0].id.is_none());
        assert!(result[0].extra.contains_key("metadata"));
        assert!(result[1].id.is_none());

        assert!(filter_input(None, true).is_none());
        assert_eq!(filter_input(Some(Vec::new()), true), Some(Vec::new()));
    }

    #[test]
    fn filter_input_removes_item_reference_items_and_can_keep_ids() {
        let input: Vec<InputItem> = from_value(json!([
            { "id": "ref_1", "type": "item_reference" },
            { "id": "msg_1", "type": "message", "role": "user", "content": "hi" },
        ]))
        .unwrap();
        let stripped = filter_input(Some(input.clone()), true).unwrap();
        assert_eq!(stripped.len(), 1);
        assert!(stripped[0].id.is_none());

        // stripIds=false (background mode) keeps ids but still drops refs.
        let kept = filter_input(Some(input), false).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id.as_deref(), Some("msg_1"));
    }

    // --- add bridge / remap message ----------------------------------------

    #[test]
    fn add_messages_prepend_developer_message_only_with_tools() {
        let input: Vec<InputItem> =
            from_value(json!([{ "type": "message", "role": "user", "content": "hello" }])).unwrap();

        let bridged = add_codex_bridge_message(Some(input.clone()), true, TEST_BRIDGE).unwrap();
        assert_eq!(bridged.len(), 2);
        assert_eq!(bridged[0].role.as_deref(), Some("developer"));
        assert_eq!(bridged[0].kind.as_deref(), Some("message"));
        let text = bridged[0].content.as_ref().unwrap()[0]["text"]
            .as_str()
            .unwrap();
        assert_eq!(text, TEST_BRIDGE);

        let remapped = add_tool_remap_message(Some(input.clone()), true, TEST_REMAP).unwrap();
        assert!(
            remapped[0].content.as_ref().unwrap()[0]["text"]
                .as_str()
                .unwrap()
                .contains("apply_patch")
        );

        assert_eq!(
            add_codex_bridge_message(Some(input.clone()), false, TEST_BRIDGE),
            Some(input)
        );
        assert!(add_codex_bridge_message(None, true, TEST_BRIDGE).is_none());
        assert!(add_tool_remap_message(None, true, TEST_REMAP).is_none());
    }

    // --- transformRequestBody: cache fields ---------------------------------

    #[test]
    fn preserves_prompt_cache_key_and_previous_response_id() {
        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [],
            "prompt_cache_key": "ses_host_key_123",
        }));
        assert_eq!(result.prompt_cache_key.as_deref(), Some("ses_host_key_123"));

        let result = transform(json!({ "model": "gpt-5", "input": [] }));
        assert!(result.prompt_cache_key.is_none());

        let result = transform(json!({
            "model": "gpt-5.4",
            "input": [],
            "previous_response_id": "resp_prior_123",
        }));
        assert_eq!(result.previous_response_id.as_deref(), Some("resp_prior_123"));
    }

    #[test]
    fn prompt_cache_retention_precedence_body_provider_config() {
        let result = transform(json!({
            "model": "gpt-5.4",
            "input": [],
            "prompt_cache_key": "ses_cache_key_123",
            "prompt_cache_retention": "24h",
        }));
        assert_eq!(result.prompt_cache_retention.as_deref(), Some("24h"));

        let result = transform(json!({
            "model": "gpt-5.4",
            "input": [],
            "providerOptions": { "openai": { "promptCacheRetention": "1h" } },
        }));
        assert_eq!(result.prompt_cache_retention.as_deref(), Some("1h"));

        // providerOptions beats user config.
        let config = user_config(json!({ "global": { "promptCacheRetention": "7d" }, "models": {} }));
        let result = transform_with(
            json!({
                "model": "gpt-5.4",
                "input": [],
                "providerOptions": { "openai": { "promptCacheRetention": "1h" } },
            }),
            |params| params.user_config = Some(Box::leak(Box::new(config))),
        );
        assert_eq!(result.prompt_cache_retention.as_deref(), Some("1h"));

        // Body beats providerOptions.
        let result = transform(json!({
            "model": "gpt-5.4",
            "input": [],
            "prompt_cache_retention": "24h",
            "providerOptions": { "openai": { "promptCacheRetention": "1h" } },
        }));
        assert_eq!(result.prompt_cache_retention.as_deref(), Some("24h"));
    }

    #[test]
    fn inherits_prompt_cache_retention_from_user_config_layers() {
        let global_only = user_config(json!({
            "global": { "promptCacheRetention": "7d" },
            "models": {}
        }));
        let result = transform_with(json!({ "model": "gpt-5.4", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(global_only)))
        });
        assert_eq!(result.prompt_cache_retention.as_deref(), Some("7d"));

        let model_specific = user_config(json!({
            "global": { "promptCacheRetention": "7d" },
            "models": { "gpt-5.4": { "options": { "promptCacheRetention": "24h" } } }
        }));
        let result = transform_with(json!({ "model": "gpt-5.4", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(model_specific)))
        });
        assert_eq!(result.prompt_cache_retention.as_deref(), Some("24h"));
    }

    #[test]
    fn preserves_text_format_when_applying_verbosity_defaults() {
        let format = json!({
            "type": "json_schema",
            "name": "contract_response",
            "schema": {
                "type": "object",
                "properties": { "answer": { "type": "string" } },
                "required": ["answer"],
            },
            "strict": true,
        });
        let result = transform(json!({
            "model": "gpt-5.4",
            "input": [],
            "text": { "format": format },
        }));
        assert_eq!(verbosity_of(&result), "medium");
        assert_eq!(
            serde_json::to_value(result.text.as_ref().unwrap().format.as_ref().unwrap()).unwrap(),
            format
        );
    }

    // --- required Codex fields ----------------------------------------------

    #[test]
    fn sets_required_codex_fields() {
        let result = transform(json!({ "model": "gpt-5", "input": [] }));
        assert_eq!(result.store, Some(false));
        assert_eq!(result.stream, Some(true));
        assert_eq!(result.instructions.as_deref(), Some(CODEX_INSTRUCTIONS));
    }

    #[test]
    fn forces_stateless_invariants_even_with_conflicting_caller_values() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [],
            "stream": false,
            "store": true,
            "include": ["custom_field"],
        }));
        assert_eq!(result.stream, Some(true));
        assert_eq!(result.store, Some(false));
        assert_eq!(
            result.include,
            Some(vec![
                "custom_field".to_string(),
                "reasoning.encrypted_content".to_string()
            ])
        );
    }

    #[test]
    fn normalizes_model_name() {
        let result = transform(json!({ "model": "gpt-5-mini", "input": [] }));
        assert_eq!(result.model.as_deref(), Some("gpt-5-mini"));
        assert_eq!(effort_of(&result), "medium");
    }

    #[test]
    fn removes_unsupported_parameters() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [],
            "max_output_tokens": 1000,
            "max_completion_tokens": 2000,
        }));
        assert!(result.max_output_tokens.is_none());
        assert!(result.max_completion_tokens.is_none());
        // And they do not serialize at all.
        let raw = serde_json::to_value(&result).unwrap();
        assert!(raw.get("max_output_tokens").is_none());
        assert!(raw.get("max_completion_tokens").is_none());
    }

    // --- reasoning & verbosity resolution -----------------------------------

    #[test]
    fn applies_gpt55_default_reasoning_for_stale_bare_gpt5_aliases() {
        let result = transform(json!({ "model": "gpt-5", "input": [] }));
        assert_eq!(effort_of(&result), "none");
        assert_eq!(summary_of(&result), "auto");
    }

    #[test]
    fn applies_user_reasoning_config() {
        let config = user_config(json!({
            "global": { "reasoningEffort": "high", "reasoningSummary": "detailed" },
            "models": {}
        }));
        let result = transform_with(json!({ "model": "gpt-5", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(effort_of(&result), "high");
        assert_eq!(summary_of(&result), "detailed");
    }

    #[test]
    fn respects_reasoning_config_already_set_in_body() {
        let config = user_config(json!({
            "global": { "reasoningEffort": "high", "reasoningSummary": "detailed" },
            "models": {}
        }));
        let result = transform_with(
            json!({
                "model": "gpt-5",
                "input": [],
                "reasoning": { "effort": "low", "summary": "auto" },
            }),
            |params| params.user_config = Some(Box::leak(Box::new(config))),
        );
        assert_eq!(effort_of(&result), "low");
        assert_eq!(summary_of(&result), "auto");
    }

    #[test]
    fn uses_reasoning_config_from_provider_options() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [],
            "providerOptions": { "openai": { "reasoningEffort": "high", "reasoningSummary": "detailed" } },
        }));
        assert_eq!(effort_of(&result), "high");
        assert_eq!(summary_of(&result), "detailed");
    }

    #[test]
    fn text_verbosity_resolution_chain() {
        let result = transform(json!({ "model": "gpt-5", "input": [] }));
        assert_eq!(verbosity_of(&result), "medium");

        let config = user_config(json!({ "global": { "textVerbosity": "low" }, "models": {} }));
        let result = transform_with(json!({ "model": "gpt-5", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(verbosity_of(&result), "low");

        let result = transform(json!({
            "model": "gpt-5",
            "input": [],
            "providerOptions": { "openai": { "textVerbosity": "low" } },
        }));
        assert_eq!(verbosity_of(&result), "low");

        // Body wins over providerOptions.
        let result = transform(json!({
            "model": "gpt-5",
            "input": [],
            "text": { "verbosity": "high" },
            "providerOptions": { "openai": { "textVerbosity": "low" } },
        }));
        assert_eq!(verbosity_of(&result), "high");
    }

    #[test]
    fn include_defaults_and_user_include() {
        let result = transform(json!({ "model": "gpt-5", "input": [] }));
        assert_eq!(
            result.include,
            Some(vec!["reasoning.encrypted_content".to_string()])
        );

        let config = user_config(json!({
            "global": { "include": ["custom_field", "reasoning.encrypted_content"] },
            "models": {}
        }));
        let result = transform_with(json!({ "model": "gpt-5", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(
            result.include,
            Some(vec![
                "custom_field".to_string(),
                "reasoning.encrypted_content".to_string()
            ])
        );
    }

    // --- effort coercion per model ------------------------------------------

    #[test]
    fn coerces_efforts_per_model_family() {
        // minimal → low for codex.
        let config = user_config(json!({ "global": { "reasoningEffort": "minimal" }, "models": {} }));
        let result = transform_with(json!({ "model": "gpt-5-codex", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(effort_of(&result), "low");

        // none → low for codex aliases.
        for model in ["gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.1-codex", "gpt-5.1-codex-max"] {
            let config = user_config(json!({ "global": { "reasoningEffort": "none" }, "models": {} }));
            let result = transform_with(json!({ "model": model, "input": [] }), |params| {
                params.user_config = Some(Box::leak(Box::new(config)))
            });
            assert_eq!(result.model.as_deref(), Some("gpt-5.3-codex"), "{model}");
            assert_eq!(effort_of(&result), "low", "{model}");
        }

        // none preserved for general models that support it.
        let config = user_config(json!({ "global": { "reasoningEffort": "none" }, "models": {} }));
        let result = transform_with(json!({ "model": "gpt-5.2-none", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(result.model.as_deref(), Some("gpt-5.2"));
        assert_eq!(effort_of(&result), "none");

        let config = user_config(json!({ "global": { "reasoningEffort": "none" }, "models": {} }));
        let result = transform_with(json!({ "model": "gpt-5.1-none", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(result.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(effort_of(&result), "none");
    }

    #[test]
    fn codex_defaults_and_xhigh_preservation() {
        // Deprecated aliases route to the current codex model, default high.
        for model in ["gpt-5.1-codex-max", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark"] {
            let result = transform(json!({ "model": model, "input": [] }));
            assert_eq!(result.model.as_deref(), Some("gpt-5.3-codex"), "{model}");
            assert_eq!(effort_of(&result), "high", "{model}");
        }

        // Per-model xhigh config on the exact variant key is honored.
        let config = user_config(json!({
            "global": { "reasoningSummary": "auto" },
            "models": {
                "gpt-5.1-codex-max-xhigh": { "options": { "reasoningEffort": "xhigh", "reasoningSummary": "detailed" } }
            }
        }));
        let result = transform_with(
            json!({ "model": "gpt-5.1-codex-max-xhigh", "input": [] }),
            |params| params.user_config = Some(Box::leak(Box::new(config))),
        );
        assert_eq!(result.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(effort_of(&result), "xhigh");
        assert_eq!(summary_of(&result), "detailed");

        // Global xhigh survives on codex (supported)…
        let config = user_config(json!({ "global": { "reasoningEffort": "xhigh" }, "models": {} }));
        let result = transform_with(json!({ "model": "gpt-5.1-codex-high", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(result.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(effort_of(&result), "xhigh");

        // …and codex-mini aliases keep the requested xhigh too.
        let config = user_config(json!({ "global": { "reasoningEffort": "xhigh" }, "models": {} }));
        let result = transform_with(
            json!({ "model": "gpt-5.1-codex-mini-high", "input": [] }),
            |params| params.user_config = Some(Box::leak(Box::new(config))),
        );
        assert_eq!(result.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(effort_of(&result), "xhigh");
    }

    #[test]
    fn downgrades_xhigh_to_high_for_non_max_general_models() {
        let config = user_config(json!({ "global": { "reasoningEffort": "xhigh" }, "models": {} }));
        let result = transform_with(json!({ "model": "gpt-5.1-high", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(result.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(effort_of(&result), "high");
    }

    #[test]
    fn gpt55_reasoning_defaults_before_unsupported_model_fallback() {
        let config = user_config(json!({ "global": { "reasoningEffort": "minimal" }, "models": {} }));
        let result = transform_with(json!({ "model": "gpt-5.5-high", "input": [] }), |params| {
            params.user_config = Some(Box::leak(Box::new(config)))
        });
        assert_eq!(result.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(effort_of(&result), "low");
        assert_eq!(verbosity_of(&result), "medium");
    }

    #[test]
    fn uses_medium_effort_for_lightweight_models() {
        let result = transform(json!({ "model": "gpt-5-nano", "input": [] }));
        assert_eq!(effort_of(&result), "medium");
    }

    // --- fast session --------------------------------------------------------

    fn fast(value: Value, strategy: FastSessionStrategy) -> RequestBody {
        transform_with(value, |params| {
            params.fast_session = true;
            params.fast_session_strategy = strategy;
        })
    }

    #[test]
    fn clamps_reasoning_and_text_for_fast_session_on_codex_models() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "low");
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
    }

    #[test]
    fn allows_none_reasoning_for_fast_session_on_gpt51_general() {
        let result = fast(
            json!({
                "model": "gpt-5.1",
                "input": [],
                "reasoning": { "effort": "high", "summary": "auto" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "none");
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
    }

    #[test]
    fn keeps_full_depth_settings_for_complex_prompts_in_hybrid_strategy() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": "Please handle this request in depth:\n1. Inspect auth flow state transitions.\n2. Compare retry and backoff behavior.\n3. Explain likely failure modes.\n4. Propose fixes with tradeoffs.",
                }],
                "tools": [{ "type": "function", "function": { "name": "read_file" } }],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "xhigh");
        assert_eq!(summary_of(&result), "detailed");
        assert_eq!(verbosity_of(&result), "high");
    }

    #[test]
    fn compacts_long_instructions_for_trivial_turns_in_hybrid_strategy() {
        let long_instructions = format!("RULES\n{}", "x".repeat(5000));
        let result = transform_with(
            json!({
                "model": "gpt-5.3-codex",
                "input": [{ "type": "message", "role": "user", "content": "hi" }],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
            }),
            |params| {
                params.codex_instructions = Box::leak(long_instructions.clone().into_boxed_str());
                params.fast_session = true;
            },
        );
        let instructions = result.instructions.as_deref().unwrap();
        assert!(instructions.len() < long_instructions.len());
        assert!(instructions.contains("Fast session mode"));
        assert_eq!(summary_of(&result), "auto");
    }

    #[test]
    fn keeps_long_instructions_for_complex_turns_in_hybrid_strategy() {
        let long_instructions = format!("RULES\n{}", "x".repeat(5000));
        let result = transform_with(
            json!({
                "model": "gpt-5.3-codex",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": "Please perform deep analysis:\n1. inspect auth flow\n2. inspect retries\n3. explain tradeoffs",
                }],
            }),
            |params| {
                params.codex_instructions = Box::leak(long_instructions.clone().into_boxed_str());
                params.fast_session = true;
            },
        );
        assert_eq!(result.instructions.as_deref(), Some(long_instructions.as_str()));
    }

    #[test]
    fn applies_fast_settings_for_simple_prompts_and_disables_tools() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [{ "type": "message", "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "read_file" } }],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "low");
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
        assert!(result.tools.is_none());
    }

    #[test]
    fn keeps_fast_settings_for_short_multi_turn_chat_in_hybrid_strategy() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [
                    { "type": "message", "role": "user", "content": "hi" },
                    { "type": "message", "role": "assistant", "content": "hey" },
                    { "type": "message", "role": "user", "content": "yo" },
                    { "type": "message", "role": "assistant", "content": "sup" },
                    { "type": "message", "role": "user", "content": "ok" },
                ],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "low");
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
    }

    #[test]
    fn drops_medium_length_head_scaffolds_for_trivial_turns() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [
                    { "type": "message", "role": "developer", "content": format!("HEAD {}", "x".repeat(700)) },
                    { "type": "message", "role": "user", "content": "hello" },
                ],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        let has_head = result.input.as_deref().unwrap_or(&[]).iter().any(|item| {
            item.role.as_deref() == Some("developer")
                && extract_message_text(item.content.as_ref()).contains("HEAD")
        });
        assert!(!has_head);
        assert_eq!(summary_of(&result), "auto");
    }

    #[test]
    fn ultra_compacts_trivial_turns_in_hybrid_strategy() {
        let mut input = vec![json!({ "type": "message", "role": "developer", "content": "Small stable scaffold" })];
        for i in 0..18 {
            input.push(json!({
                "type": "message",
                "role": if i % 2 == 0 { "assistant" } else { "user" },
                "content": format!("history-{i}"),
            }));
        }
        input.push(json!({ "type": "message", "role": "user", "content": "yo" }));

        let result = transform_with(
            json!({
                "model": "gpt-5.1",
                "input": input,
                "reasoning": { "effort": "high", "summary": "auto" },
                "text": { "verbosity": "high" },
            }),
            |params| {
                params.fast_session = true;
                params.fast_session_max_input_items = 8;
            },
        );
        let items = result.input.as_deref().unwrap();
        assert!(items.len() <= 2);
        let latest_user = items
            .iter()
            .rev()
            .find(|item| item.role.as_deref() == Some("user"))
            .unwrap();
        assert_eq!(
            latest_user.content.as_ref().and_then(Value::as_str),
            Some("yo")
        );
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
    }

    #[test]
    fn applies_fast_settings_when_tool_history_is_old_but_recent_turn_is_simple() {
        let mut input = vec![json!({
            "type": "function_call_output", "call_id": "old_1", "name": "read_file", "output": "{}"
        })];
        for i in 0..20 {
            input.push(json!({
                "type": "message",
                "role": if i % 2 == 0 { "assistant" } else { "user" },
                "content": format!("filler-{i}"),
            }));
        }
        input.push(json!({ "type": "message", "role": "user", "content": "hi" }));

        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": input,
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "low");
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
    }

    #[test]
    fn keeps_full_depth_settings_when_recent_tool_call_history_exists() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [
                    { "type": "message", "role": "user", "content": "quick check" },
                    { "type": "function_call_output", "call_id": "recent_1", "name": "read_file", "output": "{}" },
                ],
                "tools": [{ "type": "function", "function": { "name": "read_file" } }],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "xhigh");
        assert_eq!(summary_of(&result), "detailed");
        assert_eq!(verbosity_of(&result), "high");
        assert_eq!(
            tools_json(&result),
            json!([{ "type": "function", "function": { "name": "read_file" } }])
        );
    }

    #[test]
    fn fast_settings_when_latest_user_prompt_is_trivial_even_after_complex_history() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": "Please analyze this thoroughly:\n- identify failure paths\n- map dependencies\n- suggest mitigations\n- call out risks",
                    },
                    { "type": "message", "role": "assistant", "content": "Understood." },
                    { "type": "message", "role": "user", "content": "hi" },
                ],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Hybrid,
        );
        assert_eq!(effort_of(&result), "low");
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
    }

    #[test]
    fn always_strategy_compacts_context_without_overriding_instructions() {
        let mut input = vec![json!({ "type": "message", "role": "developer", "content": "Core instruction scaffold" })];
        for i in 0..24 {
            input.push(json!({
                "type": "message",
                "role": if i % 2 == 0 { "assistant" } else { "user" },
                "content": format!("history-{i}"),
            }));
        }
        input.push(json!({ "type": "message", "role": "user", "content": "hi" }));

        let result = transform_with(
            json!({
                "model": "gpt-5.3-codex",
                "input": input,
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            |params| {
                params.fast_session = true;
                params.fast_session_strategy = FastSessionStrategy::Always;
                params.fast_session_max_input_items = 12;
            },
        );
        let items = result.input.as_deref().unwrap();
        assert!(items.len() <= 12);
        let last_user = items
            .iter()
            .rev()
            .find(|item| item.role.as_deref() == Some("user"))
            .unwrap();
        assert_eq!(last_user.content.as_ref().and_then(Value::as_str), Some("hi"));
        assert_eq!(result.instructions.as_deref(), Some(CODEX_INSTRUCTIONS));
        assert_eq!(effort_of(&result), "low");
        assert_eq!(verbosity_of(&result), "low");
    }

    #[test]
    fn always_strategy_forces_fast_settings_for_complex_prompts_but_keeps_tools() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": "Please perform a full review:\n1. inspect account rotation\n2. inspect refresh queue\n3. inspect retry windows\n4. summarize issues and improvements",
                }],
                "tools": [{ "type": "function", "function": { "name": "read_file" } }],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Always,
        );
        assert_eq!(effort_of(&result), "low");
        assert_eq!(summary_of(&result), "auto");
        assert_eq!(verbosity_of(&result), "low");
        assert_eq!(
            tools_json(&result),
            json!([{ "type": "function", "function": { "name": "read_file" } }])
        );
    }

    #[test]
    fn always_strategy_disables_tools_for_trivial_turns() {
        let result = fast(
            json!({
                "model": "gpt-5.3-codex",
                "input": [{ "type": "message", "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "read_file" } }],
                "reasoning": { "effort": "xhigh", "summary": "detailed" },
                "text": { "verbosity": "high" },
            }),
            FastSessionStrategy::Always,
        );
        assert_eq!(effort_of(&result), "low");
        assert!(result.tools.is_none());
    }

    #[test]
    fn defers_fast_session_input_trimming_when_requested() {
        let input: Vec<Value> = (0..12)
            .map(|index| {
                json!({
                    "type": "message",
                    "role": if index == 0 { "developer" } else { "user" },
                    "content": if index == 0 { "system prompt".to_string() } else { format!("message-{index}") },
                })
            })
            .collect();
        let result = transform_with(json!({ "model": "gpt-5.4", "input": input }), |params| {
            params.fast_session = true;
            params.fast_session_strategy = FastSessionStrategy::Always;
            params.fast_session_max_input_items = 8;
            params.defer_fast_session_input_trimming = true;
        });
        assert_eq!(result.input.as_deref().unwrap().len(), 12);
    }

    // --- input surgery through the pipeline ---------------------------------

    #[test]
    fn removes_ids_from_input_array() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [
                { "id": "rs_123", "type": "message", "role": "assistant", "content": "old" },
                { "type": "message", "role": "user", "content": "new" },
            ],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.id.is_none()));
        assert_eq!(items[0].content.as_ref().and_then(Value::as_str), Some("old"));
        assert_eq!(items[1].content.as_ref().and_then(Value::as_str), Some("new"));
    }

    #[test]
    fn adds_bridge_message_when_tools_present_in_codex_mode() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [{ "type": "message", "role": "user", "content": "hello" }],
            "tools": [{ "name": "test_tool" }],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].role.as_deref(), Some("developer"));
        assert_eq!(
            items[0].content.as_ref().unwrap()[0]["text"].as_str(),
            Some(TEST_BRIDGE)
        );
    }

    #[test]
    fn filters_codex_prompts_in_codex_mode() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [
                { "type": "message", "role": "developer", "content": "You are a coding agent running in the Codex" },
                { "type": "message", "role": "user", "content": "hello" },
            ],
            "tools": [{ "name": "test_tool" }],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].role.as_deref(), Some("developer"));
        assert_eq!(
            items[0].content.as_ref().unwrap()[0]["text"].as_str(),
            Some(TEST_BRIDGE)
        );
        assert_eq!(items[1].role.as_deref(), Some("user"));
    }

    #[test]
    fn no_message_added_without_tools() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [{ "type": "message", "role": "user", "content": "hello" }],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].role.as_deref(), Some("user"));
    }

    #[test]
    fn uses_tool_remap_message_and_keeps_codex_prompts_when_codex_mode_off() {
        let result = transform_with(
            json!({
                "model": "gpt-5",
                "input": [
                    { "type": "message", "role": "developer", "content": "You are a coding agent running in the Codex" },
                    { "type": "message", "role": "user", "content": "hello" },
                ],
                "tools": [{ "name": "test_tool" }],
            }),
            |params| params.codex_mode = false,
        );
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].role.as_deref(), Some("developer"));
        let remap_text = items[0].content.as_ref().unwrap()[0]["text"].as_str().unwrap();
        assert!(remap_text.contains("apply_patch"));
        assert!(remap_text.contains("patch (preferred if available)"));
        assert_eq!(items[1].role.as_deref(), Some("developer"));
        assert_eq!(items[2].role.as_deref(), Some("user"));
    }

    #[test]
    fn converts_orphaned_function_call_output_to_message() {
        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [
                { "type": "message", "role": "user", "content": "hello" },
                { "type": "function_call_output", "role": "assistant", "call_id": "orphan_call", "name": "read", "output": "{}" },
            ],
        }));
        assert!(result.tools.is_none());
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind.as_deref(), Some("message"));
        assert_eq!(items[1].kind.as_deref(), Some("message"));
        assert_eq!(items[1].role.as_deref(), Some("assistant"));
        assert!(
            items[1]
                .content
                .as_ref()
                .and_then(Value::as_str)
                .unwrap()
                .contains("[Previous read result; call_id=orphan_call]")
        );
    }

    #[test]
    fn keeps_matched_tool_call_pairs() {
        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [
                { "type": "message", "role": "user", "content": "hello" },
                { "type": "function_call", "call_id": "call_1", "name": "write", "arguments": "{}" },
                { "type": "function_call_output", "call_id": "call_1", "output": "success" },
            ],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1].kind.as_deref(), Some("function_call"));
        assert_eq!(items[2].kind.as_deref(), Some("function_call_output"));
    }

    #[test]
    fn treats_local_shell_call_as_match_for_function_call_output() {
        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [
                { "type": "message", "role": "user", "content": "hello" },
                { "type": "local_shell_call", "call_id": "shell_call", "action": { "type": "exec", "command": ["ls"] } },
                { "type": "function_call_output", "call_id": "shell_call", "output": "ok" },
            ],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1].kind.as_deref(), Some("local_shell_call"));
        assert_eq!(items[2].kind.as_deref(), Some("function_call_output"));
    }

    #[test]
    fn keeps_matching_and_converts_orphaned_custom_tool_call_outputs() {
        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [
                { "type": "message", "role": "user", "content": "hello" },
                { "type": "custom_tool_call", "call_id": "custom_call", "name": "mcp_tool", "input": "{}" },
                { "type": "custom_tool_call_output", "call_id": "custom_call", "output": "done" },
            ],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1].kind.as_deref(), Some("custom_tool_call"));
        assert_eq!(items[2].kind.as_deref(), Some("custom_tool_call_output"));

        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [
                { "type": "message", "role": "user", "content": "hello" },
                { "type": "custom_tool_call_output", "call_id": "orphan_custom", "output": "oops" },
            ],
        }));
        let items = result.input.as_deref().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].kind.as_deref(), Some("message"));
        assert!(
            items[1]
                .content
                .as_ref()
                .and_then(Value::as_str)
                .unwrap()
                .contains("[Previous tool result; call_id=orphan_custom]")
        );
    }

    // --- collaboration mode & capability sanitization -----------------------

    fn tool_names(body: &RequestBody) -> Vec<String> {
        tools_json(body)
            .as_array()
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn removes_request_user_input_tool_in_default_collaboration_mode() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [{
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "# Collaboration Mode: Default" }],
            }],
            "tools": [
                { "type": "function", "function": { "name": "request_user_input", "parameters": { "type": "object", "properties": {} } } },
                { "type": "function", "function": { "name": "exec_command", "parameters": { "type": "object", "properties": {} } } },
            ],
        }));
        assert_eq!(tool_names(&result), vec!["exec_command".to_string()]);
    }

    #[test]
    fn keeps_request_user_input_tool_in_plan_collaboration_mode() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [{
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "# Collaboration Mode: Plan" }],
            }],
            "tools": [
                { "type": "function", "function": { "name": "request_user_input", "parameters": { "type": "object", "properties": {} } } },
            ],
        }));
        assert_eq!(tool_names(&result), vec!["request_user_input".to_string()]);
    }

    #[test]
    fn removes_nested_request_user_input_tools_outside_plan_mode() {
        // No collaboration signal at all → "unknown" also removes plan-only tools.
        let result = transform(json!({
            "model": "gpt-5",
            "input": [],
            "tools": [{
                "type": "namespace",
                "name": "planner",
                "tools": [
                    { "type": "function", "function": { "name": "request_user_input", "parameters": { "type": "object", "properties": {} } } },
                    { "type": "function", "function": { "name": "exec_command", "parameters": { "type": "object", "properties": {} } } },
                ],
            }],
        }));
        let tools = tools_json(&result);
        assert_eq!(tools[0]["type"], json!("namespace"));
        assert_eq!(tools[0]["name"], json!("planner"));
        let nested = tools[0]["tools"].as_array().unwrap();
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0]["function"]["name"], json!("exec_command"));
    }

    #[test]
    fn drops_namespace_entirely_when_all_plan_only_tools_are_removed() {
        let result = transform(json!({
            "model": "gpt-5",
            "input": [{
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "# Collaboration Mode: Default" }],
            }],
            "tools": [{
                "type": "namespace",
                "name": "planner",
                "tools": [
                    { "type": "function", "function": { "name": "request_user_input", "parameters": { "type": "object", "properties": {} } } },
                ],
            }],
        }));
        assert!(result.tools.is_none());
    }

    #[test]
    fn removes_tool_search_when_model_lacks_search_capability() {
        let result = transform(json!({
            "model": "gpt-5-nano",
            "input": [],
            "tools": [
                { "type": "tool_search", "max_num_results": 3 },
                { "type": "mcp", "server_label": "docs", "server_url": "https://mcp.example.com", "defer_loading": true },
            ],
        }));
        assert_eq!(
            tools_json(&result),
            json!([
                { "type": "mcp", "server_label": "docs", "server_url": "https://mcp.example.com", "defer_loading": true }
            ])
        );
    }

    #[test]
    fn gpt55_pro_capability_surface_keeps_computer_use_but_drops_tool_search() {
        let config = user_config(json!({ "global": { "reasoningEffort": "low" }, "models": {} }));
        let result = transform_with(
            json!({
                "model": "gpt-5.5-pro",
                "input": [],
                "tools": [
                    { "type": "tool_search", "max_num_results": 3 },
                    { "type": "computer_use_preview", "display_width": 1024, "display_height": 768, "environment": "browser" },
                ],
            }),
            |params| params.user_config = Some(Box::leak(Box::new(config))),
        );
        assert_eq!(result.model.as_deref(), Some("gpt-5.5-pro"));
        assert_eq!(effort_of(&result), "medium");
        assert_eq!(verbosity_of(&result), "medium");
        assert_eq!(
            tools_json(&result),
            json!([
                { "type": "computer_use_preview", "display_width": 1024, "display_height": 768, "environment": "browser" }
            ])
        );
    }

    #[test]
    fn removes_computer_tools_when_model_lacks_computer_use() {
        let result = transform(json!({
            "model": "gpt-5-nano",
            "input": [],
            "tools": [
                { "type": "computer_use_preview", "display_width": 1024, "display_height": 768, "environment": "browser" },
                { "type": "tool_search", "max_num_results": 1 },
            ],
        }));
        assert!(result.tools.is_none());
        assert_eq!(result.input.as_deref().unwrap().len(), 0);
    }

    #[test]
    fn filters_unsupported_tools_from_nested_namespaces() {
        let result = transform(json!({
            "model": "gpt-5-nano",
            "input": [],
            "tools": [{
                "type": "namespace",
                "name": "outer_suite",
                "tools": [{
                    "type": "namespace",
                    "name": "inner_suite",
                    "tools": [
                        { "type": "tool_search", "max_num_results": 2 },
                        { "type": "mcp", "server_label": "remote-docs", "server_url": "https://mcp.example.com", "defer_loading": true },
                    ],
                }],
            }],
        }));
        assert_eq!(
            tools_json(&result),
            json!([{
                "type": "namespace",
                "name": "outer_suite",
                "tools": [{
                    "type": "namespace",
                    "name": "inner_suite",
                    "tools": [
                        { "type": "mcp", "server_label": "remote-docs", "server_url": "https://mcp.example.com", "defer_loading": true }
                    ],
                }],
            }])
        );
    }

    #[test]
    #[serial_test::serial(env)]
    fn env_collaboration_mode_overrides_input_detection() {
        let mut sandbox = cma_testkit::sandbox::EnvSandbox::new();
        sandbox.set_var("CODEX_COLLABORATION_MODE", "plan");
        // Input says Default, but the env override forces plan mode → the
        // plan-only tool survives.
        let result = transform(json!({
            "model": "gpt-5",
            "input": [{
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "# Collaboration Mode: Default" }],
            }],
            "tools": [
                { "type": "function", "function": { "name": "request_user_input", "parameters": { "type": "object", "properties": {} } } },
            ],
        }));
        assert_eq!(tool_names(&result), vec!["request_user_input".to_string()]);
    }

    // --- tool schema cleaning through the pipeline ---------------------------

    #[test]
    fn cleans_tool_schemas_through_the_pipeline() {
        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "test_tool",
                    "parameters": {
                        "type": "object",
                        "properties": { "valid_param": { "type": "string" } },
                        "required": ["valid_param", "invalid_param"],
                    },
                },
            }],
        }));
        let tools = tools_json(&result);
        assert_eq!(
            tools[0]["function"]["parameters"]["required"],
            json!(["valid_param"])
        );

        let result = transform(json!({
            "model": "gpt-5-codex",
            "input": [],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "void_tool",
                    "parameters": { "type": "object", "properties": {} },
                },
            }],
        }));
        let tools = tools_json(&result);
        assert!(
            tools[0]["function"]["parameters"]["properties"]
                .get("_placeholder")
                .is_some()
        );
    }

    // --- background mode ------------------------------------------------------

    #[test]
    fn rejects_background_mode_unless_explicitly_enabled() {
        let err = transform_request_body(base_params(json!({
            "model": "gpt-5.4",
            "background": true,
            "input": [{ "type": "message", "role": "user", "content": "hello" }],
        })))
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Responses background mode is disabled. Enable pluginConfig.backgroundResponses or CODEX_AUTH_BACKGROUND_RESPONSES=1 to opt in."
        );
    }

    #[test]
    fn preserves_stateful_request_fields_when_background_mode_is_enabled() {
        let result = transform_with(
            json!({
                "model": "gpt-5.4",
                "background": true,
                "input": [{ "id": "msg_stateful_123", "type": "message", "role": "user", "content": "hello" }],
            }),
            |params| {
                params.fast_session = true;
                params.fast_session_strategy = FastSessionStrategy::Always;
                params.fast_session_max_input_items = 12;
                params.allow_background_responses = true;
            },
        );
        assert_eq!(result.background, Some(true));
        assert_eq!(result.store, Some(true));
        assert!(result.include.is_none());
        assert_eq!(verbosity_of(&result), "medium");
        let user_item = result
            .input
            .as_deref()
            .unwrap()
            .iter()
            .find(|item| item.role.as_deref() == Some("user"))
            .unwrap();
        assert_eq!(user_item.id.as_deref(), Some("msg_stateful_123"));
        assert_eq!(user_item.kind.as_deref(), Some("message"));
        assert_eq!(
            user_item.content.as_ref().and_then(Value::as_str),
            Some("hello")
        );
    }

    #[test]
    fn rejects_background_mode_when_store_false_is_forced() {
        let expected = "Responses background mode requires store=true and cannot be combined with stateless store=false routing.";

        let err = transform_request_body({
            let mut params = base_params(json!({
                "model": "gpt-5.4",
                "background": true,
                "store": false,
                "input": [{ "type": "message", "role": "user", "content": "hello" }],
            }));
            params.allow_background_responses = true;
            params
        })
        .unwrap_err();
        assert_eq!(err.to_string(), expected);

        let err = transform_request_body({
            let mut params = base_params(json!({
                "model": "gpt-5.4",
                "background": true,
                "providerOptions": { "openai": { "store": false } },
                "input": [{ "type": "message", "role": "user", "content": "hello" }],
            }));
            params.allow_background_responses = true;
            params
        })
        .unwrap_err();
        assert_eq!(err.to_string(), expected);
    }

    // --- trimInputForFastSession ---------------------------------------------

    #[test]
    fn trim_preserves_leading_developer_instruction_outside_the_tail_window() {
        let mut input: Vec<InputItem> = vec![
            from_value(json!({ "type": "message", "role": "developer", "content": "HEAD_INSTRUCTION" })).unwrap(),
        ];
        for i in 1..50 {
            input.push(
                from_value(json!({ "type": "message", "role": "user", "content": format!("msg-{i}") }))
                    .unwrap(),
            );
        }

        let max_items = 30;
        let result = trim_input_for_fast_session(Some(input), max_items, false).unwrap();

        assert_eq!(
            result[0].content.as_ref().and_then(Value::as_str),
            Some("HEAD_INSTRUCTION")
        );
        assert_eq!(result[0].role.as_deref(), Some("developer"));
        assert_eq!(
            result[result.len() - 1]
                .content
                .as_ref()
                .and_then(Value::as_str),
            Some("msg-49")
        );
        // Fills the item budget exactly.
        assert_eq!(result.len() as i64, max_items);
    }

    #[test]
    fn trim_keeps_every_preserved_head_instruction_when_input_just_exceeds_budget() {
        let max_items: i64 = 10;
        let mut input: Vec<InputItem> = vec![
            from_value(json!({ "type": "message", "role": "developer", "content": "HEAD_ONE" })).unwrap(),
            from_value(json!({ "type": "message", "role": "system", "content": "HEAD_TWO" })).unwrap(),
        ];
        for i in 2..=max_items {
            input.push(
                from_value(json!({ "type": "message", "role": "user", "content": format!("msg-{i}") }))
                    .unwrap(),
            );
        }
        assert_eq!(input.len() as i64, max_items + 1);

        let result = trim_input_for_fast_session(Some(input), max_items, false).unwrap();

        assert_eq!(
            result[0].content.as_ref().and_then(Value::as_str),
            Some("HEAD_ONE")
        );
        assert_eq!(
            result[1].content.as_ref().and_then(Value::as_str),
            Some("HEAD_TWO")
        );
        assert_eq!(
            result[result.len() - 1]
                .content
                .as_ref()
                .and_then(Value::as_str),
            Some(format!("msg-{max_items}").as_str())
        );
        assert_eq!(result.len() as i64, max_items);
    }

    #[test]
    fn trim_returns_input_untouched_when_within_budget() {
        let input: Vec<InputItem> = from_value(json!([
            { "type": "message", "role": "user", "content": "a" },
            { "type": "message", "role": "assistant", "content": "b" },
        ]))
        .unwrap();
        let result = trim_input_for_fast_session(Some(input.clone()), 30, false).unwrap();
        assert_eq!(result, input);
        assert!(trim_input_for_fast_session(None, 30, false).is_none());
    }
}
