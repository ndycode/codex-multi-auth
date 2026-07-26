//! Port of `lib/types.ts` — hand-written interfaces (no runtime validation in
//! TS; here permissive serde models).
//!
//! Design rules (ARCHITECTURE §6.1 / §8.1):
//! - [`RequestBody`] and every nested request-shaped struct MUST round-trip
//!   unknown fields: known typed fields + `#[serde(flatten)] extra`.
//!   `serde_json`'s `preserve_order` feature keeps unknown-key order stable.
//! - Fields the TS *interface* marks required but the runtime tolerates
//!   missing (e.g. `RequestBody.model`, `InputItem.role`) are `Option` here so
//!   permissive request bodies keep flowing exactly as they did through the JS
//!   runtime.
//! - Open string unions (`PromptCacheRetention`, verbosity, summary levels on
//!   the wire) stay `String`; strict enums exist only for values WE construct
//!   ([`ReasoningConfig`]).
//!
//! Schema-inferred aliases from TS `types.ts` (`PluginConfig`, `TokenResult`,
//! `AccountIdSource`, …) live in `crate::schemas::*` — the barrel re-export
//! has no Rust equivalent (each consumer imports from the owning module).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::constants::WireReasoningEffort;

// ---------------------------------------------------------------------------
// Host/user config shapes
// ---------------------------------------------------------------------------

/// TS `UserConfig` — the host's per-model configuration tree.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UserConfig {
    #[serde(default)]
    pub global: ConfigOptions,
    #[serde(default)]
    pub models: HashMap<String, UserModelConfig>,
}

/// One entry of `UserConfig.models` (TS inline type; open record).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UserModelConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<ConfigOptions>,
    /// `Record<string, (ConfigOptions & { disabled?: boolean }) | undefined>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variants: Option<HashMap<String, Option<ModelVariantConfig>>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `ConfigOptions`. All unions stay open strings — invalid values must
/// degrade downstream (set-membership checks), never fail deserialization.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ConfigOptions {
    /// `ultra` is accepted here but always resolves to `max` before the request.
    #[serde(default, rename = "reasoningEffort", skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// `"auto" | "concise" | "detailed" | "off" | "on"`.
    #[serde(default, rename = "reasoningSummary", skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    /// `"low" | "medium" | "high"`.
    #[serde(default, rename = "textVerbosity", skip_serializing_if = "Option::is_none")]
    pub text_verbosity: Option<String>,
    /// [`PromptCacheRetention`] — open string union.
    #[serde(default, rename = "promptCacheRetention", skip_serializing_if = "Option::is_none")]
    pub prompt_cache_retention: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `ConfigOptions & { disabled?: boolean }` (model-variant entry).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelVariantConfig {
    #[serde(default, rename = "reasoningEffort", skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, rename = "reasoningSummary", skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(default, rename = "textVerbosity", skip_serializing_if = "Option::is_none")]
    pub text_verbosity: Option<String>,
    #[serde(default, rename = "promptCacheRetention", skip_serializing_if = "Option::is_none")]
    pub prompt_cache_retention: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `PromptCacheRetention = "5m" | "1h" | "24h" | "7d" | (string & {})` —
/// an OPEN string union, so it stays a plain `String` in Rust.
pub type PromptCacheRetention = String;

// ---------------------------------------------------------------------------
// Reasoning config
// ---------------------------------------------------------------------------

/// Summary detail level accepted by the Responses API (TS inline union on
/// `ReasoningConfig.summary`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningSummary {
    Auto,
    Concise,
    Detailed,
}

impl ReasoningSummary {
    pub const fn as_str(self) -> &'static str {
        match self {
            ReasoningSummary::Auto => "auto",
            ReasoningSummary::Concise => "concise",
            ReasoningSummary::Detailed => "detailed",
        }
    }
}

/// TS `ReasoningConfig` — the STRICT shape the transformer constructs.
/// `effort` as sent to the API; `ultra` is absent by construction (it is a
/// client-side tier that always resolves to `max` before the request is built).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningConfig {
    pub effort: WireReasoningEffort,
    pub summary: ReasoningSummary,
}

