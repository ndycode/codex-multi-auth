//! Port of `lib/runtime/runtime-observability.ts` — process-wide singleton
//! snapshot of proxy metrics, persisted to `<mad>/runtime-observability.json`.
//!
//! **In-memory state is the source of truth; disk is a write-behind mirror**
//! loaded once lazily at first access. Persistence rules (spec 10 §5 / §12.5):
//! `JSON.stringify(snapshot, null, 2)` with NO trailing newline, file mode
//! 0o600, dir 0o700 (re-asserted via chmod on POSIX — non-ENOENT chmod errors
//! THROW so a world-readable dir never silently holds account ids), temp+rename
//! with 3 attempts retrying only EBUSY/EPERM. Writes are serialized and every
//! write error is swallowed. Version-gated: a persisted numeric `version != 1`
//! discards the file.
//!
//! Test-mode gate: the TS module skipped persistence entirely when
//! `process.env.VITEST === "true"`; the Rust port keeps the same env var name
//! but reads it live (per call) instead of once at module load, so test
//! harnesses can flip it without ordering constraints (gotcha 23).

use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use cma_core::json_io::{
    read_text_file, stringify_pretty2, write_json_atomic_sync, TrailingNewline, WriteJsonOptions,
};
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::utils::now_ms;

pub const RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION: i64 = 1;
const SNAPSHOT_FILE_NAME: &str = "runtime-observability.json";

/// Nested `runtimeMetrics` shape — all counters default 0. Field order is the
/// TS declaration order (serialization order matters for byte parity).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetricsSnapshot {
    pub started_at: i64,
    pub total_requests: i64,
    pub successful_requests: i64,
    pub failed_requests: i64,
    pub responses_requests: i64,
    pub auth_refresh_requests: i64,
    pub diagnostic_probe_requests: i64,
    pub outbound_request_attempt_budget: Option<i64>,
    pub outbound_request_attempts_consumed: i64,
    pub request_attempt_budget_exhaustions: i64,
    pub pool_exhaustion_fast_fails: i64,
    pub server_burst_fast_fails: i64,
    pub rate_limited_responses: i64,
    pub server_errors: i64,
    pub network_errors: i64,
    pub user_aborts: i64,
    pub auth_refresh_failures: i64,
    pub empty_response_retries: i64,
    pub account_rotations: i64,
    pub same_account_retries: i64,
    pub stream_failover_attempts: i64,
    pub stream_failover_candidates_considered: i64,
    pub last_stream_failover_candidate_count: i64,
    pub stream_failover_recoveries: i64,
    pub stream_failover_cross_account_recoveries: i64,
    pub cumulative_latency_ms: i64,
    pub last_request_at: Option<i64>,
    pub last_error: Option<String>,
    /// Unknown keys from a persisted file survive the merge (`{...base,
    /// ...parsed.runtimeMetrics}` in TS) and re-serialize after the known set.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Top-level persisted snapshot. Every field is populated by the default
/// snapshot (TS `createDefaultSnapshot`), so `Option` fields serialize as
/// explicit `null`, matching the TS output byte-for-byte.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeObservabilitySnapshot {
    pub version: i64,
    pub updated_at: i64,
    pub current_request_id: Option<String>,
    pub responses_requests: i64,
    pub auth_refresh_requests: i64,
    pub diagnostic_probe_requests: i64,
    pub pool_exhaustion_cooldown_until: Option<i64>,
    pub server_burst_cooldown_until: Option<i64>,
    pub last_account_index: Option<i64>,
    pub last_account_label: Option<String>,
    pub last_account_email: Option<String>,
    pub last_account_id: Option<String>,
    pub last_account_updated_at: Option<i64>,
    pub last_pool_exhaustion_reason: Option<String>,
    pub last_pool_exhaustion_retry_after_ms: Option<i64>,
    /// Keys are stringified account indexes.
    pub last_pool_exhaustion_skip_reasons: serde_json::Map<String, Value>,
    pub last_runtime_reset_at: Option<i64>,
    pub last_runtime_reset_reason: Option<String>,
    pub last_runtime_reload_at: Option<i64>,
    pub last_runtime_reload_reason: Option<String>,
    pub account_skip_reasons: serde_json::Map<String, Value>,
    pub policy_blocked_indexes: Vec<i64>,
    pub policy_blocked_reasons: serde_json::Map<String, Value>,
    pub runtime_metrics: RuntimeMetricsSnapshot,
    /// Unknown top-level keys from a persisted file (TS `{...base, ...parsed}`
    /// spread keeps them); re-serialized after the known fields.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

