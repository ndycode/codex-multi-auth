//! Port of `lib/codex-cli/observability.ts` — in-process metrics counters for
//! the Codex CLI mirror plus account fingerprint hashing for log lines.
//!
//! Behavior source: specs/11-cli-usage-recovery.md §1.1.
//!
//! Contracts:
//! - All 12 counters default to 0 and live in a module-level mutable singleton.
//! - Metrics are **per-process, in-memory only** — never persisted to disk
//!   (spec 11 gotcha 39).
//! - `make_account_fingerprint` prefers the trimmed accountId, falls back to
//!   the trimmed **lowercased** email, and returns the first 12 hex chars of
//!   the sha256 — raw ids/emails must never reach logs.

use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};

/// The Codex CLI mirror metric counters (TS `CodexCliMetrics`).
///
/// Serialized (diagnostics only — never persisted) with the exact TS field
/// names via camelCase renames.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliMetrics {
    pub read_attempts: u64,
    pub read_successes: u64,
    pub read_misses: u64,
    pub read_failures: u64,
    pub legacy_sync_env_uses: u64,
    pub reconcile_attempts: u64,
    pub reconcile_changes: u64,
    pub reconcile_noops: u64,
    pub reconcile_failures: u64,
    pub write_attempts: u64,
    pub write_successes: u64,
    pub write_failures: u64,
}

/// Typed key for [`increment_codex_cli_metric`] (TS `keyof CodexCliMetrics`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexCliMetricKey {
    ReadAttempts,
    ReadSuccesses,
    ReadMisses,
    ReadFailures,
    LegacySyncEnvUses,
    ReconcileAttempts,
    ReconcileChanges,
    ReconcileNoops,
    ReconcileFailures,
    WriteAttempts,
    WriteSuccesses,
    WriteFailures,
}

static METRICS: Mutex<CodexCliMetrics> = Mutex::new(CodexCliMetrics {
    read_attempts: 0,
    read_successes: 0,
    read_misses: 0,
    read_failures: 0,
    legacy_sync_env_uses: 0,
    reconcile_attempts: 0,
    reconcile_changes: 0,
    reconcile_noops: 0,
    reconcile_failures: 0,
    write_attempts: 0,
    write_successes: 0,
    write_failures: 0,
});

fn lock_metrics() -> std::sync::MutexGuard<'static, CodexCliMetrics> {
    METRICS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Add `delta` to the given counter (TS `incrementCodexCliMetric(key, delta)`).
pub fn increment_codex_cli_metric_by(key: CodexCliMetricKey, delta: u64) {
    let mut metrics = lock_metrics();
    let slot = match key {
        CodexCliMetricKey::ReadAttempts => &mut metrics.read_attempts,
        CodexCliMetricKey::ReadSuccesses => &mut metrics.read_successes,
        CodexCliMetricKey::ReadMisses => &mut metrics.read_misses,
        CodexCliMetricKey::ReadFailures => &mut metrics.read_failures,
        CodexCliMetricKey::LegacySyncEnvUses => &mut metrics.legacy_sync_env_uses,
        CodexCliMetricKey::ReconcileAttempts => &mut metrics.reconcile_attempts,
        CodexCliMetricKey::ReconcileChanges => &mut metrics.reconcile_changes,
        CodexCliMetricKey::ReconcileNoops => &mut metrics.reconcile_noops,
        CodexCliMetricKey::ReconcileFailures => &mut metrics.reconcile_failures,
        CodexCliMetricKey::WriteAttempts => &mut metrics.write_attempts,
        CodexCliMetricKey::WriteSuccesses => &mut metrics.write_successes,
        CodexCliMetricKey::WriteFailures => &mut metrics.write_failures,
    };
    *slot = slot.saturating_add(delta);
}

/// Increment the given counter by 1 (TS default `delta = 1`).
pub fn increment_codex_cli_metric(key: CodexCliMetricKey) {
    increment_codex_cli_metric_by(key, 1);
}