/// The PERMISSIVE `reasoning` slot of [`RequestBody`]
/// (TS `reasoning?: Partial<ReasoningConfig>` on an unvalidated wire object).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReasoningSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl From<ReasoningConfig> for ReasoningSettings {
    fn from(config: ReasoningConfig) -> Self {
        ReasoningSettings {
            effort: Some(config.effort.as_str().to_string()),
            summary: Some(config.summary.as_str().to_string()),
            extra: Map::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/// TS `ToolParametersSchema` (open record; `type` is nominally `"object"` but
/// left permissive — runtime guards do the checking).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolParametersSchema {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `ToolFunction` (open record).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<ToolParametersSchema>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Literal tag `"function"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum FunctionToolTag {
    #[default]
    #[serde(rename = "function")]
    Function,
}

/// TS `FunctionToolDefinition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionToolDefinition {
    #[serde(rename = "type")]
    pub kind: FunctionToolTag,
    pub function: ToolFunction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer_loading: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Literal tag `"tool_search"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolSearchToolTag {
    #[default]
    #[serde(rename = "tool_search")]
    ToolSearch,
}

/// TS `ToolSearchToolDefinition`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolSearchToolDefinition {
    #[serde(rename = "type")]
    pub kind: ToolSearchToolTag,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_num_results: Option<Number>,
    /// `"low" | "medium" | "high"` (open).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_context_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Literal tag `"mcp"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum RemoteMcpToolTag {
    #[default]
    #[serde(rename = "mcp")]
    Mcp,
}

/// TS `RemoteMcpToolDefinition`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RemoteMcpToolDefinition {
    #[serde(rename = "type")]
    pub kind: RemoteMcpToolTag,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector_id: Option<String>,
    /// `Record<string, string>` in TS; kept order-preserving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    /// `"never" | "always" | "auto" | Record<string, unknown>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_approval: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer_loading: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Literal tag `"computer" | "computer_use_preview"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComputerUseToolTag {
    #[default]
    #[serde(rename = "computer")]
    Computer,
    #[serde(rename = "computer_use_preview")]
    ComputerUsePreview,
}

/// TS `ComputerUseToolDefinition`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ComputerUseToolDefinition {
    #[serde(rename = "type")]
    pub kind: ComputerUseToolTag,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_width: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_height: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Literal tag `"namespace"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum NamespaceToolTag {
    #[default]
    #[serde(rename = "namespace")]
    Namespace,
}

/// TS `ToolNamespaceDefinition` (recursive).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolNamespaceDefinition {
    #[serde(rename = "type")]
    pub kind: NamespaceToolTag,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<RequestToolDefinition>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `RequestToolDefinition` union. Untagged: each typed variant carries a
/// literal `type` tag enum, so discrimination matches the TS discriminants;
/// anything else (including the open `{type?: string}` catch-all) lands in
/// `Other` and round-trips verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestToolDefinition {
    Function(FunctionToolDefinition),
    ToolSearch(ToolSearchToolDefinition),
    RemoteMcp(RemoteMcpToolDefinition),
    ComputerUse(ComputerUseToolDefinition),
    Namespace(ToolNamespaceDefinition),
    Other(Value),
}

// ---------------------------------------------------------------------------
// Text format config
// ---------------------------------------------------------------------------

/// Literal tag `"text"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextFormatTextTag {
    #[default]
    #[serde(rename = "text")]
    Text,
}

/// `{ type: "text", ... }` arm of [`TextFormatConfig`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextFormatText {
    #[serde(rename = "type")]
    pub kind: TextFormatTextTag,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Literal tag `"json_object"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextFormatJsonObjectTag {
    #[default]
    #[serde(rename = "json_object")]
    JsonObject,
}

/// `{ type: "json_object", ... }` arm of [`TextFormatConfig`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextFormatJsonObject {
    #[serde(rename = "type")]
    pub kind: TextFormatJsonObjectTag,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Literal tag `"json_schema"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextFormatJsonSchemaTag {
    #[default]
    #[serde(rename = "json_schema")]
    JsonSchema,
}

/// `{ type: "json_schema", ... }` arm of [`TextFormatConfig`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextFormatJsonSchema {
    #[serde(rename = "type")]
    pub kind: TextFormatJsonSchemaTag,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `TextFormatConfig` union (all arms are open records; the final arm is a
/// full catch-all so any JSON value round-trips).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TextFormatConfig {
    Text(TextFormatText),
    JsonObject(TextFormatJsonObject),
    JsonSchema(TextFormatJsonSchema),
    Other(Value),
}

/// The permissive `text` slot of [`RequestBody`]
/// (TS `text?: { verbosity?; format? }`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextSettings {
    /// `"low" | "medium" | "high"` (open).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<TextFormatConfig>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// ---------------------------------------------------------------------------
// OAuth flow shapes
// ---------------------------------------------------------------------------

