//! Port of `lib/runtime/rotation-account-selection.ts` — the SYNC account
//! selector for the proxy hot path (spec 10 §8, spec 04 §339, ARCHITECTURE
//! §6.12) — plus `normalizeForcedAccountIndex` (issue #623) from
//! `lib/runtime-rotation-proxy.ts`.
//!
//! Selection precedence (exact): manual pin (#474 — fail-hard, NEVER
//! `mark_switched`) > sequential drain-first (#509 — fallback never
//! advances the active pointer) > session affinity (hybrid only) > hybrid
//! selector > linear scan fallback.
//!
//! `choose_account` mutates the rotation cursor internally
//! (`mark_switched`) and does NOT take the routing mutex itself — the
//! caller wraps selection + commit in one routing-mutex acquisition when
//! `routingMutex == "enabled"`.

use crate::rotation::server_types::{skip_reason, SchedulingStrategy};
use cma_accounts::manager::{AccountManager, ManagedAccount};
use cma_accounts::session_affinity::SessionAffinityStore;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::SwitchReason;
use cma_quota::runtime_policy::RuntimePolicyDecision;
use cma_rotation::selector::HybridSelectionOptions;
use std::collections::{HashMap, HashSet};

/// Named-parameter bundle for [`choose_account`] (TS single object param).
pub struct ChooseAccountParams<'a> {
    pub account_manager: &'a mut AccountManager,
    pub session_affinity_store: Option<&'a mut SessionAffinityStore>,
    pub session_key: Option<&'a str>,
    pub family: ModelFamily,
    pub model: Option<&'a str>,
    pub attempted_indexes: &'a HashSet<i64>,
    pub now: i64,
    pub policy: Option<&'a RuntimePolicyDecision>,
    /// Manual pin: `switch <n>` from disk or the ephemeral forced index
    /// (#623). `Some` = fail-hard pinned selection.
    pub pinned_index: Option<i64>,
    /// Rejected-candidate reasons, keyed by account index (the pinned index
    /// may be out of range).
    pub skip_reasons: Option<&'a mut HashMap<i64, String>>,
    /// Sticky per-account score boosts (override policy boosts key-wise).
    pub sticky_boost_by_account: Option<&'a HashMap<i64, f64>>,
    pub pid_offset_enabled: bool,
    pub scheduling_strategy: SchedulingStrategy,
}

fn record_skip(skip_reasons: &mut Option<&mut HashMap<i64, String>>, index: i64, reason: &str) {
    if let Some(map) = skip_reasons.as_deref_mut() {
        map.insert(index, reason.to_string());
    }
}

fn blocked_contains(policy: Option<&RuntimePolicyDecision>, index: i64) -> bool {
    policy.is_some_and(|policy| policy.blocked_account_indexes.contains(&index))
}

