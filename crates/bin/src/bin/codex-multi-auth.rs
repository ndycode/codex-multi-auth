//! `codex-multi-auth` — the account-manager CLI (TS `scripts/codex-multi-auth.js`).
//!
//! Bare subcommands (`status`, `login`, …) normalize through the `auth`
//! prefix rule INSIDE `run_codex_multi_auth_cli` (spec 08 §2), so this main
//! only handles the standalone `--version`/`-v` short-circuit (which the TS
//! bin script answered itself, before loading the manager).

fn main() {
    cma_bin::run_main(|args| async move {
        let first = args.first().map(String::as_str).unwrap_or("");
        if args.len() == 1 && (first == "--version" || first == "-v") {
            // TS: prints the package version, exit 0 (the "version
            // unavailable" branch is unreachable here — the crate version is
            // compiled in).
            println!("{}", cma_bin::cli_version());
            return 0;
        }
        cma_manager::dispatcher::run_codex_multi_auth_cli(&args).await
    });
}
