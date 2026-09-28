//! Docs-parity suite — the `test/documentation.test.ts` analogue (spec 14
//! §2 / §9.5, ARCHITECTURE §9.5).
//!
//! Docs under `docs/reference/*` are TESTED TRUTH: this suite fails when the
//! CLI surface drifts from them. It asserts three contract families:
//!
//! 1. the command registry (`ACCOUNT_MANAGER_COMMANDS`) vs
//!    `docs/reference/commands.md`;
//! 2. the `--json` anchor list (Common Flags row + JSON Mode Contract +
//!    additive surfaces) vs the frozen anchor set from spec 14 §2.4;
//! 3. the stable error-code tables (proxy `error.code` values, canonical
//!    usage-error strings, frozen refresh-failure message) vs
//!    `docs/reference/error-contracts.md` AND the compiled implementation.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cma_manager::dispatcher::{CliOut, run_codex_multi_auth_cli_with};
use cma_manager::help::print_usage;
use cma_manager::registry::ACCOUNT_MANAGER_COMMANDS;
use cma_testkit::sandbox::EnvSandbox;
use serial_test::serial;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/bin sits two levels below the repo root")
        .to_path_buf()
}

fn read_doc(relative: &str) -> String {
    let path = repo_root().join(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

fn usage_text() -> String {
    let mut out = CliOut::capture();
    print_usage(&mut out);
    out.info_text()
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

/// The documentation-test `--json` anchor list (spec 14 §2.4; frozen order —
/// it must match the Common Flags row in commands.md cell-for-cell).
const JSON_ANCHOR_COMMANDS: [&str; 16] = [
    "verify-flagged",
    "verify",
    "why-selected",
    "best",
    "forecast",
    "report",
    "usage",
    "budget",
    "models",
    "monitor",
    "integrations",
    "fix",
    "doctor",
    "config explain",
    "debug bundle",
    "history",
];

/// Additive `--json` surfaces documented outside the compact Common Flags row.
const ADDITIVE_JSON_SURFACES: [&str; 4] = [
    "uninstall --json",
    "rotation reset-rate-limits --json",
    "rotation reset-runtime --json",
    "account policy list --json",
];

/// The six stable runtime-rotation-proxy error codes and their documented
/// HTTP statuses (spec 14 §7 table).
const PROXY_ERROR_CODES: [(&str, &str); 6] = [
    ("runtime_rotation_proxy_not_found", "`404`"),
    ("runtime_rotation_proxy_unauthorized", "`401`"),
    ("runtime_rotation_proxy_payload_too_large", "`413`"),
    ("codex_runtime_rotation_pool_exhausted", "`429` or `503`"),
    ("codex_pinned_account_unavailable", "`503`"),
    ("codex_runtime_rotation_proxy_error", "`500`"),
];

// ---------------------------------------------------------------------------
// 1. Command registry vs commands.md
// ---------------------------------------------------------------------------

#[test]
fn registry_matches_ts_source_and_every_command_is_documented() {
    // Spec 14 §2 header says "28 commands"; the ported TS source
    // (`account-manager-commands.ts`, the authority) enumerates 29 —
    // the registry is ported verbatim (see cma-manager::registry).
    assert_eq!(ACCOUNT_MANAGER_COMMANDS.len(), 29);

    let commands_md = read_doc("docs/reference/commands.md");
    for command in ACCOUNT_MANAGER_COMMANDS {
        assert!(
            commands_md.contains(&format!("codex-multi-auth {command}")),
            "docs/reference/commands.md does not document `codex-multi-auth {command}`"
        );
    }
}

#[test]
fn usage_text_covers_every_registry_command() {
    let usage = usage_text();
    for command in ACCOUNT_MANAGER_COMMANDS {
        // The usage text may list a command as an alternation of a sibling
        // (ported verbatim from TS help.ts, e.g.
        // `codex-multi-auth config template|init-config …`).
        assert!(
            usage.contains(&format!("codex-multi-auth {command}"))
                || usage.contains(&format!("|{command}")),
            "CLI usage text does not mention `codex-multi-auth {command}`"
        );
    }
}

/// The exact usage lines documentation.test.ts pinned against the CLI help.
#[test]
fn usage_text_contains_documentation_test_pins() {
    let usage = usage_text();
    for pin in [
        "codex-multi-auth fix [--dry-run|-n] [--json] [--live] [--model <model>]",
        "codex-multi-auth report [--live] [--json] [--explain] [--model <model>] [--max-accounts <n>] [--max-probes <n>] [--cached-only] [--out <path>]",
        "codex-multi-auth config explain [--json]",
        "codex-multi-auth debug bundle [--json]",
        "codex-multi-auth why-selected [--now|-n | --last|-l] [--json]",
    ] {
        assert!(usage.contains(pin), "usage text lost the pinned line: {pin}");
    }
}

// ---------------------------------------------------------------------------
// 2. `--json` anchors
// ---------------------------------------------------------------------------

#[test]
fn common_flags_json_row_matches_frozen_anchor_list() {
    let commands_md = read_doc("docs/reference/commands.md");
    let row = commands_md
        .lines()
        .find(|line| line.trim_start().starts_with("| `--json` |"))
        .expect("commands.md Common Flags table has a `--json` row");
    let cells: Vec<&str> = row.split('|').map(str::trim).collect();
    // ["", "`--json`", "<families>", "<description>", ""]
    let listed: Vec<&str> = cells[2].split(',').map(str::trim).collect();
    assert_eq!(
        listed,
        JSON_ANCHOR_COMMANDS.to_vec(),
        "Common Flags `--json` row drifted from the frozen anchor list"
    );
}

#[test]
fn json_mode_contract_lists_every_anchor_and_additive_surface() {
    let error_contracts = read_doc("docs/reference/error-contracts.md");
    let section_start = error_contracts
        .find("## JSON Mode Contract")
        .expect("error-contracts.md has a JSON Mode Contract section");
    let section_end = error_contracts[section_start..]
        .find("\n---")
        .map(|offset| section_start + offset)
        .unwrap_or(error_contracts.len());
    let section = &error_contracts[section_start..section_end];

    for command in JSON_ANCHOR_COMMANDS {
        assert!(
            section.contains(&format!("`{command}`")),
            "JSON Mode Contract omits anchor `{command}`"
        );
    }
    for surface in ADDITIVE_JSON_SURFACES {
        assert!(
            section.contains(&format!("`codex-multi-auth {surface}`")),
            "JSON Mode Contract omits additive surface `codex-multi-auth {surface}`"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. Stable error-code tables
// ---------------------------------------------------------------------------

#[test]
fn proxy_error_code_table_documents_all_six_stable_codes() {
    let error_contracts = read_doc("docs/reference/error-contracts.md");
    for (code, status) in PROXY_ERROR_CODES {
        let row = error_contracts
            .lines()
            .find(|line| line.starts_with("| `") && line.contains(&format!("`{code}`")))
            .unwrap_or_else(|| panic!("no proxy error table row for `{code}`"));
        assert!(
            row.contains(status),
            "proxy error row for `{code}` no longer documents HTTP {status}: {row}"
        );
    }
    // Pinned-unavailable structured skip reasons are a contract (issue #486).
    for reason in [
        "rate-limited",
        "cooling-down:auth-failure",
        "circuit-open",
        "disabled",
        "workspace-disabled",
        "policy-blocked",
        "missing",
        "already-attempted",
    ] {
        assert!(
            error_contracts.contains(&format!("`{reason}`")),
            "documented pinned-unavailable skip reason `{reason}` is missing"
        );
    }
    assert!(error_contracts.contains("`pinnedAccountIndex`"));
    assert!(error_contracts.contains("`account_skip_reasons`"));
}

/// Docs ↔ implementation: the pool-exhausted payload the proxy actually
/// builds carries the documented code, `reason`, `retry_after_ms`, and the
/// `rotation status` hint (compact JSON, key order frozen by preserve_order).
#[test]
fn pool_exhausted_body_matches_documented_contract() {
    let skip: HashMap<i64, String> = HashMap::from([(0, "rate-limited".to_string())]);
    let body = cma_proxy::retry_loop::build_pool_exhausted_body("rate-limit", 12_345, &skip, 2);
    assert!(body.contains("\"code\":\"codex_runtime_rotation_pool_exhausted\""));
    assert!(body.contains("\"reason\":\"rate-limit\""));
    assert!(body.contains("\"retry_after_ms\":12345"));
    assert!(body.contains("\"account_skip_reasons\":{\"0\":\"rate-limited\"}"));
    // Docs: "includes ... a hint to run `codex-multi-auth rotation status`".
    assert!(body.contains("codex-multi-auth rotation status"));
}

/// The frozen refresh-failure message is identical in the compiled constants
/// and in error-contracts.md (spec 14 §8 frozen-string table).
#[test]
fn frozen_refresh_failure_message_matches_docs_and_constants() {
    const FROZEN: &str = "Failed to refresh token, authentication required";
    assert_eq!(cma_core::constants::ERROR_MESSAGES.token_refresh_failed, FROZEN);
    assert!(read_doc("docs/reference/error-contracts.md").contains(FROZEN));
}

/// Canonical usage-error strings: error-contracts.md documents them, and the
/// live dispatcher emits exactly those strings with exit code 1.
#[tokio::test(flavor = "multi_thread")]
#[serial(env)]
async fn canonical_usage_errors_match_error_contracts_doc() {
    let error_contracts = read_doc("docs/reference/error-contracts.md");
    assert!(error_contracts.contains("`Unknown command: <name>`"));
    assert!(error_contracts.contains("`Missing index. Usage: codex-multi-auth switch <index>`"));
    assert!(error_contracts.contains("`Invalid index: <value>`"));

    let _sandbox = EnvSandbox::new();

    let mut out = CliOut::capture();
    let code =
        run_codex_multi_auth_cli_with(&args(&["auth", "definitely-not-a-command"]), &mut out)
            .await;
    assert_eq!(code, 1);
    assert!(
        out.error_text()
            .contains("Unknown command: definitely-not-a-command"),
        "unknown-command error drifted: {}",
        out.error_text()
    );

    let mut out = CliOut::capture();
    let code = run_codex_multi_auth_cli_with(&args(&["auth", "switch"]), &mut out).await;
    assert_eq!(code, 1);
    assert_eq!(
        out.error_text(),
        "Missing index. Usage: codex-multi-auth switch <index>"
    );

    let mut out = CliOut::capture();
    let code = run_codex_multi_auth_cli_with(&args(&["auth", "switch", "abc"]), &mut out).await;
    assert_eq!(code, 1);
    assert_eq!(out.error_text(), "Invalid index: abc");
}