/// Data half of the TS `OAuthServerInfo` (the `close`/`waitForCode` behavior
/// lives on the server handle in `cma-auth::callback_server`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthServerInfo {
    pub port: u16,
    pub ready: bool,
    /// The `errno` code from a failed listen (for example `EADDRINUSE`) when
    /// `ready` is `false`. Lets callers distinguish a contended callback port
    /// from other bind failures. Absent when `ready` is `true`.
    #[serde(
        default,
        rename = "bindErrorCode",
        skip_serializing_if = "Option::is_none"
    )]
    pub bind_error_code: Option<String>,
}

/// TS `PKCEPair`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PKCEPair {
    pub challenge: String,
    pub verifier: String,
}

/// TS `AuthorizationFlow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationFlow {
    pub pkce: PKCEPair,
    pub state: String,
    pub url: String,
}

/// TS `ParsedAuthInput`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedAuthInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

/// TS `OAuthAuthDetails = Extract<Auth, { type: "oauth" }>` — the in-memory
/// credential triple exchanged between the account manager and auth flows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthAuthDetails {
    pub access: String,
    pub refresh: String,
    /// Epoch milliseconds.
    pub expires: i64,
}

// ---------------------------------------------------------------------------
// JWT payload
// ---------------------------------------------------------------------------

/// The `"https://api.openai.com/auth"` claim object (see
/// [`crate::constants::JWT_CLAIM_PATH`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct JwtAuthClaim {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_user_email: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `JWTPayload` — JWT payload with ChatGPT account info. Unverified decode
/// target (`crate::jwt::decode_jwt`); everything optional, unknown keys kept.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct JWTPayload {
    #[serde(
        default,
        rename = "https://api.openai.com/auth",
        skip_serializing_if = "Option::is_none"
    )]
    pub auth: Option<JwtAuthClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organizations: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orgs: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teams: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_username: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/// TS `InputItem` — message input item. The TS interface marks `type`/`role`
/// required, but the runtime tolerates items without them (e.g.
/// `function_call_output` items carry no `role`), so both are optional here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InputItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The `providerOptions.openai` slot
/// (TS `Partial<ConfigOptions> & { store?; include? }`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OpenAiProviderOptions {
    #[serde(default, rename = "reasoningEffort", skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, rename = "reasoningSummary", skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(default, rename = "textVerbosity", skip_serializing_if = "Option::is_none")]
    pub text_verbosity: Option<String>,
    #[serde(default, rename = "promptCacheRetention", skip_serializing_if = "Option::is_none")]
    pub prompt_cache_retention: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The `providerOptions` slot of [`RequestBody`] (open record).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProviderOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai: Option<OpenAiProviderOptions>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `RequestBody` — the Responses API request body. Permissive: known typed
/// fields + `extra` for everything else; MUST round-trip unknown fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RequestBody {
    /// Required in the TS interface; optional here because the runtime routes
    /// missing/empty models to `DEFAULT_MODEL` downstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<InputItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<RequestToolDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(
        default,
        rename = "providerOptions",
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_options: Option<ProviderOptions>,
    /// Stable key to enable prompt-token caching on Codex backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    /// Retention mode for server-side prompt cache entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_retention: Option<PromptCacheRetention>,
    /// Resume a prior Responses API turn without resending the full transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<Number>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// ---------------------------------------------------------------------------
// SSE / caching / GitHub
// ---------------------------------------------------------------------------

