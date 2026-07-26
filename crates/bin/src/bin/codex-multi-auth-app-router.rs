//! `codex-multi-auth-app-router` — the detached app-bind router process
//! (replaces `scripts/codex-app-router.js`, ARCHITECTURE R3): starts the
//! rotation proxy, writes `app-bind/runtime-rotation-app-bind-status.json`,
//! and idle-exits via `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS`.

fn main() {
    cma_bin::run_main(|args| async move { cma_proxy::router::run(&args).await });
}
