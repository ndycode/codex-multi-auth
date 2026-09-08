//! Port of `lib/codex-manager/commands/check.ts` — `check` always runs a
//! live-probe health check and always exits 0. Args are ignored entirely
//! (spec 08 gotcha 24).

use std::future::Future;

use crate::dispatcher::CliOut;

/// Seam mirroring TS `runCheckCommand({ runHealthCheck })` — the injected
/// health check always receives `liveProbe: true` and the command always
/// returns 0.
pub async fn run_check_command_via<F, Fut>(run_health_check: F) -> i32
where
    F: FnOnce(bool) -> Fut,
    Fut: Future<Output = ()>,
{
    run_health_check(true).await;
    0
}

/// Production entry: delegates to the real health-check engine.
pub async fn run_check_command(args: &[String], out: &mut CliOut) -> i32 {
    let _ = (args, &out); // args are ignored entirely (TS parity)
    run_check_command_via(crate::health_check::run_health_check).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    // Port of test/codex-manager-check-command.test.ts: runHealthCheck is
    // invoked with liveProbe=true and the exit code is 0.
    #[tokio::test]
    async fn always_live_probes_and_returns_zero() {
        let called_live = AtomicBool::new(false);
        let code = run_check_command_via(|live_probe| {
            called_live.store(live_probe, Ordering::SeqCst);
            async {}
        })
        .await;
        assert_eq!(code, 0);
        assert!(called_live.load(Ordering::SeqCst));
    }
}