/// TS `chooseAccount(params)` — returns a CLONE of the selected account
/// (the TS function returned the live object; callers re-fetch by index
/// when they need to observe later mutations) or `None` when no eligible
/// account remains.
pub fn choose_account(params: ChooseAccountParams<'_>) -> Option<ManagedAccount> {
    let ChooseAccountParams {
        account_manager,
        session_affinity_store,
        session_key,
        family,
        model,
        attempted_indexes,
        now,
        policy,
        pinned_index,
        mut skip_reasons,
        sticky_boost_by_account,
        pid_offset_enabled,
        scheduling_strategy,
    } = params;

    // Manual pin (from `codex-multi-auth switch <n>`) overrides every other
    // selection signal. We do NOT call mark_switched here — the proxy must
    // not clobber the pin set by the CLI. See issue #474.
    if let Some(pinned_index) = pinned_index {
        if attempted_indexes.contains(&pinned_index) {
            record_skip(&mut skip_reasons, pinned_index, skip_reason::ALREADY_ATTEMPTED);
            return None;
        }
        if pinned_index < 0 || pinned_index >= account_manager.get_account_count() as i64 {
            record_skip(&mut skip_reasons, pinned_index, skip_reason::MISSING);
            return None;
        }
        if blocked_contains(policy, pinned_index) {
            record_skip(&mut skip_reasons, pinned_index, skip_reason::POLICY_BLOCKED);
            return None;
        }
        let pinned = account_manager.get_account_by_index(pinned_index).cloned();
        let Some(pinned) = pinned.filter(|account| account.is_enabled()) else {
            record_skip(&mut skip_reasons, pinned_index, skip_reason::DISABLED);
            return None;
        };
        if let Some(reason) =
            account_manager.get_account_runtime_skip_reason(pinned_index, family, model)
        {
            record_skip(&mut skip_reasons, pinned_index, &reason);
            return None;
        }
        return Some(pinned);
    }

    // Sequential / drain-first mode (issue #509): the active account governs
    // ALL new requests, so we deliberately SKIP the per-session affinity
    // tier — there is no per-chat stickiness. The manual pin above still
    // wins (handled first).
    if scheduling_strategy == SchedulingStrategy::Sequential {
        let blocked_usize: Option<HashSet<usize>> = policy.map(|policy| {
            policy
                .blocked_account_indexes
                .iter()
                .filter(|index| **index >= 0)
                .map(|index| *index as usize)
                .collect()
        });
        let selected = account_manager
            .get_current_or_next_for_family_sequential(family, model, blocked_usize.as_ref())
            .cloned();
        if let Some(selected) = selected {
            let selected_index = selected.index as i64;
            if !attempted_indexes.contains(&selected_index)
                && !blocked_contains(policy, selected_index)
            {
                match account_manager.get_account_runtime_skip_reason(selected_index, family, model)
                {
                    None => return Some(selected),
                    Some(reason) => record_skip(&mut skip_reasons, selected_index, &reason),
                }
            }
        }

        // Active account was attempted/blocked/skipped this request: fall
        // through to the shared linear scan with advance_active_pointer =
        // false — a transient, non-exhausting failure on the active account
        // must NOT permanently move the drain-first primary. Only
        // get_current_or_next_for_family_sequential may advance it, and only
        // on true exhaustion.
        return choose_linear_scan_fallback(
            account_manager,
            family,
            model,
            attempted_indexes,
            policy,
            &mut skip_reasons,
            false,
        );
    }

    // Session-affinity tier (hybrid only).
    let preferred_index = session_affinity_store
        .and_then(|store| store.get_preferred_account_index(session_key, now));
    if let Some(preferred_index) = preferred_index
        && !attempted_indexes.contains(&preferred_index)
        && !blocked_contains(policy, preferred_index)
    {
        let preferred = account_manager.get_account_by_index(preferred_index).cloned();
        if let Some(preferred) = preferred {
            match account_manager.get_account_runtime_skip_reason(
                preferred.index as i64,
                family,
                model,
            ) {
                Some(reason) => {
                    record_skip(&mut skip_reasons, preferred.index as i64, &reason);
                }
                None => {
                    // L4 (deferred): unlocked cursor mutation — see module
                    // docs.
                    account_manager.mark_switched(
                        preferred.index as i64,
                        SwitchReason::Rotation,
                        family,
                    );
                    // Return the post-mark state (TS returned the live
                    // object that markSwitched just mutated).
                    return account_manager
                        .get_account_by_index(preferred.index as i64)
                        .cloned()
                        .or(Some(preferred));
                }
            }
        }
    }

    // Hybrid selector tier. Sticky boosts override policy boosts key-wise;
    // pid_offset_enabled carries the PID-offset distribution into the proxy
    // path (accounts-05).
    let mut score_boost_by_account: HashMap<usize, f64> = HashMap::new();
    if let Some(policy) = policy {
        for (index, boost) in policy.score_boost_by_account.iter() {
            if *index >= 0 {
                score_boost_by_account.insert(*index as usize, *boost);
            }
        }
    }
    if let Some(sticky) = sticky_boost_by_account {
        for (index, boost) in sticky.iter() {
            if *index >= 0 {
                score_boost_by_account.insert(*index as usize, *boost);
            }
        }
    }
    let selected = account_manager
        .get_current_or_next_for_family_hybrid(
            family,
            model,
            Some(HybridSelectionOptions {
                pid_offset_enabled,
                score_boost_by_account,
            }),
        )
        .cloned();
    if let Some(selected) = selected {
        let selected_index = selected.index as i64;
        if !attempted_indexes.contains(&selected_index) && !blocked_contains(policy, selected_index)
        {
            match account_manager.get_account_runtime_skip_reason(selected_index, family, model) {
                None => return Some(selected),
                Some(reason) => record_skip(&mut skip_reasons, selected_index, &reason),
            }
        }
    }

    choose_linear_scan_fallback(
        account_manager,
        family,
        model,
        attempted_indexes,
        policy,
        &mut skip_reasons,
        true,
    )
}

