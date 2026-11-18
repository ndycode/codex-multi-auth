//! Port of the SELECTION half of `lib/accounts.ts` (spec 03 §1.6):
//! round-robin (`get_current_or_next_for_family` / `get_next_for_family`),
//! sequential drain-first with policy block-sets (#509), hybrid delegation to
//! `cma_rotation::selector`, availability checks (with MUTATING lazy expiry of
//! rate limits), runtime skip reasons, and per-family minimum wait times.
//!
//! Extends `crate::manager::AccountManager` (state + core half live there;
//! persistence half in `crate::manager_persistence`). Rate-limit primitives
//! come from `crate::rate_limits` via the [`RateLimitedEntity`] trait that
//! `ManagedAccount` implements.
//!
//! # Selection contracts (spec 03 gotchas 6–11)
//!
//! - `get_next_for_family` is IDENTICAL to `get_current_or_next_for_family`
//!   except it does NOT commit `current_account_index_by_family` (peek-next).
//!   Deliberate — do not merge the two (gotcha 7).
//! - The sequential selector NEVER advances on every pick (#509): it sticks
//!   to the active account while usable, and its recovery scan starts AT the
//!   active index (not active+1) so a recovered earlier account reclaims the
//!   slot on wrap-around. `blocked_indexes` (the request's policy block set)
//!   is treated as unusable so the sticky pointer never anchors on a
//!   policy-blocked account (#509 review P1).
//! - Cursor lockstep (HI-02): every commit here sets
//!   `cursor = (index + 1) % count`.
//! - Availability checks MUTATE: expired rate-limit windows are deleted and
//!   expired cooldowns self-clear during evaluation (gotchas 11/12). The
//!   `&&`/`||` chains short-circuit exactly like the TS (`is_cooling_down` is
//!   not consulted — and does not self-clear — when the account is already
//!   rate-limited).
//! - Hybrid selection delegates scoring to
//!   `cma_rotation::selector::select_hybrid_account` and returns `None` when
//!   nothing is available (AUDIT-H2/D-01).

use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{CooldownReason, SwitchReason};
use cma_core::utils::now_ms;
use cma_rotation::circuit_breaker::get_circuit_breaker;
use cma_rotation::routing_mutex::{SelectionRecord, with_routing_mutex};
use cma_rotation::selector::{
    AccountWithMetrics, HybridSelectionOptions, SelectHybridAccountParams, select_hybrid_account,
};
use cma_rotation::trackers::{DEFAULT_DRAIN_AMOUNT, get_health_tracker, get_token_tracker};
use std::collections::HashSet;

use crate::manager::{
    AccountManager, FamilyStateMap, ManagedAccount, get_account_circuit_key,
    get_runtime_tracker_key,
};
use crate::rate_limits::{self, RateLimitedEntity};

/// Circuit availability for an account (pure read on the breaker; the key
/// itself is the sticky cached circuit key from `crate::manager`).
fn circuit_is_available(account: &mut ManagedAccount) -> bool {
    get_circuit_breaker(&get_account_circuit_key(account), None).is_available()
}

/// The shared usable-account predicate of the round-robin selectors and the
/// availability check: enabled → workspaces → (MUTATING) expired-window clear
/// → not rate-limited && not cooling down && circuit available.
fn account_selectable(
    account: &mut ManagedAccount,
    family: ModelFamily,
    model: Option<&str>,
) -> bool {
    if !account.is_enabled() {
        return false;
    }
    if !account.has_enabled_workspaces() {
        return false;
    }
    rate_limits::clear_expired_rate_limits(account);
    !rate_limits::is_rate_limited_for_family(account, family, model)
        && !account.is_cooling_down()
        && circuit_is_available(account)
}

/// The sequential selector's `isUsable` (#509): like [`account_selectable`]
/// but with the policy block-set consulted between the enabled and workspace
/// checks (TS order). Uses `account.index` — the ORIGINAL storage position —
/// not the array slot (spec gotcha 14).
fn sequential_usable(
    account: &mut ManagedAccount,
    family: ModelFamily,
    model: Option<&str>,
    blocked_indexes: Option<&HashSet<usize>>,
) -> bool {
    if !account.is_enabled() {
        return false;
    }
    if let Some(blocked) = blocked_indexes
        && blocked.contains(&account.index)
    {
        return false;
    }
    if !account.has_enabled_workspaces() {
        return false;
    }
    rate_limits::clear_expired_rate_limits(account);
    !rate_limits::is_rate_limited_for_family(account, family, model)
        && !account.is_cooling_down()
        && circuit_is_available(account)
}

/// Family-map access seams (TS `Record<ModelFamily, number>`): keep every
/// read/write in this file behind these two helpers plus `FamilyStateMap::set`
/// so a change to the manager's family-state representation touches only this
/// spot.
fn family_cursor(map: &FamilyStateMap, family: ModelFamily) -> i64 {
    map.get(family)
}

fn family_active(map: &FamilyStateMap, family: ModelFamily) -> i64 {
    map.get(family)
}

/// The TS quota-key expression `` model ? `${family}:${model}` : family ``
/// used by every tracker interaction (an empty model string is FALSY in TS →
/// base key).
fn selection_quota_key(family: ModelFamily, model: Option<&str>) -> String {
    match model {
        Some(model) if !model.is_empty() => format!("{}:{model}", family.as_str()),
        _ => family.as_str().to_string(),
    }
}

/// Bounds-checked pool array slot for an `i64` index (the TS methods take the
/// live account OBJECT; the Rust port addresses pool members by position,
/// matching `get_account_by_index`).
fn pool_slot(index: i64, count: usize) -> Option<usize> {
    if index < 0 || index as usize >= count {
        None
    } else {
        Some(index as usize)
    }
}

/// Optional context threaded into [`AccountManager::mark_switched_locked`]
/// (TS `{ trackerKeyQuota?: string; score?: number }`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MarkSwitchedContext {
    /// Quota tracker key (e.g. `"codex"` or `"codex:gpt-5-codex"`).
    pub tracker_key_quota: Option<String>,
    /// Final hybrid score used during selection.
    pub score: Option<f64>,
}

impl AccountManager {
    /// TS `isAccountAvailableForFamily` — `false` for missing/disabled/
    /// workspace-less/rate-limited/cooling/circuit-open accounts. MUTATES:
    /// clears expired rate-limit windows (spec gotcha 11).
    pub fn is_account_available_for_family(
        &mut self,
        index: i64,
        family: ModelFamily,
        model: Option<&str>,
    ) -> bool {
        if index < 0 || index as usize >= self.accounts.len() {
            return false;
        }
        let account = &mut self.accounts[index as usize];
        account_selectable(account, family, model)
    }

    /// TS `getAccountRuntimeSkipReason` — first of `"missing"`, `"disabled"`,
    /// `"workspace-disabled"`, `"rate-limited"`,
    /// `"cooling-down:<reason>"`/`"cooling-down"`, `"circuit-open"`, else
    /// `None`. The strings are a de-facto contract with observability/UI
    /// (spec 03 §13). Also mutates via the expired-window clear.
    pub fn get_account_runtime_skip_reason(
        &mut self,
        index: i64,
        family: ModelFamily,
        model: Option<&str>,
    ) -> Option<String> {
        if index < 0 || index as usize >= self.accounts.len() {
            return Some("missing".to_string());
        }
        let account = &mut self.accounts[index as usize];
        if !account.is_enabled() {
            return Some("disabled".to_string());
        }
        if !account.has_enabled_workspaces() {
            return Some("workspace-disabled".to_string());
        }
        rate_limits::clear_expired_rate_limits(account);
        if rate_limits::is_rate_limited_for_family(account, family, model) {
            return Some("rate-limited".to_string());
        }
        if account.is_cooling_down() {
            return Some(match account.meta.cooldown_reason {
                Some(reason) => format!("cooling-down:{}", reason.as_str()),
                None => "cooling-down".to_string(),
            });
        }
        if !circuit_is_available(account) {
            return Some("circuit-open".to_string());
        }
        None
    }

