//! Port of `lib/rotation.ts` trackers — [`HealthScoreTracker`] and
//! [`TokenBucketTracker`].
//!
//! **HARD RULE (spec 04 gotcha 1 / ARCHITECTURE §8.4): nothing in this module
//! is ever persisted.** No state type here implements `serde::Serialize`; that
//! absence is the compiler-enforced never-persist boundary. Writing local
//! token-bucket state into the persisted `rateLimitResetTimes` was the critical
//! 6.4.0 regression (fixed in 6.4.1) — do not add `Serialize` derives.
//!
//! Composite tracker keying (spec 04 §1): every entry is keyed by
//! `JSON.stringify([String(accountKey), quotaKey ?? null])`, so a numeric key
//! `3` and the string key `"3"` normalize identically, and quota scopes
//! (`"codex"` / `"codex:gpt-5-codex"`) isolate state per account × quota.
//!
//! Timing constants (spec 04 §13): health +1 success / −10 rate-limit / −20
//! failure, clamped 0..100, +2/hour passive recovery; token bucket 50 max,
//! 6/min fractional refill, 90 000 ms refund window.
//!
//! The wall clock is injectable ([`cma_core::clock::Clock`]) purely as the test
//! seam replacing vitest fake timers; production paths use the system clock.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use cma_core::clock::{Clock, system_clock};

// ============================================================================
// Tracker keying
// ============================================================================

/// `type TrackerKey = number | string` from `lib/rotation.ts`.
///
/// Account keys are either pool indexes (numbers) or sticky identity strings
/// (e.g. `"email:user@example.com"`). Both normalize to the string form used
/// inside the composite JSON key, so [`TrackerKey::Number`]`(3)` and
/// [`TrackerKey::Text`]`("3")` address the same entry.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TrackerKey {
    /// Numeric account key (JS `number`; typically a pool index).
    Number(i64),
    /// String account key (stable identity key).
    Text(String),
}

impl TrackerKey {
    /// The JS `String(accountKey)` normalization: numbers render in decimal.
    pub fn normalized(&self) -> String {
        match self {
            TrackerKey::Number(n) => n.to_string(),
            TrackerKey::Text(s) => s.clone(),
        }
    }
}

impl std::fmt::Display for TrackerKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.normalized())
    }
}

impl From<i64> for TrackerKey {
    fn from(value: i64) -> Self {
        TrackerKey::Number(value)
    }
}

impl From<i32> for TrackerKey {
    fn from(value: i32) -> Self {
        TrackerKey::Number(i64::from(value))
    }
}

impl From<u32> for TrackerKey {
    fn from(value: u32) -> Self {
        TrackerKey::Number(i64::from(value))
    }
}

impl From<usize> for TrackerKey {
    fn from(value: usize) -> Self {
        TrackerKey::Number(value as i64)
    }
}

impl From<&str> for TrackerKey {
    fn from(value: &str) -> Self {
        TrackerKey::Text(value.to_string())
    }
}

impl From<String> for TrackerKey {
    fn from(value: String) -> Self {
        TrackerKey::Text(value)
    }
}

impl From<&String> for TrackerKey {
    fn from(value: &String) -> Self {
        TrackerKey::Text(value.clone())
    }
}

/// `normalizeTrackerKey`: `JSON.stringify([String(accountKey), quotaKey ?? null])`.
///
/// Byte-identical to the TS composite key (compact JSON, `null` for an absent
/// quota key) so diagnostic dumps of tracker keys line up between ports.
fn normalize_tracker_key(account_key: &TrackerKey, quota_key: Option<&str>) -> String {
    serde_json::to_string(&(account_key.normalized(), quota_key))
        .expect("tracker key serialization cannot fail")
}

/// Parse a composite tracker key back into `(accountKey, quotaKey)`.
/// Malformed keys yield `None` (TS wraps `JSON.parse` in try/catch and
/// ignores failures).
fn parse_tracker_key(key: &str) -> Option<(String, Option<String>)> {
    serde_json::from_str::<(String, Option<String>)>(key).ok()
}

/// `/^\d+$/` — ASCII digits only, non-empty.
fn is_all_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

fn lock_entries<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ============================================================================
// Health score tracking
// ============================================================================

/// `HealthScoreConfig` — deltas and bounds for [`HealthScoreTracker`].
/// NEVER derives `Serialize` (never-persist boundary).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HealthScoreConfig {
    /// Points added on successful request.
    pub success_delta: f64,
    /// Points deducted on rate limit (negative).
    pub rate_limit_delta: f64,
    /// Points deducted on other failures (negative).
    pub failure_delta: f64,
    /// Maximum health score.
    pub max_score: f64,
    /// Minimum health score.
    pub min_score: f64,
    /// Points recovered per hour of inactivity.
    pub passive_recovery_per_hour: f64,
}

