//! Port of `lib/accounts.ts` — CORE STATE half of `AccountManager`:
//! `ManagedAccount`, construction/hydration, account CRUD, tracker/circuit
//! keys, removal bookkeeping, `updateFromAuth`, `commitRefreshedAuth`, and
//! workspace rotation (#491).
//!
//! Behavior source: spec 03 §1 (+ gotchas). TS source is authoritative.
//!
//! File split within the crate (ARCHITECTURE §6.9): the selection half
//! (round-robin / sequential / hybrid pickers, availability checks,
//! min-wait) lives in `manager_selection.rs`; the
//! persistence half (`build_storage_snapshot`, `reconcile_tokens_from_disk`,
//! `save_to_disk*`, `mark_rate_limited_with_reason`, cooldown bookkeeping,
//! formatters) lives in `manager_persistence.rs`. Both add `impl` blocks to
//! the types defined HERE; struct fields are `pub(crate)` for that reason.
//!
//! Never-persist boundary (ARCHITECTURE §8.4): [`ManagedAccount`] wraps the
//! serde [`AccountMetadataV3`] plus a NON-serde [`RuntimeAccountState`]
//! (`lastRateLimitReason`, `consecutiveAuthFailures`, cached tracker/circuit
//! keys). `ManagedAccount` itself derives NO `Serialize`; the persistence
//! half's `build_storage_snapshot` is the only bridge to disk. For TS-shaped
//! ergonomics `ManagedAccount` derefs to its `meta` (so `account.email`,
//! `account.enabled`, `account.last_used` … resolve to the persisted-shape
//! fields), and the always-present in-memory rate-limit map lives as a
//! DIRECT field (`rate_limit_reset_times`) — its `meta` slot stays `None`
//! in memory and is populated only by the snapshot builder.

use std::collections::BTreeSet;
use std::error::Error as StdError;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use cma_core::constants::ERROR_MESSAGES;
use cma_core::errors::CodexError;
use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::model_family::{MODEL_FAMILIES, ModelFamily};
use cma_core::schemas::account_storage::{
    AccountIdSource, AccountMetadataV3, AccountStorageV3, RateLimitReason, RateLimitStateV3,
    SwitchReason, Workspace,
};
use cma_core::token_utils::{
    extract_account_email, extract_account_id, sanitize_email, should_update_account_id_from_token,
};
use cma_core::types::OAuthAuthDetails;
use cma_core::utils::now_ms;

use cma_cli_mirror::state::{CodexCliTokenCacheEntry, load_codex_cli_state};
use cma_cli_mirror::sync::sync_account_storage_from_codex_cli;
use cma_cli_mirror::writer::{ActiveSelection, set_codex_cli_active_selection};

use cma_rotation::circuit_breaker::{remove_circuit_breaker, reset_all_circuit_breakers};
use cma_rotation::routing_mutex::RoutingMutexMode;
use cma_rotation::trackers::{TrackerKey, get_health_tracker, get_token_tracker, reset_trackers};

use cma_storage::identity::{
    AccountIdentityLike, RuntimeAccountIdentityKey, get_account_identity_key,
    get_runtime_account_identity_key,
};
use cma_storage::load::load_accounts;
use cma_storage::match_utils::AccountRecency;
use cma_storage::matching::{AccountMatchOptions, find_matching_account_index};
use cma_storage::path_state::{StoragePathState, get_storage_path_state};
use cma_storage::save_retry::save_accounts_with_retry;
use cma_storage::transactions::with_account_storage_transaction;

use crate::rate_limits::{RateLimitedEntity, clamp_non_negative_int_i64};

fn accounts_log() -> ScopedLogger {
    create_logger("accounts")
}

/// TS module-global `nextRuntimeCircuitKeyId` (process-wide counter used for
/// the `circuit:<n>` fallback when an account has no identity key).
static NEXT_RUNTIME_CIRCUIT_KEY_ID: AtomicU64 = AtomicU64::new(0);

// ============================================================================
// ManagedAccount — AccountMetadataV3 + runtime-only (never-persisted) state
// ============================================================================

/// Runtime-only per-account state (spec 03 gotcha 2 / ARCHITECTURE §8.4).
/// NEVER serialized: this struct has no `Serialize` impl, and the snapshot
/// builder in `manager_persistence.rs` never reads these fields into the
/// persisted shape.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RuntimeAccountState {
    /// TS `lastRateLimitReason?: RateLimitReason` — runtime-only.
    pub last_rate_limit_reason: Option<RateLimitReason>,
    /// TS `consecutiveAuthFailures?: number` — runtime-only. `None` means
    /// "never tracked"; `clearAuthFailures` sets `Some(0)` (NOT `None` —
    /// the TS assign-0-vs-delete asymmetry, gotcha 13).
    pub consecutive_auth_failures: Option<u32>,
    /// TS `_runtimeTrackerKey?: string | number` — sticky cached tracker key
    /// (see [`get_runtime_tracker_key`]).
    pub runtime_tracker_key: Option<TrackerKey>,
    /// TS `circuitKeyId?: string` — sticky cached circuit-breaker key.
    pub circuit_key_id: Option<String>,
}

/// TS `interface ManagedAccount` — one account in the in-memory pool.
///
/// `meta` carries the persisted fields (TS `access`/`expires` map to
/// `meta.access_token`/`meta.expires_at`) and is reachable directly via
/// `Deref`, so `account.email` / `account.enabled` / `account.last_used`
/// read (and, through `DerefMut`, write) the `meta` fields with TS-shaped
/// syntax. In-memory invariants that differ from the disk shape:
/// - `meta.enabled` is always `Some(true)`/`Some(false)` after construction
///   (TS stores a literal boolean in memory; on disk it is `false`-or-omitted).
/// - the ALWAYS-PRESENT in-memory rate-limit map is the direct
///   [`Self::rate_limit_reset_times`] field (TS required field);
///   `meta.rate_limit_reset_times` stays `None` in memory (dormant slot —
///   only `build_storage_snapshot` writes the non-empty map into the
///   persisted shape).
#[derive(Clone, Debug, PartialEq)]
pub struct ManagedAccount {
    /// Position bookkeeping: set from the STORED array position at
    /// construction (skipped blank-refresh rows leave gaps until the first
    /// `remove_account*` reindex — spec 03 gotcha 14), rewritten to the array
    /// position on every removal.
    pub index: usize,
    /// In-memory rate-limit windows (`{quotaKey: epochMs}`) — TS required
    /// field. Shadows the dormant `meta.rate_limit_reset_times` slot.
    pub rate_limit_reset_times: RateLimitStateV3,
    /// The persisted account shape (serde struct from `cma-core`), exposed
    /// through `Deref`/`DerefMut`.
    pub meta: AccountMetadataV3,
    /// Runtime-only state — never serialized.
    pub runtime: RuntimeAccountState,
}

impl std::ops::Deref for ManagedAccount {
    type Target = AccountMetadataV3;
    fn deref(&self) -> &AccountMetadataV3 {
        &self.meta
    }
}

impl std::ops::DerefMut for ManagedAccount {
    fn deref_mut(&mut self) -> &mut AccountMetadataV3 {
        &mut self.meta
    }
}

impl ManagedAccount {
    /// TS convention `account.enabled !== false`.
    pub fn is_enabled(&self) -> bool {
        self.meta.enabled != Some(false)
    }

    /// TS `updateFromAuth(account, auth)` — adopt the refreshed token triple;
    /// accountId only follows the token when
    /// [`should_update_account_id_from_token`] allows (org/manual selections
    /// stay stable); email keeps the old value when extraction fails.
    pub fn update_from_auth(&mut self, auth: &OAuthAuthDetails) {
        self.meta.refresh_token = auth.refresh.clone();
        self.meta.access_token = Some(auth.access.clone());
        self.meta.expires_at = Some(auth.expires);
        let token_account_id = trim_to_non_empty(extract_account_id(Some(auth.access.as_str())));
        if let Some(token_account_id) = token_account_id
            && should_update_account_id_from_token(
                self.meta.account_id_source.as_ref(),
                self.meta.account_id.as_deref(),
            )
        {
            self.meta.account_id = Some(token_account_id);
            self.meta.account_id_source = Some(AccountIdSource::Token);
        }
        if let Some(email) =
            sanitize_email(extract_account_email(Some(auth.access.as_str()), None).as_deref())
        {
            self.meta.email = Some(email);
        }
    }

    // NOTE: `is_cooling_down` / `clear_cooldown` (TS `isAccountCoolingDown` /
    // `clearAccountCooldown`) live in `manager_persistence.rs` (cooldown
    // bookkeeping is the persistence half's row).

    /// TS `incrementAuthFailures(account)` — returns the new count.
    pub fn increment_auth_failures(&mut self) -> u32 {
        let next = self.runtime.consecutive_auth_failures.unwrap_or(0) + 1;
        self.runtime.consecutive_auth_failures = Some(next);
        next
    }

    /// TS `clearAuthFailures(account)` — sets `0` (does NOT delete).
    pub fn clear_auth_failures(&mut self) {
        self.runtime.consecutive_auth_failures = Some(0);
    }

    // -- Workspace management (#491) -----------------------------------------

    /// TS private `resetWorkspaces` — re-enable every workspace and point the
    /// cursor at the default workspace (or index 0 when none is flagged).
    pub(crate) fn reset_workspaces(&mut self) {
        let Some(workspaces) = self.meta.workspaces.as_mut() else {
            return;
        };
        if workspaces.is_empty() {
            return;
        }
        let reset_index = workspaces
            .iter()
            .position(|workspace| workspace.is_default == Some(true));
        for workspace in workspaces.iter_mut() {
            workspace.enabled = true;
            workspace.disabled_at = None;
        }
        self.meta.current_workspace_index = Some(reset_index.unwrap_or(0) as i64);
    }

    /// TS `getCurrentWorkspace(account)` — `workspaces[currentWorkspaceIndex
    /// ?? 0] ?? null`; `None` when no workspaces are tracked.
    pub fn get_current_workspace(&self) -> Option<&Workspace> {
        let workspaces = self.meta.workspaces.as_ref()?;
        if workspaces.is_empty() {
            return None;
        }
        let idx = self.meta.current_workspace_index.unwrap_or(0);
        usize::try_from(idx).ok().and_then(|idx| workspaces.get(idx))
    }

    /// TS `disableCurrentWorkspace(account, expectedWorkspaceId?)` — CAS
    /// guard on the workspace id; false when already disabled (gotcha 28).
    pub fn disable_current_workspace(&mut self, expected_workspace_id: Option<&str>) -> bool {
        let Some(workspaces) = self.meta.workspaces.as_mut() else {
            return false;
        };
        if workspaces.is_empty() {
            return false;
        }
        let idx = self.meta.current_workspace_index.unwrap_or(0);
        let Ok(idx) = usize::try_from(idx) else {
            return false;
        };
        if idx >= workspaces.len() {
            return false;
        }
        let Some(workspace) = workspaces.get_mut(idx) else {
            return false;
        };
        if let Some(expected) = expected_workspace_id
            && workspace.id != expected
        {
            return false;
        }
        if !workspace.enabled {
            return false;
        }
        workspace.enabled = false;
        workspace.disabled_at = Some(now_ms());
        true
    }

    /// TS `rotateToNextWorkspace(account)` — scans SUCCESSORS only (the
    /// current slot is never re-selected, gotcha 28); first enabled successor
    /// becomes current and is returned.
    pub fn rotate_to_next_workspace(&mut self) -> Option<&Workspace> {
        let total = self.meta.workspaces.as_ref().map_or(0, Vec::len) as i64;
        if total == 0 {
            return None;
        }
        let current_idx = self.meta.current_workspace_index.unwrap_or(0);
        for i in 1..total {
            // JS `%` keeps sign; a negative currentWorkspaceIndex simply
            // never resolves to a workspace (same skip behavior as TS).
            let next_idx = (current_idx + i) % total;
            let Ok(next) = usize::try_from(next_idx) else {
                continue;
            };
            let enabled = self
                .meta
                .workspaces
                .as_ref()
                .and_then(|workspaces| workspaces.get(next))
                .is_some_and(|workspace| workspace.enabled);
            if enabled {
                self.meta.current_workspace_index = Some(next_idx);
                return self
                    .meta
                    .workspaces
                    .as_ref()
                    .and_then(|workspaces| workspaces.get(next));
            }
        }
        None
    }