    /// TS `getCurrentOrNext` = `getCurrentOrNextForFamily("codex")`.
    pub fn get_current_or_next(&mut self) -> Option<&ManagedAccount> {
        self.get_current_or_next_for_family(ModelFamily::Codex, None)
    }

    /// TS `getCurrentOrNextForFamily` — round-robin from the family cursor:
    /// the first selectable account wins; on pick the cursor advances to
    /// `idx+1`, the active pointer commits to `idx`, and `last_used` stamps.
    pub fn get_current_or_next_for_family(
        &mut self,
        family: ModelFamily,
        model: Option<&str>,
    ) -> Option<&ManagedAccount> {
        let count = self.accounts.len();
        if count == 0 {
            return None;
        }
        let cursor = family_cursor(&self.cursor_by_family, family).rem_euclid(count as i64) as usize;
        for i in 0..count {
            let idx = (cursor + i) % count;
            let account = &mut self.accounts[idx];
            if !account_selectable(account, family, model) {
                continue;
            }
            self.cursor_by_family.set(family, ((idx + 1) % count) as i64);
            self.current_account_index_by_family.set(family, idx as i64);
            self.accounts[idx].meta.last_used = now_ms();
            return self.accounts.get(idx);
        }
        None
    }

    /// TS `getNextForFamily` — IDENTICAL loop to
    /// [`Self::get_current_or_next_for_family`] except it does NOT update the
    /// active pointer (only cursor + `last_used`). Deliberate: peek-next
    /// without committing (spec gotcha 7).
    pub fn get_next_for_family(
        &mut self,
        family: ModelFamily,
        model: Option<&str>,
    ) -> Option<&ManagedAccount> {
        let count = self.accounts.len();
        if count == 0 {
            return None;
        }
        let cursor = family_cursor(&self.cursor_by_family, family).rem_euclid(count as i64) as usize;
        for i in 0..count {
            let idx = (cursor + i) % count;
            let account = &mut self.accounts[idx];
            if !account_selectable(account, family, model) {
                continue;
            }
            self.cursor_by_family.set(family, ((idx + 1) % count) as i64);
            self.accounts[idx].meta.last_used = now_ms();
            return self.accounts.get(idx);
        }
        None
    }

    /// TS `getCurrentOrNextForFamilySequential` — drain-first (#509).
    ///
    /// Sticky phase: while the family's active account is usable it is
    /// returned WITHOUT moving cursor or pointer. Scan phase: only when the
    /// active account is exhausted, scan forward FROM the active index
    /// (wrapping) for the next usable account and pin it as the new active
    /// account. `blocked_indexes` is the request's policy block set (paused /
    /// drained / capability-blocked account indexes from
    /// `RuntimePolicyDecision.blockedAccountIndexes`).
    pub fn get_current_or_next_for_family_sequential(
        &mut self,
        family: ModelFamily,
        model: Option<&str>,
        blocked_indexes: Option<&HashSet<usize>>,
    ) -> Option<&ManagedAccount> {
        let count = self.accounts.len();
        if count == 0 {
            return None;
        }

        // Sticky: stay on the current active account while it is still usable
        // so we drain it fully before moving on.
        let active_index = family_active(&self.current_account_index_by_family, family);
        if active_index >= 0 && (active_index as usize) < count {
            let idx = active_index as usize;
            let account = &mut self.accounts[idx];
            if sequential_usable(account, family, model, blocked_indexes) {
                account.meta.last_used = now_ms();
                return self.accounts.get(idx);
            }
        }

        // Active account is exhausted (or none set): scan forward from the
        // active index, wrapping, and pin the first usable account. Starting
        // AT the active index (not active+1) lets a recovered earlier account
        // reclaim the active slot on wrap-around.
        let start = if active_index >= 0 && (active_index as usize) < count {
            active_index as usize
        } else {
            0
        };
        for i in 0..count {
            let idx = (start + i) % count;
            let account = &mut self.accounts[idx];
            if !sequential_usable(account, family, model, blocked_indexes) {
                continue;
            }
            self.current_account_index_by_family.set(family, idx as i64);
            self.cursor_by_family.set(family, ((idx + 1) % count) as i64);
            self.accounts[idx].meta.last_used = now_ms();
            return self.accounts.get(idx);
        }

        None
    }

    /// TS `getCurrentOrNextForFamilyHybrid` — builds `AccountWithMetrics`
    /// from ALL enabled/workspace-eligible accounts (unavailable ones are
    /// included with `is_available: false`) and delegates the scoring to
    /// `cma_rotation::selector::select_hybrid_account`.
    pub fn get_current_or_next_for_family_hybrid(
        &mut self,
        family: ModelFamily,
        model: Option<&str>,
        options: Option<HybridSelectionOptions>,
    ) -> Option<&ManagedAccount> {
        let count = self.accounts.len();
        if count == 0 {
            return None;
        }

        let quota_key = selection_quota_key(family, model);
        let health_tracker = get_health_tracker(None);
        let token_tracker = get_token_tracker(None);

        let mut accounts_with_metrics: Vec<AccountWithMetrics> = Vec::new();
        for account in self.accounts.iter_mut() {
            if !account.is_enabled() {
                continue;
            }
            if !account.has_enabled_workspaces() {
                continue;
            }
            rate_limits::clear_expired_rate_limits(account);
            let is_available = !rate_limits::is_rate_limited_for_family(account, family, model)
                && !account.is_cooling_down()
                && circuit_is_available(account);
            accounts_with_metrics.push(AccountWithMetrics {
                index: account.index,
                tracker_key: Some(get_runtime_tracker_key(account)),
                is_available,
                last_used: account.meta.last_used,
            });
        }

        let selected = select_hybrid_account(SelectHybridAccountParams {
            accounts: &accounts_with_metrics,
            health_tracker,
            token_tracker,
            quota_key: Some(&quota_key),
            config: Default::default(),
            options: options.unwrap_or_default(),
        })?;

        // TS looks up `this.accounts[selected.index]` (the pool-index FIELD)
        // and commits pointers from `account.index` — port verbatim.
        let account = self.accounts.get_mut(selected.index)?;
        let account_index = account.index;
        account.meta.last_used = now_ms();
        self.current_account_index_by_family
            .set(family, account_index as i64);
        self.cursor_by_family
            .set(family, ((account_index + 1) % count) as i64);
        self.accounts.get(selected.index)
    }

    /// TS `getMinWaitTime` = `getMinWaitTimeForFamily("codex")`.
    pub fn get_min_wait_time(&mut self) -> i64 {
        self.get_min_wait_time_for_family(ModelFamily::Codex, None)
    }