/// Shallow copy of the current counters (TS `getCodexCliMetricsSnapshot`).
pub fn get_codex_cli_metrics_snapshot() -> CodexCliMetrics {
    *lock_metrics()
}

/// Reset all counters to 0 (TS `resetCodexCliMetricsForTests`).
pub fn reset_codex_cli_metrics_for_tests() {
    *lock_metrics() = CodexCliMetrics::default();
}

/// Stable 12-hex-char fingerprint for log lines (TS `makeAccountFingerprint`).
///
/// Raw value preference: trimmed non-empty `account_id`, else trimmed
/// **lowercased** non-empty `email`, else `None`. The fingerprint is the first
/// 12 hex chars of `sha256(raw)`; raw ids/emails are never logged.
pub fn make_account_fingerprint(
    account_id: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    let raw = match account_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => id.to_string(),
        None => match email.map(str::trim).filter(|email| !email.is_empty()) {
            Some(email) => email.to_lowercase(),
            None => return None,
        },
    };
    let digest = Sha256::digest(raw.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(hex[..12].to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn fingerprint_prefers_account_id_over_email() {
        let by_id = make_account_fingerprint(Some("acct-user-one"), Some("user@example.com"));
        let id_only = make_account_fingerprint(Some("acct-user-one"), None);
        assert_eq!(by_id, id_only);
        assert!(by_id.is_some());
    }

    #[test]
    fn fingerprint_trims_and_lowercases_email_fallback() {
        let mixed = make_account_fingerprint(None, Some("  User.One@Example.COM  "));
        let lower = make_account_fingerprint(None, Some("user.one@example.com"));
        assert_eq!(mixed, lower);
        // Blank accountId falls through to the email.
        let blank_id = make_account_fingerprint(Some("   "), Some("user.one@example.com"));
        assert_eq!(blank_id, lower);
    }

    #[test]
    fn fingerprint_is_none_when_both_identifiers_are_absent_or_blank() {
        assert_eq!(make_account_fingerprint(None, None), None);
        assert_eq!(make_account_fingerprint(Some("  "), Some("")), None);
    }

    #[test]
    fn fingerprint_is_12_lowercase_hex_chars_and_never_the_raw_value() {
        let fp = make_account_fingerprint(Some("acct-user-one"), None).unwrap();
        assert_eq!(fp.len(), 12);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(fp, "acct-user-one");
    }

    #[test]
    #[serial(env)] // metrics are process-global shared state
    fn metrics_increment_snapshot_and_reset() {
        reset_codex_cli_metrics_for_tests();
        assert_eq!(get_codex_cli_metrics_snapshot(), CodexCliMetrics::default());

        increment_codex_cli_metric(CodexCliMetricKey::ReadAttempts);
        increment_codex_cli_metric(CodexCliMetricKey::ReadAttempts);
        increment_codex_cli_metric_by(CodexCliMetricKey::WriteFailures, 3);
        let snapshot = get_codex_cli_metrics_snapshot();
        assert_eq!(snapshot.read_attempts, 2);
        assert_eq!(snapshot.write_failures, 3);
        assert_eq!(snapshot.read_successes, 0);

        // Snapshot is a copy — later increments do not mutate it.
        increment_codex_cli_metric(CodexCliMetricKey::ReadAttempts);
        assert_eq!(snapshot.read_attempts, 2);

        reset_codex_cli_metrics_for_tests();
        assert_eq!(get_codex_cli_metrics_snapshot(), CodexCliMetrics::default());
    }

    #[test]
    fn metrics_serialize_with_ts_field_names() {
        let json = serde_json::to_value(CodexCliMetrics::default()).unwrap();
        let object = json.as_object().unwrap();
        for key in [
            "readAttempts",
            "readSuccesses",
            "readMisses",
            "readFailures",
            "legacySyncEnvUses",
            "reconcileAttempts",
            "reconcileChanges",
            "reconcileNoops",
            "reconcileFailures",
            "writeAttempts",
            "writeSuccesses",
            "writeFailures",
        ] {
            assert!(object.contains_key(key), "missing {key}");
        }
        assert_eq!(object.len(), 12);
    }
}
