//! Account storage schemas — port of the account-storage half of
//! `lib/schemas.ts` (spec 01 §3.2, spec 02 §3–4).
//!
//! Byte-compat rules honored here (spec 02 §3, ARCHITECTURE §8.1):
//! - Serde field order == zod schema declaration order (accounts:
//!   `accountId, accountIdSource, accountLabel, email, refreshToken,
//!   accessToken, expiresAt, enabled, addedAt, lastUsed, lastSwitchReason,
//!   rateLimitResetTimes, coolingDownUntil, cooldownReason, workspaces,
//!   currentWorkspaceIndex`; top level: `version, accounts, activeIndex,
//!   activeIndexByFamily[, pinnedAccountIndex][, affinityGeneration]`).
//! - `None` optionals are omitted (`skip_serializing_if`), mirroring
//!   `JSON.stringify` dropping `undefined` values.
//! - `workspaces`/`currentWorkspaceIndex` MUST be part of the schema or a
//!   strict-strip parse silently erases workspace tracking on every load
//!   round-trip (#491).
//! - `version: 3` / `version: 1` are literal-checked at deserialization time.
//! - [`RateLimitStateV3`] preserves key insertion order with JS object
//!   semantics (re-assigning an existing key keeps its position).
//!
//! Zod-bound enforcement (whole-parse failure on violation, like
//! `safeParse`): `refreshToken` non-empty, `activeIndex >= 0`,
//! `pinnedAccountIndex`/`affinityGeneration` non-negative integers.
//! Unknown keys are ignored on parse (zod strips them) — including V3-only
//! keys appearing in V1 payloads.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::parse::{
    Version1, Version3, de_number_lenient, de_number_min0_lenient, de_opt_int_min0_strict,
    de_opt_number_lenient, de_opt_strict, de_string_min1, number_to_i64_lossy,
};
use crate::model_family::ModelFamily;

// ============================================================================
// Enums (spec 01 §3.2; also ARCHITECTURE §4 item 4 — these live in core)
// ============================================================================

/// Source of the accountId used for ChatGPT requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AccountIdSource {
    #[serde(rename = "token")]
    Token,
    #[serde(rename = "id_token")]
    IdToken,
    #[serde(rename = "org")]
    Org,
    #[serde(rename = "manual")]
    Manual,
}

impl AccountIdSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::IdToken => "id_token",
            Self::Org => "org",
            Self::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "token" => Some(Self::Token),
            "id_token" => Some(Self::IdToken),
            "org" => Some(Self::Org),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

impl std::fmt::Display for AccountIdSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Cooldown reason for temporary account suspension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CooldownReason {
    #[serde(rename = "auth-failure")]
    AuthFailure,
    #[serde(rename = "network-error")]
    NetworkError,
    #[serde(rename = "server-error")]
    ServerError,
    #[serde(rename = "rate-limit")]
    RateLimit,
}

impl CooldownReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AuthFailure => "auth-failure",
            Self::NetworkError => "network-error",
            Self::ServerError => "server-error",
            Self::RateLimit => "rate-limit",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auth-failure" => Some(Self::AuthFailure),
            "network-error" => Some(Self::NetworkError),
            "server-error" => Some(Self::ServerError),
            "rate-limit" => Some(Self::RateLimit),
            _ => None,
        }
    }
}

impl std::fmt::Display for CooldownReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Last switch reason for account rotation tracking.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SwitchReason {
    #[serde(rename = "rate-limit")]
    RateLimit,
    #[serde(rename = "initial")]
    Initial,
    #[serde(rename = "rotation")]
    Rotation,
    #[serde(rename = "best")]
    Best,
    #[serde(rename = "restore")]
    Restore,
    #[serde(rename = "manual")]
    Manual,
}

impl SwitchReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::RateLimit => "rate-limit",
            Self::Initial => "initial",
            Self::Rotation => "rotation",
            Self::Best => "best",
            Self::Restore => "restore",
            Self::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "rate-limit" => Some(Self::RateLimit),
            "initial" => Some(Self::Initial),
            "rotation" => Some(Self::Rotation),
            "best" => Some(Self::Best),
            "restore" => Some(Self::Restore),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

