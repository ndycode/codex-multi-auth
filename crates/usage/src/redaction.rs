//! Port of `lib/usage/redaction.ts` — row normalization + PII hashing.
//!
//! Behavior source: specs/11-cli-usage-recovery.md §5.3. Privacy P0:
//! - Identifiers are persisted ONLY as `sha256:`-prefixed hex digests.
//! - `hashUsageIdentifier` trims but does NOT lowercase — callers lowercase
//!   email first ([`create_usage_account_ref`] does).
//! - `accountId` is trimmed; `email` is trimmed then lowercased.
//! - `usageRowToJsonLine` = `JSON.stringify(row) + "\n"` (single compact
//!   line; field order frozen by the [`UsageLedgerRow`] declaration).

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use cma_core::json_io::stringify_compact;
use cma_core::utils::now_ms;

use crate::pricing::estimate_usage_cost_usd;
use crate::types::{
    USAGE_LEDGER_ROW_VERSION, UsageLedgerAccountRef, UsageLedgerAppendInput, UsageLedgerOperation,
    UsageLedgerOutcome, UsageLedgerRow, UsageLedgerSource, UsageTokenCounts, js_trim,
};

// ---------------------------------------------------------------------------
// Scalar normalizers (private in TS; kept private here)
// ---------------------------------------------------------------------------

fn normalize_finite_number(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite())
}

