//! Port of `lib/runtime/quota-probe.ts` + `lib/runtime/quota-headers.ts` —
//! runtime quota-probe adapters over `cma-quota` (spec 10 §16).
//!
//! The TS runtime cluster carries its own DI copy of the probe loop and the
//! quota-header parsing; in Rust the probe loop lives once in
//! `cma_quota::probe` (chain walk, 15 s timeout, unsupported-model
//! traversal, `CodexUnavailableError` mapping) and this module provides:
//! - the header-parsing pure functions (`parse_reset_at_ms`,
//!   `parse_codex_quota_snapshot`) over any header source;
//! - `format_codex_quota_line` (delegates to the quota crate — identical
//!   output contract);
//! - `fetch_runtime_codex_quota_snapshot`, the adapter the account-check
//!   engine calls.

use cma_core::errors::CodexError;
use cma_core::utils::now_ms;
use cma_quota::probe::{
    CodexQuotaSnapshot, CodexQuotaWindow, ProbeCodexQuotaOptions, fetch_codex_quota_snapshot,
    format_quota_snapshot_line,
};

/// TS `ParsedCodexQuotaSnapshot = Omit<CodexQuotaSnapshot, "model">`.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedCodexQuotaSnapshot {
    pub status: u16,
    pub plan_type: Option<String>,
    pub active_limit: Option<i64>,
    pub primary: CodexQuotaWindow,
    pub secondary: CodexQuotaWindow,
}

impl ParsedCodexQuotaSnapshot {
    /// TS `{ ...snapshot, model }`.
    pub fn with_model(self, model: impl Into<String>) -> CodexQuotaSnapshot {
        CodexQuotaSnapshot {
            status: self.status,
            plan_type: self.plan_type,
            active_limit: self.active_limit,
            primary: self.primary,
            secondary: self.secondary,
            model: model.into(),
        }
    }
}

/// Case-insensitive header lookup (the TS code reads WHATWG `Headers`).
pub trait HeaderLookup {
    /// The header value for `name` (lowercase), or `None` when absent.
    fn get_header(&self, name: &str) -> Option<String>;
}

impl HeaderLookup for reqwest::header::HeaderMap {
    fn get_header(&self, name: &str) -> Option<String> {
        self.get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }
}

impl HeaderLookup for std::collections::HashMap<String, String> {
    fn get_header(&self, name: &str) -> Option<String> {
        // Callers may use any casing; normalize both sides to lowercase.
        let lowered = name.to_lowercase();
        self.iter()
            .find(|(k, _)| k.to_lowercase() == lowered)
            .map(|(_, v)| v.clone())
    }
}

impl HeaderLookup for Vec<(String, String)> {
    fn get_header(&self, name: &str) -> Option<String> {
        let lowered = name.to_lowercase();
        self.iter()
            .find(|(k, _)| k.to_lowercase() == lowered)
            .map(|(_, v)| v.clone())
    }
}

// =============================================================================
// JS numeric semantics
// =============================================================================

