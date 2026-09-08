//! `codex-multi-auth-app-launcher` — Codex app shortcut routing (TS
//! `scripts/codex-app-launcher.js`): Windows `.lnk` retarget / macOS app /
//! Linux `.desktop`, with `--remove` and `--dry-run`.

fn main() {
    cma_bin::run_main(|args| async move { cma_runtime::app_launcher::run(&args).await });
}
