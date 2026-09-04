//! Retry counters, attempt budgets and terminal synthetic bodies for the
//! merged rotation pipeline (index.ts §5.3–§5.5.5 ∪ proxy loop, spec 13+04).
//!
//! Owns:
//! - the outer-loop retry counters that SURVIVE model-fallback restarts
//!   (spec 13 gotcha 7);
//! - the per-request outbound attempt budget bookkeeping (spec 13 §5.4;
//!   cap 6 via `compute_outbound_request_attempt_budget`);
//! - the 429 short-retry decision (`MAX_SHORT_RETRY_ATTEMPTS = 3`,
//!   cooldown ≤ threshold) — the MARK-BEFORE-SLEEP side effects live in the
//!   pipeline, the decision here (spec 13 §5.5.3 step 8, gotcha 5);
//! - every terminal synthetic JSON body: pool-exhaustion / server-burst
//!   fast-fails, budget exhaustion, the spec-04 `writePoolExhausted`
//!   contract body, and the spec-13 terminal messages (frozen strings,
//!   spec 13 gotcha 29 / spec 04 §14).

use std::collections::HashMap;

use cma_request::fetch_helpers::SyntheticResponse;
use cma_request::rate_limit_backoff::MAX_SHORT_RETRY_ATTEMPTS;
use http::HeaderMap;
use http::header::HeaderValue;
use serde_json::{Map, Value, json};

/// Counters that live OUTSIDE the outer (model-fallback) loop — they do NOT
/// reset when a fallback restarts account traversal (spec 13 gotcha 7).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetryCounters {
    /// `allRateLimitedRetries` — wait-and-retry cycles after full pool
    /// rate-limit exhaustion (§5.5.5).
    pub all_rate_limited_retries: i64,
    /// `emptyResponseRetries` — outer counter, distinct from the metric of
    /// the same name (§5.5.4 step 4).
    pub empty_response_retries: i64,
}

/// Per-request outbound attempt budget (spec 13 §5.4). The pipeline
/// increments its metrics alongside; this struct is the pure remaining-count
/// bookkeeping shared with the stream-failover closure.
#[derive(Debug)]
pub struct OutboundAttemptBudget {
    budget: u32,
    remaining: std::sync::atomic::AtomicI64,
}

impl OutboundAttemptBudget {
    pub fn new(budget: u32) -> Self {
        Self {
            budget,
            remaining: std::sync::atomic::AtomicI64::new(budget as i64),
        }
    }

    /// The computed budget (recorded into `runtimeMetrics
    /// .outboundRequestAttemptBudget` via `??=` — first request only,
    /// spec 13 gotcha 15).
    pub fn budget(&self) -> u32 {
        self.budget
    }

    /// `tryConsumeOutboundRequestAttempt` minus the metrics/log side
    /// effects: `false` when the budget is exhausted.
    pub fn try_consume(&self) -> bool {
        self.remaining
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |remaining| (remaining > 0).then_some(remaining - 1),
            )
            .is_ok()
    }

    /// `lastError` set when consumption fails (frozen string).
    pub fn exhausted_last_error(&self) -> String {
        format!(
            "Request attempt budget exhausted after {} outbound request(s)",
            self.budget
        )
    }
}

/// 429 short-retry decision (spec 13 §5.5.3 step 8). The caller MUST apply
/// mark-before-sleep on `ShortRetry` (mark rate-limited + debounced save
/// BEFORE sleeping — AUDIT-H3 / D-07, spec 13 gotcha 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimit429Decision {
    /// Same-account retry after `sleep(addJitter(max(100, cooldownMs), 0.2))`.
    ShortRetry,
    /// Full rotation to the next account.
    Rotate,
}