fn create_default_metrics() -> RuntimeMetricsSnapshot {
    RuntimeMetricsSnapshot {
        started_at: 0,
        total_requests: 0,
        successful_requests: 0,
        failed_requests: 0,
        responses_requests: 0,
        auth_refresh_requests: 0,
        diagnostic_probe_requests: 0,
        outbound_request_attempt_budget: None,
        outbound_request_attempts_consumed: 0,
        request_attempt_budget_exhaustions: 0,
        pool_exhaustion_fast_fails: 0,
        server_burst_fast_fails: 0,
        rate_limited_responses: 0,
        server_errors: 0,
        network_errors: 0,
        user_aborts: 0,
        auth_refresh_failures: 0,
        empty_response_retries: 0,
        account_rotations: 0,
        same_account_retries: 0,
        stream_failover_attempts: 0,
        stream_failover_candidates_considered: 0,
        last_stream_failover_candidate_count: 0,
        stream_failover_recoveries: 0,
        stream_failover_cross_account_recoveries: 0,
        cumulative_latency_ms: 0,
        last_request_at: None,
        last_error: None,
        extra: serde_json::Map::new(),
    }
}

pub fn create_default_snapshot() -> RuntimeObservabilitySnapshot {
    RuntimeObservabilitySnapshot {
        version: RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION,
        updated_at: 0,
        current_request_id: None,
        responses_requests: 0,
        auth_refresh_requests: 0,
        diagnostic_probe_requests: 0,
        pool_exhaustion_cooldown_until: None,
        server_burst_cooldown_until: None,
        last_account_index: None,
        last_account_label: None,
        last_account_email: None,
        last_account_id: None,
        last_account_updated_at: None,
        last_pool_exhaustion_reason: None,
        last_pool_exhaustion_retry_after_ms: None,
        last_pool_exhaustion_skip_reasons: serde_json::Map::new(),
        last_runtime_reset_at: None,
        last_runtime_reset_reason: None,
        last_runtime_reload_at: None,
        last_runtime_reload_reason: None,
        account_skip_reasons: serde_json::Map::new(),
        policy_blocked_indexes: Vec::new(),
        policy_blocked_reasons: serde_json::Map::new(),
        runtime_metrics: create_default_metrics(),
        extra: serde_json::Map::new(),
    }
}

/// `PERSIST_RUNTIME_SNAPSHOT` — persistence disabled under the vitest-style
/// test gate. Read live (see module docs).
fn persist_runtime_snapshot() -> bool {
    std::env::var("VITEST").ok().as_deref() != Some("true")
}

static SNAPSHOT_STATE: Mutex<Option<RuntimeObservabilitySnapshot>> = Mutex::new(None);
/// Serializes persisted writes (the TS pending-write promise chain).
static WRITE_QUEUE: Mutex<()> = Mutex::new(());

fn get_snapshot_path() -> PathBuf {
    get_codex_multi_auth_dir().join(SNAPSHOT_FILE_NAME)
}

/// Rebuild a string-valued overlay map (`{...(parsed.x ?? {})}` in TS —
/// non-object values collapse to `{}`; non-string entry values are dropped so
/// a corrupt file cannot poison the typed snapshot).
fn rebuild_reason_map(value: Option<&Value>) -> serde_json::Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map
            .iter()
            .filter(|(_, v)| v.is_string())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        _ => serde_json::Map::new(),
    }
}