impl std::fmt::Display for SwitchReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Switch reasons that callers may pass to `persistAndSyncSelectedAccount`.
/// Excludes the runtime-internal reasons (`rate-limit`, `initial`) which are
/// recorded by `markSwitched` but never originate from the CLI persist path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PersistedSwitchReason {
    #[serde(rename = "rotation")]
    Rotation,
    #[serde(rename = "best")]
    Best,
    #[serde(rename = "restore")]
    Restore,
    #[serde(rename = "manual")]
    Manual,
}

impl PersistedSwitchReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Rotation => "rotation",
            Self::Best => "best",
            Self::Restore => "restore",
            Self::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "rotation" => Some(Self::Rotation),
            "best" => Some(Self::Best),
            "restore" => Some(Self::Restore),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

impl From<PersistedSwitchReason> for SwitchReason {
    fn from(value: PersistedSwitchReason) -> Self {
        match value {
            PersistedSwitchReason::Rotation => Self::Rotation,
            PersistedSwitchReason::Best => Self::Best,
            PersistedSwitchReason::Restore => Self::Restore,
            PersistedSwitchReason::Manual => Self::Manual,
        }
    }
}

impl std::fmt::Display for PersistedSwitchReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Classified 429 cause — `lib/accounts/rate-limits.ts`
/// `RateLimitReason = "quota" | "tokens" | "concurrent" | "unknown"`.
/// (The classifier `parse_rate_limit_reason` lives in the accounts crate;
/// only the enum is core vocabulary — ARCHITECTURE §4 item 4.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RateLimitReason {
    #[serde(rename = "quota")]
    Quota,
    #[serde(rename = "tokens")]
    Tokens,
    #[serde(rename = "concurrent")]
    Concurrent,
    #[serde(rename = "unknown")]
    Unknown,
}

impl RateLimitReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Quota => "quota",
            Self::Tokens => "tokens",
            Self::Concurrent => "concurrent",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "quota" => Some(Self::Quota),
            "tokens" => Some(Self::Tokens),
            "concurrent" => Some(Self::Concurrent),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

impl std::fmt::Display for RateLimitReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// ============================================================================
// RateLimitStateV3 — ordered map: quota key -> epoch-ms reset time
// ============================================================================

/// `RateLimitStateV3 = Record<string, number|undefined>` with preserved key
/// insertion order and JS object assignment semantics: setting an existing
/// key keeps its original position; new keys append. Values are epoch-ms
/// timestamps modeled as `i64` (architecture R9: epochs never gain a decimal
/// point). Deserialization requires every value to be a JSON number,
/// mirroring `z.record(z.string(), z.number().optional())` — a non-number
/// value fails the whole parse.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RateLimitStateV3 {
    entries: Vec<(String, i64)>,
}

impl RateLimitStateV3 {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<i64> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| *v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    /// JS `obj[key] = value`: replaces in place (keeping position) when the
    /// key exists, otherwise appends. Returns the previous value if any.
    pub fn insert(&mut self, key: impl Into<String>, value: i64) -> Option<i64> {
        let key = key.into();
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            let previous = entry.1;
            entry.1 = value;
            Some(previous)
        } else {
            self.entries.push((key, value));
            None
        }
    }

    /// JS `delete obj[key]`. Returns the removed value if the key existed.
    pub fn remove(&mut self, key: &str) -> Option<i64> {
        let index = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(index).1)
    }

    /// Keep only the entries for which the predicate returns `true`.
    pub fn retain(&mut self, mut predicate: impl FnMut(&str, i64) -> bool) {
        self.entries.retain(|(k, v)| predicate(k, *v));
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, i64)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), *v))
    }

    pub fn entries(&self) -> &[(String, i64)] {
        &self.entries
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

impl FromIterator<(String, i64)> for RateLimitStateV3 {
    fn from_iter<T: IntoIterator<Item = (String, i64)>>(iter: T) -> Self {
        let mut state = Self::new();
        for (key, value) in iter {
            state.insert(key, value);
        }
        state
    }
}

impl<'a> IntoIterator for &'a RateLimitStateV3 {
    type Item = &'a (String, i64);
    type IntoIter = std::slice::Iter<'a, (String, i64)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter()
    }
}