    /// TS `hasEnabledWorkspaces(account)` — TRUE for accounts with NO
    /// tracked workspaces (legacy implicit single workspace, gotcha 27).
    pub fn has_enabled_workspaces(&self) -> bool {
        match self.meta.workspaces.as_ref() {
            None => true,
            Some(workspaces) if workspaces.is_empty() => true,
            Some(workspaces) => workspaces.iter().any(|workspace| workspace.enabled),
        }
    }

    /// TS `getWorkspaceCount(account)`.
    pub fn get_workspace_count(&self) -> usize {
        self.meta.workspaces.as_ref().map_or(0, Vec::len)
    }

    /// TS `getEnabledWorkspaceCount(account)` — 0 when no `workspaces` field
    /// (asymmetric with [`Self::has_enabled_workspaces`], gotcha 27).
    pub fn get_enabled_workspace_count(&self) -> usize {
        self.meta.workspaces.as_ref().map_or(0, |workspaces| {
            workspaces
                .iter()
                .filter(|workspace| workspace.enabled)
                .count()
        })
    }
}

impl AccountIdentityLike for ManagedAccount {
    fn identity_account_id(&self) -> Option<&str> {
        self.meta.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.meta.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        Some(self.meta.refresh_token.as_str())
    }
}

impl AccountRecency for ManagedAccount {
    fn recency_last_used(&self) -> i64 {
        self.meta.last_used
    }
    fn recency_added_at(&self) -> i64 {
        self.meta.added_at
    }
}

impl RateLimitedEntity for ManagedAccount {
    fn rate_limit_reset_times(&self) -> &RateLimitStateV3 {
        &self.rate_limit_reset_times
    }
    fn rate_limit_reset_times_mut(&mut self) -> &mut RateLimitStateV3 {
        &mut self.rate_limit_reset_times
    }
}

// ============================================================================
// Tracker / circuit keys
// ============================================================================

/// TS exported `getRuntimeTrackerKey(account)` — sticky cache on
/// `_runtimeTrackerKey`: `getRuntimeAccountIdentityKey(account) ??
/// account.index`. Once cached the key deliberately does NOT change when the
/// account later gains accountId/email (`updateFromAuth` enrichment) — only
/// `remove_account*` invalidates NUMERIC cached keys (gotcha 5).
pub fn get_runtime_tracker_key(account: &mut ManagedAccount) -> TrackerKey {
    if let Some(key) = account.runtime.runtime_tracker_key.as_ref() {
        return key.clone();
    }
    let key = match get_runtime_account_identity_key(
        account.meta.account_id.as_deref(),
        account.meta.email.as_deref(),
        Some(account.index as i64),
    ) {
        Some(RuntimeAccountIdentityKey::Key(key)) => TrackerKey::Text(key),
        Some(RuntimeAccountIdentityKey::Index(index)) => TrackerKey::Number(index),
        None => TrackerKey::Number(account.index as i64),
    };
    account.runtime.runtime_tracker_key = Some(key.clone());
    key
}

/// TS private `getAccountCircuitKey(account)` — sticky cache on
/// `circuitKeyId`: `getAccountIdentityKey(account) ?? "circuit:<n++>"`.
/// (An empty cached string is falsy in TS and recomputed.)
pub(crate) fn get_account_circuit_key(account: &mut ManagedAccount) -> String {
    if let Some(key) = account.runtime.circuit_key_id.as_ref()
        && !key.is_empty()
    {
        return key.clone();
    }
    let key = get_account_identity_key(account).unwrap_or_else(|| {
        format!(
            "circuit:{}",
            NEXT_RUNTIME_CIRCUIT_KEY_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    account.runtime.circuit_key_id = Some(key.clone());
    key
}

// ============================================================================
// Identity candidates
// ============================================================================

/// TS `AccountIdentityCandidate` — the `{accountId?, email?, refreshToken,
/// index?}` shape passed to identity lookups (`getAccountByIdentity`,
/// `commitRefreshedAuth` source).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountIdentityCandidate {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub refresh_token: Option<String>,
    pub index: Option<i64>,
}

impl AccountIdentityLike for AccountIdentityCandidate {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }
}

/// TS `getAuthIdentityCandidate(auth)`.
fn get_auth_identity_candidate(auth: Option<&OAuthAuthDetails>) -> AccountIdentityCandidate {
    let access = auth.map(|auth| auth.access.as_str());
    AccountIdentityCandidate {
        account_id: trim_to_non_empty(extract_account_id(access)),
        email: sanitize_email(extract_account_email(access, None).as_deref()),
        refresh_token: auth.map(|auth| auth.refresh.clone()),
        index: None,
    }
}

/// TS `buildAccountIdentityCandidates(source, auth?)` — up to 4 deduped
/// candidates in this EXACT order (dedup key `"{id}|{email}|{refresh}"`).
fn build_account_identity_candidates(
    source: &AccountIdentityCandidate,
    auth: Option<&OAuthAuthDetails>,
) -> Vec<AccountIdentityCandidate> {
    let derived = get_auth_identity_candidate(auth);
    let mut candidates: Vec<AccountIdentityCandidate> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    let mut push_candidate = |candidate: AccountIdentityCandidate| {
        let key = format!(
            "{}|{}|{}",
            candidate.account_id.as_deref().unwrap_or(""),
            candidate.email.as_deref().unwrap_or(""),
            candidate.refresh_token.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            candidates.push(candidate);
        }
    };

    push_candidate(source.clone());
    push_candidate(AccountIdentityCandidate {
        account_id: source.account_id.clone().or_else(|| derived.account_id.clone()),
        email: source.email.clone().or_else(|| derived.email.clone()),
        refresh_token: source.refresh_token.clone(),
        index: source.index,
    });
    push_candidate(AccountIdentityCandidate {
        account_id: derived.account_id.clone().or_else(|| source.account_id.clone()),
        email: derived.email.clone().or_else(|| source.email.clone()),
        refresh_token: source.refresh_token.clone(),
        index: source.index,
    });
    push_candidate(AccountIdentityCandidate {
        account_id: derived.account_id.clone().or_else(|| source.account_id.clone()),
        email: derived.email.clone().or_else(|| source.email.clone()),
        refresh_token: derived
            .refresh_token
            .clone()
            .or_else(|| source.refresh_token.clone()),
        index: source.index,
    });

    candidates
}

/// TS `findAccountIndexByIdentity(accounts, source, auth?)` — first candidate
/// (in order) that `findMatchingAccountIndex` resolves wins; always uses
/// `allowUniqueAccountIdFallbackWithoutEmail: true`.
pub(crate) fn find_account_index_by_identity<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    source: &AccountIdentityCandidate,
    auth: Option<&OAuthAuthDetails>,
) -> Option<usize> {
    for candidate in build_account_identity_candidates(source, auth) {
        let match_index = find_matching_account_index(
            accounts,
            &candidate,
            AccountMatchOptions {
                allow_unique_account_id_fallback_without_email: true,
            },
        );
        if match_index.is_some() {
            return match_index;
        }
    }
    None
}

