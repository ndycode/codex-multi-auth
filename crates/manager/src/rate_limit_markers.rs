//! Port of `lib/codex-manager/rate-limit-markers.ts`.
//!
//! Behavior source: spec 08 §8 / spec 09 §4.4 — a status marker counts as
//! "rate-limited" when it is exactly `"rate-limited"` or starts with the
//! `"rate-limited:"` prefix (e.g. `"rate-limited:2h 5m"`).

/// TS `isRateLimitedMarker(marker)`.
pub fn is_rate_limited_marker(marker: &str) -> bool {
    marker == "rate-limited" || marker.starts_with("rate-limited:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_bare_and_prefixed_markers() {
        assert!(is_rate_limited_marker("rate-limited"));
        assert!(is_rate_limited_marker("rate-limited:2h 5m"));
        assert!(is_rate_limited_marker("rate-limited:"));
    }

    #[test]
    fn rejects_other_markers() {
        assert!(!is_rate_limited_marker("rate-limit"));
        assert!(!is_rate_limited_marker("cooldown:rate-limited"));
        assert!(!is_rate_limited_marker("quota-exhausted"));
        assert!(!is_rate_limited_marker(""));
        assert!(!is_rate_limited_marker("RATE-LIMITED"));
    }
}