impl Serialize for RateLimitStateV3 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, value) in &self.entries {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for RateLimitStateV3 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MapVisitor;

        impl<'de> serde::de::Visitor<'de> for MapVisitor {
            type Value = RateLimitStateV3;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a map of string keys to numbers")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut access: A,
            ) -> Result<Self::Value, A::Error> {
                let mut state = RateLimitStateV3::new();
                while let Some((key, value)) = access.next_entry::<String, serde_json::Number>()? {
                    state.insert(key, number_to_i64_lossy(&value));
                }
                Ok(state)
            }
        }

        deserializer.deserialize_map(MapVisitor)
    }
}

// ============================================================================
// Workspace (#491)
// ============================================================================

/// Workspace entry within an account. Supports a single OpenAI account that
/// belongs to multiple ChatGPT workspaces, each a distinct quota pool keyed
/// by its org_id (`id`). See #491.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    pub enabled: bool,
    #[serde(
        rename = "disabledAt",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub disabled_at: Option<i64>,
    #[serde(
        rename = "isDefault",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub is_default: Option<bool>,
}

// ============================================================================
// AccountMetadataV3 / AccountStorageV3
// ============================================================================

/// Account metadata V3 — current storage format. Field order and optionality
/// mirror `AccountMetadataV3Schema` exactly (spec 01 §3.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountMetadataV3 {
    #[serde(
        rename = "accountId",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id: Option<String>,
    #[serde(
        rename = "accountIdSource",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id_source: Option<AccountIdSource>,
    #[serde(
        rename = "accountLabel",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_label: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub email: Option<String>,
    /// Required, non-empty (`z.string().min(1)`).
    #[serde(rename = "refreshToken", deserialize_with = "de_string_min1")]
    pub refresh_token: String,
    #[serde(
        rename = "accessToken",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub access_token: Option<String>,
    #[serde(
        rename = "expiresAt",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<i64>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
    /// Required, ms epoch.
    #[serde(rename = "addedAt", deserialize_with = "de_number_lenient")]
    pub added_at: i64,
    /// Required, ms epoch.
    #[serde(rename = "lastUsed", deserialize_with = "de_number_lenient")]
    pub last_used: i64,
    #[serde(
        rename = "lastSwitchReason",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_switch_reason: Option<SwitchReason>,
    #[serde(
        rename = "rateLimitResetTimes",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub rate_limit_reset_times: Option<RateLimitStateV3>,
    #[serde(
        rename = "coolingDownUntil",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub cooling_down_until: Option<i64>,
    #[serde(
        rename = "cooldownReason",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub cooldown_reason: Option<CooldownReason>,
    /// Multi-workspace support (#491): without these two fields in the
    /// schema, a strict-strip parse erases workspace tracking on every
    /// load/save round-trip.
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspaces: Option<Vec<Workspace>>,
    #[serde(
        rename = "currentWorkspaceIndex",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_workspace_index: Option<i64>,
}

impl AccountMetadataV3 {
    /// Minimal valid account (the three required fields), everything else
    /// unset.
    pub fn new(refresh_token: impl Into<String>, added_at: i64, last_used: i64) -> Self {
        Self {
            account_id: None,
            account_id_source: None,
            account_label: None,
            email: None,
            refresh_token: refresh_token.into(),
            access_token: None,
            expires_at: None,
            enabled: None,
            added_at,
            last_used,
            last_switch_reason: None,
            rate_limit_reset_times: None,
            cooling_down_until: None,
            cooldown_reason: None,
            workspaces: None,
            current_workspace_index: None,
        }
    }

    /// TS convention: `account.enabled !== false` (missing means enabled).
    pub fn is_enabled(&self) -> bool {
        self.enabled != Some(false)
    }
}