/// TS `SSEEventData` — SSE event data structure. `type` is nominally required;
/// optional here so the response handler can apply its own malformed-event
/// handling instead of failing deserialization.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SSEEventData {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `CacheMetadata` — cache metadata for Codex instructions.
/// NOTE: `etag` is `string | null` (NOT optional) — `None` serializes as an
/// explicit `null`, matching the TS on-disk cache format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheMetadata {
    pub etag: Option<String>,
    pub tag: String,
    #[serde(rename = "lastChecked")]
    pub last_checked: i64,
    pub url: String,
    /// SHA-256 of the cached content (prompts-03). When present, the disk
    /// cache is verified against it before use and discarded on mismatch, so
    /// a corrupted or tampered cache file cannot be served as trusted prompt
    /// instructions. Optional for backward compatibility with caches written
    /// before this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// TS `GitHubRelease`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_body_round_trips_unknown_fields() {
        let raw = json!({
            "model": "gpt-5.3-codex",
            "stream": true,
            "store": false,
            "instructions": "be brief",
            "input": [
                {"type": "message", "role": "user", "content": "hi", "customFlag": true},
                {"type": "function_call_output", "call_id": "c1", "output": "{}"}
            ],
            "reasoning": {"effort": "high", "novelKey": 1},
            "text": {"verbosity": "low", "format": {"type": "text"}},
            "providerOptions": {"openai": {"reasoningEffort": "medium", "store": true}},
            "prompt_cache_key": "abc",
            "max_output_tokens": 4096,
            "totally_unknown_top_level": {"a": [1, 2, 3]}
        });

        let body: RequestBody = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(body.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(body.stream, Some(true));
        assert_eq!(body.store, Some(false));
        assert!(body.extra.contains_key("totally_unknown_top_level"));

        let input = body.input.as_ref().unwrap();
        assert_eq!(input[0].role.as_deref(), Some("user"));
        assert!(input[0].extra.contains_key("customFlag"));
        // function_call_output items have no role — must still parse.
        assert_eq!(input[1].role, None);
        assert!(input[1].extra.contains_key("call_id"));

        let reasoning = body.reasoning.as_ref().unwrap();
        assert_eq!(reasoning.effort.as_deref(), Some("high"));
        assert!(reasoning.extra.contains_key("novelKey"));

        let round = serde_json::to_value(&body).unwrap();
        assert_eq!(round, raw);
    }

    #[test]
    fn request_body_without_model_still_parses() {
        let body: RequestBody = serde_json::from_value(json!({"input": []})).unwrap();
        assert_eq!(body.model, None);
        let round = serde_json::to_value(&body).unwrap();
        assert_eq!(round, json!({"input": []}));
    }

    #[test]
    fn tool_definitions_discriminate_on_type_literal() {
        let raw = json!([
            {"type": "function", "function": {"name": "read_file", "parameters": {"type": "object", "properties": {}}}},
            {"type": "tool_search", "max_num_results": 5},
            {"type": "mcp", "server_label": "gh", "require_approval": "never"},
            {"type": "computer_use_preview", "display_width": 1280},
            {"type": "namespace", "name": "ns", "tools": [{"type": "function", "function": {"name": "inner"}}]},
            {"type": "future_tool_kind", "payload": 1},
            {"no_type_at_all": true}
        ]);
        let tools: Vec<RequestToolDefinition> = serde_json::from_value(raw.clone()).unwrap();

        assert!(matches!(&tools[0], RequestToolDefinition::Function(f) if f.function.name == "read_file"));
        assert!(matches!(&tools[1], RequestToolDefinition::ToolSearch(_)));
        assert!(matches!(&tools[2], RequestToolDefinition::RemoteMcp(m) if m.server_label.as_deref() == Some("gh")));
        assert!(matches!(
            &tools[3],
            RequestToolDefinition::ComputerUse(c) if c.kind == ComputerUseToolTag::ComputerUsePreview
        ));
        assert!(matches!(&tools[4], RequestToolDefinition::Namespace(n) if n.tools.as_ref().unwrap().len() == 1));
        assert!(matches!(&tools[5], RequestToolDefinition::Other(_)));
        assert!(matches!(&tools[6], RequestToolDefinition::Other(_)));

        let round = serde_json::to_value(&tools).unwrap();
        assert_eq!(round, raw);
    }

    #[test]
    fn malformed_function_tool_falls_to_catch_all_and_round_trips() {
        // `type: "function"` without a `function` field — the TS runtime guard
        // would skip it; here it lands in Other and round-trips untouched.
        let raw = json!({"type": "function", "name": "oops"});
        let tool: RequestToolDefinition = serde_json::from_value(raw.clone()).unwrap();
        assert!(matches!(&tool, RequestToolDefinition::Other(_)));
        assert_eq!(serde_json::to_value(&tool).unwrap(), raw);
    }

    #[test]
    fn text_format_config_arms() {
        let text: TextFormatConfig = serde_json::from_value(json!({"type": "text"})).unwrap();
        assert!(matches!(text, TextFormatConfig::Text(_)));

        let schema: TextFormatConfig = serde_json::from_value(
            json!({"type": "json_schema", "name": "s", "strict": true, "schema": {"type": "object"}}),
        )
        .unwrap();
        match &schema {
            TextFormatConfig::JsonSchema(s) => {
                assert_eq!(s.name.as_deref(), Some("s"));
                assert_eq!(s.strict, Some(true));
            }
            other => panic!("expected JsonSchema, got {other:?}"),
        }

        let unknown: TextFormatConfig =
            serde_json::from_value(json!({"type": "grammar", "rules": []})).unwrap();
        assert!(matches!(unknown, TextFormatConfig::Other(_)));
    }

    #[test]
    fn reasoning_config_converts_to_wire_settings() {
        let config = ReasoningConfig {
            effort: WireReasoningEffort::Max,
            summary: ReasoningSummary::Auto,
        };
        let settings: ReasoningSettings = config.into();
        assert_eq!(settings.effort.as_deref(), Some("max"));
        assert_eq!(settings.summary.as_deref(), Some("auto"));
        assert_eq!(
            serde_json::to_value(&settings).unwrap(),
            json!({"effort": "max", "summary": "auto"})
        );
    }

    #[test]
    fn jwt_payload_reads_the_claim_path_and_keeps_unknown_keys() {
        let raw = json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acc_123",
                "chatgpt_user_email": "user@example.com",
                "plan": "pro"
            },
            "email": "user@example.com",
            "exp": 1_700_000_000,
            "custom": {"nested": true}
        });
        let payload: JWTPayload = serde_json::from_value(raw.clone()).unwrap();
        let auth = payload.auth.as_ref().unwrap();
        assert_eq!(auth.chatgpt_account_id.as_deref(), Some("acc_123"));
        assert_eq!(auth.chatgpt_user_email.as_deref(), Some("user@example.com"));
        assert!(auth.extra.contains_key("plan"));
        assert_eq!(payload.email.as_deref(), Some("user@example.com"));
        assert!(payload.extra.contains_key("exp"));
        assert!(payload.extra.contains_key("custom"));
        assert_eq!(serde_json::to_value(&payload).unwrap(), raw);
    }

    #[test]
    fn cache_metadata_serializes_null_etag_and_omits_absent_sha256() {
        let meta = CacheMetadata {
            etag: None,
            tag: "codex".to_string(),
            last_checked: 1_700_000_000_123,
            url: "https://example.com/prompt.md".to_string(),
            sha256: None,
        };
        assert_eq!(
            serde_json::to_string(&meta).unwrap(),
            r#"{"etag":null,"tag":"codex","lastChecked":1700000000123,"url":"https://example.com/prompt.md"}"#
        );

        // Pre-sha256 caches (no field) still deserialize.
        let old: CacheMetadata = serde_json::from_str(
            r#"{"etag":"\"abc\"","tag":"t","lastChecked":1,"url":"u"}"#,
        )
        .unwrap();
        assert_eq!(old.etag.as_deref(), Some("\"abc\""));
        assert_eq!(old.sha256, None);
    }

    #[test]
    fn oauth_shapes_round_trip() {
        let info = OAuthServerInfo {
            port: 1455,
            ready: false,
            bind_error_code: Some("EADDRINUSE".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            json!({"port": 1455, "ready": false, "bindErrorCode": "EADDRINUSE"})
        );

        let details = OAuthAuthDetails {
            access: "a".into(),
            refresh: "r".into(),
            expires: 1_700_000_000_000,
        };
        let round: OAuthAuthDetails =
            serde_json::from_value(serde_json::to_value(&details).unwrap()).unwrap();
        assert_eq!(round, details);
    }

    #[test]
    fn user_config_tolerates_missing_sections_and_open_values() {
        let config: UserConfig = serde_json::from_value(json!({})).unwrap();
        assert!(config.models.is_empty());

        let config: UserConfig = serde_json::from_value(json!({
            "global": {"reasoningEffort": "ultra", "unknownOpt": 1},
            "models": {
                "gpt-5.5": {
                    "options": {"textVerbosity": "high"},
                    "variants": {"fast": {"reasoningEffort": "low", "disabled": true}, "off": null},
                    "customModelKey": "x"
                }
            }
        }))
        .unwrap();
        assert_eq!(config.global.reasoning_effort.as_deref(), Some("ultra"));
        assert!(config.global.extra.contains_key("unknownOpt"));
        let model = &config.models["gpt-5.5"];
        assert_eq!(
            model.options.as_ref().unwrap().text_verbosity.as_deref(),
            Some("high")
        );
        let variants = model.variants.as_ref().unwrap();
        assert_eq!(
            variants["fast"].as_ref().unwrap().disabled,
            Some(true)
        );
        assert!(variants["off"].is_none());
        assert!(model.extra.contains_key("customModelKey"));
    }

    #[test]
    fn sse_event_data_is_permissive() {
        let event: SSEEventData = serde_json::from_value(json!({
            "type": "response.completed",
            "response": {"id": "resp_1"},
            "sequence_number": 7
        }))
        .unwrap();
        assert_eq!(event.kind.as_deref(), Some("response.completed"));
        assert!(event.response.is_some());
        assert!(event.extra.contains_key("sequence_number"));

        // No type at all still parses; the response handler decides what to do.
        let untyped: SSEEventData = serde_json::from_value(json!({"delta": "x"})).unwrap();
        assert_eq!(untyped.kind, None);
    }
}
