//! Integration tests for the `--account` force-pin (#623) against a real
//! on-disk accounts pool — ports the disk-backed assertions of
//! `test/codex-bin-wrapper.test.ts` (§ "--account" cases) that the in-file
//! unit tests cover only in pure form.

use serial_test::serial;

use cma_testkit::sandbox::EnvSandbox;
use cma_wrapper::account_force::{
    apply_forced_account_selection, resolve_forced_account_index, ForcedAccountOutcome,
};

fn v(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

fn write_pool(sandbox: &EnvSandbox) {
    let dir = sandbox.codex_multi_auth_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let storage = serde_json::json!({
        "version": 3,
        "activeIndex": 0,
        "accounts": [
            { "accountId": "acc_1", "email": "account-1@example.com",
              "refreshToken": "r1", "addedAt": 1, "lastUsed": 1 },
            { "accountId": "acc_2", "email": "account-2@example.com",
              "refreshToken": "r2", "addedAt": 2, "lastUsed": 2 },
            { "accountId": "acc_3", "email": "account-3@example.com",
              "refreshToken": "r3", "addedAt": 3, "lastUsed": 3 }
        ]
    });
    std::fs::write(
        dir.join("openai-codex-accounts.json"),
        serde_json::to_string_pretty(&storage).unwrap(),
    )
    .unwrap();
}

#[test]
#[serial(env)]
fn resolves_selectors_against_the_scoped_pool_on_disk() {
    let sandbox = EnvSandbox::new();
    write_pool(&sandbox);
    // ALL-DIGIT = 1-based index, always.
    assert_eq!(resolve_forced_account_index("2").unwrap(), 1);
    // Email + account id (case-insensitive).
    assert_eq!(
        resolve_forced_account_index("ACCOUNT-2@EXAMPLE.COM").unwrap(),
        1
    );
    assert_eq!(resolve_forced_account_index("acc_3").unwrap(), 2);
    // Out of range lists the pool.
    let err = resolve_forced_account_index("99").unwrap_err();
    assert!(err.contains("--account 99 is out of range (have 3 accounts)"));
    assert!(err.contains("  2. account-2@example.com"));
    drop(sandbox);
}

/// TS `String.prototype.toLowerCase` parity: `--account` selectors match
/// ids/emails with FULL Unicode lowercasing, not ASCII-only — `--account`
/// never falls back, so an ASCII-only mismatch would fail the run hard.
#[test]
#[serial(env)]
fn unicode_selectors_match_case_insensitively_in_both_directions() {
    let sandbox = EnvSandbox::new();
    let dir = sandbox.codex_multi_auth_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let storage = serde_json::json!({
        "version": 3,
        "activeIndex": 0,
        "accounts": [
            { "accountId": "acc_1", "email": "ä@example.com",
              "refreshToken": "r1", "addedAt": 1, "lastUsed": 1 },
            { "accountId": "acc_2", "email": "Ö@EXAMPLE.COM",
              "refreshToken": "r2", "addedAt": 2, "lastUsed": 2 }
        ]
    });
    std::fs::write(
        dir.join("openai-codex-accounts.json"),
        serde_json::to_string_pretty(&storage).unwrap(),
    )
    .unwrap();
    // Upper-case selector vs lower-case stored email…
    assert_eq!(resolve_forced_account_index("Ä@EXAMPLE.COM").unwrap(), 0);
    // …and the reverse (lower-case selector vs upper-case stored email).
    assert_eq!(resolve_forced_account_index("ö@example.com").unwrap(), 1);
    drop(sandbox);
}

#[test]
#[serial(env)]
fn empty_pool_fails_with_login_hint() {
    let sandbox = EnvSandbox::new();
    // No accounts file at all.
    let err = resolve_forced_account_index("1").unwrap_err();
    assert_eq!(
        err,
        "codex-multi-auth: --account was set but no Codex accounts are configured. Run `codex-multi-auth login` first."
    );
    drop(sandbox);
}

#[tokio::test]
#[serial(env)]
async fn flag_wins_over_env_selector_and_publishes_zero_based_index() {
    let mut sandbox = EnvSandbox::new();
    write_pool(&sandbox);
    sandbox.set_var("CODEX_MULTI_AUTH_FORCE_ACCOUNT", "3");
    // Flag `--account 1` (index 0) wins over env `…FORCE_ACCOUNT=3` (index 2).
    let outcome = apply_forced_account_selection(
        &v(&["exec", "--account", "1", "status"]),
        async |_args: &[String]| true,
    )
    .await;
    match outcome {
        ForcedAccountOutcome::Forward {
            forward_args,
            forced_index,
        } => {
            assert_eq!(forward_args, v(&["exec", "status"]));
            assert_eq!(forced_index, Some(0));
        }
        other => panic!("expected Forward, got {other:?}"),
    }
    drop(sandbox);
}

#[tokio::test]
#[serial(env)]
async fn env_selector_used_when_flag_absent() {
    let mut sandbox = EnvSandbox::new();
    write_pool(&sandbox);
    sandbox.set_var("CODEX_MULTI_AUTH_FORCE_ACCOUNT", "account-2@example.com");
    let outcome =
        apply_forced_account_selection(&v(&["exec", "status"]), async |_args: &[String]| true)
            .await;
    match outcome {
        ForcedAccountOutcome::Forward {
            forward_args,
            forced_index,
        } => {
            assert_eq!(forward_args, v(&["exec", "status"]));
            assert_eq!(forced_index, Some(1));
        }
        other => panic!("expected Forward, got {other:?}"),
    }
    drop(sandbox);
}

#[tokio::test]
#[serial(env)]
async fn fails_hard_before_spawn_when_proxy_inactive() {
    let mut sandbox = EnvSandbox::new();
    write_pool(&sandbox);
    sandbox.set_var("CODEX_MULTI_AUTH_BYPASS", "1");
    // The proxy gate is evaluated by the caller-provided closure (forward.rs
    // wires is_runtime_rotation_proxy_enabled, which returns false under
    // BYPASS); mirror that wiring here.
    let outcome = apply_forced_account_selection(
        &v(&["exec", "--account", "1"]),
        async |args: &[String]| cma_wrapper::forward::is_runtime_rotation_proxy_enabled(args).await,
    )
    .await;
    match outcome {
        ForcedAccountOutcome::Error(message) => {
            assert!(message.contains("--account requires the runtime rotation proxy"));
        }
        other => panic!("expected Error, got {other:?}"),
    }
    drop(sandbox);
}

#[tokio::test]
#[serial(env)]
async fn no_selector_returns_no_pin() {
    let sandbox = EnvSandbox::new();
    write_pool(&sandbox);
    let outcome =
        apply_forced_account_selection(&v(&["exec"]), async |_args: &[String]| true).await;
    assert_eq!(
        outcome,
        ForcedAccountOutcome::Forward {
            forward_args: v(&["exec"]),
            forced_index: None
        }
    );
    drop(sandbox);
}
