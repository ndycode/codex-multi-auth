//! Port of `lib/usage/pricing.ts` — hardcoded per-model USD pricing + cost
//! estimator.
//!
//! Behavior source: specs/11-cli-usage-recovery.md §5.2.
//!
//! Byte-compat critical: `estimateUsageCostUsd` rounds via
//! `Number(sum.toFixed(8))` — 8-decimal rounding is part of the on-disk
//! format. [`js_to_fixed_8`] reproduces ECMAScript `Number.prototype.toFixed`
//! semantics exactly: the rounding decision is made on the EXACT decimal
//! expansion of the binary double (so e.g. `0.000000015` rounds DOWN to
//! `1e-8` because the double is `0.0000000149999…`), and true ties pick the
//! larger magnitude (ES2023 §Number.prototype.toFixed "pick the larger n").
//! The ledger summarizer reuses this helper at every accumulation step.

use crate::types::{UsageTokenCounts, js_trim};

/// `UsageModelPricing` — USD per million tokens. `cached_input`/`reasoning`
/// fall back to `input`/`output` respectively when absent.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelPricing {
    pub input_usd_per_million: f64,
    pub output_usd_per_million: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_usd_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_usd_per_million: Option<f64>,
}

const fn pricing(input: f64, output: f64, cached: f64, reasoning: f64) -> UsageModelPricing {
    UsageModelPricing {
        input_usd_per_million: input,
        output_usd_per_million: output,
        cached_input_usd_per_million: Some(cached),
        reasoning_usd_per_million: Some(reasoning),
    }
}

/// `MODEL_PRICING` — exact table from `lib/usage/pricing.ts` (keys are
/// lowercase model ids, insertion order preserved).
pub const MODEL_PRICING: [(&str, UsageModelPricing); 9] = [
    ("gpt-5-codex", pricing(1.25, 10.0, 0.125, 10.0)),
    ("gpt-5.1-codex", pricing(1.25, 10.0, 0.125, 10.0)),
    ("gpt-5.2", pricing(1.25, 10.0, 0.125, 10.0)),
    ("gpt-5.3-codex", pricing(1.25, 10.0, 0.125, 10.0)),
    ("gpt-5.4", pricing(2.0, 12.0, 0.2, 12.0)),
    ("gpt-5.5", pricing(2.0, 12.0, 0.2, 12.0)),
    ("gpt-5.6-sol", pricing(5.0, 30.0, 0.5, 30.0)),
    ("gpt-5.6-terra", pricing(2.5, 15.0, 0.25, 15.0)),
    ("gpt-5.6-luna", pricing(1.0, 6.0, 0.1, 6.0)),
];

fn normalize_model_name(model: Option<&str>) -> Option<String> {
    let trimmed = js_trim(model?).to_lowercase();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

/// `getUsageModelPricing` — trim+lowercase lookup; `None` for unknown/empty.
pub fn get_usage_model_pricing(model: Option<&str>) -> Option<&'static UsageModelPricing> {
    let normalized = normalize_model_name(model)?;
    MODEL_PRICING
        .iter()
        .find(|(key, _)| *key == normalized)
        .map(|(_, value)| value)
}

/// `estimateUsageCostUsd` — `None` when the model has no price card (so the
/// summary layer can distinguish "free" from "unpriceable").
///
/// `billableInput = max(0, inputTokens - cachedInputTokens)`; cached input is
/// billed at the cached rate (falling back to the input rate), reasoning at
/// the reasoning rate (falling back to the output rate). The final sum is
/// rounded through [`js_to_fixed_8`] — part of the on-disk format.
pub fn estimate_usage_cost_usd(model: Option<&str>, tokens: &UsageTokenCounts) -> Option<f64> {
    let pricing = get_usage_model_pricing(model)?;

    let billable_input_tokens = tokens.input_tokens.saturating_sub(tokens.cached_input_tokens);
    let input = (billable_input_tokens as f64 / 1_000_000.0) * pricing.input_usd_per_million;
    let output = (tokens.output_tokens as f64 / 1_000_000.0) * pricing.output_usd_per_million;
    let cached = (tokens.cached_input_tokens as f64 / 1_000_000.0)
        * pricing
            .cached_input_usd_per_million
            .unwrap_or(pricing.input_usd_per_million);
    let reasoning = (tokens.reasoning_tokens as f64 / 1_000_000.0)
        * pricing
            .reasoning_usd_per_million
            .unwrap_or(pricing.output_usd_per_million);
    Some(js_to_fixed_8(input + output + cached + reasoning))
}