/// Per-family active index map — object schema with one optional-number key
/// per `MODEL_FAMILIES` entry (`.partial()`); unknown keys are stripped on
/// parse. Serialized key order is the family declaration order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveIndexByFamily {
    #[serde(
        rename = "gpt-5-codex",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub gpt5_codex: Option<i64>,
    #[serde(
        rename = "codex-max",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_max: Option<i64>,
    #[serde(
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub codex: Option<i64>,
    #[serde(
        rename = "gpt-5.2",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub gpt5_2: Option<i64>,
    #[serde(
        rename = "gpt-5.1",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub gpt5_1: Option<i64>,
}

impl ActiveIndexByFamily {
    pub fn get(&self, family: ModelFamily) -> Option<i64> {
        match family {
            ModelFamily::Gpt5Codex => self.gpt5_codex,
            ModelFamily::CodexMax => self.codex_max,
            ModelFamily::Codex => self.codex,
            ModelFamily::Gpt5_2 => self.gpt5_2,
            ModelFamily::Gpt5_1 => self.gpt5_1,
        }
    }

    pub fn set(&mut self, family: ModelFamily, index: Option<i64>) {
        match family {
            ModelFamily::Gpt5Codex => self.gpt5_codex = index,
            ModelFamily::CodexMax => self.codex_max = index,
            ModelFamily::Codex => self.codex = index,
            ModelFamily::Gpt5_2 => self.gpt5_2 = index,
            ModelFamily::Gpt5_1 => self.gpt5_1 = index,
        }
    }

    /// Iterate all five family slots in declaration (= serialization) order.
    pub fn iter(&self) -> impl Iterator<Item = (ModelFamily, Option<i64>)> + '_ {
        [
            (ModelFamily::Gpt5Codex, self.gpt5_codex),
            (ModelFamily::CodexMax, self.codex_max),
            (ModelFamily::Codex, self.codex),
            (ModelFamily::Gpt5_2, self.gpt5_2),
            (ModelFamily::Gpt5_1, self.gpt5_1),
        ]
        .into_iter()
    }

    pub fn is_empty(&self) -> bool {
        self.iter().all(|(_, index)| index.is_none())
    }
}

/// Account storage V3 — current storage format with per-family active
/// indices, manual pin (#474) and affinity generation counter (#474).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountStorageV3 {
    /// Literal `3`.
    pub version: Version3,
    pub accounts: Vec<AccountMetadataV3>,
    /// Required, `>= 0` (`z.number().min(0)`).
    #[serde(rename = "activeIndex", deserialize_with = "de_number_min0_lenient")]
    pub active_index: i64,
    #[serde(
        rename = "activeIndexByFamily",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub active_index_by_family: Option<ActiveIndexByFamily>,
    /// Optional int `>= 0` — manual pin (#474).
    #[serde(
        rename = "pinnedAccountIndex",
        default,
        deserialize_with = "de_opt_int_min0_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub pinned_account_index: Option<i64>,
    /// Optional int `>= 0` — monotonic counter (#474).
    #[serde(
        rename = "affinityGeneration",
        default,
        deserialize_with = "de_opt_int_min0_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub affinity_generation: Option<i64>,
}

impl AccountStorageV3 {
    /// Empty storage (`{version:3, accounts:[], activeIndex:0}`).
    pub fn empty() -> Self {
        Self {
            version: Version3::default(),
            accounts: Vec::new(),
            active_index: 0,
            active_index_by_family: None,
            pinned_account_index: None,
            affinity_generation: None,
        }
    }
}

// ============================================================================
// Legacy V1 shapes (read-only; auto-migrated by the storage crate)
// ============================================================================