/// TS `chooseLinearScanFallback` — shared linear-scan fallback used by both
/// the hybrid and sequential selection paths. Walks every account in pool
/// order and returns the first one that is not already attempted, not
/// policy-blocked, and has no runtime skip reason, recording a skip reason
/// for each rejected candidate.
///
/// `advance_active_pointer` (hybrid: `true`) controls whether the winner is
/// committed as the new active/cursor position via `mark_switched`. The
/// sequential path passes `false`: its within-request fallback only needs
/// an account to TRY this request, and must NOT move the drain-first
/// primary (issue #509 regression caught in review).
fn choose_linear_scan_fallback(
    account_manager: &mut AccountManager,
    family: ModelFamily,
    model: Option<&str>,
    attempted_indexes: &HashSet<i64>,
    policy: Option<&RuntimePolicyDecision>,
    skip_reasons: &mut Option<&mut HashMap<i64, String>>,
    advance_active_pointer: bool,
) -> Option<ManagedAccount> {
    let snapshot = account_manager.get_accounts_snapshot();
    for account in snapshot {
        let index = account.index as i64;
        if attempted_indexes.contains(&index) {
            record_skip(skip_reasons, index, skip_reason::ALREADY_ATTEMPTED);
            continue;
        }
        if blocked_contains(policy, index) {
            record_skip(skip_reasons, index, skip_reason::POLICY_BLOCKED);
            continue;
        }
        match account_manager.get_account_runtime_skip_reason(index, family, model) {
            None => {
                let live = account_manager.get_account_by_index(index).cloned();
                let Some(live) = live else { continue };
                // L4 (deferred): unlocked cursor mutation. Skipped in
                // sequential mode (advance_active_pointer=false) so a
                // within-request retry never reassigns the drain-first
                // primary.
                if advance_active_pointer {
                    account_manager.mark_switched(index, SwitchReason::Rotation, family);
                    return account_manager.get_account_by_index(index).cloned().or(Some(live));
                }
                return Some(live);
            }
            Some(reason) => record_skip(skip_reasons, index, &reason),
        }
    }
    None
}

/// TS `normalizeForcedAccountIndex(value)` (issue #623, `@internal` in
/// `lib/runtime-rotation-proxy.ts`) — string form. `None`/blank-parse ⇒
/// `None`; strings go through JS `Number.parseInt(trim, 10)` semantics
/// (leading sign, leading digit prefix, e.g. `"3.5"` parses to `3`);
/// non-integer or `< 0` ⇒ `None`. Never fails — an out-of-range env pin
/// must not crash proxy startup; `choose_account` reports it per-request
/// instead ("missing").
pub fn normalize_forced_account_index(value: Option<&str>) -> Option<i64> {
    let value = value?;
    js_parse_int_base10(value.trim()).and_then(|parsed| if parsed < 0 { None } else { Some(parsed) })
}