    /// TS `getMinWaitTimeForFamily` — `0` when any enabled account is
    /// available (or when none are enabled); otherwise the minimum over
    /// enabled accounts of each account's LAST blocker to clear
    /// (max of base-window, model-window, cooldown remainder, breaker wait).
    pub fn get_min_wait_time_for_family(
        &mut self,
        family: ModelFamily,
        model: Option<&str>,
    ) -> i64 {
        let now = now_ms();

        // Availability pass — evaluated for EVERY enabled account (the TS
        // `.filter` runs the mutating predicate on each; no early exit).
        let mut any_enabled = false;
        let mut any_available = false;
        for account in self.accounts.iter_mut() {
            if !account.is_enabled() {
                continue;
            }
            any_enabled = true;
            rate_limits::clear_expired_rate_limits(account);
            let available = !rate_limits::is_rate_limited_for_family(account, family, model)
                && !account.is_cooling_down()
                && circuit_is_available(account);
            if available {
                any_available = true;
            }
        }
        if any_available {
            return 0;
        }
        if !any_enabled {
            return 0;
        }

        let base_key = rate_limits::get_quota_key(family, None);
        let model_key = model.map(|model| rate_limits::get_quota_key(family, Some(model)));

        let mut wait_times: Vec<i64> = Vec::new();
        for account in self.accounts.iter_mut() {
            if !account.is_enabled() {
                continue;
            }
            let mut per_account_wait_times: Vec<i64> = Vec::new();
            if let Some(base_reset_at) = account.rate_limit_reset_times().get(&base_key) {
                per_account_wait_times.push((base_reset_at - now).max(0));
            }
            if let Some(model_key) = &model_key
                && let Some(model_reset_at) = account.rate_limit_reset_times().get(model_key)
            {
                per_account_wait_times.push((model_reset_at - now).max(0));
            }
            if let Some(cooling_down_until) = account.meta.cooling_down_until {
                per_account_wait_times.push((cooling_down_until - now).max(0));
            }
            let breaker_wait = get_circuit_breaker(&get_account_circuit_key(account), None)
                .get_time_until_available();
            if breaker_wait > 0 {
                per_account_wait_times.push(breaker_wait);
            }
            if let Some(max_wait) = per_account_wait_times.iter().copied().max() {
                wait_times.push(max_wait);
            }
        }

        wait_times.into_iter().min().unwrap_or(0)
    }
}

// ============================================================================
// Tracker interactions + routing-mutex wrappers (TS recordSuccess /
// recordRateLimit / recordFailure / consumeToken / refundToken /
// markSwitched / markSwitchedLocked / markAccountCoolingDownLocked /
// setActiveIndexLocked)
// ============================================================================

impl AccountManager {
    /// TS `recordSuccess(account, family, model?)` — health `+1` under the
    /// quota key, cooldown/auth-failure healing, circuit-breaker success.
    ///
    /// Healing (spec 03 §1.6): the pre-check metadata is captured BEFORE
    /// `is_cooling_down` (which may itself lazily clear an expired cooldown);
    /// only a NOT-currently-cooling account heals.
    ///
    /// Returns `true` when healing occurred. The TS method then called
    /// `saveToDiskDebounced()`; in the Rust split the debounce surface lives
    /// on `SharedAccountManager` (manager_persistence.rs), so callers holding
    /// the shared handle schedule `save_to_disk_debounced(500)` when this
    /// returns `true` — the same plain-method/shared-wrapper split already
    /// used by `clear_account_transient_state`.
    pub fn record_success(&mut self, index: i64, family: ModelFamily, model: Option<&str>) -> bool {
        let Some(idx) = pool_slot(index, self.accounts.len()) else {
            return false;
        };
        let quota_key = selection_quota_key(family, model);
        let account = &mut self.accounts[idx];
        get_health_tracker(None).record_success(get_runtime_tracker_key(account), Some(&quota_key));

        let had_cooldown_metadata =
            account.meta.cooling_down_until.is_some() || account.meta.cooldown_reason.is_some();
        let had_auth_failures = account.runtime.consecutive_auth_failures.unwrap_or(0) > 0;
        let is_cooling_down = account.is_cooling_down();
        let mut healed = false;

        if !is_cooling_down && had_cooldown_metadata {
            account.clear_cooldown();
            healed = true;
        }
        if !is_cooling_down && had_auth_failures {
            account.clear_auth_failures();
            healed = true;
        }

        get_circuit_breaker(&get_account_circuit_key(account), None).record_success();
        healed
    }

    /// TS `recordRateLimit(account, family, model?)` — health `-10` and a
    /// token-bucket drain under the quota key. No circuit interaction, no
    /// persistence.
    pub fn record_rate_limit(&mut self, index: i64, family: ModelFamily, model: Option<&str>) {
        let Some(idx) = pool_slot(index, self.accounts.len()) else {
            return;
        };
        let quota_key = selection_quota_key(family, model);
        let tracker_key = get_runtime_tracker_key(&mut self.accounts[idx]);
        get_health_tracker(None).record_rate_limit(tracker_key.clone(), Some(&quota_key));
        get_token_tracker(None).drain(tracker_key, Some(&quota_key), DEFAULT_DRAIN_AMOUNT);
    }

    /// TS `recordFailure(account, family, model?)` — health `-20` under the
    /// quota key plus a circuit-breaker failure.
    pub fn record_failure(&mut self, index: i64, family: ModelFamily, model: Option<&str>) {
        let Some(idx) = pool_slot(index, self.accounts.len()) else {
            return;
        };
        let quota_key = selection_quota_key(family, model);
        let account = &mut self.accounts[idx];
        get_health_tracker(None).record_failure(get_runtime_tracker_key(account), Some(&quota_key));
        get_circuit_breaker(&get_account_circuit_key(account), None).record_failure();
    }

    /// TS `consumeToken(account, family, model?)` — try-consume from the
    /// per-process token bucket; when the account's circuit is OPEN
    /// (`can_execute` errors) the token is refunded and the call reports
    /// `false`. Token buckets are per-process and MUST NOT be persisted
    /// (spec gotcha 2 / the 6.4.0 regression).
    pub fn consume_token(&mut self, index: i64, family: ModelFamily, model: Option<&str>) -> bool {
        let Some(idx) = pool_slot(index, self.accounts.len()) else {
            return false;
        };
        let quota_key = selection_quota_key(family, model);
        let (tracker_key, circuit_key) = {
            let account = &mut self.accounts[idx];
            (
                get_runtime_tracker_key(account),
                get_account_circuit_key(account),
            )
        };
        let token_tracker = get_token_tracker(None);
        if !token_tracker.try_consume(tracker_key.clone(), Some(&quota_key)) {
            return false;
        }
        match get_circuit_breaker(&circuit_key, None).can_execute() {
            Ok(_) => true,
            Err(_) => {
                token_tracker.refund_token(tracker_key, Some(&quota_key));
                false
            }
        }
    }

    /// TS `refundToken(account, family, model?)` — refund a token consumed
    /// within the refund window. For network errors, not rate limits.
    /// Returns `true` when a valid in-window consumption was refunded.
    pub fn refund_token(&mut self, index: i64, family: ModelFamily, model: Option<&str>) -> bool {
        let Some(idx) = pool_slot(index, self.accounts.len()) else {
            return false;
        };
        let quota_key = selection_quota_key(family, model);
        let tracker_key = get_runtime_tracker_key(&mut self.accounts[idx]);
        get_token_tracker(None).refund_token(tracker_key, Some(&quota_key))
    }