/// `cooldownMs <= shortRetryThresholdMs && shortRateLimitRetryCount <
/// MAX_SHORT_RETRY_ATTEMPTS` → short retry.
pub fn decide_rate_limit_429(
    cooldown_ms: i64,
    short_retry_threshold_ms: i64,
    short_rate_limit_retry_count: u32,
) -> RateLimit429Decision {
    if cooldown_ms <= short_retry_threshold_ms
        && short_rate_limit_retry_count < MAX_SHORT_RETRY_ATTEMPTS
    {
        RateLimit429Decision::ShortRetry
    } else {
        RateLimit429Decision::Rotate
    }
}

// ---------------------------------------------------------------------------
// Synthetic JSON bodies (frozen strings)
// ---------------------------------------------------------------------------

/// `content-type: application/json; charset=utf-8` header map used by every
/// synthetic response emitted from the pipeline.
pub fn synthetic_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers
}

/// `{"error":{"message": <message>}}` (compact — TS `JSON.stringify`).
pub fn error_message_body(message: &str) -> String {
    serde_json::to_string(&json!({"error": {"message": message}}))
        .expect("static shape serializes")
}

/// Build a buffered synthetic response with the standard JSON content type.
pub fn synthetic_json_response(status: u16, body: String) -> SyntheticResponse {
    SyntheticResponse {
        status,
        status_text: String::new(),
        headers: synthetic_json_headers(),
        body,
    }
}

/// Pool-exhaustion fast-fail 429 message (spec 13 §5.3).
pub fn pool_exhaustion_cooldown_message(wait_label: &str) -> String {
    format!(
        "The account pool is cooling down after recent rate-limit exhaustion. Try again in {wait_label} or inspect `codex-multi-auth status`."
    )
}

/// Server-burst fast-fail 503 message (spec 13 §5.3).
pub fn server_burst_cooldown_message(wait_label: &str) -> String {
    format!(
        "Multiple accounts recently failed with upstream server errors. Try again in {wait_label} or inspect `codex-multi-auth report --json`."
    )
}

/// Empty-response-exhausted server-burst 503 message (spec 13 §5.5.4 step 4;
/// gotcha 22 — wait label computed at response-build time).
pub fn empty_response_server_burst_message(wait_label: &str) -> String {
    format!(
        "Upstream server failures were observed across multiple accounts. Pausing retries for {wait_label}. Check `codex-multi-auth report --json` for runtime metrics."
    )
}

/// Budget-exhausted 503 message (spec 13 §5.4).
pub fn budget_exhausted_response_message(last_error: Option<&str>) -> String {
    match last_error {
        Some(detail) => format!("{detail}. Try again after the current retries settle."),
        None => "Request attempt budget exhausted. Try again shortly.".to_string(),
    }
}

/// Terminal pool-exhaustion messages (spec 13 §5.5.5) — become
/// `runtimeMetrics.lastError` and drive the fast-fail cooldown arming.
pub fn terminal_pool_message(count: usize, effective_wait_ms: i64, wait_label: &str) -> String {
    if count == 0 {
        "No Codex accounts configured. Run `codex-multi-auth login`.".to_string()
    } else if effective_wait_ms > 0 {
        format!(
            "All {count} account(s) are rate-limited. A short pool cooldown is now active for {wait_label}. Try again later or inspect `codex-multi-auth status`."
        )
    } else {
        format!(
            "All {count} account(s) failed (server errors or auth issues). Check account health with `codex-multi-auth report --json`."
        )
    }
}

/// Countdown toast prefix for the all-rate-limited wait (spec 13 §5.5.5).
pub fn all_rate_limited_countdown_message(count: usize) -> String {
    format!("All {count} account(s) rate-limited. Waiting")
}