/// TS `normalizeForcedAccountIndex(value)` — number form: numbers are used
/// as-is; non-integer or `< 0` ⇒ `None`.
pub fn normalize_forced_account_index_number(value: Option<f64>) -> Option<i64> {
    let value = value?;
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 {
        return None;
    }
    // Values beyond i64 range saturate — they behave as "missing" (out of
    // pool range) downstream exactly like any other huge pin.
    if value >= i64::MAX as f64 {
        return Some(i64::MAX);
    }
    Some(value as i64)
}

/// JS `Number.parseInt(s, 10)`: optional sign, then the longest leading run
/// of ASCII digits; empty run ⇒ NaN (`None` here). Trailing garbage is
/// ignored (`"3.5"` ⇒ 3).
fn js_parse_int_base10(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    let mut pos = 0usize;
    let mut negative = false;
    if pos < bytes.len() && (bytes[pos] == b'+' || bytes[pos] == b'-') {
        negative = bytes[pos] == b'-';
        pos += 1;
    }
    let digits_start = pos;
    let mut value: i128 = 0;
    let mut saturated = false;
    while pos < bytes.len() && bytes[pos].is_ascii_digit() {
        if !saturated {
            value = value * 10 + i128::from(bytes[pos] - b'0');
            if value > i64::MAX as i128 {
                saturated = true;
            }
        }
        pos += 1;
    }
    if pos == digits_start {
        return None;
    }
    let magnitude = if saturated { i64::MAX } else { value as i64 };
    Some(if negative { -magnitude } else { magnitude })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{
        AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily, CooldownReason, RateLimitStateV3,
    };
    use cma_core::utils::now_ms;
    use serial_test::serial;

    const FAMILY: ModelFamily = ModelFamily::Gpt5Codex;

    fn storage_with(count: usize) -> AccountStorageV3 {
        let now = now_ms();
        let mut storage = AccountStorageV3::empty();
        storage.accounts = (0..count)
            .map(|index| {
                let mut meta = AccountMetadataV3::new(
                    format!("refresh-{}", index + 1),
                    now - 60_000,
                    // Account 0 is the least recently used → deterministic
                    // hybrid pick under equal tracker metrics.
                    now - ((count - index) as i64) * 60_000,
                );
                meta.email = Some(format!("account-{}@example.com", index + 1));
                meta.account_id = Some(format!("acc_{}", index + 1));
                meta.access_token = Some(format!("access-{}", index + 1));
                meta.expires_at = Some(now + 3_600_000);
                meta
            })
            .collect();
        let mut by_family = ActiveIndexByFamily::default();
        by_family.set(FAMILY, Some(0));
        storage.active_index_by_family = Some(by_family);
        storage
    }

    fn manager_with(count: usize) -> AccountManager {
        AccountManager::reset_volatile_runtime_state();
        AccountManager::new(None, Some(&storage_with(count)))
    }

    fn policy_with(blocked: &[i64]) -> RuntimePolicyDecision {
        RuntimePolicyDecision {
            allowed: true,
            status_code: 200,
            error_code: None,
            reasons: Vec::new(),
            project_key: None,
            blocked_account_indexes: blocked.iter().copied().collect(),
            score_boost_by_account: HashMap::new(),
            budget_evaluations: Vec::new(),
        }
    }

    struct Fixture {
        manager: AccountManager,
        attempted: HashSet<i64>,
        skip_reasons: HashMap<i64, String>,
    }

    impl Fixture {
        fn new(count: usize) -> Self {
            Self {
                manager: manager_with(count),
                attempted: HashSet::new(),
                skip_reasons: HashMap::new(),
            }
        }

        fn choose(
            &mut self,
            pinned_index: Option<i64>,
            policy: Option<&RuntimePolicyDecision>,
            strategy: SchedulingStrategy,
            store: Option<&mut SessionAffinityStore>,
            session_key: Option<&str>,
        ) -> Option<ManagedAccount> {
            choose_account(ChooseAccountParams {
                account_manager: &mut self.manager,
                session_affinity_store: store,
                session_key,
                family: FAMILY,
                model: None,
                attempted_indexes: &self.attempted,
                now: now_ms(),
                policy,
                pinned_index,
                skip_reasons: Some(&mut self.skip_reasons),
                sticky_boost_by_account: None,
                pid_offset_enabled: false,
                scheduling_strategy: strategy,
            })
        }
    }

    // ---- pinned selection (issue #474) ----

    #[test]
    #[serial(env)]
    fn returns_the_pinned_account_without_advancing_any_cursor() {
        let mut fx = Fixture::new(3);
        let active_before = fx.manager.get_active_index_for_family(FAMILY);

        let selected = fx.choose(Some(1), None, SchedulingStrategy::Hybrid, None, None);

        assert_eq!(selected.map(|a| a.index), Some(1));
        // The proxy must not clobber the pin set by the CLI: no cursor moved.
        assert_eq!(fx.manager.get_active_index_for_family(FAMILY), active_before);
    }

    #[test]
    #[serial(env)]
    fn refuses_the_pin_instead_of_falling_back() {
        // already-attempted
        let mut fx = Fixture::new(3);
        fx.attempted.insert(1);
        assert!(fx
            .choose(Some(1), None, SchedulingStrategy::Hybrid, None, None)
            .is_none());
        assert_eq!(fx.skip_reasons.get(&1).map(String::as_str), Some("already-attempted"));

        // missing (out of range)
        let mut fx = Fixture::new(3);
        assert!(fx
            .choose(Some(7), None, SchedulingStrategy::Hybrid, None, None)
            .is_none());
        assert_eq!(fx.skip_reasons.get(&7).map(String::as_str), Some("missing"));

        // policy-blocked
        let mut fx = Fixture::new(3);
        let policy = policy_with(&[1]);
        assert!(fx
            .choose(Some(1), Some(&policy), SchedulingStrategy::Hybrid, None, None)
            .is_none());
        assert_eq!(fx.skip_reasons.get(&1).map(String::as_str), Some("policy-blocked"));
    }

    #[test]
    #[serial(env)]
    fn refuses_a_disabled_pinned_account() {
        let mut fx = Fixture::new(3);
        fx.manager.set_account_enabled(1, false);

        let selected = fx.choose(Some(1), None, SchedulingStrategy::Hybrid, None, None);

        assert!(selected.is_none());
        assert_eq!(fx.skip_reasons.get(&1).map(String::as_str), Some("disabled"));
    }

    #[test]
    #[serial(env)]
    fn refuses_a_rate_limited_pinned_account_with_the_runtime_reason() {
        let mut fx = Fixture::new(3);
        {
            let account = fx.manager.get_account_by_index_mut(1).unwrap();
            let mut windows = RateLimitStateV3::default();
            windows.insert(FAMILY.as_str().to_string(), now_ms() + 600_000);
            account.rate_limit_reset_times = windows;
        }

        let selected = fx.choose(Some(1), None, SchedulingStrategy::Hybrid, None, None);

        assert!(selected.is_none());
        assert_eq!(fx.skip_reasons.get(&1).map(String::as_str), Some("rate-limited"));
    }

    #[test]
    #[serial(env)]
    fn refuses_a_cooling_down_pinned_account_with_the_tagged_reason() {
        let mut fx = Fixture::new(3);
        fx.manager
            .mark_account_cooling_down(1, 60_000, CooldownReason::AuthFailure);

        let selected = fx.choose(Some(1), None, SchedulingStrategy::Hybrid, None, None);

        assert!(selected.is_none());
        assert_eq!(
            fx.skip_reasons.get(&1).map(String::as_str),
            Some("cooling-down:auth-failure")
        );
    }

    #[test]
    #[serial(env)]
    fn refuses_a_pinned_account_whose_circuit_breaker_is_open() {
        let mut fx = Fixture::new(3);
        // Trip the breaker (threshold is 3 failures).
        for _ in 0..3 {
            fx.manager.record_failure(1, FAMILY, None);
        }

        let selected = fx.choose(Some(1), None, SchedulingStrategy::Hybrid, None, None);

        assert!(selected.is_none());
        assert_eq!(fx.skip_reasons.get(&1).map(String::as_str), Some("circuit-open"));
    }

    // ---- session affinity tier ----

    #[test]
    #[serial(env)]
    fn prefers_the_remembered_account_and_commits_the_cursor() {
        let mut fx = Fixture::new(3);
        let mut store = SessionAffinityStore::new(Default::default());
        store.remember(Some("sess-1"), 2, now_ms());

        let selected = fx.choose(
            None,
            None,
            SchedulingStrategy::Hybrid,
            Some(&mut store),
            Some("sess-1"),
        );

        assert_eq!(selected.map(|a| a.index), Some(2));
        // mark_switched committed the cursor to the sticky account.
        assert_eq!(fx.manager.get_active_index_for_family(FAMILY), 2);
    }

    #[test]
    #[serial(env)]
    fn records_the_skip_reason_and_falls_through_when_the_sticky_account_is_unusable() {
        let mut fx = Fixture::new(3);
        {
            let account = fx.manager.get_account_by_index_mut(2).unwrap();
            let mut windows = RateLimitStateV3::default();
            windows.insert(FAMILY.as_str().to_string(), now_ms() + 600_000);
            account.rate_limit_reset_times = windows;
        }
        let mut store = SessionAffinityStore::new(Default::default());
        store.remember(Some("sess-1"), 2, now_ms());

        let selected = fx.choose(
            None,
            None,
            SchedulingStrategy::Hybrid,
            Some(&mut store),
            Some("sess-1"),
        );

        assert_eq!(fx.skip_reasons.get(&2).map(String::as_str), Some("rate-limited"));
        // Falls through to the hybrid tier, which picks a usable account.
        let selected_index = selected.map(|a| a.index).expect("an account is selected");
        assert_ne!(selected_index, 2);
    }

    // ---- hybrid tier + linear fallback ----

    #[test]
    #[serial(env)]
    fn falls_back_to_a_linear_scan_that_commits_the_cursor_when_the_hybrid_pick_was_attempted() {
        let mut fx = Fixture::new(3);
        // Account 0 is the deterministic hybrid pick under fresh trackers
        // (longest idle); marking it attempted forces the linear fallback.
        fx.attempted.insert(0);
        let policy = policy_with(&[1]);

        let selected = fx.choose(None, Some(&policy), SchedulingStrategy::Hybrid, None, None);

        // 0 was attempted, 1 is policy-blocked, 2 wins and becomes the cursor.
        assert_eq!(selected.map(|a| a.index), Some(2));
        assert_eq!(fx.skip_reasons.get(&0).map(String::as_str), Some("already-attempted"));
        assert_eq!(fx.skip_reasons.get(&1).map(String::as_str), Some("policy-blocked"));
        assert_eq!(fx.manager.get_active_index_for_family(FAMILY), 2);
    }

    #[test]
    #[serial(env)]
    fn returns_null_with_a_reason_per_account_when_the_pool_is_exhausted() {
        let mut fx = Fixture::new(3);
        fx.attempted.extend([0, 1, 2]);

        let selected = fx.choose(None, None, SchedulingStrategy::Hybrid, None, None);

        assert!(selected.is_none());
        let mut entries: Vec<(i64, &str)> = fx
            .skip_reasons
            .iter()
            .map(|(index, reason)| (*index, reason.as_str()))
            .collect();
        entries.sort();
        assert_eq!(
            entries,
            vec![
                (0, "already-attempted"),
                (1, "already-attempted"),
                (2, "already-attempted"),
            ]
        );
    }

    // ---- sequential mode (issue #509) ----

    #[test]
    #[serial(env)]
    fn follows_the_drain_first_selector_and_skips_the_affinity_tier() {
        let mut fx = Fixture::new(3);
        let mut store = SessionAffinityStore::new(Default::default());
        store.remember(Some("sess-1"), 2, now_ms());

        let selected = fx.choose(
            None,
            None,
            SchedulingStrategy::Sequential,
            Some(&mut store),
            Some("sess-1"),
        );

        // Every request follows the single active account (0): no per-chat
        // stickiness consulted (the remembered account 2 is NOT selected).
        assert_eq!(selected.map(|a| a.index), Some(0));
    }

    #[test]
    #[serial(env)]
    fn routes_around_a_policy_blocked_primary() {
        let mut fx = Fixture::new(3);
        let policy = policy_with(&[0]);

        let selected = fx.choose(None, Some(&policy), SchedulingStrategy::Sequential, None, None);

        // The blocked set is threaded into the drain-first selector, which
        // advances to the next eligible account (true exhaustion of the
        // primary for this policy).
        assert_eq!(selected.map(|a| a.index), Some(1));
    }

    #[test]
    #[serial(env)]
    fn retries_another_account_without_moving_the_drain_first_primary() {
        let mut fx = Fixture::new(3);
        fx.attempted.insert(0);

        let selected = fx.choose(None, None, SchedulingStrategy::Sequential, None, None);

        // The transiently failed active account stays primary: the fallback
        // only finds an account to TRY, it must not commit the cursor.
        assert_eq!(selected.map(|a| a.index), Some(1));
        assert_eq!(fx.skip_reasons.get(&0).map(String::as_str), Some("already-attempted"));
        assert_eq!(fx.manager.get_active_index_for_family(FAMILY), 0);
    }

    // ---- normalize_forced_account_index (issue #623) ----

    #[test]
    #[serial(env)]
    fn normalize_forced_account_index_string_semantics() {
        assert_eq!(normalize_forced_account_index(None), None);
        assert_eq!(normalize_forced_account_index(Some("")), None);
        assert_eq!(normalize_forced_account_index(Some("   ")), None);
        assert_eq!(normalize_forced_account_index(Some("0")), Some(0));
        assert_eq!(normalize_forced_account_index(Some(" 2 ")), Some(2));
        assert_eq!(normalize_forced_account_index(Some("13")), Some(13));
        // JS parseInt: leading digit prefix wins, trailing garbage ignored.
        assert_eq!(normalize_forced_account_index(Some("3.5")), Some(3));
        assert_eq!(normalize_forced_account_index(Some("7abc")), Some(7));
        // Negative or non-numeric → null (never throws).
        assert_eq!(normalize_forced_account_index(Some("-1")), None);
        assert_eq!(normalize_forced_account_index(Some("abc")), None);
        assert_eq!(normalize_forced_account_index(Some("+4")), Some(4));
    }

    #[test]
    #[serial(env)]
    fn normalize_forced_account_index_number_semantics() {
        assert_eq!(normalize_forced_account_index_number(None), None);
        assert_eq!(normalize_forced_account_index_number(Some(0.0)), Some(0));
        assert_eq!(normalize_forced_account_index_number(Some(5.0)), Some(5));
        // Numbers are used as-is: non-integers are rejected, not truncated.
        assert_eq!(normalize_forced_account_index_number(Some(3.5)), None);
        assert_eq!(normalize_forced_account_index_number(Some(-1.0)), None);
        assert_eq!(normalize_forced_account_index_number(Some(f64::NAN)), None);
        assert_eq!(
            normalize_forced_account_index_number(Some(f64::INFINITY)),
            None
        );
    }
}