/// Legacy V1 account metadata for migration support (scalar
/// `rateLimitResetTime` instead of the per-family map; no workspaces).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountMetadataV1 {
    #[serde(
        rename = "accountId",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id: Option<String>,
    #[serde(
        rename = "accountIdSource",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id_source: Option<AccountIdSource>,
    #[serde(
        rename = "accountLabel",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_label: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub email: Option<String>,
    #[serde(rename = "refreshToken", deserialize_with = "de_string_min1")]
    pub refresh_token: String,
    #[serde(
        rename = "accessToken",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub access_token: Option<String>,
    #[serde(
        rename = "expiresAt",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<i64>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
    #[serde(rename = "addedAt", deserialize_with = "de_number_lenient")]
    pub added_at: i64,
    #[serde(rename = "lastUsed", deserialize_with = "de_number_lenient")]
    pub last_used: i64,
    #[serde(
        rename = "lastSwitchReason",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_switch_reason: Option<SwitchReason>,
    /// V1 used a single scalar reset time.
    #[serde(
        rename = "rateLimitResetTime",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub rate_limit_reset_time: Option<i64>,
    #[serde(
        rename = "coolingDownUntil",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub cooling_down_until: Option<i64>,
    #[serde(
        rename = "cooldownReason",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub cooldown_reason: Option<CooldownReason>,
}

/// Legacy V1 storage format for migration support.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountStorageV1 {
    /// Literal `1`.
    pub version: Version1,
    pub accounts: Vec<AccountMetadataV1>,
    #[serde(rename = "activeIndex", deserialize_with = "de_number_min0_lenient")]
    pub active_index: i64,
}

// ============================================================================
// AnyAccountStorage — discriminated union on `version` (1 | 3)
// ============================================================================

/// Union of V1 and V3 storage formats for migration detection. Manual
/// deserializer discriminating on the `version` key: `1` → V1, `3` → V3,
/// anything else fails (zod discriminated-union semantics).
#[derive(Clone, Debug, PartialEq)]
pub enum AnyAccountStorage {
    V1(AccountStorageV1),
    V3(AccountStorageV3),
}

impl AnyAccountStorage {
    pub fn version(&self) -> u8 {
        match self {
            Self::V1(_) => 1,
            Self::V3(_) => 3,
        }
    }
}

impl Serialize for AnyAccountStorage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::V1(storage) => storage.serialize(serializer),
            Self::V3(storage) => storage.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for AnyAccountStorage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let version = value.get("version").and_then(serde_json::Value::as_f64);
        if version == Some(1.0) {
            AccountStorageV1::deserialize(value)
                .map(Self::V1)
                .map_err(serde::de::Error::custom)
        } else if version == Some(3.0) {
            AccountStorageV3::deserialize(value)
                .map(Self::V3)
                .map_err(serde::de::Error::custom)
        } else {
            Err(serde::de::Error::custom(
                "Invalid input: expected version 1 or 3",
            ))
        }
    }
}