/// JS `Number(raw)` over a header string (TS `parseFiniteNumberHeader`
/// backing): trims; empty → 0; otherwise a full-string float parse
/// (unparseable → `None`, i.e. NaN/non-finite).
fn js_number(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// JS `Number.parseInt(raw, 10)`: skips leading whitespace, optional sign,
/// then consumes leading decimal digits; NaN when none.
fn js_parse_int(raw: &str) -> Option<i64> {
    let trimmed = raw.trim_start();
    let (negative, rest) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let value: i64 = digits.parse().ok()?;
    Some(if negative { -value } else { value })
}

fn parse_finite_number_header(headers: &impl HeaderLookup, name: &str) -> Option<f64> {
    let raw = headers.get_header(name)?;
    if raw.is_empty() {
        return None;
    }
    js_number(&raw)
}

fn parse_finite_int_header(headers: &impl HeaderLookup, name: &str) -> Option<i64> {
    let raw = headers.get_header(name)?;
    if raw.is_empty() {
        return None;
    }
    js_parse_int(&raw)
}

// =============================================================================
// Header parsing (TS quota-headers.ts)
// =============================================================================

/// TS `parseResetAtMs(headers, prefix)` — prefer
/// `{prefix}-reset-after-seconds` (`> 0` → now + seconds); else
/// `{prefix}-reset-at`: pure digits are epoch seconds when `< 1e10` (×1000)
/// else already ms; otherwise an RFC date via `Date.parse`.
///
/// `now_override` is a Rust-only test seam for the `Date.now()` read.
pub fn parse_reset_at_ms(
    headers: &impl HeaderLookup,
    prefix: &str,
    now_override: Option<i64>,
) -> Option<i64> {
    if let Some(reset_after_seconds) =
        parse_finite_int_header(headers, &format!("{prefix}-reset-after-seconds"))
        && reset_after_seconds > 0
    {
        let now = now_override.unwrap_or_else(now_ms);
        // f64 multiply mirrors JS semantics; the `as i64` cast saturates on
        // overflow (hostile huge header → far-future resetAtMs, like TS).
        return Some(now.saturating_add((reset_after_seconds as f64 * 1000.0) as i64));
    }

    let reset_at_raw = headers.get_header(&format!("{prefix}-reset-at"))?;
    if reset_at_raw.is_empty() {
        return None;
    }

    let trimmed = reset_at_raw.trim();
    if !trimmed.is_empty()
        && trimmed.chars().all(|c| c.is_ascii_digit())
        && let Ok(parsed) = trimmed.parse::<i64>()
        && parsed > 0
    {
        return Some(if parsed < 10_000_000_000 {
            parsed * 1000
        } else {
            parsed
        });
    }

    // Date.parse(trimmed): accept RFC 3339 / RFC 2822 forms (recorded
    // deviation: JS Date.parse accepts more esoteric formats).
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc2822(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    None
}

const QUOTA_WINDOW_HEADER_KEYS: [&str; 8] = [
    "x-codex-primary-used-percent",
    "x-codex-primary-window-minutes",
    "x-codex-primary-reset-at",
    "x-codex-primary-reset-after-seconds",
    "x-codex-secondary-used-percent",
    "x-codex-secondary-window-minutes",
    "x-codex-secondary-reset-at",
    "x-codex-secondary-reset-after-seconds",
];

fn has_codex_quota_headers(headers: &impl HeaderLookup) -> bool {
    QUOTA_WINDOW_HEADER_KEYS
        .iter()
        .any(|key| headers.get_header(key).is_some())
}

/// TS `parseCodexQuotaSnapshot(headers, status)` — `None` when none of the 8
/// window headers are present.
pub fn parse_codex_quota_snapshot(
    headers: &impl HeaderLookup,
    status: u16,
) -> Option<ParsedCodexQuotaSnapshot> {
    parse_codex_quota_snapshot_at(headers, status, None)
}

/// [`parse_codex_quota_snapshot`] with an injectable `Date.now()` for tests.
pub fn parse_codex_quota_snapshot_at(
    headers: &impl HeaderLookup,
    status: u16,
    now_override: Option<i64>,
) -> Option<ParsedCodexQuotaSnapshot> {
    if !has_codex_quota_headers(headers) {
        return None;
    }

    let window = |prefix: &str| CodexQuotaWindow {
        used_percent: parse_finite_number_header(headers, &format!("{prefix}-used-percent")),
        window_minutes: parse_finite_int_header(headers, &format!("{prefix}-window-minutes")),
        reset_at_ms: parse_reset_at_ms(headers, prefix, now_override),
    };

    let primary = window("x-codex-primary");
    let secondary = window("x-codex-secondary");

    let plan_type = headers
        .get_header("x-codex-plan-type")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let active_limit = parse_finite_int_header(headers, "x-codex-active-limit");

    Some(ParsedCodexQuotaSnapshot {
        status,
        plan_type,
        active_limit,
        primary,
        secondary,
    })
}

// =============================================================================
// Formatting + the probe adapter
// =============================================================================

/// TS `formatCodexQuotaLine(snapshot)` — identical output contract to the
/// quota crate's `formatQuotaSnapshotLine`; delegated so the string stays
/// frozen in ONE place.
pub fn format_codex_quota_line(snapshot: &CodexQuotaSnapshot) -> String {
    format_quota_snapshot_line(snapshot)
}

/// TS `fetchRuntimeCodexQuotaSnapshot({accountId, accessToken, ...deps})` —
/// the runtime adapter: walks `QUOTA_PROBE_MODEL_CHAIN` via the quota
/// crate's probe (default chain, default 15 s per-model timeout).
///
/// `base_url_override` is the Rust test seam mirroring the TS `baseUrl`
/// param (`None` in production → `CODEX_BASE_URL`).
pub async fn fetch_runtime_codex_quota_snapshot(
    account_id: &str,
    access_token: &str,
    base_url_override: Option<String>,
) -> Result<CodexQuotaSnapshot, CodexError> {
    let options = ProbeCodexQuotaOptions {
        account_id: account_id.to_string(),
        access_token: access_token.to_string(),
        model: None,
        fallback_models: None,
        timeout_ms: None,
        base_url: base_url_override,
    };
    fetch_codex_quota_snapshot(&options).await
}

// =============================================================================
// Tests — ported from test/quota-headers.test.ts
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn returns_none_without_any_window_headers() {
        let h = headers(&[("x-codex-plan-type", "pro")]);
        assert!(parse_codex_quota_snapshot(&h, 200).is_none());
        let empty = headers(&[]);
        assert!(parse_codex_quota_snapshot(&empty, 200).is_none());
    }

    #[test]
    fn parses_window_headers_and_plan_type() {
        let h = headers(&[
            ("x-codex-primary-used-percent", "25.5"),
            ("x-codex-primary-window-minutes", "300"),
            ("x-codex-secondary-used-percent", "80"),
            ("x-codex-secondary-window-minutes", "10080"),
            ("x-codex-plan-type", "  plus  "),
            ("x-codex-active-limit", "5"),
        ]);
        let snapshot = parse_codex_quota_snapshot(&h, 200).expect("snapshot");
        assert_eq!(snapshot.status, 200);
        assert_eq!(snapshot.primary.used_percent, Some(25.5));
        assert_eq!(snapshot.primary.window_minutes, Some(300));
        assert_eq!(snapshot.secondary.used_percent, Some(80.0));
        assert_eq!(snapshot.secondary.window_minutes, Some(10080));
        assert_eq!(snapshot.plan_type.as_deref(), Some("plus"));
        assert_eq!(snapshot.active_limit, Some(5));
    }

    #[test]
    fn reset_after_seconds_wins_over_reset_at() {
        let h = headers(&[
            ("x-codex-primary-reset-after-seconds", "60"),
            ("x-codex-primary-reset-at", "1000"),
        ]);
        let now = 1_000_000i64;
        assert_eq!(
            parse_reset_at_ms(&h, "x-codex-primary", Some(now)),
            Some(now + 60_000)
        );
    }

    #[test]
    fn reset_at_seconds_vs_ms_heuristic() {
        // Pure digits < 1e10 → epoch seconds (×1000).
        let h = headers(&[("x-codex-primary-reset-at", "1753500000")]);
        assert_eq!(
            parse_reset_at_ms(&h, "x-codex-primary", Some(0)),
            Some(1_753_500_000_000)
        );
        // Pure digits >= 1e10 → already ms.
        let h = headers(&[("x-codex-primary-reset-at", "1753500000000")]);
        assert_eq!(
            parse_reset_at_ms(&h, "x-codex-primary", Some(0)),
            Some(1_753_500_000_000)
        );
        // RFC date.
        let h = headers(&[("x-codex-primary-reset-at", "2026-07-27T00:00:00Z")]);
        let parsed = parse_reset_at_ms(&h, "x-codex-primary", Some(0)).expect("date");
        let expected = chrono::DateTime::parse_from_rfc3339("2026-07-27T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(parsed, expected);
        // Garbage → None.
        let h = headers(&[("x-codex-primary-reset-at", "not a date")]);
        assert_eq!(parse_reset_at_ms(&h, "x-codex-primary", Some(0)), None);
        // Zero / non-positive seconds fall through.
        let h = headers(&[("x-codex-primary-reset-after-seconds", "0")]);
        assert_eq!(parse_reset_at_ms(&h, "x-codex-primary", Some(0)), None);
    }

    #[test]
    fn non_numeric_values_become_none() {
        let h = headers(&[
            ("x-codex-primary-used-percent", "abc"),
            ("x-codex-primary-window-minutes", "12x"),
        ]);
        let snapshot = parse_codex_quota_snapshot(&h, 200).expect("snapshot");
        assert_eq!(snapshot.primary.used_percent, None);
        // parseInt takes leading digits ("12x" → 12).
        assert_eq!(snapshot.primary.window_minutes, Some(12));
    }

    #[test]
    fn format_line_contract_matches_quota_crate() {
        let snapshot = ParsedCodexQuotaSnapshot {
            status: 429,
            plan_type: Some("plus".into()),
            active_limit: Some(3),
            primary: CodexQuotaWindow {
                used_percent: Some(40.0),
                window_minutes: Some(300),
                reset_at_ms: None,
            },
            secondary: CodexQuotaWindow {
                used_percent: Some(10.0),
                window_minutes: Some(10080),
                reset_at_ms: None,
            },
        }
        .with_model("gpt-5.5");
        let line = format_codex_quota_line(&snapshot);
        assert_eq!(line, "5h 60% left, 7d 90% left, plan:plus, active:3, rate-limited");
    }

    #[test]
    fn hostile_huge_reset_after_seconds_saturates_to_far_future() {
        // Mirrors the quota-probe fix: i64 multiply must not wrap negative
        // (release) or panic (overflow checks) — TS float math keeps a huge
        // finite blocked-window resetAtMs.
        let now = 1_753_500_000_000_i64;
        let h = headers(&[("x-codex-primary-reset-after-seconds", "9300000000000000")]);
        let parsed = parse_reset_at_ms(&h, "x-codex-primary", Some(now)).expect("resetAtMs");
        assert!(parsed > now, "far-future, never wrapped: {parsed}");
    }

    #[test]
    fn with_model_carries_all_fields() {
        let parsed = ParsedCodexQuotaSnapshot {
            status: 200,
            plan_type: None,
            active_limit: None,
            primary: CodexQuotaWindow::default(),
            secondary: CodexQuotaWindow::default(),
        };
        let snapshot = parsed.with_model("gpt-5.6-sol");
        assert_eq!(snapshot.model, "gpt-5.6-sol");
        assert_eq!(snapshot.status, 200);
    }
}