/// `normalizePersistedSnapshot` — merge order: defaults ← parsed top-level ←
/// forced `version:1`; `runtimeMetrics` deep-merged over defaults; the four
/// map/array overlay fields rebuilt fresh. Returns `None` for non-objects and
/// for numeric versions other than 1.
fn normalize_persisted_snapshot(parsed: &Value) -> Option<RuntimeObservabilitySnapshot> {
    let parsed_map = parsed.as_object()?;
    if let Some(version) = parsed_map.get("version")
        && version.is_number()
        && version.as_i64() != Some(RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION)
    {
        return None;
    }

    let base = create_default_snapshot();
    let mut merged = match serde_json::to_value(&base) {
        Ok(Value::Object(map)) => map,
        _ => return None,
    };
    for (key, value) in parsed_map {
        merged.insert(key.clone(), value.clone());
    }
    merged.insert(
        "version".to_string(),
        Value::from(RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION),
    );

    // runtimeMetrics: defaults deep-merged with the parsed object (spread of a
    // non-object contributes nothing).
    let mut metrics = match serde_json::to_value(&base.runtime_metrics) {
        Ok(Value::Object(map)) => map,
        _ => return None,
    };
    if let Some(Value::Object(parsed_metrics)) = parsed_map.get("runtimeMetrics") {
        for (key, value) in parsed_metrics {
            metrics.insert(key.clone(), value.clone());
        }
    }
    merged.insert("runtimeMetrics".to_string(), Value::Object(metrics));

    merged.insert(
        "lastPoolExhaustionSkipReasons".to_string(),
        Value::Object(rebuild_reason_map(
            parsed_map.get("lastPoolExhaustionSkipReasons"),
        )),
    );
    merged.insert(
        "accountSkipReasons".to_string(),
        Value::Object(rebuild_reason_map(parsed_map.get("accountSkipReasons"))),
    );
    merged.insert(
        "policyBlockedIndexes".to_string(),
        Value::Array(match parsed_map.get("policyBlockedIndexes") {
            Some(Value::Array(values)) => values
                .iter()
                .filter(|v| v.as_i64().is_some() || v.as_u64().is_some())
                .cloned()
                .collect(),
            _ => Vec::new(),
        }),
    );
    merged.insert(
        "policyBlockedReasons".to_string(),
        Value::Object(rebuild_reason_map(parsed_map.get("policyBlockedReasons"))),
    );

    // Deviation from TS (recorded): TS spread garbage-typed fields straight
    // into the snapshot; the typed Rust struct cannot hold them, so a file
    // whose known field has the wrong JSON type resets to fresh defaults.
    serde_json::from_value(Value::Object(merged)).ok()
}

fn load_persisted_snapshot_from_disk() -> Option<RuntimeObservabilitySnapshot> {
    let path = get_snapshot_path();
    let raw = read_text_file(&path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    normalize_persisted_snapshot(&parsed)
}

fn ensure_snapshot_state<R>(f: impl FnOnce(&mut RuntimeObservabilitySnapshot) -> R) -> R {
    let mut guard = SNAPSHOT_STATE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if guard.is_none() {
        let loaded = if persist_runtime_snapshot() {
            load_persisted_snapshot_from_disk()
        } else {
            None
        };
        *guard = Some(loaded.unwrap_or_else(create_default_snapshot));
    }
    f(guard.as_mut().expect("snapshot state initialized"))
}

/// Persist a snapshot to disk. The snapshot holds account identifiers
/// (`lastAccountId`/label/index), so the directory is kept owner-only on
/// POSIX: `mkdir -p` with mode 0o700 plus an explicit re-`chmod 0o700` (mkdir
/// mode only applies to freshly created dirs). Only ENOENT is swallowed on
/// the chmod; any other failure is surfaced rather than silently leaving a
/// world-readable dir. Win32: modes are a no-op (Node parity).
fn write_snapshot(snapshot: &RuntimeObservabilitySnapshot) -> io::Result<()> {
    let dir = get_codex_multi_auth_dir();
    let path = get_snapshot_path();
    create_dir_owner_only(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error);
        }
    }
    let content = stringify_pretty2(snapshot);
    write_json_atomic_sync(
        &path,
        &content,
        Some(0o600),
        &WriteJsonOptions {
            trailing_newline: TrailingNewline::None,
            rename_max_attempts: 3,
            ..WriteJsonOptions::default()
        },
    )
}