    /// TS `markSwitched(account, reason, family)` — stamp
    /// `lastSwitchReason`, commit the family's active pointer to
    /// `account.index` and (HI-02) keep the cursor in lockstep at
    /// `(account.index + 1) % count` so round-robin resumes AFTER the
    /// just-switched account. Returns `false` for an out-of-range index.
    pub fn mark_switched(&mut self, index: i64, reason: SwitchReason, family: ModelFamily) -> bool {
        let count = self.accounts.len();
        let Some(idx) = pool_slot(index, count) else {
            return false;
        };
        let account = &mut self.accounts[idx];
        account.meta.last_switch_reason = Some(reason);
        let account_index = account.index;
        self.current_account_index_by_family
            .set(family, account_index as i64);
        if count > 0 {
            self.cursor_by_family
                .set(family, ((account_index + 1) % count) as i64);
        }
        true
    }

    /// TS `markSwitchedLocked(account, reason, family, context?)` — the
    /// mutex-serialized variant of [`Self::mark_switched`] (PR-N / R4).
    /// Serialized through the shared routing mutex when the pool's mode is
    /// `enabled`; `legacy` runs inline. Returns a [`SelectionRecord`]
    /// describing the decision (`None` only for an out-of-range index, which
    /// the TS could not express).
    pub async fn mark_switched_locked(
        &mut self,
        index: i64,
        reason: SwitchReason,
        family: ModelFamily,
        context: Option<MarkSwitchedContext>,
    ) -> Option<SelectionRecord> {
        let mode = self.routing_mutex_mode;
        let this = &mut *self;
        with_routing_mutex(mode, move || async move {
            let count = this.accounts.len();
            let idx = pool_slot(index, count)?;
            let account = &mut this.accounts[idx];
            account.meta.last_switch_reason = Some(reason);
            let account_index = account.index;
            this.current_account_index_by_family
                .set(family, account_index as i64);
            // HI-02: cursor lockstep, matching the legacy `mark_switched`.
            if count > 0 {
                this.cursor_by_family
                    .set(family, ((account_index + 1) % count) as i64);
            }
            let tracker_key = get_runtime_tracker_key(&mut this.accounts[idx]);
            let account = &this.accounts[idx];
            let account_id = account
                .meta
                .account_id
                .clone()
                .or_else(|| account.meta.email.clone())
                .unwrap_or_else(|| tracker_key.normalized());
            let tracker_key_quota = context
                .as_ref()
                .and_then(|context| context.tracker_key_quota.clone());
            let health =
                get_health_tracker(None).get_score(tracker_key.clone(), tracker_key_quota.as_deref());
            let tokens =
                get_token_tracker(None).get_tokens(tracker_key, tracker_key_quota.as_deref());
            Some(SelectionRecord {
                account_index,
                account_id,
                reason,
                timestamp: now_ms(),
                tracker_key_quota,
                health: Some(health),
                tokens: Some(tokens),
                score: context.and_then(|context| context.score),
            })
        })
        .await
    }

    /// TS `markAccountCoolingDownLocked(account, cooldownMs, reason)` — the
    /// mutex-serialized variant of `mark_account_cooling_down` (PR-N / R4).
    /// Returns `false` for an out-of-range index.
    pub async fn mark_account_cooling_down_locked(
        &mut self,
        index: i64,
        cooldown_ms: i64,
        reason: CooldownReason,
    ) -> bool {
        let mode = self.routing_mutex_mode;
        let this = &mut *self;
        with_routing_mutex(mode, move || async move {
            let Some(idx) = pool_slot(index, this.accounts.len()) else {
                return false;
            };
            this.accounts[idx].mark_cooling_down(cooldown_ms, reason);
            true
        })
        .await
    }

    /// TS `setActiveIndexLocked(index)` — the mutex-serialized variant of
    /// `set_active_index` (PR-N / R4). Returns the newly active account on
    /// success, or `None` when the index is out of range / disabled
    /// (matching the sync semantics).
    pub async fn set_active_index_locked(&mut self, index: i64) -> Option<&ManagedAccount> {
        let mode = self.routing_mutex_mode;
        let selected = {
            let this = &mut *self;
            with_routing_mutex(mode, move || async move {
                this.set_active_index(index).is_some()
            })
            .await
        };
        if selected {
            self.accounts.get(index as usize)
        } else {
            None
        }
    }
}

