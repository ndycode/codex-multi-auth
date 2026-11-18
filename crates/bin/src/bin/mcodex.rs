//! `mcodex` — convenience launcher over the codex wrapper (TS
//! `scripts/mcodex.js`): default forward; `--monitor` (watch); `--tmux`/`-t`
//! (+ `--live-accounts`). Missing-tool fallbacks per spec 14 §2.1 / R8.

fn main() {
    cma_bin::run_main(|args| async move { cma_wrapper::mcodex::run_mcodex(&args).await });
}