// ============================================================================
// Tests (ported from test/schemas.test.ts account-storage suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_account() -> serde_json::Value {
        json!({
            "refreshToken": "rt_valid_token",
            "addedAt": 1700000000000i64,
            "lastUsed": 1700000000001i64,
        })
    }

    fn parse_account(value: serde_json::Value) -> Result<AccountMetadataV3, serde_json::Error> {
        serde_json::from_value(value)
    }

    #[test]
    fn accepts_minimal_valid_account() {
        let account = parse_account(valid_account()).expect("minimal account parses");
        assert_eq!(account.refresh_token, "rt_valid_token");
        assert_eq!(account.added_at, 1_700_000_000_000);
        assert!(account.is_enabled());
    }

    #[test]
    fn accepts_full_account_with_all_optional_fields() {
        let mut value = valid_account();
        let obj = value.as_object_mut().unwrap();
        obj.insert("accountId".into(), json!("acc_123"));
        obj.insert("accountIdSource".into(), json!("token"));
        obj.insert("accountLabel".into(), json!("Work Account"));
        obj.insert("email".into(), json!("test@example.com"));
        obj.insert("lastSwitchReason".into(), json!("rate-limit"));
        obj.insert(
            "rateLimitResetTimes".into(),
            json!({ "gpt-5.2-codex": 1700000060000i64 }),
        );
        obj.insert("coolingDownUntil".into(), json!(1700000030000i64));
        obj.insert("cooldownReason".into(), json!("auth-failure"));
        let account = parse_account(value).expect("full account parses");
        assert_eq!(account.account_id_source, Some(AccountIdSource::Token));
        assert_eq!(account.last_switch_reason, Some(SwitchReason::RateLimit));
        assert_eq!(account.cooldown_reason, Some(CooldownReason::AuthFailure));
        assert_eq!(
            account
                .rate_limit_reset_times
                .as_ref()
                .and_then(|m| m.get("gpt-5.2-codex")),
            Some(1_700_000_060_000)
        );
    }

    #[test]
    fn rejects_empty_refresh_token() {
        let mut value = valid_account();
        value["refreshToken"] = json!("");
        assert!(parse_account(value).is_err());
    }

    #[test]
    fn rejects_missing_refresh_token() {
        assert!(parse_account(json!({ "addedAt": 1, "lastUsed": 1 })).is_err());
    }

    #[test]
    fn rejects_invalid_account_id_source() {
        let mut value = valid_account();
        value["accountIdSource"] = json!("invalid");
        assert!(parse_account(value).is_err());
    }

    #[test]
    fn rejects_invalid_cooldown_reason() {
        let mut value = valid_account();
        value["cooldownReason"] = json!("unknown");
        assert!(parse_account(value).is_err());
    }

    #[test]
    fn preserves_workspaces_and_current_workspace_index_issue_491() {
        let mut value = valid_account();
        value["workspaces"] = json!([
            { "id": "org-AAAA", "name": "Personal Plus", "enabled": true, "isDefault": true },
            { "id": "org-BBBB", "name": "GkTech Business", "enabled": false, "disabledAt": 123 },
        ]);
        value["currentWorkspaceIndex"] = json!(1);
        let account = parse_account(value).expect("parses");
        let workspaces = account.workspaces.expect("workspaces kept");
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].name.as_deref(), Some("Personal Plus"));
        assert!(!workspaces[1].enabled);
        assert_eq!(workspaces[1].disabled_at, Some(123));
        assert_eq!(account.current_workspace_index, Some(1));
    }

    #[test]
    fn rejects_workspace_missing_its_id_issue_491() {
        let mut value = valid_account();
        value["workspaces"] = json!([{ "name": "Personal Plus", "enabled": true }]);
        assert!(parse_account(value).is_err());
    }

    #[test]
    fn accepts_valid_v3_storage() {
        let storage: AccountStorageV3 = serde_json::from_value(json!({
            "version": 3,
            "accounts": [{ "refreshToken": "rt_1", "addedAt": 1, "lastUsed": 2 }],
            "activeIndex": 0,
        }))
        .expect("valid V3 parses");
        assert_eq!(storage.accounts.len(), 1);
        assert_eq!(storage.active_index, 0);
    }

    #[test]
    fn accepts_v3_storage_with_active_index_by_family_stripping_unknown_keys() {
        // "gpt-5.2-codex" is not a model family; zod's partial object strips it.
        let storage: AccountStorageV3 = serde_json::from_value(json!({
            "version": 3,
            "accounts": [{ "refreshToken": "rt_1", "addedAt": 1, "lastUsed": 2 }],
            "activeIndex": 0,
            "activeIndexByFamily": { "gpt-5.2-codex": 0, "codex-max": 0 },
        }))
        .expect("parses");
        let by_family = storage.active_index_by_family.expect("map kept");
        assert_eq!(by_family.get(ModelFamily::CodexMax), Some(0));
        assert_eq!(by_family.get(ModelFamily::Gpt5_2), None);
    }

    #[test]
    fn accepts_empty_accounts_array() {
        let storage: AccountStorageV3 = serde_json::from_value(json!({
            "version": 3,
            "accounts": [],
            "activeIndex": 0,
        }))
        .expect("parses");
        assert!(storage.accounts.is_empty());
    }

    #[test]
    fn rejects_wrong_version() {
        let result: Result<AccountStorageV3, _> = serde_json::from_value(json!({
            "version": 2,
            "accounts": [],
            "activeIndex": 0,
        }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_negative_active_index() {
        let result: Result<AccountStorageV3, _> = serde_json::from_value(json!({
            "version": 3,
            "accounts": [],
            "activeIndex": -1,
        }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_fractional_or_negative_pinned_account_index() {
        let fractional: Result<AccountStorageV3, _> = serde_json::from_value(json!({
            "version": 3,
            "accounts": [],
            "activeIndex": 0,
            "pinnedAccountIndex": 1.5,
        }));
        assert!(fractional.is_err());
        let negative: Result<AccountStorageV3, _> = serde_json::from_value(json!({
            "version": 3,
            "accounts": [],
            "activeIndex": 0,
            "pinnedAccountIndex": -1,
        }));
        assert!(negative.is_err());
    }

    #[test]
    fn accepts_valid_v1_storage() {
        let storage: AccountStorageV1 = serde_json::from_value(json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt_1",
                "addedAt": 1,
                "lastUsed": 2,
                "rateLimitResetTime": 1700000060000i64,
            }],
            "activeIndex": 0,
        }))
        .expect("parses");
        assert_eq!(
            storage.accounts[0].rate_limit_reset_time,
            Some(1_700_000_060_000)
        );
    }

    #[test]
    fn v1_accepts_and_strips_v3_only_fields() {
        // zod strips unknown keys, so a V1 account carrying the V3
        // `rateLimitResetTimes` map still parses (test/schemas.test.ts
        // "rejects V1 with rateLimitResetTimes (V3 field)" expects success).
        let storage: AccountStorageV1 = serde_json::from_value(json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt_1",
                "addedAt": 1,
                "lastUsed": 2,
                "rateLimitResetTimes": {},
            }],
            "activeIndex": 0,
        }))
        .expect("parses despite V3-only field");
        assert_eq!(storage.accounts[0].rate_limit_reset_time, None);
    }

    #[test]
    fn any_account_storage_accepts_v1() {
        let storage: AnyAccountStorage = serde_json::from_value(json!({
            "version": 1,
            "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 1 }],
            "activeIndex": 0,
        }))
        .expect("parses");
        assert_eq!(storage.version(), 1);
    }

    #[test]
    fn any_account_storage_accepts_v3() {
        let storage: AnyAccountStorage = serde_json::from_value(json!({
            "version": 3,
            "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 1 }],
            "activeIndex": 0,
        }))
        .expect("parses");
        assert_eq!(storage.version(), 3);
    }

    #[test]
    fn any_account_storage_rejects_unknown_version() {
        let result: Result<AnyAccountStorage, _> = serde_json::from_value(json!({
            "version": 5,
            "accounts": [],
            "activeIndex": 0,
        }));
        assert!(result.is_err());
    }

    #[test]
    fn serializes_in_schema_key_order_with_none_omitted() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(AccountMetadataV3::new("rt", 1, 2));
        let compact = serde_json::to_string(&storage).unwrap();
        assert_eq!(
            compact,
            r#"{"version":3,"accounts":[{"refreshToken":"rt","addedAt":1,"lastUsed":2}],"activeIndex":0}"#
        );
    }

    #[test]
    fn serializes_optionals_in_schema_order_when_present() {
        let mut account = AccountMetadataV3::new("rt", 1, 2);
        account.account_id = Some("acc_1".into());
        account.email = Some("a@b.com".into());
        account.enabled = Some(false);
        let mut resets = RateLimitStateV3::new();
        resets.insert("gpt-5.2", 99);
        account.rate_limit_reset_times = Some(resets);
        account.cooldown_reason = Some(CooldownReason::RateLimit);
        let compact = serde_json::to_string(&account).unwrap();
        assert_eq!(
            compact,
            r#"{"accountId":"acc_1","email":"a@b.com","refreshToken":"rt","enabled":false,"addedAt":1,"lastUsed":2,"rateLimitResetTimes":{"gpt-5.2":99},"cooldownReason":"rate-limit"}"#
        );
    }

    #[test]
    fn top_level_key_order_includes_pin_and_generation_last() {
        let mut storage = AccountStorageV3::empty();
        storage.active_index_by_family = Some(ActiveIndexByFamily {
            gpt5_codex: Some(0),
            codex_max: Some(0),
            codex: Some(0),
            gpt5_2: Some(0),
            gpt5_1: Some(0),
        });
        storage.pinned_account_index = Some(0);
        storage.affinity_generation = Some(2);
        let compact = serde_json::to_string(&storage).unwrap();
        assert_eq!(
            compact,
            r#"{"version":3,"accounts":[],"activeIndex":0,"activeIndexByFamily":{"gpt-5-codex":0,"codex-max":0,"codex":0,"gpt-5.2":0,"gpt-5.1":0},"pinnedAccountIndex":0,"affinityGeneration":2}"#
        );
    }

    #[test]
    fn rate_limit_state_preserves_insertion_order_with_js_assignment_semantics() {
        let mut state = RateLimitStateV3::new();
        state.insert("gpt-5.2", 10);
        state.insert("codex", 20);
        state.insert("gpt-5-codex", 30);
        // Re-assigning an existing key keeps its position (JS object rule).
        state.insert("gpt-5.2", 11);
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"gpt-5.2":11,"codex":20,"gpt-5-codex":30}"#
        );
        state.remove("codex");
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"gpt-5.2":11,"gpt-5-codex":30}"#
        );
        // Round-trip keeps on-disk key order.
        let parsed: RateLimitStateV3 = serde_json::from_str(r#"{"b":2,"a":1}"#).expect("parses");
        assert_eq!(serde_json::to_string(&parsed).unwrap(), r#"{"b":2,"a":1}"#);
    }

    #[test]
    fn rate_limit_state_rejects_non_number_values() {
        let result: Result<RateLimitStateV3, _> = serde_json::from_str(r#"{"a":"soon"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn zod_optional_is_not_nullable_explicit_null_fails() {
        // zod `.optional()` accepts absence (undefined) but REJECTS an
        // explicit JSON null; plain serde Option would silently accept it.
        for (key, null_value) in [
            ("email", json!(null)),
            ("accountId", json!(null)),
            ("accountIdSource", json!(null)),
            ("enabled", json!(null)),
            ("expiresAt", json!(null)),
            ("lastSwitchReason", json!(null)),
            ("rateLimitResetTimes", json!(null)),
            ("coolingDownUntil", json!(null)),
            ("cooldownReason", json!(null)),
            ("workspaces", json!(null)),
            ("currentWorkspaceIndex", json!(null)),
        ] {
            let mut value = valid_account();
            value[key] = null_value;
            assert!(
                parse_account(value).is_err(),
                "{key}: null should fail the parse"
            );
        }
        let storage_null_map: Result<AccountStorageV3, _> = serde_json::from_value(json!({
            "version": 3,
            "accounts": [],
            "activeIndex": 0,
            "activeIndexByFamily": null,
        }));
        assert!(storage_null_map.is_err());
        let pin_null: Result<AccountStorageV3, _> = serde_json::from_value(json!({
            "version": 3,
            "accounts": [],
            "activeIndex": 0,
            "pinnedAccountIndex": null,
        }));
        assert!(pin_null.is_err());
    }

    #[test]
    fn enum_string_conversions() {
        assert_eq!(SwitchReason::parse("rotation"), Some(SwitchReason::Rotation));
        assert_eq!(SwitchReason::parse("bogus"), None);
        assert_eq!(
            SwitchReason::from(PersistedSwitchReason::Best),
            SwitchReason::Best
        );
        assert_eq!(PersistedSwitchReason::parse("rate-limit"), None);
        assert_eq!(RateLimitReason::parse("quota"), Some(RateLimitReason::Quota));
        assert_eq!(
            AccountIdSource::parse("id_token"),
            Some(AccountIdSource::IdToken)
        );
        assert_eq!(CooldownReason::RateLimit.as_str(), "rate-limit");
        assert_eq!(SwitchReason::RateLimit.to_string(), "rate-limit");
    }
}
