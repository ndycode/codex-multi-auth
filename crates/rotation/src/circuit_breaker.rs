//! Port of `lib/circuit-breaker.ts` — classic closed/open/half-open breaker
//! plus a bounded process-global registry.
//!
//! Contracts carried over verbatim (spec 04 §2 + gotcha 5):
//! - `can_execute()` **THROWS** [`CircuitOpenError`] (never returns `false`
//!   when blocked) and MUTATES (half-open attempt counter, automatic
//!   open→half-open transition); `is_available*` is the pure, non-mutating
//!   predicate.
//! - Defaults: 3 failures / 60 s window, 30 s reset timeout, 1 half-open
//!   probe. Config is honored only at construction.
//! - Registry cap 100 with **insertion-order** eviction (first map key — the
//!   oldest-created entry, NOT LRU). `remove_circuit_breaker` exists so a
//!   removed-then-re-added account starts with a fresh closed circuit
//!   (accounts-02).
//!
//! In-memory only; nothing here implements `Serialize` (never-persist
//! boundary, ARCHITECTURE §8.4). The wall clock is injectable purely as the
//! test seam replacing vitest fake timers.

use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use cma_core::clock::{Clock, system_clock};

/// `CircuitBreakerConfig`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CircuitBreakerConfig {
    /// Failures within the window required to open the circuit.
    pub failure_threshold: usize,
    /// Sliding window (ms) in which failures are counted.
    pub failure_window_ms: i64,
    /// Wait (ms) before an open circuit admits a half-open probe.
    pub reset_timeout_ms: i64,
    /// Probe budget per half-open window.
    pub half_open_max_attempts: u32,
}

/// `DEFAULT_CIRCUIT_BREAKER_CONFIG` = `{ 3, 60_000, 30_000, 1 }`.
pub const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = CircuitBreakerConfig {
    failure_threshold: 3,
    failure_window_ms: 60_000,
    reset_timeout_ms: 30_000,
    half_open_max_attempts: 1,
};

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        DEFAULT_CIRCUIT_BREAKER_CONFIG
    }
}

/// `CircuitState = "closed" | "open" | "half-open"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CircuitState {
    /// Normal operation.
    Closed,
    /// Blocking; waiting out the reset timeout.
    Open,
    /// Admitting a bounded number of probe requests.
    HalfOpen,
}

impl CircuitState {
    /// The TS string form (`"closed" | "open" | "half-open"`).
    pub fn as_str(&self) -> &'static str {
        match self {
            CircuitState::Closed => "closed",
            CircuitState::Open => "open",
            CircuitState::HalfOpen => "half-open",
        }
    }
}

impl std::fmt::Display for CircuitState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `CircuitOpenError` — thrown by [`CircuitBreaker::can_execute`] when the
/// circuit blocks execution. `name = "CircuitOpenError"`; default message
/// `"Circuit is open"` (half-open saturation uses `"Circuit is half-open"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CircuitOpenError {
    message: String,
}

impl CircuitOpenError {
    /// The TS `Error.name`.
    pub const NAME: &'static str = "CircuitOpenError";

    /// Error with the default message `"Circuit is open"`.
    pub fn new() -> Self {
        Self::with_message("Circuit is open")
    }

    /// Error with a custom message.
    pub fn with_message(message: impl Into<String>) -> Self {
        CircuitOpenError {
            message: message.into(),
        }
    }

    /// The frozen error message.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The TS `Error.name` (`"CircuitOpenError"`).
    pub fn name(&self) -> &'static str {
        Self::NAME
    }
}

impl Default for CircuitOpenError {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for CircuitOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CircuitOpenError {}

/// Mutable breaker state. In-memory only; never serialized.
#[derive(Debug)]
struct BreakerState {
    state: CircuitState,
    /// Failure timestamps (epoch ms) inside the sliding window.
    failures: Vec<i64>,
    last_state_change: i64,
    half_open_attempts: u32,
}

/// Per-key circuit breaker gating accounts after repeated failures.
///
/// Thread-safe (interior mutability) so registry entries can be shared as
/// [`Arc<CircuitBreaker>`] across callers, mirroring the shared TS instances.
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    clock: Arc<dyn Clock>,
    inner: Mutex<BreakerState>,
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new()
    }
}

impl CircuitBreaker {
    /// Breaker with [`DEFAULT_CIRCUIT_BREAKER_CONFIG`] and the system clock.
    pub fn new() -> Self {
        Self::with_config(DEFAULT_CIRCUIT_BREAKER_CONFIG)
    }

