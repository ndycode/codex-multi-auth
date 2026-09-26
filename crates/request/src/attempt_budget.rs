//! Port of `lib/request/request-attempt-budget.ts` — the finite per-request
//! outbound attempt budget and the stream-failover candidate order
//! (spec 06 §15).

const MAX_TOTAL_OUTBOUND_REQUEST_ATTEMPTS: u32 = 6;
const MAX_STREAM_FAILOVERS: u32 = 1;
const MAX_STREAM_FAILOVER_CANDIDATES: usize = 2;

/// TS `capStreamFailoverMax(value)` — clamp configured stream failover
/// retries to the conservative runtime cap. **CLAMPS TO 1** (never more than
/// a single failover). Non-finite input coerces to 0.
pub fn cap_stream_failover_max(value: f64) -> u32 {
    let floored = if value.is_finite() { value.floor() } else { 0.0 };
    floored.clamp(0.0, MAX_STREAM_FAILOVERS as f64) as u32
}

/// Params for [`compute_outbound_request_attempt_budget`]. Values are `f64`
/// because the TS callers feed raw config numbers (possibly NaN/Infinity);
/// each is sanitized exactly like the TS.
#[derive(Clone, Copy, Debug)]
pub struct OutboundRequestAttemptBudgetParams {
    pub account_count: f64,
    pub max_same_account_retries: f64,
    pub empty_response_max_retries: f64,
    pub stream_failover_max: f64,
}

/// `Math.max(lo, Math.floor(Number.isFinite(v) ? v : dflt))`.
fn sanitize(value: f64, default: f64, lo: f64) -> f64 {
    let v = if value.is_finite() { value } else { default };
    v.floor().max(lo)
}

/// TS `computeOutboundRequestAttemptBudget(params)` — bounds all outbound
/// Responses API fetches across account rotation, same-account retries,
/// empty-response retries, and stream failover. Result is in `1..=6`.
pub fn compute_outbound_request_attempt_budget(
    params: OutboundRequestAttemptBudgetParams,
) -> u32 {
    let account_count = sanitize(params.account_count, 1.0, 1.0);
    let max_same_account_retries = sanitize(params.max_same_account_retries, 0.0, 0.0);
    let empty_response_max_retries = sanitize(params.empty_response_max_retries, 0.0, 0.0);
    let stream_failover_max = cap_stream_failover_max(params.stream_failover_max) as f64;

    let total = account_count
        + max_same_account_retries
        + empty_response_max_retries
        + stream_failover_max;
    total
        .min(MAX_TOTAL_OUTBOUND_REQUEST_ATTEMPTS as f64)
        .max(1.0) as u32
}

/// TS `buildStreamFailoverCandidateOrder(primaryIndex, accountIndices)` —
/// the primary first plus at most ONE alternate (2 candidates total),
/// skipping duplicates. (The TS `Number.isFinite` filter is statically
/// guaranteed by `usize`.)
pub fn build_stream_failover_candidate_order(
    primary_index: usize,
    account_indices: &[usize],
) -> Vec<usize> {
    let mut order = vec![primary_index];
    for &index in account_indices {
        if index == primary_index || order.contains(&index) {
            continue;
        }
        order.push(index);
        if order.len() >= MAX_STREAM_FAILOVER_CANDIDATES {
            break;
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_stream_failover_to_a_single_retry() {
        assert_eq!(cap_stream_failover_max(0.0), 0);
        assert_eq!(cap_stream_failover_max(1.0), 1);
        assert_eq!(cap_stream_failover_max(3.0), 1);
        assert_eq!(cap_stream_failover_max(f64::NAN), 0);
        assert_eq!(cap_stream_failover_max(-2.0), 0);
        assert_eq!(cap_stream_failover_max(f64::INFINITY), 0);
    }

    #[test]
    fn caps_outbound_request_budgets_for_large_account_pools() {
        assert_eq!(
            compute_outbound_request_attempt_budget(OutboundRequestAttemptBudgetParams {
                account_count: 12.0,
                max_same_account_retries: 2.0,
                empty_response_max_retries: 2.0,
                stream_failover_max: 3.0,
            }),
            6
        );
    }

    #[test]
    fn sanitizes_non_finite_retry_inputs_to_deterministic_defaults() {
        assert_eq!(
            compute_outbound_request_attempt_budget(OutboundRequestAttemptBudgetParams {
                account_count: f64::NAN,
                max_same_account_retries: f64::INFINITY,
                empty_response_max_retries: f64::NEG_INFINITY,
                stream_failover_max: f64::NAN,
            }),
            1
        );
    }

    #[test]
    fn small_pools_get_small_budgets() {
        assert_eq!(
            compute_outbound_request_attempt_budget(OutboundRequestAttemptBudgetParams {
                account_count: 1.0,
                max_same_account_retries: 1.0,
                empty_response_max_retries: 1.0,
                stream_failover_max: 1.0,
            }),
            4
        );
    }

    #[test]
    fn keeps_primary_plus_at_most_one_alternate() {
        assert_eq!(
            build_stream_failover_candidate_order(2, &[2, 5, 2, 7, 9]),
            vec![2, 5]
        );
        assert_eq!(build_stream_failover_candidate_order(0, &[]), vec![0]);
        assert_eq!(build_stream_failover_candidate_order(1, &[1, 1]), vec![1]);
    }
}