/// The spec-04 `writePoolExhausted` body (stable machine-readable contract,
/// spec 04 §14 / lib/runtime-rotation-proxy.ts):
///
/// ```json
/// {"error":{"message":"All managed Codex accounts are temporarily unavailable for this runtime request.",
///   "code":"codex_runtime_rotation_pool_exhausted","reason":"...",
///   "retry_after_ms":N,"account_skip_reasons":{"0":"..."},"hint":"..."}}
/// ```
///
/// Key order matches the TS object literal (serde_json preserve_order).
pub fn build_pool_exhausted_body(
    reason: &str,
    retry_after_ms: i64,
    account_skip_reasons: &HashMap<i64, String>,
    account_count: usize,
) -> String {
    let hint = pool_exhausted_hint(reason, account_count);
    let mut skip_map = Map::new();
    let mut indexes: Vec<&i64> = account_skip_reasons.keys().collect();
    indexes.sort();
    for index in indexes {
        skip_map.insert(
            index.to_string(),
            Value::String(account_skip_reasons[index].clone()),
        );
    }
    let mut error = Map::new();
    error.insert(
        "message".to_string(),
        Value::String(
            "All managed Codex accounts are temporarily unavailable for this runtime request."
                .to_string(),
        ),
    );
    error.insert(
        "code".to_string(),
        Value::String("codex_runtime_rotation_pool_exhausted".to_string()),
    );
    error.insert("reason".to_string(), Value::String(reason.to_string()));
    error.insert("retry_after_ms".to_string(), Value::from(retry_after_ms));
    error.insert("account_skip_reasons".to_string(), Value::Object(skip_map));
    error.insert("hint".to_string(), Value::String(hint));
    let mut root = Map::new();
    root.insert("error".to_string(), Value::Object(error));
    serde_json::to_string(&Value::Object(root)).expect("static shape serializes")
}

/// The exact hint strings from `writePoolExhausted` (spec 04).
pub fn pool_exhausted_hint(reason: &str, account_count: usize) -> String {
    if reason == "no-account" && account_count > 0 {
        "Accounts exist but all failed runtime availability checks. Run `codex-multi-auth report --json` to inspect runtime skip reasons, or `codex-multi-auth rotation reset-runtime` to reload the runtime proxy.".to_string()
    } else {
        "Run `codex-multi-auth rotation status` to inspect account state.".to_string()
    }
}

// ---------------------------------------------------------------------------
// Empty-response retry decision (spec 13 §5.5.4 step 4)
// ---------------------------------------------------------------------------

/// What to do after `isEmptyResponse(parsed)` returned true with retries
/// remaining. Effects (refund + recordFailure + capability recordFailure +
/// metrics + toast) are the pipeline's; the policy fork is decided here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmptyResponseRetryAction {
    /// `policy.retrySameAccount && sameAccountRetryCount <
    /// maxSameAccountRetries` — sleep `delay` (jittered only when > 0) and
    /// continue the inner loop.
    SameAccount { delay_ms: i64 },
    /// Forget the session, sleep `addJitter(emptyResponseRetryDelayMs, 0.2)`,
    /// break to the next account.
    NextAccount,
}

/// Decide the empty-response retry fork from the failure-policy decision.
pub fn decide_empty_response_retry(
    policy_retry_same_account: bool,
    policy_retry_delay_ms: Option<i64>,
    same_account_retry_count: u32,
    max_same_account_retries: u32,
    empty_response_retry_delay_ms: i64,
) -> EmptyResponseRetryAction {
    if policy_retry_same_account && same_account_retry_count < max_same_account_retries {
        let delay = policy_retry_delay_ms
            .unwrap_or(empty_response_retry_delay_ms)
            .max(0);
        EmptyResponseRetryAction::SameAccount { delay_ms: delay }
    } else {
        EmptyResponseRetryAction::NextAccount
    }
}

/// "Empty response. Retrying (<i>/<max>)..." toast (spec 13 §5.5.4).
pub fn empty_response_retry_toast(attempt: i64, max: i64) -> String {
    format!("Empty response. Retrying ({attempt}/{max})...")
}

