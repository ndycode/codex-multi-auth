//! Injectable clock seam (new in the Rust port; ARCHITECTURE §6.1 / §8.5).
//!
//! `now_ms()` here and everywhere = WALL clock, exactly where the TS used
//! `Date.now()` (cooldowns, rate-limit windows, persistence timestamps).
//! `std::time::Instant` is allowed only for `performance.now()` analogues
//! (logger timers) — never for anything persisted or compared to epoch ms.
//!
//! The [`Clock`] trait exists ONLY where specs demand an injectable `now`
//! (forecast, preemptive scheduler, rotation trackers). Spec 10 gotcha:
//! `apply_monotonic_auth_cooldown` compares REAL wall-clock values — injected
//! test clocks must never leak into those comparisons; call sites there use
//! [`SystemClock`] / [`now_ms`] directly, not an injected `&dyn Clock`.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

/// Wall-clock time source, in milliseconds since the Unix epoch.
pub trait Clock: Send + Sync {
    /// Current wall-clock time in epoch milliseconds.
    fn now_ms(&self) -> i64;
}

/// The real wall clock (`Date.now()` equivalent).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        crate::utils::now_ms()
    }
}

/// Current wall-clock time in epoch milliseconds (free-function convenience;
/// identical to [`crate::utils::now_ms`]).
pub fn now_ms() -> i64 {
    crate::utils::now_ms()
}

/// Shared handle to the real wall clock, for call sites that take
/// `Arc<dyn Clock>`.
pub fn system_clock() -> Arc<dyn Clock> {
    Arc::new(SystemClock)
}

/// Manually-driven clock for tests (the Rust analogue of the TS fake-timer
/// seams). Thread-safe; can be shared across tasks via `Arc`.
#[derive(Debug, Default)]
pub struct ManualClock {
    now: AtomicI64,
}

impl ManualClock {
    /// Creates a manual clock pinned at `start_ms`.
    pub fn new(start_ms: i64) -> Self {
        ManualClock {
            now: AtomicI64::new(start_ms),
        }
    }

    /// Pins the clock to an absolute epoch-ms value.
    pub fn set(&self, now_ms: i64) {
        self.now.store(now_ms, Ordering::SeqCst);
    }

    /// Advances the clock by `delta_ms` (may be negative).
    pub fn advance(&self, delta_ms: i64) {
        self.now.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_tracks_wall_clock() {
        let clock = SystemClock;
        let before = crate::utils::now_ms();
        let sampled = clock.now_ms();
        let after = crate::utils::now_ms();
        assert!(before <= sampled && sampled <= after);
        assert!(now_ms() >= before);
    }

    #[test]
    fn system_clock_arc_is_usable_as_dyn_clock() {
        let clock = system_clock();
        assert!(clock.now_ms() > 1_577_836_800_000);
    }

    #[test]
    fn manual_clock_set_and_advance() {
        let clock = ManualClock::new(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance(500);
        assert_eq!(clock.now_ms(), 1_500);
        clock.advance(-250);
        assert_eq!(clock.now_ms(), 1_250);
        clock.set(42);
        assert_eq!(clock.now_ms(), 42);
    }
}