/// `max(0, Math.trunc(x))`, defaulting to 0 for absent/non-finite values.
fn normalize_non_negative_integer(value: Option<f64>) -> u64 {
    match normalize_finite_number(value) {
        Some(numeric) => {
            let truncated = numeric.trunc();
            if truncated <= 0.0 { 0 } else { truncated as u64 }
        }
        None => 0,
    }
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    let trimmed = js_trim(value?);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_status_code(value: Option<f64>) -> Option<u16> {
    let numeric = normalize_finite_number(value)?;
    let status_code = numeric.trunc();
    if (100.0..=599.0).contains(&status_code) {
        Some(status_code as u16)
    } else {
        None
    }
}

fn normalize_duration_ms(value: Option<f64>) -> Option<u64> {
    let numeric = normalize_finite_number(value)?;
    let truncated = numeric.trunc();
    Some(if truncated <= 0.0 { 0 } else { truncated as u64 })
}

fn normalize_source(value: Option<&str>) -> UsageLedgerSource {
    value
        .and_then(UsageLedgerSource::parse)
        .unwrap_or(UsageLedgerSource::Unknown)
}

fn normalize_operation(value: Option<&str>) -> UsageLedgerOperation {
    value
        .and_then(UsageLedgerOperation::parse)
        .unwrap_or(UsageLedgerOperation::Unknown)
}

fn normalize_outcome(value: Option<&str>) -> UsageLedgerOutcome {
    // Fallback is "failure", NOT "unknown": an unclassifiable outcome must
    // never be counted as a success.
    value
        .and_then(UsageLedgerOutcome::parse)
        .unwrap_or(UsageLedgerOutcome::Failure)
}

// ---------------------------------------------------------------------------
// PII hashing
// ---------------------------------------------------------------------------

/// `hashUsageIdentifier` — `"sha256:" + hex(sha256(value.trim()))`.
///
/// Trims but does NOT lowercase (callers lowercase email first).
pub fn hash_usage_identifier(value: &str) -> String {
    let digest = Sha256::digest(js_trim(value).as_bytes());
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `createUsageAccountRef` — hash the raw facets; `None` when no identifying
/// facet survives normalization. `index` is kept only when it is a
/// non-negative integer (fractional and negative indexes are dropped).
pub fn create_usage_account_ref(
    account_id: Option<&str>,
    email: Option<&str>,
    account_index: Option<f64>,
) -> Option<UsageLedgerAccountRef> {
    let account_id = normalize_optional_string(account_id);
    let email = normalize_optional_string(email).map(|e| e.to_lowercase());
    let index = account_index
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0)
        .map(|v| v as u64);
    if account_id.is_none() && email.is_none() && index.is_none() {
        return None;
    }

    Some(UsageLedgerAccountRef {
        account_hash: account_id.map(|id| hash_usage_identifier(&id)),
        email_hash: email.map(|e| hash_usage_identifier(&e)),
        index,
    })
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

fn normalize_tokens(input: &UsageLedgerAppendInput) -> UsageTokenCounts {
    let input_tokens = normalize_non_negative_integer(input.input_tokens);
    let output_tokens = normalize_non_negative_integer(input.output_tokens);
    let cached_input_tokens = normalize_non_negative_integer(input.cached_input_tokens);
    let reasoning_tokens = normalize_non_negative_integer(input.reasoning_tokens);
    let provided_total = normalize_finite_number(input.total_tokens);
    // Cached input is NOT added: cached is a subset of input.
    let computed_total = input_tokens
        .saturating_add(output_tokens)
        .saturating_add(reasoning_tokens);

    UsageTokenCounts {
        input_tokens,
        output_tokens,
        cached_input_tokens,
        reasoning_tokens,
        total_tokens: match provided_total {
            None => computed_total,
            Some(total) => {
                let truncated = total.trunc();
                if truncated <= 0.0 { 0 } else { truncated as u64 }
            }
        },
    }
}

/// `normalizeUsageLedgerRow` — canonical row construction (write side). Raw
/// identifiers never reach the returned row.
pub fn normalize_usage_ledger_row(input: &UsageLedgerAppendInput) -> UsageLedgerRow {
    let model = normalize_optional_string(input.model.as_deref());
    let tokens = normalize_tokens(input);
    let explicit_cost = normalize_finite_number(input.cost_usd);

    UsageLedgerRow {
        version: USAGE_LEDGER_ROW_VERSION,
        id: normalize_optional_string(input.id.as_deref())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        created_at: normalize_finite_number(input.created_at).unwrap_or_else(|| now_ms() as f64),
        source: normalize_source(input.source.as_deref()),
        operation: normalize_operation(input.operation.as_deref()),
        outcome: normalize_outcome(input.outcome.as_deref()),
        model: model.clone(),
        project_key: normalize_optional_string(input.project_key.as_deref()),
        account: create_usage_account_ref(
            input.account_id.as_deref(),
            input.email.as_deref(),
            input.account_index,
        ),
        request_id: normalize_optional_string(input.request_id.as_deref()),
        status_code: normalize_status_code(input.status_code),
        error_code: normalize_optional_string(input.error_code.as_deref()),
        duration_ms: normalize_duration_ms(input.duration_ms),
        cost_usd: match explicit_cost {
            Some(cost) => Some(cost.max(0.0)),
            None => estimate_usage_cost_usd(model.as_deref(), &tokens),
        },
        tokens,
    }
}

/// `usageRowToJsonLine` — one compact JSON line terminated by `"\n"`. Field
/// order follows the [`UsageLedgerRow`] declaration (the TS object-literal
/// order); readers don't depend on it, but it keeps ledgers diff-friendly.
pub fn usage_row_to_json_line(row: &UsageLedgerRow) -> String {
    format!("{}\n", stringify_compact(row))
}

// ---------------------------------------------------------------------------
// Tests (ported from test/usage-redaction.test.ts — privacy P0)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sha256_plain(value: &str) -> String {
        let digest = Sha256::digest(value.as_bytes());
        let mut out = String::from("sha256:");
        for byte in digest {
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    fn base_input(outcome: &str) -> UsageLedgerAppendInput {
        UsageLedgerAppendInput {
            outcome: Some(outcome.to_string()),
            ..Default::default()
        }
    }

    // ----- hashUsageIdentifier -----

    #[test]
    fn trims_before_hashing_and_prefixes_the_digest_format() {
        assert_eq!(hash_usage_identifier("  acct-123 "), sha256_plain("acct-123"));
        assert_eq!(
            hash_usage_identifier("acct-123"),
            hash_usage_identifier("\tacct-123  ")
        );
        assert!(hash_usage_identifier("x").starts_with("sha256:"));
    }

    // ----- createUsageAccountRef -----

    #[test]
    fn hashes_account_id_and_lowercased_email_never_storing_raw_values() {
        let account_ref =
            create_usage_account_ref(Some(" acct-123 "), Some(" Alice@Example.COM "), Some(2.0))
                .unwrap();
        assert_eq!(account_ref.account_hash, Some(sha256_plain("acct-123")));
        assert_eq!(
            account_ref.email_hash,
            Some(sha256_plain("alice@example.com"))
        );
        assert_eq!(account_ref.index, Some(2));
    }

    #[test]
    fn returns_none_when_no_identifying_facet_survives_normalization() {
        assert_eq!(create_usage_account_ref(Some("  "), Some(""), None), None);
        assert_eq!(create_usage_account_ref(None, None, None), None);
    }

    #[test]
    fn rejects_negative_and_fractional_indexes_but_keeps_zero() {
        let zero = create_usage_account_ref(None, None, Some(0.0)).unwrap();
        assert_eq!(zero.account_hash, None);
        assert_eq!(zero.email_hash, None);
        assert_eq!(zero.index, Some(0));
        assert_eq!(create_usage_account_ref(None, None, Some(-1.0)), None);
        assert_eq!(create_usage_account_ref(None, None, Some(1.5)), None);
        assert_eq!(create_usage_account_ref(None, None, Some(f64::NAN)), None);
    }

    // ----- normalizeUsageLedgerRow -----

    #[test]
    fn coerces_unknown_enums_to_their_documented_fallbacks() {
        let row = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            source: Some("smoke-signal".to_string()),
            operation: Some("bogus".to_string()),
            outcome: Some("exploded".to_string()),
            ..Default::default()
        });
        assert_eq!(row.source, UsageLedgerSource::Unknown);
        assert_eq!(row.operation, UsageLedgerOperation::Unknown);
        // Outcome falls back to "failure", not "unknown": an unclassifiable
        // outcome must never be counted as a success.
        assert_eq!(row.outcome, UsageLedgerOutcome::Failure);
        // Missing outcome behaves the same.
        assert_eq!(
            normalize_usage_ledger_row(&UsageLedgerAppendInput::default()).outcome,
            UsageLedgerOutcome::Failure
        );
    }

    #[test]
    fn keeps_valid_enums_as_is() {
        let row = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            source: Some("runtime-proxy".to_string()),
            operation: Some("responses".to_string()),
            outcome: Some("blocked".to_string()),
            ..Default::default()
        });
        assert_eq!(row.source, UsageLedgerSource::RuntimeProxy);
        assert_eq!(row.operation, UsageLedgerOperation::Responses);
        assert_eq!(row.outcome, UsageLedgerOutcome::Blocked);
    }

    #[test]
    fn clamps_token_counts_and_recomputes_total_when_none_is_provided() {
        let row = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            input_tokens: Some(100.9),
            output_tokens: Some(-5.0),
            cached_input_tokens: Some(f64::NAN),
            reasoning_tokens: Some(7.0),
            ..base_input("success")
        });
        assert_eq!(
            row.tokens,
            UsageTokenCounts {
                input_tokens: 100,
                output_tokens: 0,
                cached_input_tokens: 0,
                reasoning_tokens: 7,
                // input + output + reasoning; cached input is informational.
                total_tokens: 107,
            }
        );
    }

    #[test]
    fn trusts_a_provided_total_but_clamps_it_non_negative() {
        let truncated = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            total_tokens: Some(42.7),
            ..base_input("success")
        });
        assert_eq!(truncated.tokens.total_tokens, 42);
        let clamped = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            total_tokens: Some(-10.0),
            ..base_input("success")
        });
        assert_eq!(clamped.tokens.total_tokens, 0);
    }

    #[test]
    fn accepts_only_real_http_status_codes() {
        let case = |status: f64| {
            normalize_usage_ledger_row(&UsageLedgerAppendInput {
                status_code: Some(status),
                ..base_input("success")
            })
            .status_code
        };
        assert_eq!(case(429.0), Some(429));
        assert_eq!(case(99.0), None);
        assert_eq!(case(600.0), None);
        assert_eq!(case(f64::NAN), None);
    }

    #[test]
    fn falls_back_to_the_pricing_estimate_when_no_explicit_cost_is_given() {
        let row = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            model: Some("gpt-5.2".to_string()),
            input_tokens: Some(1_000_000.0),
            output_tokens: Some(1_000_000.0),
            ..base_input("success")
        });
        // Literal pin of the gpt-5.2 price card ($1.25/M input + $10/M
        // output), not just delegation: a wrong table entry must fail here.
        assert_eq!(row.cost_usd, Some(11.25));
        assert_eq!(
            row.cost_usd,
            estimate_usage_cost_usd(Some("gpt-5.2"), &row.tokens)
        );
        let negative = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            cost_usd: Some(-3.0),
            ..base_input("success")
        });
        assert_eq!(negative.cost_usd, Some(0.0));
        let explicit = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            cost_usd: Some(1.25),
            ..base_input("success")
        });
        assert_eq!(explicit.cost_usd, Some(1.25));
    }

    #[test]
    fn records_a_null_cost_for_models_without_a_price_card() {
        // None (not 0) so the summary aggregator can distinguish "free" from
        // "unpriceable".
        let row = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            model: Some("mystery-model".to_string()),
            input_tokens: Some(1_000.0),
            ..base_input("success")
        });
        assert_eq!(row.cost_usd, None);
    }

    #[test]
    fn clamps_and_truncates_duration_ms_dropping_non_finite_values() {
        let case = |duration: Option<f64>| {
            normalize_usage_ledger_row(&UsageLedgerAppendInput {
                duration_ms: duration,
                ..base_input("success")
            })
            .duration_ms
        };
        assert_eq!(case(Some(1234.9)), Some(1234));
        assert_eq!(case(Some(-50.0)), Some(0));
        assert_eq!(case(Some(f64::NAN)), None);
        assert_eq!(case(None), None);
    }

    #[test]
    fn fills_id_and_created_at_defaults() {
        let before = now_ms() as f64;
        let row = normalize_usage_ledger_row(&base_input("success"));
        let after = now_ms() as f64;
        assert!(row.created_at >= before && row.created_at <= after);
        // randomUUID shape: 8-4-4-4-12 lowercase hex.
        let id = row.id.as_bytes();
        assert_eq!(id.len(), 36);
        for (index, byte) in id.iter().enumerate() {
            if matches!(index, 8 | 13 | 18 | 23) {
                assert_eq!(*byte, b'-', "hyphen at {index}");
            } else {
                assert!(
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
                    "lowercase hex at {index}"
                );
            }
        }

        let explicit = normalize_usage_ledger_row(&UsageLedgerAppendInput {
            id: Some(" row-1 ".to_string()),
            created_at: Some(5.0),
            ..base_input("success")
        });
        assert_eq!(explicit.id, "row-1");
        assert_eq!(explicit.created_at, 5.0);
    }

    // ----- usageRowToJsonLine -----

    #[test]
    fn serializes_one_newline_terminated_json_line_with_no_raw_identifiers() {
        let line = usage_row_to_json_line(&normalize_usage_ledger_row(&UsageLedgerAppendInput {
            account_id: Some("acct-123".to_string()),
            email: Some("Alice@Example.com".to_string()),
            model: Some("gpt-5.2".to_string()),
            ..base_input("success")
        }));
        assert!(line.ends_with('\n'));
        assert_eq!(line.find('\n'), Some(line.len() - 1));
        assert!(serde_json::from_str::<serde_json::Value>(&line).is_ok());
        // The redaction guarantee the ledger relies on: raw identifiers must
        // never reach the serialized row.
        assert!(!line.contains("acct-123"));
        assert!(!line.to_lowercase().contains("alice@example.com"));
        assert!(line.contains(&sha256_plain("acct-123")));
        assert!(line.contains(&sha256_plain("alice@example.com")));
    }

    // ----- golden byte fixture (crates/testkit/goldens/usage-ledger-row.jsonl) -----

    #[test]
    fn golden_usage_ledger_row_line_is_byte_identical_to_the_ts_writer() {
        // Exact inputs from crates/testkit/goldens/generate.mjs §13.
        let input = UsageLedgerAppendInput {
            id: Some("usage-fixture-0000000000000001".to_string()),
            created_at: Some(1_750_000_000_000.0),
            source: Some("runtime-proxy".to_string()),
            operation: Some("responses".to_string()),
            outcome: Some("success".to_string()),
            model: Some("gpt-5.2".to_string()),
            project_key: Some("my-app-0123456789ab".to_string()),
            account_id: Some("acct-user-one".to_string()),
            email: Some("User.One@Example.com".to_string()),
            account_index: Some(0.0),
            request_id: Some("req-fixture-0001".to_string()),
            status_code: Some(200.0),
            duration_ms: Some(1234.0),
            input_tokens: Some(1200.0),
            output_tokens: Some(350.0),
            cached_input_tokens: Some(800.0),
            reasoning_tokens: Some(64.0),
            cost_usd: Some(0.0123),
            ..Default::default()
        };
        let line = usage_row_to_json_line(&normalize_usage_ledger_row(&input));
        let golden = cma_testkit::goldens::read_golden_string("usage-ledger-row.jsonl")
            .replace("\r\n", "\n");
        assert_eq!(line, golden);
    }
}