    /// Breaker with a custom config (TS `Partial<…>` merge ⇒ struct-update
    /// syntax over [`CircuitBreakerConfig::default`]).
    pub fn with_config(config: CircuitBreakerConfig) -> Self {
        Self::with_config_and_clock(config, system_clock())
    }

    /// Test seam: custom config plus an injected clock (fake-timer analogue).
    pub fn with_config_and_clock(config: CircuitBreakerConfig, clock: Arc<dyn Clock>) -> Self {
        let now = clock.now_ms();
        CircuitBreaker {
            config,
            clock,
            inner: Mutex::new(BreakerState {
                state: CircuitState::Closed,
                failures: Vec::new(),
                last_state_change: now,
                half_open_attempts: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, BreakerState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Gate a request through the breaker. Returns `Ok(true)` when execution
    /// is admitted; **returns `Err(CircuitOpenError)` instead of `false`**
    /// when blocked. Mutates: an elapsed open circuit transitions to
    /// half-open, and admitted half-open probes consume the attempt budget.
    pub fn can_execute(&self) -> Result<bool, CircuitOpenError> {
        let now = self.clock.now_ms();
        let mut state = self.lock();

        if state.state == CircuitState::Open {
            if now - state.last_state_change >= self.config.reset_timeout_ms {
                // transitionToHalfOpen
                state.state = CircuitState::HalfOpen;
                state.last_state_change = now;
                state.half_open_attempts = 0;
            } else {
                return Err(CircuitOpenError::new());
            }
        }

        if state.state == CircuitState::HalfOpen {
            if state.half_open_attempts >= self.config.half_open_max_attempts {
                if now - state.last_state_change >= self.config.reset_timeout_ms {
                    // resetHalfOpenProbeWindow
                    state.last_state_change = now;
                    state.half_open_attempts = 0;
                } else {
                    return Err(CircuitOpenError::with_message("Circuit is half-open"));
                }
            }
            state.half_open_attempts += 1;
            return Ok(true);
        }

        Ok(true)
    }

    /// Pure, non-mutating availability predicate at the current wall time.
    pub fn is_available(&self) -> bool {
        self.is_available_at(self.clock.now_ms())
    }

    /// Pure, non-mutating availability predicate at an explicit `now`
    /// (TS `isAvailable(now = Date.now())`).
    pub fn is_available_at(&self, now: i64) -> bool {
        let state = self.lock();
        match state.state {
            CircuitState::Open => now - state.last_state_change >= self.config.reset_timeout_ms,
            CircuitState::HalfOpen => {
                state.half_open_attempts < self.config.half_open_max_attempts
                    || now - state.last_state_change >= self.config.reset_timeout_ms
            }
            CircuitState::Closed => true,
        }
    }

    /// Half-open ⇒ full reset to closed (clears failures). Closed ⇒ prune
    /// failures outside the window. Open ⇒ no-op.
    pub fn record_success(&self) {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        match state.state {
            CircuitState::HalfOpen => reset_to_closed(&mut state, now),
            CircuitState::Closed => prune_failures(&mut state, self.config.failure_window_ms, now),
            CircuitState::Open => {}
        }
    }

    /// Prune + record a failure timestamp. Half-open ⇒ reopen; closed with
    /// `failures >= threshold` ⇒ open.
    pub fn record_failure(&self) {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        prune_failures(&mut state, self.config.failure_window_ms, now);
        state.failures.push(now);

        if state.state == CircuitState::HalfOpen {
            transition_to_open(&mut state, now);
            return;
        }

        if state.state == CircuitState::Closed
            && state.failures.len() >= self.config.failure_threshold
        {
            transition_to_open(&mut state, now);
        }
    }

    /// Current state.
    pub fn get_state(&self) -> CircuitState {
        self.lock().state
    }

    /// Force-close and clear failures.
    pub fn reset(&self) {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        reset_to_closed(&mut state, now);
    }

    /// Failure count after pruning the sliding window (mutating, like TS).
    pub fn get_failure_count(&self) -> usize {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        prune_failures(&mut state, self.config.failure_window_ms, now);
        state.failures.len()
    }

    /// Remaining wait until an open circuit admits a probe; 0 when not open.
    pub fn get_time_until_reset(&self) -> i64 {
        let now = self.clock.now_ms();
        let state = self.lock();
        if state.state != CircuitState::Open {
            return 0;
        }
        let elapsed = now - state.last_state_change;
        (self.config.reset_timeout_ms - elapsed).max(0)
    }

    /// Remaining wait until the breaker can admit a request at the current
    /// wall time (open, or half-open with an exhausted probe budget).
    pub fn get_time_until_available(&self) -> i64 {
        self.get_time_until_available_at(self.clock.now_ms())
    }

    /// [`Self::get_time_until_available`] at an explicit `now`
    /// (TS `getTimeUntilAvailable(now = Date.now())`).
    pub fn get_time_until_available_at(&self, now: i64) -> i64 {
        let state = self.lock();
        if state.state == CircuitState::Open {
            return (self.config.reset_timeout_ms - (now - state.last_state_change)).max(0);
        }
        if state.state == CircuitState::HalfOpen
            && state.half_open_attempts >= self.config.half_open_max_attempts
        {
            return (self.config.reset_timeout_ms - (now - state.last_state_change)).max(0);
        }
        0
    }
}

fn prune_failures(state: &mut BreakerState, failure_window_ms: i64, now: i64) {
    let cutoff = now - failure_window_ms;
    state.failures.retain(|timestamp| *timestamp >= cutoff);
}

fn transition_to_open(state: &mut BreakerState, now: i64) {
    state.state = CircuitState::Open;
    state.last_state_change = now;
    state.half_open_attempts = 0;
}

fn reset_to_closed(state: &mut BreakerState, now: i64) {
    state.state = CircuitState::Closed;
    state.last_state_change = now;
    state.half_open_attempts = 0;
    state.failures.clear();
}

// ============================================================================
// Bounded global registry
// ============================================================================

const MAX_CIRCUIT_BREAKERS: usize = 100;

/// One registry slot: `(key, breaker)`.
type RegistryEntry = (String, Arc<CircuitBreaker>);

/// Insertion-ordered registry (TS `Map` semantics: re-adding a deleted key
/// appends at the tail). Cap 100 with oldest-created eviction, NOT LRU.
static CIRCUIT_BREAKERS: LazyLock<Mutex<Vec<RegistryEntry>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

fn lock_registry() -> MutexGuard<'static, Vec<RegistryEntry>> {
    CIRCUIT_BREAKERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Get-or-create the breaker for `key`. `config` is only used at creation.
/// On create when the registry holds 100 entries, the FIRST entry (insertion
/// order — oldest-created) is evicted.
pub fn get_circuit_breaker(key: &str, config: Option<CircuitBreakerConfig>) -> Arc<CircuitBreaker> {
    let mut registry = lock_registry();
    if let Some((_, breaker)) = registry.iter().find(|(entry_key, _)| entry_key == key) {
        return breaker.clone();
    }
    if registry.len() >= MAX_CIRCUIT_BREAKERS {
        registry.remove(0);
    }
    let breaker = Arc::new(match config {
        Some(config) => CircuitBreaker::with_config(config),
        None => CircuitBreaker::new(),
    });
    registry.push((key.to_string(), breaker.clone()));
    breaker
}

/// `resetAllCircuitBreakers()` — `.reset()` every registered breaker
/// (instances are kept).
pub fn reset_all_circuit_breakers() {
    let registry = lock_registry();
    for (_, breaker) in registry.iter() {
        breaker.reset();
    }
}

/// `clearCircuitBreakers()` — drop every registered breaker.
pub fn clear_circuit_breakers() {
    lock_registry().clear();
}

/// Remove a single circuit breaker by key. Used when an account is removed so
/// a later re-add of the same identity starts with a fresh (closed) circuit
/// rather than inheriting an open one (accounts-02).
pub fn remove_circuit_breaker(key: &str) {
    lock_registry().retain(|(entry_key, _)| entry_key != key);
}

// ============================================================================
// Tests (ported from test/circuit-breaker.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::clock::ManualClock;
    use serial_test::serial;

    fn breaker_with_clock() -> (CircuitBreaker, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(0));
        let breaker =
            CircuitBreaker::with_config_and_clock(DEFAULT_CIRCUIT_BREAKER_CONFIG, clock.clone());
        (breaker, clock)
    }

    fn trip(breaker: &CircuitBreaker) {
        breaker.record_failure();
        breaker.record_failure();
        breaker.record_failure();
    }

    #[test]
    fn starts_closed_with_default_config() {
        let breaker = CircuitBreaker::new();
        assert_eq!(breaker.get_state(), CircuitState::Closed);
        assert_eq!(DEFAULT_CIRCUIT_BREAKER_CONFIG.failure_threshold, 3);
    }

    #[test]
    fn allows_execution_when_closed() {
        let breaker = CircuitBreaker::new();
        assert_eq!(breaker.can_execute(), Ok(true));
    }

    #[test]
    fn opens_after_threshold_failures_within_window() {
        let (breaker, _clock) = breaker_with_clock();
        trip(&breaker);
        assert_eq!(breaker.get_state(), CircuitState::Open);
    }

    #[test]
    fn does_not_open_if_failures_are_outside_window() {
        let (breaker, clock) = breaker_with_clock();
        breaker.record_failure();
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.failure_window_ms + 1);
        breaker.record_failure();
        breaker.record_failure();
        assert_eq!(breaker.get_state(), CircuitState::Closed);
    }

    #[test]
    fn throws_circuit_open_error_while_open() {
        let (breaker, _clock) = breaker_with_clock();
        trip(&breaker);
        let err = breaker.can_execute().unwrap_err();
        assert_eq!(err.message(), "Circuit is open");
        assert_eq!(err.name(), "CircuitOpenError");
    }

    #[test]
    fn transitions_to_half_open_after_reset_timeout() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert_eq!(breaker.can_execute(), Ok(true));
        assert_eq!(breaker.get_state(), CircuitState::HalfOpen);
    }

