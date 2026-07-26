//! cma-bin — shared plumbing for the five published binaries (ARCHITECTURE
//! §2 / §6.16).
//!
//! Every `src/bin/*.rs` main stays thin: it hands an async entry closure to
//! [`run_main`], which installs the panic hook, builds the multi-thread tokio
//! runtime, drives the future to completion, and terminates the process with
//! `std::process::exit(code)` — mirroring the Node bins' `process.exitCode`
//! convention (ARCHITECTURE §5.4).
//!
//! This crate is also the ONLY place allowed to bridge `cma-wrapper` and
//! `cma-manager` (they must not depend on each other, §4), so the two glue
//! seams the wrapper deliberately leaves open live here:
//! [`ManagerBackedLatestVersionFetch`] (npm update-notice fetch) and
//! [`auto_sync_manager_active_selection_if_enabled`] (TS
//! `autoSyncManagerActiveSelectionIfEnabled` in `scripts/codex.js`).

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;

/// Exit code when the CLI future panics (Node parity: an uncaught exception
/// terminates the process with a non-zero code; we normalize to 1).
pub const PANIC_EXIT_CODE: i32 = 1;

/// The CLI version string (TS `resolveCliVersion()` reads `package.json`;
/// here the crate version is the package version). Never empty.
pub fn cli_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Install the CLI panic hook: with `CODEX_MULTI_AUTH_DEBUG=1` keep the full
/// default report (backtrace pointer included); otherwise print one concise
/// stderr line so a crash never dumps an internal trace at users.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let debug = std::env::var("CODEX_MULTI_AUTH_DEBUG")
            .unwrap_or_default()
            .trim()
            == "1";
        if debug {
            default_hook(info);
            return;
        }
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unexpected internal error".to_string());
        eprintln!("codex-multi-auth: fatal error: {message}");
    }));
}

/// Thin-main driver: panic hook + multi-thread tokio runtime + exit-code
/// convention. `entry` receives `argv[1..]` (the bin-name is dropped, like
/// `process.argv.slice(2)`).
///
/// Background tasks spawned by the entry (detached children, unref'd loops)
/// are NOT awaited — the runtime is shut down without draining, matching the
/// Node bins, which exit as soon as the main promise settles.
pub fn run_main<F, Fut>(entry: F) -> !
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: Future<Output = i32>,
{
    install_panic_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("codex-multi-auth: failed to start async runtime: {error}");
            std::process::exit(PANIC_EXIT_CODE);
        }
    };
    let code = std::panic::catch_unwind(AssertUnwindSafe(|| runtime.block_on(entry(args))))
        .unwrap_or(PANIC_EXIT_CODE);
    runtime.shutdown_background();
    std::process::exit(code);
}

/// Production [`cma_wrapper::update_check::LatestVersionFetch`]: the wrapper
/// crate has no HTTP client by design, so the bin wires its startup update
/// notice to the manager's reqwest-backed, 24h-cached npm lookup
/// (`cma_manager::update_notice::check_for_updates`). `force=false` keeps the
/// two modules' shared `update-check-cache.json` reads/writes coherent — the
/// wrapper only invokes this fetcher when that cache is already stale.
pub struct ManagerBackedLatestVersionFetch;

impl cma_wrapper::update_check::LatestVersionFetch for ManagerBackedLatestVersionFetch {
    fn fetch_latest_version(
        &self,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        Box::pin(async move {
            cma_manager::update_notice::check_for_updates(false, Some(timeout_ms))
                .await
                .latest_version
        })
    }
}

/// TS `autoSyncManagerActiveSelectionIfEnabled()` (`scripts/codex.js`):
/// gated on `CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP` (default on; only a
/// trimmed `"0"` disables), then best-effort — a sync failure never blocks
/// the official Codex launch.
pub async fn auto_sync_manager_active_selection_if_enabled() {
    let enabled = std::env::var("CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP")
        .unwrap_or_else(|_| "1".to_string())
        .trim()
        != "0";
    if !enabled {
        return;
    }
    let _ = cma_manager::dispatcher::auto_sync_active_account_to_codex().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_version_is_the_crate_version_and_non_empty() {
        assert_eq!(cli_version(), env!("CARGO_PKG_VERSION"));
        assert!(!cli_version().trim().is_empty());
    }
}