/// Rate-limit short-retry toast (spec 13 §5.5.3 step 8).
pub fn short_retry_toast(wait_label: &str, attempt: u32) -> String {
    format!("Rate limited. Retrying in {wait_label} (attempt {attempt})...")
}

/// Rate-limit rotation toast (spec 13 §5.5.3 step 8).
pub fn rate_limit_rotation_toast(wait_label: &str) -> String {
    format!("Rate limited. Switching accounts (retry in {wait_label}).")
}

/// Account-removal toast after consecutive auth failures (spec 13 §5.5.1).
pub fn auth_failure_removal_toast(label: &str, failures: u32) -> String {
    format!(
        "Removed {label} after {failures} consecutive auth failures. Run 'codex-multi-auth login' to re-add."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_consumes_down_to_zero() {
        let budget = OutboundAttemptBudget::new(2);
        assert!(budget.try_consume());
        assert!(budget.try_consume());
        assert!(!budget.try_consume());
        assert!(!budget.try_consume());
        assert_eq!(budget.budget(), 2);
        assert_eq!(
            budget.exhausted_last_error(),
            "Request attempt budget exhausted after 2 outbound request(s)"
        );
    }

    #[test]
    fn short_retry_decision_honors_threshold_and_cap() {
        assert_eq!(
            decide_rate_limit_429(1_000, 5_000, 0),
            RateLimit429Decision::ShortRetry
        );
        // Above threshold → rotate.
        assert_eq!(
            decide_rate_limit_429(6_000, 5_000, 0),
            RateLimit429Decision::Rotate
        );
        // Cap of MAX_SHORT_RETRY_ATTEMPTS (3).
        assert_eq!(
            decide_rate_limit_429(1_000, 5_000, 2),
            RateLimit429Decision::ShortRetry
        );
        assert_eq!(
            decide_rate_limit_429(1_000, 5_000, 3),
            RateLimit429Decision::Rotate
        );
        // Equal to threshold is a short retry (`<=`).
        assert_eq!(
            decide_rate_limit_429(5_000, 5_000, 0),
            RateLimit429Decision::ShortRetry
        );
    }

    #[test]
    fn error_body_shape_is_compact_json() {
        assert_eq!(
            error_message_body("boom"),
            r#"{"error":{"message":"boom"}}"#
        );
    }

    #[test]
    fn frozen_fast_fail_messages() {
        assert_eq!(
            pool_exhaustion_cooldown_message("2m"),
            "The account pool is cooling down after recent rate-limit exhaustion. Try again in 2m or inspect `codex-multi-auth status`."
        );
        assert_eq!(
            server_burst_cooldown_message("30s"),
            "Multiple accounts recently failed with upstream server errors. Try again in 30s or inspect `codex-multi-auth report --json`."
        );
        assert_eq!(
            empty_response_server_burst_message("30s"),
            "Upstream server failures were observed across multiple accounts. Pausing retries for 30s. Check `codex-multi-auth report --json` for runtime metrics."
        );
    }

    #[test]
    fn budget_exhausted_message_variants() {
        assert_eq!(
            budget_exhausted_response_message(Some("Request attempt budget exhausted after 6 outbound request(s)")),
            "Request attempt budget exhausted after 6 outbound request(s). Try again after the current retries settle."
        );
        assert_eq!(
            budget_exhausted_response_message(None),
            "Request attempt budget exhausted. Try again shortly."
        );
    }

    #[test]
    fn terminal_pool_messages() {
        assert_eq!(
            terminal_pool_message(0, 0, "a bit"),
            "No Codex accounts configured. Run `codex-multi-auth login`."
        );
        assert_eq!(
            terminal_pool_message(3, 60_000, "1m"),
            "All 3 account(s) are rate-limited. A short pool cooldown is now active for 1m. Try again later or inspect `codex-multi-auth status`."
        );
        assert_eq!(
            terminal_pool_message(2, 0, "a bit"),
            "All 2 account(s) failed (server errors or auth issues). Check account health with `codex-multi-auth report --json`."
        );
        assert_eq!(
            all_rate_limited_countdown_message(4),
            "All 4 account(s) rate-limited. Waiting"
        );
    }

    #[test]
    fn pool_exhausted_body_matches_ts_contract() {
        let mut skip = HashMap::new();
        skip.insert(0i64, "rate-limited".to_string());
        skip.insert(1i64, "cooling-down:server-error".to_string());
        let body = build_pool_exhausted_body("rate-limit", 12_345, &skip, 2);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        let error = &parsed["error"];
        assert_eq!(
            error["message"],
            "All managed Codex accounts are temporarily unavailable for this runtime request."
        );
        assert_eq!(error["code"], "codex_runtime_rotation_pool_exhausted");
        assert_eq!(error["reason"], "rate-limit");
        assert_eq!(error["retry_after_ms"], 12_345);
        assert_eq!(error["account_skip_reasons"]["0"], "rate-limited");
        assert_eq!(
            error["account_skip_reasons"]["1"],
            "cooling-down:server-error"
        );
        assert_eq!(
            error["hint"],
            "Run `codex-multi-auth rotation status` to inspect account state."
        );
        // Key order: message, code, reason, retry_after_ms,
        // account_skip_reasons, hint (TS object-literal order).
        let keys: Vec<&String> = error.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "message",
                "code",
                "reason",
                "retry_after_ms",
                "account_skip_reasons",
                "hint"
            ]
        );
    }

    #[test]
    fn pool_exhausted_hint_no_account_with_accounts_present() {
        assert_eq!(
            pool_exhausted_hint("no-account", 2),
            "Accounts exist but all failed runtime availability checks. Run `codex-multi-auth report --json` to inspect runtime skip reasons, or `codex-multi-auth rotation reset-runtime` to reload the runtime proxy."
        );
        assert_eq!(
            pool_exhausted_hint("no-account", 0),
            "Run `codex-multi-auth rotation status` to inspect account state."
        );
        assert_eq!(
            pool_exhausted_hint("rate-limit", 2),
            "Run `codex-multi-auth rotation status` to inspect account state."
        );
    }

    #[test]
    fn empty_response_retry_forks() {
        assert_eq!(
            decide_empty_response_retry(true, Some(200), 0, 1, 750),
            EmptyResponseRetryAction::SameAccount { delay_ms: 200 }
        );
        // Policy delay missing → config delay.
        assert_eq!(
            decide_empty_response_retry(true, None, 0, 1, 750),
            EmptyResponseRetryAction::SameAccount { delay_ms: 750 }
        );
        // Same-account retries exhausted → next account.
        assert_eq!(
            decide_empty_response_retry(true, Some(200), 1, 1, 750),
            EmptyResponseRetryAction::NextAccount
        );
        assert_eq!(
            decide_empty_response_retry(false, Some(200), 0, 1, 750),
            EmptyResponseRetryAction::NextAccount
        );
        // Negative policy delay clamps at 0 (`max(0, floor(...))`).
        assert_eq!(
            decide_empty_response_retry(true, Some(-5), 0, 1, 750),
            EmptyResponseRetryAction::SameAccount { delay_ms: 0 }
        );
    }

    #[test]
    fn frozen_toasts() {
        assert_eq!(
            empty_response_retry_toast(1, 2),
            "Empty response. Retrying (1/2)..."
        );
        assert_eq!(
            short_retry_toast("5s", 1),
            "Rate limited. Retrying in 5s (attempt 1)..."
        );
        assert_eq!(
            rate_limit_rotation_toast("1m"),
            "Rate limited. Switching accounts (retry in 1m)."
        );
        assert_eq!(
            auth_failure_removal_toast("user@example.com", 3),
            "Removed user@example.com after 3 consecutive auth failures. Run 'codex-multi-auth login' to re-add."
        );
    }
}
