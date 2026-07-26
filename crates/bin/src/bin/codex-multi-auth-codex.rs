//! `codex-multi-auth-codex` — the codex wrapper bin (TS `scripts/codex.js`
//! `main()`): auth-family args run the local manager; everything else
//! forwards to the official `@openai/codex` via `cma_wrapper::forward`.

use cma_wrapper::forward::{self, WrapperDispatch};

fn main() {
    cma_bin::run_main(|raw_args| async move {
        match forward::classify_wrapper_args(&raw_args) {
            // Internal detached app-helper child (`--codex-multi-auth-runtime-app-helper`).
            WrapperDispatch::RunAppHelper => forward::run_runtime_rotation_app_helper().await,
            // Auth-family (incl. `codex multi auth|multi-auth|multiauth` aliases,
            // unless CODEX_MULTI_AUTH_BYPASS=1): run the local account manager.
            // The startup update notice is a deliberate no-op on this path
            // (TS `shouldRunStartupUpdateNotice` returns false for it).
            WrapperDispatch::AuthManager { normalized_args } => {
                let code = cma_manager::dispatcher::run_codex_multi_auth_cli(&normalized_args).await;
                forward::maybe_install_codex_app_launcher_after_rotation_enable(
                    &normalized_args,
                    code,
                )
                .await;
                code
            }
            // Forward to the official Codex CLI. `forward()` owns bin
            // resolution, `--account` preflight, statusline, quota refresh,
            // and observability; the bin owns the update notice and the
            // auto-sync sandwich (both need cma-manager, which the wrapper
            // crate must not depend on).
            WrapperDispatch::Forward { raw_args } => {
                let normalized_args = cma_wrapper::routing::normalize_auth_alias(&raw_args);
                cma_wrapper::update_check::show_update_notice_if_available(
                    &raw_args,
                    &normalized_args,
                    Some(&cma_bin::ManagerBackedLatestVersionFetch),
                )
                .await;
                // TS runs the pre-sync after codex-bin/--account preflight;
                // running it just before forward() is the closest seam the
                // thin main has (an extra best-effort mirror write when the
                // launch would fail is harmless).
                cma_bin::auto_sync_manager_active_selection_if_enabled().await;
                let code = forward::forward(&raw_args).await;
                // TS `finally` branch: re-sync after the forwarded run.
                cma_bin::auto_sync_manager_active_selection_if_enabled().await;
                code
            }
        }
    });
}