/// `DEFAULT_HEALTH_SCORE_CONFIG` = `{ +1, −10, −20, 100, 0, +2/hr }`.
pub const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = HealthScoreConfig {
    success_delta: 1.0,
    rate_limit_delta: -10.0,
    failure_delta: -20.0,
    max_score: 100.0,
    min_score: 0.0,
    passive_recovery_per_hour: 2.0,
};

impl Default for HealthScoreConfig {
    fn default() -> Self {
        DEFAULT_HEALTH_SCORE_CONFIG
    }
}

/// Per-key health entry. In-memory only; never serialized.
#[derive(Debug, Clone)]
struct HealthEntry {
    score: f64,
    last_updated: i64,
    consecutive_failures: u32,
}

/// Tracks health scores for accounts to prioritize healthy accounts.
/// Accounts with higher health scores are preferred for selection.
///
/// Thread-safe (interior mutability) so the process-wide singleton returned by
/// [`get_health_tracker`] can be shared by reference.
pub struct HealthScoreTracker {
    entries: Mutex<HashMap<String, HealthEntry>>,
    config: HealthScoreConfig,
    clock: Arc<dyn Clock>,
}

impl Default for HealthScoreTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl HealthScoreTracker {
    /// Tracker with [`DEFAULT_HEALTH_SCORE_CONFIG`] and the system clock.
    pub fn new() -> Self {
        Self::with_config(DEFAULT_HEALTH_SCORE_CONFIG)
    }

    /// Tracker with a custom config (TS `new HealthScoreTracker(partial)`;
    /// use struct-update syntax over [`HealthScoreConfig::default`] for the
    /// `Partial<…>` merge).
    pub fn with_config(config: HealthScoreConfig) -> Self {
        Self::with_config_and_clock(config, system_clock())
    }

    /// Test seam: custom config plus an injected clock (fake-timer analogue).
    pub fn with_config_and_clock(config: HealthScoreConfig, clock: Arc<dyn Clock>) -> Self {
        HealthScoreTracker {
            entries: Mutex::new(HashMap::new()),
            config,
            clock,
        }
    }

    fn key(&self, account_key: &TrackerKey, quota_key: Option<&str>) -> String {
        normalize_tracker_key(account_key, quota_key)
    }

    /// `min(score + hoursSinceUpdate * passiveRecoveryPerHour, maxScore)`.
    fn apply_passive_recovery(&self, entry: &HealthEntry, now: i64) -> f64 {
        let hours_since_update = (now - entry.last_updated) as f64 / (1000.0 * 60.0 * 60.0);
        let recovery = hours_since_update * self.config.passive_recovery_per_hour;
        (entry.score + recovery).min(self.config.max_score)
    }

    /// Unknown key ⇒ `maxScore`; known ⇒ passive-recovered score.
    /// **Read does not mutate** the stored entry.
    pub fn get_score(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) -> f64 {
        let key = self.key(&account_key.into(), quota_key);
        let now = self.clock.now_ms();
        let entries = lock_entries(&self.entries);
        match entries.get(&key) {
            Some(entry) => self.apply_passive_recovery(entry, now),
            None => self.config.max_score,
        }
    }

    /// Consecutive failure count; 0 when unknown.
    pub fn get_consecutive_failures(
        &self,
        account_key: impl Into<TrackerKey>,
        quota_key: Option<&str>,
    ) -> u32 {
        let key = self.key(&account_key.into(), quota_key);
        let entries = lock_entries(&self.entries);
        entries
            .get(&key)
            .map(|entry| entry.consecutive_failures)
            .unwrap_or(0)
    }

    /// `min(base + successDelta, maxScore)`; resets consecutive failures.
    pub fn record_success(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) {
        self.record(
            account_key.into(),
            quota_key,
            self.config.success_delta,
            true,
        );
    }

    /// `max(base + rateLimitDelta, minScore)`; consecutive failures +1.
    pub fn record_rate_limit(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) {
        self.record(
            account_key.into(),
            quota_key,
            self.config.rate_limit_delta,
            false,
        );
    }

    /// `max(base + failureDelta, minScore)`; consecutive failures +1.
    pub fn record_failure(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) {
        self.record(
            account_key.into(),
            quota_key,
            self.config.failure_delta,
            false,
        );
    }

    fn record(&self, account_key: TrackerKey, quota_key: Option<&str>, delta: f64, success: bool) {
        let key = self.key(&account_key, quota_key);
        let now = self.clock.now_ms();
        let mut entries = lock_entries(&self.entries);
        let entry = entries.get(&key);
        let base_score = match entry {
            Some(entry) => self.apply_passive_recovery(entry, now),
            None => self.config.max_score,
        };
        // Clamp by METHOD identity, exactly like TS: recordSuccess uses
        // `min(base + delta, maxScore)` (no lower clamp); recordRateLimit /
        // recordFailure use `max(base + delta, minScore)` (no upper clamp).
        // Inferring the clamp from the delta's sign would diverge for custom
        // configs with sign-flipped deltas.
        let new_score = if success {
            (base_score + delta).min(self.config.max_score)
        } else {
            (base_score + delta).max(self.config.min_score)
        };
        let consecutive_failures = if success {
            0
        } else {
            entry.map(|e| e.consecutive_failures).unwrap_or(0) + 1
        };
        entries.insert(
            key,
            HealthEntry {
                score: new_score,
                last_updated: now,
                consecutive_failures,
            },
        );
    }