/// `listUsageModelPricing` — a copy of the table in declaration order.
pub fn list_usage_model_pricing() -> Vec<(&'static str, UsageModelPricing)> {
    MODEL_PRICING.to_vec()
}

// ---------------------------------------------------------------------------
// js_to_fixed_8 — Number(x.toFixed(8)) with exact ECMAScript semantics
// ---------------------------------------------------------------------------

/// `Number(value.toFixed(8))` — byte-exact ECMAScript semantics.
///
/// - Non-finite values round-trip unchanged (`Number(String(NaN))` etc.).
/// - `|x| >= 1e21` takes the `ToString(x)` path, which `Number()` round-trips
///   exactly → returned unchanged.
/// - Otherwise the integer `n` minimizing `|n / 10^8 - x|` is chosen against
///   the EXACT decimal expansion of the double, with true ties picking the
///   larger `n` (round half away from zero in magnitude).
/// - The decimal string is then re-parsed to the nearest double, exactly like
///   JS `Number(string)`.
pub fn js_to_fixed_8(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    if value.abs() >= 1e21 {
        // toFixed returns ToString(x) here; Number() round-trips it exactly.
        return value;
    }
    let text = js_to_fixed_string_8(value);
    text.parse::<f64>()
        .expect("fixed-decimal string always parses as f64")
}

/// `value.toFixed(8)` as a string, for `|value| < 1e21` finite doubles.
fn js_to_fixed_string_8(value: f64) -> String {
    // Note: -0 is NOT negative here (JS: only `x < 0` sets the sign), so
    // (-0).toFixed(8) === "0.00000000" → Number → +0.
    let negative = value < 0.0;
    let abs = value.abs();

    // Exact decimal expansion: every finite double's fraction terminates
    // within 1074 decimal digits (the smallest subnormal), so `{:.1074}`
    // performs no rounding — it IS the exact value.
    let exact = format!("{abs:.1074}");
    let (int_part, frac_part) = exact
        .split_once('.')
        .expect("fixed-precision format always contains a fraction");
    let frac = frac_part.as_bytes();

    // digits = <int digits><first 8 fraction digits> as a decimal integer.
    let mut digits: Vec<u8> = Vec::with_capacity(int_part.len() + 8);
    digits.extend_from_slice(int_part.as_bytes());
    digits.extend_from_slice(&frac[..8]);

    // The expansion is exact, so: first tail digit >= 5 ⇒ tail >= half an
    // ulp at digit 8 ⇒ round up (exact half is a tie → "pick the larger n").
    if frac[8] >= b'5' {
        increment_decimal_digits(&mut digits);
    }

    let split = digits.len() - 8;
    let int_str = std::str::from_utf8(&digits[..split]).expect("ascii digits");
    let frac_str = std::str::from_utf8(&digits[split..]).expect("ascii digits");
    let int_str = if int_str.is_empty() { "0" } else { int_str };
    if negative {
        format!("-{int_str}.{frac_str}")
    } else {
        format!("{int_str}.{frac_str}")
    }
}

