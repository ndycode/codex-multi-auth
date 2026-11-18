//! `codex-multi-auth-codex` — the codex wrapper bin (TS `scripts/codex.js`
//! `main()`): auth-family args run the local manager; everything else
//! forwards to the official `@openai/codex` via `cma_wrapper::forward`.
//!
//! R-deviation (deliberate, not a silent drop): TS `main()` calls
//! `ensureWindowsShellShimGuards()` on every invocation — an OPT-IN win32
//! self-heal that, under `CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD` /
//! `CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD` (both default OFF), rewrites
//! `codex.bat/.cmd/.ps1` shims in the npm global bin dir and upserts a
//! PowerShell-profile `codex` function so `codex` keeps resolving to the
//! wrapper after an official-codex npm install clobbers the shims. The Rust
//! bin does NOT port it: the TS shim contents are npm/node_modules-specific
//! (they exec `node scripts/codex.js`), and what a repaired shim should
//! invoke under the native-binary distribution model is an open product
//! decision. Until that decision lands, the two env vars are silent no-ops
//! here; revisit `scripts/codex.js ensureWindowsShellShimGuards` +
//! `test/codex-bin-wrapper.test.ts` when porting.

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
