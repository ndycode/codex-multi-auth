//! Port of `lib/runtime/runtime-current-account.ts` (+ the duplicate
//! `status-marker.ts` helper) — answers "which account is the *runtime*
//! actually using right now?" by merging three status signals against the
//! account storage.
//!
//! Behavioral contracts (spec 10 §4 + gotcha 17): 24 h staleness cap; signals
//! sorted newest-first with source-rank tie-break
//! (runtime-observability < app-bind < app-helper); app-bind signals require
//! `state == "running"` but no pid check; app-helper signals require
//! kind + state + live pid; the index fallback is rejected when it contradicts
//! the signal's account id or email.

use std::path::PathBuf;

use serde_json::Value;

use cma_core::constants::APP_RUNTIME_HELPER_STATUS_FILE;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::schemas::account_storage::AccountStorageV3;
use cma_core::utils::now_ms;

use crate::app_bind::{is_process_alive, AppBindRouterStatus};
use crate::observability::RuntimeObservabilitySnapshot;
use crate::ui_runtime::{get_status_marker, RuntimeStatus, StatusMarkerTheme};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeCurrentAccountSource {
    RuntimeObservability,
    AppBind,
    AppHelper,
}

impl RuntimeCurrentAccountSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeCurrentAccountSource::RuntimeObservability => "runtime-observability",
            RuntimeCurrentAccountSource::AppBind => "app-bind",
            RuntimeCurrentAccountSource::AppHelper => "app-helper",
        }
    }

    fn rank(self) -> u8 {
        match self {
            RuntimeCurrentAccountSource::RuntimeObservability => 0,
            RuntimeCurrentAccountSource::AppBind => 1,
            RuntimeCurrentAccountSource::AppHelper => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeCurrentAccountMatch {
    AccountId,
    Email,
    Index,
}

impl RuntimeCurrentAccountMatch {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeCurrentAccountMatch::AccountId => "account-id",
            RuntimeCurrentAccountMatch::Email => "email",
            RuntimeCurrentAccountMatch::Index => "index",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountCurrentMarker {
    Current,
    InUse,
    Selected,
}

impl AccountCurrentMarker {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountCurrentMarker::Current => "current",
            AccountCurrentMarker::InUse => "in-use",
            AccountCurrentMarker::Selected => "selected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RuntimeAccountSignal {
    pub source: Option<RuntimeCurrentAccountSource>,
    pub last_account_index: Option<i64>,
    pub last_account_id: Option<String>,
    pub last_account_email: Option<String>,
    pub last_account_label: Option<String>,
    pub last_account_updated_at: Option<i64>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeCurrentAccountSelection {
    pub index: usize,
    pub source: RuntimeCurrentAccountSource,
    pub matched_by: RuntimeCurrentAccountMatch,
    pub updated_at: i64,
    pub last_account_id: Option<String>,
    pub last_account_email: Option<String>,
    pub last_account_label: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeCurrentAccountOptions {
    pub now: Option<i64>,
    pub max_age_ms: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeCurrentAccountSources {
    pub runtime_snapshot: Option<RuntimeObservabilitySnapshot>,
    pub app_bind_status: Option<AppBindRouterStatus>,
    pub app_helper_status: Option<RuntimeAccountSignal>,
}

pub const RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
const APP_RUNTIME_HELPER_KIND: &str = "codex-app-runtime-rotation-helper";
const MAX_STATUS_FILE_BYTES: u64 = 1024 * 1024; // 1 MB sanity cap

/// `runtime-rotation-app-helper.json` shape (all nullable, spec 10 §12.6).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AppRuntimeHelperAccountStatus {
    pub kind: Option<String>,
    pub state: Option<String>,
    pub pid: Option<i64>,
    pub last_account_index: Option<i64>,
    pub last_account_label: Option<String>,
    pub last_account_email: Option<String>,
    pub last_account_id: Option<String>,
    pub last_account_updated_at: Option<i64>,
    pub updated_at: Option<i64>,
}

fn normalize_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_account_id(value: Option<&str>) -> Option<String> {
    normalize_string(value)
}

fn normalize_email(value: Option<&str>) -> Option<String> {
    normalize_string(value).map(|email| email.to_lowercase())
}

/// Index normalization: truncate toward zero; negative → None.
fn normalize_index(value: Option<i64>) -> Option<i64> {
    match value {
        Some(index) if index >= 0 => Some(index),
        _ => None,
    }
}

fn normalize_timestamp_value(value: Option<i64>) -> Option<i64> {
    value.filter(|timestamp| *timestamp > 0)
}

/// Effective timestamp of a signal = max of the positive finite values.
fn normalize_timestamp(signal: &RuntimeAccountSignal) -> Option<i64> {
    [
        normalize_timestamp_value(signal.last_account_updated_at),
        normalize_timestamp_value(signal.updated_at),
    ]
    .into_iter()
    .flatten()
    .max()
}

fn read_optional_number(record: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    match record.get(key) {
        Some(value) if value.is_number() => value.as_i64().or_else(|| {
            // Fractional values truncate toward zero (JS Math.trunc happens at
            // the index-normalization layer; other numeric fields tolerate it).
            value.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)
        }),
        _ => None,
    }
}

fn read_optional_string(record: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    match record.get(key) {
        Some(Value::String(value)) => normalize_string(Some(value)),
        _ => None,
    }
}

/// `readAppRuntimeHelperStatus` — reads
/// `<multiAuthDir>/runtime-rotation-app-helper.json`; None when missing,
/// larger than 1 MB, unparseable, or not a JSON object. Strings must be
/// non-empty after trim; numbers finite.
pub fn read_app_runtime_helper_status() -> Option<AppRuntimeHelperAccountStatus> {
    read_app_runtime_helper_status_at(
        &get_codex_multi_auth_dir().join(APP_RUNTIME_HELPER_STATUS_FILE),
    )
}

fn read_app_runtime_helper_status_at(status_path: &PathBuf) -> Option<AppRuntimeHelperAccountStatus> {
    let metadata = std::fs::metadata(status_path).ok()?;
    if metadata.len() > MAX_STATUS_FILE_BYTES {
        return None;
    }
    let raw = std::fs::read_to_string(status_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let record = parsed.as_object()?;
    Some(AppRuntimeHelperAccountStatus {
        kind: read_optional_string(record, "kind"),
        state: read_optional_string(record, "state"),
        pid: read_optional_number(record, "pid"),
        last_account_index: read_optional_number(record, "lastAccountIndex"),
        last_account_label: read_optional_string(record, "lastAccountLabel"),
        last_account_email: read_optional_string(record, "lastAccountEmail"),
        last_account_id: read_optional_string(record, "lastAccountId"),
        last_account_updated_at: read_optional_number(record, "lastAccountUpdatedAt"),
        updated_at: read_optional_number(record, "updatedAt"),
    })
}

/// `appRuntimeHelperStatusToSignal` — trusted only when
/// `kind == "codex-app-runtime-rotation-helper"`, `state == "running"`, and
/// the pid is alive (EPERM counts as alive).
pub fn app_runtime_helper_status_to_signal(
    status: Option<&AppRuntimeHelperAccountStatus>,
) -> Option<RuntimeAccountSignal> {
    let status = status?;
    if status.kind.as_deref() != Some(APP_RUNTIME_HELPER_KIND) {
        return None;
    }
    if status.state.as_deref() != Some("running") {
        return None;
    }
    if !is_process_alive(status.pid) {
        return None;
    }
    Some(RuntimeAccountSignal {
        source: Some(RuntimeCurrentAccountSource::AppHelper),
        last_account_index: status.last_account_index,
        last_account_id: status.last_account_id.clone(),
        last_account_email: status.last_account_email.clone(),
        last_account_label: status.last_account_label.clone(),
        last_account_updated_at: status.last_account_updated_at,
        updated_at: status.updated_at,
    })
}

/// `readAppRuntimeHelperAccountSignal` — composition of the two above.
pub fn read_app_runtime_helper_account_signal() -> Option<RuntimeAccountSignal> {
    app_runtime_helper_status_to_signal(read_app_runtime_helper_status().as_ref())
}

fn runtime_snapshot_to_signal(
    snapshot: Option<&RuntimeObservabilitySnapshot>,
) -> Option<RuntimeAccountSignal> {
    let snapshot = snapshot?;
    Some(RuntimeAccountSignal {
        source: Some(RuntimeCurrentAccountSource::RuntimeObservability),
        last_account_index: snapshot.last_account_index,
        last_account_id: snapshot.last_account_id.clone(),
        last_account_email: snapshot.last_account_email.clone(),
        last_account_label: snapshot.last_account_label.clone(),
        last_account_updated_at: snapshot.last_account_updated_at,
        updated_at: Some(snapshot.updated_at),
    })
}

/// App-bind router status is eligible **only when `state == "running"`** — no
/// pid check here (spec 10 §4 step 2).
fn app_bind_status_to_signal(status: Option<&AppBindRouterStatus>) -> Option<RuntimeAccountSignal> {
    let status = status?;
    if status.state.as_deref() != Some("running") {
        return None;
    }
    Some(RuntimeAccountSignal {
        source: Some(RuntimeCurrentAccountSource::AppBind),
        last_account_index: status.last_account_index,
        last_account_id: status.last_account_id.clone(),
        last_account_email: status.last_account_email.clone(),
        last_account_label: status.last_account_label.clone(),
        last_account_updated_at: None,
        updated_at: status.updated_at,
    })
}

fn find_unique_email_index(storage: &AccountStorageV3, email: &str) -> Option<usize> {
    let mut match_index: Option<usize> = None;
    for (index, account) in storage.accounts.iter().enumerate() {
        if normalize_email(account.email.as_deref()).as_deref() != Some(email) {
            continue;
        }
        if match_index.is_some() {
            return None;
        }
        match_index = Some(index);
    }
    match_index
}

fn find_unique_account_id_index(storage: &AccountStorageV3, account_id: &str) -> Option<usize> {
    let mut match_index: Option<usize> = None;
    for (index, account) in storage.accounts.iter().enumerate() {
        if normalize_account_id(account.account_id.as_deref()).as_deref() != Some(account_id) {
            continue;
        }
        if match_index.is_some() {
            return None;
        }
        match_index = Some(index);
    }
    match_index
}

fn match_signal_to_account(
    storage: &AccountStorageV3,
    signal: &RuntimeAccountSignal,
) -> Option<(usize, RuntimeCurrentAccountMatch)> {
    let account_id = normalize_account_id(signal.last_account_id.as_deref());
    if let Some(account_id) = &account_id
        && let Some(id_index) = find_unique_account_id_index(storage, account_id)
    {
        return Some((id_index, RuntimeCurrentAccountMatch::AccountId));
    }

    let email = normalize_email(signal.last_account_email.as_deref());
    if let Some(email) = &email
        && let Some(email_index) = find_unique_email_index(storage, email)
    {
        return Some((email_index, RuntimeCurrentAccountMatch::Email));
    }

    let index = normalize_index(signal.last_account_index)?;
    let index = usize::try_from(index).ok()?;
    if index >= storage.accounts.len() {
        return None;
    }
    let indexed_account = storage.accounts.get(index)?;

    // Guard: an index fallback that contradicts the signal's id/email is no
    // match at all.
    let indexed_account_id = normalize_account_id(indexed_account.account_id.as_deref());
    if let (Some(signal_id), Some(indexed_id)) = (&account_id, &indexed_account_id)
        && indexed_id != signal_id
    {
        return None;
    }
    let indexed_email = normalize_email(indexed_account.email.as_deref());
    if let (Some(signal_email), Some(indexed_email)) = (&email, &indexed_email)
        && indexed_email != signal_email
    {
        return None;
    }
    Some((index, RuntimeCurrentAccountMatch::Index))
}

/// `resolveRuntimeCurrentAccount` — see spec 10 §4 for the exact precedence.
pub fn resolve_runtime_current_account(
    storage: &AccountStorageV3,
    sources: &RuntimeCurrentAccountSources,
    options: RuntimeCurrentAccountOptions,
) -> Option<RuntimeCurrentAccountSelection> {
    if storage.accounts.is_empty() {
        return None;
    }
    let now = options.now.unwrap_or_else(now_ms);
    let max_age_ms = options.max_age_ms.unwrap_or(RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS);

    let mut signals: Vec<(RuntimeAccountSignal, i64)> = [
        runtime_snapshot_to_signal(sources.runtime_snapshot.as_ref()),
        app_bind_status_to_signal(sources.app_bind_status.as_ref()),
        sources.app_helper_status.clone(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|signal| {
        let updated_at = normalize_timestamp(&signal)?;
        if now - updated_at > max_age_ms {
            return None;
        }
        Some((signal, updated_at))
    })
    .collect();
    signals.sort_by(|(left_signal, left_ts), (right_signal, right_ts)| {
        right_ts.cmp(left_ts).then_with(|| {
            let left_rank = left_signal.source.map(|s| s.rank()).unwrap_or(u8::MAX);
            let right_rank = right_signal.source.map(|s| s.rank()).unwrap_or(u8::MAX);
            left_rank.cmp(&right_rank)
        })
    });

    for (signal, updated_at) in signals {
        let Some((index, matched_by)) = match_signal_to_account(storage, &signal) else {
            continue;
        };
        return Some(RuntimeCurrentAccountSelection {
            index,
            source: signal
                .source
                .unwrap_or(RuntimeCurrentAccountSource::AppHelper),
            matched_by,
            updated_at,
            last_account_id: normalize_account_id(signal.last_account_id.as_deref()),
            last_account_email: normalize_email(signal.last_account_email.as_deref()),
            last_account_label: normalize_string(signal.last_account_label.as_deref()),
        });
    }

    None
}

/// `resolveAccountCurrentMarkers` — no runtime signal (or runtime index ==
/// stored index): `["current"]` at the stored index, else `[]`; divergent:
/// `"in-use"` at the runtime index, `"selected"` at the stored index.
pub fn resolve_account_current_markers(
    index: usize,
    stored_current_index: usize,
    runtime_current: Option<&RuntimeCurrentAccountSelection>,
) -> Vec<AccountCurrentMarker> {
    let Some(runtime_current) = runtime_current else {
        return if index == stored_current_index {
            vec![AccountCurrentMarker::Current]
        } else {
            Vec::new()
        };
    };
    if runtime_current.index == stored_current_index {
        return if index == stored_current_index {
            vec![AccountCurrentMarker::Current]
        } else {
            Vec::new()
        };
    }
    let mut markers = Vec::new();
    if index == runtime_current.index {
        markers.push(AccountCurrentMarker::InUse);
    }
    if index == stored_current_index {
        markers.push(AccountCurrentMarker::Selected);
    }
    markers
}

/// `isDisplayCurrentAccount` — the runtime index wins when a runtime signal
/// exists, else the stored index.
pub fn is_display_current_account(
    index: usize,
    stored_current_index: usize,
    runtime_current: Option<&RuntimeCurrentAccountSelection>,
) -> bool {
    match runtime_current {
        Some(runtime_current) => index == runtime_current.index,
        None => index == stored_current_index,
    }
}

/// `getRuntimeStatusMarker` (from `status-marker.ts`) — identical duplicate of
/// [`crate::ui_runtime::get_status_marker`].
pub fn get_runtime_status_marker(ui: &StatusMarkerTheme, status: RuntimeStatus) -> String {
    get_status_marker(ui, status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn account(email: Option<&str>, account_id: Option<&str>) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(
            format!(
                "rt-{}-{}",
                email.unwrap_or("none"),
                account_id.unwrap_or("none")
            ),
            0,
            0,
        );
        account.email = email.map(str::to_string);
        account.account_id = account_id.map(str::to_string);
        account
    }

    fn storage(accounts: Vec<AccountMetadataV3>) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts = accounts;
        storage
    }

    fn observability_signal_snapshot(
        updated_at: i64,
        index: Option<i64>,
        id: Option<&str>,
        email: Option<&str>,
    ) -> RuntimeObservabilitySnapshot {
        let mut snapshot = crate::observability::create_default_snapshot();
        snapshot.updated_at = updated_at;
        snapshot.last_account_index = index;
        snapshot.last_account_id = id.map(str::to_string);
        snapshot.last_account_email = email.map(str::to_string);
        snapshot
    }

    // runtime-current-account.test.ts: "uses the freshest runtime source and
    // matches by account id"
    #[test]
    fn uses_the_freshest_runtime_source_and_matches_by_account_id() {
        let storage = storage(vec![
            account(Some("a@example.com"), Some("acc_a")),
            account(Some("b@example.com"), Some("acc_b")),
        ]);
        let now = 1_000_000;
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(
                now - 5_000,
                Some(0),
                Some("acc_a"),
                None,
            )),
            app_bind_status: Some(AppBindRouterStatus {
                state: Some("running".to_string()),
                last_account_id: Some("acc_b".to_string()),
                updated_at: Some(now - 1_000),
                ..AppBindRouterStatus::default()
            }),
            app_helper_status: None,
        };
        let selection = resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .expect("selection");
        // app-bind is fresher → wins despite lower source rank.
        assert_eq!(selection.index, 1);
        assert_eq!(selection.source, RuntimeCurrentAccountSource::AppBind);
        assert_eq!(selection.matched_by, RuntimeCurrentAccountMatch::AccountId);
        assert_eq!(selection.last_account_id.as_deref(), Some("acc_b"));
    }

    // "uses deterministic source precedence for equal timestamp signals"
    #[test]
    fn uses_deterministic_source_precedence_for_equal_timestamp_signals() {
        let storage = storage(vec![
            account(Some("a@example.com"), Some("acc_a")),
            account(Some("b@example.com"), Some("acc_b")),
        ]);
        let now = 1_000_000;
        let ts = now - 2_000;
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(ts, None, Some("acc_a"), None)),
            app_bind_status: Some(AppBindRouterStatus {
                state: Some("running".to_string()),
                last_account_id: Some("acc_b".to_string()),
                updated_at: Some(ts),
                ..AppBindRouterStatus::default()
            }),
            app_helper_status: None,
        };
        let selection = resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .expect("selection");
        // Tie → runtime-observability (rank 0) wins.
        assert_eq!(selection.source, RuntimeCurrentAccountSource::RuntimeObservability);
        assert_eq!(selection.index, 0);
    }

    // "ignores stale runtime account signals"
    #[test]
    fn ignores_stale_runtime_account_signals() {
        let storage = storage(vec![account(Some("a@example.com"), Some("acc_a"))]);
        let now = RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS * 2;
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(
                now - RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS - 1,
                Some(0),
                Some("acc_a"),
                None,
            )),
            ..RuntimeCurrentAccountSources::default()
        };
        assert!(resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .is_none());
    }

    // "keeps live sessions current when heartbeat is newer than switch
    // timestamp" — effective ts = max(lastAccountUpdatedAt, updatedAt).
    #[test]
    fn keeps_live_sessions_current_when_heartbeat_is_newer_than_switch_timestamp() {
        let storage = storage(vec![account(Some("a@example.com"), Some("acc_a"))]);
        let now = RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS * 3;
        let mut snapshot = observability_signal_snapshot(0, Some(0), Some("acc_a"), None);
        // Old switch stamp but a fresh heartbeat.
        snapshot.last_account_updated_at = Some(now - RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS * 2);
        snapshot.updated_at = now - 60_000;
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(snapshot),
            ..RuntimeCurrentAccountSources::default()
        };
        let selection = resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .expect("selection");
        assert_eq!(selection.updated_at, now - 60_000);
    }

    // "does not accept ambiguous duplicate account-id matches"
    #[test]
    fn does_not_accept_ambiguous_duplicate_account_id_matches() {
        let storage = storage(vec![
            account(Some("a@example.com"), Some("acc_dup")),
            account(Some("b@example.com"), Some("acc_dup")),
        ]);
        let now = 1_000_000;
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(
                now - 1_000,
                None,
                Some("acc_dup"),
                Some("b@example.com"),
            )),
            ..RuntimeCurrentAccountSources::default()
        };
        let selection = resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .expect("selection");
        // Duplicate id disqualifies the id path; unique email still matches.
        assert_eq!(selection.matched_by, RuntimeCurrentAccountMatch::Email);
        assert_eq!(selection.index, 1);
    }

    // "ignores app-bind router status that is not running"
    #[test]
    fn ignores_app_bind_router_status_that_is_not_running() {
        let storage = storage(vec![account(Some("a@example.com"), Some("acc_a"))]);
        let now = 1_000_000;
        let sources = RuntimeCurrentAccountSources {
            app_bind_status: Some(AppBindRouterStatus {
                state: Some("stopped".to_string()),
                last_account_id: Some("acc_a".to_string()),
                updated_at: Some(now - 100),
                ..AppBindRouterStatus::default()
            }),
            ..RuntimeCurrentAccountSources::default()
        };
        assert!(resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .is_none());
    }

    // "only turns a running live app helper status into a runtime signal"
    #[test]
    fn only_turns_a_running_live_app_helper_status_into_a_runtime_signal() {
        let mut status = AppRuntimeHelperAccountStatus {
            kind: Some(APP_RUNTIME_HELPER_KIND.to_string()),
            state: Some("running".to_string()),
            pid: Some(i64::from(std::process::id())),
            last_account_index: Some(0),
            updated_at: Some(123),
            ..AppRuntimeHelperAccountStatus::default()
        };
        let signal =
            app_runtime_helper_status_to_signal(Some(&status)).expect("live helper is a signal");
        assert_eq!(signal.source, Some(RuntimeCurrentAccountSource::AppHelper));

        status.state = Some("stopped".to_string());
        assert!(app_runtime_helper_status_to_signal(Some(&status)).is_none());
        status.state = Some("running".to_string());
        status.kind = Some("other-kind".to_string());
        assert!(app_runtime_helper_status_to_signal(Some(&status)).is_none());
        status.kind = Some(APP_RUNTIME_HELPER_KIND.to_string());
        status.pid = None;
        assert!(app_runtime_helper_status_to_signal(Some(&status)).is_none());
        assert!(app_runtime_helper_status_to_signal(None).is_none());
    }

    // "labels stored selected and runtime in-use rows separately"
    #[test]
    fn labels_stored_selected_and_runtime_in_use_rows_separately() {
        let runtime = RuntimeCurrentAccountSelection {
            index: 2,
            source: RuntimeCurrentAccountSource::RuntimeObservability,
            matched_by: RuntimeCurrentAccountMatch::Index,
            updated_at: 1,
            last_account_id: None,
            last_account_email: None,
            last_account_label: None,
        };
        assert_eq!(
            resolve_account_current_markers(2, 0, Some(&runtime)),
            vec![AccountCurrentMarker::InUse]
        );
        assert_eq!(
            resolve_account_current_markers(0, 0, Some(&runtime)),
            vec![AccountCurrentMarker::Selected]
        );
        assert!(resolve_account_current_markers(1, 0, Some(&runtime)).is_empty());
        // Runtime == stored: only "current" at the stored index.
        let aligned = RuntimeCurrentAccountSelection { index: 0, ..runtime };
        assert_eq!(
            resolve_account_current_markers(0, 0, Some(&aligned)),
            vec![AccountCurrentMarker::Current]
        );
        assert!(resolve_account_current_markers(1, 0, Some(&aligned)).is_empty());
        // No runtime signal.
        assert_eq!(
            resolve_account_current_markers(0, 0, None),
            vec![AccountCurrentMarker::Current]
        );
        assert!(resolve_account_current_markers(1, 0, None).is_empty());
        // Display-current follows the runtime index when present.
        assert!(is_display_current_account(2, 0, Some(&RuntimeCurrentAccountSelection { index: 2, ..aligned.clone() })));
        assert!(!is_display_current_account(0, 0, Some(&RuntimeCurrentAccountSelection { index: 2, ..aligned })));
        assert!(is_display_current_account(0, 0, None));
    }

    // "falls back to the reported index when id and email are absent"
    #[test]
    fn falls_back_to_the_reported_index_when_id_and_email_are_absent() {
        let storage = storage(vec![
            account(Some("a@example.com"), Some("acc_a")),
            account(Some("b@example.com"), Some("acc_b")),
        ]);
        let now = 1_000_000;
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(now - 100, Some(1), None, None)),
            ..RuntimeCurrentAccountSources::default()
        };
        let selection = resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .expect("selection");
        assert_eq!(selection.index, 1);
        assert_eq!(selection.matched_by, RuntimeCurrentAccountMatch::Index);
    }

    // "truncates fractional indices and rejects negative or out-of-range ones"
    #[test]
    fn rejects_negative_or_out_of_range_indices() {
        let storage = storage(vec![account(Some("a@example.com"), None)]);
        let now = 1_000_000;
        for bad_index in [Some(-1), Some(5)] {
            let sources = RuntimeCurrentAccountSources {
                runtime_snapshot: Some(observability_signal_snapshot(
                    now - 100,
                    bad_index,
                    None,
                    None,
                )),
                ..RuntimeCurrentAccountSources::default()
            };
            assert!(
                resolve_runtime_current_account(
                    &storage,
                    &sources,
                    RuntimeCurrentAccountOptions {
                        now: Some(now),
                        max_age_ms: None,
                    },
                )
                .is_none(),
                "index {bad_index:?} must not match"
            );
        }
    }

    // "rejects an index fallback that contradicts the signal account id or
    // email"
    #[test]
    fn rejects_an_index_fallback_that_contradicts_the_signal_identity() {
        let storage = storage(vec![
            account(Some("a@example.com"), Some("acc_a")),
            account(Some("b@example.com"), Some("acc_b")),
        ]);
        let now = 1_000_000;
        // Signal id "acc_zz" (matches nothing uniquely) + index 0 whose
        // account has a DIFFERENT id → no match.
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(
                now - 100,
                Some(0),
                Some("acc_zz"),
                None,
            )),
            ..RuntimeCurrentAccountSources::default()
        };
        assert!(resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .is_none());
        // Same for a contradicting email.
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(
                now - 100,
                Some(0),
                None,
                Some("zz@example.com"),
            )),
            ..RuntimeCurrentAccountSources::default()
        };
        assert!(resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .is_none());
    }

    // "ignores whitespace-only ids and emails when matching by index"
    #[test]
    fn ignores_whitespace_only_ids_and_emails_when_matching_by_index() {
        let storage = storage(vec![account(Some("  "), Some("   "))]);
        let now = 1_000_000;
        let sources = RuntimeCurrentAccountSources {
            runtime_snapshot: Some(observability_signal_snapshot(
                now - 100,
                Some(0),
                Some("acc_a"),
                Some("a@example.com"),
            )),
            ..RuntimeCurrentAccountSources::default()
        };
        // The indexed account's blank id/email normalize to None → the
        // contradiction guard does not fire → index match.
        let selection = resolve_runtime_current_account(
            &storage,
            &sources,
            RuntimeCurrentAccountOptions {
                now: Some(now),
                max_age_ms: None,
            },
        )
        .expect("selection");
        assert_eq!(selection.matched_by, RuntimeCurrentAccountMatch::Index);
    }

    // readAppRuntimeHelperStatus file-shape tests.
    #[test]
    #[serial(env)]
    fn read_app_runtime_helper_status_file_contract() {
        let sandbox = EnvSandbox::new();
        let dir = sandbox.codex_multi_auth_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(APP_RUNTIME_HELPER_STATUS_FILE);

        // Missing file → None.
        assert!(read_app_runtime_helper_status().is_none());

        // Malformed JSON → None; array → None.
        std::fs::write(&path, "{not json").unwrap();
        assert!(read_app_runtime_helper_status().is_none());
        std::fs::write(&path, "[1,2,3]").unwrap();
        assert!(read_app_runtime_helper_status().is_none());

        // >1 MB → None.
        let big = format!(
            "{{\"kind\": \"{APP_RUNTIME_HELPER_KIND}\", \"pad\": \"{}\"}}",
            "x".repeat((MAX_STATUS_FILE_BYTES as usize) + 10)
        );
        std::fs::write(&path, big).unwrap();
        assert!(read_app_runtime_helper_status().is_none());

        // Types normalized: strings trimmed, wrong-typed values dropped.
        std::fs::write(
            &path,
            format!(
                "{{\"kind\": \"  {APP_RUNTIME_HELPER_KIND}  \", \"state\": 5, \"pid\": \"nope\", \"lastAccountIndex\": 2, \"lastAccountLabel\": \"  \", \"updatedAt\": 42}}"
            ),
        )
        .unwrap();
        let status = read_app_runtime_helper_status().expect("status record");
        assert_eq!(status.kind.as_deref(), Some(APP_RUNTIME_HELPER_KIND));
        assert!(status.state.is_none());
        assert!(status.pid.is_none());
        assert_eq!(status.last_account_index, Some(2));
        assert!(status.last_account_label.is_none());
        assert_eq!(status.updated_at, Some(42));
    }
}