fn increment_decimal_digits(digits: &mut Vec<u8>) {
    for digit in digits.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return;
        }
    }
    digits.insert(0, b'1');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(input: u64, output: u64, cached: u64, reasoning: u64) -> UsageTokenCounts {
        UsageTokenCounts {
            input_tokens: input,
            output_tokens: output,
            cached_input_tokens: cached,
            reasoning_tokens: reasoning,
            total_tokens: input + output + reasoning,
        }
    }

    // ----- table + lookup -----

    #[test]
    fn pricing_table_matches_ts_entries_and_order() {
        assert_eq!(MODEL_PRICING.len(), 9);
        assert_eq!(MODEL_PRICING[0].0, "gpt-5-codex");
        assert_eq!(MODEL_PRICING[8].0, "gpt-5.6-luna");
        let listed = list_usage_model_pricing();
        assert!(listed.iter().any(|(key, _)| *key == "gpt-5.3-codex"));
        let sol = get_usage_model_pricing(Some("gpt-5.6-sol")).unwrap();
        assert_eq!(sol.input_usd_per_million, 5.0);
        assert_eq!(sol.output_usd_per_million, 30.0);
        assert_eq!(sol.cached_input_usd_per_million, Some(0.5));
        assert_eq!(sol.reasoning_usd_per_million, Some(30.0));
    }

    #[test]
    fn lookup_trims_and_lowercases_and_rejects_empty_or_unknown() {
        assert!(get_usage_model_pricing(Some("  GPT-5.2  ")).is_some());
        assert!(get_usage_model_pricing(Some("unknown-model")).is_none());
        assert!(get_usage_model_pricing(Some("")).is_none());
        assert!(get_usage_model_pricing(Some("   ")).is_none());
        assert!(get_usage_model_pricing(None).is_none());
    }

    // ----- estimateUsageCostUsd (assertions ported from usage-ledger.test.ts) -----

    #[test]
    fn estimates_deterministic_costs_from_the_price_card() {
        // 1M of everything on gpt-5.3-codex: billable input 0, output 10,
        // cached 0.125, reasoning 10 → 20.125.
        assert_eq!(
            estimate_usage_cost_usd(
                Some("gpt-5.3-codex"),
                &tokens(1_000_000, 1_000_000, 1_000_000, 1_000_000)
            ),
            Some(20.125)
        );
        assert_eq!(
            estimate_usage_cost_usd(Some("gpt-5.3-codex"), &tokens(1_000, 200, 50, 25)),
            Some(0.00344375)
        );
        // Literal pin of the gpt-5.2 price card ($1.25/M in + $10/M out).
        assert_eq!(
            estimate_usage_cost_usd(Some("gpt-5.2"), &tokens(1_000_000, 1_000_000, 0, 0)),
            Some(11.25)
        );
        assert_eq!(estimate_usage_cost_usd(None, &tokens(1, 1, 0, 0)), None);
        assert_eq!(
            estimate_usage_cost_usd(Some("unknown-model"), &tokens(1, 1, 0, 0)),
            None
        );
    }

    #[test]
    fn billable_input_clamps_at_zero_when_cached_exceeds_input() {
        // billable = max(0, 100 - 200) = 0 → only cached tokens billed.
        assert_eq!(
            estimate_usage_cost_usd(Some("gpt-5.2"), &tokens(100, 0, 200, 0)),
            Some(0.000025)
        );
    }

    // ----- js_to_fixed_8 (vectors verified against Node `Number(x.toFixed(8))`) -----

    #[test]
    fn js_to_fixed_8_matches_ecmascript_tofixed_vectors() {
        // (value, Number(value.toFixed(8))) — generated with Node 24.
        let cases: &[(f64, f64)] = &[
            (0.1 + 0.2, 0.3),
            // Doubles just below the printed tie round DOWN (exact expansion
            // 0.0000000149999… / 1.0000000049999…) — the "toFixed is not
            // naive half-up" cases.
            (0.000000015, 1e-8),
            (0.000000025, 2e-8),
            (1.000000005, 1.0),
            (0.123456785, 0.12345678),
            (0.123456775, 0.12345678),
            (3.000000004999999, 3.0),
            // TRUE ties (odd/2^9 terminates exactly at digit 9 with a 5):
            // spec picks the larger n → round up, in magnitude for negatives.
            (0.001953125, 0.00195313),
            (0.005859375, 0.00585938),
            (-0.001953125, -0.00195313),
            // Rounding to zero / carry propagation into the integer part.
            (2.5e-9, 0.0),
            (1.5e-9, 0.0),
            (1e-9, 0.0),
            (-0.000000015, -1e-8),
            (0.9999999995, 1.0),
            // Pass-throughs.
            (0.00344375, 0.00344375),
            // JS source literal 123456789.123456789 — same double as below.
            (123456789.12345679, 123456789.12345679),
            (1e21, 1e21),
            (0.0, 0.0),
        ];
        for (input, expected) in cases {
            let actual = js_to_fixed_8(*input);
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "input {input:e}: got {actual:e}, want {expected:e}"
            );
        }
        assert!(js_to_fixed_8(f64::NAN).is_nan());
        assert_eq!(js_to_fixed_8(f64::INFINITY), f64::INFINITY);
        assert_eq!(js_to_fixed_8(f64::NEG_INFINITY), f64::NEG_INFINITY);
    }

    #[test]
    fn js_to_fixed_8_rounds_at_every_accumulation_step_like_the_ts_summarizer() {
        // Mirrors addRowToBucket: acc = Number((acc + cost).toFixed(8)).
        // Expected intermediates generated with Node 24 — note the 0.2 step
        // (11.36574375 + 0.2 = 11.565743750000001) collapses back to
        // 11.56574375 only because of the per-step re-rounding.
        let costs: [f64; 7] = [0.00344375, 0.0123, 11.25, 0.1, 0.2, 1e-9, 2.5e-9];
        let expected: [f64; 7] = [
            0.00344375,
            0.01574375,
            11.26574375,
            11.36574375,
            11.56574375,
            11.56574375,
            11.56574375,
        ];
        let mut acc = 0.0;
        for (cost, want) in costs.iter().zip(expected.iter()) {
            acc = js_to_fixed_8(acc + cost);
            assert_eq!(acc.to_bits(), want.to_bits(), "after adding {cost}");
        }
    }
}