/// TS `isRetryableAuthPersistenceError(error)` — code ∈ {EAGAIN, EBUSY,
/// EPERM} (uppercased), HTTP status 429, or the same recursively on the
/// cause chain.
pub(crate) fn is_retryable_auth_persistence_error(error: &(dyn StdError + 'static)) -> bool {
    let mut current: Option<&(dyn StdError + 'static)> = Some(error);
    // Depth cap stands in for the TS `cause !== error` self-reference guard.
    let mut depth = 0;
    while let Some(err) = current {
        if depth > 32 {
            return false;
        }
        if let Some(codex) = err.downcast_ref::<CodexError>() {
            let code = codex.code().to_uppercase();
            if matches!(code.as_str(), "EAGAIN" | "EBUSY" | "EPERM") {
                return true;
            }
            if codex.status() == Some(429) {
                return true;
            }
        }
        if let Some(io_error) = err.downcast_ref::<std::io::Error>()
            && let Some(code) = cma_core::fs_retry::code_of(io_error)
            && matches!(code, "EAGAIN" | "EBUSY" | "EPERM")
        {
            return true;
        }
        current = err.source();
        depth += 1;
    }
    false
}

/// `extractAccountId(...)?.trim() || undefined`.
fn trim_to_non_empty(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

// ============================================================================
// Per-family state map
// ============================================================================

/// TS `initFamilyState(defaultValue)` — `Record<ModelFamily, number>` with an
/// entry for every model family (always fully populated, so `get` returns a
/// plain `i64`). (Debounced-save state is NOT declared on the manager: the
/// persistence half implements the TS debounce surface on its
/// `SharedAccountManager` wrapper.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FamilyStateMap {
    values: [i64; 5],
}

impl FamilyStateMap {
    pub fn new(default_value: i64) -> Self {
        Self {
            values: [default_value; 5],
        }
    }

    const fn slot(family: ModelFamily) -> usize {
        match family {
            ModelFamily::Gpt5Codex => 0,
            ModelFamily::CodexMax => 1,
            ModelFamily::Codex => 2,
            ModelFamily::Gpt5_2 => 3,
            ModelFamily::Gpt5_1 => 4,
        }
    }

    pub fn get(&self, family: ModelFamily) -> i64 {
        self.values[Self::slot(family)]
    }

    pub fn set(&mut self, family: ModelFamily, value: i64) {
        self.values[Self::slot(family)] = value;
    }
}

// ============================================================================
// AccountManager
// ============================================================================

/// Internal identity-row shape used for fallback matching in the constructor
/// (TS `storedIdentityRows`; recency fields are absent in TS ⇒ 0 here).
struct StoredIdentityRow {
    index: usize,
    account_id: Option<String>,
    email: Option<String>,
    refresh_token: String,
}

impl AccountIdentityLike for StoredIdentityRow {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        Some(self.refresh_token.as_str())
    }
}

impl AccountRecency for StoredIdentityRow {
    fn recency_last_used(&self) -> i64 {
        0
    }
    fn recency_added_at(&self) -> i64 {
        0
    }
}

/// TS `class AccountManager` — the in-memory account pool.
///
/// Fields are `pub(crate)` so the selection/persistence halves (sibling
/// modules of this crate) can add `impl` blocks; outside the crate only the
/// methods are visible.
pub struct AccountManager {
    pub(crate) accounts: Vec<ManagedAccount>,
    /// Round-robin scan start per family (init 0; always fully populated).
    pub(crate) cursor_by_family: FamilyStateMap,
    /// Active pointer per family (init -1; always fully populated).
    pub(crate) current_account_index_by_family: FamilyStateMap,
    pub(crate) last_toast_account_index: i64,
    pub(crate) last_toast_time: i64,
    /// Shallow copy of the ambient storage-path state captured at
    /// construction; `save_to_disk` re-enters it so a project-scoped manager
    /// keeps writing to its project-scoped file (spec 03 §14).
    pub(crate) storage_path_state: StoragePathState,
    /// Manual pin (#474) — hydrated from disk; NO mutators on the pool.
    pub(crate) pinned_account_index: Option<i64>,
    /// Affinity generation (#474) — same hydration path; 0 when absent.
    pub(crate) affinity_generation: i64,
    /// PR-N / R4 routing-mutex mode (default `legacy`).
    pub(crate) routing_mutex_mode: RoutingMutexMode,
}

impl AccountManager {
    /// TS `constructor(authFallback?, stored?)`.
    pub fn new(
        auth_fallback: Option<&OAuthAuthDetails>,
        stored: Option<&AccountStorageV3>,
    ) -> Self {
        let storage_path_state = get_storage_path_state();
        let fallback_account_id = trim_to_non_empty(extract_account_id(
            auth_fallback.map(|auth| auth.access.as_str()),
        ));
        let fallback_account_email = sanitize_email(
            extract_account_email(auth_fallback.map(|auth| auth.access.as_str()), None).as_deref(),
        );

        // Hydrate pin/gen from the stored snapshot (validation beyond the
        // schema's non-negative-int guarantees: range check for the pin).
        let affinity_generation = stored
            .and_then(|stored| stored.affinity_generation)
            .filter(|generation| *generation >= 0)
            .unwrap_or(0);
        let account_count = stored.map_or(0, |stored| stored.accounts.len());
        let pinned_account_index = stored
            .and_then(|stored| stored.pinned_account_index)
            .filter(|pin| *pin >= 0 && (*pin as usize) < account_count);

        let mut manager = AccountManager {
            accounts: Vec::new(),
            cursor_by_family: FamilyStateMap::new(0),
            current_account_index_by_family: FamilyStateMap::new(-1),
            last_toast_account_index: -1,
            last_toast_time: 0,
            storage_path_state,
            pinned_account_index,
            affinity_generation,
            routing_mutex_mode: RoutingMutexMode::Legacy,
        };

        if let Some(stored) = stored
            && !stored.accounts.is_empty()
        {
            let stored_identity_rows: Vec<StoredIdentityRow> = stored
                .accounts
                .iter()
                .enumerate()
                .filter(|(_, account)| !account.refresh_token.trim().is_empty())
                .map(|(index, account)| StoredIdentityRow {
                    index,
                    account_id: account.account_id.clone(),
                    email: account.email.clone(),
                    refresh_token: account.refresh_token.clone(),
                })
                .collect();

            let fallback_matched_row_index: Option<usize> = match auth_fallback {
                Some(auth) if !stored_identity_rows.is_empty() => find_matching_account_index(
                    &stored_identity_rows,
                    &AccountIdentityCandidate {
                        account_id: fallback_account_id.clone(),
                        email: fallback_account_email.clone(),
                        refresh_token: Some(auth.refresh.clone()),
                        index: None,
                    },
                    AccountMatchOptions {
                        allow_unique_account_id_fallback_without_email: true,
                    },
                )
                .map(|row| stored_identity_rows[row].index),
                _ => None,
            };

            let base_now = now_ms();
            for (index, account) in stored.accounts.iter().enumerate() {
                if account.refresh_token.trim().is_empty() {
                    // Skipped rows keep their ORIGINAL stored positions in the
                    // surviving accounts' `index` fields (gotcha 14).
                    continue;
                }
                let matches_fallback =
                    auth_fallback.is_some() && fallback_matched_row_index == Some(index);
                let meta = AccountMetadataV3 {
                    account_id: if matches_fallback {
                        fallback_account_id
                            .clone()
                            .or_else(|| account.account_id.clone())
                    } else {
                        account.account_id.clone()
                    },
                    account_id_source: account.account_id_source,
                    account_label: account.account_label.clone(),
                    email: if matches_fallback {
                        fallback_account_email
                            .clone()
                            .or_else(|| sanitize_email(account.email.as_deref()))
                    } else {
                        sanitize_email(account.email.as_deref())
                    },
                    refresh_token: match (matches_fallback, auth_fallback) {
                        (true, Some(auth)) => auth.refresh.clone(),
                        _ => account.refresh_token.clone(),
                    },
                    access_token: match (matches_fallback, auth_fallback) {
                        (true, Some(auth)) => Some(auth.access.clone()),
                        _ => account.access_token.clone(),
                    },
                    expires_at: match (matches_fallback, auth_fallback) {
                        (true, Some(auth)) => Some(auth.expires),
                        _ => account.expires_at,
                    },
                    enabled: Some(account.is_enabled()),
                    added_at: clamp_non_negative_int_i64(Some(account.added_at), base_now),
                    last_used: clamp_non_negative_int_i64(Some(account.last_used), 0),
                    last_switch_reason: account.last_switch_reason,
                    // Dormant in memory — the live map is the DIRECT field.
                    rate_limit_reset_times: None,
                    cooling_down_until: account.cooling_down_until,
                    cooldown_reason: account.cooldown_reason,
                    workspaces: account.workspaces.clone(),
                    current_workspace_index: account.current_workspace_index,
                };
                manager.accounts.push(ManagedAccount {
                    index,
                    rate_limit_reset_times: account
                        .rate_limit_reset_times
                        .clone()
                        .unwrap_or_default(),
                    meta,
                    runtime: RuntimeAccountState::default(),
                });
            }

            let has_matching_fallback =
                auth_fallback.is_some() && fallback_matched_row_index.is_some();

            if let Some(auth) = auth_fallback
                && !has_matching_fallback
            {
                let now = now_ms();
                let index = manager.accounts.len();
                let mut meta = AccountMetadataV3::new(auth.refresh.clone(), now, now);
                meta.account_id = fallback_account_id.clone();
                meta.account_id_source = fallback_account_id
                    .is_some()
                    .then_some(AccountIdSource::Token);
                meta.email = fallback_account_email.clone();
                meta.enabled = Some(true);
                meta.access_token = Some(auth.access.clone());
                meta.expires_at = Some(auth.expires);
                meta.last_switch_reason = Some(SwitchReason::Initial);
                manager.accounts.push(ManagedAccount {
                    index,
                    rate_limit_reset_times: RateLimitStateV3::new(),
                    meta,
                    runtime: RuntimeAccountState::default(),
                });
            }

            if !manager.accounts.is_empty() {
                let len = manager.accounts.len() as i64;
                let default_index = clamp_non_negative_int_i64(Some(stored.active_index), 0) % len;
                for family in MODEL_FAMILIES {
                    let raw = stored
                        .active_index_by_family
                        .as_ref()
                        .and_then(|map| map.get(family));
                    let next_index = clamp_non_negative_int_i64(raw, default_index) % len;
                    manager
                        .current_account_index_by_family
                        .set(family, next_index);
                    manager.cursor_by_family.set(family, next_index);
                }
            }
            return manager;
        }

        if let Some(auth) = auth_fallback {
            let now = now_ms();
            let mut meta = AccountMetadataV3::new(auth.refresh.clone(), now, 0);
            meta.account_id = fallback_account_id.clone();
            meta.account_id_source = fallback_account_id
                .is_some()
                .then_some(AccountIdSource::Token);
            meta.email = fallback_account_email;
            meta.enabled = Some(true);
            meta.access_token = Some(auth.access.clone());
            meta.expires_at = Some(auth.expires);
            meta.last_switch_reason = Some(SwitchReason::Initial);
            manager.accounts.push(ManagedAccount {
                index: 0,
                rate_limit_reset_times: RateLimitStateV3::new(),
                meta,
                runtime: RuntimeAccountState::default(),
            });
            for family in MODEL_FAMILIES {
                manager.current_account_index_by_family.set(family, 0);
                manager.cursor_by_family.set(family, 0);
            }
        }

        manager
    }

    /// TS `static loadFromDisk(authFallback?)` — load storage, run the Codex
    /// CLI reconcile, best-effort persist a changed source-of-truth, build
    /// the pool, then hydrate token gaps from the CLI cache.
    pub async fn load_from_disk(auth_fallback: Option<&OAuthAuthDetails>) -> AccountManager {
        let stored = load_accounts().await.map(|loaded| loaded.storage);
        let synced = sync_account_storage_from_codex_cli(stored.as_ref()).await;
        let changed = synced.changed;
        let source_of_truth = synced.storage.or(stored);
        if changed
            && let Some(storage) = source_of_truth.as_ref()
            && let Err(error) = save_accounts_with_retry(storage).await
        {
            accounts_log().debug(
                "Failed to persist Codex CLI source-of-truth sync",
                Some(&json!({ "error": error.to_string() })),
            );
        }

        let mut manager = AccountManager::new(auth_fallback, source_of_truth.as_ref());
        manager.hydrate_from_codex_cli().await;
        manager
    }

    /// TS `hasRefreshToken(refreshToken)` — exact string equality.
    pub fn has_refresh_token(&self, refresh_token: &str) -> bool {
        self.accounts
            .iter()
            .any(|account| account.meta.refresh_token == refresh_token)
    }

    /// TS private `hydrateFromCodexCli()` — merge the official Codex CLI
    /// token cache into accounts whose access token is missing or expired.
    /// Never overwrites a live token; best-effort persists on change.
    async fn hydrate_from_codex_cli(&mut self) {
        let Some(state) = load_codex_cli_state(false).await else {
            return;
        };
        if state.accounts.is_empty() {
            return;
        }

        let mut cache: Vec<(String, CodexCliTokenCacheEntry)> = Vec::new();
        for snapshot in &state.accounts {
            let Some(email) = sanitize_email(snapshot.email.as_deref()) else {
                continue;
            };
            if snapshot.access_token.is_empty() {
                continue;
            }
            let entry = CodexCliTokenCacheEntry {
                access_token: snapshot.access_token.clone(),
                expires_at: snapshot.expires_at,
                refresh_token: snapshot.refresh_token.clone(),
                account_id: snapshot.account_id.clone(),
            };
            // JS Map#set semantics: last write for a duplicate email wins.
            if let Some(existing) = cache.iter_mut().find(|(key, _)| *key == email) {
                existing.1 = entry;
            } else {
                cache.push((email, entry));
            }
        }
        if cache.is_empty() {
            return;
        }

        let now = now_ms();
        let mut changed = false;

        for account in &mut self.accounts {
            let Some(email) = sanitize_email(account.meta.email.as_deref()) else {
                continue;
            };
            let Some((_, cached)) = cache.iter().find(|(key, _)| *key == email) else {
                continue;
            };

            if let Some(expires_at) = cached.expires_at
                && expires_at <= now as f64
            {
                continue;
            }

            let missing_or_expired = account
                .meta
                .access_token
                .as_deref()
                .is_none_or(str::is_empty)
                || account.meta.expires_at.is_none_or(|expires| expires <= now);
            if missing_or_expired {
                account.meta.access_token = Some(cached.access_token.clone());
                if let Some(expires_at) = cached.expires_at {
                    account.meta.expires_at = Some(expires_at as i64);
                }
                changed = true;
            }

            if account.meta.account_id.as_deref().is_none_or(str::is_empty)
                && cached.account_id.as_deref().is_some_and(|id| !id.is_empty())
                && should_update_account_id_from_token(
                    account.meta.account_id_source.as_ref(),
                    account.meta.account_id.as_deref(),
                )
            {
                account.meta.account_id = cached.account_id.clone();
                account.meta.account_id_source =
                    Some(account.meta.account_id_source.unwrap_or(AccountIdSource::Token));
                changed = true;
            }
        }

        if !changed {
            return;
        }

        if let Err(error) = self.save_to_disk().await {
            accounts_log().debug(
                "Failed to persist Codex CLI cache hydration",
                Some(&json!({ "error": error.to_string() })),
            );
        }
    }

    /// TS `getAccountCount()`.
    pub fn get_account_count(&self) -> usize {
        self.accounts.len()
    }

    /// TS `getActiveIndex()` = `getActiveIndexForFamily("codex")`.
    pub fn get_active_index(&self) -> i64 {
        self.get_active_index_for_family(ModelFamily::Codex)
    }

    /// TS `getActiveIndexForFamily(family)` — ROUTABLE index contract
    /// (AUDIT-H10 / oracle F1): `-1` on empty pool; out-of-range pointer
    /// clamps to 0; disabled slots are walked past; `-1` when every account
    /// is disabled.
    pub fn get_active_index_for_family(&self, family: ModelFamily) -> i64 {
        if self.accounts.is_empty() {
            return -1;
        }
        let index = self.current_account_index_by_family.get(family);
        let len = self.accounts.len() as i64;
        let clamped = if index < 0 || index >= len { 0 } else { index };
        if self.accounts[clamped as usize].is_enabled() {
            return clamped;
        }
        for step in 1..len {
            let candidate = (clamped + step) % len;
            if self.accounts[candidate as usize].is_enabled() {
                return candidate;
            }
        }
        -1
    }

    /// TS `getAccountsSnapshot()` — WRITE side effect: force-materializes
    /// `_runtimeTrackerKey` / `circuitKeyId` on the LIVE accounts (gotcha 33)
    /// before cloning. The Rust clone is a full deep copy (the TS snapshot
    /// shared the nested `workspaces` array; Rust cannot share without `Rc`,
    /// so mutations of a snapshot's workspaces do not reach the live pool).
    pub fn get_accounts_snapshot(&mut self) -> Vec<ManagedAccount> {
        for account in &mut self.accounts {
            let _ = get_runtime_tracker_key(account);
            let _ = get_account_circuit_key(account);
        }
        self.accounts.clone()
    }

    /// TS `getAccountByIndex(index)` — `None` for out-of-range (NaN maps to
    /// the typed `i64` domain).
    pub fn get_account_by_index(&self, index: i64) -> Option<&ManagedAccount> {
        if index < 0 || index >= self.accounts.len() as i64 {
            return None;
        }
        self.accounts.get(index as usize)
    }

    /// Mutable sibling of [`Self::get_account_by_index`] — the TS API handed
    /// out live object references; Rust callers mutate through this instead.
    pub fn get_account_by_index_mut(&mut self, index: i64) -> Option<&mut ManagedAccount> {
        if index < 0 || index >= self.accounts.len() as i64 {
            return None;
        }
        self.accounts.get_mut(index as usize)
    }

    /// TS `static resetVolatileRuntimeState()` — clears the process-global
    /// rotation trackers and circuit breakers ONLY (per-account transient
    /// state is `clear_account_transient_state`, persistence half / #606).
    pub fn reset_volatile_runtime_state() {
        reset_trackers();
        reset_all_circuit_breakers();
    }

    /// TS `setActiveIndex(index)` — mutates ALL families' active pointer AND
    /// cursor to `index` (cursor = index here, NOT index+1 — gotcha 9),
    /// stamps `lastUsed`/`lastSwitchReason="rotation"`, fire-and-forgets the
    /// Codex CLI active-selection mirror write, returns the account.
    pub fn set_active_index(&mut self, index: i64) -> Option<&ManagedAccount> {
        if index < 0 || index >= self.accounts.len() as i64 {
            return None;
        }
        let idx = index as usize;
        if !self.accounts[idx].is_enabled() {
            return None;
        }

        for family in MODEL_FAMILIES {
            self.current_account_index_by_family.set(family, index);
            self.cursor_by_family.set(family, index);
        }

        let account = &mut self.accounts[idx];
        account.meta.last_used = now_ms();
        account.meta.last_switch_reason = Some(SwitchReason::Rotation);

        // TS: `void this.syncCodexCliActiveSelectionForIndex(account.index)`.
        // Fire-and-forget over captured data; outside a tokio runtime the
        // advisory mirror write is skipped (best-effort in TS too).
        let selection = ActiveSelection {
            account_id: account.meta.account_id.clone(),
            email: account.meta.email.clone(),
            access_token: account.meta.access_token.clone(),
            refresh_token: Some(account.meta.refresh_token.clone()),
            expires_at: account.meta.expires_at.map(|expires| expires as f64),
            id_token: None,
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = set_codex_cli_active_selection(&selection).await;
            });
        }

        self.accounts.get(idx)
    }

    /// TS `getCurrentAccount()` = `getCurrentAccountForFamily("codex")`.
    pub fn get_current_account(&self) -> Option<&ManagedAccount> {
        self.get_current_account_for_family(ModelFamily::Codex)
    }

    /// TS `getCurrentAccountForFamily(family)` — `None` when the pointer is
    /// out of range or the slot is disabled. NO availability checks (rate
    /// limit / cooldown / circuit are deliberately not consulted).
    pub fn get_current_account_for_family(&self, family: ModelFamily) -> Option<&ManagedAccount> {
        let index = self.current_account_index_by_family.get(family);
        if index < 0 || index >= self.accounts.len() as i64 {
            return None;
        }
        let account = &self.accounts[index as usize];
        if !account.is_enabled() {
            return None;
        }
        Some(account)
    }

    /// TS `setRoutingMutexMode(mode)` (PR-N / R4).
    pub fn set_routing_mutex_mode(&mut self, mode: RoutingMutexMode) {
        self.routing_mutex_mode = mode;
    }

    /// TS `getRoutingMutexMode()`.
    pub fn get_routing_mutex_mode(&self) -> RoutingMutexMode {
        self.routing_mutex_mode
    }

    /// TS `getAccountByIdentity(candidate, auth?)` — index-returning form
    /// (the TS method returned the live object reference).
    pub fn get_account_index_by_identity(
        &self,
        candidate: &AccountIdentityCandidate,
        auth: Option<&OAuthAuthDetails>,
    ) -> Option<usize> {
        find_account_index_by_identity(&self.accounts, candidate, auth)
    }

    /// TS `getAccountByIdentity(candidate, auth?)`.
    pub fn get_account_by_identity(
        &self,
        candidate: &AccountIdentityCandidate,
        auth: Option<&OAuthAuthDetails>,
    ) -> Option<&ManagedAccount> {
        let index = self.get_account_index_by_identity(candidate, auth)?;
        self.accounts.get(index)
    }

    /// TS `shouldShowAccountToast(accountIndex, debounceMs = 30000)` — only
    /// the SAME index within the window is debounced; a different index
    /// always toasts (gotcha 30).
    pub fn should_show_account_toast(&self, account_index: i64, debounce_ms: Option<i64>) -> bool {
        let debounce_ms = debounce_ms.unwrap_or(30_000);
        let now = now_ms();
        !(account_index == self.last_toast_account_index
            && now - self.last_toast_time < debounce_ms)
    }

    /// TS `markToastShown(accountIndex)`.
    pub fn mark_toast_shown(&mut self, account_index: i64) {
        self.last_toast_account_index = account_index;
        self.last_toast_time = now_ms();
    }

    /// TS `commitRefreshedAuth(source, auth)` — persist a refreshed token
    /// triple transactionally and mirror it onto the live account.
    ///
    /// Returns the LIVE account index (the TS method returned the account
    /// object) — `Ok(None)` when no matching account resolves (the stored
    /// row, when found, is still persisted in that case). Every escaping
    /// error is wrapped as `CodexAuthError` with the FROZEN message
    /// `"Failed to refresh token, authentication required"` and `retryable`
    /// derived from EAGAIN/EBUSY/EPERM/429 across the cause chain.
    pub async fn commit_refreshed_auth(
        &mut self,
        source: &AccountIdentityCandidate,
        auth: &OAuthAuthDetails,
    ) -> Result<Option<usize>, CodexError> {
        let next_account_id = trim_to_non_empty(extract_account_id(Some(auth.access.as_str())));
        let next_email =
            sanitize_email(extract_account_email(Some(auth.access.as_str()), None).as_deref());

        let this = &mut *self;
        let result = with_account_storage_transaction(move |_current, persist| async move {
            // Snapshot the live in-memory pool under the storage lock so
            // refresh persistence merges against the latest account state
            // (TS `structuredClone(this.buildStorageSnapshot())`).
            let mut next_storage: AccountStorageV3 = this.build_storage_snapshot();
            let storage_index =
                find_account_index_by_identity(&next_storage.accounts, source, Some(auth));
            let Some(storage_index) = storage_index else {
                accounts_log().warn(
                    "Unable to resolve refreshed account for persistence",
                    Some(&json!({ "sourceIndex": source.index })),
                );
                return Ok(None);
            };

            let Some(stored_account) = next_storage.accounts.get_mut(storage_index) else {
                return Ok(None);
            };

            stored_account.refresh_token = auth.refresh.clone();
            stored_account.access_token = Some(auth.access.clone());
            stored_account.expires_at = Some(auth.expires);
            if let Some(account_id) = next_account_id.as_ref()
                && should_update_account_id_from_token(
                    stored_account.account_id_source.as_ref(),
                    stored_account.account_id.as_deref(),
                )
            {
                stored_account.account_id = Some(account_id.clone());
                stored_account.account_id_source = Some(AccountIdSource::Token);
            }
            if let Some(email) = next_email.as_ref() {
                stored_account.email = Some(email.clone());
            }
            // Re-enable on disk: `enabled = undefined` (omitted).
            stored_account.enabled = None;
            stored_account.cooling_down_until = None;
            stored_account.cooldown_reason = None;

            let live_index = find_account_index_by_identity(&this.accounts, source, Some(auth));
            if let Some(live_index) = live_index {
                let previous = {
                    let live = &this.accounts[live_index];
                    (
                        live.meta.access_token.clone(),
                        live.meta.refresh_token.clone(),
                        live.meta.expires_at,
                        live.meta.account_id.clone(),
                        live.meta.account_id_source,
                        live.meta.email.clone(),
                        live.meta.enabled,
                        live.meta.cooling_down_until,
                        live.meta.cooldown_reason,
                        live.runtime.consecutive_auth_failures,
                    )
                };

                {
                    let live = &mut this.accounts[live_index];
                    live.update_from_auth(auth);
                    live.meta.enabled = Some(true);
                    live.clear_cooldown();
                    live.clear_auth_failures();
                }

                if let Err(error) = persist.persist(&next_storage).await {
                    // Roll back every live-account field exactly.
                    let live = &mut this.accounts[live_index];
                    live.meta.access_token = previous.0;
                    live.meta.refresh_token = previous.1;
                    live.meta.expires_at = previous.2;
                    live.meta.account_id = previous.3;
                    live.meta.account_id_source = previous.4;
                    live.meta.email = previous.5;
                    live.meta.enabled = previous.6;
                    live.meta.cooling_down_until = previous.7;
                    live.meta.cooldown_reason = previous.8;
                    live.runtime.consecutive_auth_failures = previous.9;
                    return Err(error);
                }

                return Ok(Some(live_index));
            }

            persist.persist(&next_storage).await?;
            accounts_log().warn(
                "Unable to resolve refreshed live account after persistence",
                Some(&json!({ "sourceIndex": source.index })),
            );
            Ok(None)
        })
        .await;

        match result {
            Ok(live_index) => Ok(live_index),
            Err(error) => {
                let retryable = is_retryable_auth_persistence_error(&error);
                Err(CodexError::auth(ERROR_MESSAGES.token_refresh_failed)
                    .with_retryable(retryable)
                    .with_cause(error))
            }
        }
    }

    /// TS private `findNextEnabled(start)` — negative-safe wrap-around scan
    /// (start inclusive); `-1` when the pool is empty or fully disabled.
    fn find_next_enabled(&self, start: i64) -> i64 {
        let count = self.accounts.len() as i64;
        if count == 0 {
            return -1;
        }
        let base = ((start % count) + count) % count;
        for step in 0..count {
            let candidate = (base + step) % count;
            if self.accounts[candidate as usize].is_enabled() {
                return candidate;
            }
        }
        -1
    }

    /// Core of TS `removeAccount(account)` (object-identity lookup becomes an
    /// array-position parameter in Rust) — splice, tracker/circuit cleanup
    /// under BOTH the stable cached key and the recomputed identity key
    /// (accounts-02), numeric-range tracker clears, reindex + numeric-cache
    /// invalidation (HI-01), cursor/active fixups, and the
    /// `lastSwitchReason="rotation"` retarget stamp (HI-04).
    fn remove_account_at(&mut self, idx: usize) -> bool {
        if idx >= self.accounts.len() {
            return false;
        }

        // Snapshot family pointers before the splice.
        let prior_cursor = self.cursor_by_family;
        let prior_active = self.current_account_index_by_family;

        let mut account = self.accounts.remove(idx);

        // Clear identity-keyed tracker + circuit state for the removed
        // account. Tracker state is WRITTEN under the pinned (stable)
        // getRuntimeTrackerKey; the recomputed runtime identity key can
        // DIFFER after identity enrichment — clear the stable key first
        // (required), then the recomputed key when it differs (defensive).
        let removed_tracker_key = get_runtime_tracker_key(&mut account);
        let health_tracker = get_health_tracker(None);
        let token_tracker = get_token_tracker(None);
        health_tracker.clear_account_key(removed_tracker_key.clone());
        token_tracker.clear_account_key(removed_tracker_key.clone());
        let removed_identity_key = get_runtime_account_identity_key(
            account.meta.account_id.as_deref(),
            account.meta.email.as_deref(),
            Some(account.index as i64),
        )
        .map(|key| match key {
            RuntimeAccountIdentityKey::Key(key) => TrackerKey::Text(key),
            RuntimeAccountIdentityKey::Index(index) => TrackerKey::Number(index),
        });
        if let Some(identity_key) = removed_identity_key
            && identity_key != removed_tracker_key
        {
            health_tracker.clear_account_key(identity_key.clone());
            token_tracker.clear_account_key(identity_key);
        }
        if let Some(circuit_key_id) = account.runtime.circuit_key_id.as_deref()
            && !circuit_key_id.is_empty()
        {
            remove_circuit_breaker(circuit_key_id);
        }

        // Numeric-range clear for the shifted survivors, then reindex and
        // invalidate cached NUMERIC tracker keys (position-encoding); string
        // identity keys survive (HI-01).
        health_tracker.clear_numeric_keys_at_or_above(idx);
        token_tracker.clear_numeric_keys_at_or_above(idx);
        for (i, acc) in self.accounts.iter_mut().enumerate() {
            acc.index = i;
            if matches!(acc.runtime.runtime_tracker_key, Some(TrackerKey::Number(_))) {
                acc.runtime.runtime_tracker_key = None;
            }
        }

        if self.accounts.is_empty() {
            for family in MODEL_FAMILIES {
                self.cursor_by_family.set(family, 0);
                self.current_account_index_by_family.set(family, -1);
            }
            return true;
        }

        let len = self.accounts.len() as i64;
        let idx_i = idx as i64;
        let mut retargeted_successors: BTreeSet<i64> = BTreeSet::new();

        for family in MODEL_FAMILIES {
            // Cursor: shift down when past the removed index, then normalize
            // into [0, len).
            let mut cursor = prior_cursor.get(family);
            if cursor > idx_i {
                cursor = (cursor - 1).max(0);
            }
            if cursor >= len {
                cursor = 0;
            }
            if cursor < 0 {
                cursor = 0;
            }
            self.cursor_by_family.set(family, cursor);

            // Active pointer: shift down when strictly past; when AT the
            // removed slot advance to the next enabled account; dangling
            // pointers re-resolve from 0; -1 only when nothing is enabled.
            let mut active = prior_active.get(family);
            let active_was_removed = active == idx_i;
            if active > idx_i {
                active -= 1;
            } else if active_was_removed {
                active = self.find_next_enabled(idx_i.min(len - 1));
            }
            if active >= len {
                active = self.find_next_enabled(0);
            }
            self.current_account_index_by_family.set(family, active);
            if active_was_removed && active >= 0 && active < len {
                retargeted_successors.insert(active);
            }
        }

        // HI-04: stamp the retarget signal (deduped — the field is
        // per-account, not per-family).
        for successor_idx in retargeted_successors {
            if let Some(successor) = self.accounts.get_mut(successor_idx as usize) {
                successor.meta.last_switch_reason = Some(SwitchReason::Rotation);
            }
        }

        true
    }

    /// TS `removeAccountByIndex(index)` — bounds-checked wrapper.
    pub fn remove_account_by_index(&mut self, index: i64) -> bool {
        if index < 0 || index >= self.accounts.len() as i64 {
            return false;
        }
        self.remove_account_at(index as usize)
    }

    /// TS `setAccountEnabled(index, enabled)` — stores the literal boolean;
    /// re-enabling resets workspaces; disabling repairs BOTH the active
    /// pointer and the cursor for every family whose pointer references the
    /// just-disabled index (AUDIT-H10 / oracle F2). Does NOT save to disk.
    pub fn set_account_enabled(&mut self, index: i64, enabled: bool) -> Option<&ManagedAccount> {
        if index < 0 || index >= self.accounts.len() as i64 {
            return None;
        }
        let idx = index as usize;
        let was_enabled = self.accounts[idx].is_enabled();
        self.accounts[idx].meta.enabled = Some(enabled);
        if enabled && !was_enabled {
            self.accounts[idx].reset_workspaces();
        }
        if !enabled {
            let len = self.accounts.len() as i64;
            // Local scan starts at start+1 (never re-checks the start slot),
            // unlike the private findNextEnabled — port both verbatim.
            let find_next_enabled = |accounts: &[ManagedAccount], start: i64| -> i64 {
                for step in 1..len {
                    let candidate = (start + step) % len;
                    if accounts[candidate as usize].is_enabled() {
                        return candidate;
                    }
                }
                -1
            };
            for family in MODEL_FAMILIES {
                if self.current_account_index_by_family.get(family) == index {
                    let next = find_next_enabled(&self.accounts, index);
                    if next != -1 {
                        self.current_account_index_by_family.set(family, next);
                    }
                }
                if self.cursor_by_family.get(family) == index {
                    let next = find_next_enabled(&self.accounts, index);
                    if next != -1 {
                        self.cursor_by_family.set(family, next);
                    }
                }
            }
        }
        self.accounts.get(idx)
    }
}