fn create_dir_owner_only(dir: &std::path::Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// `getRuntimeObservabilitySnapshot` — a clone of the singleton (callers can't
/// mutate the live state through it).
pub fn get_runtime_observability_snapshot() -> RuntimeObservabilitySnapshot {
    ensure_snapshot_state(|snapshot| snapshot.clone())
}

/// `mutateRuntimeObservabilitySnapshot` — applies the mutator, stamps
/// `updatedAt = now`, and persists (skipped under the test gate). The write is
/// serialized through [`WRITE_QUEUE`] and all write errors are swallowed,
/// mirroring the TS pending-write promise chain with its `.catch(() =>
/// undefined)` tail. (The TS write was queued asynchronously; the Rust port
/// writes synchronously in mutation order — same ordering and error contract,
/// with the file visible immediately after the call returns.)
pub fn mutate_runtime_observability_snapshot(
    mutator: impl FnOnce(&mut RuntimeObservabilitySnapshot),
) {
    let next_snapshot = ensure_snapshot_state(|snapshot| {
        mutator(snapshot);
        snapshot.updated_at = now_ms();
        if persist_runtime_snapshot() {
            Some(snapshot.clone())
        } else {
            None
        }
    });
    if let Some(snapshot) = next_snapshot {
        let _queue = WRITE_QUEUE
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let _ = write_snapshot(&snapshot);
    }
}

/// `recordRuntimePoolExhaustion` — sets the pool-exhaustion diagnostics and
/// **copies** the skip reasons into both overlay maps.
pub fn record_runtime_pool_exhaustion(
    reason: &str,
    retry_after_ms: i64,
    account_skip_reasons: &serde_json::Map<String, Value>,
) {
    mutate_runtime_observability_snapshot(|snapshot| {
        snapshot.last_pool_exhaustion_reason = Some(reason.to_string());
        snapshot.last_pool_exhaustion_retry_after_ms = Some(retry_after_ms);
        snapshot.last_pool_exhaustion_skip_reasons = account_skip_reasons.clone();
        snapshot.account_skip_reasons = account_skip_reasons.clone();
    });
}

/// `recordRuntimeReload` — stamps reload time + reason.
pub fn record_runtime_reload(reason: &str) {
    mutate_runtime_observability_snapshot(|snapshot| {
        snapshot.last_runtime_reload_at = Some(now_ms());
        snapshot.last_runtime_reload_reason = Some(reason.to_string());
    });
}

/// `recordRuntimeReset` — stamps reset time + reason and clears both
/// skip-reason maps, the pool-exhaustion fields, and the policy-block state.
pub fn record_runtime_reset(reason: &str) {
    mutate_runtime_observability_snapshot(|snapshot| {
        snapshot.last_runtime_reset_at = Some(now_ms());
        snapshot.last_runtime_reset_reason = Some(reason.to_string());
        snapshot.last_pool_exhaustion_reason = None;
        snapshot.last_pool_exhaustion_retry_after_ms = None;
        snapshot.last_pool_exhaustion_skip_reasons = serde_json::Map::new();
        snapshot.account_skip_reasons = serde_json::Map::new();
        snapshot.policy_blocked_indexes = Vec::new();
        snapshot.policy_blocked_reasons = serde_json::Map::new();
    });
}

/// `recordRuntimeAccountRecovery` — clears a single account's persisted skip
/// reason after a successful request. **No-op (no disk write) when the account
/// has no recorded skip reason** in either map (spec 10 gotcha 16). Index must
/// be an integer ≥ 0.
pub fn record_runtime_account_recovery(index: i64) {
    if index < 0 {
        return;
    }
    let key = index.to_string();
    let has_reason = ensure_snapshot_state(|snapshot| {
        snapshot.account_skip_reasons.contains_key(&key)
            || snapshot.last_pool_exhaustion_skip_reasons.contains_key(&key)
    });
    if !has_reason {
        return;
    }
    mutate_runtime_observability_snapshot(|snapshot| {
        snapshot.account_skip_reasons.shift_remove(&key);
        snapshot.last_pool_exhaustion_skip_reasons.shift_remove(&key);
    });
}

/// `loadPersistedRuntimeObservabilitySnapshot` — read-only variant of the
/// loader; does NOT touch the singleton.
pub fn load_persisted_runtime_observability_snapshot() -> Option<RuntimeObservabilitySnapshot> {
    load_persisted_snapshot_from_disk()
}

/// Test hook: drop the singleton so the next access reloads from disk (or
/// starts from defaults). Tests using this must be `#[serial(env)]` and pin
/// `CODEX_MULTI_AUTH_DIR` via the testkit sandbox.
pub fn reset_runtime_observability_for_tests() {
    let mut guard = SNAPSHOT_STATE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn write_snapshot_file(sandbox: &EnvSandbox, contents: &str) {
        let dir = sandbox.codex_multi_auth_dir();
        std::fs::create_dir_all(&dir).expect("create multi-auth dir");
        std::fs::write(dir.join(SNAPSHOT_FILE_NAME), contents).expect("seed snapshot file");
    }

    fn read_snapshot_file(sandbox: &EnvSandbox) -> String {
        std::fs::read_to_string(sandbox.codex_multi_auth_dir().join(SNAPSHOT_FILE_NAME))
            .expect("read snapshot file")
    }

    // runtime-observability.test.ts: "normalizes legacy unversioned snapshots"
    #[test]
    #[serial(env)]
    fn normalizes_legacy_unversioned_snapshots() {
        let sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        write_snapshot_file(
            &sandbox,
            "{\"responsesRequests\": 7, \"runtimeMetrics\": {\"totalRequests\": 9}}",
        );
        let snapshot = get_runtime_observability_snapshot();
        assert_eq!(snapshot.version, 1);
        assert_eq!(snapshot.responses_requests, 7);
        assert_eq!(snapshot.runtime_metrics.total_requests, 9);
        // Unset metrics fall back to defaults.
        assert_eq!(snapshot.runtime_metrics.successful_requests, 0);
        reset_runtime_observability_for_tests();
    }

    // runtime-observability.test.ts: "drops unknown future snapshot versions safely"
    #[test]
    #[serial(env)]
    fn drops_unknown_future_snapshot_versions_safely() {
        let sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        write_snapshot_file(&sandbox, "{\"version\": 2, \"responsesRequests\": 99}");
        let snapshot = get_runtime_observability_snapshot();
        assert_eq!(snapshot.version, 1);
        assert_eq!(snapshot.responses_requests, 0);
        reset_runtime_observability_for_tests();
    }

    // runtime-observability.test.ts: "seeds the first in-memory snapshot from
    // disk before mutating"
    #[test]
    #[serial(env)]
    fn seeds_the_first_in_memory_snapshot_from_disk_before_mutating() {
        let sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        write_snapshot_file(
            &sandbox,
            "{\"version\": 1, \"responsesRequests\": 3, \"runtimeMetrics\": {\"totalRequests\": 3}}",
        );
        mutate_runtime_observability_snapshot(|snapshot| {
            snapshot.responses_requests += 1;
            snapshot.runtime_metrics.total_requests += 1;
        });
        let snapshot = get_runtime_observability_snapshot();
        assert_eq!(snapshot.responses_requests, 4);
        assert_eq!(snapshot.runtime_metrics.total_requests, 4);
        assert!(snapshot.updated_at > 0);
        // Persisted immediately (write-behind mirror).
        let raw = read_snapshot_file(&sandbox);
        assert!(raw.contains("\"responsesRequests\": 4"));
        // NO trailing newline (spec 12.5).
        assert!(!raw.ends_with('\n'));
        reset_runtime_observability_for_tests();
    }

    // runtime-observability.test.ts: "normalizes and persists runtime pool
    // exhaustion diagnostics"
    #[test]
    #[serial(env)]
    fn normalizes_and_persists_runtime_pool_exhaustion_diagnostics() {
        let sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        let mut reasons = serde_json::Map::new();
        reasons.insert("0".to_string(), Value::from("rate-limited"));
        reasons.insert("2".to_string(), Value::from("cooldown"));
        record_runtime_pool_exhaustion("rate-limit", 45_000, &reasons);
        let snapshot = get_runtime_observability_snapshot();
        assert_eq!(
            snapshot.last_pool_exhaustion_reason.as_deref(),
            Some("rate-limit")
        );
        assert_eq!(snapshot.last_pool_exhaustion_retry_after_ms, Some(45_000));
        assert_eq!(snapshot.last_pool_exhaustion_skip_reasons, reasons);
        assert_eq!(snapshot.account_skip_reasons, reasons);
        let raw = read_snapshot_file(&sandbox);
        assert!(raw.contains("\"lastPoolExhaustionReason\": \"rate-limit\""));
        assert!(raw.contains("\"rate-limited\""));
        reset_runtime_observability_for_tests();
    }

    // runtime-observability.test.ts: "clears a single account's stale skip
    // reason on recovery"
    #[test]
    #[serial(env)]
    fn clears_a_single_accounts_stale_skip_reason_on_recovery() {
        let _sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        let mut reasons = serde_json::Map::new();
        reasons.insert("0".to_string(), Value::from("rate-limited"));
        reasons.insert("1".to_string(), Value::from("cooldown"));
        record_runtime_pool_exhaustion("rate-limit", 1_000, &reasons);
        record_runtime_account_recovery(0);
        let snapshot = get_runtime_observability_snapshot();
        assert!(!snapshot.account_skip_reasons.contains_key("0"));
        assert!(!snapshot.last_pool_exhaustion_skip_reasons.contains_key("0"));
        assert!(snapshot.account_skip_reasons.contains_key("1"));
        assert!(snapshot.last_pool_exhaustion_skip_reasons.contains_key("1"));
        reset_runtime_observability_for_tests();
    }

    // runtime-observability.test.ts: "is a no-op when the recovered account
    // has no recorded skip reason"
    #[test]
    #[serial(env)]
    fn recovery_is_a_no_op_without_a_recorded_skip_reason() {
        let sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        // Snapshot untouched, no file written for a clean account.
        record_runtime_account_recovery(3);
        record_runtime_account_recovery(-1);
        assert!(!sandbox
            .codex_multi_auth_dir()
            .join(SNAPSHOT_FILE_NAME)
            .exists());
        reset_runtime_observability_for_tests();
    }

    // runtime-observability.test.ts (reset semantics used by #606 recovery).
    #[test]
    #[serial(env)]
    fn reset_clears_skip_reasons_and_pool_exhaustion_fields() {
        let _sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        let mut reasons = serde_json::Map::new();
        reasons.insert("0".to_string(), Value::from("rate-limited"));
        record_runtime_pool_exhaustion("rate-limit", 2_000, &reasons);
        mutate_runtime_observability_snapshot(|snapshot| {
            snapshot.policy_blocked_indexes = vec![1, 2];
            snapshot
                .policy_blocked_reasons
                .insert("1".to_string(), Value::from("paused"));
        });
        record_runtime_reset("pool-exhausted-no-account");
        let snapshot = get_runtime_observability_snapshot();
        assert_eq!(
            snapshot.last_runtime_reset_reason.as_deref(),
            Some("pool-exhausted-no-account")
        );
        assert!(snapshot.last_runtime_reset_at.is_some());
        assert!(snapshot.last_pool_exhaustion_reason.is_none());
        assert!(snapshot.last_pool_exhaustion_retry_after_ms.is_none());
        assert!(snapshot.last_pool_exhaustion_skip_reasons.is_empty());
        assert!(snapshot.account_skip_reasons.is_empty());
        assert!(snapshot.policy_blocked_indexes.is_empty());
        assert!(snapshot.policy_blocked_reasons.is_empty());
        reset_runtime_observability_for_tests();
    }

    // Version gate applies to the read-only loader too; policyBlockedIndexes
    // filtered to integers.
    #[test]
    #[serial(env)]
    fn read_only_loader_normalizes_without_touching_the_singleton() {
        let sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        write_snapshot_file(
            &sandbox,
            "{\"version\": 1, \"policyBlockedIndexes\": [1, \"x\", 2.5, 3], \"accountSkipReasons\": {\"0\": \"rate-limited\", \"1\": 42}}",
        );
        let loaded =
            load_persisted_runtime_observability_snapshot().expect("snapshot should normalize");
        assert_eq!(loaded.policy_blocked_indexes, vec![1, 3]);
        assert!(loaded.account_skip_reasons.contains_key("0"));
        // Non-string reason values are dropped rather than poisoning the map.
        assert!(!loaded.account_skip_reasons.contains_key("1"));
        write_snapshot_file(&sandbox, "{\"version\": 7}");
        assert!(load_persisted_runtime_observability_snapshot().is_none());
        write_snapshot_file(&sandbox, "not json");
        assert!(load_persisted_runtime_observability_snapshot().is_none());
        write_snapshot_file(&sandbox, "[1,2,3]");
        assert!(load_persisted_runtime_observability_snapshot().is_none());
        reset_runtime_observability_for_tests();
    }

    // VITEST gate: persistence disabled entirely.
    #[test]
    #[serial(env)]
    fn vitest_gate_disables_persistence() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("VITEST", "true");
        reset_runtime_observability_for_tests();
        mutate_runtime_observability_snapshot(|snapshot| {
            snapshot.responses_requests += 1;
        });
        assert!(!sandbox
            .codex_multi_auth_dir()
            .join(SNAPSHOT_FILE_NAME)
            .exists());
        reset_runtime_observability_for_tests();
    }

    // Serialization order + null fields match the TS JSON.stringify output.
    #[test]
    fn default_snapshot_serializes_in_ts_field_order() {
        let raw = stringify_pretty2(&create_default_snapshot());
        let version_idx = raw.find("\"version\"").unwrap();
        let updated_idx = raw.find("\"updatedAt\"").unwrap();
        let metrics_idx = raw.find("\"runtimeMetrics\"").unwrap();
        assert!(version_idx < updated_idx);
        assert!(updated_idx < metrics_idx);
        assert!(raw.contains("\"currentRequestId\": null"));
        assert!(raw.contains("\"lastAccountIndex\": null"));
        assert!(raw.contains("\"outboundRequestAttemptBudget\": null"));
        assert!(raw.contains("\"lastPoolExhaustionSkipReasons\": {}"));
        assert!(raw.contains("\"policyBlockedIndexes\": []"));
    }

    // Unknown keys survive the merge and re-serialize (TS spread semantics).
    #[test]
    #[serial(env)]
    fn unknown_keys_round_trip_through_the_merge() {
        let sandbox = EnvSandbox::new();
        reset_runtime_observability_for_tests();
        write_snapshot_file(
            &sandbox,
            "{\"version\": 1, \"futureField\": \"kept\", \"runtimeMetrics\": {\"futureCounter\": 5}}",
        );
        let loaded = load_persisted_runtime_observability_snapshot().expect("normalizes");
        assert_eq!(loaded.extra.get("futureField"), Some(&Value::from("kept")));
        assert_eq!(
            loaded.runtime_metrics.extra.get("futureCounter"),
            Some(&Value::from(5))
        );
        reset_runtime_observability_for_tests();
    }
}