    #[test]
    fn allows_a_single_trial_request_in_half_open() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert_eq!(breaker.can_execute(), Ok(true));
        let err = breaker.can_execute().unwrap_err();
        assert_eq!(err.message(), "Circuit is half-open");
    }

    #[test]
    fn closes_on_success_from_half_open() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        breaker.can_execute().unwrap();
        breaker.record_success();
        assert_eq!(breaker.get_state(), CircuitState::Closed);
        assert_eq!(breaker.can_execute(), Ok(true));
    }

    #[test]
    fn reopens_on_failure_from_half_open() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        breaker.can_execute().unwrap();
        breaker.record_failure();
        assert_eq!(breaker.get_state(), CircuitState::Open);
        assert!(breaker.can_execute().is_err());
    }

    #[test]
    fn reset_returns_to_closed_and_clears_failures() {
        let (breaker, _clock) = breaker_with_clock();
        breaker.record_failure();
        breaker.record_failure();
        breaker.reset();
        assert_eq!(breaker.get_state(), CircuitState::Closed);
        assert_eq!(breaker.can_execute(), Ok(true));
    }

    #[test]
    fn prunes_failures_on_success_in_closed_state() {
        let (breaker, clock) = breaker_with_clock();
        breaker.record_failure();
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.failure_window_ms + 1);
        breaker.record_success();
        breaker.record_failure();
        breaker.record_failure();
        assert_eq!(breaker.get_state(), CircuitState::Closed);
    }

    #[test]
    fn half_open_max_attempts_can_be_customized() {
        let clock = Arc::new(ManualClock::new(0));
        let breaker = CircuitBreaker::with_config_and_clock(
            CircuitBreakerConfig {
                half_open_max_attempts: 2,
                ..CircuitBreakerConfig::default()
            },
            clock.clone(),
        );
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert_eq!(breaker.can_execute(), Ok(true));
        assert_eq!(breaker.can_execute(), Ok(true));
        assert!(breaker.can_execute().is_err());
    }

    #[test]
    fn uses_failure_window_threshold_boundary() {
        let (breaker, clock) = breaker_with_clock();
        breaker.record_failure();
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.failure_window_ms - 1);
        breaker.record_failure();
        breaker.record_failure();
        assert_eq!(breaker.get_state(), CircuitState::Open);
    }

    #[test]
    fn get_failure_count_returns_pruned_failure_count() {
        let (breaker, clock) = breaker_with_clock();
        breaker.record_failure();
        breaker.record_failure();
        assert_eq!(breaker.get_failure_count(), 2);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.failure_window_ms + 1);
        assert_eq!(breaker.get_failure_count(), 0);
    }

    #[test]
    fn get_time_until_reset_zero_when_not_open() {
        let (breaker, _clock) = breaker_with_clock();
        assert_eq!(breaker.get_time_until_reset(), 0);
        breaker.record_failure();
        assert_eq!(breaker.get_time_until_reset(), 0);
    }

    #[test]
    fn get_time_until_reset_returns_remaining_time_when_open() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        assert_eq!(breaker.get_state(), CircuitState::Open);
        clock.set(10_000);
        assert_eq!(
            breaker.get_time_until_reset(),
            DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms - 10_000
        );
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1000);
        assert_eq!(breaker.get_time_until_reset(), 0);
    }

    #[test]
    fn get_time_until_available_while_half_open_probe_slot_exhausted() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert_eq!(breaker.can_execute(), Ok(true));
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1001);

        assert_eq!(breaker.get_state(), CircuitState::HalfOpen);
        assert_eq!(
            breaker.get_time_until_available(),
            DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms - 1000
        );
    }

    #[test]
    fn get_time_until_available_stays_zero_with_probe_capacity() {
        let clock = Arc::new(ManualClock::new(0));
        let breaker = CircuitBreaker::with_config_and_clock(
            CircuitBreakerConfig {
                half_open_max_attempts: 2,
                ..CircuitBreakerConfig::default()
            },
            clock.clone(),
        );
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert_eq!(breaker.can_execute(), Ok(true));
        assert_eq!(breaker.get_state(), CircuitState::HalfOpen);
        assert_eq!(breaker.get_time_until_available(), 0);
    }

    #[test]
    fn is_available_false_while_open_true_after_reset_timeout() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        assert!(!breaker.is_available());
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert!(breaker.is_available());
    }

    #[test]
    fn is_available_becomes_false_when_half_open_attempts_exhausted() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert!(breaker.is_available());
        breaker.can_execute().unwrap();
        assert!(!breaker.is_available());
    }

    #[test]
    fn is_available_does_not_mutate_state() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        // The pure predicate must NOT perform the open→half-open transition.
        assert!(breaker.is_available());
        assert_eq!(breaker.get_state(), CircuitState::Open);
    }

    #[test]
    fn allows_a_new_half_open_probe_after_the_exhausted_wait_window() {
        let (breaker, clock) = breaker_with_clock();
        trip(&breaker);
        clock.set(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms + 1);
        assert_eq!(breaker.can_execute(), Ok(true));

        clock.advance(DEFAULT_CIRCUIT_BREAKER_CONFIG.reset_timeout_ms);

        assert!(breaker.is_available());
        assert_eq!(breaker.get_time_until_available(), 0);
        assert_eq!(breaker.can_execute(), Ok(true));
    }

    // ---------------- registry ----------------

    #[test]
    #[serial(circuit_registry)]
    fn registry_returns_singleton_per_key() {
        clear_circuit_breakers();
        let first = get_circuit_breaker("alpha", None);
        let second = get_circuit_breaker("alpha", None);
        assert!(Arc::ptr_eq(&first, &second));

        let other = get_circuit_breaker("beta", None);
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[test]
    #[serial(circuit_registry)]
    fn registry_evicts_oldest_entry_when_max_exceeded() {
        clear_circuit_breakers();
        for i in 0..100 {
            get_circuit_breaker(&format!("key-{i}"), None);
        }
        let first_breaker = get_circuit_breaker("key-0", None);
        get_circuit_breaker("new-key-101", None);
        let refetched_first = get_circuit_breaker("key-0", None);
        assert!(!Arc::ptr_eq(&refetched_first, &first_breaker));
    }

    #[test]
    #[serial(circuit_registry)]
    fn registry_reset_all_resets_breakers_to_closed() {
        clear_circuit_breakers();
        let breaker1 = get_circuit_breaker("reset-test-1", None);
        let breaker2 = get_circuit_breaker("reset-test-2", None);
        trip(&breaker1);
        trip(&breaker2);
        assert_eq!(breaker1.get_state(), CircuitState::Open);
        assert_eq!(breaker2.get_state(), CircuitState::Open);
        reset_all_circuit_breakers();
        assert_eq!(breaker1.get_state(), CircuitState::Closed);
        assert_eq!(breaker2.get_state(), CircuitState::Closed);
    }

    #[test]
    #[serial(circuit_registry)]
    fn registry_clear_removes_all_breakers() {
        clear_circuit_breakers();
        let breaker = get_circuit_breaker("clear-test", None);
        breaker.record_failure();
        clear_circuit_breakers();
        let new_breaker = get_circuit_breaker("clear-test", None);
        assert_eq!(new_breaker.get_failure_count(), 0);
        clear_circuit_breakers();
    }

    #[test]
    #[serial(circuit_registry)]
    fn registry_remove_gives_a_fresh_closed_circuit_on_re_add() {
        clear_circuit_breakers();
        let breaker = get_circuit_breaker("remove-test", None);
        trip(&breaker);
        assert_eq!(breaker.get_state(), CircuitState::Open);
        remove_circuit_breaker("remove-test");
        let fresh = get_circuit_breaker("remove-test", None);
        assert!(!Arc::ptr_eq(&fresh, &breaker));
        assert_eq!(fresh.get_state(), CircuitState::Closed);
        clear_circuit_breakers();
    }
}