// ============================================================================
// Tests — ported from test/accounts.test.ts (state / constructor / removal /
// tracker-key suites) and test/accounts-load-from-disk.test.ts (hydration).
// Selection- and persistence-half suites are ported by their owning modules.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::json_io::stringify_pretty2;
    use cma_rotation::circuit_breaker::{clear_circuit_breakers, get_circuit_breaker};
    use cma_rotation::trackers::DEFAULT_TOKEN_BUCKET_CONFIG;
    use cma_testkit::sandbox::EnvSandbox;
    use serde_json::{Value, json};
    use serial_test::serial;

    /// Minimal base64url (no padding) encoder so the test JWTs need no
    /// external dev-dependency (the crate's Cargo.toml is foundation-frozen).
    fn base64url_no_pad(input: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
            let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
            let triple = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
            out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
            if chunk.len() > 1 {
                out.push(ALPHABET[(triple >> 6) as usize & 0x3f] as char);
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[triple as usize & 0x3f] as char);
            }
        }
        out
    }

    fn make_jwt(payload: &Value) -> String {
        format!(
            "{}.{}.signature",
            base64url_no_pad(b"{\"alg\":\"none\"}"),
            base64url_no_pad(payload.to_string().as_bytes())
        )
    }

    fn auth(access: &str, refresh: &str, expires: i64) -> OAuthAuthDetails {
        OAuthAuthDetails {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires,
        }
    }

    fn stored_account(refresh: &str, now: i64) -> AccountMetadataV3 {
        AccountMetadataV3::new(refresh, now, now)
    }

    fn storage_of(accounts: Vec<AccountMetadataV3>, active_index: i64) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts = accounts;
        storage.active_index = active_index;
        storage
    }

    fn reset_volatile() {
        reset_trackers();
        clear_circuit_breakers();
    }

    // -- constructor ---------------------------------------------------------

    #[test]
    fn seeds_from_fallback_auth_when_no_storage_exists() {
        let auth = auth("access-token", "refresh-token", now_ms() + 60_000);
        let manager = AccountManager::new(Some(&auth), None);
        assert_eq!(manager.get_account_count(), 1);
        let account = manager.get_current_account().expect("current account");
        assert_eq!(account.meta.refresh_token, "refresh-token");
        // Fresh-pool fallback gets lastUsed = 0 (NOT now — gotcha 14).
        assert_eq!(account.meta.last_used, 0);
        assert_eq!(account.meta.last_switch_reason, Some(SwitchReason::Initial));
        assert!(account.is_enabled());
        assert_eq!(manager.get_active_index(), 0);
    }

    #[test]
    fn returns_account_by_index_and_rejects_invalid_indexes() {
        let now = now_ms();
        let stored = storage_of(
            vec![stored_account("token-1", now), stored_account("token-2", now)],
            0,
        );
        let manager = AccountManager::new(None, Some(&stored));
        assert_eq!(
            manager
                .get_account_by_index(0)
                .map(|a| a.meta.refresh_token.as_str()),
            Some("token-1")
        );
        assert_eq!(
            manager
                .get_account_by_index(1)
                .map(|a| a.meta.refresh_token.as_str()),
            Some("token-2")
        );
        assert!(manager.get_account_by_index(-1).is_none());
        assert!(manager.get_account_by_index(9).is_none());
    }

    #[test]
    fn filters_out_accounts_with_blank_refresh_token_keeping_stored_positions() {
        let now = now_ms();
        let stored = storage_of(
            vec![
                stored_account("valid-token", now),
                stored_account("", now),
                stored_account("   ", now),
                stored_account("another-valid", now),
            ],
            0,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        assert_eq!(manager.get_account_count(), 2);
        let accounts = manager.get_accounts_snapshot();
        assert_eq!(accounts[0].meta.refresh_token, "valid-token");
        assert_eq!(accounts[1].meta.refresh_token, "another-valid");
        // Gotcha 14: surviving rows keep their ORIGINAL stored positions in
        // `index` until the first removal reindex.
        assert_eq!(accounts[0].index, 0);
        assert_eq!(accounts[1].index, 3);
    }

    #[test]
    fn merges_fallback_auth_when_matching_by_account_id() {
        let now = now_ms();
        let access = make_jwt(&json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "matching-account-id" },
            "email": "fallback@example.com",
        }));
        let mut account = stored_account("stored-token", now);
        account.account_id = Some("matching-account-id".to_string());
        let stored = storage_of(vec![account], 0);
        let auth = auth(&access, "new-refresh-token", now + 60_000);

        let manager = AccountManager::new(Some(&auth), Some(&stored));
        assert_eq!(manager.get_account_count(), 1);
        let account = manager.get_current_account().expect("account");
        assert_eq!(account.meta.refresh_token, "new-refresh-token");
        assert_eq!(account.meta.access_token.as_deref(), Some(access.as_str()));
    }

    #[test]
    fn trims_fallback_account_id_before_matching_and_persisting_it() {
        let now = now_ms();
        let access = make_jwt(&json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "  matching-account-id  " },
        }));
        let mut account = stored_account("stored-token", now);
        account.account_id = Some("matching-account-id".to_string());
        let stored = storage_of(vec![account], 0);
        let auth = auth(&access, "new-refresh-token", now + 60_000);

        let manager = AccountManager::new(Some(&auth), Some(&stored));
        assert_eq!(manager.get_account_count(), 1);
        let account = manager.get_current_account().expect("account");
        assert_eq!(account.meta.refresh_token, "new-refresh-token");
        assert_eq!(
            account.meta.account_id.as_deref(),
            Some("matching-account-id")
        );
    }

    #[test]
    fn ignores_malformed_stored_rows_when_matching_fallback_by_shared_account_id() {
        let now = now_ms();
        let access = make_jwt(&json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "matching-account-id" },
        }));
        let make = |refresh: &str| {
            let mut account = stored_account(refresh, now);
            account.account_id = Some("matching-account-id".to_string());
            account
        };
        let stored = storage_of(vec![make("stored-token"), make(""), make("   ")], 0);
        let auth = auth(&access, "new-refresh-token", now + 60_000);

        let manager = AccountManager::new(Some(&auth), Some(&stored));
        assert_eq!(manager.get_account_count(), 1);
        let account = manager.get_current_account().expect("account");
        assert_eq!(account.meta.refresh_token, "new-refresh-token");
        assert_eq!(
            account.meta.account_id.as_deref(),
            Some("matching-account-id")
        );
    }

    #[test]
    fn merges_fallback_auth_when_matching_by_email_without_duplicating() {
        let now = now_ms();
        let access = make_jwt(&json!({ "email": "fallback@example.com" }));
        let mut account = stored_account("stored-token", now);
        account.email = Some("fallback@example.com".to_string());
        let stored = storage_of(vec![account], 0);
        let auth = auth(&access, "different-refresh-token", now + 60_000);

        let manager = AccountManager::new(Some(&auth), Some(&stored));
        assert_eq!(manager.get_account_count(), 1);
        let account = manager.get_current_account().expect("account");
        assert_eq!(account.meta.refresh_token, "different-refresh-token");
        assert_eq!(
            account.meta.email.as_deref(),
            Some("fallback@example.com")
        );
    }

    #[test]
    fn adds_fallback_as_distinct_account_when_same_email_spans_multiple_account_ids() {
        let now = now_ms();
        let access = make_jwt(&json!({ "email": "shared@example.com" }));
        let make = |id: &str, refresh: &str| {
            let mut account = stored_account(refresh, now);
            account.account_id = Some(id.to_string());
            account.email = Some("shared@example.com".to_string());
            account
        };
        let stored = storage_of(
            vec![
                make("workspace-alpha", "refresh-alpha"),
                make("workspace-beta", "refresh-beta"),
            ],
            0,
        );
        let auth = auth(&access, "refresh-gamma", now + 60_000);

        let mut manager = AccountManager::new(Some(&auth), Some(&stored));
        assert_eq!(manager.get_account_count(), 3);
        let refreshes: Vec<String> = manager
            .get_accounts_snapshot()
            .iter()
            .map(|account| account.meta.refresh_token.clone())
            .collect();
        assert_eq!(refreshes, vec!["refresh-alpha", "refresh-beta", "refresh-gamma"]);
    }

    #[test]
    fn adds_fallback_as_new_account_when_no_match_found() {
        let now = now_ms();
        let stored = storage_of(vec![stored_account("existing-token", now)], 0);
        let auth = auth("new-access", "new-refresh", now + 60_000);

        let mut manager = AccountManager::new(Some(&auth), Some(&stored));
        assert_eq!(manager.get_account_count(), 2);
        let accounts = manager.get_accounts_snapshot();
        assert_eq!(accounts[0].meta.refresh_token, "existing-token");
        assert_eq!(accounts[1].meta.refresh_token, "new-refresh");
        // Appended fallback gets lastUsed = now (differs from the fresh-pool
        // case, gotcha 14) and lastSwitchReason = "initial".
        assert!(accounts[1].meta.last_used >= now);
        assert_eq!(
            accounts[1].meta.last_switch_reason,
            Some(SwitchReason::Initial)
        );
        // Opaque access token carries no accountId → source stays unset.
        assert_eq!(accounts[1].meta.account_id_source, None);
    }

    #[test]
    fn sets_account_id_source_to_token_when_fallback_account_id_exists() {
        let now = now_ms();
        let access = make_jwt(&json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_new" },
        }));
        let auth = auth(&access, "refresh-new", now + 60_000);
        let manager = AccountManager::new(Some(&auth), None);
        let account = manager.get_current_account().expect("account");
        assert_eq!(account.meta.account_id.as_deref(), Some("acc_new"));
        assert_eq!(
            account.meta.account_id_source,
            Some(AccountIdSource::Token)
        );
    }

    #[test]
    fn pointer_init_uses_active_index_by_family_modulo_pool_size() {
        let now = now_ms();
        let mut stored = storage_of(
            vec![stored_account("token-1", now), stored_account("token-2", now)],
            1,
        );
        let mut by_family = cma_core::schemas::account_storage::ActiveIndexByFamily::default();
        by_family.set(ModelFamily::Gpt5_2, Some(5)); // 5 % 2 == 1
        by_family.set(ModelFamily::Codex, Some(0));
        stored.active_index_by_family = Some(by_family);

        let manager = AccountManager::new(None, Some(&stored));
        assert_eq!(manager.get_active_index_for_family(ModelFamily::Codex), 0);
        assert_eq!(manager.get_active_index_for_family(ModelFamily::Gpt5_2), 1);
        // Families without an entry fall back to activeIndex (1).
        assert_eq!(manager.get_active_index_for_family(ModelFamily::CodexMax), 1);
        assert_eq!(manager.cursor_by_family.get(ModelFamily::Gpt5_2), 1);
    }

    // -- hasRefreshToken -----------------------------------------------------

    #[test]
    fn has_refresh_token_exact_equality() {
        let now = now_ms();
        let stored = storage_of(
            vec![stored_account("token-1", now), stored_account("token-2", now)],
            0,
        );
        let manager = AccountManager::new(None, Some(&stored));
        assert!(manager.has_refresh_token("token-1"));
        assert!(manager.has_refresh_token("token-2"));
        assert!(!manager.has_refresh_token("non-existent"));
        assert!(!manager.has_refresh_token(""));
    }

    // -- workspaces (#491) ---------------------------------------------------

    fn workspace(id: &str, name: &str, enabled: bool, is_default: Option<bool>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: Some(name.to_string()),
            enabled,
            disabled_at: None,
            is_default,
        }
    }

    #[test]
    fn does_not_disable_a_different_current_workspace_after_rotation() {
        let now = now_ms();
        let mut account = stored_account("token-1", now);
        account.workspaces = Some(vec![
            workspace("workspace-1", "Workspace 1", true, None),
            workspace("workspace-2", "Workspace 2", true, None),
        ]);
        account.current_workspace_index = Some(0);
        let stored = storage_of(vec![account], 0);

        let mut manager = AccountManager::new(None, Some(&stored));
        let account = manager.get_account_by_index_mut(0).expect("account");

        assert!(account.disable_current_workspace(Some("workspace-1")));
        assert_eq!(
            account.rotate_to_next_workspace().map(|w| w.id.as_str()),
            Some("workspace-2")
        );
        // CAS guard: the current workspace is now workspace-2.
        assert!(!account.disable_current_workspace(Some("workspace-1")));
        assert!(account.is_enabled());
        assert!(account.has_enabled_workspaces());
        assert_eq!(account.get_enabled_workspace_count(), 1);
        assert_eq!(
            account.get_current_workspace().map(|w| w.id.as_str()),
            Some("workspace-2")
        );
        let states: Vec<bool> = account
            .meta
            .workspaces
            .as_ref()
            .unwrap()
            .iter()
            .map(|w| w.enabled)
            .collect();
        assert_eq!(states, vec![false, true]);
    }

    #[test]
    fn re_enabling_an_exhausted_account_restores_its_workspaces() {
        let now = now_ms();
        let mut account = stored_account("token-1", now);
        account.workspaces = Some(vec![
            workspace("workspace-1", "One", false, None),
            workspace("workspace-2", "Two", false, Some(true)),
        ]);
        account.current_workspace_index = Some(0);
        account.enabled = Some(false);
        let stored = storage_of(vec![account], 0);

        let mut manager = AccountManager::new(None, Some(&stored));
        let account = manager.set_account_enabled(0, true).expect("account");
        assert!(account.is_enabled());
        // All workspaces re-enabled; cursor points at the DEFAULT workspace.
        assert!(account.has_enabled_workspaces());
        assert_eq!(account.get_enabled_workspace_count(), 2);
        assert_eq!(account.meta.current_workspace_index, Some(1));
        assert!(
            account
                .meta
                .workspaces
                .as_ref()
                .unwrap()
                .iter()
                .all(|w| w.enabled && w.disabled_at.is_none())
        );
    }

    #[test]
    fn re_enabling_without_default_workspace_resets_to_first() {
        let now = now_ms();
        let mut account = stored_account("token-1", now);
        account.workspaces = Some(vec![
            workspace("workspace-1", "One", false, None),
            workspace("workspace-2", "Two", false, None),
        ]);
        account.current_workspace_index = Some(1);
        account.enabled = Some(false);
        let stored = storage_of(vec![account], 0);

        let mut manager = AccountManager::new(None, Some(&stored));
        let account = manager.set_account_enabled(0, true).expect("account");
        assert_eq!(account.meta.current_workspace_index, Some(0));
    }

    #[test]
    fn workspace_less_legacy_accounts_count_as_implicitly_enabled() {
        let now = now_ms();
        let stored = storage_of(vec![stored_account("token-1", now)], 0);
        let manager = AccountManager::new(None, Some(&stored));
        let account = manager.get_account_by_index(0).expect("account");
        assert!(account.has_enabled_workspaces());
        assert_eq!(account.get_workspace_count(), 0);
        assert_eq!(account.get_enabled_workspace_count(), 0);
        assert!(account.get_current_workspace().is_none());
    }

    // -- getActiveIndexForFamily (AUDIT-H10 / oracle F1) ---------------------

    #[test]
    fn active_index_normalizes_to_next_enabled_slot_when_active_disabled() {
        let now = now_ms();
        let stored = storage_of(
            vec![
                stored_account("token-1", now),
                stored_account("token-2", now),
                stored_account("token-3", now),
            ],
            1,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        assert_eq!(manager.get_active_index(), 1);
        manager.set_account_enabled(1, false);
        // Pointer repair moved the active pointer; the read-side walk also
        // guarantees a routable index.
        let active = manager.get_active_index();
        assert!(active == 2 || active == 0);
        assert!(
            manager
                .get_account_by_index(active)
                .expect("account")
                .is_enabled()
        );
    }

    #[test]
    fn active_index_returns_minus_one_when_all_disabled() {
        let now = now_ms();
        let stored = storage_of(
            vec![stored_account("token-1", now), stored_account("token-2", now)],
            0,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        manager.set_account_enabled(0, false);
        manager.set_account_enabled(1, false);
        assert_eq!(manager.get_active_index(), -1);
        assert!(manager.get_current_account().is_none());
    }

    #[test]
    fn active_index_is_minus_one_on_empty_pool() {
        let manager = AccountManager::new(None, None);
        assert_eq!(manager.get_active_index(), -1);
    }

    // -- setActiveIndex ------------------------------------------------------

    #[test]
    fn set_active_index_sets_all_families_and_returns_account() {
        let now = now_ms();
        let stored = storage_of(
            vec![stored_account("token-1", now), stored_account("token-2", now)],
            0,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        let account = manager.set_active_index(1).expect("account");
        assert_eq!(account.meta.refresh_token, "token-2");
        assert_eq!(account.meta.last_switch_reason, Some(SwitchReason::Rotation));
        for family in MODEL_FAMILIES {
            assert_eq!(manager.current_account_index_by_family.get(family), 1);
            // Gotcha 9: setActiveIndex sets cursor = index (NOT index+1).
            assert_eq!(manager.cursor_by_family.get(family), 1);
        }
    }

    #[test]
    fn set_active_index_rejects_invalid_or_disabled() {
        let now = now_ms();
        let stored = storage_of(
            vec![stored_account("token-1", now), stored_account("token-2", now)],
            0,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        assert!(manager.set_active_index(-1).is_none());
        assert!(manager.set_active_index(2).is_none());
        manager.set_account_enabled(1, false);
        assert!(manager.set_active_index(1).is_none());
    }

    // -- toast debounce ------------------------------------------------------

    #[test]
    fn debounces_account_toasts_for_the_same_index_only() {
        let now = now_ms();
        let stored = storage_of(vec![stored_account("token-1", now)], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        assert!(manager.should_show_account_toast(0, None));
        manager.mark_toast_shown(0);
        assert!(!manager.should_show_account_toast(0, None));
        // A DIFFERENT index always toasts (gotcha 30).
        assert!(manager.should_show_account_toast(1, None));
        // A zero window never debounces.
        assert!(manager.should_show_account_toast(0, Some(0)));
    }

    // -- updateFromAuth ------------------------------------------------------

    #[test]
    fn update_from_auth_updates_tokens_and_token_sourced_account_id() {
        let now = now_ms();
        let mut stored_row = stored_account("old-refresh", now);
        stored_row.account_id = Some("old-account".to_string());
        stored_row.account_id_source = Some(AccountIdSource::Token);
        let stored = storage_of(vec![stored_row], 0);
        let mut manager = AccountManager::new(None, Some(&stored));

        let access = make_jwt(&json!({
            "email": "new@example.com",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_new" },
        }));
        let auth = auth(&access, "new-refresh", now + 3_600_000);
        let account = manager.get_account_by_index_mut(0).expect("account");
        account.update_from_auth(&auth);

        assert_eq!(account.meta.refresh_token, "new-refresh");
        assert_eq!(account.meta.access_token.as_deref(), Some(access.as_str()));
        assert_eq!(account.meta.expires_at, Some(now + 3_600_000));
        assert_eq!(account.meta.account_id.as_deref(), Some("acc_new"));
        assert_eq!(account.meta.account_id_source, Some(AccountIdSource::Token));
        assert_eq!(account.meta.email.as_deref(), Some("new@example.com"));
    }

    #[test]
    fn update_from_auth_preserves_org_selected_account_id() {
        let now = now_ms();
        let mut stored_row = stored_account("old-refresh", now);
        stored_row.account_id = Some("org-selected".to_string());
        stored_row.account_id_source = Some(AccountIdSource::Org);
        let stored = storage_of(vec![stored_row], 0);
        let mut manager = AccountManager::new(None, Some(&stored));

        let access = make_jwt(&json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_token" },
        }));
        let auth = auth(&access, "new-refresh", now + 3_600_000);
        let account = manager.get_account_by_index_mut(0).expect("account");
        account.update_from_auth(&auth);

        // Org selection is sticky across refreshes.
        assert_eq!(account.meta.account_id.as_deref(), Some("org-selected"));
        assert_eq!(account.meta.account_id_source, Some(AccountIdSource::Org));
        // Email extraction failed (no email claim) → old value kept (None).
        assert_eq!(account.meta.email, None);
    }

    // -- auth-failure primitives ---------------------------------------------
    // (Cooldown set/clear/self-expiry lives in manager_persistence.rs and is
    // tested there.)

    #[test]
    fn auth_failures_increment_and_clear_to_zero_not_none() {
        let now = now_ms();
        let stored = storage_of(vec![stored_account("token-1", now)], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        let account = manager.get_account_by_index_mut(0).expect("account");

        assert_eq!(account.runtime.consecutive_auth_failures, None);
        assert_eq!(account.increment_auth_failures(), 1);
        assert_eq!(account.increment_auth_failures(), 2);
        account.clear_auth_failures();
        // Sets 0, does NOT delete (gotcha 13).
        assert_eq!(account.runtime.consecutive_auth_failures, Some(0));
    }

    // -- tracker keys --------------------------------------------------------

    #[test]
    fn runtime_tracker_key_prefers_identity_and_falls_back_to_index() {
        let now = now_ms();
        let mut with_id = stored_account("tok-a", now);
        with_id.account_id = Some("acc_stable".to_string());
        let anonymous = stored_account("tok-b", now);
        let stored = storage_of(vec![with_id, anonymous], 0);
        let mut manager = AccountManager::new(None, Some(&stored));

        assert_eq!(
            get_runtime_tracker_key(manager.get_account_by_index_mut(0).unwrap()),
            TrackerKey::Text("account:acc_stable".to_string())
        );
        assert_eq!(
            get_runtime_tracker_key(manager.get_account_by_index_mut(1).unwrap()),
            TrackerKey::Number(1)
        );
    }

    #[test]
    fn runtime_tracker_key_is_sticky_across_identity_enrichment() {
        let now = now_ms();
        let mut email_only = stored_account("tok-enrich", now);
        email_only.email = Some("stale@example.com".to_string());
        let stored = storage_of(vec![email_only], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        let account = manager.get_account_by_index_mut(0).expect("account");

        let stable = get_runtime_tracker_key(account);
        assert_eq!(stable, TrackerKey::Text("email:stale@example.com".to_string()));

        let access = make_jwt(&json!({
            "email": "stale@example.com",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_enriched" },
        }));
        account.update_from_auth(&auth(&access, "tok-enrich-rotated", now + 3_600_000));
        assert_eq!(account.meta.account_id.as_deref(), Some("acc_enriched"));
        // The pinned key does NOT change (gotcha 5)...
        assert_eq!(get_runtime_tracker_key(account), stable);
        // ...while the recomputed identity key now DIVERGES.
        let recomputed = get_runtime_account_identity_key(
            account.meta.account_id.as_deref(),
            account.meta.email.as_deref(),
            Some(account.index as i64),
        )
        .expect("identity key");
        assert_ne!(
            recomputed,
            RuntimeAccountIdentityKey::Key("email:stale@example.com".to_string())
        );
    }

    #[test]
    fn snapshot_materializes_keys_and_deep_copies_rate_limit_map() {
        let now = now_ms();
        let mut with_id = stored_account("tok-a", now);
        with_id.account_id = Some("acc_snap".to_string());
        let stored = storage_of(vec![with_id], 0);
        let mut manager = AccountManager::new(None, Some(&stored));

        let mut snapshot = manager.get_accounts_snapshot();
        assert_eq!(
            snapshot[0].runtime.runtime_tracker_key,
            Some(TrackerKey::Text("account:acc_snap".to_string()))
        );
        assert_eq!(
            snapshot[0].runtime.circuit_key_id.as_deref(),
            Some("account:acc_snap")
        );
        // Side effect: the LIVE account's caches were materialized too.
        assert!(
            manager.accounts[0].runtime.runtime_tracker_key.is_some()
                && manager.accounts[0].runtime.circuit_key_id.is_some()
        );
        // Deep copy: mutating the snapshot's map does not touch the live one.
        snapshot[0]
            .rate_limit_reset_times
            .insert("codex", now + 60_000);
        assert!(manager.accounts[0].rate_limit_reset_times.is_empty());
    }

    // -- removeAccount -------------------------------------------------------

    #[test]
    #[serial(volatile)]
    fn removes_an_account_and_updates_indices() {
        reset_volatile();
        let now = now_ms();
        let stored = storage_of(
            vec![
                stored_account("token-1", now),
                stored_account("token-2", now),
                stored_account("token-3", now),
            ],
            1,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        assert_eq!(
            manager
                .get_current_account()
                .map(|a| a.meta.refresh_token.clone()),
            Some("token-2".to_string())
        );

        assert!(manager.remove_account_by_index(1));
        assert_eq!(manager.get_account_count(), 2);
        let remaining = manager.get_accounts_snapshot();
        assert_eq!(remaining[0].meta.refresh_token, "token-1");
        assert_eq!(remaining[1].meta.refresh_token, "token-3");
        assert_eq!(remaining[0].index, 0);
        assert_eq!(remaining[1].index, 1);
        // HI-04: the successor that replaced the removed "current" pointer is
        // stamped with lastSwitchReason = "rotation".
        assert_eq!(
            remaining[1].meta.last_switch_reason,
            Some(SwitchReason::Rotation)
        );
        assert_eq!(manager.get_active_index(), 1);
    }

    #[test]
    #[serial(volatile)]
    fn clears_identity_keyed_tracker_and_circuit_state_on_removal() {
        reset_volatile();
        let now = now_ms();
        let mut stable = stored_account("tok-a", now);
        stable.account_id = Some("acc_stable".to_string());
        let mut other = stored_account("tok-b", now);
        other.account_id = Some("acc_other".to_string());
        let stored = storage_of(vec![stable, other], 0);
        let mut manager = AccountManager::new(None, Some(&stored));

        // Materialize keys on the live accounts (snapshot side effect).
        let _ = manager.get_accounts_snapshot();
        let identity_key = TrackerKey::Text("account:acc_stable".to_string());

        let health_tracker = get_health_tracker(None);
        let token_tracker = get_token_tracker(None);
        assert!(token_tracker.try_consume(identity_key.clone(), Some("codex")));
        assert!(
            token_tracker.get_tokens(identity_key.clone(), Some("codex"))
                < DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
        let breaker = get_circuit_breaker("account:acc_stable", None);
        breaker.record_failure();
        breaker.record_failure();
        breaker.record_failure();
        assert!(!breaker.is_available());
        for _ in 0..5 {
            health_tracker.record_failure(identity_key.clone(), Some("codex"));
        }
        assert!(health_tracker.get_score(identity_key.clone(), Some("codex")) < 100.0);

        assert!(manager.remove_account_by_index(0));

        assert_eq!(
            health_tracker.get_score(identity_key.clone(), Some("codex")),
            100.0
        );
        assert_eq!(
            token_tracker.get_tokens(identity_key, Some("codex")),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
        assert!(get_circuit_breaker("account:acc_stable", None).is_available());
    }

    #[test]
    #[serial(volatile)]
    fn clears_stable_tracker_key_after_identity_enrichment_on_removal() {
        reset_volatile();
        let now = now_ms();
        let mut email_only = stored_account("tok-enrich", now);
        email_only.email = Some("stale@example.com".to_string());
        let mut other = stored_account("tok-other", now);
        other.account_id = Some("acc_other".to_string());
        let stored = storage_of(vec![email_only, other], 0);
        let mut manager = AccountManager::new(None, Some(&stored));

        let stable_key = get_runtime_tracker_key(manager.get_account_by_index_mut(0).unwrap());
        assert_eq!(stable_key, TrackerKey::Text("email:stale@example.com".to_string()));

        let health_tracker = get_health_tracker(None);
        let token_tracker = get_token_tracker(None);
        assert!(token_tracker.try_consume(stable_key.clone(), Some("codex")));
        for _ in 0..5 {
            health_tracker.record_failure(stable_key.clone(), Some("codex"));
        }
        assert!(health_tracker.get_score(stable_key.clone(), Some("codex")) < 100.0);

        // Enrich the identity so the recomputed key diverges from the pinned
        // one.
        let access = make_jwt(&json!({
            "email": "stale@example.com",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_enriched" },
        }));
        manager
            .get_account_by_index_mut(0)
            .unwrap()
            .update_from_auth(&auth(&access, "tok-enrich-rotated", now + 3_600_000));
        assert_eq!(
            get_runtime_tracker_key(manager.get_account_by_index_mut(0).unwrap()),
            stable_key
        );

        assert!(manager.remove_account_by_index(0));

        // The STABLE key's state was cleared (the buggy variant cleared only
        // the recomputed key).
        assert_eq!(
            health_tracker.get_score(stable_key.clone(), Some("codex")),
            100.0
        );
        assert_eq!(
            token_tracker.get_tokens(stable_key, Some("codex")),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
    }

    #[test]
    #[serial(volatile)]
    fn invalidates_numeric_runtime_tracker_keys_after_reindex_hi_01() {
        reset_volatile();
        let now = now_ms();
        // Refresh-only accounts: tracker keys fall back to numeric indexes.
        let stored = storage_of(
            vec![
                stored_account("tok-0", now),
                stored_account("tok-1", now),
                stored_account("tok-2", now),
            ],
            0,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        assert_eq!(
            get_runtime_tracker_key(manager.get_account_by_index_mut(1).unwrap()),
            TrackerKey::Number(1)
        );
        assert_eq!(
            get_runtime_tracker_key(manager.get_account_by_index_mut(2).unwrap()),
            TrackerKey::Number(2)
        );

        assert!(manager.remove_account_by_index(0));

        // Cached numeric keys were invalidated and re-derive from the NEW
        // positions.
        assert_eq!(manager.accounts[0].runtime.runtime_tracker_key, None);
        assert_eq!(
            get_runtime_tracker_key(manager.get_account_by_index_mut(0).unwrap()),
            TrackerKey::Number(0)
        );
        assert_eq!(
            get_runtime_tracker_key(manager.get_account_by_index_mut(1).unwrap()),
            TrackerKey::Number(1)
        );
    }

    #[test]
    #[serial(volatile)]
    fn remove_returns_false_for_out_of_range_index() {
        reset_volatile();
        let now = now_ms();
        let stored = storage_of(vec![stored_account("token-1", now)], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        assert!(!manager.remove_account_by_index(999));
        assert!(!manager.remove_account_by_index(-1));
        assert_eq!(manager.get_account_count(), 1);
    }

    #[test]
    #[serial(volatile)]
    fn handles_removing_the_last_account() {
        reset_volatile();
        let now = now_ms();
        let stored = storage_of(vec![stored_account("token-1", now)], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        assert!(manager.remove_account_by_index(0));
        assert_eq!(manager.get_account_count(), 0);
        assert!(manager.get_current_account().is_none());
        for family in MODEL_FAMILIES {
            assert_eq!(manager.cursor_by_family.get(family), 0);
            assert_eq!(manager.current_account_index_by_family.get(family), -1);
        }
    }

    #[test]
    #[serial(volatile)]
    fn adjusts_cursor_when_removing_account_before_cursor_position() {
        reset_volatile();
        let now = now_ms();
        let stored = storage_of(
            vec![
                stored_account("token-1", now),
                stored_account("token-2", now),
                stored_account("token-3", now),
            ],
            0,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        for family in MODEL_FAMILIES {
            manager.cursor_by_family.set(family, 2);
            manager.current_account_index_by_family.set(family, 2);
        }

        assert!(manager.remove_account_by_index(0));

        for family in MODEL_FAMILIES {
            assert_eq!(manager.cursor_by_family.get(family), 1);
            assert_eq!(manager.current_account_index_by_family.get(family), 1);
        }
        assert_eq!(
            manager
                .get_current_account()
                .map(|a| a.meta.refresh_token.clone()),
            Some("token-3".to_string())
        );
    }

    #[test]
    #[serial(volatile)]
    fn advances_active_pointer_to_next_enabled_when_active_slot_removed_at_end() {
        reset_volatile();
        let now = now_ms();
        let stored = storage_of(
            vec![
                stored_account("token-1", now),
                stored_account("token-2", now),
                stored_account("token-3", now),
            ],
            2,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        assert_eq!(
            manager
                .get_current_account()
                .map(|a| a.meta.refresh_token.clone()),
            Some("token-3".to_string())
        );
        assert!(manager.remove_account_by_index(2));
        assert_eq!(manager.get_account_count(), 2);
        // Pointer references a valid enabled account, not -1: the removed
        // slot re-resolves via findNextEnabled(min(idx, len-1)) → index 1.
        let after = manager.get_active_index();
        assert_eq!(after, 1);
        assert_eq!(
            manager
                .get_current_account()
                .map(|a| a.meta.refresh_token.clone()),
            Some("token-2".to_string())
        );
    }

    #[test]
    #[serial(volatile)]
    fn yields_no_routable_account_when_every_remaining_account_is_disabled() {
        reset_volatile();
        let now = now_ms();
        let mut disabled_1 = stored_account("token-1", now);
        disabled_1.enabled = Some(false);
        let active = stored_account("token-2", now);
        let mut disabled_2 = stored_account("token-3", now);
        disabled_2.enabled = Some(false);
        let stored = storage_of(vec![disabled_1, active, disabled_2], 1);
        let mut manager = AccountManager::new(None, Some(&stored));

        assert!(manager.remove_account_by_index(1));
        assert_eq!(manager.get_active_index(), -1);
        // No successor is stamped when nothing is enabled (HI-04 sibling
        // assertion).
        assert!(
            manager
                .get_accounts_snapshot()
                .iter()
                .all(|account| account.meta.last_switch_reason != Some(SwitchReason::Rotation))
        );
    }

    #[test]
    #[serial(volatile)]
    fn does_not_perturb_unrelated_family_pointers_on_removal() {
        reset_volatile();
        let now = now_ms();
        let stored = storage_of(
            vec![
                stored_account("token-1", now),
                stored_account("token-2", now),
                stored_account("token-3", now),
                stored_account("token-4", now),
            ],
            0,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        // codex points at the removed slot; gpt-5.2 points past it; gpt-5.1
        // points before it.
        manager
            .current_account_index_by_family
            .set(ModelFamily::Codex, 1);
        manager
            .current_account_index_by_family
            .set(ModelFamily::Gpt5_2, 3);
        manager
            .current_account_index_by_family
            .set(ModelFamily::Gpt5_1, 0);

        assert!(manager.remove_account_by_index(1));

        let active = |family: ModelFamily| manager.current_account_index_by_family.get(family);
        assert_eq!(active(ModelFamily::Codex), 1);
        // Past the removed index: shifted down by one.
        assert_eq!(active(ModelFamily::Gpt5_2), 2);
        // Before the removed index: untouched.
        assert_eq!(active(ModelFamily::Gpt5_1), 0);
    }

    // -- setAccountEnabled pointer repair (oracle F2) ------------------------

    #[test]
    fn disabling_repairs_active_and_cursor_pointers_in_lockstep() {
        let now = now_ms();
        let stored = storage_of(
            vec![
                stored_account("token-1", now),
                stored_account("token-2", now),
                stored_account("token-3", now),
            ],
            1,
        );
        let mut manager = AccountManager::new(None, Some(&stored));
        manager.set_account_enabled(1, false);
        for family in MODEL_FAMILIES {
            assert_eq!(manager.current_account_index_by_family.get(family), 2);
            assert_eq!(manager.cursor_by_family.get(family), 2);
        }
        // Families whose pointers did NOT reference the disabled index stay
        // put when only one family matched (multi-family variant).
        let mut manager = AccountManager::new(None, Some(&stored));
        manager
            .current_account_index_by_family
            .set(ModelFamily::Gpt5_1, 0);
        manager.set_account_enabled(1, false);
        assert_eq!(
            manager
                .current_account_index_by_family
                .get(ModelFamily::Gpt5_1),
            0
        );
    }

    // -- is_retryable_auth_persistence_error ---------------------------------

    #[test]
    fn retryable_auth_persistence_classification() {
        let ebusy = CodexError::storage("save failed", "EBUSY", "/x/a.json", "hint", None);
        assert!(is_retryable_auth_persistence_error(&ebusy));
        let enospc = CodexError::storage("save failed", "ENOSPC", "/x/a.json", "hint", None);
        assert!(!is_retryable_auth_persistence_error(&enospc));
        let rate_limited = CodexError::api("too many requests", 429);
        assert!(is_retryable_auth_persistence_error(&rate_limited));
        // Cause chain: an outer non-retryable error wrapping EPERM.
        let wrapped = CodexError::new("outer").with_cause(CodexError::storage(
            "inner", "EPERM", "/x/a.json", "hint", None,
        ));
        assert!(is_retryable_auth_persistence_error(&wrapped));
        let plain = CodexError::new("plain failure");
        assert!(!is_retryable_auth_persistence_error(&plain));
    }

    // -- commitRefreshedAuth (sandboxed storage transaction) -----------------

    #[tokio::test]
    #[serial(env)]
    async fn commit_refreshed_auth_persists_and_updates_the_live_account() {
        let _sandbox = EnvSandbox::new();
        let now = now_ms();
        let mut stored_row = stored_account("old-refresh", now);
        stored_row.email = Some("user@example.com".to_string());
        stored_row.enabled = Some(false);
        stored_row.cooling_down_until = Some(now + 60_000);
        stored_row.cooldown_reason =
            Some(cma_core::schemas::account_storage::CooldownReason::AuthFailure);
        let stored = storage_of(vec![stored_row], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        manager.get_account_by_index_mut(0).unwrap().increment_auth_failures();

        let access = make_jwt(&json!({
            "email": "user@example.com",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_refreshed" },
        }));
        let auth = auth(&access, "rotated-refresh", now + 3_600_000);
        let source = AccountIdentityCandidate {
            account_id: None,
            email: Some("user@example.com".to_string()),
            refresh_token: Some("old-refresh".to_string()),
            index: Some(0),
        };

        let live_index = manager
            .commit_refreshed_auth(&source, &auth)
            .await
            .expect("commit succeeds");
        assert_eq!(live_index, Some(0));

        let account = manager.get_account_by_index(0).expect("account");
        assert_eq!(account.meta.refresh_token, "rotated-refresh");
        assert_eq!(account.meta.access_token.as_deref(), Some(access.as_str()));
        assert_eq!(account.meta.expires_at, Some(now + 3_600_000));
        assert_eq!(account.meta.account_id.as_deref(), Some("acc_refreshed"));
        assert_eq!(account.meta.enabled, Some(true));
        assert_eq!(account.meta.cooling_down_until, None);
        assert_eq!(account.meta.cooldown_reason, None);
        assert_eq!(account.runtime.consecutive_auth_failures, Some(0));

        // The refreshed row reached disk (re-enabled: `enabled` omitted).
        let on_disk = load_accounts().await.expect("storage on disk").storage;
        assert_eq!(on_disk.accounts.len(), 1);
        assert_eq!(on_disk.accounts[0].refresh_token, "rotated-refresh");
        assert_eq!(on_disk.accounts[0].enabled, None);
        assert_eq!(on_disk.accounts[0].cooling_down_until, None);
    }

    #[tokio::test]
    #[serial(env)]
    async fn commit_refreshed_auth_returns_none_for_unresolvable_source() {
        let _sandbox = EnvSandbox::new();
        let now = now_ms();
        let stored = storage_of(vec![stored_account("some-refresh", now)], 0);
        let mut manager = AccountManager::new(None, Some(&stored));

        let auth = auth("opaque-access", "rotated-refresh", now + 3_600_000);
        let source = AccountIdentityCandidate {
            account_id: Some("acc_missing".to_string()),
            email: Some("missing@example.com".to_string()),
            refresh_token: Some("unknown-refresh".to_string()),
            index: Some(7),
        };
        let result = manager
            .commit_refreshed_auth(&source, &auth)
            .await
            .expect("commit resolves");
        assert_eq!(result, None);
        // The live pool is untouched.
        assert_eq!(
            manager.get_account_by_index(0).unwrap().meta.refresh_token,
            "some-refresh"
        );
    }

    // -- hydrateFromCodexCli / loadFromDisk (sandboxed) ----------------------

    fn write_cli_accounts(path: &std::path::Path, value: &Value) {
        std::fs::write(path, stringify_pretty2(value)).unwrap();
    }

    #[tokio::test]
    #[serial(env)]
    async fn hydrates_missing_access_tokens_from_codex_cli_cache() {
        let mut sandbox = EnvSandbox::new();
        let accounts_path = sandbox.root().join("cli-accounts.json");
        let auth_path = sandbox.root().join("cli-auth.json");
        let config_path = sandbox.root().join("cli-config.toml");
        sandbox.set_var("CODEX_CLI_ACCOUNTS_PATH", &accounts_path);
        sandbox.set_var("CODEX_CLI_AUTH_PATH", &auth_path);
        sandbox.set_var("CODEX_CLI_CONFIG_PATH", &config_path);
        sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
        cma_cli_mirror::state::clear_codex_cli_state_cache();

        let now = now_ms();
        let fresh_expiry = now + 3_600_000;
        write_cli_accounts(
            &accounts_path,
            &json!({
                "accounts": [
                    {
                        "accountId": "acc_cli",
                        "email": "cli@example.com",
                        "auth": { "tokens": {
                            "access_token": "cli-access",
                            "refresh_token": "cli-refresh",
                        }},
                        "expiresAt": fresh_expiry,
                    },
                    {
                        "accountId": "acc_stale",
                        "email": "stale@example.com",
                        "auth": { "tokens": {
                            "access_token": "stale-access",
                            "refresh_token": "stale-refresh",
                        }},
                        "expiresAt": now - 1_000,
                    },
                ],
            }),
        );

        // Managed pool: one account missing its access token, one whose cache
        // entry is expired.
        let mut needs_token = stored_account("local-refresh", now);
        needs_token.email = Some("cli@example.com".to_string());
        let mut stale = stored_account("stale-local-refresh", now);
        stale.email = Some("stale@example.com".to_string());
        let stored = storage_of(vec![needs_token, stale], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        manager.hydrate_from_codex_cli().await;

        let hydrated = manager.get_account_by_index(0).expect("account");
        assert_eq!(hydrated.meta.access_token.as_deref(), Some("cli-access"));
        assert_eq!(hydrated.meta.expires_at, Some(fresh_expiry));
        assert_eq!(hydrated.meta.account_id.as_deref(), Some("acc_cli"));
        assert_eq!(
            hydrated.meta.account_id_source,
            Some(AccountIdSource::Token)
        );
        // Expired cache entries are ignored entirely.
        let untouched = manager.get_account_by_index(1).expect("account");
        assert_eq!(untouched.meta.access_token, None);
        assert_eq!(untouched.meta.account_id, None);

        cma_cli_mirror::state::clear_codex_cli_state_cache();
    }

    #[tokio::test]
    #[serial(env)]
    async fn hydrate_never_overwrites_a_live_token() {
        let mut sandbox = EnvSandbox::new();
        let accounts_path = sandbox.root().join("cli-accounts.json");
        sandbox.set_var("CODEX_CLI_ACCOUNTS_PATH", &accounts_path);
        sandbox.set_var("CODEX_CLI_AUTH_PATH", sandbox.root().join("cli-auth.json"));
        sandbox.set_var(
            "CODEX_CLI_CONFIG_PATH",
            sandbox.root().join("cli-config.toml"),
        );
        sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
        cma_cli_mirror::state::clear_codex_cli_state_cache();

        let now = now_ms();
        write_cli_accounts(
            &accounts_path,
            &json!({
                "accounts": [{
                    "email": "live@example.com",
                    "auth": { "tokens": {
                        "access_token": "cli-access",
                        "refresh_token": "cli-refresh",
                    }},
                    "expiresAt": now + 3_600_000,
                }],
            }),
        );

        let mut live = stored_account("live-refresh", now);
        live.email = Some("live@example.com".to_string());
        live.access_token = Some("live-access".to_string());
        live.expires_at = Some(now + 1_800_000);
        let stored = storage_of(vec![live], 0);
        let mut manager = AccountManager::new(None, Some(&stored));
        manager.hydrate_from_codex_cli().await;

        let account = manager.get_account_by_index(0).expect("account");
        assert_eq!(account.meta.access_token.as_deref(), Some("live-access"));
        assert_eq!(account.meta.expires_at, Some(now + 1_800_000));

        cma_cli_mirror::state::clear_codex_cli_state_cache();
    }

    #[tokio::test]
    #[serial(env)]
    async fn load_from_disk_with_empty_dir_yields_empty_or_seeded_manager() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var(
            "CODEX_CLI_ACCOUNTS_PATH",
            sandbox.root().join("cli-accounts.json"),
        );
        sandbox.set_var("CODEX_CLI_AUTH_PATH", sandbox.root().join("cli-auth.json"));
        sandbox.set_var(
            "CODEX_CLI_CONFIG_PATH",
            sandbox.root().join("cli-config.toml"),
        );
        cma_cli_mirror::state::clear_codex_cli_state_cache();

        let manager = AccountManager::load_from_disk(None).await;
        assert_eq!(manager.get_account_count(), 0);
        assert_eq!(manager.get_active_index(), -1);

        let seeded_auth = auth("access-token", "seed-refresh", now_ms() + 60_000);
        let manager = AccountManager::load_from_disk(Some(&seeded_auth)).await;
        assert_eq!(manager.get_account_count(), 1);
        assert_eq!(
            manager.get_current_account().unwrap().meta.refresh_token,
            "seed-refresh"
        );

        cma_cli_mirror::state::clear_codex_cli_state_cache();
    }
}