// ============================================================================
// Tests — ported from test/accounts.test.ts (selection + availability +
// min-wait + #509 sequential suites). All tests touch the process-global
// tracker/circuit singletons → #[serial].
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::model_family::MODEL_FAMILIES;
    use cma_core::schemas::account_storage::{
        AccountMetadataV3, AccountStorageV3, CooldownReason, RateLimitStateV3, Workspace,
    };
    use cma_rotation::circuit_breaker::clear_circuit_breakers;
    use cma_rotation::trackers::reset_trackers;
    use serial_test::serial;

    fn stored_account(refresh: &str, now: i64) -> AccountMetadataV3 {
        AccountMetadataV3::new(refresh, now, now)
    }

    fn storage_with(accounts: Vec<AccountMetadataV3>) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts = accounts;
        storage
    }

    fn manager_from(accounts: Vec<AccountMetadataV3>) -> AccountManager {
        AccountManager::new(None, Some(&storage_with(accounts)))
    }

    fn rate_limits_map(entries: &[(&str, i64)]) -> RateLimitStateV3 {
        let mut map = RateLimitStateV3::new();
        for (key, value) in entries {
            map.insert(*key, *value);
        }
        map
    }

    fn reset_globals() {
        reset_trackers();
        clear_circuit_breakers();
    }

    fn active(manager: &AccountManager, family: ModelFamily) -> i64 {
        family_active(&manager.current_account_index_by_family, family)
    }

    fn cursor(manager: &AccountManager, family: ModelFamily) -> i64 {
        family_cursor(&manager.cursor_by_family, family)
    }

    #[test]
    #[serial]
    fn checks_account_availability_by_enabled_rate_limit_cooldown_state() {
        reset_globals();
        let now = now_ms();
        let mut disabled = stored_account("token-1", now);
        disabled.enabled = Some(false);
        let mut rate_limited = stored_account("token-2", now);
        rate_limited.rate_limit_reset_times = Some(rate_limits_map(&[("codex", now + 60_000)]));
        let mut cooling = stored_account("token-3", now);
        cooling.cooling_down_until = Some(now + 60_000);
        cooling.cooldown_reason = Some(CooldownReason::NetworkError);
        let free = stored_account("token-4", now);

        let mut manager = manager_from(vec![disabled, rate_limited, cooling, free]);

        assert!(!manager.is_account_available_for_family(0, ModelFamily::Codex, None));
        assert!(!manager.is_account_available_for_family(1, ModelFamily::Codex, None));
        assert!(!manager.is_account_available_for_family(2, ModelFamily::Codex, None));
        assert!(manager.is_account_available_for_family(3, ModelFamily::Codex, None));
    }

    #[test]
    #[serial]
    fn skip_reasons_match_the_contract_strings() {
        reset_globals();
        let now = now_ms();
        let mut disabled = stored_account("skip-1", now);
        disabled.enabled = Some(false);
        let mut rate_limited = stored_account("skip-2", now);
        rate_limited.rate_limit_reset_times = Some(rate_limits_map(&[("codex", now + 60_000)]));
        let mut cooling = stored_account("skip-3", now);
        cooling.cooling_down_until = Some(now + 60_000);
        cooling.cooldown_reason = Some(CooldownReason::AuthFailure);
        let mut workspace_disabled = stored_account("skip-4", now);
        workspace_disabled.workspaces = Some(vec![Workspace {
            id: "ws-1".to_string(),
            name: None,
            enabled: false,
            disabled_at: None,
            is_default: None,
        }]);
        let free = stored_account("skip-5", now);

        let mut manager =
            manager_from(vec![disabled, rate_limited, cooling, workspace_disabled, free]);

        assert_eq!(
            manager.get_account_runtime_skip_reason(-1, ModelFamily::Codex, None),
            Some("missing".to_string())
        );
        assert_eq!(
            manager.get_account_runtime_skip_reason(99, ModelFamily::Codex, None),
            Some("missing".to_string())
        );
        assert_eq!(
            manager.get_account_runtime_skip_reason(0, ModelFamily::Codex, None),
            Some("disabled".to_string())
        );
        assert_eq!(
            manager.get_account_runtime_skip_reason(1, ModelFamily::Codex, None),
            Some("rate-limited".to_string())
        );
        assert_eq!(
            manager.get_account_runtime_skip_reason(2, ModelFamily::Codex, None),
            Some("cooling-down:auth-failure".to_string())
        );
        assert_eq!(
            manager.get_account_runtime_skip_reason(3, ModelFamily::Codex, None),
            Some("workspace-disabled".to_string())
        );
        assert_eq!(
            manager.get_account_runtime_skip_reason(4, ModelFamily::Codex, None),
            None
        );

        // circuit-open: trip the free account's breaker (3 failures).
        let key = get_account_circuit_key(&mut manager.accounts[4]);
        let breaker = get_circuit_breaker(&key, None);
        breaker.record_failure();
        breaker.record_failure();
        breaker.record_failure();
        assert_eq!(
            manager.get_account_runtime_skip_reason(4, ModelFamily::Codex, None),
            Some("circuit-open".to_string())
        );
    }

    #[test]
    #[serial]
    fn treats_accounts_with_all_tracked_workspaces_disabled_as_unavailable() {
        reset_globals();
        let now = now_ms();
        let mut workspace_disabled = stored_account("token-workspace-disabled", now);
        workspace_disabled.workspaces = Some(vec![
            Workspace {
                id: "workspace-1".to_string(),
                name: Some("Workspace 1".to_string()),
                enabled: false,
                disabled_at: None,
                is_default: None,
            },
            Workspace {
                id: "workspace-2".to_string(),
                name: Some("Workspace 2".to_string()),
                enabled: false,
                disabled_at: None,
                is_default: None,
            },
        ]);
        workspace_disabled.current_workspace_index = Some(0);
        let mut ready = stored_account("token-ready", now);
        ready.last_used = now - 10_000;

        let mut manager = manager_from(vec![workspace_disabled, ready]);

        assert!(!manager.is_account_available_for_family(0, ModelFamily::Codex, None));
        assert_eq!(
            manager
                .get_current_or_next_for_family(ModelFamily::Codex, None)
                .map(|account| account.meta.refresh_token.as_str()),
            Some("token-ready")
        );
        assert_eq!(
            manager
                .get_next_for_family(ModelFamily::Codex, None)
                .map(|account| account.meta.refresh_token.as_str()),
            Some("token-ready")
        );
        assert_eq!(
            manager
                .get_current_or_next_for_family_hybrid(ModelFamily::Codex, None, None)
                .map(|account| account.meta.refresh_token.as_str()),
            Some("token-ready")
        );
    }

    #[test]
    #[serial]
    fn keeps_workspace_less_legacy_accounts_eligible_for_selection() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![stored_account("token-legacy", now)]);

        assert!(manager.accounts[0].has_enabled_workspaces());
        assert!(manager.is_account_available_for_family(0, ModelFamily::Codex, None));
        assert_eq!(
            manager
                .get_current_or_next_for_family(ModelFamily::Codex, None)
                .map(|account| account.meta.refresh_token.as_str()),
            Some("token-legacy")
        );
    }

    #[test]
    #[serial]
    fn returns_false_for_invalid_account_index_in_availability_checks() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![stored_account("token-1", now)]);
        assert!(!manager.is_account_available_for_family(-1, ModelFamily::Codex, None));
        assert!(!manager.is_account_available_for_family(99, ModelFamily::Codex, None));
    }

    #[test]
    #[serial]
    fn clears_expired_rate_limit_windows_before_availability_check() {
        reset_globals();
        let now = now_ms();
        let mut expired = stored_account("token-1", now);
        expired.rate_limit_reset_times = Some(rate_limits_map(&[("codex", now - 1_000)]));
        let mut manager = manager_from(vec![expired]);

        assert!(manager.is_account_available_for_family(0, ModelFamily::Codex, None));
        // MUTATING lazy expiry: the expired key is gone from the live map.
        assert_eq!(manager.accounts[0].rate_limit_reset_times().get("codex"), None);
    }

    #[test]
    #[serial]
    fn rotates_when_the_active_account_is_rate_limited() {
        reset_globals();
        let now = now_ms();
        let mut limited = stored_account("token-1", now);
        limited.rate_limit_reset_times = Some(rate_limits_map(&[("codex", now + 60_000)]));
        let mut manager = manager_from(vec![limited, stored_account("token-2", now)]);

        assert_eq!(
            manager
                .get_current_or_next()
                .map(|account| account.meta.refresh_token.as_str()),
            Some("token-2")
        );
        assert_eq!(manager.get_min_wait_time(), 0);
    }

    #[test]
    #[serial]
    fn skips_accounts_that_are_cooling_down() {
        reset_globals();
        let now = now_ms();
        let mut cooling = stored_account("token-1", now);
        cooling.cooling_down_until = Some(now + 60_000);
        cooling.cooldown_reason = Some(CooldownReason::AuthFailure);
        let mut manager = manager_from(vec![cooling, stored_account("token-2", now)]);

        assert_eq!(
            manager
                .get_current_or_next()
                .map(|account| account.meta.refresh_token.as_str()),
            Some("token-2")
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 1);
    }

    #[test]
    #[serial]
    fn returns_min_wait_time_when_all_accounts_are_blocked() {
        reset_globals();
        let now = now_ms();
        let mut cooling = stored_account("token-1", now);
        cooling.cooling_down_until = Some(now + 60_000);
        cooling.cooldown_reason = Some(CooldownReason::NetworkError);
        let mut limited = stored_account("token-2", now);
        limited.rate_limit_reset_times = Some(rate_limits_map(&[("codex", now + 120_000)]));
        let mut manager = manager_from(vec![cooling, limited]);

        let wait_ms = manager.get_min_wait_time();
        assert!(wait_ms > 0);
        assert!(wait_ms <= 60_000);
    }

    #[test]
    #[serial]
    fn min_wait_is_zero_when_no_accounts_are_enabled() {
        reset_globals();
        let now = now_ms();
        let mut disabled = stored_account("token-1", now);
        disabled.enabled = Some(false);
        let mut manager = manager_from(vec![disabled]);
        assert_eq!(manager.get_min_wait_time(), 0);
    }

    #[test]
    #[serial]
    fn min_wait_uses_the_last_blocker_per_account_and_min_across_accounts() {
        reset_globals();
        let now = now_ms();
        // One account, blocked by BOTH a base window (30s) and a model window
        // (90s): the account waits for its LAST blocker (90s).
        let mut both = stored_account("token-both", now);
        both.rate_limit_reset_times = Some(rate_limits_map(&[
            ("codex", now + 30_000),
            ("codex:m1", now + 90_000),
        ]));
        let mut manager = manager_from(vec![both]);
        let wait = manager.get_min_wait_time_for_family(ModelFamily::Codex, Some("m1"));
        assert!(wait > 60_000, "expected ~90s wait, got {wait}");
        assert!(wait <= 90_000);
    }

    #[test]
    #[serial]
    fn performs_true_round_robin_rotation_across_multiple_requests() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![
            stored_account("token-1", now),
            stored_account("token-2", now),
            stored_account("token-3", now),
        ]);

        let picks: Vec<String> = (0..4)
            .map(|_| {
                manager
                    .get_current_or_next()
                    .map(|account| account.meta.refresh_token.clone())
                    .unwrap()
            })
            .collect();
        assert_eq!(picks, vec!["token-1", "token-2", "token-3", "token-1"]);
    }

    #[test]
    #[serial]
    fn skips_rate_limited_accounts_during_rotation() {
        reset_globals();
        let now = now_ms();
        let mut limited = stored_account("token-2", now);
        limited.rate_limit_reset_times = Some(rate_limits_map(&[("codex", now + 60_000)]));
        let mut manager = manager_from(vec![
            stored_account("token-1", now),
            limited,
            stored_account("token-3", now),
        ]);

        let picks: Vec<String> = (0..3)
            .map(|_| {
                manager
                    .get_current_or_next()
                    .map(|account| account.meta.refresh_token.clone())
                    .unwrap()
            })
            .collect();
        assert_eq!(picks, vec!["token-1", "token-3", "token-1"]);
    }

    #[test]
    #[serial]
    fn uses_independent_cursors_per_model_family() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![
            stored_account("token-1", now),
            stored_account("token-2", now),
        ]);

        let codex_first = manager
            .get_current_or_next_for_family(ModelFamily::Codex, None)
            .map(|account| account.meta.refresh_token.clone());
        let gpt51_first = manager
            .get_current_or_next_for_family(ModelFamily::Gpt5_1, None)
            .map(|account| account.meta.refresh_token.clone());
        let codex_second = manager
            .get_current_or_next_for_family(ModelFamily::Codex, None)
            .map(|account| account.meta.refresh_token.clone());
        let gpt51_second = manager
            .get_current_or_next_for_family(ModelFamily::Gpt5_1, None)
            .map(|account| account.meta.refresh_token.clone());

        assert_eq!(codex_first.as_deref(), Some("token-1"));
        assert_eq!(gpt51_first.as_deref(), Some("token-1"));
        assert_eq!(codex_second.as_deref(), Some("token-2"));
        assert_eq!(gpt51_second.as_deref(), Some("token-2"));
    }

    #[test]
    #[serial]
    fn get_next_for_family_does_not_commit_the_active_pointer() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![
            stored_account("token-1", now),
            stored_account("token-2", now),
        ]);
        // Constructor pointer init: both cursor and active start at 0.
        let first = manager
            .get_next_for_family(ModelFamily::Codex, None)
            .map(|account| account.meta.refresh_token.clone());
        assert_eq!(first.as_deref(), Some("token-1"));
        // Cursor advanced, active pointer untouched (gotcha 7).
        assert_eq!(cursor(&manager, ModelFamily::Codex), 1);
        assert_eq!(active(&manager, ModelFamily::Codex), 0);

        let second = manager
            .get_next_for_family(ModelFamily::Codex, None)
            .map(|account| account.meta.refresh_token.clone());
        assert_eq!(second.as_deref(), Some("token-2"));
        assert_eq!(active(&manager, ModelFamily::Codex), 0);
    }

    #[test]
    #[serial]
    fn hybrid_selection_prefers_the_healthier_candidate_over_the_active_index() {
        reset_globals();
        let now = now_ms();
        let mut stale = stored_account("token-1", now);
        stale.last_used = 0; // very stale → high freshness score
        let mut fresh = stored_account("token-2", now);
        fresh.last_used = now; // just used → low freshness score
        let mut storage = storage_with(vec![stale, fresh]);
        storage.active_index = 1;
        let mut manager = AccountManager::new(None, Some(&storage));

        let selected =
            manager.get_current_or_next_for_family_hybrid(ModelFamily::Codex, None, None);
        let selected = selected.expect("hybrid must select an available account");
        assert_eq!(selected.meta.refresh_token, "token-1");
        assert_eq!(selected.index, 0);
    }

    #[test]
    #[serial]
    fn hybrid_returns_none_when_pool_is_empty() {
        reset_globals();
        let mut manager = AccountManager::new(None, Some(&AccountStorageV3::empty()));
        assert!(
            manager
                .get_current_or_next_for_family_hybrid(ModelFamily::Codex, None, None)
                .is_none()
        );
    }

    // ------------------------------------------------------------------
    // getCurrentOrNextForFamilySequential (issue #509 drain-first)
    // ------------------------------------------------------------------

    fn sequential_pool(count: usize) -> AccountManager {
        let now = now_ms();
        let accounts = (0..count)
            .map(|i| {
                let mut account = stored_account(&format!("token-{i}"), now);
                account.last_used = now - (i as i64) * 1_000;
                account
            })
            .collect();
        // activeIndexByFamily.codex = 0 in the TS fixture; the plain
        // activeIndex 0 default produces the same pointer init.
        manager_from(accounts)
    }

    fn rate_limit_account(manager: &mut AccountManager, idx: usize, now: i64) {
        manager.accounts[idx]
            .rate_limit_reset_times_mut()
            .insert("codex", now + 60_000);
    }

    #[test]
    #[serial]
    fn sticks_to_the_active_account_across_calls_while_it_stays_available() {
        reset_globals();
        let mut manager = sequential_pool(2);

        for _ in 0..3 {
            let picked = manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index);
            assert_eq!(picked, Some(0));
        }
        // Pointer never advanced while draining the active account.
        assert_eq!(active(&manager, ModelFamily::Codex), 0);
    }

    #[test]
    #[serial]
    fn advances_to_the_next_account_only_once_the_active_one_is_exhausted() {
        reset_globals();
        let now = now_ms();
        let mut manager = sequential_pool(2);

        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(0)
        );

        // Drain account 0 (rate-limited): selector must move to account 1.
        rate_limit_account(&mut manager, 0, now);

        let after_drain = manager
            .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
            .map(|account| (account.index, account.meta.refresh_token.clone()));
        assert_eq!(after_drain, Some((1, "token-1".to_string())));
        assert_eq!(active(&manager, ModelFamily::Codex), 1);

        // And it now sticks to account 1.
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );
    }

    #[test]
    #[serial]
    fn wraps_back_to_a_recovered_earlier_account_when_the_current_one_drains() {
        reset_globals();
        let now = now_ms();
        let mut manager = sequential_pool(2);

        // A drains -> switch to B.
        rate_limit_account(&mut manager, 0, now);
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );

        // A's quota window recovers; B then drains.
        manager.accounts[0].rate_limit_reset_times_mut().clear();
        rate_limit_account(&mut manager, 1, now);

        // Sequential wraps forward from B (index 1) and reclaims recovered A.
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(0)
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 0);
    }

    #[test]
    #[serial]
    fn returns_none_when_every_account_is_exhausted() {
        reset_globals();
        let now = now_ms();
        let mut manager = sequential_pool(2);
        rate_limit_account(&mut manager, 0, now);
        rate_limit_account(&mut manager, 1, now);

        assert!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .is_none()
        );
    }

    #[test]
    #[serial]
    fn advances_when_the_active_account_is_cooling_down_then_reclaims_on_recovery() {
        reset_globals();
        let now = now_ms();
        let mut manager = sequential_pool(2);

        // Cooldown is a non-rate-limit exhaustion path: must advance.
        manager.accounts[0].meta.cooling_down_until = Some(now + 30_000);
        manager.accounts[0].meta.cooldown_reason = Some(CooldownReason::AuthFailure);

        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 1);

        // Account 0 recovers; account 1 then cools down -> wrap back to 0.
        manager.accounts[0].clear_cooldown();
        manager.accounts[1].meta.cooling_down_until = Some(now + 30_000);
        manager.accounts[1].meta.cooldown_reason = Some(CooldownReason::NetworkError);

        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(0)
        );
    }

    #[test]
    #[serial]
    fn advances_when_the_active_accounts_circuit_is_open() {
        reset_globals();
        let mut manager = sequential_pool(2);

        // Trip the circuit breaker on the active account (3 failures).
        let key = get_account_circuit_key(&mut manager.accounts[0]);
        let breaker = get_circuit_breaker(&key, None);
        breaker.record_failure();
        breaker.record_failure();
        breaker.record_failure();

        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 1);
    }

    #[test]
    #[serial]
    fn drains_a_3_account_pool_in_order_and_wraps_to_a_recovered_account() {
        reset_globals();
        let now = now_ms();
        let mut manager = sequential_pool(3);

        // A is primary.
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(0)
        );

        // A drains -> B.
        rate_limit_account(&mut manager, 0, now);
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );

        // B drains -> C (forward scan past A which is still down).
        rate_limit_account(&mut manager, 1, now);
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(2)
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 2);

        // A recovers; C drains -> wrap forward from C reclaims A.
        manager.accounts[0].rate_limit_reset_times_mut().clear();
        rate_limit_account(&mut manager, 2, now);
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(0)
        );
    }

    #[test]
    #[serial]
    fn skips_a_disabled_active_account_and_advances() {
        reset_globals();
        let mut manager = sequential_pool(2);
        manager.accounts[0].meta.enabled = Some(false);

        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );
    }

    #[test]
    #[serial]
    fn selects_the_first_usable_account_when_active_index_is_unset() {
        reset_globals();
        let mut manager = sequential_pool(2);
        // Simulate an unset (-1) active pointer.
        manager
            .current_account_index_by_family
            .set(ModelFamily::Codex, -1);

        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(0)
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 0);
    }

    #[test]
    #[serial]
    fn advances_each_model_family_independently() {
        reset_globals();
        let now = now_ms();
        let mut manager = sequential_pool(2);

        // Exhaust account 0 for the codex family ONLY.
        rate_limit_account(&mut manager, 0, now);

        // codex must advance to account 1...
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 1);

        // ...but gpt-5.1 is unaffected and still drains account 0.
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Gpt5_1, None, None)
                .map(|account| account.index),
            Some(0)
        );
        assert_eq!(active(&manager, ModelFamily::Gpt5_1), 0);
    }

    #[test]
    #[serial]
    fn never_anchors_the_active_pointer_on_a_policy_blocked_account() {
        reset_globals();
        let now = now_ms();
        let mut manager = sequential_pool(2);
        // Account 0 is exhausted; account 1 is otherwise usable but
        // policy-blocked (e.g. paused/drained) for this request.
        rate_limit_account(&mut manager, 0, now);
        let blocked: HashSet<usize> = [1].into_iter().collect();

        // Selector must NOT commit the active pointer to the blocked account.
        assert!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, Some(&blocked))
                .is_none()
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 0);

        // Once the block clears, account 1 becomes selectable normally.
        let empty: HashSet<usize> = HashSet::new();
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, Some(&empty))
                .map(|account| account.index),
            Some(1)
        );
    }

    #[test]
    #[serial]
    fn all_families_share_the_constructor_pointer_init() {
        reset_globals();
        let now = now_ms();
        let mut storage = storage_with(vec![
            stored_account("token-1", now),
            stored_account("token-2", now),
        ]);
        storage.active_index = 1;
        let manager = AccountManager::new(None, Some(&storage));
        for family in MODEL_FAMILIES {
            assert_eq!(active(&manager, family), 1);
            assert_eq!(cursor(&manager, family), 1);
        }
    }

    // ------------------------------------------------------------------
    // Tracker interactions (recordSuccess / recordRateLimit / recordFailure /
    // consumeToken / refundToken) + markSwitched + locked variants
    // ------------------------------------------------------------------

    #[test]
    #[serial]
    fn record_rate_limit_lowers_health_and_drains_the_token_bucket() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![stored_account("rl-token", now)]);
        let tracker_key = get_runtime_tracker_key(&mut manager.accounts[0]);

        manager.record_rate_limit(0, ModelFamily::Codex, None);

        let health = get_health_tracker(None).get_score(tracker_key.clone(), Some("codex"));
        let tokens = get_token_tracker(None).get_tokens(tracker_key, Some("codex"));
        assert_eq!(health, 90.0); // 100 - 10 (rate-limit event)
        assert_eq!(tokens, 40.0); // 50 - DEFAULT_DRAIN_AMOUNT
    }

    #[test]
    #[serial]
    fn record_failure_lowers_health_and_trips_the_circuit_after_three() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![
            stored_account("fail-token", now),
            stored_account("ok-token", now),
        ]);
        let tracker_key = get_runtime_tracker_key(&mut manager.accounts[0]);

        manager.record_failure(0, ModelFamily::Codex, None);
        manager.record_failure(0, ModelFamily::Codex, None);
        manager.record_failure(0, ModelFamily::Codex, None);

        let health = get_health_tracker(None).get_score(tracker_key, Some("codex"));
        assert_eq!(health, 40.0); // 100 - 3*20
        assert_eq!(
            manager.get_account_runtime_skip_reason(0, ModelFamily::Codex, None),
            Some("circuit-open".to_string())
        );
        // Sequential selection now advances past the tripped account.
        assert_eq!(
            manager
                .get_current_or_next_for_family_sequential(ModelFamily::Codex, None, None)
                .map(|account| account.index),
            Some(1)
        );
    }

    #[test]
    #[serial]
    fn consume_token_consumes_and_refunds_when_the_circuit_is_open() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![stored_account("consume-token", now)]);
        let tracker_key = get_runtime_tracker_key(&mut manager.accounts[0]);

        assert!(manager.consume_token(0, ModelFamily::Codex, None));
        assert_eq!(
            get_token_tracker(None).get_tokens(tracker_key.clone(), Some("codex")),
            49.0
        );

        // Trip the circuit: consume must fail AND refund the consumed token.
        manager.record_failure(0, ModelFamily::Codex, None);
        manager.record_failure(0, ModelFamily::Codex, None);
        manager.record_failure(0, ModelFamily::Codex, None);
        assert!(!manager.consume_token(0, ModelFamily::Codex, None));
        assert_eq!(
            get_token_tracker(None).get_tokens(tracker_key, Some("codex")),
            49.0
        );
        // Out-of-range index never consumes.
        assert!(!manager.consume_token(99, ModelFamily::Codex, None));
    }

    #[test]
    #[serial]
    fn refund_token_refunds_an_in_window_consumption() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![stored_account("refund-token", now)]);
        let tracker_key = get_runtime_tracker_key(&mut manager.accounts[0]);

        assert!(manager.consume_token(0, ModelFamily::Codex, None));
        assert!(manager.refund_token(0, ModelFamily::Codex, None));
        assert_eq!(
            get_token_tracker(None).get_tokens(tracker_key, Some("codex")),
            50.0
        );
        // Nothing left to refund.
        assert!(!manager.refund_token(0, ModelFamily::Codex, None));
    }

    #[test]
    #[serial]
    fn record_success_heals_expired_cooldown_metadata_and_auth_failures() {
        reset_globals();
        let now = now_ms();
        let mut expired = stored_account("heal-token", now);
        expired.cooling_down_until = Some(now - 1_000); // EXPIRED metadata
        expired.cooldown_reason = Some(CooldownReason::AuthFailure);
        let mut manager = manager_from(vec![expired]);
        manager.accounts[0].runtime.consecutive_auth_failures = Some(2);

        let healed = manager.record_success(0, ModelFamily::Codex, None);

        assert!(healed, "expired metadata + auth failures must heal");
        assert_eq!(manager.accounts[0].meta.cooling_down_until, None);
        assert_eq!(manager.accounts[0].meta.cooldown_reason, None);
        // clearAuthFailures sets 0 (does NOT delete) — spec gotcha 13.
        assert_eq!(
            manager.accounts[0].runtime.consecutive_auth_failures,
            Some(0)
        );
    }

    #[test]
    #[serial]
    fn record_success_does_not_heal_while_actively_cooling() {
        reset_globals();
        let now = now_ms();
        let mut cooling = stored_account("cooling-token", now);
        cooling.cooling_down_until = Some(now + 60_000); // ACTIVE cooldown
        cooling.cooldown_reason = Some(CooldownReason::NetworkError);
        let mut manager = manager_from(vec![cooling]);
        manager.accounts[0].runtime.consecutive_auth_failures = Some(1);

        let healed = manager.record_success(0, ModelFamily::Codex, None);

        assert!(!healed);
        assert!(manager.accounts[0].meta.cooling_down_until.is_some());
        assert_eq!(
            manager.accounts[0].meta.cooldown_reason,
            Some(CooldownReason::NetworkError)
        );
        assert_eq!(
            manager.accounts[0].runtime.consecutive_auth_failures,
            Some(1)
        );
    }

    #[test]
    #[serial]
    fn mark_switched_sets_reason_and_keeps_the_cursor_in_lockstep() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![
            stored_account("token-1", now),
            stored_account("token-2", now),
        ]);

        assert!(manager.mark_switched(1, SwitchReason::RateLimit, ModelFamily::Codex));

        assert_eq!(
            manager.accounts[1].meta.last_switch_reason,
            Some(SwitchReason::RateLimit)
        );
        assert_eq!(active(&manager, ModelFamily::Codex), 1);
        // HI-02: cursor = (index + 1) % count.
        assert_eq!(cursor(&manager, ModelFamily::Codex), 0);
        // Other families untouched.
        assert_eq!(active(&manager, ModelFamily::Gpt5_1), 0);
        // Out-of-range is a no-op.
        assert!(!manager.mark_switched(9, SwitchReason::Manual, ModelFamily::Codex));
    }

    #[tokio::test]
    #[serial]
    async fn mark_switched_locked_returns_a_selection_record() {
        reset_globals();
        let now = now_ms();
        let mut with_email = stored_account("token-1", now);
        with_email.email = Some("user@example.com".to_string());
        let mut manager = manager_from(vec![stored_account("token-0", now), with_email]);

        let record = manager
            .mark_switched_locked(
                1,
                SwitchReason::RateLimit,
                ModelFamily::Codex,
                Some(MarkSwitchedContext {
                    tracker_key_quota: Some("codex".to_string()),
                    score: Some(12.5),
                }),
            )
            .await
            .expect("in-range index yields a record");

        assert_eq!(record.account_index, 1);
        // accountId ?? email ?? String(trackerKey) — email wins here.
        assert_eq!(record.account_id, "user@example.com");
        assert_eq!(record.reason, SwitchReason::RateLimit);
        assert_eq!(record.tracker_key_quota.as_deref(), Some("codex"));
        assert_eq!(record.health, Some(100.0));
        assert_eq!(record.tokens, Some(50.0));
        assert_eq!(record.score, Some(12.5));
        // Pointer + cursor lockstep committed under the mutex.
        assert_eq!(active(&manager, ModelFamily::Codex), 1);
        assert_eq!(cursor(&manager, ModelFamily::Codex), 0);
        assert_eq!(
            manager.accounts[1].meta.last_switch_reason,
            Some(SwitchReason::RateLimit)
        );

        // Identity-less account falls back to String(trackerKey).
        let record = manager
            .mark_switched_locked(0, SwitchReason::Rotation, ModelFamily::Codex, None)
            .await
            .expect("record");
        assert_eq!(record.account_id, "0");
        assert_eq!(record.score, None);

        // Out-of-range yields no record (defensive; unreachable in TS).
        assert!(
            manager
                .mark_switched_locked(9, SwitchReason::Manual, ModelFamily::Codex, None)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    #[serial]
    async fn mark_account_cooling_down_locked_clamps_and_sets_both_fields() {
        reset_globals();
        let now = now_ms();
        let mut manager = manager_from(vec![stored_account("cool-token", now)]);

        assert!(
            manager
                .mark_account_cooling_down_locked(0, 30_000, CooldownReason::ServerError)
                .await
        );
        let until = manager.accounts[0].meta.cooling_down_until.unwrap();
        assert!(until >= now + 30_000);
        assert_eq!(
            manager.accounts[0].meta.cooldown_reason,
            Some(CooldownReason::ServerError)
        );

        // Negative durations clamp to 0 (coolingDownUntil = now).
        assert!(
            manager
                .mark_account_cooling_down_locked(0, -500, CooldownReason::RateLimit)
                .await
        );
        let until = manager.accounts[0].meta.cooling_down_until.unwrap();
        assert!(until <= now_ms());

        assert!(
            !manager
                .mark_account_cooling_down_locked(9, 1_000, CooldownReason::RateLimit)
                .await
        );
    }

    #[tokio::test]
    #[serial]
    async fn set_active_index_locked_delegates_to_set_active_index() {
        // set_active_index fire-and-forgets a Codex-CLI mirror write when a
        // tokio runtime is present — sandbox the env so it targets a tempdir.
        let _sandbox = cma_testkit::sandbox::EnvSandbox::new();
        reset_globals();
        let now = now_ms();
        let mut disabled = stored_account("locked-1", now);
        disabled.enabled = Some(false);
        let mut manager = manager_from(vec![stored_account("locked-0", now), disabled]);

        let selected = manager.set_active_index_locked(0).await;
        assert_eq!(selected.map(|account| account.index), Some(0));
        for family in MODEL_FAMILIES {
            assert_eq!(active(&manager, family), 0);
            // Gotcha 9: setActiveIndex sets cursor = index (NOT index + 1).
            assert_eq!(cursor(&manager, family), 0);
        }

        // Disabled / out-of-range → None (matching sync semantics).
        assert!(manager.set_active_index_locked(1).await.is_none());
        assert!(manager.set_active_index_locked(99).await.is_none());
    }
}