    /// Delete one composite key.
    pub fn reset(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) {
        let key = self.key(&account_key.into(), quota_key);
        lock_entries(&self.entries).remove(&key);
    }

    /// Delete all entries.
    pub fn clear(&self) {
        lock_entries(&self.entries).clear();
    }

    /// Delete every entry whose parsed account key is all-digits and
    /// `>= start_index` (index-removal fixups). Malformed keys are ignored.
    pub fn clear_numeric_keys_at_or_above(&self, start_index: usize) {
        let mut entries = lock_entries(&self.entries);
        clear_numeric_keys_at_or_above_in(&mut entries, start_index);
    }

    /// Delete every entry (across all quota-key variants) for a given account
    /// key. Used when an account is removed so a later re-add of the same
    /// identity does not inherit stale health penalties (accounts-02).
    pub fn clear_account_key(&self, account_key: impl Into<TrackerKey>) {
        let normalized = account_key.into().normalized();
        let mut entries = lock_entries(&self.entries);
        clear_account_key_in(&mut entries, &normalized);
    }
}

fn clear_numeric_keys_at_or_above_in<V>(entries: &mut HashMap<String, V>, start_index: usize) {
    let to_remove: Vec<String> = entries
        .keys()
        .filter(|key| {
            parse_tracker_key(key)
                .map(|(account_key, _)| {
                    is_all_digits(&account_key)
                        && account_key
                            .parse::<f64>()
                            .map(|n| n >= start_index as f64)
                            .unwrap_or(false)
                })
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    for key in to_remove {
        entries.remove(&key);
    }
}

fn clear_account_key_in<V>(entries: &mut HashMap<String, V>, normalized: &str) {
    let to_remove: Vec<String> = entries
        .keys()
        .filter(|key| {
            parse_tracker_key(key)
                .map(|(account_key, _)| account_key == normalized)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    for key in to_remove {
        entries.remove(&key);
    }
}

// ============================================================================
// Token bucket rate limiting
// ============================================================================

/// `TokenBucketConfig`. NEVER derives `Serialize` (never-persist boundary).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TokenBucketConfig {
    /// Maximum tokens in bucket.
    pub max_tokens: f64,
    /// Tokens regenerated per minute (fractional refill allowed).
    pub tokens_per_minute: f64,
}

/// `DEFAULT_TOKEN_BUCKET_CONFIG` = `{ maxTokens: 50, tokensPerMinute: 6 }`.
pub const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = TokenBucketConfig {
    max_tokens: 50.0,
    tokens_per_minute: 6.0,
};

impl Default for TokenBucketConfig {
    fn default() -> Self {
        DEFAULT_TOKEN_BUCKET_CONFIG
    }
}

/// Default `drainAmount` for [`TokenBucketTracker::drain`] (TS default param).
pub const DEFAULT_DRAIN_AMOUNT: f64 = 10.0;

// Must cover the full request lifetime so a token consumed at request start can
// still be refunded when the request fails at the very end. The runtime proxy
// refunds on network error / upstream timeout, and the default fetch timeout is
// 60_000ms (config fetchTimeoutMs) — measured AFTER token consumption and a
// token refresh. 90_000ms = that 60s timeout plus slack for the refresh and
// processing, so a genuinely timed-out request's token is reversed instead of
// leaking (gradual token-bucket starvation -> spurious token-exhausted skips).
const TOKEN_REFUND_WINDOW_MS: i64 = 90_000;

/// Per-key bucket entry. In-memory only; never serialized.
#[derive(Debug, Clone)]
struct TokenBucketEntry {
    tokens: f64,
    last_refill: i64,
    consumptions: Vec<i64>,
}

/// Client-side token bucket for rate limiting requests per account.
/// Prevents sending requests to accounts that are likely to be rate-limited.
///
/// Thread-safe (interior mutability); see [`get_token_tracker`].
pub struct TokenBucketTracker {
    buckets: Mutex<HashMap<String, TokenBucketEntry>>,
    config: TokenBucketConfig,
    clock: Arc<dyn Clock>,
}

impl Default for TokenBucketTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenBucketTracker {
    /// Tracker with [`DEFAULT_TOKEN_BUCKET_CONFIG`] and the system clock.
    pub fn new() -> Self {
        Self::with_config(DEFAULT_TOKEN_BUCKET_CONFIG)
    }

    /// Tracker with a custom config (TS `Partial<TokenBucketConfig>` merge ⇒
    /// struct-update syntax over [`TokenBucketConfig::default`]).
    pub fn with_config(config: TokenBucketConfig) -> Self {
        Self::with_config_and_clock(config, system_clock())
    }

    /// Test seam: custom config plus an injected clock.
    pub fn with_config_and_clock(config: TokenBucketConfig, clock: Arc<dyn Clock>) -> Self {
        TokenBucketTracker {
            buckets: Mutex::new(HashMap::new()),
            config,
            clock,
        }
    }

    fn key(&self, account_key: &TrackerKey, quota_key: Option<&str>) -> String {
        normalize_tracker_key(account_key, quota_key)
    }

    /// `min(tokens + minutesSinceRefill * tokensPerMinute, maxTokens)`.
    fn refill_tokens(&self, entry: &TokenBucketEntry, now: i64) -> f64 {
        let minutes_since_refill = (now - entry.last_refill) as f64 / (1000.0 * 60.0);
        let tokens_to_add = minutes_since_refill * self.config.tokens_per_minute;
        (entry.tokens + tokens_to_add).min(self.config.max_tokens)
    }

    /// Unknown key ⇒ `maxTokens`; else the refilled value (no mutation).
    pub fn get_tokens(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) -> f64 {
        let key = self.key(&account_key.into(), quota_key);
        let now = self.clock.now_ms();
        let buckets = lock_entries(&self.buckets);
        match buckets.get(&key) {
            Some(entry) => self.refill_tokens(entry, now),
            None => self.config.max_tokens,
        }
    }

    /// Attempt to consume a token. Returns `true` if successful, `false` if
    /// the bucket is empty. Resets `lastRefill = now` on success (refill
    /// accrual restarts on every mutation — spec 04 gotcha 4).
    pub fn try_consume(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) -> bool {
        let key = self.key(&account_key.into(), quota_key);
        let now = self.clock.now_ms();
        let mut buckets = lock_entries(&self.buckets);
        let entry = buckets.get(&key);
        let current_tokens = match entry {
            Some(entry) => self.refill_tokens(entry, now),
            None => self.config.max_tokens,
        };

        if current_tokens < 1.0 {
            return false;
        }

        let cutoff = now - TOKEN_REFUND_WINDOW_MS;
        let mut consumptions: Vec<i64> = entry
            .map(|e| {
                e.consumptions
                    .iter()
                    .copied()
                    .filter(|timestamp| *timestamp >= cutoff)
                    .collect()
            })
            .unwrap_or_default();
        consumptions.push(now);

        buckets.insert(
            key,
            TokenBucketEntry {
                tokens: current_tokens - 1.0,
                last_refill: now,
                consumptions,
            },
        );
        true
    }

    /// Attempt to refund a token consumed within the 90 s refund window.
    /// Use this when a request fails due to network errors (not rate limits —
    /// a 429 is genuine quota consumption and is NOT refunded, gotcha 17).
    /// Removes the FIRST in-window consumption; returns `false` if no valid
    /// consumption is found. Resets `lastRefill = now` on success.
    pub fn refund_token(
        &self,
        account_key: impl Into<TrackerKey>,
        quota_key: Option<&str>,
    ) -> bool {
        let key = self.key(&account_key.into(), quota_key);
        let now = self.clock.now_ms();
        let mut buckets = lock_entries(&self.buckets);
        let Some(entry) = buckets.get_mut(&key) else {
            return false;
        };
        if entry.consumptions.is_empty() {
            return false;
        }

        let cutoff = now - TOKEN_REFUND_WINDOW_MS;
        let Some(valid_index) = entry
            .consumptions
            .iter()
            .position(|timestamp| *timestamp >= cutoff)
        else {
            return false;
        };

        entry.consumptions.remove(valid_index);
        // Refill from the pre-refund entry state (tokens + lastRefill), then
        // add the refunded token back, capped at maxTokens.
        let entry_snapshot = TokenBucketEntry {
            tokens: entry.tokens,
            last_refill: entry.last_refill,
            consumptions: Vec::new(),
        };
        let current_tokens = self.refill_tokens(&entry_snapshot, now);
        entry.tokens = (current_tokens + 1.0).min(self.config.max_tokens);
        entry.last_refill = now;
        true
    }

    /// Drain tokens on rate limit to prevent immediate retries. Creates the
    /// entry if absent (starting from `maxTokens`); preserves consumptions and
    /// resets `lastRefill = now`. TS default `drainAmount` is
    /// [`DEFAULT_DRAIN_AMOUNT`].
    pub fn drain(
        &self,
        account_key: impl Into<TrackerKey>,
        quota_key: Option<&str>,
        drain_amount: f64,
    ) {
        let key = self.key(&account_key.into(), quota_key);
        let now = self.clock.now_ms();
        let mut buckets = lock_entries(&self.buckets);
        let entry = buckets.get(&key);
        let current_tokens = match entry {
            Some(entry) => self.refill_tokens(entry, now),
            None => self.config.max_tokens,
        };
        let consumptions = entry.map(|e| e.consumptions.clone()).unwrap_or_default();
        buckets.insert(
            key,
            TokenBucketEntry {
                tokens: (current_tokens - drain_amount).max(0.0),
                last_refill: now,
                consumptions,
            },
        );
    }

    /// Delete one composite key.
    pub fn reset(&self, account_key: impl Into<TrackerKey>, quota_key: Option<&str>) {
        let key = self.key(&account_key.into(), quota_key);
        lock_entries(&self.buckets).remove(&key);
    }

    /// Delete all buckets.
    pub fn clear(&self) {
        lock_entries(&self.buckets).clear();
    }

    /// Delete every bucket whose parsed account key is all-digits and
    /// `>= start_index`. Malformed keys are ignored.
    pub fn clear_numeric_keys_at_or_above(&self, start_index: usize) {
        let mut buckets = lock_entries(&self.buckets);
        clear_numeric_keys_at_or_above_in(&mut buckets, start_index);
    }

    /// Delete every bucket (across all quota-key variants) for a given account
    /// key, so a removed-then-re-added account does not inherit stale token
    /// state (accounts-02).
    pub fn clear_account_key(&self, account_key: impl Into<TrackerKey>) {
        let normalized = account_key.into().normalized();
        let mut buckets = lock_entries(&self.buckets);
        clear_account_key_in(&mut buckets, &normalized);
    }
}

// ============================================================================
// Singleton instances
// ============================================================================

static HEALTH_TRACKER_INSTANCE: OnceLock<HealthScoreTracker> = OnceLock::new();
static TOKEN_TRACKER_INSTANCE: OnceLock<TokenBucketTracker> = OnceLock::new();

/// Lazy process-wide health tracker singleton. `config` is honored only on the
/// first call (spec 04 gotcha 27).
pub fn get_health_tracker(config: Option<HealthScoreConfig>) -> &'static HealthScoreTracker {
    HEALTH_TRACKER_INSTANCE.get_or_init(|| match config {
        Some(config) => HealthScoreTracker::with_config(config),
        None => HealthScoreTracker::new(),
    })
}

/// Lazy process-wide token tracker singleton. `config` is honored only on the
/// first call (spec 04 gotcha 27).
pub fn get_token_tracker(config: Option<TokenBucketConfig>) -> &'static TokenBucketTracker {
    TOKEN_TRACKER_INSTANCE.get_or_init(|| match config {
        Some(config) => TokenBucketTracker::with_config(config),
        None => TokenBucketTracker::new(),
    })
}

/// `resetTrackers()` — clears both singletons **if instantiated** (does NOT
/// null them out; the instances and their configs survive).
pub fn reset_trackers() {
    if let Some(tracker) = HEALTH_TRACKER_INSTANCE.get() {
        tracker.clear();
    }
    if let Some(tracker) = TOKEN_TRACKER_INSTANCE.get() {
        tracker.clear();
    }
}

// ============================================================================
// Tests (ported from test/rotation.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::clock::ManualClock;

    /// 2026-01-30T12:00:00Z, the fake-timer epoch used by rotation.test.ts.
    const T0: i64 = 1_769_774_400_000;

    fn health_with_clock() -> (HealthScoreTracker, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(T0));
        let tracker =
            HealthScoreTracker::with_config_and_clock(DEFAULT_HEALTH_SCORE_CONFIG, clock.clone());
        (tracker, clock)
    }

    fn tokens_with_clock() -> (TokenBucketTracker, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(T0));
        let tracker =
            TokenBucketTracker::with_config_and_clock(DEFAULT_TOKEN_BUCKET_CONFIG, clock.clone());
        (tracker, clock)
    }

    #[test]
    fn tracker_key_normalization_is_composite_json() {
        assert_eq!(
            normalize_tracker_key(&TrackerKey::Number(3), None),
            "[\"3\",null]"
        );
        assert_eq!(
            normalize_tracker_key(&TrackerKey::Text("3".into()), None),
            "[\"3\",null]"
        );
        assert_eq!(
            normalize_tracker_key(&TrackerKey::Text("acc".into()), Some("codex:gpt-5-codex")),
            "[\"acc\",\"codex:gpt-5-codex\"]"
        );
    }

    // ---------------- HealthScoreTracker ----------------

    #[test]
    fn health_returns_max_score_for_unknown_accounts() {
        let (tracker, _clock) = health_with_clock();
        assert_eq!(
            tracker.get_score(0usize, None),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
        assert_eq!(
            tracker.get_score(0usize, Some("quota-a")),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
    }

    #[test]
    fn health_record_success_increases_score_and_resets_failures() {
        let (tracker, _clock) = health_with_clock();
        tracker.record_rate_limit(0usize, None);
        let after_rate_limit = tracker.get_score(0usize, None);
        tracker.record_success(0usize, None);
        assert!(tracker.get_score(0usize, None) > after_rate_limit);

        tracker.record_failure(0usize, None);
        tracker.record_failure(0usize, None);
        assert_eq!(tracker.get_consecutive_failures(0usize, None), 2);
        tracker.record_success(0usize, None);
        assert_eq!(tracker.get_consecutive_failures(0usize, None), 0);
    }

    #[test]
    fn health_success_does_not_exceed_max_score() {
        let (tracker, _clock) = health_with_clock();
        for _ in 0..200 {
            tracker.record_success(0usize, None);
        }
        assert!(tracker.get_score(0usize, None) <= DEFAULT_HEALTH_SCORE_CONFIG.max_score);
    }

    #[test]
    fn health_rate_limit_decreases_score_and_increments_failures() {
        let (tracker, _clock) = health_with_clock();
        tracker.record_rate_limit(0usize, None);
        let expected =
            DEFAULT_HEALTH_SCORE_CONFIG.max_score + DEFAULT_HEALTH_SCORE_CONFIG.rate_limit_delta;
        assert_eq!(tracker.get_score(0usize, None), expected);
        assert_eq!(tracker.get_consecutive_failures(0usize, None), 1);
        tracker.record_rate_limit(0usize, None);
        assert_eq!(tracker.get_consecutive_failures(0usize, None), 2);
    }

    #[test]
    fn health_failure_decreases_score_by_failure_delta() {
        let (tracker, _clock) = health_with_clock();
        tracker.record_failure(0usize, None);
        let expected =
            DEFAULT_HEALTH_SCORE_CONFIG.max_score + DEFAULT_HEALTH_SCORE_CONFIG.failure_delta;
        assert_eq!(tracker.get_score(0usize, None), expected);
    }

    #[test]
    fn health_does_not_go_below_min_score() {
        let (tracker, _clock) = health_with_clock();
        for _ in 0..10 {
            tracker.record_failure(0usize, None);
        }
        assert_eq!(
            tracker.get_score(0usize, None),
            DEFAULT_HEALTH_SCORE_CONFIG.min_score
        );
    }

    #[test]
    fn health_passive_recovery_over_time() {
        let (tracker, clock) = health_with_clock();
        tracker.record_rate_limit(0usize, None);
        let after_rate_limit = tracker.get_score(0usize, None);

        clock.advance(1000 * 60 * 60);
        let after_one_hour = tracker.get_score(0usize, None);
        let expected_recovery = DEFAULT_HEALTH_SCORE_CONFIG.passive_recovery_per_hour;
        assert!((after_one_hour - (after_rate_limit + expected_recovery)).abs() < 0.1);

        clock.advance(1000 * 60 * 60 * 100);
        assert!(tracker.get_score(0usize, None) <= DEFAULT_HEALTH_SCORE_CONFIG.max_score);
    }

    #[test]
    fn health_read_does_not_mutate_the_stored_entry() {
        let (tracker, clock) = health_with_clock();
        tracker.record_rate_limit(0usize, None); // 90 at T0
        clock.advance(1000 * 60 * 60); // +2 recovery on read
        let first = tracker.get_score(0usize, None);
        let second = tracker.get_score(0usize, None);
        assert_eq!(first, second);
        assert_eq!(tracker.get_consecutive_failures(0usize, None), 1);
    }

    #[test]
    fn health_reset_and_clear() {
        let (tracker, _clock) = health_with_clock();
        tracker.record_failure(0usize, None);
        tracker.record_failure(1usize, None);

        tracker.reset(0usize, None);
        assert_eq!(
            tracker.get_score(0usize, None),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
        assert!(tracker.get_score(1usize, None) < DEFAULT_HEALTH_SCORE_CONFIG.max_score);

        tracker.record_failure(2usize, None);
        tracker.clear();
        for index in 0usize..3 {
            assert_eq!(
                tracker.get_score(index, None),
                DEFAULT_HEALTH_SCORE_CONFIG.max_score
            );
        }
    }

    #[test]
    fn health_isolates_scores_by_quota_key() {
        let (tracker, _clock) = health_with_clock();
        tracker.record_failure(0usize, Some("quota-a"));
        tracker.record_success(0usize, Some("quota-b"));

        assert!(tracker.get_score(0usize, Some("quota-a")) < DEFAULT_HEALTH_SCORE_CONFIG.max_score);
        assert_eq!(
            tracker.get_score(0usize, Some("quota-b")),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
    }

    #[test]
    fn health_clear_account_key_clears_every_quota_variant() {
        let (tracker, _clock) = health_with_clock();
        tracker.record_failure("acc", Some("codex"));
        tracker.record_failure("acc", Some("codex:gpt-5.1"));
        tracker.record_failure("other", Some("codex"));

        tracker.clear_account_key("acc");

        assert_eq!(
            tracker.get_score("acc", Some("codex")),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
        assert_eq!(
            tracker.get_score("acc", Some("codex:gpt-5.1")),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
        assert!(tracker.get_score("other", Some("codex")) < DEFAULT_HEALTH_SCORE_CONFIG.max_score);
    }

    #[test]
    fn health_clear_account_key_normalizes_numeric_keys() {
        let (tracker, _clock) = health_with_clock();
        // Write under the numeric key but clear with the string form.
        tracker.record_failure(3usize, Some("codex"));
        tracker.clear_account_key("3");
        assert_eq!(
            tracker.get_score(3usize, Some("codex")),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
    }

    #[test]
    fn health_clear_numeric_keys_at_or_above() {
        let (tracker, _clock) = health_with_clock();
        tracker.record_failure(0usize, None);
        tracker.record_failure(1usize, Some("codex"));
        tracker.record_failure(2usize, None);
        tracker.record_failure("identity", Some("codex"));

        tracker.clear_numeric_keys_at_or_above(1);

        assert!(tracker.get_score(0usize, None) < DEFAULT_HEALTH_SCORE_CONFIG.max_score);
        assert_eq!(
            tracker.get_score(1usize, Some("codex")),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
        assert_eq!(
            tracker.get_score(2usize, None),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
        // Non-numeric identity keys survive.
        assert!(
            tracker.get_score("identity", Some("codex")) < DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
    }

    // ---------------- TokenBucketTracker ----------------

    #[test]
    fn tokens_returns_max_for_unknown_accounts() {
        let (tracker, _clock) = tokens_with_clock();
        assert_eq!(
            tracker.get_tokens(0usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
    }

    #[test]
    fn tokens_try_consume_consumes_one_token() {
        let (tracker, _clock) = tokens_with_clock();
        assert!(tracker.try_consume(0usize, None));
        assert_eq!(
            tracker.get_tokens(0usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens - 1.0
        );
    }

    #[test]
    fn tokens_try_consume_returns_false_when_empty() {
        let (tracker, _clock) = tokens_with_clock();
        for _ in 0..DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens as usize {
            tracker.try_consume(0usize, None);
        }
        assert!(!tracker.try_consume(0usize, None));
    }

    #[test]
    fn tokens_refund_within_window() {
        let (tracker, _clock) = tokens_with_clock();
        tracker.try_consume(0usize, None);
        assert!(tracker.refund_token(0usize, None));
        assert_eq!(
            tracker.get_tokens(0usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
    }

    #[test]
    fn tokens_refund_covers_the_55s_request_lifetime() {
        // tokensPerMinute: 0 so refill can't mask the refund's restored token.
        let clock = Arc::new(ManualClock::new(T0));
        let no_refill = TokenBucketTracker::with_config_and_clock(
            TokenBucketConfig {
                tokens_per_minute: 0.0,
                ..TokenBucketConfig::default()
            },
            clock.clone(),
        );
        no_refill.try_consume(0usize, None);
        let before_refund = no_refill.get_tokens(0usize, None);

        clock.advance(55_000);

        assert!(no_refill.refund_token(0usize, None));
        assert_eq!(no_refill.get_tokens(0usize, None), before_refund + 1.0);
    }

    #[test]
    fn tokens_refund_window_boundary_is_inclusive() {
        // The cutoff is `timestamp >= now - TOKEN_REFUND_WINDOW_MS`.
        let clock = Arc::new(ManualClock::new(T0));
        let no_refill = TokenBucketTracker::with_config_and_clock(
            TokenBucketConfig {
                tokens_per_minute: 0.0,
                ..TokenBucketConfig::default()
            },
            clock.clone(),
        );
        no_refill.try_consume(0usize, None);
        let before_refund = no_refill.get_tokens(0usize, None);

        clock.advance(TOKEN_REFUND_WINDOW_MS);

        assert!(no_refill.refund_token(0usize, None));
        assert_eq!(no_refill.get_tokens(0usize, None), before_refund + 1.0);
    }

    #[test]
    fn tokens_refund_rejected_for_ancient_consumption() {
        let (tracker, clock) = tokens_with_clock();
        tracker.try_consume(0usize, None);
        clock.advance(TOKEN_REFUND_WINDOW_MS + 1);
        assert!(!tracker.refund_token(0usize, None));
    }

    #[test]
    fn tokens_refund_returns_false_without_consumptions() {
        let (tracker, _clock) = tokens_with_clock();
        assert!(!tracker.refund_token(0usize, None));
    }

    #[test]
    fn tokens_refund_does_not_exceed_max_tokens() {
        let (tracker, clock) = tokens_with_clock();
        tracker.try_consume(0usize, None);
        clock.advance(10_000);
        assert!(tracker.refund_token(0usize, None));
        assert_eq!(
            tracker.get_tokens(0usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
    }

    #[test]
    fn tokens_refill_over_time_and_cap() {
        let (tracker, clock) = tokens_with_clock();
        for _ in 0..10 {
            tracker.try_consume(0usize, None);
        }
        let after_drain = tracker.get_tokens(0usize, None);
        clock.advance(1000 * 60);
        assert!(tracker.get_tokens(0usize, None) > after_drain);

        clock.advance(1000 * 60 * 60);
        assert!(tracker.get_tokens(0usize, None) <= DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens);
    }

    #[test]
    fn tokens_drain_removes_specified_tokens() {
        let (tracker, _clock) = tokens_with_clock();
        tracker.drain(0usize, None, 20.0);
        assert_eq!(
            tracker.get_tokens(0usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens - 20.0
        );
    }

    #[test]
    fn tokens_drain_does_not_go_below_zero() {
        let (tracker, _clock) = tokens_with_clock();
        tracker.drain(0usize, None, 100.0);
        assert_eq!(tracker.get_tokens(0usize, None), 0.0);
    }

    #[test]
    fn tokens_drain_creates_entry_starting_from_max() {
        let (tracker, _clock) = tokens_with_clock();
        tracker.drain(5usize, Some("new-quota"), 5.0);
        assert_eq!(
            tracker.get_tokens(5usize, Some("new-quota")),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens - 5.0
        );
    }

    #[test]
    fn tokens_reset_and_clear() {
        let (tracker, _clock) = tokens_with_clock();
        tracker.drain(0usize, None, 30.0);
        tracker.drain(1usize, None, 30.0);

        tracker.reset(0usize, None);
        assert_eq!(
            tracker.get_tokens(0usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
        assert!(tracker.get_tokens(1usize, None) < DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens);

        tracker.clear();
        assert_eq!(
            tracker.get_tokens(1usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
    }

    #[test]
    fn tokens_clear_account_key_clears_every_quota_variant() {
        let (tracker, _clock) = tokens_with_clock();
        tracker.drain("acc", Some("codex"), 30.0);
        tracker.drain("acc", Some("codex:gpt-5.1"), 30.0);
        tracker.drain("other", Some("codex"), 30.0);

        tracker.clear_account_key("acc");

        assert_eq!(
            tracker.get_tokens("acc", Some("codex")),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
        assert_eq!(
            tracker.get_tokens("acc", Some("codex:gpt-5.1")),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
        assert!(tracker.get_tokens("other", Some("codex")) < DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens);
    }

    #[test]
    fn tokens_clear_account_key_normalizes_numeric_keys() {
        let (tracker, _clock) = tokens_with_clock();
        // Drain under the string key but clear with the numeric form.
        tracker.drain("3", Some("codex"), 30.0);
        tracker.clear_account_key(3usize);
        assert_eq!(
            tracker.get_tokens("3", Some("codex")),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
    }

    #[test]
    fn tokens_consume_resets_last_refill_to_now() {
        // lastRefill must be reset to `now` on every mutation (gotcha 4):
        // otherwise refill accrual double-counts the elapsed time.
        let (tracker, clock) = tokens_with_clock();
        tracker.drain(0usize, None, 30.0); // 20 tokens, lastRefill = T0
        clock.advance(30_000); // refill view: 20 + 3 = 23
        assert_eq!(tracker.get_tokens(0usize, None), 23.0);
        tracker.try_consume(0usize, None); // 23 - 1 = 22, lastRefill = T0+30s
        clock.advance(10_000); // +1 from the NEW lastRefill
        // A non-reset lastRefill (still T0) would yield 22 + 4 = 26 here.
        assert_eq!(tracker.get_tokens(0usize, None), 23.0);
    }

    // ---------------- singletons ----------------

    #[test]
    #[serial_test::serial(rotation_tracker_singletons)]
    fn singletons_are_process_wide_and_reset_clears_them() {
        let first = get_health_tracker(None);
        let second = get_health_tracker(None);
        assert!(std::ptr::eq(first, second));

        let token_first = get_token_tracker(None);
        let token_second = get_token_tracker(None);
        assert!(std::ptr::eq(token_first, token_second));

        first.record_failure(0usize, None);
        token_first.drain(0usize, None, 30.0);
        reset_trackers();
        assert_eq!(
            first.get_score(0usize, None),
            DEFAULT_HEALTH_SCORE_CONFIG.max_score
        );
        assert_eq!(
            token_first.get_tokens(0usize, None),
            DEFAULT_TOKEN_BUCKET_CONFIG.max_tokens
        );
    }
}
